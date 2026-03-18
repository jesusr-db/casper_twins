"""
Playback endpoint — historical event replay for a market within a time window.
"""

import json
import logging
from datetime import datetime, timedelta

from fastapi import APIRouter, HTTPException, Query

from backend.db import get_pool

logger = logging.getLogger(__name__)
router = APIRouter(prefix="/api", tags=["playback"])

# Safety limits
MAX_WINDOW_HOURS = 2
MAX_EVENTS = 5000


def _parse_json_field(raw: str | None) -> dict | list | None:
    """Safely parse a JSON text column."""
    if raw is None:
        return None
    try:
        return json.loads(raw)
    except (json.JSONDecodeError, TypeError):
        return None


@router.get("/playback/{market_id}")
async def get_playback_events(
    market_id: str,
    start: str = Query(..., description="Start timestamp (YYYY-MM-DD HH:MM:SS)"),
    end: str = Query(..., description="End timestamp (YYYY-MM-DD HH:MM:SS)"),
):
    """Fetch historical events for a market within a time window.

    Used by the playback engine to replay delivery operations.
    Enforces a maximum 2-hour window and 5000-event cap.

    Returns events sorted by timestamp ascending for sequential replay.
    """
    # Parse and validate time window
    try:
        start_dt = datetime.strptime(start, "%Y-%m-%d %H:%M:%S")
        end_dt = datetime.strptime(end, "%Y-%m-%d %H:%M:%S")
    except ValueError:
        raise HTTPException(
            status_code=400,
            detail="Invalid timestamp format. Use YYYY-MM-DD HH:MM:SS",
        )

    if end_dt <= start_dt:
        raise HTTPException(
            status_code=400, detail="End time must be after start time"
        )

    window = end_dt - start_dt
    if window > timedelta(hours=MAX_WINDOW_HOURS):
        raise HTTPException(
            status_code=400,
            detail=f"Time window exceeds maximum of {MAX_WINDOW_HOURS} hours",
        )

    pool = await get_pool()

    # Fetch events with cap — use LIMIT + 1 to detect truncation
    query = """
        SELECT event_id, order_id, event_type, body, ts, sequence
        FROM lakeflow.all_events_synced
        WHERE location_id = $1
          AND ts >= $2
          AND ts <= $3
        ORDER BY ts ASC, CAST(sequence AS INTEGER) ASC
        LIMIT $4
    """

    rows = await pool.fetch(query, market_id, start, end, MAX_EVENTS + 1)

    truncated = len(rows) > MAX_EVENTS
    if truncated:
        rows = rows[:MAX_EVENTS]

    events = [
        {
            "event_id": row["event_id"],
            "order_id": row["order_id"],
            "event_type": row["event_type"],
            "body": _parse_json_field(row["body"]),
            "ts": row["ts"],
            "sequence": row["sequence"],
        }
        for row in rows
    ]

    return {
        "events": events,
        "total_count": len(events),
        "truncated": truncated,
    }
