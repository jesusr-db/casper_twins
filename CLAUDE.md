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

---

## Remaining Steps to Go Live

1. **Provision Lakebase database**: Use the `databricks-lakebase` skill or MCP tool to create the `twins` database in catalog `caspersdev_jmr`
2. **Set up sync pipelines**: Create the 3 Lakebase syncs (markets, orders, order_events) per `pipelines/lakebase_sync_setup.sql`
3. **Create Postgres indexes**: Run the 4 CREATE INDEX statements after syncs are established
4. **Add DLT SQL to pipeline**: Add `pipelines/orders_current_state.sql` to the existing Lakeflow DLT pipeline
5. **Restart app**: `databricks apps deploy twins-digital-twin --source-code-path ...` or restart via UI
6. **Verify**: Hit https://twins-digital-twin-984752964297111.11.azure.databricksapps.com and confirm 4 markets load
