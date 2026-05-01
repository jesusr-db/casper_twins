# Store Operations Panel Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Ship a full-page `/operations` dashboard with chain-wide live metrics (revenue, orders, kitchen, drivers, customers, loyalty), a URL-driven multi-select store filter, a sortable per-store leaderboard, and a "View in Operations" button on the existing map `StoreDetailPanel`.

**Architecture:** New `/operations` route rendered under a shared `App` shell with a `TopNav` (Map · Operations pills). Backend exposes one composite `GET /api/operations/dashboard` endpoint that runs four Lakebase queries in parallel via `asyncio.gather` and returns an atomic snapshot. Frontend polls every 5s via the existing `usePolling` hook. Filter state lives in the URL (`?stores=…`).

**Tech Stack:** FastAPI + asyncpg + Postgres (Lakebase), React 18 + TypeScript + react-router-dom v6 + Vite. Tests: pytest (new) for backend, Playwright for E2E. No frontend component test harness exists; skipping component tests and expanding E2E in this iteration.

**Spec:** `docs/superpowers/specs/2026-04-20-store-operations-panel-design.md` (commit `a500023`).

---

## Deviations from spec (read before starting)

1. **Backend tests** — spec says "pytest"; repo has no pytest setup. Task 1 bootstraps pytest + `tests/backend/conftest.py`.
2. **Frontend component tests** — spec says "Vitest + Testing Library"; neither is installed. This plan **defers** component tests and adds broader Playwright E2E coverage in Task 24 instead. Adding vitest is a follow-up.
3. **Cross-route state preservation** — spec says "keep `activeMarketId` + `rightRailMode` at App level so cross-route navigation preserves them." Doing so is a deep refactor of `App.tsx`. v1 accepts that returning from `/operations` to `/` resets to the first market (existing fallback behavior).

---

## File structure

### New files (backend)
- `requirements-dev.txt` — dev-only dependencies (pytest, pytest-asyncio, httpx)
- `backend/routes/operations.py` — the composite endpoint
- `tests/backend/__init__.py`
- `tests/backend/conftest.py` — pytest fixtures: app/client + mock pool
- `tests/backend/test_operations.py` — unit tests for the endpoint

### New files (frontend)
- `frontend/src/pages/MapShell.tsx` — current `App.tsx` body, minus the top bar
- `frontend/src/pages/OperationsPage.tsx` — orchestrates fetch + section render
- `frontend/src/components/TopNav.tsx` — Map · Operations pill bar
- `frontend/src/components/operations/StoreFilter.tsx`
- `frontend/src/components/operations/HeadlineKpis.tsx`
- `frontend/src/components/operations/ChainPipeline.tsx`
- `frontend/src/components/operations/KitchenPanel.tsx`
- `frontend/src/components/operations/CustomersPanel.tsx`
- `frontend/src/components/operations/LoyaltyPanel.tsx`
- `frontend/src/components/operations/StoreLeaderboard.tsx`
- `frontend/src/hooks/useOperationsDashboard.ts`
- `tests/e2e/specs/operations.spec.ts`

### Modified files
- `backend/main.py` — register `operations.router`
- `frontend/src/main.tsx` — route tree: layout around `/` and `/operations`
- `frontend/src/App.tsx` — becomes thin shell (TopNav + `<Outlet />`)
- `frontend/src/components/StoreDetailPanel.tsx` — add "View in Operations" button
- `frontend/src/types/index.ts` — add operations response types

---

## Task 1: Bootstrap pytest for backend tests

**Files:**
- Create: `requirements-dev.txt`
- Create: `tests/backend/__init__.py`
- Create: `tests/backend/conftest.py`
- Create: `tests/backend/test_smoke.py` (delete at end of task)

- [ ] **Step 1: Add dev requirements**

Create `requirements-dev.txt`:

```txt
-r requirements.txt
pytest>=8.0.0
pytest-asyncio>=0.23.0
httpx>=0.27.0
```

- [ ] **Step 2: Install dev requirements in local venv**

Run: `pip install -r requirements-dev.txt`

Expected: all packages install without errors.

- [ ] **Step 3: Create `tests/backend/__init__.py`**

Create an empty file at `tests/backend/__init__.py`.

- [ ] **Step 4: Create `tests/backend/conftest.py`**

```python
"""
Shared pytest fixtures for backend tests.

CRITICAL: We must patch `backend.db.init_pool` and `backend.db.close_pool`
at module-import time so that `from backend.main import app` does not trigger
a real Databricks authentication flow. See CLAUDE.md.
"""
from unittest.mock import AsyncMock, patch

import pytest

# Patch pool lifecycle before backend.main is imported anywhere.
_pool_patches = [
    patch("backend.db.init_pool", new=AsyncMock(return_value=None)),
    patch("backend.db.close_pool", new=AsyncMock(return_value=None)),
]
for p in _pool_patches:
    p.start()


@pytest.fixture
def mock_pool():
    """An AsyncMock that stands in for the asyncpg.Pool.

    Individual tests wire up `pool.fetch`, `pool.fetchrow`, `pool.fetchval`
    with pre-canned return values.
    """
    pool = AsyncMock()
    pool.fetch = AsyncMock(return_value=[])
    pool.fetchrow = AsyncMock(return_value=None)
    pool.fetchval = AsyncMock(return_value=True)  # table-exists check default True
    return pool


def sql_dispatch(mapping):
    """Return a function suitable as `AsyncMock.side_effect` that inspects the
    SQL string and returns the first matching mapped value.

    Use this instead of list-based `side_effect` when call ordering depends
    on asyncio scheduling (e.g. when the endpoint uses `asyncio.gather`).

    mapping: dict of {SQL-substring: return_value}. First match wins.
    """
    async def dispatcher(sql, *args, **kwargs):
        for keyword, value in mapping.items():
            if keyword in sql:
                return value
        return []

    return dispatcher


@pytest.fixture
def client(mock_pool):
    """FastAPI TestClient with a mocked DB pool.

    `backend.db.get_pool` is patched to return our `mock_pool` for the
    duration of the test.
    """
    # Import here so pool-lifecycle patches above are already active.
    from fastapi.testclient import TestClient

    from backend import db
    from backend.main import app

    async def _get_pool():
        return mock_pool

    original = db.get_pool
    db.get_pool = _get_pool
    try:
        with TestClient(app) as c:
            yield c
    finally:
        db.get_pool = original
```

- [ ] **Step 5: Create smoke test to verify the harness**

Create `tests/backend/test_smoke.py`:

```python
def test_health_endpoint(client):
    resp = client.get("/api/health")
    assert resp.status_code == 200
    assert resp.json() == {"status": "ok", "app": "digital-twin"}
```

- [ ] **Step 6: Run the smoke test**

Run: `pytest tests/backend/test_smoke.py -v`

Expected: 1 passed.

If it fails with an import error, fix import paths; if it fails with an auth error, verify the `_pool_patches` loop in `conftest.py` ran before `backend.main` was imported by the test client fixture.

- [ ] **Step 7: Delete smoke test**

Delete `tests/backend/test_smoke.py` — it was just to verify the harness.

- [ ] **Step 8: Commit**

```bash
git add requirements-dev.txt tests/backend/__init__.py tests/backend/conftest.py
git commit -m "test(backend): bootstrap pytest harness with mocked pool

Adds requirements-dev.txt (pytest, pytest-asyncio, httpx) and
tests/backend/{__init__.py,conftest.py} with:
  - module-import-time patch for db.init_pool/close_pool
  - mock_pool fixture (asyncpg.Pool stand-in)
  - client fixture (FastAPI TestClient)
  - sql_dispatch helper — order-independent side_effect for fetch mocks

Co-authored-by: Isaac"
```

---

## Task 2: Failing test — `/api/operations/dashboard` exists with correct shape

**Files:**
- Create: `tests/backend/test_operations.py`

- [ ] **Step 1: Write the failing test**

```python
"""Tests for /api/operations/dashboard."""


def test_dashboard_returns_expected_shape_for_empty_cohort(client, mock_pool):
    """Endpoint returns the full documented response shape with zeros when no data."""
    # Pool returns empty rows for every query.
    mock_pool.fetch.return_value = []
    mock_pool.fetchrow.return_value = None

    resp = client.get("/api/operations/dashboard")
    assert resp.status_code == 200

    body = resp.json()
    # Top-level keys
    assert set(body.keys()) == {
        "cohort",
        "headline",
        "pipeline",
        "kitchen",
        "customers",
        "loyalty",
        "leaderboard",
    }
    # Cohort block
    assert body["cohort"] == {"store_count": 0, "store_ids": []}
    # Headline block has the 6 keys we care about
    assert set(body["headline"].keys()) == {
        "revenue_today",
        "orders_active",
        "drivers_out",
        "kitchens_busy",
        "avg_delivery_min",
        "sla_health_pct",
    }
    # Leaderboard is a list
    assert body["leaderboard"] == []
```

- [ ] **Step 2: Run the test — expect failure**

Run: `pytest tests/backend/test_operations.py -v`

Expected: FAIL with 404 (endpoint does not exist yet).

- [ ] **Step 3: Commit the failing test**

```bash
git add tests/backend/test_operations.py
git commit -m "test(operations): failing test for dashboard endpoint shape

Co-authored-by: Isaac"
```

---

## Task 3: Endpoint skeleton — empty payload, full shape

**Files:**
- Create: `backend/routes/operations.py`
- Modify: `backend/main.py`

- [ ] **Step 1: Create the endpoint skeleton**

Create `backend/routes/operations.py`:

```python
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
```

- [ ] **Step 2: Register the router in `backend/main.py`**

Modify `backend/main.py` — at the top, alongside the existing `from backend.routes import drivers, markets, orders, playback` line, add `operations`:

```python
from backend.routes import drivers, markets, operations, orders, playback
```

And alongside the existing `app.include_router(...)` lines, add:

```python
app.include_router(operations.router)
```

