# Digital Twin & Driver Tracking App — Project Intelligence

## Introspection

### Phase 0: Domain Research (2026-03-16)

#### What worked
- food-delivery-sme: Domain research completed cleanly on first attempt. All 3 artifacts produced (domain-playbook.md, data-requirements.yaml, success-criteria.yaml). Web research yielded useful context on Domino's Tracker stages, delivery KPIs, and MapLibre GL animation patterns.

#### What failed or needed fixing
- No failures in this phase.

#### Patterns to watch for
- Timestamp fields in source data are stored as strings ("YYYY-MM-DD HH:MM:SS.000"), not native TIMESTAMP types. All downstream agents must handle string-to-timestamp conversion explicitly.
- The `sequence` field is also stored as a string and must be cast to INT for ordering.
- There is no cancellation or failure state in the event stream — all orders progress to delivery. The UI should not attempt to handle cancellation flows.
- `order_revenue` exists in `gold_order_header` but may need to be derived from `order_body` JSON in the `orders_current_state` table for KPI calculations.

#### QA iterations
- Attempt 1: PASS — all 3 artifacts exist, playbook covers all required sections (order lifecycle, KPIs, UX patterns, terminology)

### Phase 1: Data Pipeline & UI Design (2026-03-16)

#### What worked
- data-engineer: DLT SQL and Lakebase sync setup produced cleanly. The domain playbook and data-requirements.yaml from Phase 0 provided sufficient context to build the pipeline without needing live table introspection.
- ui-ux-analyst: All 3 wireframes, UX workflow document, and component contract produced on first pass. The domain playbook's color palette, stage groupings, and UX patterns sections directly informed the design decisions.
- Parallel execution: Both agents' outputs are fully non-overlapping (pipelines/ vs .agent-team/artifacts/) so merge was clean.

#### What failed or needed fixing
- Catalog `caspersdev_jmr` was not accessible via MCP tools from the current workspace context. This did not block work because Phase 0's data profile had already captured the schema details. However, live validation of the DLT SQL against actual table metadata was not possible.

