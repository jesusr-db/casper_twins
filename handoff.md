# Digital Twin App — Agent Handoff

**Date**: 2026-03-18
**App URL**: https://twins-digital-twin-1351565862180944.aws.databricksapps.com
**Simulator time**: ~2026-04-07 (advancing fast, ~3 weeks ahead of real time)

---

## What the App Does

Real-time delivery operations dashboard backed by a Domino's order event simulator. The simulator emits events (`order_created`, `gk_started`, `gk_ready`, `gk_finished`, `driver_arrived`, `driver_picked_up`, `driver_ping`, `delivered`) into a Delta streaming table (`vdm_classic_rikfy0_catalog.lakeflow.all_events`). These flow through:

1. **SDP pipeline** (`twins-orders-enriched`, CONTINUOUS) → `driver_positions` (streaming table, APPLY CHANGES SCD1) + `orders_enriched` (MV)
2. **Lakebase syncs** (CONTINUOUS) → Postgres tables in `lakeflow` schema
3. **FastAPI backend** queries Postgres via asyncpg
4. **React frontend** polls `/api/markets/{id}/orders`, `/api/markets/{id}/drivers`, `/api/markets/{id}/kpis` every 3s

---

## Current State — Everything Working

As of 2026-03-18 all major issues have been resolved and the app is fully functional:

- **88 market tabs** load in ~1.2s with live order counts
- **KPI bar**: Active Orders, Drivers Out, Avg Delivery Time (~23 min), Today's Revenue all accurate
- **Map**: Store pin, driver markers (GPS-tracked in-transit orders), route polylines
- **Pipeline bar**: New / Kitchen Prep / Ready / In Transit / Delivered counts are accurate and internally consistent
- **Order drawer**: Click a driver marker to see full order lifecycle with correct timestamps and "X min to deliver" header
- **Drivers Out = In Transit**: Both KPI and pipeline bar draw from the same source (`orders_enriched_synced`) so counts always match

---

## Architecture

```
all_events (Delta streaming, caspers-kitchens DAB)
    ↓ CONTINUOUS pipeline (twins-orders-enriched)
driver_positions (streaming APPLY CHANGES SCD1)   orders_enriched (MV)
    ↓ CONTINUOUS sync                                    ↓ [Postgres VIEW over all_events_synced]
driver_positions_synced (Postgres)               orders_enriched_synced (Postgres VIEW)
    ↓                                                    ↓
FastAPI /api/markets/{id}/drivers           FastAPI /api/markets/{id}/orders + /kpis
    ↓                                                    ↓
React frontend (polls every 3s)
```

### Key Design Decisions (from debugging sessions)

- **`orders_enriched_synced` is a Postgres VIEW** over `all_events_synced`, not a synced table. Materialized Views cannot be CONTINUOUS-synced by Lakebase.
- **Carryout orders** have an empty `driver_picked_up` body (`{}`). The view detects this via `route_body IS NULL OR route_body = '{}'` and sets `delivered_at = picked_up_at` so they don't appear as active delivery orders.
- **Simulator bug**: ~37% of orders (85K+) never receive a `delivered` event — these are **carryout orders**, not bugs. Identified by empty `route_body`.
- **`CURRENT_DATE` must never be used** — always use `(SELECT MAX(ts)::date FROM lakeflow.all_events_synced)` since simulator time is weeks ahead of real time.
- **`/api/markets` query**: Uses a regular subquery JOIN (not LATERAL) to evaluate the view once for all 88 markets. LATERAL caused 504 timeouts by evaluating the view 88 times.

---

## Key Files

| File | Purpose |
|---|---|
| `setup/config.py` | Lakebase sync config + `VIEW_SQL` (Postgres view definition) + `INDEX_SQL` |
| `setup/finalize.py` | Creates Postgres view + indexes + grants — run after any VIEW_SQL change |
| `backend/routes/markets.py` | `/api/markets` + `/api/markets/{id}/kpis` |
| `backend/routes/orders.py` | `/api/markets/{id}/orders` + `/api/orders/{id}` |
| `backend/routes/drivers.py` | `/api/markets/{id}/drivers` |
| `backend/db.py` | asyncpg pool, Lakebase OAuth token rotation |
| `databricks.yml` | DAB bundle — app, pipeline, setup jobs |
| `frontend/src/components/OrderDrawer.tsx` | Order lifecycle timeline, timestamps |
| `frontend/src/components/OrderPipeline.tsx` | Pipeline stage bar (already wired for click/filter) |

