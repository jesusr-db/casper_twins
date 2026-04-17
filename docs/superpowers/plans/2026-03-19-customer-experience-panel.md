# Customer Experience Panel Implementation Plan

> **For agentic workers:** REQUIRED: Use superpowers:subagent-driven-development (if subagents available) or superpowers:executing-plans to implement this plan. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add a `/cx` route to the Digital Twin app showing complaint and refund data globally and per-store, backed by two new Lakebase syncs.

**Architecture:** New `backend/routes/cx.py` exposes 4 read-only FastAPI endpoints. The frontend adds React Router (prerequisite), a new `frontend/src/components/cx/` directory with 6 components, and a CX nav tab in the top bar. All data flows from two new Lakebase synced tables (`complaints.complaints_synced`, `recommender.refund_recommendations_synced`).

**Tech Stack:** FastAPI + asyncpg (backend), React 18 + TypeScript + Vite (frontend), react-router-dom v6, Lakebase Postgres via `setup/config.py` syncs.

**Spec:** `docs/superpowers/specs/2026-03-19-customer-experience-panel-design.md`

---

## File Map

### New files
- `backend/routes/cx.py` — 4 CX API endpoints
- `tests/test_cx_routes.py` — pytest tests for all 4 endpoints
- `frontend/src/components/cx/CXPanel.tsx` — route root, owns filter state + navigation
- `frontend/src/components/cx/CXGlobalView.tsx` — KPI row + filter bar + store table
- `frontend/src/components/cx/CXStoreDetail.tsx` — breadcrumb + tab container + store KPIs
- `frontend/src/components/cx/CXOverviewTab.tsx` — 2×2 dashboard grid
- `frontend/src/components/cx/CXComplaintsTab.tsx` — paginated, filterable complaints table
- `frontend/src/components/cx/CXRefundsTab.tsx` — paginated, filterable refunds table

### Modified files
- `setup/config.py` — add 2 syncs to `SYNCS`, add 2 indexes to `INDEX_SQL`
- `backend/main.py` — register `cx` router
- `frontend/src/main.tsx` — wrap in `<BrowserRouter>` + `<Routes>`
- `frontend/src/App.tsx` — add `useSearchParams` deep-link handler + CX nav tab link
- `frontend/src/types/index.ts` — add 4 CX TypeScript types

---

## Phase 0 — Data Layer

### Task 1: Add syncs and indexes to config.py

**Files:**
- Modify: `setup/config.py`

- [ ] **Step 1: Add 2 new entries to `SYNCS` list**

In `setup/config.py`, append after the existing `customer_address_index_synced` entry (before the closing `]`):

```python
    # Complaints — LLM-generated customer complaint records
    {
        "source": f"{SOURCE_CATALOG}.complaints.raw_complaints",
        "name": f"{SOURCE_CATALOG}.complaints.complaints_synced",
        "policy": SyncedTableSchedulingPolicy.CONTINUOUS,
        "pk": ["complaint_id"],
    },
    # Refund recommendations — AI agent output, batch-generated
    {
        "source": f"{SOURCE_CATALOG}.recommender.refund_recommendations",
        "name": f"{SOURCE_CATALOG}.recommender.refund_recommendations_synced",
        "policy": SyncedTableSchedulingPolicy.SNAPSHOT,
        "pk": ["order_id"],
    },
```

- [ ] **Step 2: Add 2 new indexes to `INDEX_SQL`**

In `setup/config.py`, append to the `INDEX_SQL` string before the closing `"""`:

```sql
CREATE INDEX IF NOT EXISTS idx_complaints_order_id
  ON complaints.complaints_synced (order_id);

CREATE INDEX IF NOT EXISTS idx_refunds_order_id
  ON recommender.refund_recommendations_synced (order_id);
```

- [ ] **Step 3: Verify config parses**

```bash
cd /path/to/twins
python3 -c "from setup.config import SYNCS, INDEX_SQL; print(f'SYNCS: {len(SYNCS)}, INDEX_SQL chars: {len(INDEX_SQL)}')"
```

Expected: `SYNCS: 7, INDEX_SQL chars: <some number>`

- [ ] **Step 4: Commit**

```bash
git add setup/config.py
git commit -m "feat(cx): add complaints + refund syncs and indexes to config"
```

---

## Phase 1 — Backend

### Task 2: Create cx.py route file with all 4 endpoints

**Files:**
- Create: `backend/routes/cx.py`
- Create: `tests/test_cx_routes.py`

- [ ] **Step 1: Create the test file first**

Create `tests/__init__.py` (empty) if it doesn't exist, then create `tests/test_cx_routes.py`:

```python
"""Tests for CX API endpoints — uses a mock pool to avoid requiring Lakebase."""
import pytest
from unittest.mock import AsyncMock, MagicMock, patch
from fastapi.testclient import TestClient

from backend.main import app


def make_mock_pool(fetchval=None, fetchrow=None, fetch=None):
    """Return a mock asyncpg pool with pre-configured return values."""
    pool = AsyncMock()
    pool.fetchval = AsyncMock(return_value=fetchval)
    pool.fetchrow = AsyncMock(return_value=fetchrow)
    pool.fetch = AsyncMock(return_value=fetch or [])
    return pool


@pytest.fixture
def client():
    with TestClient(app) as c:
        yield c


@patch("backend.routes.cx.get_pool")
def test_cx_summary_days_zero_allowed(mock_get_pool, client):
    """days=0 (all time) must be accepted, not rejected."""
    pool = make_mock_pool(fetch=[])
    mock_get_pool.return_value = pool
    resp = client.get("/api/cx/summary?days=0")
    assert resp.status_code == 200


@patch("backend.routes.cx.get_pool")
def test_cx_summary_defaults(mock_get_pool, client):
    """Summary endpoint returns kpis + stores keys."""
    pool = make_mock_pool(fetch=[
        {"location_id": 1, "name": "Test Store", "location_code": "TST-L1",
         "orders": 100, "complaints": 10, "complaint_rate": 10.0,
         "refund_exposure": 500.0, "top_category": "delivery_delay"}
    ])
    mock_get_pool.return_value = pool
    resp = client.get("/api/cx/summary")
    assert resp.status_code == 200
    data = resp.json()
    assert "kpis" in data
    assert "stores" in data
    assert data["stores"][0]["location_id"] == 1


@patch("backend.routes.cx.get_pool")
def test_cx_summary_rejects_negative_days(mock_get_pool, client):
    """Negative days values must be rejected. days=0 (all time) is allowed."""
    pool = make_mock_pool()
    mock_get_pool.return_value = pool
    resp = client.get("/api/cx/summary?days=-5")
    assert resp.status_code == 422


@patch("backend.routes.cx.get_pool")
def test_cx_store_detail(mock_get_pool, client):
    """Store detail endpoint returns expected shape."""
    pool = AsyncMock()
    # fetchrow for KPIs
    pool.fetchrow = AsyncMock(return_value={
        "complaints": 50, "orders": 400, "complaint_rate": 12.5,
        "refund_exposure": 2000.0, "avg_refund": 8.0
    })
    # fetch for trend, category, refund_split, top_customers (4 calls)
    pool.fetch = AsyncMock(side_effect=[
        [{"date": "2026-03-19", "complaints": 5}],     # trend
        [{"category": "delivery_delay", "count": 30, "pct": 60.0}],  # category
        [{"refund_class": "partial", "count": 28}],    # refund_split
        [{"customer_id": "c1", "name": "Jane D", "is_loyalty_member": True, "complaint_count": 3}],  # top_customers
    ])
    mock_get_pool.return_value = pool
    resp = client.get("/api/cx/stores/1")
    assert resp.status_code == 200
    data = resp.json()
    assert "kpis" in data
    assert "trend" in data
    assert "category_breakdown" in data
    assert "refund_class_split" in data
    assert "top_customers" in data


@patch("backend.routes.cx.get_pool")
def test_cx_complaints(mock_get_pool, client):
    """Complaints endpoint returns paginated rows."""
    pool = AsyncMock()
    pool.fetchval = AsyncMock(return_value=25)  # total count
    pool.fetch = AsyncMock(return_value=[
        {"complaint_id": "abc", "order_id": "ORD1", "category": "delivery_delay",
         "complaint_text": "Late!", "ts": "2026-03-19T10:00:00",
         "refund_usd": 9.25, "refund_class": "partial"}
    ])
    mock_get_pool.return_value = pool
    resp = client.get("/api/cx/stores/1/complaints")
    assert resp.status_code == 200
    data = resp.json()
    assert data["total"] == 25
    assert data["page"] == 1
    assert data["page_size"] == 50
    assert len(data["rows"]) == 1


@patch("backend.routes.cx.get_pool")
def test_cx_refunds(mock_get_pool, client):
    """Refunds endpoint returns paginated rows with last_sync_ts."""
    pool = AsyncMock()
    pool.fetchval = AsyncMock(side_effect=[
        42,                              # total count
        "2026-03-19T12:00:00+00:00",    # last_sync_ts
    ])
    pool.fetch = AsyncMock(return_value=[
        {"order_id": "ORD2", "refund_class": "partial", "refund_usd": 8.09,
         "reason": "Delivered late", "order_ts": "2026-03-19T09:00:00"}
    ])
    mock_get_pool.return_value = pool
    resp = client.get("/api/cx/stores/1/refunds")
    assert resp.status_code == 200
    data = resp.json()
    assert "last_sync_ts" in data
    assert data["total"] == 42
```

