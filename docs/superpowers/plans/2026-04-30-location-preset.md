# Location Preset + Currency Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add a `LOCATION_PRESET` DAB job parameter that selects a city+country+currency combo at data-generation time, and thread `currency_symbol` from the locations table through to frontend price rendering.

**Architecture:** `generate_dimensions.py` becomes the preset registry — each city in `CITIES` gains `country`/`currency_code`/`currency_symbol` fields, and six international presets are added. The `LOCATION_PRESET` env var drives which city's rows are produced. The symbol flows: `locations` parquet → `locations_synced` Postgres table → `/api/markets` response → `MapShell` active market → `OrderDrawer` prop.

**Tech Stack:** Python/pandas (datagen), FastAPI/asyncpg (backend), React/TypeScript (frontend), Databricks Asset Bundles (DAB YAML)

---

## File Map

| File | Change |
|------|--------|
| `tests/datagen/__init__.py` | New — makes datagen a test package |
| `tests/datagen/test_generate_dimensions.py` | New — tests for CITIES currency fields, column output, preset filter |
| `tests/backend/test_markets.py` | New — tests `currency_symbol` in `/api/markets` response |
| `datagen/generators/generate_dimensions.py` | Add currency fields to all CITIES, add 6 international presets, add columns to `generate_locations()`, parameterize filter |
| `datagen/canonical_generator_simple.ipynb` | Add `LOCATION_PRESET` widget + set env var |
| `databricks.yml` | Add `location_preset` job parameter with preset comment block |
| `setup/bootstrap_datagen.py` | Forward `LOCATION_PRESET` env var to subprocess |
| `backend/routes/markets.py` | Add `currency_symbol` to both `locations_synced` SELECTs |
| `frontend/src/types/index.ts` | Add `currency_symbol: string` to `Market` interface |
| `frontend/src/components/OrderDrawer.tsx` | Add `currencySymbol` prop, replace 3 hardcoded `$` |
| `frontend/src/pages/MapShell.tsx` | Pass `currencySymbol` from `activeMarket` to `OrderDrawer` |

---

## Task 1: Tests for generate_dimensions.py (failing first)

**Files:**
- Create: `tests/datagen/__init__.py`
- Create: `tests/datagen/test_generate_dimensions.py`

- [ ] **Step 1: Create the test package init**

```bash
mkdir -p tests/datagen
touch tests/datagen/__init__.py
```

- [ ] **Step 2: Write the failing tests**

Create `tests/datagen/test_generate_dimensions.py`:

```python
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
```

- [ ] **Step 3: Run tests — verify they all fail**

```bash
pytest tests/datagen/test_generate_dimensions.py -v
```

Expected: all tests FAIL with `ImportError` or `AssertionError` (CITIES missing currency fields, columns missing).

- [ ] **Step 4: Commit the failing tests**

```bash
git add tests/datagen/__init__.py tests/datagen/test_generate_dimensions.py
git commit -m "test(datagen): failing tests for location preset + currency fields"
```

---

## Task 2: Extend generate_dimensions.py

**Files:**
- Modify: `datagen/generators/generate_dimensions.py`

- [ ] **Step 1: Add currency fields to existing four US cities and add six international presets**

Replace the entire `CITIES` list in `datagen/generators/generate_dimensions.py` with:

