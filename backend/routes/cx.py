"""
Customer Experience endpoints — complaints and refund recommendations.

All queries drive from orders_enriched_synced so complaint rate denominators
are correct (orders with no complaint are still counted as orders).
"""
import logging
from typing import Optional

from fastapi import APIRouter, HTTPException, Query

from backend.db import get_pool

logger = logging.getLogger(__name__)
router = APIRouter(prefix="/api/cx", tags=["cx"])

PAGE_SIZE = 50
VALID_CATEGORIES = {"delivery_delay", "missing_items", "food_quality", "service_issue", "other"}
VALID_REFUND_CLASSES = {"partial", "full", "none", "error"}


def _validate_days(days: int) -> int:
    """Validate days param. 0 = all time (no date filter). Negative values rejected."""
    if days < 0:
        raise HTTPException(status_code=422, detail="days must be >= 0 (0 = all time)")
    return days

# All queries use the stable SQL pattern:
#   AND ($N = 0 OR col::timestamp >= (SELECT MAX(ts)::timestamp FROM
#                                     lakeflow.all_events_synced)
#                                     - make_interval(days => $N::int))
# - Simulator time (MAX(ts)) instead of NOW() — simulator is ~19 months
#   ahead of wall-clock, so NOW()-based filters include no recent data.
# - col::timestamp cast — synced TEXT timestamp columns can't compare to
#   timestamptz directly.
# Positional param count stays constant regardless of days value, avoiding
# asyncpg "too many arguments" errors when days=0.


@router.get("/summary")
async def get_cx_summary(
    category: Optional[str] = Query(None),
    days: int = Query(30),
):
    """Global KPIs + per-store complaint/refund aggregates.

    Market filtering is client-side — all stores are returned.
    Category filter is applied in the LEFT JOIN ON clause to preserve
    the outer join (orders with no complaint still count in the denominator).
    """
    _validate_days(days)
    if category and category not in VALID_CATEGORIES:
        raise HTTPException(status_code=422, detail=f"Invalid category: {category}")

    pool = await get_pool()

    rows = await pool.fetch(
        """
        SELECT
          oe.location_id,
          loc.name,
          loc.location_code,
          COUNT(DISTINCT oe.order_id)                                              AS orders,
          COUNT(DISTINCT c.complaint_id)                                           AS complaints,
          ROUND(COUNT(DISTINCT c.complaint_id) * 100.0
            / NULLIF(COUNT(DISTINCT oe.order_id), 0), 1)                           AS complaint_rate,
          COALESCE(SUM(
            CASE WHEN rr.agent_response::json->>'refund_class' != 'none'
                 THEN (rr.agent_response::json->>'refund_usd')::numeric END), 0)   AS refund_exposure,
          MODE() WITHIN GROUP (ORDER BY c.complaint_category)                      AS top_category
        FROM lakeflow.orders_enriched_synced oe
        JOIN simulator.locations_synced loc ON oe.location_id = loc.location_id::text
        LEFT JOIN complaints.complaints_synced c
               ON c.order_id = oe.order_id
              AND ($2::text IS NULL OR c.complaint_category = $2)
        LEFT JOIN recommender.refund_recommendations_synced rr ON rr.order_id = oe.order_id
        WHERE ($1 = 0 OR oe.created_at::timestamp >= (SELECT MAX(ts)::timestamp FROM lakeflow.all_events_synced) - make_interval(days => $1::int))
        GROUP BY oe.location_id, loc.name, loc.location_code
        """,
        days, category,
    )

    stores = [dict(r) for r in rows]

    total_complaints = sum(s["complaints"] for s in stores)
    total_orders = sum(s["orders"] for s in stores)
    refund_exposure = sum(float(s["refund_exposure"]) for s in stores)

    # avg_refund: mean across stores that have complaints with non-zero refund
    refund_stores = [s for s in stores if float(s["refund_exposure"]) > 0 and s["complaints"] > 0]
    avg_refund = (
        sum(float(s["refund_exposure"]) / s["complaints"] for s in refund_stores) / len(refund_stores)
        if refund_stores else 0.0
    )

    kpis = {
        "total_complaints": total_complaints,
        "complaint_rate": round(total_complaints * 100.0 / total_orders, 1) if total_orders else 0.0,
        "refund_exposure": round(refund_exposure, 2),
        "avg_refund": round(avg_refund, 2),
    }

    for s in stores:
        s["complaint_rate"] = float(s["complaint_rate"] or 0)
        s["refund_exposure"] = float(s["refund_exposure"] or 0)

    return {"kpis": kpis, "stores": stores}


