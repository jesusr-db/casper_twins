# Phase 1 — Absorb Caspers Event Datagen into Twins

**Status**: Design — pending user review
**Date**: 2026-04-20
**Companion work**:
- `docs/superpowers/specs/2026-04-20-b3-roadmap-design.md` (Phase 0 deploy.sh)
- `docs/superpowers/specs/2026-04-20-strip-cx-panel-design.md` (Work 2 — CX strip)
**Research foundation**: `docs/superpowers/research/2026-04-20-caspers-full-audit.md` (712-line audit)
**Scope**: Make twins the sole producer of `lakeflow.all_events` and `simulator.*` dimensional tables by absorbing caspers' event generation stack.

---

## Problem

Twins currently depends on `../caspers-kitchens` to produce two Delta tables it consumes via Lakebase syncs: `lakeflow.all_events` (1M+ events/90-day replay window) and `simulator.locations` (88 stores). The audit established that:

1. These tables are produced by **runtime-created** Databricks resources: a DLT pipeline declared inside `stages/lakeflow.ipynb` and a scheduled job declared inside `stages/canonical_data.ipynb` — neither is a DAB resource.
2. The live event-write path uses a **lockless watermark file** in a UC Volume. Concurrent runs race.
3. Dimensional tables are seeded with `write.mode("overwrite")` — unguarded; every caspers run clobbers existing tables.
4. Seed data (`events.parquet` + dim parquets) lives in caspers' repo at `data/canonical/canonical_dataset/*.parquet`, produced by `generate_dimensions.py` + `generate_canonical_dataset.py`.
5. Caspers has been **declared dead** (user decision 2026-04-20): twins becomes the sole live demo. No cross-bundle coordination required going forward.

This project absorbs everything caspers produces that twins consumes, ships it as first-class DAB resources in twins, fixes the concurrency race, and retires caspers for good.

## Goals

1. `vdm_classic_rikfy0_catalog.lakeflow.all_events` produced by a **twins-owned, DAB-declared** DLT pipeline.
2. `vdm_classic_rikfy0_catalog.simulator.*` dimensional tables seeded by a **twins-owned** setup task from deterministic generators vendored in the repo.
3. Replay engine running as a **DAB-declared, scheduled job** with `max_concurrent_runs: 1` to prevent watermark races.
4. Twins fully self-contained at the data layer. No cross-bundle dependency remains.
5. Caspers' remaining code (menus, inspections, LLM agents, refund-manager app) is left alone; it was declared dead and operators are aware.

## Non-goals

- Porting caspers' LLM-backed stages (menus, inspections, refunder, complaints agents).
- Replacing the `.ipynb` format for absorbed live-path notebooks — user chose verbatim copy.
- Moving to a new catalog name — staying on `vdm_classic_rikfy0_catalog`.
- Rewriting `canonical_generator_simple.ipynb` for stronger concurrency semantics — `max_concurrent_runs: 1` is the agreed fix.
- Shadow-schema parallel verification window — big-bang cutover agreed.
- `generate_dimensions.py` / `generate_canonical_dataset.py` improvements (tests, parameter sweeps) — port verbatim.
- Decommissioning caspers (its code stays where it is; nobody deploys it).
- Monitoring dashboard / alerting on `MAX(ts)` staleness — acknowledged as follow-up.
- Genie Space / StoreOps AI integration — separate roadmap.
- Migration tooling for any existing in-flight orders — cutover is destructive; run during low-activity window.

## Decisions (recap from brainstorm)

| # | Decision | Rationale |
|---|---|---|
| 1 | Caspers is dead after this lands | User decision — twins becomes sole live demo |
| 2 | Keep catalog name `vdm_classic_rikfy0_catalog` | Zero migration cost; name is ugly but harmless |
| 3 | Vendor generators, regenerate seed data on first setup | Deterministic (`np.random.seed(42)`), keeps repo small, explicit provenance |
| 4 | Big-bang cutover | Caspers-is-dead removes the need for parallel-run safety |
| 5 | `max_concurrent_runs: 1` on the scheduled replay job | Simple, effective, matches Databricks-native knobs |
| 6 | Keep absorbed notebooks as `.ipynb` | Verbatim copy minimizes behavior drift |
| 7 | One atomic PR | Matches big-bang cutover; one review, one revert |

---

## Architecture overview

**Target state after merge**:

```
┌─────────────────────────────────────────────────────────────────┐
│                          TWINS (self-contained)                  │
│                                                                  │
│  setup-lakebase job:                                             │
│    ┌────────────────────┐   ┌─────────────────┐                  │
│    │ bootstrap_datagen  │─▶ │ canonical_data  │ (.ipynb)         │
│    │ (runs generators,  │   │ seeds sim.*,    │                  │
│    │  fills UC Volume)  │   │ init watermark  │                  │
│    └────────────────────┘   └────────┬────────┘                  │
│                                      ▼                           │
│    ┌──────────────────────────────────────────────────┐          │
│    │ trigger_pipeline → provision → generate_customers │          │
│    │   → create_syncs → finalize                       │          │
│    └──────────────────────────────────────────────────┘          │
│                                                                  │
│  datagen-replay job (scheduled, every 3 min, max_concurrent=1):  │
│    canonical_generator_simple.ipynb                              │
│      ├─ reads /Volumes/.../simulator/canonical_seed/events.pq    │
│      ├─ reads/writes /Volumes/.../simulator/misc/_watermark      │
│      └─ appends JSON to /Volumes/.../simulator/events/           │
│                                                                  │
│  DAB-declared DLT pipeline (twins-order-items, continuous):      │
│    pipelines/order_items/transformations/transformation.py       │
│      produces lakeflow.{all_events, silver_*, gold_*}            │
│                                                                  │
│  Existing DAB-declared pipeline (twins-orders-enriched):         │
│    pipelines/orders_enriched.sql                                 │
│      reads lakeflow.all_events, produces orders_enriched +       │
│      driver_positions + order_customer_map                       │
└─────────────────────────────────────────────────────────────────┘
                            No external dependencies
```

Caspers is gone from this picture.

---

## File structure

### New directory: `datagen/`

| Path | Type | Source | Purpose |
|---|---|---|---|
| `datagen/canonical_data.ipynb` | Notebook | Copied verbatim from `../caspers-kitchens/stages/canonical_data.ipynb` | Live seeder — one-shot per setup; reads dim parquets, writes `simulator.*` Delta tables, initializes watermark |
| `datagen/canonical_generator_simple.ipynb` | Notebook | Copied verbatim from `../caspers-kitchens/data/canonical/canonical_generator_simple.ipynb` | Replay engine — scheduled every 3 min; reads events.parquet + watermark, appends JSON to events Volume, advances watermark |
| `datagen/generators/generate_dimensions.py` | Python | Copied from `../caspers-kitchens/data/canonical/generate_dimensions.py` | Offline dim generator; `numpy.random.seed(42)` |
| `datagen/generators/generate_canonical_dataset.py` | Python | Copied from `../caspers-kitchens/data/canonical/generate_canonical_dataset.py` | Offline event generator; deterministic |
| `datagen/generators/regenerate_all.py` | Python | Copied from `../caspers-kitchens/data/canonical/regenerate_all.py` | Wrapper: runs both generators in sequence; accepts `--out-dir` |

**Header comment** on each vendored file: `# Ported from caspers-kitchens at commit <SHA> on 2026-04-20. Caspers is retired — this is now the authoritative copy. Modifying this file is a twins-internal decision.`

### New directory: `pipelines/order_items/`

| Path | Source | Purpose |
|---|---|---|
| `pipelines/order_items/transformations/transformation.py` | Copied verbatim from `../caspers-kitchens/pipelines/order_items/transformations/transformation.py` | DLT code producing `@dlt.table all_events` (Auto Loader over events Volume), `@dlt.table silver_order_items`, `@dlt.table gold_order_header`, `@dlt.table gold_item_sales_day`, `@dlt.table gold_brand_sales_day`, `@dlt.table gold_location_sales_hourly` |

### New file: `setup/bootstrap_datagen.py`

**Responsibilities**:
1. Check for a marker file at `/Volumes/vdm_classic_rikfy0_catalog/simulator/canonical_seed/.seed-complete`.
2. If present — log and return (idempotent no-op).
3. If absent — invoke `datagen/generators/regenerate_all.py` with `--out-dir /Volumes/vdm_classic_rikfy0_catalog/simulator/canonical_seed/`.
4. On success, write the `.seed-complete` marker.

Expected first-run wall time: 2–5 minutes (events.parquet generation dominates).
Expected subsequent-run wall time: < 1 second (marker hit, immediate return).

### `databricks.yml` additions