- [ ] **Step 3: Run the test — expect pass**

Run: `pytest tests/backend/test_operations.py -v`

Expected: 1 passed.

- [ ] **Step 4: Commit**

```bash
git add backend/routes/operations.py backend/main.py
git commit -m "feat(operations): scaffold /api/operations/dashboard endpoint

Registers a new composite dashboard endpoint that returns the documented
empty-shape payload. SQL queries land in subsequent commits.

Co-authored-by: Isaac"
```

---

## Task 4: Resolve cohort — honor `?stores=` and return real store_count

**Files:**
- Modify: `backend/routes/operations.py`
- Modify: `tests/backend/test_operations.py`

- [ ] **Step 1: Write the failing test**

Append to `tests/backend/test_operations.py`:

```python
def test_dashboard_resolves_full_cohort_when_no_filter(client, mock_pool):
    """With no ?stores= param, cohort = all stores from locations_synced."""
    from tests.backend.conftest import sql_dispatch

    mock_pool.fetch.side_effect = sql_dispatch({
        "simulator.locations_synced ORDER BY location_id": [
            {"location_id": 1}, {"location_id": 2}, {"location_id": 3},
        ],
    })

    resp = client.get("/api/operations/dashboard")
    assert resp.status_code == 200
    body = resp.json()
    assert body["cohort"]["store_count"] == 3
    assert body["cohort"]["store_ids"] == ["1", "2", "3"]


def test_dashboard_resolves_filtered_cohort(client, mock_pool):
    """With ?stores=1,3 the cohort is exactly those ids (no DB round-trip needed)."""
    # Locations query shouldn't be called when cohort is explicit, but provide a
    # permissive mock just in case.
    mock_pool.fetch.return_value = []

    resp = client.get("/api/operations/dashboard?stores=1,3")
    assert resp.status_code == 200
    body = resp.json()
    assert body["cohort"]["store_count"] == 2
    assert body["cohort"]["store_ids"] == ["1", "3"]
```

- [ ] **Step 2: Run tests — expect two failures**

Run: `pytest tests/backend/test_operations.py -v`

Expected: `test_dashboard_resolves_full_cohort_when_no_filter` and `test_dashboard_resolves_filtered_cohort` both FAIL (`store_count` is 0).

- [ ] **Step 3: Implement cohort resolution**

Replace the `get_dashboard` function body in `backend/routes/operations.py`:

```python
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


@router.get("/operations/dashboard")
async def get_dashboard(stores: str | None = Query(default=None)):
    """Composite operations dashboard — atomic snapshot across a cohort."""
    requested = _parse_store_ids(stores)
    pool = await get_pool()
    cohort = await _resolve_cohort(pool, requested)

    if not cohort:
        return _empty_dashboard()

    payload = _empty_dashboard()
    payload["cohort"] = {"store_count": len(cohort), "store_ids": cohort}
    payload["headline"]["kitchens_busy"]["of"] = len(cohort)
    return payload
```

- [ ] **Step 4: Run tests — expect all pass**

Run: `pytest tests/backend/test_operations.py -v`

Expected: 3 passed (includes the earlier shape test — `fetch.return_value = []` still resolves to empty cohort → empty payload).

- [ ] **Step 5: Commit**

```bash
git add backend/routes/operations.py tests/backend/test_operations.py
git commit -m "feat(operations): resolve cohort from ?stores= or catalog

Co-authored-by: Isaac"
```

---

## Task 5: Query A — headline + pipeline + kitchen + loyalty_order_pct

**Files:**
- Modify: `backend/routes/operations.py`
- Modify: `tests/backend/test_operations.py`

- [ ] **Step 1: Write the failing test**

Append to `tests/backend/test_operations.py`:

```python
def test_query_a_populates_headline_pipeline_kitchen(client, mock_pool):
    """Query A aggregates fill headline + pipeline + kitchen + loyalty_order_pct."""
    from tests.backend.conftest import sql_dispatch

    mock_pool.fetch.side_effect = sql_dispatch({
        "simulator.locations_synced ORDER BY location_id": [
            {"location_id": 1}, {"location_id": 2}, {"location_id": 3},
        ],
    })
    # Query A uses fetchrow.
    mock_pool.fetchrow.return_value = {
        "revenue_today": 12480.0,
        "orders_active": 147,
        "drivers_out": 89,
        "kitchens_busy_n": 2,
        "avg_delivery_min": 24.0,
        "sla_active_count": 100,
        "sla_red_count": 6,
        "pipeline_new": 34,
        "pipeline_kitchen": 58,
        "pipeline_ready": 22,
        "pipeline_transit": 89,
        "pipeline_delivered_today": 312,
        "kitchen_in_kitchen": 58,
        "kitchen_ready_waiting": 22,
        "kitchen_backlogged_stores": 4,
        "kitchen_avg_min": 6.2,
        "loyalty_order_pct": 64.0,
    }

    resp = client.get("/api/operations/dashboard")
    assert resp.status_code == 200
    body = resp.json()

    assert body["headline"]["revenue_today"] == 12480.0
    assert body["headline"]["orders_active"] == 147
    assert body["headline"]["drivers_out"] == 89
    assert body["headline"]["kitchens_busy"] == {"n": 2, "of": 3}
    assert body["headline"]["avg_delivery_min"] == 24.0
    # sla_health_pct = (100 - 6) / 100 * 100 = 94.0
    assert body["headline"]["sla_health_pct"] == 94.0

    assert body["pipeline"] == {
        "new": 34, "kitchen": 58, "ready": 22,
        "transit": 89, "delivered_today": 312,
    }
    assert body["kitchen"] == {
        "in_kitchen": 58, "ready_waiting": 22,
        "backlogged_stores": 4, "avg_kitchen_min": 6.2,
    }
    assert body["loyalty"]["loyalty_order_pct"] == 64.0
```

- [ ] **Step 2: Run test — expect failure**

Run: `pytest tests/backend/test_operations.py::test_query_a_populates_headline_pipeline_kitchen -v`

Expected: FAIL (values are still zeros).

- [ ] **Step 3: Implement Query A**

Add the SLA threshold constants + Query A helper + integrate into `get_dashboard` in `backend/routes/operations.py`. Insert after `_resolve_cohort`:

```python
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
```

Now update `get_dashboard` to call Query A and merge:

```python
@router.get("/operations/dashboard")
async def get_dashboard(stores: str | None = Query(default=None)):
    requested = _parse_store_ids(stores)
    pool = await get_pool()
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
```

- [ ] **Step 4: Run tests — expect all pass**

Run: `pytest tests/backend/test_operations.py -v`

Expected: 4 passed.

- [ ] **Step 5: Commit**

```bash
git add backend/routes/operations.py tests/backend/test_operations.py
git commit -m "feat(operations): implement Query A — headline/pipeline/kitchen

Aggregates active orders, today's revenue, kitchens-busy count, SLA health,
pipeline stage counts, and loyalty order pct from orders_enriched_synced.
SLA thresholds are duplicated from frontend/src/constants/sla.ts —
keep in sync.

Co-authored-by: Isaac"
```

---

## Task 6: Query B — customers today (unique + AOV + top personas)

**Files:**
- Modify: `backend/routes/operations.py`
- Modify: `tests/backend/test_operations.py`

- [ ] **Step 1: Write the failing test**

Append to `tests/backend/test_operations.py`:

```python
def test_query_b_populates_customers_section(client, mock_pool):
    """Query B fills customers.unique_today, avg_order_value, top_personas."""
    from tests.backend.conftest import sql_dispatch

    mock_pool.fetch.side_effect = sql_dispatch({
        "simulator.locations_synced ORDER BY location_id": [
            {"location_id": 1}, {"location_id": 2}, {"location_id": 3},
        ],
        # Query B aggregate — the unique_today column alias is unique to this query
        "unique_today": [
            {"unique_today": 312, "avg_order_value": 39.90},
        ],
        # Query B personas — ORDER BY n DESC LIMIT 3 is unique to this query
        "ORDER BY n DESC": [
            {"persona": "Family Night", "pct": 28.0},
            {"persona": "Late Crew",    "pct": 19.0},
            {"persona": "Solo Snacker", "pct": 14.0},
        ],
    })
    mock_pool.fetchrow.return_value = None  # Query A returns None — headline stays zero

    resp = client.get("/api/operations/dashboard")
    body = resp.json()
    assert body["customers"]["unique_today"] == 312
    assert body["customers"]["avg_order_value"] == 39.90
    assert body["customers"]["top_personas"] == [
        {"name": "Family Night", "pct": 28.0},
        {"name": "Late Crew",    "pct": 19.0},
        {"name": "Solo Snacker", "pct": 14.0},
    ]
```

- [ ] **Step 2: Run test — expect failure**

Run: `pytest tests/backend/test_operations.py::test_query_b_populates_customers_section -v`

Expected: FAIL.

- [ ] **Step 3: Implement Query B**

Add to `backend/routes/operations.py` below Query A:

