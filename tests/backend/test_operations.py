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