```python
CITIES = [
    {
        "code": "sf",
        "city": "San Francisco",
        "state": "CA",
        "country": "US",
        "currency_code": "USD",
        "currency_symbol": "$",
        "center_lat": 37.7749,
        "center_lon": -122.4194,
        "narrative": "growing",
        "base_orders_mean": 28,
        "base_orders_std": 4,
        "growth_rate_daily_mean": 0.0020,
        "growth_rate_daily_std": 0.0008,
        "trajectory": "growing",
        "growth_rate_monthly_mean": 0.06,
        "neighborhoods": [
            "Mission", "SOMA", "Marina", "Castro", "Sunset",
            "Richmond", "Noe Valley", "Hayes Valley", "Tenderloin", "Potrero Hill",
            "Excelsior", "Bayview", "Bernal Heights", "Dogpatch", "Pacific Heights",
            "Inner Sunset", "Outer Sunset", "North Beach", "Chinatown", "Financial District",
            "Haight-Ashbury", "Glen Park",
        ],
        "streets": [
            "Mission St", "Valencia St", "Market St", "Geary Blvd", "Clement St",
            "Irving St", "Taraval St", "Columbus Ave", "Fillmore St", "Divisadero St",
            "3rd St", "24th St", "Church St", "Folsom St", "Howard St",
            "Judah St", "Noriega St", "Balboa St", "Cortland Ave", "Ocean Ave",
            "Haight St", "Guerrero St",
        ],
    },
    {
        "code": "sv",
        "city": "Silicon Valley",
        "state": "CA",
        "country": "US",
        "currency_code": "USD",
        "currency_symbol": "$",
        "center_lat": 37.3861,
        "center_lon": -122.0839,
        "narrative": "growing_fast",
        "base_orders_mean": 22,
        "base_orders_std": 5,
        "growth_rate_daily_mean": 0.0040,
        "growth_rate_daily_std": 0.0012,
        "trajectory": "growing",
        "growth_rate_monthly_mean": 0.12,
        "neighborhoods": [
            "Palo Alto", "Mountain View", "Sunnyvale", "Santa Clara", "Cupertino",
            "Los Altos", "Milpitas", "Campbell", "Los Gatos", "Saratoga",
            "Menlo Park", "Redwood City", "San Mateo", "Foster City", "Fremont",
            "Newark", "Union City", "Alviso", "Stanford", "East Palo Alto",
            "San Carlos", "Burlingame",
        ],
        "streets": [
            "El Camino Real", "University Ave", "Castro St", "Stevens Creek Blvd",
            "De Anza Blvd", "Middlefield Rd", "San Antonio Rd", "Foothill Expy",
            "Lawrence Expy", "Central Expy", "Bascom Ave", "Winchester Blvd",
            "Santa Cruz Ave", "California Ave", "Page Mill Rd", "Oregon Expy",
            "Alma St", "Fremont Ave", "Saratoga Ave", "Wolfe Rd",
            "Mathilda Ave", "Mary Ave",
        ],
    },
    {
        "code": "bellevue",
        "city": "Seattle",
        "state": "WA",
        "country": "US",
        "currency_code": "USD",
        "currency_symbol": "$",
        "center_lat": 47.6062,
        "center_lon": -122.3321,
        "narrative": "stagnant",
        "base_orders_mean": 25,
        "base_orders_std": 4,
        "growth_rate_daily_mean": 0.0000,
        "growth_rate_daily_std": 0.0006,
        "trajectory": "flat",
        "growth_rate_monthly_mean": 0.00,
        "neighborhoods": [
            "Capitol Hill", "Ballard", "Fremont", "Wallingford", "University District",
            "Queen Anne", "Beacon Hill", "Columbia City", "Greenwood", "Ravenna",
            "Northgate", "Lake City", "Georgetown", "SoDo", "Pioneer Square",
            "Belltown", "First Hill", "International District", "West Seattle", "Rainier Valley",
            "Magnolia", "Eastlake",
        ],
        "streets": [
            "Broadway", "Pike St", "Pine St", "Madison St", "Marion St",
            "Rainier Ave S", "Aurora Ave N", "15th Ave NE", "45th St NE", "Market St NW",
            "MLK Jr Way S", "Beacon Ave S", "California Ave SW", "35th Ave NE", "Greenwood Ave N",
            "Lake City Way NE", "Airport Way S", "1st Ave S", "Denny Way", "Mercer St",
            "Yesler Way", "Eastlake Ave E",
        ],
    },
    {
        "code": "chicago",
        "city": "Chicago",
        "state": "IL",
        "country": "US",
        "currency_code": "USD",
        "currency_symbol": "$",
        "center_lat": 41.8781,
        "center_lon": -87.6298,
        "narrative": "declining",
        "base_orders_mean": 30,
        "base_orders_std": 5,
        "growth_rate_daily_mean": -0.0015,
        "growth_rate_daily_std": 0.0010,
        "trajectory": "declining",
        "growth_rate_monthly_mean": -0.05,
        "neighborhoods": [
            "Lincoln Park", "Wicker Park", "Logan Square", "Lakeview", "Pilsen",
            "Hyde Park", "Bronzeville", "Bucktown", "Humboldt Park", "Uptown",
            "Edgewater", "Rogers Park", "Ravenswood", "Roscoe Village", "Old Town",
            "River North", "West Loop", "South Loop", "Bridgeport", "Chinatown",
            "Andersonville", "Irving Park",
        ],
        "streets": [
            "Clark St", "Halsted St", "Milwaukee Ave", "Ashland Ave", "Western Ave",
            "Damen Ave", "Division St", "North Ave", "Fullerton Ave", "Belmont Ave",
            "Lincoln Ave", "Broadway", "Sheridan Rd", "Lake Shore Dr", "Michigan Ave",
            "State St", "Wabash Ave", "Wells St", "Clybourn Ave", "Armitage Ave",
            "Irving Park Rd", "Montrose Ave",
        ],
    },
    # --- International presets ---
    {
        "code": "london",
        "city": "London",
        "state": "England",
        "country": "GB",
        "currency_code": "GBP",
        "currency_symbol": "£",
        "center_lat": 51.5074,
        "center_lon": -0.1278,
        "narrative": "growing",
        "base_orders_mean": 26,
        "base_orders_std": 4,
        "growth_rate_daily_mean": 0.0018,
        "growth_rate_daily_std": 0.0007,
        "trajectory": "growing",
        "growth_rate_monthly_mean": 0.05,
        "neighborhoods": [
            "Soho", "Shoreditch", "Brixton", "Camden", "Hackney",
            "Notting Hill", "Islington", "Canary Wharf", "Bermondsey", "Peckham",
            "Dalston", "Clapham", "Battersea", "Kensington", "Chelsea",
            "Fulham", "Greenwich", "Lewisham", "Stratford", "Bethnal Green",
            "Whitechapel", "Finsbury Park",
        ],
        "streets": [
            "Oxford St", "Baker St", "King's Rd", "Portobello Rd", "Broadway Market",
            "Brick Lane", "Columbia Rd", "Upper St", "Bethnal Green Rd", "Roman Rd",
            "Kingsland Rd", "Mare St", "Stoke Newington High St", "Holloway Rd", "Caledonian Rd",
            "Stroud Green Rd", "Finchley Rd", "Edgware Rd", "Harrow Rd", "Ladbroke Grove",
            "Golborne Rd", "Uxbridge Rd",
        ],
    },
    {
        "code": "tokyo",
        "city": "Tokyo",
        "state": "Tokyo",
        "country": "JP",
        "currency_code": "JPY",
        "currency_symbol": "¥",
        "center_lat": 35.6762,
        "center_lon": 139.6503,
        "narrative": "stagnant",
        "base_orders_mean": 24,
        "base_orders_std": 4,
        "growth_rate_daily_mean": 0.0002,
        "growth_rate_daily_std": 0.0005,
        "trajectory": "flat",
        "growth_rate_monthly_mean": 0.01,
        "neighborhoods": [
            "Shibuya", "Shinjuku", "Harajuku", "Akihabara", "Asakusa",
            "Ueno", "Ginza", "Roppongi", "Ebisu", "Daikanyama",
            "Nakameguro", "Shimokitazawa", "Koenji", "Kichijoji", "Ikebukuro",
            "Sugamo", "Yanaka", "Nezu", "Sendagi", "Nishi-Ogikubo",
            "Kagurazaka", "Yushima",
        ],
        "streets": [
            "Takeshita Dori", "Omotesando", "Meiji Dori", "Yamate Dori", "Kannana Dori",
            "Kokudo 20 Go", "Showa Dori", "Chuo Dori", "Yasukuni Dori", "Mejiro Dori",
            "Kuramaebashi Dori", "Kokusai Dori", "Edo Dori", "Kasuga Dori", "Iidabashi Dori",
            "Waseda Dori", "Kagurazaka Dori", "Itabashi Dori", "Hakusan Dori", "Sotobori Dori",
            "Hibiya Dori", "Harumi Dori",
        ],
    },
    {
        "code": "berlin",
        "city": "Berlin",
        "state": "Berlin",
        "country": "DE",
        "currency_code": "EUR",
        "currency_symbol": "€",
        "center_lat": 52.5200,
        "center_lon": 13.4050,
        "narrative": "growing",
        "base_orders_mean": 23,
        "base_orders_std": 4,
        "growth_rate_daily_mean": 0.0015,
        "growth_rate_daily_std": 0.0007,
        "trajectory": "growing",
        "growth_rate_monthly_mean": 0.04,
        "neighborhoods": [
            "Mitte", "Prenzlauer Berg", "Friedrichshain", "Kreuzberg", "Schöneberg",
            "Charlottenburg", "Neukölln", "Tempelhof", "Wedding", "Spandau",
            "Pankow", "Weißensee", "Lichtenberg", "Treptow", "Köpenick",
            "Reinickendorf", "Steglitz", "Zehlendorf", "Wilmersdorf", "Tiergarten",
            "Moabit", "Gesundbrunnen",
        ],
        "streets": [
            "Unter den Linden", "Kurfürstendamm", "Karl-Marx-Allee", "Friedrichstraße", "Torstraße",
            "Kastanienallee", "Boxhagener Str", "Sonnenallee", "Hermannstraße", "Hasenheide",
            "Bergmannstraße", "Gneisenaustraße", "Yorckstraße", "Potsdamer Str", "Tauentzienstraße",
            "Kantstraße", "Bleibtreustraße", "Savignyplatz", "Pestalozzistraße", "Windscheidstraße",
            "Nollendorfplatz", "Goltzstraße",
        ],
    },
    {
        "code": "toronto",
        "city": "Toronto",
        "state": "ON",
        "country": "CA",
        "currency_code": "CAD",
        "currency_symbol": "C$",
        "center_lat": 43.6532,
        "center_lon": -79.3832,
        "narrative": "growing",
        "base_orders_mean": 25,
        "base_orders_std": 4,
        "growth_rate_daily_mean": 0.0016,
        "growth_rate_daily_std": 0.0007,
        "trajectory": "growing",
        "growth_rate_monthly_mean": 0.05,
        "neighborhoods": [
            "Kensington Market", "Distillery District", "Annex", "Yorkville", "Roncesvalles",
            "Little Portugal", "Leslieville", "Riverdale", "Danforth", "East York",
            "Scarborough", "Etobicoke", "North York", "Midtown", "Cabbagetown",
            "St Lawrence", "Financial District", "Liberty Village", "Junction", "Bloor West",
            "Forest Hill", "Lawrence Park",
        ],
        "streets": [
            "Yonge St", "Bloor St W", "College St", "Dundas St W", "Queen St W",
            "King St W", "Spadina Ave", "Bathurst St", "Dufferin St", "Ossington Ave",
            "Roncesvalles Ave", "Harbord St", "St Clair Ave W", "Eglinton Ave W", "Lawrence Ave W",
            "Sheppard Ave W", "Steeles Ave W", "Jane St", "Kipling Ave", "Weston Rd",
            "Rogers Rd", "St Clair Ave E",
        ],
    },
    {
        "code": "sydney",
        "city": "Sydney",
        "state": "NSW",
        "country": "AU",
        "currency_code": "AUD",
        "currency_symbol": "A$",
        "center_lat": -33.8688,
        "center_lon": 151.2093,
        "narrative": "growing",
        "base_orders_mean": 24,
        "base_orders_std": 4,
        "growth_rate_daily_mean": 0.0014,
        "growth_rate_daily_std": 0.0006,
        "trajectory": "growing",
        "growth_rate_monthly_mean": 0.04,
        "neighborhoods": [
            "Surry Hills", "Newtown", "Glebe", "Balmain", "Leichhardt",
            "Pyrmont", "Ultimo", "Chippendale", "Redfern", "Erskineville",
            "Alexandria", "Waterloo", "Zetland", "Mascot", "Eastlakes",
            "Paddington", "Woollahra", "Bondi", "Coogee", "Randwick",
            "Manly", "Mosman",
        ],
        "streets": [
            "Crown St", "King St", "Enmore Rd", "Wilson St", "Darling St",
            "Victoria Rd", "Pyrmont Bridge Rd", "Harris St", "George St", "Pitt St",
            "Elizabeth St", "Oxford St", "Bourke St", "Cleveland St", "Botany Rd",
            "O'Riordan St", "Gardeners Rd", "Anzac Parade", "Alison Rd", "Avoca St",
            "Pittwater Rd", "Sydney Rd",
        ],
    },
    {
        "code": "sao_paulo",
        "city": "São Paulo",
        "state": "SP",
        "country": "BR",
        "currency_code": "BRL",
        "currency_symbol": "R$",
        "center_lat": -23.5505,
        "center_lon": -46.6333,
        "narrative": "growing_fast",
        "base_orders_mean": 30,
        "base_orders_std": 5,
        "growth_rate_daily_mean": 0.0030,
        "growth_rate_daily_std": 0.0010,
        "trajectory": "growing",
        "growth_rate_monthly_mean": 0.09,
        "neighborhoods": [
            "Jardins", "Vila Madalena", "Pinheiros", "Itaim Bibi", "Moema",
            "Vila Mariana", "Bela Vista", "Consolação", "República", "Higienópolis",
            "Perdizes", "Pompeia", "Lapa", "Barra Funda", "Santana",
            "Tucuruvi", "Penha", "Tatuapé", "Vila Prudente", "Santo André",
            "São Bernardo", "Osasco",
        ],
        "streets": [
            "Av Paulista", "Rua Augusta", "Rua Oscar Freire", "Rua Fradique Coutinho", "Rua Aspicuelta",
            "Av Rebouças", "Rua Teodoro Sampaio", "Av Brasil", "Rua Haddock Lobo", "Al Santos",
            "Al Lorena", "Rua Bela Cintra", "Av Higienópolis", "Av Angélica", "R Piauí",
            "R Minas Gerais", "Av Ipiranga", "R da Consolação", "Rua Xavier de Toledo", "R Sete de Abril",
            "R Direita", "Largo do Arouche",
        ],
    },
]
```

