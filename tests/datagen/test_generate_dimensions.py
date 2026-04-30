import sys
from pathlib import Path

import pandas as pd
import pytest

# Add generators dir to path so we can import without installing
sys.path.insert(0, str(Path(__file__).parent.parent.parent / "datagen" / "generators"))

from generate_dimensions import CITIES, generate_locations


def test_all_cities_have_currency_fields():
    """Every city dict must have country, currency_code, currency_symbol."""
    for city in CITIES:
        assert "country" in city, f"{city['code']} missing 'country'"
        assert "currency_code" in city, f"{city['code']} missing 'currency_code'"
        assert "currency_symbol" in city, f"{city['code']} missing 'currency_symbol'"
        assert city["country"], f"{city['code']} 'country' is empty"
        assert city["currency_code"], f"{city['code']} 'currency_code' is empty"
        assert city["currency_symbol"], f"{city['code']} 'currency_symbol' is empty"


def test_generate_locations_has_currency_columns():
    """generate_locations() DataFrame must include country and currency_symbol columns."""
    df = generate_locations()
    assert "country" in df.columns
    assert "currency_symbol" in df.columns


def test_generate_locations_excludes_currency_code():
    df = generate_locations()
    assert "currency_code" not in df.columns


def test_sf_preset_produces_usd():
    """SF rows must have currency_symbol='$' and country='US'."""
    df = generate_locations()
    sf_rows = df[df["location_code"] == "sf"]
    assert len(sf_rows) == 22
    assert (sf_rows["currency_symbol"] == "$").all()
    assert (sf_rows["country"] == "US").all()


def test_london_preset_produces_gbp():
    """London rows must have currency_symbol='£' and country='GB'."""
    df = generate_locations()
    london_rows = df[df["location_code"] == "london"]
    assert len(london_rows) == 22
    assert (london_rows["currency_symbol"] == "£").all()
    assert (london_rows["country"] == "GB").all()


def test_tokyo_preset_produces_jpy():
    df = generate_locations()
    rows = df[df["location_code"] == "tokyo"]
    assert len(rows) == 22
    assert (rows["currency_symbol"] == "¥").all()
    assert (rows["country"] == "JP").all()


def test_berlin_preset_produces_eur():
    df = generate_locations()
    rows = df[df["location_code"] == "berlin"]
    assert len(rows) == 22
    assert (rows["currency_symbol"] == "€").all()
    assert (rows["country"] == "DE").all()


def test_all_presets_present():
    """All 10 presets (4 original + 6 new) must appear in the DataFrame."""
    df = generate_locations()
    expected_codes = {"sf", "sv", "bellevue", "chicago", "london", "tokyo", "berlin", "toronto", "sydney", "sao_paulo"}
    actual_codes = set(df["location_code"].unique())
    assert expected_codes == actual_codes


def test_invalid_preset_produces_empty_df():
    """Filtering by an unknown preset code should yield an empty DataFrame."""
    df = generate_locations()
    result = df[df["location_code"] == "nonexistent"].reset_index(drop=True)
    assert len(result) == 0