```python
_QUERY_B_AGG = """
WITH sim_now AS (
    SELECT MAX(ts)::timestamp AS now_ts FROM lakeflow.all_events_synced
),
today_orders AS (
    SELECT oe.*
    FROM lakeflow.orders_enriched_synced oe, sim_now
    WHERE oe.location_id = ANY($1::text[])
      AND oe.created_at::date = sim_now.now_ts::date
),
matched AS (
    SELECT t.*, c.customer_id, c.persona
    FROM today_orders t
    LEFT JOIN simulator.customer_address_index_synced cai
        ON ROUND((t.order_body::json->>'customer_lat')::numeric, 3)
            = cai.rounded_lat
       AND ROUND((t.order_body::json->>'customer_lon')::numeric, 3)
            = cai.rounded_lon
    LEFT JOIN simulator.customers_synced c
        ON c.customer_id = cai.customer_id
)
SELECT
    COUNT(DISTINCT customer_id) FILTER (WHERE customer_id IS NOT NULL)
        AS unique_today,
    ROUND(CAST(AVG(order_total) AS numeric), 2) AS avg_order_value
FROM matched
"""


_QUERY_B_PERSONAS = """
WITH sim_now AS (
    SELECT MAX(ts)::timestamp AS now_ts FROM lakeflow.all_events_synced
),
today_matched AS (
    SELECT c.persona
    FROM lakeflow.orders_enriched_synced oe, sim_now
    LEFT JOIN simulator.customer_address_index_synced cai
        ON ROUND((oe.order_body::json->>'customer_lat')::numeric, 3)
            = cai.rounded_lat
       AND ROUND((oe.order_body::json->>'customer_lon')::numeric, 3)
            = cai.rounded_lon
    LEFT JOIN simulator.customers_synced c
        ON c.customer_id = cai.customer_id
    WHERE oe.location_id = ANY($1::text[])
      AND oe.created_at::date = sim_now.now_ts::date
      AND c.persona IS NOT NULL
),
counts AS (
    SELECT persona, COUNT(*) AS n FROM today_matched GROUP BY persona
),
total AS (SELECT SUM(n) AS total FROM counts)
SELECT persona, ROUND(CAST(100.0 * n / NULLIF(total, 0) AS numeric), 1) AS pct
FROM counts, total
ORDER BY n DESC
LIMIT 3
"""


async def _query_b(pool, cohort: list[str]) -> dict:
    agg_rows = await pool.fetch(_QUERY_B_AGG, cohort)
    personas = await pool.fetch(_QUERY_B_PERSONAS, cohort)
    agg = dict(agg_rows[0]) if agg_rows else {}
    return {
        "unique_today": int(agg.get("unique_today") or 0),
        "avg_order_value": float(agg.get("avg_order_value") or 0.0),
        "top_personas": [
            {"name": p["persona"], "pct": float(p["pct"])} for p in personas
        ],
    }
```

Update `get_dashboard` — after the Query A block, insert:

```python
    b = await _query_b(pool, cohort)
    payload["customers"] = b
```

- [ ] **Step 4: Run tests — expect all pass**

Run: `pytest tests/backend/test_operations.py -v`

Expected: 5 passed.

- [ ] **Step 5: Commit**

```bash
git add backend/routes/operations.py tests/backend/test_operations.py
git commit -m "feat(operations): implement Query B — customers + personas

Co-authored-by: Isaac"
```

---

## Task 7: Query C — loyalty points + avg coupon propensity

**Files:**
- Modify: `backend/routes/operations.py`
- Modify: `tests/backend/test_operations.py`

**Metric note:** `points_earned_today` is synthetic for v1 — `FLOOR(order_total)` for every order from a loyalty-member customer today. `avg_coupon_propensity` maps the string column to a numeric scale:

```
always    -> 1.0
sometimes -> 0.5
never     -> 0.0
```

- [ ] **Step 1: Write the failing test**

Append to `tests/backend/test_operations.py`:

```python
def test_query_c_populates_loyalty_points_and_propensity(client, mock_pool):
    """Query C fills loyalty.points_earned_today and avg_coupon_propensity."""
    from tests.backend.conftest import sql_dispatch

    mock_pool.fetch.side_effect = sql_dispatch({
        "simulator.locations_synced ORDER BY location_id": [
            {"location_id": 1}, {"location_id": 2}, {"location_id": 3},
        ],
        # Query C — matched by the unique identifier in the SELECT clause
        "points_earned_today": [
            {"points_earned_today": 8240, "avg_coupon_propensity": 0.58},
        ],
    })
    mock_pool.fetchrow.return_value = None  # Query A

    resp = client.get("/api/operations/dashboard")
    body = resp.json()
    assert body["loyalty"]["points_earned_today"] == 8240
    assert body["loyalty"]["avg_coupon_propensity"] == 0.58
```

- [ ] **Step 2: Run test — expect failure**

Run: `pytest tests/backend/test_operations.py::test_query_c_populates_loyalty_points_and_propensity -v`

Expected: FAIL.

- [ ] **Step 3: Implement Query C**

Add to `backend/routes/operations.py`:

```python
# points_earned_today is a v1 synthetic: FLOOR(order_total) for loyalty members.
# Revise when real loyalty accrual rules land.
_QUERY_C = """
WITH sim_now AS (
    SELECT MAX(ts)::timestamp AS now_ts FROM lakeflow.all_events_synced
),
today_matched AS (
    SELECT oe.order_total, c.is_loyalty_member, c.coupon_propensity
    FROM lakeflow.orders_enriched_synced oe, sim_now
    LEFT JOIN simulator.customer_address_index_synced cai
        ON ROUND((oe.order_body::json->>'customer_lat')::numeric, 3)
            = cai.rounded_lat
       AND ROUND((oe.order_body::json->>'customer_lon')::numeric, 3)
            = cai.rounded_lon
    LEFT JOIN simulator.customers_synced c
        ON c.customer_id = cai.customer_id
    WHERE oe.location_id = ANY($1::text[])
      AND oe.created_at::date = sim_now.now_ts::date
)
SELECT
    COALESCE(SUM(
        CASE WHEN is_loyalty_member THEN FLOOR(order_total)::bigint ELSE 0 END
    ), 0) AS points_earned_today,
    ROUND(CAST(AVG(
        CASE coupon_propensity
            WHEN 'always'    THEN 1.0
            WHEN 'sometimes' THEN 0.5
            WHEN 'never'     THEN 0.0
            ELSE NULL
        END
    ) AS numeric), 2) AS avg_coupon_propensity
FROM today_matched
"""


async def _query_c(pool, cohort: list[str]) -> dict:
    rows = await pool.fetch(_QUERY_C, cohort)
    row = dict(rows[0]) if rows else {}
    return {
        "points_earned_today": int(row.get("points_earned_today") or 0),
        "avg_coupon_propensity": float(row.get("avg_coupon_propensity") or 0.0),
    }
```

Update `get_dashboard` — after the Query B line, insert:

```python
    c = await _query_c(pool, cohort)
    payload["loyalty"]["points_earned_today"] = c["points_earned_today"]
    payload["loyalty"]["avg_coupon_propensity"] = c["avg_coupon_propensity"]
```

- [ ] **Step 4: Run tests — expect all pass**

Run: `pytest tests/backend/test_operations.py -v`

Expected: 6 passed.

- [ ] **Step 5: Commit**

```bash
git add backend/routes/operations.py tests/backend/test_operations.py
git commit -m "feat(operations): implement Query C — loyalty points + propensity

Co-authored-by: Isaac"
```

---

## Task 8: Query D — per-store leaderboard + SLA roll-up

**Files:**
- Modify: `backend/routes/operations.py`
- Modify: `tests/backend/test_operations.py`

- [ ] **Step 1: Write the failing test**

Append to `tests/backend/test_operations.py`:

```python
def test_query_d_populates_leaderboard(client, mock_pool):
    """Query D fills leaderboard with one row per store, default sort active_orders DESC."""
    from tests.backend.conftest import sql_dispatch

    mock_pool.fetch.side_effect = sql_dispatch({
        "FROM simulator.locations_synced\nORDER BY location_id": [
            {"location_id": 1}, {"location_id": 2},
        ],
        # Query D — per-store rows (matched by the per_store CTE name)
        "per_store AS": [
            {
                "location_id": "1",
                "location_code": "sf-mission",
                "name": "SF — Mission St",
                "active_orders": 12,
                "drivers_out": 7,
                "revenue_today": 820.00,
                "avg_delivery_min": 22.0,
                "in_kitchen": 4,
                "sla_red_count": 0,
                "sla_yellow_count": 0,
            },
            {
                "location_id": "2",
                "location_code": "sf-castro",
                "name": "SF — Castro",
                "active_orders": 9,
                "drivers_out": 4,
                "revenue_today": 640.00,
                "avg_delivery_min": 28.0,
                "in_kitchen": 3,
                "sla_red_count": 0,
                "sla_yellow_count": 2,
            },
        ],
    })
    mock_pool.fetchrow.return_value = None

    resp = client.get("/api/operations/dashboard")
    body = resp.json()
    lb = body["leaderboard"]
    assert len(lb) == 2
    assert lb[0]["location_id"] == "1"
    assert lb[0]["sla_status"] == "green"
    assert lb[0]["active_orders"] == 12
    assert lb[1]["sla_status"] == "yellow"  # has yellow, no red
    assert "sla_red_count" not in lb[0]  # internal fields stripped
```

- [ ] **Step 2: Run test — expect failure**

Run: `pytest tests/backend/test_operations.py::test_query_d_populates_leaderboard -v`

Expected: FAIL.

- [ ] **Step 3: Implement Query D**

Add to `backend/routes/operations.py`:

```python
_QUERY_D = f"""
WITH sim_now AS (
    SELECT MAX(ts)::timestamp AS now_ts FROM lakeflow.all_events_synced
),
window_orders AS (
    SELECT oe.*
    FROM lakeflow.orders_enriched_synced oe, sim_now
    WHERE oe.location_id = ANY($1::text[])
      AND oe.created_at::timestamp >= sim_now.now_ts - INTERVAL '24 hours'
),
per_store AS (
    SELECT
        wo.location_id,
        COUNT(*) FILTER (WHERE delivered_at IS NULL) AS active_orders,
        COUNT(*) FILTER (
            WHERE picked_up_at IS NOT NULL AND delivered_at IS NULL
        ) AS drivers_out,
        COALESCE(SUM(order_total) FILTER (
            WHERE delivered_at IS NOT NULL
              AND delivered_at::date = sim_now.now_ts::date
        ), 0.0) AS revenue_today,
        ROUND(CAST(EXTRACT(EPOCH FROM AVG(
            delivered_at::timestamp - picked_up_at::timestamp
        ) FILTER (
            WHERE delivered_at IS NOT NULL AND picked_up_at IS NOT NULL
              AND delivered_at > picked_up_at
              AND delivered_at::date = sim_now.now_ts::date
        )) / 60.0 AS numeric), 1) AS avg_delivery_min,
        COUNT(*) FILTER (
            WHERE kitchen_started_at IS NOT NULL AND kitchen_finished_at IS NULL
        ) AS in_kitchen,
        COUNT(*) FILTER (
            WHERE delivered_at IS NULL AND {_sla_case_expr("red")}
        ) AS sla_red_count,
        COUNT(*) FILTER (
            WHERE delivered_at IS NULL AND {_sla_case_expr("yellow")}
              AND NOT {_sla_case_expr("red")}
        ) AS sla_yellow_count
    FROM window_orders wo, sim_now
    GROUP BY wo.location_id
)
SELECT
    m.location_id::text AS location_id,
    m.location_code,
    m.name,
    COALESCE(ps.active_orders, 0) AS active_orders,
    COALESCE(ps.drivers_out, 0) AS drivers_out,
    COALESCE(ps.revenue_today, 0.0) AS revenue_today,
    ps.avg_delivery_min,
    COALESCE(ps.in_kitchen, 0) AS in_kitchen,
    COALESCE(ps.sla_red_count, 0) AS sla_red_count,
    COALESCE(ps.sla_yellow_count, 0) AS sla_yellow_count
FROM simulator.locations_synced m
LEFT JOIN per_store ps ON ps.location_id = m.location_id::text
WHERE m.location_id::text = ANY($1::text[])
ORDER BY active_orders DESC, m.location_id
"""


def _roll_up_sla(red: int, yellow: int) -> str:
    if red > 0:
        return "red"
    if yellow > 0:
        return "yellow"
    return "green"


async def _query_d(pool, cohort: list[str]) -> list[dict]:
    rows = await pool.fetch(_QUERY_D, cohort)
    out = []
    for r in rows:
        d = dict(r)
        sla_status = _roll_up_sla(
            int(d.pop("sla_red_count", 0) or 0),
            int(d.pop("sla_yellow_count", 0) or 0),
        )
        d["sla_status"] = sla_status
        # Ensure numeric types for JSON
        d["revenue_today"] = float(d["revenue_today"] or 0.0)
        if d.get("avg_delivery_min") is not None:
            d["avg_delivery_min"] = float(d["avg_delivery_min"])
        out.append(d)
    return out
```

Update `get_dashboard` — after the Query C lines, add:

```python
    payload["leaderboard"] = await _query_d(pool, cohort)
```

- [ ] **Step 4: Run tests — expect all pass**

Run: `pytest tests/backend/test_operations.py -v`

Expected: 7 passed.

- [ ] **Step 5: Commit**

```bash
git add backend/routes/operations.py tests/backend/test_operations.py
git commit -m "feat(operations): implement Query D — per-store leaderboard

Per-store active/drivers/revenue/avg-delivery/in-kitchen counts plus
SLA roll-up (worst of any active order per store).

Co-authored-by: Isaac"
```

---

## Task 9: Parallelize queries with `asyncio.gather`

**Files:**
- Modify: `backend/routes/operations.py`

Queries A/B/C/D are independent — run them in parallel for lower tail latency.

- [ ] **Step 1: Wrap calls in `asyncio.gather`**

Replace the sequential `_query_a`/`_query_b`/`_query_c`/`_query_d` call block in `get_dashboard` with:

```python
    import asyncio

    a, b, c, d = await asyncio.gather(
        _query_a(pool, cohort),
        _query_b(pool, cohort),
        _query_c(pool, cohort),
        _query_d(pool, cohort),
    )
```

Keep the merging code after `gather` unchanged — it still reads `a`, `b`, `c`, `d`.

Move the `import asyncio` to the top of the file with the other imports.

- [ ] **Step 2: Run tests — expect all pass**

Run: `pytest tests/backend/test_operations.py -v`

Expected: 7 passed. Tests are order-independent (they use `sql_dispatch` from `conftest.py`) so parallelizing doesn't break them.

- [ ] **Step 3: Commit**

```bash
git add backend/routes/operations.py
git commit -m "perf(operations): run Query A/B/C/D in parallel via asyncio.gather

Co-authored-by: Isaac"
```

---

## Task 10: Frontend — add Operations types

**Files:**
- Modify: `frontend/src/types/index.ts`

- [ ] **Step 1: Append types**

At the end of `frontend/src/types/index.ts`:

```typescript
// =============================================================================
// Store Operations (Phase 1)
// =============================================================================

export interface PersonaBreakdown {
  name: string;
  pct: number;
}

export interface StoreLeaderboardRow {
  location_id: string;
  location_code: string;
  name: string;
  active_orders: number;
  drivers_out: number;
  revenue_today: number;
  avg_delivery_min: number | null;
  in_kitchen: number;
  sla_status: "green" | "yellow" | "red";
}

export interface OperationsDashboard {
  cohort: {
    store_count: number;
    store_ids: string[];
  };
  headline: {
    revenue_today: number;
    orders_active: number;
    drivers_out: number;
    kitchens_busy: { n: number; of: number };
    avg_delivery_min: number | null;
    sla_health_pct: number;
  };
  pipeline: {
    new: number;
    kitchen: number;
    ready: number;
    transit: number;
    delivered_today: number;
  };
  kitchen: {
    in_kitchen: number;
    ready_waiting: number;
    backlogged_stores: number;
    avg_kitchen_min: number | null;
  };
  customers: {
    unique_today: number;
    avg_order_value: number;
    top_personas: PersonaBreakdown[];
  };
  loyalty: {
    loyalty_order_pct: number;
    points_earned_today: number;
    avg_coupon_propensity: number;
  };
  leaderboard: StoreLeaderboardRow[];
}
```

- [ ] **Step 2: Confirm the frontend still type-checks**

Run: `cd frontend && npm run build`

Expected: build succeeds. If it fails with unrelated errors, stop and investigate.

- [ ] **Step 3: Commit**

```bash
git add frontend/src/types/index.ts
git commit -m "types(operations): add OperationsDashboard + supporting types

Co-authored-by: Isaac"
```

---

## Task 11: Frontend — `useOperationsDashboard` hook

**Files:**
- Create: `frontend/src/hooks/useOperationsDashboard.ts`

- [ ] **Step 1: Create the hook**

```typescript
import { useCallback, useState } from "react";
import { usePolling } from "./usePolling";
import type { OperationsDashboard } from "../types";

interface UseOperationsDashboardResult {
  data: OperationsDashboard | null;
  isLoading: boolean;
  error: string | null;
}

/**
 * Polls /api/operations/dashboard every 5s using the poll-after-completion
 * pattern in `usePolling`. `storeIds` controls the `?stores=` query param —
 * empty array = all stores.
 *
 * Cohort change aborts in-flight requests and re-fetches immediately.
 */
export function useOperationsDashboard(
  storeIds: string[],
  enabled: boolean = true
): UseOperationsDashboardResult {
  const [data, setData] = useState<OperationsDashboard | null>(null);
  const [isLoading, setIsLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const cohortKey = storeIds.slice().sort().join(",");

  const fetcher = useCallback(
    async (signal: AbortSignal) => {
      const qs = cohortKey ? `?stores=${encodeURIComponent(cohortKey)}` : "";
      const res = await fetch(`/api/operations/dashboard${qs}`, { signal });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const body: OperationsDashboard = await res.json();
      if (signal.aborted) return;
      setData(body);
      setError(null);
      setIsLoading(false);
    },
    [cohortKey]
  );

  usePolling(
    async (signal) => {
      try {
        await fetcher(signal);
      } catch (err) {
        if (err instanceof DOMException && err.name === "AbortError") return;
        setError(err instanceof Error ? err.message : String(err));
        setIsLoading(false);
      }
    },
    5000,
    enabled,
    [cohortKey]
  );

  return { data, isLoading, error };
}
```

- [ ] **Step 2: Confirm build still works**

Run: `cd frontend && npm run build`

Expected: build succeeds.

- [ ] **Step 3: Commit**

```bash
git add frontend/src/hooks/useOperationsDashboard.ts
git commit -m "feat(operations): useOperationsDashboard hook (5s poll)

Co-authored-by: Isaac"
```

---

## Task 12: Frontend — extract `MapShell` from `App.tsx`

**Files:**
- Create: `frontend/src/pages/MapShell.tsx`
- Modify: `frontend/src/App.tsx` (partial — the body will move; App is rewritten in Task 13)

The current `App.tsx` body owns the whole map view. We'll move its contents into `pages/MapShell.tsx` so `App.tsx` can become a thin routes-only shell.

- [ ] **Step 1: Create `frontend/src/pages/MapShell.tsx` as a byte-for-byte copy of `App.tsx`**

Copy the entire contents of `frontend/src/App.tsx` into a new file `frontend/src/pages/MapShell.tsx`. Change the final line:

```typescript
export default App;
```

to:

```typescript
export default App;
export { App as MapShell };
```

(Keep the existing `export default App` for one commit — Task 13 flips the default export. Doing it in two commits keeps each diff reviewable.)

- [ ] **Step 2: Confirm build still works**

Run: `cd frontend && npm run build`

Expected: build succeeds.

- [ ] **Step 3: Commit**

```bash
git add frontend/src/pages/MapShell.tsx
git commit -m "refactor(frontend): copy App.tsx to pages/MapShell.tsx

Preparatory step — App.tsx becomes a routes-only shell in the next commit.

Co-authored-by: Isaac"
```

---

## Task 13: Frontend — rewire `App.tsx` as routes-only shell

**Files:**
- Modify: `frontend/src/App.tsx`
- Modify: `frontend/src/main.tsx`
- Modify: `frontend/src/pages/MapShell.tsx`

- [ ] **Step 1: Replace `App.tsx` with a routes-only shell**

Overwrite `frontend/src/App.tsx` with:

