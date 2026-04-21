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