```yaml
variables:
  catalog:
    description: "UC catalog for twins data"
    default: vdm_classic_rikfy0_catalog

resources:
  schemas:
    simulator:
      catalog_name: ${var.catalog}
      name: simulator
      comment: "Store metadata + dim tables + event replay volume (twins-owned)"
    lakeflow:
      catalog_name: ${var.catalog}
      name: lakeflow
      comment: "Event stream + orders_enriched + silver/gold aggregates (twins-owned)"

  volumes:
    simulator_events:
      catalog_name: ${var.catalog}
      schema_name: simulator
      name: events
      comment: "JSON event files appended by datagen-replay; consumed by twins-order-items DLT pipeline"
    simulator_canonical_seed:
      catalog_name: ${var.catalog}
      schema_name: simulator
      name: canonical_seed
      comment: "Generator output: events.parquet + dim parquets; filled by bootstrap_datagen"

  pipelines:
    order_items:
      name: twins-order-items
      catalog: ${var.catalog}
      schema: lakeflow
      serverless: true
      continuous: true
      libraries:
        - file:
            path: pipelines/order_items/transformations/transformation.py
      configuration:
        RAW_DATA_CATALOG: ${var.catalog}
        RAW_DATA_SCHEMA: simulator
        RAW_DATA_VOLUME: events
      tags:
        app: twins
      permissions:
        - user_name: jesus.rodriguez@databricks.com
          level: CAN_MANAGE

  jobs:
    datagen-replay:
      name: twins-datagen-replay
      description: >
        Replay engine — every 3 minutes, appends a batch of event JSON files
        to /Volumes/.../simulator/events/ based on a watermark. Consumed by
        the twins-order-items DLT pipeline to produce lakeflow.all_events.

        IMPORTANT: landed PAUSED. Unpause only after setup-lakebase has
        completed its canonical_data task (otherwise concurrent writes to the
        watermark + events volume can race).
      tags:
        app: twins
      max_concurrent_runs: 1
      schedule:
        quartz_cron_expression: "0 0/3 * * * ?"
        timezone_id: UTC
        pause_status: PAUSED
      tasks:
        - task_key: replay
          notebook_task:
            notebook_path: ${workspace.root_path}/datagen/canonical_generator_simple
            base_parameters:
              CATALOG: ${var.catalog}
              SCHEMA: simulator
              VOLUME: events
              SCHEDULE_MINUTES: "3"
              SPEED_MULTIPLIER: "60.0"
              START_DAY: "70"
      run_as:
        user_name: jesus.rodriguez@databricks.com
      permissions:
        - user_name: jesus.rodriguez@databricks.com
          level: CAN_MANAGE
```

### `databricks.yml` changes — updated `setup-lakebase` job

Prepend two tasks to the existing `setup-lakebase` task graph:

```yaml
  jobs:
    setup-lakebase:
      tasks:
        - task_key: bootstrap_datagen           # NEW
          spark_python_task:
            python_file: setup/bootstrap_datagen.py
          environment_key: setup_env
        - task_key: canonical_data              # NEW
          depends_on:
            - task_key: bootstrap_datagen
          notebook_task:
            notebook_path: ${workspace.root_path}/datagen/canonical_data
            base_parameters:
              CATALOG: ${var.catalog}
              SIMULATOR_SCHEMA: simulator
              EVENTS_VOLUME: events
              SEED_DIR: /Volumes/${var.catalog}/simulator/canonical_seed
              START_DAY: "70"
              SPEED_MULTIPLIER: "60.0"
        - task_key: trigger_pipeline
          depends_on:
            - task_key: canonical_data          # CHANGED: was no dependency
          spark_python_task:
            python_file: setup/trigger_pipeline.py
          environment_key: setup_env
        # ... provision_lakebase, generate_customers, create_syncs, finalize: unchanged
```

Note: `trigger_pipeline` now triggers both the existing `twins-orders-enriched` pipeline and the new `twins-order-items` pipeline. `setup/trigger_pipeline.py` needs a small update to trigger both (or just the new one — `twins-orders-enriched` is already continuous and will pick up from `all_events` once it exists).

### `databricks.yml` changes — updated `destroy-lakebase` job

The destroy job's `setup/destroy_lakebase.py` is extended to:
1. **Pre-step**: pause `twins-datagen-replay` via SDK (prevents races during drops).
2. **Existing steps 1-3**: drop synced tables, Lakebase instance, twins-owned DLT tables.
3. **New step 4**: drop twins-owned base tables (`lakeflow.all_events` + silver + gold; `simulator.brands`, `simulator.locations`, `simulator.menus`, `simulator.categories`, `simulator.items`, `simulator.brand_locations`).
4. **New step 5**: drop the two UC Volumes (`simulator.events`, `simulator.canonical_seed`).

DAB resources (pipelines, jobs, schemas, volumes) themselves are removed by `databricks bundle destroy`, not by this task.