```typescript
import React from "react";
import { Routes, Route } from "react-router-dom";
import { MapShell } from "./pages/MapShell";
import { OperationsPage } from "./pages/OperationsPage";

const App: React.FC = () => {
  return (
    <Routes>
      <Route path="/" element={<MapShell />} />
      <Route path="/operations" element={<OperationsPage />} />
    </Routes>
  );
};

export default App;
```

- [ ] **Step 2: Simplify `main.tsx` so it wraps `<App />` in `<BrowserRouter>` without its own `<Routes>`**

Replace `frontend/src/main.tsx` with:

```typescript
import React from "react";
import ReactDOM from "react-dom/client";
import { BrowserRouter } from "react-router-dom";
import App from "./App";
import "./styles/dominos-theme.css";
import "maplibre-gl/dist/maplibre-gl.css";

ReactDOM.createRoot(document.getElementById("root")!).render(
  <React.StrictMode>
    <BrowserRouter>
      <App />
    </BrowserRouter>
  </React.StrictMode>
);
```

- [ ] **Step 3: Flip `MapShell.tsx` default export**

In `frontend/src/pages/MapShell.tsx`, change the last two lines from:

```typescript
export default App;
export { App as MapShell };
```

to:

```typescript
export { App as MapShell };
```

(We only need the named export now — App.tsx imports `MapShell` by name.)

- [ ] **Step 4: Create a placeholder `OperationsPage`**

Create `frontend/src/pages/OperationsPage.tsx`:

```typescript
import React from "react";

export const OperationsPage: React.FC = () => {
  return (
    <div style={{ padding: 24, color: "var(--text-primary)" }}>
      <h2>Operations</h2>
      <p>Dashboard content coming in the next task.</p>
    </div>
  );
};

export default OperationsPage;
```

- [ ] **Step 5: Build and manually verify**

Run: `cd frontend && npm run build`

Expected: build succeeds.

Run: `cd frontend && npm run dev` — open `http://localhost:5173/` (map) and `http://localhost:5173/operations` (placeholder). Both should load.

- [ ] **Step 6: Commit**

```bash
git add frontend/src/App.tsx frontend/src/main.tsx frontend/src/pages/MapShell.tsx frontend/src/pages/OperationsPage.tsx
git commit -m "refactor(frontend): routes-only App.tsx; add /operations placeholder

App.tsx is now a thin <Routes> wrapper. main.tsx no longer owns routing.
Existing map view is unchanged — hosted at / via MapShell.

Co-authored-by: Isaac"
```

---

## Task 14: Frontend — `TopNav` component

**Files:**
- Create: `frontend/src/components/TopNav.tsx`
- Modify: `frontend/src/App.tsx`

- [ ] **Step 1: Create `TopNav.tsx`**

```typescript
import React from "react";
import { NavLink } from "react-router-dom";

interface TopNavProps {
  storeCount?: number;
  simTime?: string;
}

export const TopNav: React.FC<TopNavProps> = ({ storeCount, simTime }) => {
  return (
    <div className="top-nav">
      <div className="top-nav-brand">
        <div className="app-logo">D</div>
        <span className="app-title">Delivery Digital Twin</span>
      </div>
      <div className="top-nav-pills">
        <NavLink
          to="/"
          end
          className={({ isActive }) =>
            `top-nav-pill ${isActive ? "top-nav-pill-active" : ""}`
          }
        >
          Map
        </NavLink>
        <NavLink
          to="/operations"
          className={({ isActive }) =>
            `top-nav-pill ${isActive ? "top-nav-pill-active" : ""}`
          }
        >
          Operations
        </NavLink>
      </div>
      <div className="top-nav-meta">
        {simTime && <span>sim-time {simTime}</span>}
        {storeCount != null && <span>· {storeCount} stores</span>}
      </div>
    </div>
  );
};

const style = document.createElement("style");
style.textContent = `
  .top-nav {
    display: flex;
    align-items: center;
    justify-content: space-between;
    padding: 0 16px;
    height: 44px;
    background: var(--surface-elevated);
    border-bottom: 1px solid var(--border-default);
    flex-shrink: 0;
    position: sticky;
    top: 0;
    z-index: 100;
  }
  .top-nav-brand {
    display: flex;
    align-items: center;
    gap: 10px;
  }
  .top-nav-pills {
    display: flex;
    gap: 4px;
  }
  .top-nav-pill {
    padding: 6px 14px;
    border-radius: 6px;
    font-size: 12px;
    font-weight: 600;
    letter-spacing: 0.3px;
    color: var(--text-secondary);
    text-decoration: none;
    text-transform: uppercase;
  }
  .top-nav-pill-active {
    background: var(--dpz-red);
    color: white;
  }
  .top-nav-meta {
    font-size: 11px;
    color: var(--text-secondary);
    display: flex;
    gap: 6px;
  }
`;
document.head.appendChild(style);
```

- [ ] **Step 2: Render `TopNav` above `<Routes>` in `App.tsx`**

Replace `frontend/src/App.tsx` with:

```typescript
import React from "react";
import { Routes, Route } from "react-router-dom";
import { TopNav } from "./components/TopNav";
import { MapShell } from "./pages/MapShell";
import { OperationsPage } from "./pages/OperationsPage";

const App: React.FC = () => {
  return (
    <div style={{ display: "flex", flexDirection: "column", height: "100vh" }}>
      <TopNav />
      <div style={{ flex: 1, minHeight: 0, display: "flex", flexDirection: "column" }}>
        <Routes>
          <Route path="/" element={<MapShell />} />
          <Route path="/operations" element={<OperationsPage />} />
        </Routes>
      </div>
    </div>
  );
};

export default App;
```

- [ ] **Step 3: Remove the now-redundant top-bar from `MapShell.tsx`**

`MapShell.tsx` still contains its own `.top-bar` block (logo + MarketTabs + mode toggle). Since `TopNav` now owns the brand and route switching, we need to:

1. Keep `MarketTabs` + `mode-toggle` in the MapShell, but move them into their own row **below** the TopNav.
2. Remove the `.logo-area` block from MapShell's `.top-bar`.

In `frontend/src/pages/MapShell.tsx`, find this block (around lines 279-310 in the original `App.tsx`):

```tsx
{/* Top Bar */}
<div className="top-bar">
  <div className="logo-area">
    <div className="app-logo">D</div>
    <span className="app-title">Delivery Digital Twin</span>
    {mode === "playback" && (
      <span className="playback-badge-indicator">PLAYBACK</span>
    )}
  </div>

  <MarketTabs ... />

  <div className="mode-toggle">...</div>
</div>
```

Replace it with:

```tsx
{/* Market + mode row (TopNav is rendered by App) */}
<div className="top-bar">
  <div className="logo-area">
    {mode === "playback" && (
      <span className="playback-badge-indicator">PLAYBACK</span>
    )}
  </div>

  <MarketTabs
    markets={markets}
    groups={marketGroups}
    activeMarketId={activeMarketId}
    onSelect={handleMarketSelect}
  />

  <div className="mode-toggle">
    {mode === "live" && <span className="live-pulse-dot" />}
    <button
      className={`mode-toggle-btn ${mode === "live" ? "mode-active" : ""}`}
      onClick={() => handleModeToggle("live")}
    >
      Live
    </button>
    <button
      className={`mode-toggle-btn ${mode === "playback" ? "mode-active-playback" : ""}`}
      onClick={() => handleModeToggle("playback")}
    >
      Playback
    </button>
  </div>
</div>
```

(The logo block stays only for the playback badge; logo itself is now in TopNav.)

- [ ] **Step 4: Build and manually verify**

Run: `cd frontend && npm run build && npm run dev`

Expected: TopNav shows at top with Map / Operations pills. `/` still shows the map with market tabs below the TopNav. `/operations` shows the placeholder.

- [ ] **Step 5: Commit**

```bash
git add frontend/src/components/TopNav.tsx frontend/src/App.tsx frontend/src/pages/MapShell.tsx
git commit -m "feat(frontend): TopNav shell with Map/Operations pills

Co-authored-by: Isaac"
```

---

## Task 15: Frontend — `StoreFilter` component (URL-driven)

**Files:**
- Create: `frontend/src/components/operations/StoreFilter.tsx`

- [ ] **Step 1: Create `StoreFilter.tsx`**

```typescript
import React, { useEffect, useState } from "react";
import { useSearchParams } from "react-router-dom";
import type { Market } from "../../types";

export const StoreFilter: React.FC = () => {
  const [searchParams, setSearchParams] = useSearchParams();
  const [markets, setMarkets] = useState<Market[]>([]);

  useEffect(() => {
    fetch("/api/markets")
      .then((r) => r.json())
      .then((data: Market[]) => {
        if (Array.isArray(data)) setMarkets(data);
      })
      .catch(() => {});
  }, []);

  const raw = searchParams.get("stores") || "";
  const selected = new Set(raw.split(",").filter(Boolean));

  const setSelected = (next: Set<string>) => {
    const params = new URLSearchParams(searchParams);
    if (next.size === 0) {
      params.delete("stores");
    } else {
      params.set("stores", Array.from(next).join(","));
    }
    setSearchParams(params, { replace: true });
  };

  const togglePill = (id: string) => {
    const next = new Set(selected);
    if (next.has(id)) next.delete(id);
    else next.add(id);
    setSelected(next);
  };

  const clearAll = () => setSelected(new Set());

  return (
    <div className="store-filter">
      <button
        className={`store-filter-pill ${selected.size === 0 ? "active" : ""}`}
        onClick={clearAll}
      >
        All stores ({markets.length})
      </button>
      {markets.map((m) => (
        <button
          key={m.location_id}
          className={`store-filter-pill ${
            selected.has(String(m.location_id)) ? "active" : ""
          }`}
          onClick={() => togglePill(String(m.location_id))}
        >
          {m.name}
        </button>
      ))}
    </div>
  );
};

const style = document.createElement("style");
style.textContent = `
  .store-filter {
    display: flex;
    flex-wrap: wrap;
    gap: 6px;
    padding: 12px 16px;
    background: var(--surface-elevated);
    border-bottom: 1px solid var(--border-default);
  }
  .store-filter-pill {
    padding: 6px 12px;
    border: 1px solid var(--border-default);
    border-radius: 14px;
    background: transparent;
    color: var(--text-secondary);
    font-size: 11px;
    font-weight: 500;
    cursor: pointer;
    font-family: var(--font-family);
  }
  .store-filter-pill.active {
    background: var(--dpz-red);
    color: white;
    border-color: var(--dpz-red);
  }