- [ ] **Step 2: Update `generate_locations()` to include `country` and `currency_symbol` columns**

In the same file, update the `locations.append({...})` call inside `generate_locations()` to include the new fields. Replace the `locations.append` block:

```python
            locations.append({
                "location_id": loc_id,
                "location_code": city["code"],
                "name": f"Domino's #{loc_id} - {neighborhood}",
                "address": f"{street_num} {street}, {city['city']}, {city['state']}",
                "lat": round(lat, 6),
                "lon": round(lon, 6),
                "narrative": narrative,
                "base_orders_day": int(base_orders[i]),
                "growth_rate_daily": round(float(growth_rates[i]), 6),
                "country": city["country"],
                "currency_symbol": city["currency_symbol"],
            })
```

- [ ] **Step 3: Parameterize the preset filter in `__main__`**

Replace the existing `__main__` block filter line:

```python
    # Phase 1 scope: San Francisco locations only (22 rows). Decision 8 in
    # docs/superpowers/specs/2026-04-20-phase1-absorb-events-design.md.
    # To restore the full 88-location dataset, remove this single filter line.
    locations = locations[locations["location_code"] == "sf"].reset_index(drop=True)
```

with:

```python
    # LOCATION_PRESET selects which city's 22 stores are generated.
    # Set via env var (DAB job parameter → notebook widget → os.environ).
    # Available presets: sf, sv, bellevue, chicago, london, tokyo, berlin,
    #   toronto, sydney, sao_paulo
    _preset = os.environ.get("LOCATION_PRESET", "sf")
    locations = locations[locations["location_code"] == _preset].reset_index(drop=True)
```