---

## Cutover sequence

**Day-of, in order** (expected window: 30–60 min):

### Step 0 — Pre-flight
- [ ] Confirm Work 2 (CX strip) is merged to main (simpler workflow, not strictly required).
- [ ] Backup: snapshot last 24 h of `all_events` as insurance:
  ```sql
  CREATE TABLE vdm_classic_rikfy0_catalog.default.all_events_backup_2026_04_20
  AS SELECT * FROM vdm_classic_rikfy0_catalog.lakeflow.all_events
  WHERE ts >= current_timestamp() - INTERVAL 24 HOURS;
  ```
- [ ] Check caspers resources are actually dormant:
  ```bash
  databricks pipelines list -p DEFAULT | grep -iE "caspers|spark_declarative"
  databricks jobs list -p DEFAULT | grep -iE "canonical_data|caspers"
  ```

### Step 1 — Quiesce any remaining caspers resources
If anything surfaced in Step 0:
```bash
databricks pipelines stop <caspers-pipeline-id> -p DEFAULT
databricks pipelines delete <caspers-pipeline-id> -p DEFAULT
databricks jobs delete --job-id <caspers-job-id> -p DEFAULT
```

### Step 2 — Drop caspers-created tables
Via MCP `execute_sql`:
```sql
DROP TABLE IF EXISTS vdm_classic_rikfy0_catalog.lakeflow.all_events;
DROP TABLE IF EXISTS vdm_classic_rikfy0_catalog.lakeflow.silver_order_items;
DROP TABLE IF EXISTS vdm_classic_rikfy0_catalog.lakeflow.gold_order_header;
DROP TABLE IF EXISTS vdm_classic_rikfy0_catalog.lakeflow.gold_item_sales_day;
DROP TABLE IF EXISTS vdm_classic_rikfy0_catalog.lakeflow.gold_brand_sales_day;
DROP TABLE IF EXISTS vdm_classic_rikfy0_catalog.lakeflow.gold_location_sales_hourly;
DROP TABLE IF EXISTS vdm_classic_rikfy0_catalog.simulator.brands;
DROP TABLE IF EXISTS vdm_classic_rikfy0_catalog.simulator.locations;
DROP TABLE IF EXISTS vdm_classic_rikfy0_catalog.simulator.menus;
DROP TABLE IF EXISTS vdm_classic_rikfy0_catalog.simulator.categories;
DROP TABLE IF EXISTS vdm_classic_rikfy0_catalog.simulator.items;
DROP TABLE IF EXISTS vdm_classic_rikfy0_catalog.simulator.brand_locations;
```
**Do NOT drop**:
- `lakeflow.orders_enriched`, `lakeflow.driver_positions`, `lakeflow.order_customer_map` — twins-owned via existing `twins-orders-enriched` pipeline.
- `simulator.customers`, `simulator.customer_address_index` — twins-owned via `setup/generate_customers.py`.

### Step 3 — Deploy bundle
```bash
./scripts/deploy.sh
```

Chained effect:
1. `bundle deploy` — uploads `datagen/`, `pipelines/order_items/`, creates DAB schemas/volumes/pipeline/jobs (`twins-datagen-replay` lands PAUSED).
2. `bundle run setup-lakebase` — runs `bootstrap_datagen` → `canonical_data` → `trigger_pipeline` → `provision_lakebase` → `generate_customers` → `create_syncs` → `finalize`.
3. `apps deploy` — redeploys the twins app.

### Step 4 — Unpause replay job
After `setup-lakebase` completes and you've confirmed `canonical_data` seeded `simulator.locations` (88 rows), unpause the replay:
```bash
# Via UI or CLI:
databricks jobs update --job-id <twins-datagen-replay-id> \
  --json '{"new_settings": {"schedule": {"pause_status": "UNPAUSED", "quartz_cron_expression": "0 0/3 * * * ?", "timezone_id": "UTC"}}}' \
  -p DEFAULT
```

Alternatively, update `pause_status: UNPAUSED` in `databricks.yml` in a follow-up commit + `bundle deploy`.

### Step 5 — Verify
See verification section below. Wait ~10 min for 3+ replay ticks, then full check.

### Rollback path
If Steps 3–5 go wrong:
```bash
databricks bundle destroy -p DEFAULT   # removes new DAB resources
```
Then either:
- Restore caspers (if code + access still exist): re-run caspers' `bundle run caspers -t default`.
- Or use the `all_events_backup_2026_04_20` snapshot as a data recovery source while debugging forward.