`;
document.head.appendChild(style);
```

- [ ] **Step 2: Verify build**

Run: `cd frontend && npm run build`

- [ ] **Step 3: Commit**

```bash
git add frontend/src/components/operations/StoreFilter.tsx
git commit -m "feat(operations): StoreFilter — URL-driven multi-select pills

Co-authored-by: Isaac"
```

---

## Task 16: Frontend — `HeadlineKpis` component

**Files:**
- Create: `frontend/src/components/operations/HeadlineKpis.tsx`

- [ ] **Step 1: Create `HeadlineKpis.tsx`**

```typescript
import React from "react";
import type { OperationsDashboard } from "../../types";

interface Props {
  data: OperationsDashboard["headline"] | null;
}

function fmtDollars(n: number): string {
  return `$${Math.round(n).toLocaleString()}`;
}

function fmtMinutes(n: number | null): string {
  return n == null ? "—" : `${n.toFixed(1)} min`;
}

export const HeadlineKpis: React.FC<Props> = ({ data }) => {
  if (!data) {
    return (
      <div className="hk-grid">
        {[1, 2, 3, 4, 5, 6].map((i) => (
          <div key={i} className="hk-tile">
            <div className="hk-label">—</div>
            <div className="hk-value">--</div>
          </div>
        ))}
      </div>
    );
  }

  const slaColor =
    data.sla_health_pct >= 90
      ? "var(--success, #4CAF50)"
      : data.sla_health_pct >= 75
      ? "var(--warning, #FFB800)"
      : "var(--dpz-red)";

  const tiles: { label: string; value: string; color?: string }[] = [
    { label: "Revenue Today", value: fmtDollars(data.revenue_today) },
    { label: "Orders Active", value: String(data.orders_active) },
    { label: "Drivers Out", value: String(data.drivers_out), color: "var(--dpz-red)" },
    {
      label: "Kitchens Busy",
      value: `${data.kitchens_busy.n} / ${data.kitchens_busy.of}`,
    },
    { label: "Avg Delivery", value: fmtMinutes(data.avg_delivery_min) },
    {
      label: "SLA Health",
      value: `${data.sla_health_pct.toFixed(0)}%`,
      color: slaColor,
    },
  ];

  return (
    <div className="hk-grid">
      {tiles.map((t) => (
        <div key={t.label} className="hk-tile">
          <div className="hk-label">{t.label}</div>
          <div className="hk-value" style={t.color ? { color: t.color } : undefined}>
            {t.value}
          </div>
        </div>
      ))}
    </div>
  );
};

const style = document.createElement("style");
style.textContent = `
  .hk-grid {
    display: grid;
    grid-template-columns: repeat(6, 1fr);
    gap: 12px;
    padding: 16px;
  }
  .hk-tile {
    background: var(--surface-card);
    border: 1px solid var(--border-default);
    border-radius: var(--radius-md, 8px);
    padding: 12px 14px;
  }
  .hk-label {
    font-size: 10px;
    text-transform: uppercase;
    letter-spacing: 0.8px;
    color: var(--text-secondary);
    margin-bottom: 4px;
  }
  .hk-value {
    font-size: 22px;
    font-weight: 700;
    color: var(--text-primary);
  }
  @media (max-width: 1100px) {
    .hk-grid { grid-template-columns: repeat(3, 1fr); }
  }
  @media (max-width: 700px) {
    .hk-grid { grid-template-columns: repeat(2, 1fr); }
  }
`;
document.head.appendChild(style);
```

- [ ] **Step 2: Verify build + commit**

Run: `cd frontend && npm run build`

```bash
git add frontend/src/components/operations/HeadlineKpis.tsx
git commit -m "feat(operations): HeadlineKpis 6-tile grid

Co-authored-by: Isaac"
```

---

## Task 17: Frontend — `ChainPipeline` component

**Files:**
- Create: `frontend/src/components/operations/ChainPipeline.tsx`

- [ ] **Step 1: Create `ChainPipeline.tsx`**

```typescript
import React from "react";
import type { OperationsDashboard } from "../../types";
import { STAGE_COLORS } from "../../types";

interface Props {
  data: OperationsDashboard["pipeline"] | null;
}

export const ChainPipeline: React.FC<Props> = ({ data }) => {
  if (!data) return null;
  const segments: { label: string; count: number; color: string }[] = [
    { label: "New", count: data.new, color: STAGE_COLORS.New },
    { label: "Kitchen", count: data.kitchen, color: STAGE_COLORS["Kitchen Prep"] },
    { label: "Ready", count: data.ready, color: STAGE_COLORS.Ready },
    { label: "Transit", count: data.transit, color: STAGE_COLORS["In Transit"] },
  ];
  const total = Math.max(
    1,
    segments.reduce((s, x) => s + x.count, 0)
  );

  return (
    <div className="cp-card">
      <div className="cp-label">Chain Pipeline</div>
      <div className="cp-bar">
        {segments.map((s) => (
          <div
            key={s.label}
            className="cp-seg"
            style={{
              flex: s.count / total,
              background: s.color,
              minWidth: s.count > 0 ? 40 : 0,
            }}
          >
            <span className="cp-seg-label">
              {s.label} {s.count}
            </span>
          </div>
        ))}
      </div>
      <div className="cp-footnote">Delivered today: {data.delivered_today}</div>
    </div>
  );
};

const style = document.createElement("style");
style.textContent = `
  .cp-card {
    background: var(--surface-card);
    border: 1px solid var(--border-default);
    border-radius: var(--radius-md, 8px);
    padding: 14px;
  }
  .cp-label {
    font-size: 10px;
    text-transform: uppercase;
    letter-spacing: 0.8px;
    color: var(--text-secondary);
    margin-bottom: 10px;
  }
  .cp-bar {
    display: flex;
    gap: 3px;
    height: 36px;
    border-radius: 4px;
    overflow: hidden;
  }
  .cp-seg {
    display: flex;
    align-items: center;
    justify-content: center;
    color: white;
    font-size: 11px;
    font-weight: 600;
    transition: flex 0.3s ease;
  }
  .cp-seg-label {
    white-space: nowrap;
    padding: 0 8px;
  }
  .cp-footnote {
    margin-top: 8px;
    font-size: 11px;
    color: var(--text-secondary);
  }
`;
document.head.appendChild(style);
```

- [ ] **Step 2: Verify build + commit**

```bash
cd frontend && npm run build
```

```bash
git add frontend/src/components/operations/ChainPipeline.tsx
git commit -m "feat(operations): ChainPipeline segmented bar

Co-authored-by: Isaac"
```

---

## Task 18: Frontend — `KitchenPanel` component

**Files:**
- Create: `frontend/src/components/operations/KitchenPanel.tsx`

- [ ] **Step 1: Create `KitchenPanel.tsx`**

```typescript
import React from "react";
import type { OperationsDashboard } from "../../types";

interface Props {
  data: OperationsDashboard["kitchen"] | null;
}

export const KitchenPanel: React.FC<Props> = ({ data }) => {
  if (!data) return null;
  return (
    <div className="ops-card">
      <div className="ops-card-label">Kitchen Status</div>
      <div className="ops-stat-row">
        <div className="ops-stat">
          <div className="ops-stat-value">{data.in_kitchen}</div>
          <div className="ops-stat-sub">In Kitchen</div>
        </div>
        <div className="ops-stat">
          <div className="ops-stat-value">{data.ready_waiting}</div>
          <div className="ops-stat-sub">Ready / Waiting</div>
        </div>
        <div className="ops-stat">
          <div
            className="ops-stat-value"
            style={{
              color:
                data.backlogged_stores > 0 ? "var(--warning, #FFB800)" : undefined,
            }}
          >
            {data.backlogged_stores}
          </div>
          <div className="ops-stat-sub">Backlogged Stores</div>
        </div>
      </div>
      <div className="ops-card-footnote">
        Avg kitchen time:{" "}
        {data.avg_kitchen_min != null ? `${data.avg_kitchen_min.toFixed(1)} min` : "—"}
      </div>
    </div>
  );
};

// Shared styles (.ops-card etc.) are registered once by the first component
// that uses them. Define them here — subsequent Customers/Loyalty panels reuse
// the same classes.
const style = document.createElement("style");
style.textContent = `
  .ops-card {
    background: var(--surface-card);
    border: 1px solid var(--border-default);
    border-radius: var(--radius-md, 8px);
    padding: 14px;
  }
  .ops-card-label {
    font-size: 10px;
    text-transform: uppercase;
    letter-spacing: 0.8px;
    color: var(--text-secondary);
    margin-bottom: 10px;
  }
  .ops-stat-row {
    display: flex;
    gap: 20px;
    margin-bottom: 8px;
  }
  .ops-stat-value {
    font-size: 22px;
    font-weight: 700;
    color: var(--text-primary);
  }
  .ops-stat-sub {
    font-size: 10px;
    text-transform: uppercase;
    letter-spacing: 0.5px;
    color: var(--text-secondary);
    margin-top: 2px;
  }
  .ops-card-footnote {
    font-size: 11px;
    color: var(--text-secondary);
  }
`;
document.head.appendChild(style);
```

- [ ] **Step 2: Verify build + commit**

```bash
cd frontend && npm run build
```

```bash
git add frontend/src/components/operations/KitchenPanel.tsx
git commit -m "feat(operations): KitchenPanel stat tile

Co-authored-by: Isaac"
```

---