#### Patterns to watch for
- The `order_total` column is computed from `order_body` JSON using `AGGREGATE` + `FROM_JSON`. If the JSON structure of order_body items differs from the assumed `{name, price, qty}` shape, this will produce nulls/zeros. The app-developer should handle this gracefully.
- The DLT SQL uses multiple CTEs with ROW_NUMBER windowing. On very large event streams, this could be expensive. Monitor pipeline performance after deployment.
- Lakebase sync setup is documented as SQL comments + operational instructions (not executable SQL) because Lakebase operations go through the MCP tool / skill, not direct SQL. The deploy-engineer in Phase 3 must use the databricks-lakebase skill to actually create the database and syncs.
- The component contract specifies 6 API endpoints. The app-developer must implement all 6 in the backend for the frontend to function.
- Playback mode uses a purple tint (#6B3FA0) to visually distinguish from live mode — this is intentional and should be preserved in implementation.

#### QA iterations
- Attempt 1: PASS — all 5 checks passed (DLT syntax, 3 Lakebase tables + 4 indexes, 3 HTML wireframes, 7 components, schema match)

### Phase 2: Application Build (2026-03-16)

#### What worked
- app-developer: Full-stack application built in a single pass — 6 API endpoints, 7 React components, 2 custom hooks, TypeScript types, CSS theme, deployment configs. The component contract from Phase 1 served as an effective implementation blueprint.
- Contract-driven development: The pipeline-to-app and ui-to-app contracts provided clear interface boundaries. Backend SQL queries matched the Lakebase table schemas exactly. Frontend components matched the component contract props.
- Security: All SQL uses asyncpg `$N` parameterized queries. OAuth token rotation via Databricks SDK. No hardcoded credentials. CORS configured. Playback enforces 2hr/5000-event caps.

#### What failed or needed fixing
- No failures in this phase. All 6 QA checks passed on first attempt.

#### Patterns to watch for
- `db.py` token rotation creates a new pool and closes the old one. Under load, this could cause brief connection interruptions. Consider implementing a smoother rotation that migrates connections gradually.
- Frontend components use `document.createElement("style")` for component-scoped styles. This works but pollutes the global style scope. Consider CSS modules or styled-components for production.
- MapView creates/removes DOM markers imperatively outside React's render cycle. This works with MapLibre GL but means marker state is not captured in React DevTools.
- The playback engine's `processEventsUpTo` iterates from the current index forward. Scrubbing backward resets to index 0 and replays from the start — this is correct but potentially slow for large event sets.
- `DriverCard` component is nested inside `OrderDrawer` — the component contract intended this. The DriverMarker referenced in the agent definition maps to the DriverCard + driver marker DOM elements in MapView.
- The app-developer agent definition referenced `DriverMarker.tsx` but the component contract defined `DriverCard` as the 7th component. We followed the contract (DriverCard) since it was the authoritative spec from the ui-ux-analyst.

#### QA iterations
- Attempt 1: PASS — all 6 checks passed (endpoints, components, parameterized SQL, polling, configs, no credentials)

### Phase 3: Deploy & Final QA (2026-03-16)

#### What worked
- deploy-engineer: databricks.yml created and validates cleanly. Frontend builds on first try after TypeScript fix. `databricks bundle deploy` uploads all files to workspace. `databricks apps deploy` creates a deployment snapshot successfully.
- App URL provisioned: https://twins-digital-twin-984752964297111.11.azure.databricksapps.com
- All 5 QA checks passed (bundle validation, frontend build, security review, deployment).

#### What failed or needed fixing
- TypeScript strict mode error in OrderDrawer.tsx: casting `OrderDetail` to `Record<string, unknown>` for dynamic key access failed. Fix: created a `getOrderTimestamp()` helper with an explicit field map. Root cause: TypeScript strict mode doesn't allow casting interface types to `Record<string, unknown>` because interface types don't have an index signature.
- databricks.yml initially had a `lakebase_database` field under app resources. The Databricks CLI schema (v0.294.0) doesn't recognize this field, producing a warning. Fix: removed the field and noted that Lakebase resource binding is handled by app.yaml at runtime.
- MCP `create_or_update_app` tool failed with "AppsAPI.create() got an unexpected keyword argument 'name'" — SDK version mismatch. Workaround: used `databricks apps create/deploy` CLI commands directly.
- App crashes on startup because the Lakebase database `twins` hasn't been provisioned yet. This is an infrastructure prerequisite, not a code bug. The app's `db.py` calls `w.lakebase.get_database()` in the lifespan handler, which fails when the database doesn't exist.

#### Patterns to watch for
- Databricks Apps require the Lakebase database to exist before the app can start. The deployment pipeline should include a "provision infrastructure" step before "deploy app." Future runs should add a Phase 2.5 or pre-deploy step that creates the Lakebase database and syncs.
- The Databricks CLI `apps deploy` command requires the app to be in RUNNING state. If the app was previously stopped, you must `apps start` first, then deploy. This two-step process is not obvious.
- `databricks bundle deploy` uploads source code to the workspace but does NOT automatically trigger an app deployment. A separate `databricks apps deploy` call is needed to create a deployment snapshot from the uploaded files.
- Frontend build produces a 985KB JS bundle (MapLibre GL JS is ~700KB). For production, consider code-splitting via dynamic imports to reduce initial load time.

#### QA iterations
- Attempt 1: PASS — all 5 checks passed (databricks.yml valid, frontend builds, bundle validates, security review, deployment succeeded)

### Phase 4: Near-Term Features + Live QA (2026-03-18/19)

#### What worked
- Feature delivery: All 3 PRD features (pipeline drill-down, store detail panel, market tab grouping) implemented and verified in a single session using tiered-execution. Per-task Sonnet subagents + Haiku mechanical tasks kept cost low.
- `getOrderStage()` as single source of truth: Centralizing stage logic in one function (checking `delivered_at` before `current_stage`) fixed an entire class of sync-lag bugs across 6 components simultaneously.
- Chrome DevTools MCP for live testing: Faster than Playwright for deployed app testing — snapshot + click loop caught real bugs (abort loop, 500 error) that unit tests would miss.

#### What failed or needed fixing
- **Polling abort loop**: `usePolling` used `setInterval` (fixed 3s cadence). Slow Lakebase queries (>3s) were cancelled every cycle. Fix: switched to poll-after-completion (`setTimeout` loop). The 3s interval was the interval between *starts*, not *completions* — under load it becomes an abort storm.
- **KPI/pipeline mismatch**: KPI bar pulled `active_orders` and `drivers_out` from a separate backend query using raw `current_stage`. Pipeline computed from frontend orders array using `getOrderStage()`. They diverged under sync lag. Fix: derive both counts client-side from the same orders array.
- **Delivered orders in "In Transit"**: `current_stage = 'driver_ping'` can persist after `delivered_at` is set due to DLT sync lag. Fix: `getOrderStage()` checks `delivered_at` first — `delivered_at IS NOT NULL` always wins regardless of `current_stage`.
- **Drivers endpoint 500 after adding delivered_at filter**: Added `AND (oe.delivered_at IS NULL OR oe.delivered_at = '')`. The `= ''` comparison against a TIMESTAMP column blew up with `InvalidDatetimeFormatError`. Fix: `AND oe.delivered_at IS NULL` only — timestamp columns don't have empty-string values.
- **Yellow dot clutter**: Including last-60-min delivered orders in the orders query for the pipeline Delivered count also added their customer pins to the map. Fix: skip customer pins for `getOrderStage(order) === "Delivered"`, then add green teardrops for delivered orders instead.
- **Market tab overflow**: MarketGroup rendered all 44 stores in SF Bay Area by default. Fix: show only stores with `active_orders > 0`, collapse idle stores behind a `+N` button.

#### Patterns to watch for
- **Lakebase `delivered_at` is TIMESTAMP, not TEXT**: Don't compare with `= ''`. Use `IS NULL` for undelivered check. Other string fields (like `current_stage`) remain TEXT and can be compared with `= ''` as a fallback.
- **Driver positions endpoint uses 2-hour ping window, not delivery status**: The `driver_positions_synced` stream stops after delivery — no return-trip data exists. `progress_pct` is 0–100% of the *outbound* leg only. The "returning to store" UX state is not supported by the current simulator.
- **LEFT JOIN + WHERE on right table = implicit INNER JOIN**: Adding `AND oe.delivered_at IS NULL` to a LEFT JOIN filters out unmatched rows (NULL oe columns pass the IS NULL check, so this is safe here — but validate carefully in other contexts).
- **`usePolling` deps cause cascading aborts on market switch**: When `activeMarketId` changes, `doFetch` callback changes, triggering effect cleanup (abort) + restart. This is correct behavior — market-switch aborts are intentional and distinct from the fixed-interval abort bug.
- **`progress_pct >= 80` as "almost there" proxy**: Based on actual simulator data (max observed: ~93%), this threshold correctly identifies drivers near the customer. Monitor if simulator speed changes alter the distribution.

#### QA iterations
- All features pass Chrome DevTools live testing. One regression (500 on drivers endpoint) caught and fixed within the same session via `/logz` log inspection.

### Feature "Synthetic Customer Dataset" — Phase 1-customers: Customer Data Generation & Pipeline (2026-03-19)

#### What worked
- data-engineer: generate_customers.py produced cleanly on first pass. The finalize.py pattern (WorkspaceClient + psycopg2 + config imports) served as an effective template. The address clustering SQL query against orders_enriched_synced view provides a natural grouping mechanism for synthetic customers.
- order_customer_map DLT streaming table appended to orders_enriched.sql with no changes to existing pipeline code. The LEFT JOIN + COALESCE pattern ensures no orders are dropped even if the address index is empty.

#### What failed or needed fixing
- No failures in this phase. All QA checks passed on first attempt.

#### Patterns to watch for
- `generate_customers.py` uses SparkSession (available in spark_python_task) for Delta writes but psycopg2 for Postgres reads. This dual-path pattern works because the script needs Lakebase data as input (via Postgres) but writes to UC Delta tables (via Spark). Future scripts following this pattern should import both SparkSession and psycopg2.
- The `__import__("datetime")` inline import in `_generate_customer` is a code smell introduced by the loyalty_join_date calculation. A top-level `from datetime import datetime, timedelta` would be cleaner. Not a bug but worth cleaning up.
- The persona assignment uses hard thresholds (e.g., lunch_ratio > 0.6, order_count >= 5). These may need tuning based on actual data distribution. The thresholds are documented in the function docstring.
- The DLT streaming table `order_customer_map` LEFT JOINs against `customer_address_index` (a static Delta table). If the address index is regenerated, already-processed orders will NOT be re-mapped (streaming tables don't reprocess). New orders will use the updated index.

### Feature "Synthetic Customer Dataset" — Phase 2-customers: DAB Integration & QA (2026-03-19)

#### What worked
- deploy-engineer: databricks.yml and config.py modifications were straightforward additive changes. Task 5 chains correctly after finalize. faker dependency added to existing setup_env.
- qa-engineer: All 5 QA checks passed on first attempt. Bundle validates. Schema consistency confirmed across all 3 new tables.
- Grants: finalize.py's schema-level GRANT pattern (`GRANT SELECT ON ALL TABLES IN SCHEMA` + `ALTER DEFAULT PRIVILEGES`) auto-covers new tables. No grant changes needed.

#### What failed or needed fixing
- Azure profile token was expired, causing `databricks bundle validate -p azure` to fail with "Refresh token is invalid". The DEFAULT profile works. This is an auth environment issue, not a code issue.

#### Patterns to watch for
- The SYNCS list in config.py now has 6 entries. The create_syncs.py script iterates all SYNCS and uses `ALREADY_EXISTS` detection, so re-running after adding new entries is safe. However, new synced tables require the Delta source tables to exist first — which means generate_customers must run before create_syncs can process the customer syncs. The task dependency chain (finalize -> generate_customers) handles this for the DAB job, but manual re-runs of create_syncs will skip the new tables if the Delta sources don't exist yet.
- order_customer_map_synced uses CONTINUOUS sync policy, matching the streaming nature of the DLT source table. This means Lakebase will continuously ingest new order-to-customer mappings as they arrive.

#### QA iterations
- Attempt 1: PASS — all 5 checks passed (generate_customers.py validation, orders_enriched.sql validation, databricks.yml bundle validate, config.py sync/index counts, schema consistency)