There is no clean roll-forward/roll-back midstream — caspers was retired. Plan accordingly: do cutover during low activity, keep the backup table, have someone on hand to triage.

---

## Verification

### Pre-merge (static)
- [ ] `databricks bundle validate -p DEFAULT` passes.
- [ ] `python -m py_compile setup/bootstrap_datagen.py setup/*.py datagen/generators/*.py` passes.
- [ ] `cd frontend && npm run build && npx tsc --noEmit` passes (no frontend changes; sanity check).

### Post-deploy immediate (within 5 min of `deploy.sh` finishing)
- [ ] `databricks pipelines list -p DEFAULT | grep twins-order-items` shows PROCESSING or RUNNING.
- [ ] `databricks jobs list -p DEFAULT | grep twins-datagen-replay` — job exists, check pause_status.
- [ ] `SELECT COUNT(*) FROM vdm_classic_rikfy0_catalog.lakeflow.all_events;` returns > 0.
- [ ] `SELECT COUNT(*) FROM vdm_classic_rikfy0_catalog.simulator.locations;` returns exactly **88**.
- [ ] Browser: app URL loads; market tabs render; orders appear.

### Post-unpause (wait 10–15 min for 3–4 replay ticks)
- [ ] `twins-datagen-replay` run history shows ≥3 SUCCESS.
- [ ] `MAX(ts)` advances ~3 hours of sim-time per tick (180 min @ 60x).
- [ ] `lakeflow.silver_*` and `lakeflow.gold_*` tables populated.
- [ ] `all_events_synced` count matches or slightly trails the Delta table (Lakebase CONTINUOUS sync).

### Extended watch (30–60 min)
- [ ] Orders progress through stages in the app.
- [ ] Drivers move on the map.
- [ ] KPIs update.
- [ ] No new errors in `databricks apps logs twins-digital-twin -p DEFAULT`.
- [ ] No 503s on data-bearing endpoints.

### Destroy / setup cycle (end-to-end idempotency)
- [ ] `databricks bundle run destroy-lakebase -p DEFAULT` completes cleanly.
- [ ] All `simulator.*` and `lakeflow.all_events` tables dropped; UC Volumes wiped.
- [ ] `./scripts/deploy.sh` brings everything back.
- [ ] `MAX(ts)` restarts from `START_DAY=70` seed state.

---

## Risks

| Risk | Likelihood | Mitigation |
|---|---|---|
| `datagen-replay` first run overlaps with `canonical_data` setup task | Medium | Job lands PAUSED; manual unpause after setup completes |
| `generate_canonical_dataset.py` takes >10 min on first bootstrap | Low | Documented wall-time; only runs once per destroy/setup cycle |
| `bootstrap_datagen` cluster runs out of memory for 1M-row parquet gen | Medium | Use standard serverless compute; chunk generation if hit |
| DAB `schemas` / `volumes` resource claims existing objects | Low | DAB is idempotent on matching name; pre-flight `SHOW SCHEMAS` if paranoid |
| `transformation.py` references caspers-specific config we miss | Medium | Verbatim first pass; review for hardcoded paths; configuration map uses RAW_DATA_CATALOG/SCHEMA/VOLUME env vars already |
| Watermark state corruption during Step 2 drops | Low | Watermark file is in a Volume, not a Delta table; Volume survives Delta table drops |
| Caspers pipeline still active, racing twins' pipeline | Low | Cutover Step 1 explicitly deletes caspers resources |
| In-flight orders lost during table drops | Medium | Low-activity cutover window; `orders_enriched` rebuilds as events flow |
| Vendored generators silently drift from caspers | Low | Header comment names source SHA; don't modify vendored files |

---

## Deliverables

- `datagen/` directory: 2 `.ipynb` + 3 `.py` generator files (all verbatim ported).
- `pipelines/order_items/transformations/transformation.py` (ported).
- `setup/bootstrap_datagen.py` (new, ~40 lines).
- `databricks.yml` (additions: 2 schemas, 2 volumes, 1 pipeline, 1 scheduled job; updated `setup-lakebase` task graph; updated destroy-lakebase).
- `setup/destroy_lakebase.py` (extended: pause replay job, drop twins base tables + silver + gold, drop volumes).
- `CLAUDE.md` (new paragraph: "Twins owns event generation as of 2026-04-20. Caspers retired.").
- `docs/roadmap-handoff.md` (B3 marked complete).
- Cutover runbook — inline in PR description.

---

## Open coordination items (cross-team / cross-repo)

None. Caspers is dead per user decision. All work is twins-internal.
