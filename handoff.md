# Digital Twin App — Agent Handoff

**Date**: 2026-04-15
**App URL**: https://twins-digital-twin-1351565862180944.aws.databricksapps.com
**Simulator time**: ~2026-04-15 (advancing fast, weeks ahead of real time)

---

## What the App Does

Real-time delivery operations dashboard backed by a Domino's order event simulator. The simulator emits events (`order_created`, `gk_started`, `gk_ready`, `gk_finished`, `driver_arrived`, `driver_picked_up`, `driver_ping`, `delivered`) into a Delta streaming table (`vdm_classic_rikfy0_catalog.lakeflow.all_events`). These flow through:

1. **SDP pipeline** (`twins-orders-enriched`, CONTINUOUS) → `driver_positions` (streaming table, APPLY CHANGES SCD1) + `orders_enriched` (MV)
2. **Lakebase syncs** (CONTINUOUS) → Postgres tables in `lakeflow` schema
3. **FastAPI backend** queries Postgres via asyncpg
4. **React frontend** polls `/api/markets/{id}/orders`, `/api/markets/{id}/drivers`, `/api/markets/{id}/kpis` every 3s

---

## Current State — Working (with temporary fix)

### Temporary Fix Applied (2026-04-15)

The app was suffering from 20-60 second API response times and CX panel 503 errors. Root cause: `orders_enriched_synced` was a Postgres VIEW (not indexable) scanning 14.6M raw events on every query. Two fixes were applied:

1. **VIEW → MATERIALIZED VIEW**: `config.py` now defines `MATVIEW_SQL` instead of `VIEW_SQL`. Indexes now work on the materialized view. Background refresh loop in `backend/db.py` refreshes every 30s.
2. **Complaints sync fixed**: Recreated `complaints.complaints_synced` with SNAPSHOT policy (source pipeline was deleted, CONTINUOUS failed).

**Result**: API times dropped from 20-60s to 33-67ms. CX panel now returns 200 OK with full data.

### What Needs to Happen Next — Convert MV → Streaming Table

The materialized view approach is a temporary workaround. The proper architecture is to push the transformation to Databricks and sync the result:

**Convert `orders_enriched` from Materialized View → Streaming Table using `APPLY CHANGES INTO` with `IGNORE NULL UPDATES`**, then sync to Lakebase with CONTINUOUS policy.

See **"Conversion Plan"** section below for full details.

---

## Conversion Plan: orders_enriched MV → Streaming Table

### Why

- Materialized Views can only use SNAPSHOT sync (full copy), not CONTINUOUS
- The current workaround (Postgres MATVIEW + background refresh) puts heavy SQL in Lakebase instead of Databricks
- A Streaming Table supports CONTINUOUS Lakebase sync with seconds of latency

### How: APPLY CHANGES INTO + IGNORE NULL UPDATES

Each event sets only its own column (e.g., `gk_started` sets `kitchen_started_at`). Other columns are NULL. `IGNORE NULL UPDATES` preserves existing values instead of overwriting with NULL. Result: one row per order, incrementally updated.

### Files to Modify

#### 1. `pipelines/orders_enriched.sql` — Replace MV with Streaming Table

**Replace** the `CREATE OR REFRESH MATERIALIZED VIEW orders_enriched` block (lines 50-135) with:

```sql
CREATE OR REFRESH STREAMING TABLE orders_enriched
COMMENT 'One row per order with current stage, all stage timestamps, body fields, order_total. Streaming via APPLY CHANGES — updates within seconds of each event. Synced to Lakebase CONTINUOUS.'
TBLPROPERTIES ('quality' = 'gold');

APPLY CHANGES INTO orders_enriched
FROM (
  SELECT
    order_id,
    location_id,
    ts,
    event_type AS current_stage,
    CASE WHEN event_type = 'order_created'    THEN ts END AS created_at,
    CASE WHEN event_type = 'gk_started'       THEN ts END AS kitchen_started_at,
    CASE WHEN event_type = 'gk_ready'         THEN ts END AS kitchen_ready_at,
    CASE WHEN event_type = 'gk_finished'      THEN ts END AS kitchen_finished_at,
    CASE WHEN event_type = 'driver_arrived'   THEN ts END AS driver_arrived_at,
    CASE WHEN event_type = 'driver_picked_up' THEN ts END AS picked_up_at,
    CASE WHEN event_type = 'delivered'        THEN ts END AS delivered_at,
    CASE WHEN event_type = 'order_created'    THEN body END AS order_body,
    CASE WHEN event_type = 'driver_picked_up' THEN body END AS route_body,
    CASE WHEN event_type = 'driver_ping'      THEN body END AS latest_ping,
    CASE WHEN event_type = 'order_created' THEN
      COALESCE(
        AGGREGATE(
          FROM_JSON(GET_JSON_OBJECT(body, '$.items'),
            'ARRAY<STRUCT<name: STRING, price: DOUBLE, qty: INT>>'),
          CAST(0.0 AS DOUBLE),
          (acc, item) -> acc + (item.price * item.qty)
        ), 0.0
      )
    END AS order_total
  FROM STREAM(${source_catalog}.lakeflow.all_events)
)
KEYS (order_id)
IGNORE NULL UPDATES
SEQUENCE BY ts
STORED AS SCD TYPE 1;
```