---

## How to Deploy Changes

### Backend or frontend code change:
```bash
npm run build  # from frontend/ if frontend changed
databricks bundle deploy
databricks apps deploy twins-digital-twin \
  --source-code-path /Workspace/Users/jesus.rodriguez@databricks.com/.bundle/twins-digital-twin/default/files
```

### VIEW_SQL change (setup/config.py):
```bash
databricks bundle deploy
databricks bundle run setup-lakebase --only finalize
# No app redeploy needed — view is in Postgres, not the app
```

---

## Known Gotchas

- **`databricks bundle deploy` ≠ app redeploy**: Must also run `databricks apps deploy` to restart with new code.
- **`pg_tables` misses views**: Use `information_schema.tables` when checking if `orders_enriched_synced` exists (it's a VIEW, not a table).
- **View indexes on views fail silently**: `finalize.py` catches these warnings — expected, not an error.
- **Simulator timestamps are UTC strings** (`"YYYY-MM-DD HH:MM:SS.000"`). Frontend must NOT append `"Z"` before parsing — that causes double UTC offset and shows times as 1 AM instead of 8 AM.
- **`asyncpg` `command_timeout=120s`**: The view query can take 10-30s on first run. Subsequent queries are faster due to Postgres caching.
- **`orders_enriched_synced` row count ~1,300**: Only delivery orders within 24h window, carryout excluded. This is correct.

---

## Bugs Fixed (2026-03-18 Session)

| Bug | Root Cause | Fix |
|---|---|---|
| `/api/markets` 504 timeout | `LATERAL JOIN` evaluated 88× view per market | Regular subquery JOIN — evaluates view once |
| Revenue = $0, avg time = `--` | `CURRENT_DATE` = server date (March 17), simulator = April | Use `MAX(ts)::date FROM all_events_synced` |
| All orders stuck at `driver_picked_up` | `latest_stage` CTE excluded `driver_ping`; 7-day window too stale | Include `driver_ping`; shrink window to 24h |
| No driver markers on map | View sync lag — order_id sets didn't overlap | LEFT JOIN + recency filter on `driver_positions_synced` |
| Drivers Out ≠ In Transit | `drivers_out` sourced from `driver_positions_synced` (stale SCD1) | Align both to `orders_enriched_synced` |
| Carryout orders inflating active counts | Empty `route_body` orders have no `delivered` event — they're carryout | Detect `route_body = '{}'`; set `delivered_at = picked_up_at` |
| Timestamps showing 1 AM | Frontend appended `"Z"` forcing UTC interpretation on already-UTC times | Remove `+ "Z"` in `formatTime()` |
| "just now" on all orders | `getTimeSincePlaced` compared simulator time to real `Date.now()` | Show `"X min to deliver"` from `delivered_at - created_at` |

---

## Roadmap

Full roadmap lives in the design spec:
`docs/superpowers/specs/2026-03-16-digital-twins-driver-tracking-design.md`

**Summary:**

### Near-term (next session)
- Pipeline stage drill-down — click a stage to see filtered order list with timing
- Store detail panel — click a store for full KPIs, alerts, order info
- Market tab grouping — bucket 88 stores by city

### Medium-term
- Alerting — late delivery, kitchen bottleneck, SLA breach
- Multi-market overview — all-markets zoomed-out view
- Predictive ETA — ML model replacing client-side heuristic

### Analytics Tab (per store)
- Store scorecard — historical perf trends, benchmarks
- **Crustopher** — conversational AI for store performance Q&A
- **Genie** — ad-hoc SQL exploration embedded in app

### Integrations
- **Casper's Kitchen** — refund manager, loyalty, inventory, other components
- **Real store locations** — Google Places API for actual Domino's addresses + Reviews
- Historical analytics dashboards
