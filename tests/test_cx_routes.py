"""Tests for CX API endpoints — uses a mock pool to avoid requiring Lakebase."""
import pytest
from unittest.mock import AsyncMock, MagicMock, patch
from fastapi.testclient import TestClient

# Patch init_pool and close_pool before importing app to prevent Databricks auth
with patch("backend.db.init_pool", new_callable=AsyncMock), \
     patch("backend.db.close_pool", new_callable=AsyncMock):
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
    with patch("backend.db.init_pool", new_callable=AsyncMock), \
         patch("backend.db.close_pool", new_callable=AsyncMock):
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