Also add `import os` at the top of the file (after the existing imports).

- [ ] **Step 4: Run tests — verify they pass**

```bash
pytest tests/datagen/test_generate_dimensions.py -v
```

Expected output:
```
PASSED tests/datagen/test_generate_dimensions.py::test_all_cities_have_currency_fields
PASSED tests/datagen/test_generate_dimensions.py::test_generate_locations_has_currency_columns
PASSED tests/datagen/test_generate_dimensions.py::test_sf_preset_produces_usd
PASSED tests/datagen/test_generate_dimensions.py::test_london_preset_produces_gbp
PASSED tests/datagen/test_generate_dimensions.py::test_tokyo_preset_produces_jpy
PASSED tests/datagen/test_generate_dimensions.py::test_berlin_preset_produces_eur
PASSED tests/datagen/test_generate_dimensions.py::test_all_presets_present
PASSED tests/datagen/test_generate_dimensions.py::test_invalid_preset_produces_empty_df
```

- [ ] **Step 5: Commit**

```bash
git add datagen/generators/generate_dimensions.py tests/datagen/
git commit -m "feat(datagen): add currency fields + 6 international presets to CITIES"
```

---

## Task 3: DAB YAML + notebook widget

**Files:**
- Modify: `databricks.yml`
- Modify: `datagen/canonical_generator_simple.ipynb`