@router.get("/stores/{location_id}")
async def get_store_detail(location_id: str, days: int = Query(30)):
    """Store-level KPIs + chart data for the Overview tab."""
    _validate_days(days)
    pool = await get_pool()

    kpi_row = await pool.fetchrow(
        """
        SELECT
          COUNT(DISTINCT c.complaint_id)                                           AS complaints,
          COUNT(DISTINCT oe.order_id)                                              AS orders,
          ROUND(COUNT(DISTINCT c.complaint_id) * 100.0
            / NULLIF(COUNT(DISTINCT oe.order_id), 0), 1)                           AS complaint_rate,
          COALESCE(SUM(
            CASE WHEN rr.agent_response::json->>'refund_class' != 'none'
                 THEN (rr.agent_response::json->>'refund_usd')::numeric END), 0)   AS refund_exposure,
          COALESCE(AVG(
            CASE WHEN rr.agent_response::json->>'refund_class' != 'none'
                 THEN (rr.agent_response::json->>'refund_usd')::numeric END), 0)   AS avg_refund
        FROM lakeflow.orders_enriched_synced oe
        LEFT JOIN complaints.complaints_synced c ON c.order_id = oe.order_id
        LEFT JOIN recommender.refund_recommendations_synced rr ON rr.order_id = oe.order_id
        WHERE oe.location_id = $1
          AND ($2 = 0 OR oe.created_at::timestamp >= (SELECT MAX(ts)::timestamp FROM lakeflow.all_events_synced) - make_interval(days => $2::int))
        """,
        location_id, days,
    )

    if kpi_row is None:
        raise HTTPException(status_code=404, detail="Store not found")

    trend = await pool.fetch(
        """
        SELECT DATE(c.ts) AS date, COUNT(*) AS complaints
        FROM complaints.complaints_synced c
        JOIN lakeflow.orders_enriched_synced oe ON c.order_id = oe.order_id
        WHERE oe.location_id = $1
          AND ($2 = 0 OR oe.created_at::timestamp >= (SELECT MAX(ts)::timestamp FROM lakeflow.all_events_synced) - make_interval(days => $2::int))
        GROUP BY DATE(c.ts)
        ORDER BY date
        """,
        location_id, days,
    )

    category_rows = await pool.fetch(
        """
        SELECT
          c.complaint_category AS category,
          COUNT(*) AS count,
          ROUND(COUNT(*) * 100.0 / NULLIF(SUM(COUNT(*)) OVER (), 0), 1) AS pct
        FROM complaints.complaints_synced c
        JOIN lakeflow.orders_enriched_synced oe ON c.order_id = oe.order_id
        WHERE oe.location_id = $1
          AND ($2 = 0 OR oe.created_at::timestamp >= (SELECT MAX(ts)::timestamp FROM lakeflow.all_events_synced) - make_interval(days => $2::int))
        GROUP BY c.complaint_category
        ORDER BY count DESC
        """,
        location_id, days,
    )

    refund_split = await pool.fetch(
        """
        SELECT
          rr.agent_response::json->>'refund_class' AS refund_class,
          COUNT(*) AS count
        FROM recommender.refund_recommendations_synced rr
        JOIN lakeflow.orders_enriched_synced oe ON rr.order_id = oe.order_id
        WHERE oe.location_id = $1
          AND ($2 = 0 OR oe.created_at::timestamp >= (SELECT MAX(ts)::timestamp FROM lakeflow.all_events_synced) - make_interval(days => $2::int))
        GROUP BY rr.agent_response::json->>'refund_class'
        """,
        location_id, days,
    )

    top_customers = await pool.fetch(
        """
        SELECT
          cust.customer_id,
          cust.name,
          cust.is_loyalty_member,
          COUNT(c.complaint_id) AS complaint_count
        FROM complaints.complaints_synced c
        JOIN lakeflow.orders_enriched_synced oe ON c.order_id = oe.order_id
        JOIN simulator.customer_address_index_synced ai
          ON ROUND(CAST((oe.order_body::json)->>'customer_lat' AS numeric), 3) = ai.rounded_lat
         AND ROUND(CAST((oe.order_body::json)->>'customer_lon' AS numeric), 3) = ai.rounded_lon
        JOIN simulator.customers_synced cust ON ai.customer_id = cust.customer_id
        WHERE oe.location_id = $1
          AND ($2 = 0 OR oe.created_at::timestamp >= (SELECT MAX(ts)::timestamp FROM lakeflow.all_events_synced) - make_interval(days => $2::int))
        GROUP BY cust.customer_id, cust.name, cust.is_loyalty_member
        ORDER BY complaint_count DESC
        LIMIT 5
        """,
        location_id, days,
    )

    return {
        "kpis": {
            "total_complaints": kpi_row["complaints"],
            "complaint_rate": float(kpi_row["complaint_rate"] or 0),
            "refund_exposure": float(kpi_row["refund_exposure"] or 0),
            "avg_refund": float(kpi_row["avg_refund"] or 0),
        },
        "trend": [{"date": str(r["date"]), "complaints": r["complaints"]} for r in trend],
        "category_breakdown": [
            {"category": r["category"], "count": r["count"], "pct": float(r["pct"] or 0)}
            for r in category_rows
        ],
        "refund_class_split": [
            {"refund_class": r["refund_class"], "count": r["count"]} for r in refund_split
        ],
        "top_customers": [
            {
                "customer_id": r["customer_id"],
                "name": r["name"],
                "is_loyalty_member": r["is_loyalty_member"],
                "complaint_count": r["complaint_count"],
            }
            for r in top_customers
        ],
    }


