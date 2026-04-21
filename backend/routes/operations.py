"""
Operations dashboard endpoint — composite chain-wide metrics.

Returns a single atomic payload with six sections: headline KPIs, chain
pipeline, kitchen status, customers, loyalty, and a per-store leaderboard.

Filter via `?stores=comma,separated,location_ids` to scope a cohort.
Empty / omitted = all stores.
"""

import logging

from fastapi import APIRouter, Query

from backend.db import get_pool

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


@router.get("/operations/dashboard")
async def get_dashboard(stores: str | None = Query(default=None)):
    """Composite operations dashboard — atomic snapshot across a cohort.

    `stores` — optional comma-separated list of `location_id` values. Empty
    or omitted = all stores in the catalog.
    """
    store_ids = _parse_store_ids(stores)
    pool = await get_pool()  # noqa: F841  unused until Task 4

    # Skeleton: always return the empty payload. Real queries land in later tasks.
    return _empty_dashboard()