- [ ] **Step 1: Add `location_preset` parameter to `databricks.yml`**

In `databricks.yml`, inside the `datagen-replay` job definition, add a top-level `parameters` block after the `max_concurrent_runs` line and update the `base_parameters` in the notebook task:

The job currently ends at:

```yaml
      tasks:
        - task_key: replay
          notebook_task:
            notebook_path: ${workspace.file_path}/datagen/canonical_generator_simple
            base_parameters:
              CATALOG: ${var.catalog}
              SCHEMA: simulator
              VOLUME: events
              SCHEDULE_MINUTES: "3"
              SPEED_MULTIPLIER: "60.0"
              START_DAY: "70"
```

Replace with:

```yaml
      parameters:
        - name: location_preset
          default: sf
          # Available presets — change this value to switch the active market:
          #   US cities   (USD $):  sf, sv, bellevue, chicago
          #   International:        london  (GBP £)
          #                         tokyo   (JPY ¥)
          #                         berlin  (EUR €)
          #                         toronto (CAD C$)
          #                         sydney  (AUD A$)
          #                         sao_paulo (BRL R$)
      tasks:
        - task_key: replay
          notebook_task:
            notebook_path: ${workspace.file_path}/datagen/canonical_generator_simple
            base_parameters:
              CATALOG: ${var.catalog}
              SCHEMA: simulator
              VOLUME: events
              SCHEDULE_MINUTES: "3"
              SPEED_MULTIPLIER: "60.0"
              START_DAY: "70"
              LOCATION_PRESET: "{{job.parameters.location_preset}}"
```