Update the file header comments to reflect the new table type.

#### 2. `setup/config.py` — Add CONTINUOUS sync, remove Postgres view logic

**Add** to SYNCS list (after `driver_positions` entry):
```python
{
    "source": f"{SOURCE_CATALOG}.lakeflow.orders_enriched",
    "name": f"{SOURCE_CATALOG}.lakeflow.orders_enriched_synced",
    "policy": SyncedTableSchedulingPolicy.CONTINUOUS,
    "pk": ["order_id"],
},
```

**Remove** these variables entirely:
- `DROP_OLD_VIEW_SQL`
- `MATVIEW_SQL` (the entire multi-line view definition)
- `REFRESH_MATVIEW_SQL`

**Keep** `INDEX_SQL` — indexes on `orders_enriched_synced` will work since it's now a real synced table.

**Remove** the `idx_orders_pk` entry from INDEX_SQL (the sync creates a PK index automatically).

Keep `idx_orders_location_stage` and `idx_orders_location_created` — these are query-optimizing composite indexes.

#### 3. `setup/finalize.py` — Remove matview creation, add matview cleanup

**Remove** the matview creation logic from `create_view_and_indexes()`:
- Remove the `DROP VIEW` and `CREATE MATERIALIZED VIEW` blocks
- Remove the `REFRESH MATERIALIZED VIEW` block
- Rename function to `create_indexes()` since it no longer creates views

**Add** a cleanup step at the start that drops the old matview:
```python
cur.execute("DROP MATERIALIZED VIEW IF EXISTS lakeflow.orders_enriched_synced")
```

**Remove** imports: `DROP_OLD_VIEW_SQL`, `MATVIEW_SQL`, `REFRESH_MATVIEW_SQL`

#### 4. `backend/db.py` — Remove matview refresh loop

**Remove:**
- `_refresh_task` global variable
- `MATVIEW_REFRESH_INTERVAL` constant
- `_refresh_matview_loop()` function entirely
- The `_refresh_task = asyncio.create_task(...)` line in `init_pool()`
- The `_refresh_task` cleanup in `close_pool()`

#### 5. `CLAUDE.md` — Update architecture notes

Update the comment about `orders_enriched_synced` being a VIEW to reflect it's now a synced streaming table.

### Deployment Sequence

1. **Full-refresh the DLT pipeline** — required because changing MV → Streaming Table is a schema change
2. **Create the new sync** — run `create_syncs.py` to add the `orders_enriched` CONTINUOUS sync
3. **Run finalize** — drops old matview, creates indexes on the new synced table, applies grants
4. **Deploy app** — `databricks bundle deploy` + `databricks apps deploy`

### Verification

1. **Pipeline**: Check pipeline UI — `orders_enriched` should show as STREAMING TABLE
2. **Sync status**: `databricks tables get vdm_classic_rikfy0_catalog.lakeflow.orders_enriched_synced` — should show FOREIGN type
3. **API timing**: Re-run `node tests/e2e/api-timing.mjs` — all endpoints should be <500ms
4. **CX panel**: Navigate to `/cx` — should show KPIs and store table
5. **Live data**: Main dashboard should show markers, KPIs, pipeline counts within 2-3s

---

## Architecture

```
all_events (Delta streaming, caspers-kitchens DAB)
    ↓ CONTINUOUS pipeline (twins-orders-enriched)
driver_positions (streaming APPLY CHANGES SCD1)   orders_enriched (MV → will become Streaming Table)
    ↓ CONTINUOUS sync                                    ↓ Currently: Postgres MATVIEW + bg refresh
driver_positions_synced (Postgres)               orders_enriched_synced (Postgres MATVIEW, will become synced table)
    ↓                                                    ↓
FastAPI /api/markets/{id}/drivers           FastAPI /api/markets/{id}/orders + /kpis
    ↓                                                    ↓
React frontend (polls every 3s)
```