@router.get("/stores/{location_id}/complaints")
async def get_store_complaints(
    location_id: str,
    category: Optional[str] = Query(None),
    days: int = Query(30),
    page: int = Query(1),
):
    """Paginated complaints for a store, joined with refund recommendations."""
    _validate_days(days)
    if category and category not in VALID_CATEGORIES:
        raise HTTPException(status_code=422, detail=f"Invalid category: {category}")
    if page < 1:
        raise HTTPException(status_code=422, detail="page must be >= 1")

    pool = await get_pool()
    offset = (page - 1) * PAGE_SIZE

    total = await pool.fetchval(
        """
        SELECT COUNT(*)
        FROM complaints.complaints_synced c
        JOIN lakeflow.orders_enriched_synced oe ON c.order_id = oe.order_id
        WHERE oe.location_id = $1
          AND ($2 = 0 OR oe.created_at::timestamp >= (SELECT MAX(ts)::timestamp FROM lakeflow.all_events_synced) - make_interval(days => $2::int))
          AND ($3::text IS NULL OR c.complaint_category = $3)
        """,
        location_id, days, category,
    )

    rows = await pool.fetch(
        """
        SELECT
          c.complaint_id,
          c.order_id,
          c.complaint_category AS category,
          c.complaint_text,
          c.ts,
          (rr.agent_response::json->>'refund_usd')::numeric AS refund_usd,
          rr.agent_response::json->>'refund_class'          AS refund_class
        FROM complaints.complaints_synced c
        JOIN lakeflow.orders_enriched_synced oe ON c.order_id = oe.order_id
        LEFT JOIN recommender.refund_recommendations_synced rr ON rr.order_id = c.order_id
        WHERE oe.location_id = $1
          AND ($2 = 0 OR oe.created_at::timestamp >= (SELECT MAX(ts)::timestamp FROM lakeflow.all_events_synced) - make_interval(days => $2::int))
          AND ($3::text IS NULL OR c.complaint_category = $3)
        ORDER BY c.ts DESC
        LIMIT $4 OFFSET $5
        """,
        location_id, days, category, PAGE_SIZE, offset,
    )

    return {
        "total": total,
        "page": page,
        "page_size": PAGE_SIZE,
        "rows": [
            {
                "complaint_id": r["complaint_id"],
                "order_id": r["order_id"],
                "category": r["category"],
                "complaint_text": r["complaint_text"],
                "ts": str(r["ts"]),
                "refund_usd": float(r["refund_usd"]) if r["refund_usd"] is not None else None,
                "refund_class": r["refund_class"],
            }
            for r in rows
        ],
    }