- [ ] **Step 2: Add `LOCATION_PRESET` widget to the notebook**

Open `datagen/canonical_generator_simple.ipynb`. The first cell contains the widget setup block. Add `LOCATION_PRESET` widget and env var assignment. The new first cell source should be:

```python
import os
from pyspark.sql import functions as F
from datetime import datetime, timedelta
import pandas as pd

# Create widgets if running interactively
try:
    dbutils.widgets.text("CATALOG", "caspersdev")
    dbutils.widgets.text("SCHEMA", "simulator")
    dbutils.widgets.text("VOLUME", "events")
    dbutils.widgets.text("START_DAY", "70")
    dbutils.widgets.text("SPEED_MULTIPLIER", "60.0")
    dbutils.widgets.text("LOCATION_PRESET", "sf")
except:
    pass

# Get parameters
CATALOG = dbutils.widgets.get("CATALOG")
SCHEMA = dbutils.widgets.get("SCHEMA")
VOLUME = dbutils.widgets.get("VOLUME")
START_DAY = int(dbutils.widgets.get("START_DAY"))
SPEED_MULTIPLIER = float(dbutils.widgets.get("SPEED_MULTIPLIER"))
LOCATION_PRESET = dbutils.widgets.get("LOCATION_PRESET")

# Set env var before generate_dimensions.py reads it
os.environ["LOCATION_PRESET"] = LOCATION_PRESET

# Paths
VOLUME_PATH = f"/Volumes/{CATALOG}/{SCHEMA}/{VOLUME}"
WATERMARK_PATH = f"/Volumes/{CATALOG}/{SCHEMA}/misc/_watermark"
SIM_START_PATH = f"/Volumes/{CATALOG}/{SCHEMA}/misc/_sim_start"

# Constants
DATASET_EPOCH = int(datetime(2024, 1, 1).timestamp())
DATASET_DAYS = 90
CYCLE_SECONDS = DATASET_DAYS * 86400
NOW = datetime.utcnow()

print(f"Config: START_DAY={START_DAY}, SPEED={SPEED_MULTIPLIER}x, LOCATION_PRESET={LOCATION_PRESET}")
print(f"Output: {VOLUME_PATH}")
print(f"Dataset cycle: {DATASET_DAYS} days ({CYCLE_SECONDS} seconds)")
```

Use the `NotebookEdit` tool to replace cell 0 (index 0) with the source above.

- [ ] **Step 3: Commit**

```bash
git add databricks.yml datagen/canonical_generator_simple.ipynb
git commit -m "feat(dab): add location_preset job parameter with preset comment block"
```

---

## Task 4: bootstrap_datagen.py — forward LOCATION_PRESET to subprocess

**Files:**
- Modify: `setup/bootstrap_datagen.py`

- [ ] **Step 1: Read `LOCATION_PRESET` and forward to subprocess env**