## Task 19: Frontend — `CustomersPanel` component

**Files:**
- Create: `frontend/src/components/operations/CustomersPanel.tsx`

- [ ] **Step 1: Create `CustomersPanel.tsx`**

```typescript
import React from "react";
import type { OperationsDashboard } from "../../types";

interface Props {
  data: OperationsDashboard["customers"] | null;
}

function fmtDollars(n: number): string {
  return `$${n.toFixed(2)}`;
}

export const CustomersPanel: React.FC<Props> = ({ data }) => {
  if (!data) return null;
  return (
    <div className="ops-card">
      <div className="ops-card-label">Customers (Today)</div>
      <div className="ops-stat-row">
        <div className="ops-stat">
          <div className="ops-stat-value">{data.unique_today}</div>
          <div className="ops-stat-sub">Unique matched</div>
        </div>
        <div className="ops-stat">
          <div className="ops-stat-value">{fmtDollars(data.avg_order_value)}</div>
          <div className="ops-stat-sub">Avg order</div>
        </div>
      </div>
      <div className="ops-persona-list">
        {data.top_personas.length === 0 ? (
          <div className="ops-card-footnote">No persona data yet.</div>
        ) : (
          data.top_personas.map((p) => (
            <div key={p.name} className="ops-persona-row">
              <span>{p.name}</span>
              <span style={{ color: "var(--text-secondary)" }}>
                {p.pct.toFixed(1)}%
              </span>
            </div>
          ))
        )}
      </div>
      <div className="ops-card-footnote">
        Matched via rounded customer lat/lon — not all orders match.
      </div>
    </div>
  );
};

const style = document.createElement("style");
style.textContent = `
  .ops-persona-list {
    display: flex;
    flex-direction: column;
    gap: 4px;
    margin-bottom: 8px;
  }
  .ops-persona-row {
    display: flex;
    justify-content: space-between;
    font-size: 12px;
    color: var(--text-primary);
  }
`;
document.head.appendChild(style);
```

- [ ] **Step 2: Verify build + commit**

```bash
cd frontend && npm run build
```

```bash
git add frontend/src/components/operations/CustomersPanel.tsx
git commit -m "feat(operations): CustomersPanel with persona list

Co-authored-by: Isaac"
```

---

## Task 20: Frontend — `LoyaltyPanel` component

**Files:**
- Create: `frontend/src/components/operations/LoyaltyPanel.tsx`

- [ ] **Step 1: Create `LoyaltyPanel.tsx`**

```typescript
import React from "react";
import type { OperationsDashboard } from "../../types";

interface Props {
  data: OperationsDashboard["loyalty"] | null;
}

export const LoyaltyPanel: React.FC<Props> = ({ data }) => {
  if (!data) return null;
  return (
    <div className="ops-card">
      <div className="ops-card-label">Loyalty / Rewards</div>
      <div className="ops-stat-row">
        <div className="ops-stat">
          <div className="ops-stat-value">{data.loyalty_order_pct.toFixed(0)}%</div>
          <div className="ops-stat-sub">Loyalty orders</div>
        </div>
        <div className="ops-stat">
          <div className="ops-stat-value">
            {data.points_earned_today.toLocaleString()}
          </div>
          <div className="ops-stat-sub">Points earned</div>
        </div>
        <div className="ops-stat">
          <div className="ops-stat-value">
            {data.avg_coupon_propensity.toFixed(2)}
          </div>
          <div className="ops-stat-sub">Avg coupon propensity</div>
        </div>
      </div>
      <div className="ops-card-footnote">
        Points formula is v1 synthetic (FLOOR of order_total for loyalty members).
      </div>
    </div>
  );
};
```

- [ ] **Step 2: Verify build + commit**

```bash
cd frontend && npm run build
```

```bash
git add frontend/src/components/operations/LoyaltyPanel.tsx
git commit -m "feat(operations): LoyaltyPanel stat tile

Co-authored-by: Isaac"
```

---

## Task 21: Frontend — `StoreLeaderboard` component

**Files:**
- Create: `frontend/src/components/operations/StoreLeaderboard.tsx`

- [ ] **Step 1: Create `StoreLeaderboard.tsx`**

```typescript
import React, { useState, useMemo } from "react";
import { useSearchParams } from "react-router-dom";
import type { StoreLeaderboardRow } from "../../types";

interface Props {
  rows: StoreLeaderboardRow[];
}

type SortKey =
  | "name"
  | "active_orders"
  | "drivers_out"
  | "revenue_today"
  | "avg_delivery_min"
  | "in_kitchen"
  | "sla_status";

type SortDir = "asc" | "desc";

const COLUMNS: { key: SortKey; label: string; right?: boolean }[] = [
  { key: "name", label: "Store" },
  { key: "active_orders", label: "Active", right: true },
  { key: "drivers_out", label: "Drivers", right: true },
  { key: "revenue_today", label: "Rev today", right: true },
  { key: "avg_delivery_min", label: "Avg deliv", right: true },
  { key: "in_kitchen", label: "Kitchen", right: true },
  { key: "sla_status", label: "SLA", right: true },
];

const SLA_DOT: Record<StoreLeaderboardRow["sla_status"], string> = {
  green: "#4CAF50",
  yellow: "#FFB800",
  red: "#E31837",
};

export const StoreLeaderboard: React.FC<Props> = ({ rows }) => {
  const [sortKey, setSortKey] = useState<SortKey>("active_orders");
  const [sortDir, setSortDir] = useState<SortDir>("desc");
  const [, setSearchParams] = useSearchParams();

  const sorted = useMemo(() => {
    const copy = [...rows];
    copy.sort((a, b) => {
      const va = a[sortKey] as string | number | null;
      const vb = b[sortKey] as string | number | null;
      if (va == null && vb == null) return 0;
      if (va == null) return 1;
      if (vb == null) return -1;
      const cmp = typeof va === "number" && typeof vb === "number"
        ? va - vb
        : String(va).localeCompare(String(vb));
      return sortDir === "asc" ? cmp : -cmp;
    });
    return copy;
  }, [rows, sortKey, sortDir]);

  const handleHeaderClick = (key: SortKey) => {
    if (sortKey === key) {
      setSortDir(sortDir === "asc" ? "desc" : "asc");
    } else {
      setSortKey(key);
      setSortDir(key === "name" ? "asc" : "desc");
    }
  };

  const handleRowClick = (row: StoreLeaderboardRow) => {
    setSearchParams({ stores: row.location_id }, { replace: false });
  };

  return (
    <div className="lb-card">
      <div className="lb-label">
        Store Leaderboard — click row to filter
      </div>
      <table className="lb-table">
        <thead>
          <tr>
            {COLUMNS.map((c) => (
              <th
                key={c.key}
                onClick={() => handleHeaderClick(c.key)}
                className={c.right ? "lb-right" : ""}
              >
                {c.label}
                {sortKey === c.key ? (sortDir === "asc" ? " ▲" : " ▼") : ""}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {sorted.map((r) => (
            <tr key={r.location_id} onClick={() => handleRowClick(r)}>
              <td>{r.name}</td>
              <td className="lb-right">{r.active_orders}</td>
              <td className="lb-right">{r.drivers_out}</td>
              <td className="lb-right">
                ${Math.round(r.revenue_today).toLocaleString()}
              </td>
              <td className="lb-right">
                {r.avg_delivery_min != null
                  ? `${r.avg_delivery_min.toFixed(0)}m`
                  : "—"}
              </td>
              <td className="lb-right">{r.in_kitchen}</td>
              <td className="lb-right">
                <span
                  style={{
                    display: "inline-block",
                    width: 10,
                    height: 10,
                    borderRadius: "50%",
                    background: SLA_DOT[r.sla_status],
                  }}
                />
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
};

const style = document.createElement("style");
style.textContent = `
  .lb-card {
    background: var(--surface-card);
    border: 1px solid var(--border-default);
    border-radius: var(--radius-md, 8px);
    padding: 14px;
    overflow-x: auto;
  }
  .lb-label {
    font-size: 10px;
    text-transform: uppercase;
    letter-spacing: 0.8px;
    color: var(--text-secondary);
    margin-bottom: 10px;
  }
  .lb-table {
    width: 100%;
    border-collapse: collapse;
    font-size: 12px;
  }
  .lb-table th {
    text-align: left;
    font-size: 10px;
    text-transform: uppercase;
    letter-spacing: 0.5px;
    color: var(--text-secondary);
    padding: 6px 8px;
    border-bottom: 1px solid var(--border-default);
    cursor: pointer;
    user-select: none;
  }
  .lb-table td {
    padding: 8px;
    color: var(--text-primary);
    border-bottom: 1px solid rgba(255,255,255,0.04);
  }
  .lb-right {
    text-align: right;
  }
  .lb-table tbody tr {
    cursor: pointer;
  }
  .lb-table tbody tr:hover {
    background: rgba(255,255,255,0.03);
  }
`;
document.head.appendChild(style);
```

- [ ] **Step 2: Verify build + commit**

```bash
cd frontend && npm run build
```

```bash
git add frontend/src/components/operations/StoreLeaderboard.tsx
git commit -m "feat(operations): StoreLeaderboard sortable table with row-click filter

Co-authored-by: Isaac"
```

---

## Task 22: Wire sections into `OperationsPage`

**Files:**
- Modify: `frontend/src/pages/OperationsPage.tsx`

- [ ] **Step 1: Replace the placeholder with the full page**

Overwrite `frontend/src/pages/OperationsPage.tsx`:

