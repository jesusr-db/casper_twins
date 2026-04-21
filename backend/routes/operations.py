"""
Operations dashboard endpoint — composite chain-wide metrics.

Returns a single atomic payload with six sections: headline KPIs, chain
pipeline, kitchen status, customers, loyalty, and a per-store leaderboard.

Filter via `?stores=comma,separated,location_ids` to scope a cohort.
Empty / omitted = all stores.
"""

import logging

from fastapi import APIRouter, Query

from backend import db

logger = logging.getLogger(__name__)
router = APIRouter(prefix="/api", tags=["operations"])


def _parse_store_ids(stores: str | None) -> list[str]:
    """Parse comma-separated location_ids; return [] for None/empty."""
    if not stores:
        return []
    return [s.strip() for s in stores.split(",") if s.strip()]


def _empty_dashboard() -> dict:
    """Canonical empty shape — used when cohort resolves to no stores."""
    return {
        "cohort": {"store_count": 0, "store_ids": []},
        "headline": {
            "revenue_today": 0.0,
            "orders_active": 0,
            "drivers_out": 0,
            "kitchens_busy": {"n": 0, "of": 0},
            "avg_delivery_min": None,
            "sla_health_pct": 100.0,
        },
        "pipeline": {
            "new": 0,
            "kitchen": 0,
            "ready": 0,
            "transit": 0,
            "delivered_today": 0,
        },
        "kitchen": {
            "in_kitchen": 0,
            "ready_waiting": 0,
            "backlogged_stores": 0,
            "avg_kitchen_min": None,
        },
        "customers": {
            "unique_today": 0,
            "avg_order_value": 0.0,
            "top_personas": [],
        },
        "loyalty": {
            "loyalty_order_pct": 0.0,
            "points_earned_today": 0,
            "avg_coupon_propensity": 0.0,
        },
        "leaderboard": [],
    }


async def _resolve_cohort(pool, store_ids: list[str]) -> list[str]:
    """Return the effective list of location_ids (as strings) to aggregate over.

    If store_ids is non-empty, use it verbatim. Otherwise query the catalog.
    """
    if store_ids:
        return store_ids
    rows = await pool.fetch(
        "SELECT location_id FROM simulator.locations_synced ORDER BY location_id"
    )
    return [str(r["location_id"]) for r in rows]


# Keep in sync with frontend/src/constants/sla.ts. Minutes in stage before
# the order is classified yellow/red. "Delivered" has no SLA.
SLA_THRESHOLDS = {
    # stage_key: {"yellow": int, "red": int, "started_col": "column name"}
    "new":     {"yellow": 3,  "red": 8,  "started_col": "created_at"},
    "kitchen": {"yellow": 12, "red": 20, "started_col": "kitchen_started_at"},
    "ready":   {"yellow": 5,  "red": 10, "started_col": "driver_arrived_at"},
    "transit": {"yellow": 25, "red": 40, "started_col": "picked_up_at"},
}


def _sla_case_expr(which: str) -> str:
    """Build a boolean CASE expression: is the active order in `which` SLA state?

    which ∈ {"yellow", "red"} — an order is in that state if mins-in-stage
    for its current stage exceeds the corresponding threshold.
    Delivered orders are always false.
    """
    clauses = []
    # New — from created_at, before kitchen_started_at
    clauses.append(
        f"(kitchen_started_at IS NULL AND delivered_at IS NULL "
        f"AND EXTRACT(EPOCH FROM (sim_now.now_ts - created_at::timestamp))/60 "
        f">= {SLA_THRESHOLDS['new'][which]})"
    )
    # Kitchen — from kitchen_started_at, before picked_up_at (still cooking/ready)
    clauses.append(
        f"(kitchen_started_at IS NOT NULL AND picked_up_at IS NULL "
        f"AND driver_arrived_at IS NULL AND delivered_at IS NULL "
        f"AND EXTRACT(EPOCH FROM (sim_now.now_ts - kitchen_started_at::timestamp))/60 "
        f">= {SLA_THRESHOLDS['kitchen'][which]})"
    )
    # Ready — from driver_arrived_at, before picked_up_at
    clauses.append(
        f"(driver_arrived_at IS NOT NULL AND picked_up_at IS NULL "
        f"AND delivered_at IS NULL "
        f"AND EXTRACT(EPOCH FROM (sim_now.now_ts - driver_arrived_at::timestamp))/60 "
        f">= {SLA_THRESHOLDS['ready'][which]})"
    )
    # Transit — from picked_up_at, before delivered_at
    clauses.append(
        f"(picked_up_at IS NOT NULL AND delivered_at IS NULL "
        f"AND EXTRACT(EPOCH FROM (sim_now.now_ts - picked_up_at::timestamp))/60 "
        f">= {SLA_THRESHOLDS['transit'][which]})"
    )
    return "(" + " OR ".join(clauses) + ")"


