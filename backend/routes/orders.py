"""
Order endpoints — list orders per market and get order detail with events.
"""

import json
import logging

from fastapi import APIRouter, HTTPException, Query

from backend.db import get_pool

logger = logging.getLogger(__name__)
router = APIRouter(prefix="/api", tags=["orders"])


def _parse_json_field(raw: str | None) -> dict | list | None:
    """Safely parse a JSON text column. Returns None on failure."""
    if raw is None:
        return None
    try:
        return json.loads(raw)
    except (json.JSONDecodeError, TypeError):
        return None


def _format_order(row: dict) -> dict:
    """Format a raw order row, parsing JSON body columns."""
    result = dict(row)
    # Parse JSON text columns into structured objects
    result["order_body"] = _parse_json_field(result.get("order_body"))
    result["latest_ping"] = _parse_json_field(result.get("latest_ping"))
    if "route_body" in result:
        result["route_body"] = _parse_json_field(result.get("route_body"))
    return result


@router.get("/markets/{market_id}/orders")
async def list_market_orders(
    market_id: str,
    include_delivered: bool = Query(False, description="Include delivered orders"),
):
    """List orders for a market. By default returns only active (undelivered) orders.

    JSON body columns (order_body, latest_ping) are parsed server-side.
    """
    pool = await get_pool()

    if include_delivered:
        query = """
            SELECT order_id, location_id, current_stage, created_at,
                   delivered_at, order_body, latest_ping, order_total
            FROM lakeflow.orders_enriched_synced
            WHERE location_id = $1
            ORDER BY created_at DESC
        """
    else:
        # Include active orders + orders delivered in the last 60 minutes
        # so the pipeline "Delivered" stage shows recent completions.
        query = """
            SELECT order_id, location_id, current_stage, created_at,
                   delivered_at, order_body, latest_ping, order_total
            FROM lakeflow.orders_enriched_synced
            WHERE location_id = $1
              AND (
                delivered_at IS NULL
                OR delivered_at::timestamp >= NOW() - INTERVAL '60 minutes'
              )
            ORDER BY created_at DESC
        """

    rows = await pool.fetch(query, market_id)
    return [_format_order(row) for row in rows]


@router.get("/orders/{order_id}")
async def get_order_detail(order_id: str):
    """Get full order detail including all stage timestamps, items, route, and event timeline.

    Joins the orders table with order_events for the full lifecycle view.
    """
    pool = await get_pool()

    # Fetch order
    order_query = """
        SELECT order_id, location_id, current_stage, created_at,
               kitchen_started_at, kitchen_ready_at, kitchen_finished_at,
               driver_arrived_at, picked_up_at, delivered_at,
               order_body, route_body, latest_ping, order_total
        FROM lakeflow.orders_enriched_synced
        WHERE order_id = $1
    """
    order_row = await pool.fetchrow(order_query, order_id)
    if order_row is None:
        raise HTTPException(status_code=404, detail="Order not found")

    # Fetch events for this order
    events_query = """
        SELECT event_id, order_id, event_type, body, ts, sequence
        FROM lakeflow.all_events_synced
        WHERE order_id = $1
        ORDER BY ts ASC, CAST(sequence AS INTEGER) ASC
    """
    event_rows = await pool.fetch(events_query, order_id)

    # Format response
    order = _format_order(order_row)
    order["route_body"] = _parse_json_field(order_row.get("route_body"))
    order["events"] = [
        {
            "event_id": e["event_id"],
            "order_id": e["order_id"],
            "event_type": e["event_type"],
            "body": _parse_json_field(e["body"]),
            "ts": e["ts"],
            "sequence": e["sequence"],
        }
        for e in event_rows
    ]

    return order
