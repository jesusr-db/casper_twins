"""
Market endpoints — list markets with mini KPIs and per-market KPI detail.
"""

import json
import logging

from fastapi import APIRouter, HTTPException

from backend.db import get_pool

logger = logging.getLogger(__name__)
router = APIRouter(prefix="/api", tags=["markets"])


@router.get("/markets")
async def list_markets():
    """List all markets with lat/lon, active order count, and drivers out.

    Returns market metadata from the `markets` table with live counts
    computed from the `orders` table.
    """
    pool = await get_pool()

    # Check if orders_current_state exists yet (it's created async by DLT pipeline)
    # information_schema.tables includes both tables and views (pg_tables is tables-only)
    check = await pool.fetchval(
        "SELECT EXISTS(SELECT 1 FROM information_schema.tables WHERE table_schema='lakeflow' AND table_name='orders_enriched_synced')"
    )

    if check:
        # Use a regular subquery (not LATERAL) so the view is evaluated once,
        # not 88 times. LATERAL would re-run the full CTE chain per market.
        # Filter to last 24h of SIMULATOR time to exclude loop-duplicate
        # orders from prior quarters (see routes/orders.py for context).
        query = """
            WITH sim_now AS (
              SELECT MAX(ts)::timestamp AS now_ts FROM lakeflow.all_events_synced
            )
            SELECT
                m.location_id,
                m.location_code,
                m.name,
                m.lat,
                m.lon,
                COALESCE(orders.active_orders, 0) AS active_orders,
                COALESCE(drivers.drivers_out, 0) AS drivers_out
            FROM simulator.locations_synced m
            LEFT JOIN (
                SELECT oe.location_id,
                    COUNT(*) FILTER (WHERE oe.delivered_at IS NULL) AS active_orders
                FROM lakeflow.orders_enriched_synced oe, sim_now
                WHERE oe.created_at::timestamp >= sim_now.now_ts - INTERVAL '24 hours'
                GROUP BY oe.location_id
            ) orders ON orders.location_id = m.location_id::text
            LEFT JOIN (
                SELECT oe.location_id,
                    COUNT(*) FILTER (
                        WHERE oe.current_stage IN ('driver_picked_up', 'driver_ping')
                        AND oe.delivered_at IS NULL
                    ) AS drivers_out
                FROM lakeflow.orders_enriched_synced oe, sim_now
                WHERE oe.created_at::timestamp >= sim_now.now_ts - INTERVAL '24 hours'
                GROUP BY oe.location_id
            ) drivers ON drivers.location_id = m.location_id::text
            ORDER BY m.location_id
        """
    else:
        # Fallback: return markets without order stats
        query = """
            SELECT location_id, location_code, name, lat, lon,
                   0 AS active_orders, 0 AS drivers_out
            FROM simulator.locations_synced
            ORDER BY location_id
        """

    rows = await pool.fetch(query)
    return [dict(row) for row in rows]


@router.get("/markets/{market_id}/kpis")
async def get_market_kpis(market_id: str):
    """Get aggregated KPIs for a specific market.

    Returns: active_orders, drivers_out, avg_delivery_time, todays_revenue
    """
    pool = await get_pool()

    # Filter to last 24h of simulator time so active counts exclude
    # loop-duplicate stale orders from prior quarters.
    query = """
        WITH sim_now AS (
          SELECT MAX(ts)::timestamp AS now_ts FROM lakeflow.all_events_synced
        )
        SELECT
            COUNT(*) FILTER (WHERE delivered_at IS NULL) AS active_orders,
            COUNT(*) FILTER (
                WHERE current_stage IN ('driver_picked_up', 'driver_ping')
                AND delivered_at IS NULL
            ) AS drivers_out,
            EXTRACT(EPOCH FROM
                AVG(delivered_at::timestamp - created_at::timestamp)
                FILTER (WHERE delivered_at IS NOT NULL
                  AND delivered_at > picked_up_at  -- exclude carryout (delivered_at = picked_up_at)
                  AND created_at::date = sim_now.now_ts::date)
            ) AS avg_delivery_seconds,
            COALESCE(
                SUM(order_total) FILTER (
                  WHERE created_at::date = sim_now.now_ts::date
                ),
                0.0
            ) AS todays_revenue
        FROM lakeflow.orders_enriched_synced, sim_now
        WHERE location_id = $1
          AND created_at::timestamp >= sim_now.now_ts - INTERVAL '24 hours'
    """

    row = await pool.fetchrow(query, market_id)
    if row is None:
        raise HTTPException(status_code=404, detail="Market not found")

    # Format avg delivery time as "HH:MM:SS"
    avg_seconds = row["avg_delivery_seconds"]
    if avg_seconds is not None:
        total_seconds = int(avg_seconds)
        hours = total_seconds // 3600
        minutes = (total_seconds % 3600) // 60
        seconds = total_seconds % 60
        avg_delivery_time = f"{hours:02d}:{minutes:02d}:{seconds:02d}"
    else:
        avg_delivery_time = None

    return {
        "active_orders": row["active_orders"],
        "drivers_out": row["drivers_out"],
        "avg_delivery_time": avg_delivery_time,
        "todays_revenue": float(row["todays_revenue"]),
    }