_QUERY_A = f"""
WITH sim_now AS (
    SELECT MAX(ts)::timestamp AS now_ts FROM lakeflow.all_events_synced
),
window_orders AS (
    SELECT oe.*
    FROM lakeflow.orders_enriched_synced oe, sim_now
    WHERE oe.location_id = ANY($1::text[])
      AND oe.created_at::timestamp >= sim_now.now_ts - INTERVAL '24 hours'
),
per_store_kitchen AS (
    SELECT location_id,
        COUNT(*) FILTER (WHERE kitchen_started_at IS NOT NULL
                          AND kitchen_finished_at IS NULL) AS in_kitchen
    FROM window_orders
    GROUP BY location_id
)
SELECT
    -- Headline
    COALESCE(SUM(order_total) FILTER (
        WHERE delivered_at IS NOT NULL
          AND delivered_at::date = sim_now.now_ts::date
    ), 0.0) AS revenue_today,
    COUNT(*) FILTER (WHERE delivered_at IS NULL) AS orders_active,
    COUNT(*) FILTER (
        WHERE picked_up_at IS NOT NULL AND delivered_at IS NULL
    ) AS drivers_out,
    (SELECT COUNT(*) FROM per_store_kitchen WHERE in_kitchen > 0)
        AS kitchens_busy_n,
    ROUND(CAST(EXTRACT(EPOCH FROM AVG(
        delivered_at::timestamp - picked_up_at::timestamp
    ) FILTER (
        WHERE delivered_at IS NOT NULL AND picked_up_at IS NOT NULL
          AND delivered_at > picked_up_at
          AND delivered_at::date = sim_now.now_ts::date
    )) / 60.0 AS numeric), 1) AS avg_delivery_min,
    COUNT(*) FILTER (WHERE delivered_at IS NULL) AS sla_active_count,
    COUNT(*) FILTER (
        WHERE delivered_at IS NULL AND {_sla_case_expr("red")}
    ) AS sla_red_count,

    -- Pipeline
    COUNT(*) FILTER (
        WHERE delivered_at IS NULL AND kitchen_started_at IS NULL
    ) AS pipeline_new,
    COUNT(*) FILTER (
        WHERE delivered_at IS NULL AND kitchen_started_at IS NOT NULL
          AND picked_up_at IS NULL AND driver_arrived_at IS NULL
    ) AS pipeline_kitchen,
    COUNT(*) FILTER (
        WHERE delivered_at IS NULL AND driver_arrived_at IS NOT NULL
          AND picked_up_at IS NULL
    ) AS pipeline_ready,
    COUNT(*) FILTER (
        WHERE delivered_at IS NULL AND picked_up_at IS NOT NULL
    ) AS pipeline_transit,
    COUNT(*) FILTER (
        WHERE delivered_at IS NOT NULL
          AND delivered_at::date = sim_now.now_ts::date
    ) AS pipeline_delivered_today,

    -- Kitchen detail
    COUNT(*) FILTER (
        WHERE kitchen_started_at IS NOT NULL AND kitchen_finished_at IS NULL
    ) AS kitchen_in_kitchen,
    COUNT(*) FILTER (
        WHERE kitchen_finished_at IS NOT NULL AND picked_up_at IS NULL
    ) AS kitchen_ready_waiting,
    (SELECT COUNT(*) FROM per_store_kitchen WHERE in_kitchen >= 5)
        AS kitchen_backlogged_stores,
    ROUND(CAST(EXTRACT(EPOCH FROM AVG(
        kitchen_finished_at::timestamp - kitchen_started_at::timestamp
    ) FILTER (
        WHERE kitchen_started_at IS NOT NULL AND kitchen_finished_at IS NOT NULL
          AND kitchen_finished_at::date = sim_now.now_ts::date
    )) / 60.0 AS numeric), 1) AS kitchen_avg_min,

    -- Loyalty order pct (needs the customer join; done here for atomicity)
    COALESCE(ROUND(
        100.0 * COUNT(*) FILTER (
            WHERE c.is_loyalty_member = true
              AND wo.created_at::date = sim_now.now_ts::date
        )::numeric
        / NULLIF(COUNT(*) FILTER (
            WHERE c.customer_id IS NOT NULL
              AND wo.created_at::date = sim_now.now_ts::date
        ), 0),
        1
    ), 0.0) AS loyalty_order_pct
FROM window_orders wo
CROSS JOIN sim_now
LEFT JOIN simulator.customer_address_index_synced cai
    ON ROUND((wo.order_body::json->>'customer_lat')::numeric, 3)
        = cai.rounded_lat
   AND ROUND((wo.order_body::json->>'customer_lon')::numeric, 3)
        = cai.rounded_lon
LEFT JOIN simulator.customers_synced c
    ON c.customer_id = cai.customer_id
"""