```typescript
import React from "react";
import { useSearchParams } from "react-router-dom";
import { StoreFilter } from "../components/operations/StoreFilter";
import { HeadlineKpis } from "../components/operations/HeadlineKpis";
import { ChainPipeline } from "../components/operations/ChainPipeline";
import { KitchenPanel } from "../components/operations/KitchenPanel";
import { CustomersPanel } from "../components/operations/CustomersPanel";
import { LoyaltyPanel } from "../components/operations/LoyaltyPanel";
import { StoreLeaderboard } from "../components/operations/StoreLeaderboard";
import { useOperationsDashboard } from "../hooks/useOperationsDashboard";

export const OperationsPage: React.FC = () => {
  const [searchParams] = useSearchParams();
  const storeIds = (searchParams.get("stores") || "")
    .split(",")
    .filter(Boolean);

  const { data, isLoading, error } = useOperationsDashboard(storeIds);

  return (
    <div className="ops-page">
      <StoreFilter />
      {error && (
        <div className="ops-error-banner">
          Live data unavailable — retrying in 5s. ({error})
        </div>
      )}
      {isLoading && !data ? (
        <div className="ops-skeleton">Loading dashboard…</div>
      ) : data ? (
        <>
          <HeadlineKpis data={data.headline} />
          <div className="ops-grid-2">
            <ChainPipeline data={data.pipeline} />
            <KitchenPanel data={data.kitchen} />
            <CustomersPanel data={data.customers} />
            <LoyaltyPanel data={data.loyalty} />
          </div>
          <div className="ops-leaderboard-wrap">
            <StoreLeaderboard rows={data.leaderboard} />
          </div>
        </>
      ) : null}
    </div>
  );
};

export default OperationsPage;

const style = document.createElement("style");
style.textContent = `
  .ops-page {
    flex: 1;
    overflow-y: auto;
    background: var(--surface-base);
    display: flex;
    flex-direction: column;
  }
  .ops-grid-2 {
    display: grid;
    grid-template-columns: 1fr 1fr;
    gap: 12px;
    padding: 0 16px 16px;
  }
  .ops-leaderboard-wrap {
    padding: 0 16px 24px;
  }
  .ops-error-banner {
    background: rgba(227, 24, 55, 0.15);
    color: var(--dpz-red);
    padding: 10px 16px;
    font-size: 12px;
    border-bottom: 1px solid var(--border-default);
  }
  .ops-skeleton {
    padding: 40px;
    color: var(--text-secondary);
    font-size: 14px;
    text-align: center;
  }
  @media (max-width: 900px) {
    .ops-grid-2 { grid-template-columns: 1fr; }
  }
`;
document.head.appendChild(style);
```

- [ ] **Step 2: Build + dev-run smoke test**

Run: `cd frontend && npm run build`

Then `npm run dev` and navigate to `http://localhost:5173/operations`. Verify:
- `StoreFilter` renders with "All stores" pill + one pill per store
- Headline row shows 6 tiles
- Two-column grid shows Pipeline + Kitchen (top row), Customers + Loyalty (bottom row)
- Leaderboard at bottom with real stores
- Clicking a store pill updates the URL to `?stores=<id>`
- Clicking a leaderboard row updates the URL and filters the dashboard

- [ ] **Step 3: Commit**

```bash
git add frontend/src/pages/OperationsPage.tsx
git commit -m "feat(operations): wire all six sections in OperationsPage

Co-authored-by: Isaac"
```

---

## Task 23: Add "View in Operations" button to `StoreDetailPanel`

**Files:**
- Modify: `frontend/src/components/StoreDetailPanel.tsx`

- [ ] **Step 1: Add import + button**

In `frontend/src/components/StoreDetailPanel.tsx`, at the top of the imports:

```typescript
import { useNavigate } from "react-router-dom";
```

Inside the component body (before the `return`), add:

```typescript
  const navigate = useNavigate();
  const handleViewInOperations = () => {
    navigate(`/operations?stores=${encodeURIComponent(String(market.location_id))}`);
  };
```

In the JSX, find the `store-detail-header` block. After the existing `store-detail-live-pill` span and before the close button, add:

```jsx
<button
  type="button"
  className="store-detail-view-ops-btn"
  onClick={handleViewInOperations}
>
  View in Operations →
</button>
```

Append to the style block (or its equivalent) a new CSS rule:

```css
.store-detail-view-ops-btn {
  background: transparent;
  border: 1px solid var(--border-default);
  border-radius: 6px;
  color: var(--text-primary);
  padding: 4px 10px;
  font-size: 11px;
  font-weight: 600;
  cursor: pointer;
  font-family: var(--font-family);
}
.store-detail-view-ops-btn:hover {
  background: var(--dpz-red);
  border-color: var(--dpz-red);
  color: white;
}
```

- [ ] **Step 2: Build + manual check**

Run: `cd frontend && npm run build && npm run dev`

In the dev server:
1. Navigate to `/` (map).
2. Click a store pin → `StoreDetailPanel` slides in.
3. Click the new "View in Operations →" button.
4. Verify you land at `/operations?stores=<that_id>` and the filter pill for that store is active.

- [ ] **Step 3: Commit**

```bash
git add frontend/src/components/StoreDetailPanel.tsx
git commit -m "feat(operations): 'View in Operations' button in StoreDetailPanel

Co-authored-by: Isaac"
```

---

## Task 24: E2E — Playwright spec for `/operations`

**Files:**
- Create: `tests/e2e/specs/operations.spec.ts`

- [ ] **Step 1: Create the spec**

```typescript
import { test, expect } from "@playwright/test";

test.describe("Operations dashboard (/operations)", () => {
  test("loads all six sections", async ({ page }) => {
    await page.goto("/operations");
    await page.waitForLoadState("networkidle");

    // Headline row — 6 tiles
    await expect(page.locator(".hk-tile").nth(0)).toBeVisible({ timeout: 15000 });
    await expect(page.locator(".hk-tile").nth(5)).toBeVisible();

    // Pipeline + Kitchen
    await expect(page.getByText("Chain Pipeline")).toBeVisible();
    await expect(page.getByText("Kitchen Status")).toBeVisible();

    // Customers + Loyalty
    await expect(page.getByText("Customers (Today)")).toBeVisible();
    await expect(page.getByText("Loyalty / Rewards")).toBeVisible();

    // Leaderboard
    await expect(page.getByText("Store Leaderboard — click row to filter"))
      .toBeVisible();
  });

  test("clicking a leaderboard row narrows the filter via URL", async ({ page }) => {
    await page.goto("/operations");
    await page.waitForLoadState("networkidle");

    const firstRow = page.locator(".lb-table tbody tr").first();
    await expect(firstRow).toBeVisible({ timeout: 15000 });

    await firstRow.click();
    await page.waitForLoadState("networkidle");

    // URL now contains ?stores=<id>
    expect(page.url()).toContain("?stores=");

    // Store filter pill for that store is active
    await expect(page.locator(".store-filter-pill.active")).toHaveCount(1);
    // The "All stores" pill is NOT active anymore
    await expect(
      page.locator(".store-filter-pill.active", { hasText: "All stores" })
    ).toHaveCount(0);
  });

  test("TopNav — clicking Map returns to /", async ({ page }) => {
    await page.goto("/operations");
    await page.waitForLoadState("networkidle");

    await page.getByRole("link", { name: "Map" }).click();
    await page.waitForURL("**/");
    await expect(page.locator("#map, .maplibregl-map")).toBeVisible({
      timeout: 15000,
    });
  });

  test("StoreDetailPanel → 'View in Operations' deep-links", async ({ page }) => {
    await page.goto("/");
    await page.waitForLoadState("networkidle");

    // Click any store pin — fallback: click the map center to open the panel
    // NOTE: this test depends on the StoreDetailPanel being reachable. If the
    // existing e2e harness has a more reliable way to open it, adapt here.
    const pin = page
      .locator(".maplibregl-marker, .store-pin, [class*='store']")
      .first();
    if (await pin.isVisible().catch(() => false)) {
      await pin.click();
    } else {
      // fallback: call the store-click via exposed global if any
      test.skip(true, "No reliable store-pin selector available in this environment");
    }

    const viewBtn = page.getByRole("button", { name: /view in operations/i });
    await expect(viewBtn).toBeVisible({ timeout: 10000 });
    await viewBtn.click();

    await page.waitForURL(/\/operations\?stores=/);
    await expect(page.locator(".hk-tile").first()).toBeVisible({
      timeout: 15000,
    });
  });
});
```

- [ ] **Step 2: Run the spec**

Run (from the repo root, assuming the app is running on :8000 per `playwright.config.ts`):

```bash
cd tests/e2e && npx playwright test specs/operations.spec.ts
```

Expected: all 4 tests pass. The store-pin test may skip if no pin is selectable — that's acceptable.

If any test fails for a timing reason, bump the explicit `timeout:` value on that expect.

- [ ] **Step 3: Commit**

```bash
git add tests/e2e/specs/operations.spec.ts
git commit -m "test(e2e): Playwright spec for /operations dashboard

Covers: six sections render, leaderboard-row-click narrows filter,
top-nav Map link returns to /, and StoreDetailPanel 'View in Operations'
deep-links with the correct ?stores= param.

Co-authored-by: Isaac"
```

---

## Done — what ships

After Task 24, you have a working `/operations` page with:

- Chain-wide headline tiles + pipeline + kitchen + customers + loyalty sections
- URL-driven multi-select store filter
- Sortable leaderboard that narrows the filter on row click
- "View in Operations →" button on the map's existing `StoreDetailPanel`
- 5-second live polling via the existing `usePolling` hook
- Backend composite endpoint with 4 parallel queries via `asyncio.gather`
- Unit tests for the backend endpoint (pytest)
- E2E Playwright spec covering the primary user flows

### Suggested follow-ups (explicitly out of scope for this plan)

- Install vitest + @testing-library/react; add component tests for `StoreFilter` and `StoreLeaderboard`
- Move SLA thresholds to a shared JSON module imported by both backend and frontend (remove the `backend/routes/operations.py` duplication flagged in Task 5)
- Cross-route preservation of `activeMarketId` when returning from `/operations` to `/`
- Code-split `/operations` route so it doesn't download MapLibre for non-map users
- Add saved-views / pinned stores to `StoreFilter`
- Wire playback-mode cursor into `/operations`