- [ ] **Step 2: Run tests — expect failures (cx.py doesn't exist yet)**

```bash
cd /path/to/twins
pip install pytest httpx pytest-asyncio -q
pytest tests/test_cx_routes.py -v 2>&1 | tail -20
```

Expected: `ImportError` or `ModuleNotFoundError` for `backend.routes.cx`.

- [ ] **Step 3: Create `backend/routes/cx.py`**

```python
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

# No _days_clause helper needed — all queries use the stable SQL pattern:
#   AND ($N = 0 OR col >= NOW() - make_interval(days => $N::int))
# This keeps positional param count constant regardless of the days value,
# avoiding asyncpg "too many arguments" errors when days=0.


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
        JOIN simulator.locations_synced loc ON oe.location_id = loc.location_id
        LEFT JOIN complaints.complaints_synced c
               ON c.order_id = oe.order_id
              AND ($2::text IS NULL OR c.complaint_category = $2)
        LEFT JOIN recommender.refund_recommendations_synced rr ON rr.order_id = oe.order_id
        WHERE ($1 = 0 OR oe.created_at >= NOW() - make_interval(days => $1::int))
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
          AND ($2 = 0 OR oe.created_at >= NOW() - make_interval(days => $2::int))
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
          AND ($2 = 0 OR c.ts >= NOW() - make_interval(days => $2::int))
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
          AND ($2 = 0 OR c.ts >= NOW() - make_interval(days => $2::int))
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
          AND ($2 = 0 OR oe.created_at >= NOW() - make_interval(days => $2::int))
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
          AND ($2 = 0 OR oe.created_at >= NOW() - make_interval(days => $2::int))
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
          AND ($2 = 0 OR c.ts >= NOW() - make_interval(days => $2::int))
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
          AND ($2 = 0 OR c.ts >= NOW() - make_interval(days => $2::int))
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
          AND ($2 = 0 OR oe.created_at >= NOW() - make_interval(days => $2::int))
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
          AND ($2 = 0 OR oe.created_at >= NOW() - make_interval(days => $2::int))
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
```

- [ ] **Step 4: Run tests — expect failures (router not registered yet)**

```bash
pytest tests/test_cx_routes.py -v 2>&1 | tail -20
```

Expected: `404` responses (routes not found).

- [ ] **Step 5: Register the cx router in `main.py`**

In `backend/main.py`, add the import and include after the existing routers:

```python
# Add to imports at top:
from backend.routes import drivers, markets, orders, playback, cx

# Add after the existing app.include_router lines:
app.include_router(cx.router)
```

- [ ] **Step 6: Run tests — expect all pass**

```bash
pytest tests/test_cx_routes.py -v
```

Expected: `5 passed`

- [ ] **Step 7: Commit**

```bash
git add backend/routes/cx.py backend/main.py tests/test_cx_routes.py tests/__init__.py
git commit -m "feat(cx): add 4 CX API endpoints with tests"
```

---

## Phase 2 — React Router Prerequisite

### Task 3: Install react-router-dom and wire routing

**Files:**
- Modify: `frontend/package.json` (via npm install)
- Modify: `frontend/src/main.tsx`
- Modify: `frontend/src/App.tsx`

- [ ] **Step 1: Install react-router-dom**

```bash
cd /path/to/twins/frontend
npm install react-router-dom@^6
```

Expected: `react-router-dom` added to `frontend/package.json` dependencies.

- [ ] **Step 2: Update `frontend/src/main.tsx` to add BrowserRouter + Routes**

Replace the entire file. **Do NOT import CXPanel yet** — it doesn't exist until Task 5. Use a placeholder for the `/cx` route:

```tsx
import React from "react";
import ReactDOM from "react-dom/client";
import { BrowserRouter, Routes, Route } from "react-router-dom";
import App from "./App";
import "./styles/dominos-theme.css";
import "maplibre-gl/dist/maplibre-gl.css";

// CXPanel imported in Task 5 after the component file is created
const CXPlaceholder: React.FC = () => (
  <div style={{ padding: 40, color: "#8ab4d4" }}>Customer Experience — coming soon</div>
);

ReactDOM.createRoot(document.getElementById("root")!).render(
  <React.StrictMode>
    <BrowserRouter>
      <Routes>
        <Route path="/" element={<App />} />
        <Route path="/cx" element={<CXPlaceholder />} />
      </Routes>
    </BrowserRouter>
  </React.StrictMode>
);
```

- [ ] **Step 3: Add `useSearchParams` deep-link handler to `App.tsx`**

Add after the existing imports at the top of `frontend/src/App.tsx`:

```tsx
import { useSearchParams } from "react-router-dom";
```

Add inside the `App` component, after the `handleDriverClick` declaration (around line 201):

```tsx
// Deep-link: open order drawer when ?order=<id> is in the URL (from CX panel links)
const [searchParams] = useSearchParams();
useEffect(() => {
  const orderId = searchParams.get("order");
  if (orderId) handleDriverClick(orderId);
}, []); // eslint-disable-line react-hooks/exhaustive-deps
```

- [ ] **Step 4: Add CX nav link to the top bar in `App.tsx`**

In the `App.tsx` JSX, find the `<div className="logo-area">` block and add a nav link after the `<span className="app-title">` line:

```tsx
import { Link, useSearchParams } from "react-router-dom";

// In the top-bar logo-area div, after app-title span:
<Link to="/cx" className="cx-nav-link">CX</Link>
```

Add a minimal style for `cx-nav-link` — append to the existing global CSS in `frontend/src/styles/dominos-theme.css`:

```css
.cx-nav-link {
  color: var(--text-secondary);
  text-decoration: none;
  font-size: 12px;
  font-weight: 600;
  letter-spacing: 0.5px;
  padding: 4px 10px;
  border-radius: 4px;
  border: 1px solid var(--border-default);
  transition: border-color 0.15s, color 0.15s;
}
.cx-nav-link:hover {
  color: var(--text-primary);
  border-color: var(--dpz-red);
}
```

- [ ] **Step 5: Verify TypeScript compiles**

```bash
cd /path/to/twins/frontend
npm run build 2>&1 | tail -20
```

Expected: Build succeeds (may warn about missing `CXPanel` import — that's fine, it's created in the next phase).

- [ ] **Step 6: Commit**

```bash
git add frontend/src/main.tsx frontend/src/App.tsx frontend/src/styles/dominos-theme.css frontend/package.json frontend/package-lock.json
git commit -m "feat(cx): wire React Router, add CX nav link, add deep-link handler"
```

---

## Phase 3 — TypeScript Types

### Task 4: Add CX types to types/index.ts

**Files:**
- Modify: `frontend/src/types/index.ts`

- [ ] **Step 1: Append CX types to `frontend/src/types/index.ts`**

Append at the end of the file:

```ts
// =============================================================================
// Customer Experience (CX) Panel types
// =============================================================================

/** Store summary row from GET /api/cx/summary */
export interface CXStoreSummary {
  location_id: number;
  name: string;
  location_code: string;
  orders: number;
  complaints: number;
  complaint_rate: number;
  refund_exposure: number;
  top_category: string | null;
}

/** Full store detail response from GET /api/cx/stores/{id} */
export interface CXStoreDetailResponse {
  kpis: {
    total_complaints: number;
    complaint_rate: number;
    refund_exposure: number;
    avg_refund: number;
  };
  trend: { date: string; complaints: number }[];
  category_breakdown: { category: string; count: number; pct: number }[];
  refund_class_split: { refund_class: string; count: number }[];
  top_customers: {
    customer_id: string;
    name: string;
    is_loyalty_member: boolean;
    complaint_count: number;
  }[];
}

/** Row from GET /api/cx/stores/{id}/complaints */
export interface CXComplaintRow {
  complaint_id: string;
  order_id: string;
  category: string;
  complaint_text: string;
  ts: string;
  refund_usd: number | null;
  refund_class: string | null;
}

/** Row from GET /api/cx/stores/{id}/refunds */
export interface CXRefundRow {
  order_id: string;
  refund_class: string;
  refund_usd: number | null;
  reason: string;
  order_ts: string;
}

/** KPIs shared between global and store-level views */
export interface CXKpis {
  total_complaints: number;
  complaint_rate: number;
  refund_exposure: number;
  avg_refund: number;
}
```

- [ ] **Step 2: Verify TypeScript sees the types**

```bash
cd /path/to/twins/frontend
npx tsc --noEmit 2>&1 | head -20
```

Expected: No errors related to CX types (other pre-existing errors are OK).

- [ ] **Step 3: Commit**

```bash
git add frontend/src/types/index.ts
git commit -m "feat(cx): add CX TypeScript types"
```

---

## Phase 4 — Frontend Components

### Task 5: Create CXPanel.tsx (route root, owns state)

**Files:**
- Create: `frontend/src/components/cx/CXPanel.tsx`

- [ ] **Step 1: Create the file**

```tsx
import React, { useState, useEffect } from "react";
import { CXGlobalView } from "./CXGlobalView";
import { CXStoreDetail } from "./CXStoreDetail";
import type { CXStoreSummary, CXKpis } from "../../types";

export type CXCategory =
  | "delivery_delay" | "missing_items" | "food_quality"
  | "service_issue" | "other" | null;

export type CXDays = 7 | 30 | 90 | 0; // 0 = all time (no filter)

interface SummaryResponse {
  kpis: CXKpis;
  stores: CXStoreSummary[];
}

export const CXPanel: React.FC = () => {
  const [days, setDays] = useState<CXDays>(30);
  const [category, setCategory] = useState<CXCategory>(null);
  const [selectedMarket, setSelectedMarket] = useState<string | null>(null);
  const [selectedStore, setSelectedStore] = useState<CXStoreSummary | null>(null);
  const [summary, setSummary] = useState<SummaryResponse | null>(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    setLoading(true);
    const params = new URLSearchParams();
    if (days > 0) params.set("days", String(days));
    if (category) params.set("category", category);

    fetch(`/api/cx/summary?${params}`)
      .then((r) => r.json())
      .then((data: SummaryResponse) => { setSummary(data); setLoading(false); })
      .catch(() => setLoading(false));
  }, [days, category]);

  if (selectedStore) {
    return (
      <CXStoreDetail
        store={selectedStore}
        days={days}
        onBack={() => setSelectedStore(null)}
      />
    );
  }

  return (
    <CXGlobalView
      summary={summary}
      loading={loading}
      days={days}
      category={category}
      selectedMarket={selectedMarket}
      onDaysChange={setDays}
      onCategoryChange={setCategory}
      onMarketChange={setSelectedMarket}
      onStoreSelect={setSelectedStore}
    />
  );
};

const style = document.createElement("style");
style.textContent = `
  .cx-root {
    min-height: 100vh;
    background: var(--surface-bg, #0a1628);
    color: var(--text-primary, #e8f0fe);
    font-family: 'DM Sans', sans-serif;
  }
  .cx-top-bar {
    display: flex;
    align-items: center;
    gap: 16px;
    padding: 12px 24px;
    background: var(--surface-elevated, #0d1f33);
    border-bottom: 2px solid var(--dpz-red, #E31837);
  }
  .cx-back-link {
    color: var(--text-secondary);
    text-decoration: none;
    font-size: 13px;
  }
  .cx-back-link:hover { color: var(--text-primary); }
  .cx-page-title {
    font-size: 16px;
    font-weight: 700;
    margin: 0;
  }
  .cx-kpi-row {
    display: flex;
    gap: 12px;
    padding: 16px 24px;
    background: var(--surface-elevated);
  }
  .cx-kpi-card {
    flex: 1;
    background: var(--surface-card, #112240);
    border: 1px solid var(--border-default, #1e3a5f);
    border-radius: 8px;
    padding: 14px 16px;
  }
  .cx-kpi-label {
    font-size: 10px;
    text-transform: uppercase;
    letter-spacing: 0.8px;
    color: var(--text-secondary);
    margin-bottom: 4px;
  }
  .cx-kpi-value {
    font-size: 24px;
    font-weight: 700;
  }
  .cx-kpi-value.red { color: #E31837; }
  .cx-kpi-value.amber { color: #FFB800; }
  .cx-kpi-value.green { color: #4CAF50; }
  .cx-content { padding: 16px 24px; }
`;
document.head.appendChild(style);
```

- [ ] **Step 2: Wire real CXPanel into `main.tsx` (replace the placeholder)**

Now that `CXPanel.tsx` exists, update `frontend/src/main.tsx` — replace `CXPlaceholder` with the real component:

```tsx
import React from "react";
import ReactDOM from "react-dom/client";
import { BrowserRouter, Routes, Route } from "react-router-dom";
import App from "./App";
import { CXPanel } from "./components/cx/CXPanel";
import "./styles/dominos-theme.css";
import "maplibre-gl/dist/maplibre-gl.css";

ReactDOM.createRoot(document.getElementById("root")!).render(
  <React.StrictMode>
    <BrowserRouter>
      <Routes>
        <Route path="/" element={<App />} />
        <Route path="/cx" element={<CXPanel />} />
      </Routes>
    </BrowserRouter>
  </React.StrictMode>
);
```

- [ ] **Step 3: Verify TypeScript builds cleanly**

```bash
cd /path/to/twins/frontend
npm run build 2>&1 | tail -10
```

Expected: Build succeeds, no TypeScript errors.

- [ ] **Step 4: Commit**

```bash
git add frontend/src/components/cx/CXPanel.tsx frontend/src/main.tsx
git commit -m "feat(cx): add CXPanel route root component"
```

---

### Task 6: Create CXGlobalView.tsx (KPI row + filter bar + store table)

**Files:**
- Create: `frontend/src/components/cx/CXGlobalView.tsx`

- [ ] **Step 1: Create the file**

```tsx
import React, { useMemo } from "react";
import { Link } from "react-router-dom";
import type { CXStoreSummary, CXKpis } from "../../types";
import type { CXCategory, CXDays } from "./CXPanel";

// Matches App.tsx CITY_GROUPS — location_code prefix → city name
const CITY_GROUPS: Record<string, string> = {
  sf: "SF Bay Area", sv: "SF Bay Area", sv2: "SF Bay Area",
  paloalto: "SF Bay Area", "palo-alto": "SF Bay Area", pa: "SF Bay Area",
  seattle: "Pacific Northwest", bellevue: "Pacific Northwest",
  chicago: "Midwest", chi: "Midwest",
};

function getMarketForStore(store: CXStoreSummary): string {
  const code = store.location_code.toLowerCase().replace(/[^a-z0-9-]/g, "");
  for (const [key, city] of Object.entries(CITY_GROUPS)) {
    if (code.startsWith(key) || code.includes(key)) return city;
  }
  return store.name.split(" ")[0];
}

const CATEGORY_LABELS: Record<string, string> = {
  delivery_delay: "Delivery Delay",
  missing_items: "Missing Items",
  food_quality: "Food Quality",
  service_issue: "Service Issue",
  other: "Other",
};

const CATEGORY_COLORS: Record<string, string> = {
  delivery_delay: "#E31837",
  missing_items: "#FF6B35",
  food_quality: "#FFB800",
  service_issue: "#006491",
  other: "#888",
};

function rateColor(rate: number): string {
  if (rate > 10) return "#E31837";
  if (rate >= 7) return "#FFB800";
  return "#4CAF50";
}

interface Props {
  summary: { kpis: CXKpis; stores: CXStoreSummary[] } | null;
  loading: boolean;
  days: CXDays;
  category: CXCategory;
  selectedMarket: string | null;
  onDaysChange: (d: CXDays) => void;
  onCategoryChange: (c: CXCategory) => void;
  onMarketChange: (m: string | null) => void;
  onStoreSelect: (s: CXStoreSummary) => void;
}

export const CXGlobalView: React.FC<Props> = ({
  summary, loading, days, category, selectedMarket,
  onDaysChange, onCategoryChange, onMarketChange, onStoreSelect,
}) => {
  const [sortCol, setSortCol] = React.useState<keyof CXStoreSummary>("complaint_rate");
  const [sortAsc, setSortAsc] = React.useState(false);

  const markets = useMemo(() => {
    if (!summary) return [];
    const seen = new Set<string>();
    for (const s of summary.stores) {
      seen.add(getMarketForStore(s));
    }
    return Array.from(seen).sort();
  }, [summary]);

  const filteredStores = useMemo(() => {
    if (!summary) return [];
    let stores = summary.stores;
    if (selectedMarket) {
      stores = stores.filter((s) => getMarketForStore(s) === selectedMarket);
    }
    return [...stores].sort((a, b) => {
      const av = a[sortCol] as number;
      const bv = b[sortCol] as number;
      return sortAsc ? av - bv : bv - av;
    });
  }, [summary, selectedMarket, sortCol, sortAsc]);

  const handleSort = (col: keyof CXStoreSummary) => {
    if (col === sortCol) setSortAsc((p) => !p);
    else { setSortCol(col); setSortAsc(false); }
  };

  const kpis = summary?.kpis;

  return (
    <div className="cx-root">
      <div className="cx-top-bar">
        <Link to="/" className="cx-back-link">← Map</Link>
        <h1 className="cx-page-title">Customer Experience</h1>
      </div>

      {/* KPI Row */}
      <div className="cx-kpi-row">
        <div className="cx-kpi-card">
          <div className="cx-kpi-label">Total Complaints</div>
          <div className="cx-kpi-value">{kpis?.total_complaints.toLocaleString() ?? "—"}</div>
        </div>
        <div className="cx-kpi-card">
          <div className="cx-kpi-label">Complaint Rate</div>
          <div className="cx-kpi-value" style={{ color: rateColor(kpis?.complaint_rate ?? 0) }}>
            {kpis ? `${kpis.complaint_rate}%` : "—"}
          </div>
        </div>
        <div className="cx-kpi-card">
          <div className="cx-kpi-label">Refund Exposure</div>
          <div className="cx-kpi-value amber">
            {kpis ? `$${kpis.refund_exposure.toLocaleString(undefined, { maximumFractionDigits: 0 })}` : "—"}
          </div>
        </div>
        <div className="cx-kpi-card">
          <div className="cx-kpi-label">Avg Refund</div>
          <div className="cx-kpi-value">
            {kpis ? `$${kpis.avg_refund.toFixed(2)}` : "—"}
          </div>
        </div>
      </div>

      {/* Filter Bar */}
      <div className="cx-filter-bar">
        <select
          className="cx-filter-select"
          value={selectedMarket ?? ""}
          onChange={(e) => onMarketChange(e.target.value || null)}
        >
          <option value="">All Markets</option>
          {markets.map((m) => <option key={m} value={m}>{m}</option>)}
        </select>
        <select
          className="cx-filter-select"
          value={category ?? ""}
          onChange={(e) => onCategoryChange((e.target.value || null) as CXCategory)}
        >
          <option value="">All Categories</option>
          {Object.entries(CATEGORY_LABELS).map(([k, v]) => <option key={k} value={k}>{v}</option>)}
        </select>
        <select
          className="cx-filter-select"
          value={days}
          onChange={(e) => onDaysChange(Number(e.target.value) as CXDays)}
        >
          <option value={7}>Last 7 days</option>
          <option value={30}>Last 30 days</option>
          <option value={90}>Last 90 days</option>
          <option value={0}>All time</option>
        </select>
      </div>

      {/* Store Table */}
      <div className="cx-content">
        {loading ? (
          <div className="cx-loading">Loading…</div>
        ) : (
          <table className="cx-table">
            <thead>
              <tr>
                <th>Store</th>
                {(["orders","complaints","complaint_rate","refund_exposure"] as const).map((col) => (
                  <th key={col} onClick={() => handleSort(col)} className="cx-th-sortable">
                    {col === "orders" ? "Orders" : col === "complaints" ? "Complaints"
                      : col === "complaint_rate" ? "Rate %" : "Refund $"}
                    {sortCol === col ? (sortAsc ? " ↑" : " ↓") : ""}
                  </th>
                ))}
                <th>Top Issue</th>
              </tr>
            </thead>
            <tbody>
              {filteredStores.map((store) => (
                <tr key={store.location_id} className="cx-table-row" onClick={() => onStoreSelect(store)}>
                  <td>{store.name} <span className="cx-code">{store.location_code}</span></td>
                  <td>{store.orders.toLocaleString()}</td>
                  <td>{store.complaints.toLocaleString()}</td>
                  <td style={{ color: rateColor(store.complaint_rate), fontWeight: 700 }}>
                    {store.complaint_rate}%
                  </td>
                  <td>${store.refund_exposure.toLocaleString(undefined, { maximumFractionDigits: 0 })}</td>
                  <td>
                    {store.top_category ? (
                      <span
                        className="cx-badge"
                        style={{ background: CATEGORY_COLORS[store.top_category] ?? "#888" }}
                      >
                        {CATEGORY_LABELS[store.top_category] ?? store.top_category}
                      </span>
                    ) : "—"}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </div>
    </div>
  );
};

const style = document.createElement("style");
style.textContent = `
  .cx-filter-bar {
    display: flex;
    gap: 10px;
    padding: 12px 24px;
    background: var(--surface-elevated);
    border-bottom: 1px solid var(--border-default);
  }
  .cx-filter-select {
    background: var(--surface-card);
    border: 1px solid var(--border-default);
    border-radius: 6px;
    color: var(--text-primary);
    padding: 6px 10px;
    font-size: 13px;
    cursor: pointer;
  }
  .cx-table {
    width: 100%;
    border-collapse: collapse;
    font-size: 13px;
  }
  .cx-table th {
    text-align: left;
    padding: 8px 12px;
    font-size: 10px;
    text-transform: uppercase;
    letter-spacing: 0.5px;
    color: var(--text-secondary);
    border-bottom: 1px solid var(--border-default);
  }
  .cx-th-sortable { cursor: pointer; user-select: none; }
  .cx-th-sortable:hover { color: var(--text-primary); }
  .cx-table-row { cursor: pointer; transition: background 0.1s; }
  .cx-table-row:hover { background: var(--surface-card); }
  .cx-table td { padding: 10px 12px; border-bottom: 1px solid rgba(30,58,95,0.4); }
  .cx-code { color: var(--text-secondary); font-size: 11px; margin-left: 6px; }
  .cx-badge {
    font-size: 10px; font-weight: 600; padding: 2px 7px;
    border-radius: 4px; color: white;
  }
  .cx-loading { padding: 40px; text-align: center; color: var(--text-secondary); }
`;
document.head.appendChild(style);
```

- [ ] **Step 2: Commit**

```bash
git add frontend/src/components/cx/CXGlobalView.tsx
git commit -m "feat(cx): add CXGlobalView with KPI bar, filters, and sortable store table"
```

---

### Task 7: Create CXStoreDetail.tsx (breadcrumb + tabs + store KPIs)

**Files:**
- Create: `frontend/src/components/cx/CXStoreDetail.tsx`

- [ ] **Step 1: Create the file**

```tsx
import React, { useState, useEffect } from "react";
import type { CXStoreSummary, CXStoreDetailResponse } from "../../types";
import { CXOverviewTab } from "./CXOverviewTab";
import { CXComplaintsTab } from "./CXComplaintsTab";
import { CXRefundsTab } from "./CXRefundsTab";
import type { CXDays } from "./CXPanel";

type StoreTab = "overview" | "complaints" | "refunds";

interface Props {
  store: CXStoreSummary;
  days: CXDays;
  onBack: () => void;
}

export const CXStoreDetail: React.FC<Props> = ({ store, days, onBack }) => {
  const [tab, setTab] = useState<StoreTab>("overview");
  const [detail, setDetail] = useState<CXStoreDetailResponse | null>(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    setLoading(true);
    const params = days > 0 ? `?days=${days}` : "";
    fetch(`/api/cx/stores/${store.location_id}${params}`)
      .then((r) => r.json())
      .then((d: CXStoreDetailResponse) => { setDetail(d); setLoading(false); })
      .catch(() => setLoading(false));
  }, [store.location_id, days]);

  const kpis = detail?.kpis ?? {
    total_complaints: store.complaints,
    complaint_rate: store.complaint_rate,
    refund_exposure: store.refund_exposure,
    avg_refund: 0,
  };

  return (
    <div className="cx-root">
      <div className="cx-top-bar">
        <button onClick={onBack} className="cx-back-btn">← Customer Experience</button>
        <span className="cx-breadcrumb-sep">/</span>
        <h1 className="cx-page-title">{store.name} <span className="cx-code">{store.location_code}</span></h1>
      </div>

      {/* Store KPI Row */}
      <div className="cx-kpi-row">
        <div className="cx-kpi-card">
          <div className="cx-kpi-label">Total Complaints</div>
          <div className="cx-kpi-value red">{kpis.total_complaints.toLocaleString()}</div>
        </div>
        <div className="cx-kpi-card">
          <div className="cx-kpi-label">Complaint Rate</div>
          <div className="cx-kpi-value" style={{ color: kpis.complaint_rate > 10 ? "#E31837" : kpis.complaint_rate >= 7 ? "#FFB800" : "#4CAF50" }}>
            {kpis.complaint_rate}%
          </div>
        </div>
        <div className="cx-kpi-card">
          <div className="cx-kpi-label">Refund Exposure</div>
          <div className="cx-kpi-value amber">
            ${kpis.refund_exposure.toLocaleString(undefined, { maximumFractionDigits: 0 })}
          </div>
        </div>
        <div className="cx-kpi-card">
          <div className="cx-kpi-label">Avg Refund</div>
          <div className="cx-kpi-value">${kpis.avg_refund.toFixed(2)}</div>
        </div>
      </div>

      {/* Tabs */}
      <div className="cx-tabs">
        {(["overview","complaints","refunds"] as StoreTab[]).map((t) => (
          <button
            key={t}
            className={`cx-tab-btn ${tab === t ? "cx-tab-active" : ""}`}
            onClick={() => setTab(t)}
          >
            {t.charAt(0).toUpperCase() + t.slice(1)}
          </button>
        ))}
      </div>

      <div className="cx-content">
        {tab === "overview" && <CXOverviewTab detail={detail} loading={loading} />}
        {tab === "complaints" && <CXComplaintsTab locationId={String(store.location_id)} days={days} />}
        {tab === "refunds" && <CXRefundsTab locationId={String(store.location_id)} days={days} />}
      </div>
    </div>
  );
};

const style = document.createElement("style");
style.textContent = `
  .cx-back-btn {
    background: none; border: none; color: var(--text-secondary);
    cursor: pointer; font-size: 13px; padding: 0;
  }
  .cx-back-btn:hover { color: var(--text-primary); }
  .cx-breadcrumb-sep { color: var(--text-secondary); margin: 0 4px; }
  .cx-tabs {
    display: flex;
    gap: 0;
    border-bottom: 1px solid var(--border-default);
    padding: 0 24px;
    background: var(--surface-elevated);
  }
  .cx-tab-btn {
    background: none; border: none; border-bottom: 2px solid transparent;
    color: var(--text-secondary); cursor: pointer;
    padding: 10px 16px; font-size: 13px; font-weight: 500;
  }
  .cx-tab-btn:hover { color: var(--text-primary); }
  .cx-tab-active { color: var(--dpz-red) !important; border-bottom-color: var(--dpz-red) !important; }
`;
document.head.appendChild(style);
```

- [ ] **Step 2: Commit**

```bash
git add frontend/src/components/cx/CXStoreDetail.tsx
git commit -m "feat(cx): add CXStoreDetail with breadcrumb and tab container"
```

---

### Task 8: Create CXOverviewTab.tsx (2×2 dashboard grid)

**Files:**
- Create: `frontend/src/components/cx/CXOverviewTab.tsx`

- [ ] **Step 1: Create the file**

```tsx
import React from "react";
import type { CXStoreDetailResponse } from "../../types";

const CATEGORY_COLORS: Record<string, string> = {
  delivery_delay: "#E31837", missing_items: "#FF6B35",
  food_quality: "#FFB800", service_issue: "#006491", other: "#888",
};
const CATEGORY_LABELS: Record<string, string> = {
  delivery_delay: "Delivery Delay", missing_items: "Missing Items",
  food_quality: "Food Quality", service_issue: "Service Issue", other: "Other",
};
const REFUND_COLORS: Record<string, string> = {
  partial: "#FFB800", none: "#1e3a5f", full: "#4CAF50", error: "#E31837",
};

interface Props {
  detail: CXStoreDetailResponse | null;
  loading: boolean;
}

export const CXOverviewTab: React.FC<Props> = ({ detail, loading }) => {
  if (loading || !detail) {
    return <div className="cx-loading">Loading overview…</div>;
  }

  const maxTrend = Math.max(...detail.trend.map((t) => t.complaints), 1);
  const maxCat = Math.max(...detail.category_breakdown.map((c) => c.count), 1);
  const totalRefund = detail.refund_class_split.reduce((s, r) => s + r.count, 0) || 1;

  return (
    <div className="cx-overview-grid">
      {/* Complaint Trend */}
      <div className="cx-chart-card">
        <div className="cx-chart-title">Complaint Trend (last 30d)</div>
        <div className="cx-bar-chart-horiz" style={{ alignItems: "flex-end", height: 80 }}>
          {detail.trend.map((t) => (
            <div key={t.date} className="cx-trend-bar-wrap" title={`${t.date}: ${t.complaints}`}>
              <div
                className="cx-trend-bar"
                style={{ height: `${(t.complaints / maxTrend) * 100}%` }}
              />
            </div>
          ))}
        </div>
        {detail.trend.length > 0 && (
          <div className="cx-chart-axis">
            <span>{detail.trend[0]?.date?.slice(5)}</span>
            <span>{detail.trend[detail.trend.length - 1]?.date?.slice(5)}</span>
          </div>
        )}
      </div>

      {/* Category Breakdown */}
      <div className="cx-chart-card">
        <div className="cx-chart-title">Category Breakdown</div>
        {detail.category_breakdown.map((c) => (
          <div key={c.category} className="cx-hbar-row">
            <div className="cx-hbar-label">{CATEGORY_LABELS[c.category] ?? c.category}</div>
            <div className="cx-hbar-track">
              <div
                className="cx-hbar-fill"
                style={{
                  width: `${(c.count / maxCat) * 100}%`,
                  background: CATEGORY_COLORS[c.category] ?? "#888",
                }}
              />
            </div>
            <div className="cx-hbar-pct">{c.pct}%</div>
          </div>
        ))}
      </div>

      {/* Refund Class Split */}
      <div className="cx-chart-card">
        <div className="cx-chart-title">Refund Class Split</div>
        <div className="cx-refund-track">
          {detail.refund_class_split.map((r) => (
            <div
              key={r.refund_class}
              title={`${r.refund_class}: ${r.count}`}
              style={{
                flex: r.count / totalRefund,
                background: REFUND_COLORS[r.refund_class] ?? "#888",
                height: 20,
              }}
            />
          ))}
        </div>
        <div className="cx-refund-legend">
          {detail.refund_class_split.map((r) => (
            <span key={r.refund_class} className="cx-legend-item">
              <span style={{ background: REFUND_COLORS[r.refund_class] ?? "#888" }} className="cx-legend-dot" />
              {r.refund_class} ({Math.round((r.count / totalRefund) * 100)}%)
            </span>
          ))}
        </div>
      </div>

      {/* Top Customers */}
      <div className="cx-chart-card">
        <div className="cx-chart-title">Top Impacted Customers</div>
        {detail.top_customers.length === 0 ? (
          <div className="cx-empty">No customer data</div>
        ) : (
          <table className="cx-top-customers-table">
            <tbody>
              {detail.top_customers.map((c) => (
                <tr key={c.customer_id}>
                  <td>{c.name}</td>
                  <td>
                    {c.is_loyalty_member && (
                      <span className="cx-badge" style={{ background: "#B8860B" }}>★ Loyalty</span>
                    )}
                  </td>
                  <td className="cx-complaint-count">{c.complaint_count}x</td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </div>
    </div>
  );
};

const style = document.createElement("style");
style.textContent = `
  .cx-overview-grid {
    display: grid;
    grid-template-columns: 1fr 1fr;
    gap: 16px;
  }
  .cx-chart-card {
    background: var(--surface-card);
    border: 1px solid var(--border-default);
    border-radius: 8px;
    padding: 16px;
  }
  .cx-chart-title {
    font-size: 10px; text-transform: uppercase; letter-spacing: 0.8px;
    color: var(--text-secondary); margin-bottom: 12px;
  }
  .cx-bar-chart-horiz { display: flex; gap: 2px; }
  .cx-trend-bar-wrap { flex: 1; display: flex; align-items: flex-end; height: 80px; }
  .cx-trend-bar { width: 100%; background: #E31837; border-radius: 2px 2px 0 0; min-height: 2px; }
  .cx-chart-axis {
    display: flex; justify-content: space-between;
    font-size: 9px; color: var(--text-secondary); margin-top: 4px;
  }
  .cx-hbar-row { display: flex; align-items: center; gap: 8px; margin-bottom: 8px; }
  .cx-hbar-label { font-size: 11px; width: 110px; flex-shrink: 0; color: var(--text-secondary); }
  .cx-hbar-track { flex: 1; background: rgba(255,255,255,0.05); border-radius: 3px; height: 10px; overflow: hidden; }
  .cx-hbar-fill { height: 100%; border-radius: 3px; transition: width 0.3s; }
  .cx-hbar-pct { font-size: 11px; width: 36px; text-align: right; color: var(--text-secondary); }
  .cx-refund-track { display: flex; border-radius: 4px; overflow: hidden; }
  .cx-refund-legend { display: flex; flex-wrap: wrap; gap: 8px; margin-top: 8px; }
  .cx-legend-item { font-size: 11px; color: var(--text-secondary); display: flex; align-items: center; gap: 4px; }
  .cx-legend-dot { width: 8px; height: 8px; border-radius: 2px; display: inline-block; }
  .cx-top-customers-table { width: 100%; border-collapse: collapse; font-size: 13px; }
  .cx-top-customers-table td { padding: 6px 0; border-bottom: 1px solid rgba(30,58,95,0.4); }
  .cx-complaint-count { text-align: right; color: var(--text-secondary); font-weight: 600; }
  .cx-empty { color: var(--text-secondary); font-size: 12px; }
`;
document.head.appendChild(style);
```

- [ ] **Step 2: Commit**

```bash
git add frontend/src/components/cx/CXOverviewTab.tsx
git commit -m "feat(cx): add CXOverviewTab 2x2 dashboard grid"
```

---

### Task 9: Create CXComplaintsTab.tsx (paginated complaints table)

**Files:**
- Create: `frontend/src/components/cx/CXComplaintsTab.tsx`

- [ ] **Step 1: Create the file**

```tsx
import React, { useState, useEffect } from "react";
import { useNavigate } from "react-router-dom";
import type { CXComplaintRow } from "../../types";
import type { CXCategory, CXDays } from "./CXPanel";

const CATEGORY_COLORS: Record<string, string> = {
  delivery_delay: "#E31837", missing_items: "#FF6B35",
  food_quality: "#FFB800", service_issue: "#006491", other: "#888",
};
const CATEGORY_LABELS: Record<string, string> = {
  delivery_delay: "Delivery Delay", missing_items: "Missing Items",
  food_quality: "Food Quality", service_issue: "Service Issue", other: "Other",
};
const REFUND_CLASS_COLORS: Record<string, string> = {
  partial: "#FFB800", full: "#4CAF50", none: "rgba(255,255,255,0.1)", error: "#E31837",
};

interface Props {
  locationId: string;
  days: CXDays;
}

interface ComplaintsResponse {
  total: number;
  page: number;
  page_size: number;
  rows: CXComplaintRow[];
}

export const CXComplaintsTab: React.FC<Props> = ({ locationId, days }) => {
  const navigate = useNavigate();
  const [category, setCategory] = useState<CXCategory>(null);
  const [page, setPage] = useState(1);
  const [data, setData] = useState<ComplaintsResponse | null>(null);
  const [loading, setLoading] = useState(true);
  const [expandedId, setExpandedId] = useState<string | null>(null);

  useEffect(() => {
    setLoading(true);
    setPage(1);
  }, [category, days]);

  useEffect(() => {
    setLoading(true);
    const params = new URLSearchParams({ page: String(page) });
    if (days > 0) params.set("days", String(days));
    if (category) params.set("category", category);

    fetch(`/api/cx/stores/${locationId}/complaints?${params}`)
      .then((r) => r.json())
      .then((d: ComplaintsResponse) => { setData(d); setLoading(false); })
      .catch(() => setLoading(false));
  }, [locationId, page, category, days]);

  const totalPages = data ? Math.ceil(data.total / data.page_size) : 0;

  return (
    <div>
      {/* Filter Bar */}
      <div className="cx-tab-filter-bar">
        <select
          className="cx-filter-select"
          value={category ?? ""}
          onChange={(e) => setCategory((e.target.value || null) as CXCategory)}
        >
          <option value="">All Categories</option>
          {Object.entries(CATEGORY_LABELS).map(([k, v]) => <option key={k} value={k}>{v}</option>)}
        </select>
      </div>

      {loading ? (
        <div className="cx-loading">Loading complaints…</div>
      ) : (
        <>
          <div className="cx-table-meta">{data?.total.toLocaleString()} complaints</div>
          <table className="cx-table">
            <thead>
              <tr>
                <th>Order ID</th>
                <th>Category</th>
                <th>Complaint</th>
                <th>Date</th>
                <th>Refund $</th>
                <th>Class</th>
              </tr>
            </thead>
            <tbody>
              {data?.rows.map((row) => (
                <React.Fragment key={row.complaint_id}>
                  <tr
                    className="cx-table-row"
                    onClick={() => setExpandedId(expandedId === row.complaint_id ? null : row.complaint_id)}
                  >
                    <td>
                      <button
                        className="cx-order-link"
                        onClick={(e) => { e.stopPropagation(); navigate(`/?order=${row.order_id}`); }}
                      >
                        #{row.order_id}
                      </button>
                    </td>
                    <td>
                      <span className="cx-badge" style={{ background: CATEGORY_COLORS[row.category] ?? "#888" }}>
                        {CATEGORY_LABELS[row.category] ?? row.category}
                      </span>
                    </td>
                    <td className="cx-truncated">
                      {row.complaint_text.length > 80
                        ? `${row.complaint_text.slice(0, 80)}…`
                        : row.complaint_text}
                    </td>
                    <td className="cx-muted">{new Date(row.ts).toLocaleString()}</td>
                    <td>{row.refund_usd != null ? `$${row.refund_usd.toFixed(2)}` : "—"}</td>
                    <td>
                      {row.refund_class ? (
                        <span className="cx-badge" style={{ background: REFUND_CLASS_COLORS[row.refund_class] ?? "#888" }}>
                          {row.refund_class}
                        </span>
                      ) : "—"}
                    </td>
                  </tr>
                  {expandedId === row.complaint_id && (
                    <tr>
                      <td colSpan={6} className="cx-expanded-text">{row.complaint_text}</td>
                    </tr>
                  )}
                </React.Fragment>
              ))}
            </tbody>
          </table>
          {totalPages > 1 && (
            <div className="cx-pagination">
              <button onClick={() => setPage((p) => Math.max(1, p - 1))} disabled={page === 1}>← Prev</button>
              <span>Page {page} of {totalPages}</span>
              <button onClick={() => setPage((p) => Math.min(totalPages, p + 1))} disabled={page === totalPages}>Next →</button>
            </div>
          )}
        </>
      )}
    </div>
  );
};

const style = document.createElement("style");
style.textContent = `
  .cx-tab-filter-bar { display: flex; gap: 10px; margin-bottom: 12px; }
  .cx-table-meta { font-size: 11px; color: var(--text-secondary); margin-bottom: 8px; }
  .cx-truncated { max-width: 280px; font-size: 12px; color: var(--text-secondary); }
  .cx-muted { color: var(--text-secondary); font-size: 12px; }
  .cx-expanded-text {
    background: var(--surface-card); font-size: 12px; padding: 10px 16px;
    color: var(--text-secondary); font-style: italic;
  }
  .cx-order-link {
    background: none; border: none; color: var(--dpz-red);
    cursor: pointer; font-size: 13px; font-weight: 600; padding: 0;
    text-decoration: underline;
  }
  .cx-order-link:hover { color: #ff4d66; }
  .cx-pagination {
    display: flex; align-items: center; gap: 12px; padding: 12px 0;
    font-size: 13px; color: var(--text-secondary);
  }
  .cx-pagination button {
    background: var(--surface-card); border: 1px solid var(--border-default);
    color: var(--text-primary); border-radius: 4px; padding: 4px 10px;
    cursor: pointer;
  }
  .cx-pagination button:disabled { opacity: 0.3; cursor: default; }
`;
document.head.appendChild(style);
```

- [ ] **Step 2: Commit**

```bash
git add frontend/src/components/cx/CXComplaintsTab.tsx
git commit -m "feat(cx): add CXComplaintsTab with pagination, category filter, order deep-link"
```

---

### Task 10: Create CXRefundsTab.tsx (paginated refunds table)

**Files:**
- Create: `frontend/src/components/cx/CXRefundsTab.tsx`

- [ ] **Step 1: Create the file**

```tsx
import React, { useState, useEffect } from "react";
import { useNavigate } from "react-router-dom";
import type { CXRefundRow } from "../../types";
import type { CXDays } from "./CXPanel";

const REFUND_CLASS_COLORS: Record<string, string> = {
  partial: "#FFB800", full: "#4CAF50", none: "rgba(255,255,255,0.1)", error: "#E31837",
};

type RefundClass = "partial" | "full" | "none" | "error" | null;

interface Props {
  locationId: string;
  days: CXDays;
}

interface RefundsResponse {
  total: number;
  page: number;
  page_size: number;
  last_sync_ts: string | null;
  rows: CXRefundRow[];
}

export const CXRefundsTab: React.FC<Props> = ({ locationId, days }) => {
  const navigate = useNavigate();
  const [refundClass, setRefundClass] = useState<RefundClass>(null);
  const [page, setPage] = useState(1);
  const [data, setData] = useState<RefundsResponse | null>(null);
  const [loading, setLoading] = useState(true);
  const [expandedId, setExpandedId] = useState<string | null>(null);

  useEffect(() => {
    setLoading(true);
    setPage(1);
  }, [refundClass, days]);

  useEffect(() => {
    setLoading(true);
    const params = new URLSearchParams({ page: String(page) });
    if (days > 0) params.set("days", String(days));
    if (refundClass) params.set("refund_class", refundClass);

    fetch(`/api/cx/stores/${locationId}/refunds?${params}`)
      .then((r) => r.json())
      .then((d: RefundsResponse) => { setData(d); setLoading(false); })
      .catch(() => setLoading(false));
  }, [locationId, page, refundClass, days]);

  const totalPages = data ? Math.ceil(data.total / data.page_size) : 0;

  return (
    <div>
      {/* Filter Bar */}
      <div className="cx-tab-filter-bar">
        <select
          className="cx-filter-select"
          value={refundClass ?? ""}
          onChange={(e) => setRefundClass((e.target.value || null) as RefundClass)}
        >
          <option value="">All Classes</option>
          <option value="partial">Partial</option>
          <option value="full">Full</option>
          <option value="none">None</option>
          <option value="error">Error</option>
        </select>
      </div>

      {data?.last_sync_ts && (
        <div className="cx-sync-note">
          Refund data as of {new Date(data.last_sync_ts).toLocaleString()}
        </div>
      )}

      {loading ? (
        <div className="cx-loading">Loading refunds…</div>
      ) : (
        <>
          <div className="cx-table-meta">{data?.total.toLocaleString()} refund records</div>
          <table className="cx-table">
            <thead>
              <tr>
                <th>Order ID</th>
                <th>Class</th>
                <th>Refund $</th>
                <th>AI Reason</th>
                <th>Order Date</th>
              </tr>
            </thead>
            <tbody>
              {data?.rows.map((row) => (
                <React.Fragment key={row.order_id}>
                  <tr
                    className="cx-table-row"
                    onClick={() => setExpandedId(expandedId === row.order_id ? null : row.order_id)}
                  >
                    <td>
                      <button
                        className="cx-order-link"
                        onClick={(e) => { e.stopPropagation(); navigate(`/?order=${row.order_id}`); }}
                      >
                        #{row.order_id}
                      </button>
                    </td>
                    <td>
                      <span
                        className="cx-badge"
                        style={{ background: REFUND_CLASS_COLORS[row.refund_class] ?? "#888" }}
                      >
                        {row.refund_class}
                      </span>
                    </td>
                    <td style={{ fontWeight: 600 }}>
                      {row.refund_usd != null ? `$${row.refund_usd.toFixed(2)}` : "—"}
                    </td>
                    <td className="cx-truncated">
                      {row.reason && row.reason.length > 100
                        ? `${row.reason.slice(0, 100)}…`
                        : (row.reason ?? "—")}
                    </td>
                    <td className="cx-muted">{new Date(row.order_ts).toLocaleString()}</td>
                  </tr>
                  {expandedId === row.order_id && (
                    <tr>
                      <td colSpan={5} className="cx-expanded-text">{row.reason}</td>
                    </tr>
                  )}
                </React.Fragment>
              ))}
            </tbody>
          </table>
          {totalPages > 1 && (
            <div className="cx-pagination">
              <button onClick={() => setPage((p) => Math.max(1, p - 1))} disabled={page === 1}>← Prev</button>
              <span>Page {page} of {totalPages}</span>
              <button onClick={() => setPage((p) => Math.min(totalPages, p + 1))} disabled={page === totalPages}>Next →</button>
            </div>
          )}
        </>
      )}
    </div>
  );
};

const style = document.createElement("style");
style.textContent = `
  .cx-sync-note {
    font-size: 11px; color: var(--text-secondary);
    margin-bottom: 8px; font-style: italic;
  }
`;
document.head.appendChild(style);
```

- [ ] **Step 2: Commit**

```bash
git add frontend/src/components/cx/CXRefundsTab.tsx
git commit -m "feat(cx): add CXRefundsTab with pagination, class filter, sync timestamp, order deep-link"
```

---

## Phase 5 — Verification

### Task 11: Build verification + backend smoke test

- [ ] **Step 1: Run TypeScript build**

```bash
cd /path/to/twins/frontend
npm run build 2>&1 | tail -30
```

Expected: Build succeeds with no TypeScript errors. Output ends with `dist/` file listing.

- [ ] **Step 2: Run full test suite**

```bash
cd /path/to/twins
pytest tests/test_cx_routes.py -v
```

Expected: `5 passed, 0 failed`

- [ ] **Step 3: Start dev server and smoke-test endpoints manually**

```bash
# Terminal 1: start backend
cd /path/to/twins
uvicorn backend.main:app --reload --port 8000

# Terminal 2: hit each endpoint
curl -s "http://localhost:8000/api/cx/summary?days=30" | python3 -m json.tool | head -20
curl -s "http://localhost:8000/api/cx/stores/1?days=30" | python3 -m json.tool | head -20
curl -s "http://localhost:8000/api/cx/stores/1/complaints?page=1" | python3 -m json.tool | head -20
curl -s "http://localhost:8000/api/cx/stores/1/refunds?page=1" | python3 -m json.tool | head -20
```

Expected: JSON responses with the shapes defined in the spec. (503 if Lakebase tables not yet synced — that's expected in a local dev environment without Lakebase access. The 503 means the app is running and the DB error middleware is working.)

- [ ] **Step 4: Final commit**

```bash
git add -A
git commit -m "feat(cx): customer experience panel — complete implementation

Adds /cx route with global store table and per-store drill-down.
Complaints tab and Refunds tab with pagination, filters, and order deep-links.
4 backend endpoints + 5 pytest tests. React Router wired into app.
Spec: docs/superpowers/specs/2026-03-19-customer-experience-panel-design.md"
```