async def _query_a(pool, cohort: list[str]) -> dict:
    row = await pool.fetchrow(_QUERY_A, cohort)
    if row is None:
        return {}
    return dict(row)


@router.get("/operations/dashboard")
async def get_dashboard(stores: str | None = Query(default=None)):
    """Composite operations dashboard — atomic snapshot across a cohort."""
    requested = _parse_store_ids(stores)
    pool = await db.get_pool()
    cohort = await _resolve_cohort(pool, requested)

    if not cohort:
        return _empty_dashboard()

    a = await _query_a(pool, cohort)

    payload = _empty_dashboard()
    payload["cohort"] = {"store_count": len(cohort), "store_ids": cohort}

    # Headline
    payload["headline"]["revenue_today"] = float(a.get("revenue_today") or 0.0)
    payload["headline"]["orders_active"] = int(a.get("orders_active") or 0)
    payload["headline"]["drivers_out"] = int(a.get("drivers_out") or 0)
    payload["headline"]["kitchens_busy"] = {
        "n": int(a.get("kitchens_busy_n") or 0),
        "of": len(cohort),
    }
    payload["headline"]["avg_delivery_min"] = (
        float(a["avg_delivery_min"]) if a.get("avg_delivery_min") is not None else None
    )
    active = int(a.get("sla_active_count") or 0)
    red = int(a.get("sla_red_count") or 0)
    payload["headline"]["sla_health_pct"] = (
        round((active - red) * 100.0 / active, 1) if active > 0 else 100.0
    )

    # Pipeline
    payload["pipeline"] = {
        "new": int(a.get("pipeline_new") or 0),
        "kitchen": int(a.get("pipeline_kitchen") or 0),
        "ready": int(a.get("pipeline_ready") or 0),
        "transit": int(a.get("pipeline_transit") or 0),
        "delivered_today": int(a.get("pipeline_delivered_today") or 0),
    }

    # Kitchen
    payload["kitchen"] = {
        "in_kitchen": int(a.get("kitchen_in_kitchen") or 0),
        "ready_waiting": int(a.get("kitchen_ready_waiting") or 0),
        "backlogged_stores": int(a.get("kitchen_backlogged_stores") or 0),
        "avg_kitchen_min": (
            float(a["kitchen_avg_min"]) if a.get("kitchen_avg_min") is not None else None
        ),
    }

    # Loyalty — only the order pct from Query A; rest filled by later tasks
    payload["loyalty"]["loyalty_order_pct"] = float(a.get("loyalty_order_pct") or 0.0)

    return payload