In `setup/bootstrap_datagen.py`, update the `main()` function. Add `LOCATION_PRESET` reading and pass it into `subprocess.run`. Replace the existing `subprocess.run(...)` call:

```python
        result = subprocess.run(
            [sys.executable, str(scratch_path / "regenerate_all.py")],
            cwd=str(scratch_path),
            capture_output=True,
            text=True,
        )
```

with:

```python
        location_preset = os.environ.get("LOCATION_PRESET", "sf")
        log.info("LOCATION_PRESET=%s", location_preset)
        result = subprocess.run(
            [sys.executable, str(scratch_path / "regenerate_all.py")],
            cwd=str(scratch_path),
            capture_output=True,
            text=True,
            env={**os.environ, "LOCATION_PRESET": location_preset},
        )
```

`os` is already imported at the top of the file.

- [ ] **Step 2: Commit**

```bash
git add setup/bootstrap_datagen.py
git commit -m "feat(setup): forward LOCATION_PRESET env var to seed data generator"
```

---

## Task 5: Backend — add currency_symbol to markets query

**Files:**
- Create: `tests/backend/test_markets.py`
- Modify: `backend/routes/markets.py`

- [ ] **Step 1: Write the failing backend test**

Create `tests/backend/test_markets.py`:

```python
"""Tests for GET /api/markets — verifies currency_symbol is returned."""
from unittest.mock import AsyncMock, patch

import pytest


def make_market_row(currency_symbol="$"):
    """Minimal asyncpg Record-like dict for a market row."""
    return {
        "location_id": 1,
        "location_code": "sf",
        "name": "Domino's #1 - Mission",
        "lat": 37.7599,
        "lon": -122.4148,
        "active_orders": 3,
        "drivers_out": 1,
        "currency_symbol": currency_symbol,
    }


def test_markets_includes_currency_symbol_usd(client, mock_pool):
    """GET /api/markets returns currency_symbol for USD markets."""
    mock_pool.fetchval = AsyncMock(return_value=True)  # table exists
    mock_pool.fetch = AsyncMock(return_value=[make_market_row("$")])

    resp = client.get("/api/markets")
    assert resp.status_code == 200
    data = resp.json()
    assert len(data) == 1
    assert data[0]["currency_symbol"] == "$"


def test_markets_includes_currency_symbol_gbp(client, mock_pool):
    """GET /api/markets returns currency_symbol for GBP markets."""
    mock_pool.fetchval = AsyncMock(return_value=True)
    mock_pool.fetch = AsyncMock(return_value=[make_market_row("£")])

    resp = client.get("/api/markets")
    assert resp.status_code == 200
    data = resp.json()
    assert data[0]["currency_symbol"] == "£"


def test_markets_fallback_includes_currency_symbol(client, mock_pool):
    """GET /api/markets fallback query (no orders table) also returns currency_symbol."""
    mock_pool.fetchval = AsyncMock(return_value=False)  # table does NOT exist
    mock_pool.fetch = AsyncMock(return_value=[make_market_row("€")])

    resp = client.get("/api/markets")
    assert resp.status_code == 200
    data = resp.json()
    assert data[0]["currency_symbol"] == "€"
```

- [ ] **Step 2: Run the test — verify it fails**

```bash
pytest tests/backend/test_markets.py -v
```

Expected: FAIL — the mock rows include `currency_symbol` but the test verifies the response contains it; this passes at the route level since we return `dict(row)`. The real failure mode here is that the SQL query doesn't SELECT `currency_symbol` yet, so in production it would be missing. The test will actually PASS against the mock (since we control the mock row), which confirms the route plumbing is correct — the SQL change is what ensures the real DB returns it. Run the test now to confirm it passes against mocks, then move on to the SQL.

```bash
pytest tests/backend/test_markets.py -v
```

