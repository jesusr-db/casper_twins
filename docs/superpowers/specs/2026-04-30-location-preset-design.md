# Location Preset + Currency — Design Spec
_Date: 2026-04-30_

## Problem

The synthetic dataset is hardcoded to San Francisco (USD, `$`). There is no way to run a demo scenario in a different market without editing source files. Currency is hardcoded as `$` in the frontend.

## Goal

A single DAB job parameter (`location_preset`) selects a city+country+currency combo at generation time. The frontend reads `currency_symbol` from the location data and uses it everywhere prices appear. No price rescaling — symbol swap only.

---

## Section 1: Data Layer

### CITIES dict extension

Each entry in `CITIES` (`generate_dimensions.py`) gains three fields:

| field | type | example |
|-------|------|---------|
| `country` | string (ISO 3166-1 alpha-2) | `"GB"` |
| `currency_code` | string (ISO 4217) | `"GBP"` |
| `currency_symbol` | string | `"£"` |

Existing four US cities (`sf`, `sv`, `bellevue`, `chicago`) all get `country="US"`, `currency_code="USD"`, `currency_symbol="$"`.

### New international presets

| code | city | state/region | country | currency_code | currency_symbol |
|------|------|-------------|---------|---------------|-----------------|
| `london` | London | England | GB | GBP | £ |
| `tokyo` | Tokyo | Tokyo | JP | JPY | ¥ |
| `berlin` | Berlin | Berlin | DE | EUR | € |
| `toronto` | Toronto | ON | CA | CAD | C$ |
| `sydney` | Sydney | NSW | AU | AUD | A$ |
| `sao_paulo` | São Paulo | SP | BR | BRL | R$ |

Each new city gets 22 neighborhoods + 22 streets in the same list format as existing cities, with realistic local names. Growth/order stats follow the same shape as existing entries.

### locations table schema

`generate_locations()` adds two new columns to the output DataFrame:
- `country` — string, ISO 3166-1 alpha-2
- `currency_symbol` — string, display symbol

`currency_code` is not written to the table (frontend only needs the symbol; code stays in `CITIES` for future use).

### Preset filter

The hardcoded filter:
```python
locations = locations[locations["location_code"] == "sf"].reset_index(drop=True)
```
becomes:
```python
locations = locations[locations["location_code"] == LOCATION_PRESET].reset_index(drop=True)
```
where `LOCATION_PRESET = os.environ.get("LOCATION_PRESET", "sf")`.

---

## Section 2: DAB / Parameter Wiring

### databricks.yml

Top-level job parameter added to `twins-datagen-replay`:

```yaml
parameters:
  - name: location_preset
    default: sf
    # Available presets:
    #   US cities (USD $):  sf, sv, bellevue, chicago
    #   International:      london (GBP £), tokyo (JPY ¥), berlin (EUR €),
    #                       toronto (CAD C$), sydney (AUD A$), sao_paulo (BRL R$)
```

Passed into the notebook task:
```yaml
tasks:
  - task_key: replay
    notebook_task:
      base_parameters:
        location_preset: "{{job.parameters.location_preset}}"
```

### canonical_generator_simple.ipynb

New widget added alongside existing ones:
```python
dbutils.widgets.text("LOCATION_PRESET", "sf")
LOCATION_PRESET = dbutils.widgets.get("LOCATION_PRESET")
os.environ["LOCATION_PRESET"] = LOCATION_PRESET
```

Widget must be set before the generator import/call so the env var is in place when `generate_dimensions.py` reads it.

### setup/bootstrap_datagen.py

Reads `LOCATION_PRESET` from env (default `"sf"`) before calling `generate_dimensions`. Fresh environment setup is preset-aware without any extra parameters.

### No other setup changes needed

- `generate_customers.py` — location-agnostic (clusters from actual order history)
- `config.py` / `create_syncs.py` — table-name based, unaffected
- `generate_canonical_dataset.py` — event simulation, no location dependency

---

## Section 3: Frontend Currency Rendering

### Backend

The locations query adds `currency_symbol` to its SELECT from `locations_synced`. The location response type gains the field.

### Frontend

`currency_symbol` flows from the location object (already available in context) to price render sites. No new API call, no new state.

Two change sites in `OrderDrawer.tsx`:
- Line 201: line item price — replace `$` with `location.currency_symbol`
- Line 135: order total display — same replacement

The location object is already passed into the drawer; `currency_symbol` is just another field on it.

---

## Section 4: Free-Form Roadmap (future, out of scope)

When `location_preset` is set to the sentinel `custom`, the generator reads individual params instead of looking up a preset.

### Additional parameters

| param | description |
|-------|-------------|
| `city` | City display name |
| `state_region` | State or region name |
| `country_code` | ISO 3166-1 alpha-2 |
| `currency_code` | ISO 4217 |
| `center_lat` | Decimal degrees, [-90, 90] |
| `center_lon` | Decimal degrees, [-180, 180] |
| `neighborhoods` | Comma-separated list |
| `streets` | Comma-separated list |

### Validation (`validate_location_params()`)

- `country_code` checked against bundled ISO 3166-1 set (~249 entries, static list in file)
- `currency_code` checked against bundled ISO 4217 set (~170 entries)
- `center_lat` / `center_lon` range checked
- All fields required when preset is `custom` — missing fields raise `ValueError` naming the missing param
- Mismatched country/currency is intentionally allowed (USD in a non-US city is valid for demos)

### Neighborhood/street sourcing

Recommended approach: accept `neighborhoods` and `streets` as explicit comma-separated DAB params. This is for scenario control — the operator knows what they want.

Fallback: if not provided, procedurally generate generic names (`District 1`, `North Quarter`, etc.) so generation doesn't fail.

### Error surfacing

Validation runs before any Spark/Delta writes. On failure: `dbutils.notebook.exit()` with a structured JSON message so the DAB job log shows exactly what was wrong.

---

## Files Changed

| file | change |
|------|--------|
| `datagen/generators/generate_dimensions.py` | Add currency fields to `CITIES`, add 6 international presets, add columns to `generate_locations()`, parameterize preset filter |
| `datagen/canonical_generator_simple.ipynb` | Add `LOCATION_PRESET` widget |
| `databricks.yml` | Add `location_preset` job parameter with preset comment block |
| `setup/bootstrap_datagen.py` | Pass `LOCATION_PRESET` env var through |
| `backend/routes/markets.py` | Add `currency_symbol` to both `locations_synced` SELECTs (lines 48 and 73) + response type |
| `frontend/src/components/OrderDrawer.tsx` | Replace hardcoded `$` with `location.currency_symbol` |
| `frontend/src/types/index.ts` | Add `currency_symbol` to location type |
