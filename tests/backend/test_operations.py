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
