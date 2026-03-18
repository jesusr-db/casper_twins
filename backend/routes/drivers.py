"""
Driver endpoints — active driver positions for map visualization.
"""

import json
import logging

from fastapi import APIRouter

from backend.db import get_pool

logger = logging.getLogger(__name__)
router = APIRouter(prefix="/api", tags=["drivers"])


def _parse_json_field(raw: str | None) -> dict | list | None:
    """Safely parse a JSON text column."""
    if raw is None:
        return None
    try:
        return json.loads(raw)
    except (json.JSONDecodeError, TypeError):
        return None


@router.get("/markets/{market_id}/drivers")
async def list_active_drivers(market_id: str):
    """Get all active in-transit drivers for a market.

    Joins driver_positions_synced (true streaming — updates within seconds of each
    driver_ping event) with orders_enriched_synced (for route polyline and pickup time).
    Only includes orders that have been picked up and not yet delivered.
    """
    pool = await get_pool()

    # Query driver_positions_synced directly — it's CONTINUOUS-synced from a
    # streaming table so it's the most current data available. Filter to pings
    # within the last 2 hours of simulator time to exclude delivered drivers
    # without needing a join on the view (which can have sync lag).
    query = """
        SELECT
            dp.order_id,
            dp.loc_lat,
            dp.loc_lon,
            dp.progress_pct,
            dp.ts          AS last_ping_ts,
            oe.route_body,
            oe.picked_up_at
        FROM lakeflow.driver_positions_synced dp
        LEFT JOIN lakeflow.orders_enriched_synced oe ON dp.order_id = oe.order_id
        WHERE dp.location_id = $1
          AND dp.loc_lat IS NOT NULL
          AND dp.loc_lon IS NOT NULL
          AND dp.ts >= (
            SELECT TO_CHAR(
              MAX(ts)::timestamp - INTERVAL '2 hours',
              'YYYY-MM-DD HH24:MI:SS.000'
            )
            FROM lakeflow.driver_positions_synced
            WHERE location_id = $1
          )
    """

    rows = await pool.fetch(query, market_id)

    return [
        {
            "order_id": row["order_id"],
            "latest_ping": {
                "loc_lat": row["loc_lat"],
                "loc_lon": row["loc_lon"],
                "progress_pct": row["progress_pct"],
            },
            "last_ping_ts": row["last_ping_ts"],
            "route_body": _parse_json_field(row["route_body"]),
            "picked_up_at": row["picked_up_at"],
        }
        for row in rows
    ]