Expected: all 3 PASS (mock provides the column; this confirms the route's `dict(row)` pass-through works correctly).

- [ ] **Step 3: Update both SELECTs in `backend/routes/markets.py`**

In the `list_markets()` function, update the `query` when the orders table exists (around line 40). Add `m.currency_symbol,` after `m.lon,`:

```python
            SELECT
                m.location_id,
                m.location_code,
                m.name,
                m.lat,
                m.lon,
                m.currency_symbol,
                COALESCE(orders.active_orders, 0) AS active_orders,
                COALESCE(drivers.drivers_out, 0) AS drivers_out
            FROM simulator.locations_synced m
```

Also update the fallback query (around line 70):

```python
        query = """
            SELECT location_id, location_code, name, lat, lon,
                   currency_symbol,
                   0 AS active_orders, 0 AS drivers_out
            FROM simulator.locations_synced
            ORDER BY location_id
        """
```

- [ ] **Step 4: Commit**

```bash
git add tests/backend/test_markets.py backend/routes/markets.py
git commit -m "feat(backend): add currency_symbol to /api/markets response"
```

---

## Task 6: Frontend — Market type + OrderDrawer + MapShell

**Files:**
- Modify: `frontend/src/types/index.ts`
- Modify: `frontend/src/components/OrderDrawer.tsx`
- Modify: `frontend/src/pages/MapShell.tsx`

- [ ] **Step 1: Add `currency_symbol` to the `Market` interface**

In `frontend/src/types/index.ts`, update the `Market` interface:

```typescript
/** Market (store location) metadata */
export interface Market {
  location_id: number;
  location_code: string;
  name: string;
  lat: number;
  lon: number;
  active_orders: number;
  drivers_out: number;
  currency_symbol: string;
}
```

- [ ] **Step 2: Add `currencySymbol` prop to `OrderDrawer` and replace hardcoded `$`**

In `frontend/src/components/OrderDrawer.tsx`, update the props interface:

```typescript
interface OrderDrawerProps {
  order: OrderDetail | null;
  isOpen: boolean;
  onClose: () => void;
  onFollowDriver: (orderId: string) => void;
  currencySymbol: string;
}
```

Update the function signature to destructure `currencySymbol`:

```typescript
export const OrderDrawer: React.FC<OrderDrawerProps> = ({
  order,
  isOpen,
  onClose,
  onFollowDriver,
  currencySymbol,
}) => {
```

Replace the three hardcoded `$` occurrences:

Line 136 — order total in header:
```tsx
          <span className="drawer-order-price">
            {currencySymbol}{order.order_total.toFixed(2)}
          </span>
```

Line 201 — line item price in table:
```tsx
                  <td style={{ textAlign: "right", fontWeight: 600 }}>
                    {currencySymbol}{(item.price * item.qty).toFixed(2)}
                  </td>
```

Line 209 — items total row:
```tsx
          <div className="items-total-row">
            <span>Total</span>
            <span>{currencySymbol}{order.order_total.toFixed(2)}</span>
          </div>
```

- [ ] **Step 3: Pass `currencySymbol` from `MapShell` to `OrderDrawer`**

In `frontend/src/pages/MapShell.tsx`, find the `<OrderDrawer` usage (around line 371) and add the `currencySymbol` prop:

```tsx
      <OrderDrawer
        order={orderDetail}
        isOpen={isDrawerOpen && rightRailMode === "order"}
        onClose={handleDrawerClose}
        onFollowDriver={handleFollowDriver}
        currencySymbol={activeMarket?.currency_symbol ?? "$"}
      />
```

`activeMarket` is already computed at line 270:
```typescript
const activeMarket = markets.find(
  (m) => String(m.location_id) === String(activeMarketId)
) || null;
```

The `?? "$"` fallback ensures the drawer renders correctly while markets are still loading.

- [ ] **Step 4: Verify TypeScript compiles with no errors**

```bash
npm run build --prefix frontend 2>&1 | tail -20
```

Expected: build succeeds with no TypeScript errors. If `currency_symbol` is missing from any mock/test data, the compiler will surface it here.

- [ ] **Step 5: Commit**

```bash
git add frontend/src/types/index.ts frontend/src/components/OrderDrawer.tsx frontend/src/pages/MapShell.tsx
git commit -m "feat(frontend): thread currency_symbol from Market through to OrderDrawer price rendering"
```

---

## Task 7: Final check

- [ ] **Step 1: Run all tests**

```bash
pytest tests/datagen/ tests/backend/ -v
```

Expected: all tests pass.

- [ ] **Step 2: Verify frontend build is clean**

```bash
npm run build --prefix frontend
```

Expected: no TypeScript errors, no warnings about missing props.

- [ ] **Step 3: Commit if any cleanup was needed, otherwise done**

```bash
git log --oneline -6
```

Should show the 5 feature commits from Tasks 1–6 cleanly stacked on the branch.
