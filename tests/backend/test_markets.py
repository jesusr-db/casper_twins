"""
Tests for GET /api/markets — verifies currency_symbol is present in the response.
"""


def _make_market_row(currency_symbol: str) -> dict:
    """Return a minimal mock row dict matching the shape of the main SELECT query."""
    return {
        "location_id": 1,
        "location_code": "sf",
        "name": "San Francisco",
        "lat": 37.7749,
        "lon": -122.4194,
        "active_orders": 3,
        "drivers_out": 2,
        "currency_symbol": currency_symbol,
    }


def test_list_markets_includes_currency_symbol_usd(client, mock_pool):
    """USD market returns currency_symbol = '$'"""
    mock_pool.fetchval.return_value = True  # orders table exists → main query path
    mock_pool.fetch.return_value = [_make_market_row("$")]

    resp = client.get("/api/markets")

    assert resp.status_code == 200
    data = resp.json()
    assert len(data) == 1
    assert data[0]["currency_symbol"] == "$"


def test_list_markets_includes_currency_symbol_gbp(client, mock_pool):
    """GBP market returns currency_symbol = '£'"""
    mock_pool.fetchval.return_value = True  # orders table exists → main query path
    mock_pool.fetch.return_value = [_make_market_row("£")]

    resp = client.get("/api/markets")

    assert resp.status_code == 200
    data = resp.json()
    assert len(data) == 1
    assert data[0]["currency_symbol"] == "£"


def test_list_markets_fallback_includes_currency_symbol(client, mock_pool):
    """Fallback path (no orders table) also returns currency_symbol"""
    mock_pool.fetchval.return_value = False  # orders table absent → fallback query
    mock_pool.fetch.return_value = [_make_market_row("$")]

    resp = client.get("/api/markets")

    assert resp.status_code == 200
    data = resp.json()
    assert len(data) == 1
    assert data[0]["currency_symbol"] == "$"