@router.get("/stores/{location_id}/refunds")
async def get_store_refunds(
    location_id: str,
    refund_class: Optional[str] = Query(None),
    days: int = Query(30),
    page: int = Query(1),
):
    """Paginated refund recommendations for a store."""
    _validate_days(days)
    if refund_class and refund_class not in VALID_REFUND_CLASSES:
        raise HTTPException(status_code=422, detail=f"Invalid refund_class: {refund_class}")
    if page < 1:
        raise HTTPException(status_code=422, detail="page must be >= 1")

    pool = await get_pool()
    offset = (page - 1) * PAGE_SIZE

    total = await pool.fetchval(
        """
        SELECT COUNT(*)
        FROM recommender.refund_recommendations_synced rr
        JOIN lakeflow.orders_enriched_synced oe ON rr.order_id = oe.order_id
        WHERE oe.location_id = $1
          AND ($2 = 0 OR oe.created_at::timestamp >= (SELECT MAX(ts)::timestamp FROM lakeflow.all_events_synced) - make_interval(days => $2::int))
          AND ($3::text IS NULL OR rr.agent_response::json->>'refund_class' = $3)
        """,
        location_id, days, refund_class,
    )

    last_sync_ts = await pool.fetchval(
        "SELECT MAX(order_ts) FROM recommender.refund_recommendations_synced"
    )

    rows = await pool.fetch(
        """
        SELECT
          rr.order_id,
          rr.agent_response::json->>'refund_class'          AS refund_class,
          (rr.agent_response::json->>'refund_usd')::numeric AS refund_usd,
          rr.agent_response::json->>'reason'                AS reason,
          rr.order_ts
        FROM recommender.refund_recommendations_synced rr
        JOIN lakeflow.orders_enriched_synced oe ON rr.order_id = oe.order_id
        WHERE oe.location_id = $1
          AND ($2 = 0 OR oe.created_at::timestamp >= (SELECT MAX(ts)::timestamp FROM lakeflow.all_events_synced) - make_interval(days => $2::int))
          AND ($3::text IS NULL OR rr.agent_response::json->>'refund_class' = $3)
        ORDER BY rr.order_ts DESC
        LIMIT $4 OFFSET $5
        """,
        location_id, days, refund_class, PAGE_SIZE, offset,
    )

    return {
        "total": total,
        "page": page,
        "page_size": PAGE_SIZE,
        "last_sync_ts": str(last_sync_ts) if last_sync_ts else None,
        "rows": [
            {
                "order_id": r["order_id"],
                "refund_class": r["refund_class"],
                "refund_usd": float(r["refund_usd"]) if r["refund_usd"] is not None else None,
                "reason": r["reason"],
                "order_ts": str(r["order_ts"]),
            }
            for r in rows
        ],
    }
