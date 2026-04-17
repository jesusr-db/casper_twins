# Digital Twin & Driver Tracking App — Project Intelligence

## Data & Schema

- Timestamp fields in source data are **strings** (`"YYYY-MM-DD HH:MM:SS.000"`), not TIMESTAMP. Cast explicitly in all downstream code.
- `sequence` field is a string — cast to INT for ordering.
- No cancellation/failure state in the event stream. All orders progress to delivery. Don't build cancellation UI.
- `order_total` computed from `order_body` JSON via `AGGREGATE` + `FROM_JSON` — handle nulls/zeros if JSON shape differs from `{name, price, qty}`.
- **`delivered_at` is TIMESTAMP, not TEXT** — use `IS NULL` for undelivered check. Never compare with `= ''`.
- `order_revenue` exists in `gold_order_header` but may need deriving from `order_body` JSON in `orders_current_state` for KPI calculations.

## Frontend

- **`getOrderStage()`** is the single source of truth for order state — checks `delivered_at` first, then `current_stage`. `delivered_at IS NOT NULL` always wins regardless of `current_stage` (DLT sync lag).
- **`usePolling`** uses `setTimeout` loop (poll-after-completion), not `setInterval`. Fixed-interval polling aborts slow Lakebase queries every cycle under load.
- `usePolling` deps cascade abort + restart on `activeMarketId` change — this is intentional. Market-switch aborts are distinct from the interval-abort bug.
- `progress_pct >= 80` = "almost there" proxy. Driver positions stream stops at delivery — no return-trip data. "Returning to store" UX is not supported.
- Frontend components use `document.createElement("style")` appended to `document.head` — consistent with codebase but creates global style pollution. Styles are never cleaned up.
- MapView manages markers imperatively outside React's render cycle. Marker state is not visible in React DevTools.
- Playback scrub backward resets to index 0 and replays from start — correct but slow for large event sets.
- Don't show customer pins for delivered orders (stage = "Delivered") — use green teardrops instead to avoid map clutter.
- Only show stores with `active_orders > 0` in MarketGroup — collapse idle stores behind `+N`.

## Backend / Postgres

- Use `make_interval(days => $N::int)` for parameterized intervals. **Not** `INTERVAL '$N days'` — that treats the param as a string literal, not a bind variable.
- `_validate_days()` in `cx.py` allows 0 (= all time, no date filter) but rejects negatives.
- All SQL uses asyncpg `$N` parameterized queries. Never interpolate values into SQL strings.
- TypeScript: don't cast interface types to `Record<string, unknown>` — TS strict mode rejects it. Use an explicit field map helper instead (see `getOrderTimestamp()`).

## Deployment

- **Always use `-p DEFAULT`** for all CLI commands. Azure profile token expires frequently. Never use `-p azure`.
- App URL (browser-only, not curl-accessible): `https://twins-digital-twin-984752964297111.11.azure.databricksapps.com`
- **Lakebase DB must exist before the app starts.** `db.py` calls `w.lakebase.get_database()` in the lifespan handler — crashes if DB doesn't exist. Provision infra before deploying app.
- `databricks bundle deploy` uploads source code only. Does **not** trigger an app deployment. Run `databricks apps deploy` separately.
- `databricks apps deploy` requires the app to be in RUNNING state. If stopped: `apps start` first.
- `databricks.yml`: no `lakebase_database` field — Lakebase resource binding is handled by `app.yaml` at runtime.

## Pipeline & DAB

- **`orders_enriched` is a Streaming Table** (not MV) using `APPLY CHANGES INTO` + `IGNORE NULL UPDATES`. Each event sets only its own timestamp column; previously-set values are preserved. CONTINUOUS Lakebase sync supported.
- `orders_enriched_synced` in Lakebase is a **CONTINUOUS-synced table** (not a view/matview). No Postgres-side transformation — all logic runs in Spark.
- `create_syncs.py` is idempotent (`ALREADY_EXISTS` detection). Safe to re-run after adding new SYNCS entries.
- New synced tables require Delta source tables to exist first. `generate_customers` must run before `create_syncs` for customer syncs.
- `order_customer_map` DLT streaming table LEFT JOINs `customer_address_index` (static). Re-generating the address index won't re-map already-processed orders.
- `generate_customers.py` uses SparkSession for Delta writes + psycopg2 for Postgres reads. Future scripts following this pattern need both imports.
- Current SYNCS count in `config.py`: **8** (5 original + 1 orders_enriched + 2 CX).

## Testing

- Patch `backend.db.init_pool` and `backend.db.close_pool` at module-import time to prevent Databricks auth during pytest collection.
- Local venv needs: `pip install asyncpg fastapi uvicorn` (app deps are on Databricks runtime, not installed locally by default).
- `.gitignore` blocks `.agent-team/` directory — use `git add -f` for agent artifacts that need committing.

## Architecture Notes

- React Router: `<BrowserRouter>` wraps the entire app in `main.tsx`. `App` component gets router context from parent.
- `DriverCard` is nested inside `OrderDrawer` (per component contract). Not a standalone component.
- Playback mode uses purple tint `#6B3FA0` to distinguish from live mode — intentional, preserve it.
- KPI counts (`active_orders`, `drivers_out`) are derived client-side from the orders array using `getOrderStage()` — not from a separate backend query. This keeps KPI and pipeline counts in sync.