### Key Design Decisions

- **`orders_enriched_synced` is currently a Postgres MATERIALIZED VIEW** — temporary fix. Will become a CONTINUOUS-synced table after conversion.
- **Carryout orders** have empty `driver_picked_up` body (`{}`). The view detects via `route_body IS NULL OR route_body = '{}'` and sets `delivered_at = picked_up_at`.
- **`CURRENT_DATE` must never be used** — always use `(SELECT MAX(ts)::date FROM lakeflow.all_events_synced)` since simulator time is ahead of real time.
- **Complaints sync uses SNAPSHOT** (not CONTINUOUS) because source pipeline was deleted.

---

## Key Files

| File | Purpose |
|---|---|
| `pipelines/orders_enriched.sql` | DLT pipeline — driver_positions (streaming) + orders_enriched (MV, to be converted) |
| `setup/config.py` | Lakebase sync config + `MATVIEW_SQL` + `INDEX_SQL` |
| `setup/finalize.py` | Creates Postgres matview + indexes + grants |
| `setup/create_syncs.py` | Creates Lakebase synced tables (idempotent) |
| `backend/routes/markets.py` | `/api/markets` + `/api/markets/{id}/kpis` |
| `backend/routes/orders.py` | `/api/markets/{id}/orders` + `/api/orders/{id}` |
| `backend/routes/drivers.py` | `/api/markets/{id}/drivers` |
| `backend/routes/cx.py` | `/api/cx/summary` + store detail + complaints + refunds |
| `backend/db.py` | asyncpg pool, OAuth rotation, matview refresh loop (temporary) |
| `databricks.yml` | DAB bundle — app, pipeline, setup jobs |
| `frontend/src/App.tsx` | Main dashboard — polling, state, routing |
| `frontend/src/components/cx/CXPanel.tsx` | Customer Experience panel root |

---

## How to Deploy Changes

### Backend or frontend code change:
```bash
npm run build  # from frontend/ if frontend changed
databricks bundle deploy -p DEFAULT
databricks apps deploy twins-digital-twin -p DEFAULT
```

### Config/finalize change (setup/config.py):
```bash
databricks bundle deploy -p DEFAULT
# Then run the finalize task:
cd setup && DATABRICKS_CONFIG_PROFILE=DEFAULT python finalize.py
```

---

## Known Gotchas

- **Always use `-p DEFAULT`** for all CLI commands. Azure profile token expires frequently.
- **`databricks bundle deploy` ≠ app redeploy**: Must also run `databricks apps deploy` to restart with new code.
- **View indexes fail silently on views**: Finalize catches warnings — expected, not errors. (Won't be an issue after conversion.)
- **Simulator timestamps are UTC strings** (`"YYYY-MM-DD HH:MM:SS.000"`). Frontend must NOT append `"Z"` before parsing.
- **`asyncpg` `command_timeout=120s`**: Matview queries can take time on first run.
- **Complaints sync**: Uses SNAPSHOT because source DLT pipeline ID `58ce33b0-8484-4595-a1fa-22e853026fad` was deleted.

---

## Bugs Fixed (2026-04-15 Session)

| Bug | Root Cause | Fix |
|---|---|---|
| All API endpoints 20-60s response time | `orders_enriched_synced` was a Postgres VIEW over 14.6M events — re-materialized every query. Indexes on views silently failed. | Converted to MATERIALIZED VIEW with indexes + background refresh every 30s |
| CX panel 503 — complaints table missing | `complaints.complaints_synced` sync used CONTINUOUS but source DLT pipeline was deleted | Recreated sync with SNAPSHOT policy |
| KPI bar stuck on "Loading..." | `/api/markets/{id}/kpis` never returned (38s query time) | Materialized view fix resolved this |
| Pipeline all zeros | `/api/markets/{id}/orders` never returned (23s) | Materialized view fix resolved this |
| No driver markers on map | `/api/markets/{id}/drivers` timed out (23s) | Materialized view fix resolved this |

### Performance Before/After (2026-04-15)

| Endpoint | Before | After |
|---|---|---|
| `/api/markets` | 60,945ms | 67ms |
| `/api/markets/1/orders` | 23,374ms | 45ms |
| `/api/markets/1/drivers` | 23,071ms | 59ms |
| `/api/markets/1/kpis` | 38,815ms | 33ms |
| `/api/cx/summary` | 503 error | 2,695ms (200 OK) |
| Dashboard first paint | >30s (never loaded) | 2.3s |
