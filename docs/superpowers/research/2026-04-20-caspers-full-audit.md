# Caspers-Kitchens Full Audit for Twins B3 Phase 1

**Date:** 2026-04-20
**Auditor:** Claude (research agent, Opus 4.7)
**Target:** `/Users/jesus.rodriguez/Documents/ItsAVibe/gitrepos_FY27/caspers-kitchens/`
**Purpose:** Map every file, job, pipeline, and data flow in caspers that twins depends on (or may need to absorb) for B3 Phase 1 re-scoping.

---

## Executive summary

Caspers-kitchens is a three-layer demo: **DABs-deployed notebook job** ("Casper's Initializer") → **runtime-created Databricks resources** (jobs, pipelines, apps, Lakebase, serving endpoints) → **UC-state tracking table** for cleanup. The `databricks.yml` contains **zero pipeline resources and zero app resources**. Everything downstream of the canonical data stage is created dynamically from notebooks that call the Databricks SDK — the "Spark_Declarative_Pipeline" task key in `databricks.yml` runs a notebook (`stages/lakeflow.ipynb`) that itself creates a pipeline via `w.pipelines.create(...)`. That pipeline's code lives at `pipelines/order_items/transformations/transformation.py` and is the sole producer of `lakeflow.all_events`.

Top surprises:

1. **`stages/raw_data.ipynb` is dead code.** No target in `databricks.yml` references it. The live path is `stages/canonical_data.ipynb`, which seeds `simulator.locations` from `data/canonical/canonical_dataset/locations.parquet` (88 Domino's locations, not the 4 "ghost kitchens" the README still describes). `init.ipynb` is also stale — it references `raw_data` and `LOCATIONS` parameters that don't exist in the shipped bundle.
2. **`lakeflow.all_events` is a DLT streaming table, not an explicit SQL artifact.** It auto-loads JSON files from `/Volumes/{CATALOG}/simulator/events` using `cloudFiles`. The pipeline is created at runtime with both `continuous=True` (if `PIPELINE_SCHEDULE_MINUTES=0`) and `serverless=True`.
3. **`simulator.locations` is seeded by `write.mode("overwrite").saveAsTable(...)` every time `canonical_data` runs.** Not guarded. If the task runs while twins is reading, reads race against a table rewrite. Locations 1–4 once referenced Casper ghost kitchens; the current file has 88 Domino's locations with extra columns (`base_orders_day`, `growth_rate_daily`) — downstream code should not assume the old schema.
4. **Five writers still use `write.mode("overwrite")`, none guarded.** No `CREATE TABLE IF NOT EXISTS` guard for the simulator dims, food_safety dims, or menu_documents. Every run of `canonical_data` clobbers `simulator.{brands, locations, menus, categories, items, brand_locations}` regardless of existing content.
5. **`canonical_generator_simple.ipynb` is a lockless watermark replayer.** It reads/writes `/Volumes/{CATALOG}/simulator/misc/_watermark` with no lock. The watermark is rewritten every 3 minutes by a scheduled job. Two concurrent runs (manual + scheduled) race: both read the same old watermark, both compute overlapping windows, both write duplicate events to the volume and one of them overwrites the watermark. **There is no `max_concurrent_runs` set anywhere in the repo** — grep confirms zero occurrences.
6. **Stream jobs that depend on `all_events` sit outside the pipeline:** the complaint generator and refund recommender are scheduled via `cron "0 0/10 * * * ?"` (every 10 minutes), each configured in a `stages/*.ipynb` wrapper that calls `w.jobs.create(...)`. These also have no concurrency policy and no update-in-place; `complaint_generator_stream.ipynb` calls `w.jobs.create(...)` unconditionally — meaning every rerun of that stage creates a *new* job.

Realistic absorption shape: twins needs to own the **event stream and its dimensions** (everything from canonical parquet → volume JSON → `lakeflow.all_events` + `simulator.locations`). Caspers retains the LLM stream jobs (`complaints.raw_complaints`, `recommender.refund_recommendations`), the refunder/complaint agents, and the menu/inspection sub-demos. The coupling point that must survive: caspers' LLM streams read `${CATALOG}.lakeflow.all_events` via `spark.readStream.table(...)` — whatever twins builds to replace the lakeflow pipeline must continue to produce an `all_events` table at that fully-qualified name in the shared catalog with at least `event_type`, `order_id`, `ts`, `body`, `location_id` columns.

---

## 1. Repository inventory

### 1.1 `data/` tree

Total: ~59 MB (almost entirely `canonical/canonical_dataset/events.parquet`).

#### `data/canonical/` (59 MB)
The canonical dataset layer. All live event and dimension data flows through here.

| File | Size | Purpose |
|---|---:|---|
| `README.md` | 16 KB | Domino's dataset docs (note: claims 4 locations, 6 KB — **stale**; actual file has 88 locations) |
| `canonical_generator.ipynb` | 24 KB | Rich version: registers custom PySpark `CaspersDataSource` streaming source. Not used by any target in `databricks.yml`. |
| `canonical_generator_simple.ipynb` | 16 KB | **The live one** — scheduled every 3 min by `canonical_data` stage. Pandas replay with lockless watermark. |
| `caspers_data_source.py` | 16 KB | Standalone Python module for local testing — the custom `CaspersDataSource` class. |
| `caspers_streaming_notebook.py` | 16 KB | Databricks-notebook form of the custom data source. Not used by bundle. |
| `generate_canonical_dataset.py` | 20 KB | Offline 90-day event generator. Produces `events.parquet`. Runs locally, not on Databricks. |
| `generate_dimensions.py` | 16 KB | Offline generator for all canonical dim parquets (locations, brands, brand_locations, menus, categories, items). Seeds `numpy.random.seed(42)`. |
| `regenerate_all.py` | 4 KB | Wrapper around the two generators. |

**`data/canonical/canonical_dataset/` (58 MB — the live seed data)**

| File | Size | Rows | Columns | Seeds → |
|---|---:|---:|---|---|
| `events.parquet` | 45 MB | 1,014,290 | event_type_id, ts_seconds, location_id, order_id, sequence, items_json, route_json, ping_*, customer_*, delivered_* | JSON files in `/Volumes/{CATALOG}/simulator/events` (via `canonical_generator_simple`) |
| `orders.parquet` | 14 MB | 75,780 | per-order metadata | Not seeded — supporting file only |
| `locations.parquet` | 12 KB | **88** | location_id, location_code, name, address, lat, lon, narrative, base_orders_day, growth_rate_daily | `{CATALOG}.simulator.locations` (canonical_data cell 7) |
| `brand_locations.parquet` | 8 KB | 88 | brand_location_id, brand_id, location_id, start_day, end_day, trajectory, growth_rate_monthly | `{CATALOG}.simulator.brand_locations` |
| `items.parquet` | 8 KB | ~29 | id, category_id, menu_id, brand_id, name, price | `{CATALOG}.simulator.items` |
| `categories.parquet` | 4 KB | 8 | id, menu_id, brand_id, name | `{CATALOG}.simulator.categories` |
| `menus.parquet` | 4 KB | 1 | id, brand_id, name | `{CATALOG}.simulator.menus` |
| `brands.parquet` | 4 KB | 1 | brand_id, name, cuisine_type, avg_prep_time_min | `{CATALOG}.simulator.brands` |

`brands.parquet` has **1 row** — the Domino's conversion collapsed all 24 original brands into a single pizza brand. This is important: any twins code that assumed multiple brand rows is now operating on a single brand.

#### `data/dimensional/` (28 KB) — **superseded by canonical/**

| File | Size | Purpose |
|---|---:|---|
| `brands.parquet` | 4 KB | Used only by stale `stages/raw_data.ipynb`. Has original 24-brand schema. |
| `menus.parquet` | 4 KB | " |
| `categories.parquet` | 8 KB | " |
| `items.parquet` | 12 KB | " |

These four files are the inputs to `stages/raw_data.ipynb` (dead code). No location file — `raw_data.ipynb` never seeded `simulator.locations` in the first place; only `canonical_data.ipynb` does.

#### `data/generator/` (48 KB) — **superseded**

| File | Size | Purpose |
|---|---:|---|
| `generator.ipynb` | 28 KB | Original long-running order-stream generator. Invoked dynamically by `raw_data.ipynb` only. Dead in current bundle. |
| `configs/sanfrancisco.json` | 4 KB | One city config for the old generator. |
| `configs/chicago.json` | 4 KB | " |
| `configs/README.md` | 12 KB | Generator config docs. |

#### `data/inspections/` (88 KB) and `data/menus/` (164 KB) — menus target

| Path | Description |
|---|---|
| `inspections/pdfs/` (12 files) | Food safety inspection PDFs (4 locations × 3 dates, one per month). ~4 KB each. |
| `inspections/inspection_metadata.json` | 20 KB — structured metadata matching PDFs. |
| `inspections/generate_inspection_reports.py` | Offline PDF generator. |
| `menus/pdfs/` (16 files) | Restaurant menu PDFs. ~4 KB each. |
| `menus/menu_metadata.json` | 56 KB — structured items/nutrition/allergens. |
| `menus/generate_menu_pdfs.py` | Offline PDF generator. |

These are consumed only by the `menus` target (menu_data / inspection_data stages). No twins dependency.

### 1.2 `utils/` tree

| File | Purpose |
|---|---|
| `utils/__init__.py` | Re-exports `UCState`, `create_state_manager`, `add` from `uc_state`. |
| `utils/resolve_tasks.py` | CLI helper. Parses `databricks.yml`, resolves task dependency closures, emits `export TASK_KEY="...,..."` shell snippets for `databricks bundle run caspers --only $Refund_...`. Read-only — no Databricks calls. |
| `utils/uc_state/__init__.py` | Re-exports `UCState`, `create_state_manager`, `add`. |
| `utils/uc_state/state_manager.py` | **The heart of the tracking system.** Class `UCState` writes to `{CATALOG}._internal_state.resources` (a Delta table) every time any stage creates a job/pipeline/endpoint/app/etc. Supports 14 resource types. `clear_all()` iterates them in strict deletion order. Every stage notebook ends with `sys.path.append('../utils'); from uc_state import add; add(...)`. |
| `utils/uc_state/requirements.txt` | `databricks-sdk`. |
| `utils/uc_state/setup.py`, `README.md` | Standalone package boilerplate. |

### 1.3 `pipelines/` tree

This directory holds **Lakeflow Spark Declarative Pipeline** source files. Notably, `databricks.yml` does not register these as `resources.pipelines.*` — they are uploaded via `sync.include: ./*` and then referenced by runtime pipeline creation (`stages/lakeflow.ipynb` → `libraries=[p.PipelineLibrary(glob=p.PathPattern(include=f"{root_dbx_path}/**"))]`).

| File | Role |
|---|---|
| `pipelines/order_items/transformations/transformation.py` | **Produces `lakeflow.all_events`** and all `silver_*`/`gold_*` order tables. Created at runtime via SDK by `stages/lakeflow.ipynb`. |
| `pipelines/menu_documents/transformations/transformation.py` | Produces `menu_documents.bronze_*/silver_*` and `food_safety.*` tables. Created at runtime by `stages/menu_pipeline.ipynb` (menus target). |

No `pipelines/*/pipeline.yml` files — the pipeline config is entirely in the notebook that creates it.

### 1.4 `init.ipynb` and `destroy.ipynb`

**`init.ipynb` (~10 KB):** Creates a standalone "Casper's Initializer" job via `w.jobs.create(...)` using hard-coded task DAG. **This file is stale**: it references `./stages/raw_data` (not `canonical_data`), uses LLM model `databricks-meta-llama-3-3-70b-instruct` (not `databricks-gpt-oss-20b`), and defines a `LOCATIONS` parameter with default `"sanfrancisco.json"`. Not used by the bundle flow; appears to be a bootstrap fallback if running without DABs.

**`destroy.ipynb` (~20 KB):** Runtime cleanup notebook — called by `databricks bundle run cleanup`. Reads `{CATALOG}._internal_state.resources` (via `uc_state`), walks a deletion order (jobs → pipelines → endpoints → KAs/MAS → VS indexes/endpoints → genie → apps → database catalogs → database instances → warehouses → MLflow experiments). **Explicitly preserves catalogs/schemas/tables** — this is why twins' reads into `vdm_classic_rikfy0_catalog` keep working across cleanups. Does NOT touch the watermark volume, the simulator volume, the simulator dim tables, or the lakeflow tables.

### 1.5 Top-level files

| File | Content / signal |
|---|---|
| `app.yaml` | 5 lines. `command: ["npm", "run", "start"]` + `SESSION_DEFAULT_CWD=/app/python/source_code`. This is the **root app** (CaspersAI Terminal wrapper), not the refund-manager app. |
| `package.json` | Root wrapper that `cd`s into `apps/caspersai-terminal` for `build`/`start`. The whole repo ships as a deployable Databricks App — but only the CaspersAI terminal; the refund-manager is deployed separately via `stages/apps.ipynb`. |
| `claude.md` | 4 lines. Points to `AGENTS.md`. |
| `AGENTS.md` | 26 KB. Project conventions for agent-driven work. Describes the three-layer architecture (DABs / Stages / uc_state). |
| `README.md` | 7 KB. "Domino's Digital Twin" — already renamed from Casper's, still 4-location narrative. Describes 4 targets: `default`, `complaints`, `free`, `menus`. |
| `.bundle/`, `.databricks/`, `.claude/`, `.superpowers/` | Local state — not deployed. |

---

## 2. `databricks.yml` structure

### 2.1 Variables

One variable defined at bundle level:

```yaml
variables:
  catalog:
    description: "UC catalog for this bundle/target"
    default: vdm_classic_rikfy0_catalog
```

**No target override for `catalog`** — all four targets write to `vdm_classic_rikfy0_catalog` by default unless a user passes `--params "CATALOG=..."`. Twins reads from this same catalog.

### 2.2 Sync / scripts

- `sync.include: ./*` uploads the entire repo tree to `/Workspace/Users/${username}/caspers-kitchens-demo/`.
- `sync.exclude` omits the CaspersAI terminal app's node_modules/logs/test directories — it's built on the app side.
- `scripts.cleanup` is a shell block that shells out to `databricks jobs submit` to run `destroy.ipynb` via an ephemeral job. This is what `databricks bundle run cleanup` triggers.

### 2.3 Targets

Four targets, each defines exactly one job resource: `resources.jobs.caspers` ("Casper's Initializer"), with `queue.enabled: true` and `performance_target: PERFORMANCE_OPTIMIZED`. No other resources at any target — no pipelines, no apps, no schedules. The job has no schedule; it's triggered by `databricks bundle run caspers`.

#### Target `default` (the primary demo)

Parameters (10):
- `CATALOG = ${var.catalog}`
- `EVENTS_VOLUME = events`
- `LLM_MODEL = databricks-gpt-oss-20b`
- `REFUND_AGENT_ENDPOINT_NAME = ${var.catalog}_refund_agent`
- `SIMULATOR_SCHEMA = simulator`
- `START_DAY = 70`
- `SPEED_MULTIPLIER = 60.0`
- `SCHEDULE_MINUTES = 3`
- `PIPELINE_SCHEDULE_MINUTES = 0` (continuous mode)

Tasks (6), linear chain:
1. `Canonical_Data` → `stages/canonical_data`
2. `Spark_Declarative_Pipeline` → `stages/lakeflow` (depends on #1)
3. `Refund_Recommender_Agent` → `stages/refunder_agent` (depends on #2)
4. `Refund_Recommender_Stream` → `stages/refunder_stream` (depends on #2)
5. `Lakebase_Reverse_ETL` → `stages/lakebase` (depends on #4)
6. `Databricks_App_Refund_Manager` → `stages/apps` (depends on #5)

#### Target `complaints`

Parameters drop refund-agent/speed-related ones, add `COMPLAINT_AGENT_ENDPOINT_NAME = ${var.catalog}_complaint_agent` and `COMPLAINT_RATE = "0.15"`.

Tasks (6):
1. `Canonical_Data`
2. `Spark_Declarative_Pipeline`
3. `Complaint_Agent` → `stages/complaint_agent`
4. `Complaint_Generator_Stream` → `stages/complaint_generator_stream`
5. `Complaint_Agent_Stream` → `stages/complaint_agent_stream` (depends on 3 + 4)
6. `Complaint_Lakebase` → `stages/complaint_lakebase`

#### Target `free`

Minimal. No LLM model, no agent endpoints. `PIPELINE_SCHEDULE_MINUTES: "3"` (triggered mode, not continuous) — because Databricks Free Edition doesn't support serverless continuous pipelines.

Tasks (2): `Canonical_Data`, `Spark_Declarative_Pipeline`. **This is the minimum viable caspers target for twins** — it produces `lakeflow.all_events` + all `simulator.*` dims and nothing else.

#### Target `menus`

Adds three new agent endpoint parameters (`MENU_KNOWLEDGE_ENDPOINT_NAME`, `INSPECTION_KNOWLEDGE_ENDPOINT_NAME`, `MENU_SUPERVISOR_ENDPOINT_NAME`). Nine tasks wired up in a DAG for menu/inspection doc intelligence; all tasks have `max_retries: 0` (explicit opt-out of retry behavior). Does **not** include the Lakeflow pipeline, so `all_events` is NOT produced by this target.

#### Target `all`

The union of `default + complaints + menus` (15 tasks). Adds Menu_Pipeline → DAG dependencies back onto Canonical_Data.

### 2.4 Deployment target differences summary

| Target | Produces `all_events`? | Creates `complaints.raw_complaints`? | Creates `recommender.refund_recommendations`? | Deploys app? |
|---|:-:|:-:|:-:|:-:|
| `default` | Yes | No | Yes | Yes (refund-manager) |
| `complaints` | Yes | Yes | No | No |
| `free` | Yes | No | No | No |
| `menus` | No | No | No | No |
| `all` | Yes | Yes | Yes | Yes |

---

## 3. `lakeflow.all_events` producer

### 3.1 The path

`databricks bundle run caspers -t default` → job task `Spark_Declarative_Pipeline` → `stages/lakeflow.ipynb` → runtime `w.pipelines.create(...)` → DLT pipeline with source glob = `/Workspace/.../pipelines/order_items/**` → pipeline executes `pipelines/order_items/transformations/transformation.py` → `@dlt.table` function `all_events()` materializes `${CATALOG}.lakeflow.all_events`.

### 3.2 The pipeline creation code

From `stages/lakeflow.ipynb`, cell 3:

```python
pipeline_config = dict(
    catalog=CATALOG,
    schema='lakeflow',
    continuous=continuous_mode,
    name=PIPELINE_NAME,
    serverless=True,
    configuration={
        "RAW_DATA_CATALOG": CATALOG,
        "RAW_DATA_SCHEMA": SIMULATOR_SCHEMA,
        "RAW_DATA_VOLUME": EVENTS_VOLUME,
    },
    root_path=root_dbx_path,
    libraries=[p.PipelineLibrary(glob=p.PathPattern(include=f"{root_dbx_path}/**"))],
)
```

Idempotent via `w.pipelines.list_pipelines(filter=...)` + `w.pipelines.update(...)` on name match. If `PIPELINE_SCHEDULE_MINUTES > 0`, a secondary job is created that calls `pipeline_task` on the Quartz cron schedule.

### 3.3 The DLT code

From `pipelines/order_items/transformations/transformation.py`:

```python
@dlt.table(comment="Raw JSON events as ingested (one file per event).")
def all_events():
    CATALOG = spark.conf.get("RAW_DATA_CATALOG")
    SCHEMA  = spark.conf.get("RAW_DATA_SCHEMA")
    VOLUME  = spark.conf.get("RAW_DATA_VOLUME")
    return (
        spark.readStream.format("cloudFiles")
             .option("cloudFiles.format", "json")
             .load(f"/Volumes/{CATALOG}/{SCHEMA}/{VOLUME}")
    )
```

This is a **streaming Bronze table** materialized from Auto Loader reads of JSON files in the simulator volume.

The same file also produces `silver_order_items`, `gold_order_header`, `gold_item_sales_day`, `gold_brand_sales_day`, `gold_location_sales_hourly` (all streaming tables, partitioned by order_day/day/hour_ts as appropriate). Silver/gold have watermarks (`withWatermark("order_ts", "3 hours")`).

### 3.4 Upstream — what fills the volume

The JSON files landed in `/Volumes/{CATALOG}/simulator/events` come from a **separate scheduled job** created dynamically by `stages/canonical_data.ipynb`. Cell 9 of that notebook creates a "Canonical Data Replay" job that calls `data/canonical/canonical_generator_simple.ipynb` every `SCHEDULE_MINUTES` (default 3). That notebook reads `./canonical_dataset/events.parquet` (a workspace file), filters by a virtual-time window derived from the watermark, time-shifts timestamps, and writes JSON:

```python
final_df.write.mode("append").json(VOLUME_PATH)
spark.createDataFrame([(str(new_end_seconds),)], ["value"]).write.mode("overwrite").text(WATERMARK_PATH)
```

### 3.5 Update frequency

- **Volume writes**: every `SCHEDULE_MINUTES` minutes (3 by default) — the scheduled job.
- **`all_events` DLT table**: continuous if `PIPELINE_SCHEDULE_MINUTES=0` (default/complaints targets), else triggered every N minutes (free target).

### 3.6 Additional consumers of `all_events`

From grep (`all_events` → 12 files):
- `stages/refunder_agent.ipynb` (cells 3-5): creates UC functions + a view that read `all_events` for delivery-time percentiles.
- `stages/complaint_agent.ipynb`: same pattern.
- `stages/apps.ipynb`: grants SELECT on `lakeflow.all_events` to the refund-manager app service principal.
- `jobs/refund_recommender_stream.ipynb`: `spark.readStream.table(f"{CATALOG}.lakeflow.all_events").filter("event_type = 'delivered'")`.
- `jobs/complaint_generator.ipynb`: same pattern with sampling by `F.rand() < COMPLAINT_RATE`.
- `apps/refund-manager/app/databricks_events.py`: `SELECT ... FROM {CATALOG}.{SCHEMA}.all_events WHERE order_id = :oid`.
- `demos/agent-compare-models/demo_materials/agent-compare-models.ipynb`: demo content.

---

## 4. `simulator.locations` producer

### 4.1 The path

`stages/canonical_data.ipynb` cell 7:

```python
import pandas as pd

spark.createDataFrame(pd.read_parquet("../data/canonical/canonical_dataset/locations.parquet")) \
    .write.mode("overwrite").saveAsTable(f"{CATALOG}.{SIMULATOR_SCHEMA}.locations")
```

This is a **batch overwrite** of the table, every time `canonical_data` runs. There is no `IF NOT EXISTS`, no `MERGE`, no guard. It runs as the first task in the bundle — which means any refund-agent / complaint-agent task that SQL-joins against `simulator.locations` will see fresh data after every bundle run.

### 4.2 The source parquet

`data/canonical/canonical_dataset/locations.parquet` (12 KB, 88 rows):

Columns: `location_id, location_code, name, address, lat, lon, narrative, base_orders_day, growth_rate_daily`

Produced by `data/canonical/generate_dimensions.py` (offline, seeded `np.random.seed(42)`, one generation per commit). The old README describes 4 rows — that is stale documentation from before the Domino's conversion.

### 4.3 Cross-cut

Grep for `simulator.locations` beyond `canonical_data.ipynb`:
- `AGENTS.md:545`: reference in doc/SQL example.
- Used via LEFT JOIN inside `${CATALOG}.ai.get_order_details` and `${CATALOG}.ai.order_delivery_times_per_location_view` — defined in `stages/refunder_agent.ipynb` and `stages/complaint_agent.ipynb`.
- Twins consumes this table directly (known from external context).

No other writer. No streaming source. Single-writer discipline is enforced implicitly (only `canonical_data` stage writes).

### 4.4 Update frequency

One-shot per bundle run. If twins absorbs this, the equivalent loader should run either once at deploy or guarded by `CREATE TABLE IF NOT EXISTS` so it stops clobbering on subsequent twins deploys.

---

## 5. Complaint + refund pipelines

Caspers has **two parallel LLM-driven streams** reading from `all_events`:

### 5.1 `complaints.raw_complaints` producer

Created by `jobs/complaint_generator.ipynb` — scheduled via `stages/complaint_generator_stream.ipynb` (a wrapper that calls `w.jobs.create(name="Complaint Generator Stream", ...)` with cron `0 0/10 * * * ?`).

The stream reads:
```python
spark.readStream
    .table(f"{CATALOG}.lakeflow.all_events")
    .filter("event_type = 'delivered'")
    .filter(F.rand() < COMPLAINT_RATE)
```

Then for each sampled order calls `ai_gen(...)` (Databricks model-serving-backed SQL function) with `LLM_MODEL=databricks-gpt-oss-20b` to generate a synthetic complaint text. Writes with `trigger(availableNow=True)` + checkpoint at `/Volumes/{CATALOG}/complaints/checkpoints/complaint_generator`.

Target schema:
```sql
CREATE TABLE IF NOT EXISTS {CATALOG}.complaints.raw_complaints (
  complaint_id STRING,
  order_id STRING,
  ts TIMESTAMP,
  complaint_category STRING,
  complaint_text STRING,
  generated_by STRING
)
```

### 5.2 `complaints.complaint_responses` (downstream of raw_complaints)

Produced by `jobs/complaint_agent_stream.ipynb` — scheduled via `stages/complaint_agent_stream.ipynb` (cron `0 0/10 * * * ?`).

Reads `{CATALOG}.complaints.raw_complaints`, calls `{CATALOG}_complaint_agent` serving endpoint per row via OpenAI-compatible client, writes responses. CDC enabled (`ALTER TABLE ... SET TBLPROPERTIES (delta.enableChangeDataFeed = true)`).

This table is then synced to Lakebase by `stages/complaint_lakebase.ipynb` as `{CATALOG}.complaints.pg_complaint_responses`, scheduling policy `CONTINUOUS`.

### 5.3 `recommender.refund_recommendations` producer

Created by `jobs/refund_recommender_stream.ipynb` — scheduled via `stages/refunder_stream.ipynb` (cron `0 0/10 * * * ?`).

Reads `spark.readStream.table(f"{CATALOG}.lakeflow.all_events").filter("event_type = 'delivered'")`. Uses `foreachBatch` with manual inference capping (`MAX_INFERENCES_PER_BATCH = 50`) — first run gets fake responses for all rows, subsequent runs call the `{CATALOG}_refund_agent` serving endpoint for the first 50 rows of each batch, fake for the rest.

Target schema:
```sql
CREATE TABLE IF NOT EXISTS {CATALOG}.recommender.refund_recommendations (
  order_id STRING,
  ts TIMESTAMP,
  order_ts TIMESTAMP,
  agent_response STRING
)
```

CDC is enabled (conditional on `SHOW TBLPROPERTIES` check).

### 5.4 Coupling surface — what twins must maintain

The LLM streams depend on:

1. **`{CATALOG}.lakeflow.all_events`** being a streaming-readable Delta table with columns `event_type`, `order_id`, `ts`, plus whatever the agents' downstream functions need (`body`, `location_id`, `sequence`, `event_id`).
2. **`{CATALOG}.simulator.locations`** being present with `location_id` + `name` for the LEFT JOIN in agent SQL functions.
3. **Enough order-level latency diversity** for the refund agent's P50/P75/P99 percentile logic to produce variance — the agent categorizes by comparing actual delivery time against location-level percentiles.
4. **Schema stability** on the `body` JSON — complaint generator uses `order_id` only, refund recommender only reads the `event_type='delivered'` subset, but the refunder_agent's UC functions re-compose an order's full event history from `all_events`.

### 5.5 Serving endpoints (agents themselves)

- `stages/refunder_agent.ipynb` → LangGraph agent registered to UC (`{CATALOG}.ai.refunder`) → deployed via `databricks.agents.deploy(..., endpoint_name=REFUND_AGENT_ENDPOINT_NAME)`. Uses 3 UC functions over `all_events` + `simulator.locations`.
- `stages/complaint_agent.ipynb` → dspy-based `ResponsesAgent`, similar pattern.

These take ~15–20 minutes to deploy, which is why the stream jobs have fake-response fallbacks on failure.

### 5.6 Schedules (every 10 minutes)

All three LLM stream jobs share cron `0 0/10 * * * ?` hardcoded in their wrapper stages. Each uses `trigger(availableNow=True)` so the stream processes all new data since the last checkpoint and exits. **None have `max_concurrent_runs` set** — if one run takes longer than 10 min, the next is queued.

**Particularly important:** `stages/complaint_generator_stream.ipynb` calls `w.jobs.create(...)` unconditionally (no `existing = [jb for jb in w.jobs.list(...)]` idempotency guard like other stages have). Every re-run of that stage creates a new duplicate scheduled job in the workspace.

---

## 6. Relative-path dependency map

Every `../data/...`, `../utils`, and `./...` path reference across `stages/` and `jobs/`:

### 6.1 `../utils` (Python import of uc_state)

Every stage except `refunder_agent`, `complaint_agent`, and a few others (via `sys.path.append('../utils'); from uc_state import add`):

| Path used | Notebooks |
|---|---|
| `sys.path.append('../utils')` | `canonical_data`, `lakeflow`, `refunder_agent`, `refunder_stream`, `menu_data`, `menu_pipeline`, `menu_genie`, `menu_knowledge_agent`, `inspection_data`, `inspection_knowledge_agent`, `menu_supervisor`, `complaint_agent` (multiple cells), `complaint_agent_stream`, `complaint_generator_stream`, `complaint_lakebase`, `lakebase`, `apps`, `raw_data` (dead) |

**18 of 18 stage notebooks import uc_state via relative path.**

### 6.2 `../data/...` (reads into parquet / PDF / JSON assets)

| Path | Consumer |
|---|---|
| `../data/canonical/canonical_dataset/brands.parquet` | `stages/canonical_data.ipynb` |
| `../data/canonical/canonical_dataset/locations.parquet` | `stages/canonical_data.ipynb` |
| `../data/canonical/canonical_dataset/menus.parquet` | `stages/canonical_data.ipynb` |
| `../data/canonical/canonical_dataset/categories.parquet` | `stages/canonical_data.ipynb` |
| `../data/canonical/canonical_dataset/items.parquet` | `stages/canonical_data.ipynb` |
| `../data/canonical/canonical_dataset/brand_locations.parquet` | `stages/canonical_data.ipynb` |
| `../data/canonical/canonical_generator_simple` | `stages/canonical_data.ipynb` (resolves workspace path for the dynamically-created job) |
| `../data/dimensional/brands.parquet` | `stages/raw_data.ipynb` (dead) |
| `../data/dimensional/menus.parquet` | " |
| `../data/dimensional/categories.parquet` | " |
| `../data/dimensional/items.parquet` | " |
| `../data/generator/configs/*.json` | `stages/raw_data.ipynb` (dead) |
| `../data/generator/generator` | `stages/raw_data.ipynb` (dead) |
| `../data/menus/pdfs` | `stages/menu_data.ipynb` |
| `../data/menus/menu_metadata.json` | `stages/menu_data.ipynb` |
| `../data/inspections/pdfs` | `stages/inspection_data.ipynb` |
| `../data/inspections/inspection_metadata.json` | `stages/inspection_data.ipynb` |

### 6.3 `../jobs` (cross-directory workspace path resolution)

| Path | Consumer |
|---|---|
| `../jobs/refund_recommender_stream` | `stages/refunder_stream.ipynb` |
| `../jobs/complaint_generator` | `stages/complaint_generator_stream.ipynb` |
| `../jobs/complaint_agent_stream` | `stages/complaint_agent_stream.ipynb` |

### 6.4 `../pipelines` and `../apps`

| Path | Consumer |
|---|---|
| `../pipelines/order_items` | `stages/lakeflow.ipynb` — `os.path.abspath("../pipelines/order_items")` is the pipeline `root_path` |
| `../apps/refund-manager` | `stages/apps.ipynb` — `os.path.abspath("../apps/refund-manager")` is the app source_code_path |
| `../apps/refund-manager/app.yaml` | `stages/apps.ipynb` — rewrites this file at runtime to inject warehouse_id + catalog env vars |

### 6.5 `./canonical_dataset/` (workspace-file-relative, inside the data dir)

| Path | Consumer |
|---|---|
| `./canonical_dataset/events.parquet` | `data/canonical/canonical_generator_simple.ipynb` |
| `./canonical_dataset/*.parquet` | `data/canonical/canonical_generator.ipynb` (unused), `data/canonical/caspers_data_source.py` (local-test only) |

### 6.6 Watermark / state volume paths

| Path | Producer/consumer |
|---|---|
| `/Volumes/{CATALOG}/simulator/misc/_watermark` | R+W by `canonical_generator_simple` (every 3 min) |
| `/Volumes/{CATALOG}/simulator/misc/_sim_start` | R+W by `canonical_generator_simple` (first-run write only) |
| `/Volumes/{CATALOG}/simulator/events` | W by `canonical_generator_simple`, R by lakeflow pipeline `cloudFiles` |
| `/Volumes/{CATALOG}/complaints/checkpoints/complaint_generator` | W by `jobs/complaint_generator` |
| `/Volumes/{CATALOG}/complaints/checkpoints/complaint_agent_stream` | W by `jobs/complaint_agent_stream` |
| `/Volumes/{CATALOG}/recommender/checkpoints/refundrecommenderstream` | W by `jobs/refund_recommender_stream` |

### 6.7 Observations

- **Every stage and data notebook depends on knowing its own workspace path relative to the repo root.** They use `os.path.abspath("../...")` and then `.replace(DATABRICKS_WORKSPACE_ROOT, "/Workspace")` to normalize. If twins absorbs any of these, the absolute workspace paths must be updated.
- **`../utils` is the most-imported path** (18 notebooks). Absorbing the event stream means either copying `uc_state` into twins or refactoring to track resources via twins' own state system.
- **`canonical_generator_simple.ipynb`'s `./canonical_dataset/` path is intra-directory** — the notebook expects to be deployed alongside the parquet files. If twins pulls just the replay notebook, it must also pull the `canonical_dataset/` folder and preserve the relative layout.

---

## 7. Concurrency + idempotency audit

### 7.1 `write.mode("overwrite")` inventory

| Location | Table | Guarded? | Notes |
|---|---|:-:|---|
| `stages/canonical_data.ipynb` cell 7 (×6) | `{CATALOG}.simulator.{brands,locations,menus,categories,items,brand_locations}` | No | Overwrites every bundle run — dim tables rebuilt from parquet |
| `stages/menu_data.ipynb` | `{CATALOG}.menu_documents.brands_metadata` | No | Menus target only |
| `stages/inspection_data.ipynb` | `{CATALOG}.food_safety.inspections`, `{CATALOG}.food_safety.violations` | No | Menus target only |
| `stages/raw_data.ipynb` (×4) | `{CATALOG}.simulator.{brands,menus,categories,items}` | No | Dead code, but would clobber if enabled |
| `jobs/refund_recommender_stream.ipynb` | `{CATALOG}.recommender.refund_recommendations` | N/A — `append` mode inside `foreachBatch` | Not an overwrite |

**Five live overwrites, none guarded.**

### 7.2 `CREATE OR REPLACE TABLE` inventory

Grep: zero occurrences of `CREATE OR REPLACE TABLE` in the repo outside of `refunder_agent.ipynb` and `complaint_agent.ipynb`, which use `CREATE OR REPLACE FUNCTION` and `CREATE OR REPLACE VIEW` (not tables). Tables are never DROP+RECREATEd — the overwrite-via-saveAsTable is the only form.

### 7.3 Watermark / state files

| Path | Format | Lock? | Rewrite frequency | Risk |
|---|---|:-:|---|---|
| `/Volumes/{CATALOG}/simulator/misc/_watermark` | Plain text (spark.write.text, overwrite) | None | Every 3 min | Concurrent replay runs read same watermark → duplicate event windows → duplicate JSON files → `cloudFiles` re-processes them if they have different paths (UUID-unique names avoid that, but increases DLT throughput cost) |
| `/Volumes/{CATALOG}/simulator/misc/_sim_start` | Plain text | None | Once (first run) | Low — only first run writes |
| Stream checkpoints (3 locations) | Spark streaming checkpoint | Spark's own | Every batch | Managed by Spark — idempotent |

**The watermark is the biggest single concurrency hazard in caspers.** `canonical_generator_simple.ipynb` cell 6 reads the watermark, cell 8 computes a new end-seconds, cell 12 writes events to the volume with event IDs that use `F.expr("uuid()")` (unique), and cell 14 overwrites the watermark. Between read and write, a concurrent run can race.

### 7.4 `max_concurrent_runs` — zero occurrences

Grep `max_concurrent_runs|maxConcurrentRuns` → **no matches** in the entire caspers-kitchens repo. Not set in any job created via SDK, not set in any `databricks.yml` resource. Every Databricks Job ships with the SDK default of 1, which means a second trigger will be **queued** — but if someone manually triggers a run while the scheduled run is active, both will run against the same watermark.

### 7.5 Idempotency in stage notebooks

Stages vary in idempotency discipline:

| Stage | Pattern | Idempotent? |
|---|---|:-:|
| `canonical_data` (scheduled job creation) | `existing = [jb for jb in w.jobs.list(...) if ...]` + `reset` vs `create` | Yes |
| `canonical_data` (dim tables) | `write.mode("overwrite")` | Yes (overwrites same data) |
| `lakeflow` (pipeline creation) | `list_pipelines(filter=...)` + `update` vs `create` | Yes |
| `lakeflow` (scheduler job, if triggered mode) | existing-check + `reset` vs `create` | Yes |
| `refunder_stream` | existing-check + `reset` vs `create` | Yes |
| `complaint_agent_stream` | **`w.jobs.create(...)` unconditional** | **No** — re-running creates duplicate jobs |
| `complaint_generator_stream` | **`w.jobs.create(...)` unconditional** | **No** — re-running creates duplicate jobs |
| `lakebase` | `get_database_instance` try/except + `get` for catalog/table | Yes |
| `complaint_lakebase` | **`create_database_instance(...)` unconditional** with generated `UNIQUE` suffix | **Yes but leaky** — always tries to create, fails if exists, no cleanup of orphans |
| `apps` | `get(APP_NAME)` try/except | Yes |

### 7.6 Single-run assumption

Every cron-scheduled job uses `trigger(availableNow=True)` which processes "all available" data since last checkpoint and exits. Two concurrent runs of the same stream would both see the same "available" data and write duplicates (Spark streaming checkpoints are per-query, not cross-query). The 10-min cron + ~1-2-min typical runtime + default queue settings makes this rare in practice but not impossible.

---

## 8. Table-by-table inventory in shared catalog

Tables caspers creates in `vdm_classic_rikfy0_catalog` (default), by schema:

| Table | Producer (file + cell) | Update frequency | Consumers |
|---|---|---|---|
| **simulator schema (dimension data)** |  |  |  |
| `simulator.brands` | `stages/canonical_data.ipynb` cell 7 | One-shot per bundle run | caspers refunder/complaint agents (implicit), twins (potentially) |
| `simulator.locations` | `stages/canonical_data.ipynb` cell 7 | One-shot per bundle run | **twins (direct)**, caspers refunder_agent (via `order_details` UC function), caspers complaint_agent |
| `simulator.menus` | `stages/canonical_data.ipynb` cell 7 | One-shot per bundle run | caspers agents (implicit) |
| `simulator.categories` | `stages/canonical_data.ipynb` cell 7 | One-shot per bundle run | caspers agents (implicit) |
| `simulator.items` | `stages/canonical_data.ipynb` cell 7 | One-shot per bundle run | caspers agents (implicit) |
| `simulator.brand_locations` | `stages/canonical_data.ipynb` cell 7 | One-shot per bundle run | caspers agents (implicit) |
| **lakeflow schema (DLT output)** |  |  |  |
| `lakeflow.all_events` | `pipelines/order_items/transformations/transformation.py` (DLT) | Streaming, continuous (default) or every N min (free) | **twins (direct)**, caspers refunder_stream, caspers complaint_generator, caspers refund-manager app |
| `lakeflow.silver_order_items` | same pipeline | Streaming | caspers gold tables (DLT), likely twins (unverified) |
| `lakeflow.gold_order_header` | same pipeline | Streaming | caspers dashboards/agents |
| `lakeflow.gold_item_sales_day` | same pipeline | Streaming | caspers dashboards |
| `lakeflow.gold_brand_sales_day` | same pipeline | Streaming | caspers dashboards |
| `lakeflow.gold_location_sales_hourly` | same pipeline | Streaming | caspers dashboards |
| **complaints schema (complaints target)** |  |  |  |
| `complaints.raw_complaints` | `jobs/complaint_generator.ipynb` | Every 10 min, `availableNow=True` | **twins (direct)**, caspers complaint_agent_stream |
| `complaints.complaint_responses` | `jobs/complaint_agent_stream.ipynb` | Every 10 min, `availableNow=True` | caspers complaint_lakebase |
| `complaints.pg_complaint_responses` (UC-synced-table shadow) | `stages/complaint_lakebase.ipynb` | Continuous sync | Lakebase postgres consumers |
| **recommender schema (default target)** |  |  |  |
| `recommender.refund_recommendations` | `jobs/refund_recommender_stream.ipynb` | Every 10 min, `availableNow=True` | **twins (direct)**, caspers lakebase reverse ETL |
| `recommender.pg_recommendations` (UC-synced-table shadow) | `stages/lakebase.ipynb` | Continuous sync | Lakebase postgres consumers |
| **food_safety schema (menus target)** |  |  |  |
| `food_safety.inspections` | `stages/inspection_data.ipynb` | One-shot | menu_pipeline DLT |
| `food_safety.violations` | `stages/inspection_data.ipynb` | One-shot | menu_pipeline DLT |
| **menu_documents schema (menus target)** |  |  |  |
| `menu_documents.brands_metadata` | `stages/menu_data.ipynb` | One-shot | menu_pipeline DLT |
| `menu_documents.bronze_menu_raw` | `pipelines/menu_documents/...` DLT | Bronze DLT | silver |
| `menu_documents.bronze_inspections_raw` | same | Bronze DLT | silver |
| `menu_documents.bronze_violations_raw` | same | Bronze DLT | silver |
| `menu_documents.silver_menu_items` | same | Silver DLT | gold |
| `menu_documents.silver_inspections` | same | Silver DLT | gold |
| `menu_documents.silver_violations` | same | Silver DLT | gold |
| `menu_documents.menu_items` | same | Gold DLT | Genie/KAs |
| `menu_documents.nutritional_info` | same | Gold DLT | Genie/KAs |
| `menu_documents.allergens` | same | Gold DLT | Genie/KAs |
| `menu_documents.brand_nutrition_summary` | same | Gold DLT | Genie/KAs |
| `menu_documents.inspection_details` | same | Gold DLT | Genie/KAs |
| `menu_documents.violation_analysis` | same | Gold DLT | Genie/KAs |
| `menu_documents.location_compliance_summary` | same | Gold DLT | Genie/KAs |
| **ai schema (agent UC functions)** |  |  |  |
| `ai.refunder` (registered model) | `stages/refunder_agent.ipynb` | Per deploy | refund serving endpoint |
| `ai.get_order_details` (UC function) | `stages/refunder_agent.ipynb` | One-shot | refunder agent tool |
| `ai.get_order_delivery_time` (UC function) | same | One-shot | refunder agent tool |
| `ai.get_location_timings` (UC function) | same | One-shot | refunder agent tool |
| `ai.order_delivery_times_per_location_view` (view) | same | One-shot | UC function |
| Plus analogous `ai.*` functions from complaint_agent | `stages/complaint_agent.ipynb` | One-shot | complaint agent |
| **_internal_state schema (cleanup bookkeeping)** |  |  |  |
| `_internal_state.resources` | `utils/uc_state/state_manager.py` | Per-resource-creation | caspers cleanup (`destroy.ipynb`) |

**Four tables with identified twins consumption: `lakeflow.all_events`, `simulator.locations`, `complaints.raw_complaints`, `recommender.refund_recommendations`.**

---

## Appendix A: Notebooks summary

### `stages/` (18 notebooks)

| Notebook | 1-line summary | Target(s) |
|---|---|---|
| `apps.ipynb` | Deploys `refund-manager` Databricks App; creates serverless 2X-Small warehouse, grants CATALOG/SCHEMA/TABLE privileges to the app SP, deletes+recreates app's pg role. | default, all |
| `canonical_data.ipynb` | **Seeds simulator dim tables from parquet** (`overwrite`); creates the 3-minute `canonical_data_replay` scheduled job that runs `canonical_generator_simple`. | default, complaints, free, menus, all |
| `complaint_agent.ipynb` | Creates UC functions + builds dspy-based ResponsesAgent, logs to UC, deploys to `_complaint_agent` serving endpoint. Heavy LLM code. | complaints, all |
| `complaint_agent_stream.ipynb` | Wrapper: creates scheduled job (`0 0/10 * * * ?`) running `jobs/complaint_agent_stream`. **Non-idempotent.** | complaints, all |
| `complaint_generator_stream.ipynb` | Wrapper: creates scheduled job running `jobs/complaint_generator`. **Non-idempotent.** | complaints, all |
| `complaint_lakebase.ipynb` | Creates Lakebase instance `{CATALOG}complaintmanager`, UC-registers its catalog, creates synced table from `complaints.complaint_responses`. | complaints, all |
| `inspection_data.ipynb` | Uploads 12 inspection PDFs to UC Volume, writes `food_safety.{inspections,violations}` tables from metadata JSON. | menus, all |
| `inspection_knowledge_agent.ipynb` | Creates KA over inspection PDFs, registers to `{CATALOG}_inspection_knowledge`. | menus, all |
| `lakebase.ipynb` | Creates Lakebase instance `{CATALOG}refundmanager`, UC-registers catalog, creates synced table from `recommender.refund_recommendations`. | default, all |
| `lakeflow.ipynb` | **Creates the DLT pipeline** for `pipelines/order_items/**` that produces `lakeflow.all_events` + silver + gold. Idempotent. | default, complaints, free, all |
| `menu_data.ipynb` | Uploads 16 menu PDFs to UC Volume, writes `menu_documents.brands_metadata`. | menus, all |
| `menu_genie.ipynb` | Creates Genie space over menu_documents gold tables. | menus, all |
| `menu_knowledge_agent.ipynb` | Creates KA over menu PDFs. | menus, all |
| `menu_pipeline.ipynb` | Creates DLT pipeline that runs `pipelines/menu_documents/**`. | menus, all |
| `menu_supervisor.ipynb` | Creates Multi-Agent Supervisor coordinating menu Genie, menu KA, inspection KA. | menus, all |
| `raw_data.ipynb` | **DEAD CODE.** Old path: seeds simulator from `data/dimensional/`, launches `data/generator/generator.ipynb` as scheduled job per city. No target references. | (none) |
| `refunder_agent.ipynb` | Creates UC functions + LangGraph agent, logs to `{CATALOG}.ai.refunder`, deploys to `_refund_agent` serving endpoint. | default, all |
| `refunder_stream.ipynb` | Wrapper: creates scheduled job running `jobs/refund_recommender_stream`. Idempotent. | default, all |

### `jobs/` (3 notebooks)

| Notebook | 1-line summary |
|---|---|
| `complaint_agent_stream.ipynb` | The actual streaming task: reads `complaints.raw_complaints`, calls complaint_agent endpoint, writes `complaints.complaint_responses`. |
| `complaint_generator.ipynb` | The actual streaming task: reads `lakeflow.all_events` filtered to `delivered`, samples at `COMPLAINT_RATE`, calls `ai_gen()` to generate complaint text, writes `complaints.raw_complaints`. |
| `refund_recommender_stream.ipynb` | The actual streaming task: reads `lakeflow.all_events` filtered to `delivered`, uses `foreachBatch` + inference-capping (50/batch) against refund_agent endpoint, writes `recommender.refund_recommendations`. |

### Root notebooks

| Notebook | 1-line summary |
|---|---|
| `init.ipynb` | Stale bootstrap: creates a "Casper's Initializer" job hard-coded to old 4-location `raw_data` path. Not used by the bundle. |
| `destroy.ipynb` | Cleanup: iterates `uc_state` in strict deletion order, stops+deletes jobs/pipelines/endpoints/apps/KAs/MAS/VS/genie/warehouses/lakebase/experiments. **Preserves catalogs/schemas/tables.** |

### `data/canonical/` notebooks

| Notebook | 1-line summary |
|---|---|
| `canonical_generator_simple.ipynb` | **The live replay engine.** Reads `./canonical_dataset/events.parquet`, applies virtual-time window via watermark, time-shifts timestamps, transforms to 8 event-type JSON shapes, appends to simulator events volume. |
| `canonical_generator.ipynb` | Rich version using custom `CaspersDataSource` PySpark streaming source. Unused by bundle. |
| `data/generator/generator.ipynb` | Original long-running order-stream generator. Unused by bundle. |

---

## Appendix B: Open questions

1. **Stale `init.ipynb`** — why does it still exist? Is it intentionally kept as a bootstrap for workspaces that lack DABs? Documentation doesn't mention it; `README.md` only describes `databricks bundle` commands.
2. **`canonical_generator.ipynb` vs `canonical_generator_simple.ipynb`** — the rich version with custom data source is never scheduled. It's unclear whether it's aspirational (future live replacement) or historical (earlier attempt). The "simple" one is what runs.
3. **`orders.parquet` (14 MB, 75K rows)** — present in `canonical_dataset/` but not referenced by any notebook. Appears to be a debugging artifact; not loaded into any simulator table.
4. **`demos/` contents not audited** — the four demo subdirectories (`agent-compare-models`, `caspers-demo-template`, `knowledge-assistant-codebase`, `multi-agent-supervisor`) were out of scope. May contain additional consumers of `lakeflow.all_events` or `simulator.locations`, or additional notebook-to-notebook dependencies.
5. **`apps/caspersai-terminal` app** — the top-level `app.yaml` deploys this, but nothing in `databricks.yml` or the stage notebooks deploys it. Its full relationship to the bundle lifecycle is unclear (may be a separate `databricks apps deploy` step).
6. **CDC enablement on `recommender.refund_recommendations` but not `complaints.raw_complaints`** — inconsistent. The synced-table downstream of `complaints.raw_complaints` works because `complaints.complaint_responses` (the intermediate table) has CDC enabled, but the raw table does not.
7. **No clear answer to "what does the menus target expect to run against"** — it does not include the Lakeflow pipeline, so if run standalone, `lakeflow.all_events` won't exist. The menu pipeline transformations reference `food_safety.*` and `menu_documents.*` tables only, so this might be intentional — but any downstream twins integration with menus-target outputs would need to be explicit.
8. **`storage_catalog`/`storage_schema` hardcoded in synced-table specs** — both `stages/lakebase.ipynb` and `stages/complaint_lakebase.ipynb` use literal strings `"storage_catalog"` / `"storage_schema"` for `NewPipelineSpec`. Unclear if these are real catalogs that must exist or typos/placeholders that the SDK interprets specially.
9. **Watermark format concern** — the watermark is stored as a Spark-written plain text file. Why not JSON or Delta? A Delta-backed watermark would enable `MERGE`-style atomic updates.

---

## Recommendations for Phase 1 spec

Given this audit, the realistic Phase 1 scope for absorbing caspers' event stream into twins:

### What to absorb (must live in twins)

1. **`canonical_data.ipynb` equivalent** — twins needs a loader that seeds `{catalog}.simulator.{brands,locations,menus,categories,items,brand_locations}` from parquet.
   - Copy `data/canonical/canonical_dataset/*.parquet` (ex. `events.parquet` — see #2) into twins.
   - Replace `write.mode("overwrite")` with `CREATE TABLE IF NOT EXISTS` + `MERGE` pattern, or guard with a "first deploy only" flag, to avoid clobbering on every deploy.
   - Preserve the locations.parquet schema exactly (9 columns, 88 rows) — twins consumers rely on `location_id`, `name`, `lat`, `lon`.

2. **`canonical_generator_simple.ipynb` equivalent** — twins needs the replay engine that writes JSON events to the volume.
   - Copy `events.parquet` (45 MB) into twins under an equivalent path.
   - **Replace the lockless plain-text watermark with a locked/atomic mechanism** — options: Delta table with `MERGE`, or a single-row Delta table with `VERSION AS OF` CAS, or a Unity Catalog configuration key-value.
   - Set `max_concurrent_runs: 1` on the scheduled job that runs it (must be parameterized).
   - Keep the `SCHEDULE_MINUTES` / `START_DAY` / `SPEED_MULTIPLIER` knobs.

3. **Lakeflow pipeline equivalent** — twins needs to produce `lakeflow.all_events` (or a twins-owned equivalent).
   - Copy `pipelines/order_items/transformations/transformation.py` into twins' pipelines directory.
   - Register it as a first-class DAB resource (`resources.pipelines.*`) rather than creating it dynamically from a notebook — this avoids the "pipeline-creates-itself" pattern and removes dependency on `uc_state` tracking.
   - **Key decision**: does twins keep the table at `{catalog}.lakeflow.all_events` (to preserve caspers' downstream LLM streams' ability to read it) or move it to a twins-owned schema (breaking caspers)? Default: keep the fully-qualified name so caspers' refund_recommender_stream and complaint_generator still work unchanged.

### What to leave in caspers (stay, don't absorb)

1. **Refunder agent + refund_recommender stream** (`recommender.refund_recommendations`) — LLM-driven, caspers-owned. The coupling is: caspers reads `lakeflow.all_events`. As long as twins keeps producing that table at the same FQN, caspers keeps working.
2. **Complaint agent + complaint_generator + complaint_agent stream** (`complaints.raw_complaints`, `complaints.complaint_responses`) — same logic.
3. **Lakebase reverse-ETL stages** (`stages/lakebase.ipynb`, `stages/complaint_lakebase.ipynb`) — caspers' problem, uses caspers' Lakebase instances.
4. **Menus target** — entirely independent.
5. **Refund-manager app** (`apps/refund-manager/`) — caspers demo asset, reads `all_events` via SQL warehouse.

### Decisions the Phase 1 spec will need to make

1. **Schema co-location**: do twins-produced `simulator.*` and `lakeflow.*` live in the same shared catalog (`vdm_classic_rikfy0_catalog`) as caspers expects, or in a twins-owned catalog? If the latter, caspers' every reference to `${CATALOG}.simulator.*` and `${CATALOG}.lakeflow.*` would break unless caspers' `CATALOG` parameter is re-pointed.
2. **Pipeline ownership**: who owns the DLT pipeline resource? If twins creates it, caspers' `stages/lakeflow.ipynb` task must be skipped/removed when deployed against the twins-owned path.
3. **Duplicate dim loaders**: if twins seeds `simulator.locations` and caspers' `canonical_data` also seeds it, deploys race. The spec needs a definitive "single writer" policy — suggest disabling `Canonical_Data` in caspers' `databricks.yml` once twins assumes the role, or replacing caspers' `canonical_data` stage with a no-op notebook that asserts the table exists.
4. **Watermark ownership**: the `_watermark` and `_sim_start` volume files are used by the replay engine. If twins owns the engine, these move to twins' volume. If caspers keeps a fallback engine, the two must not share a volume.
5. **Event schema versioning**: `events.parquet` has a specific schema. The Phase 1 spec should capture the schema contract explicitly so future updates are explicit.
6. **Handling of the 8 event types** — `order_created`, `gk_started`, `gk_finished`, `gk_ready`, `driver_arrived`, `driver_picked_up`, `driver_ping`, `delivered`. The spec should state that twins preserves this set exactly (no new types, no renames) during Phase 1.
7. **Target consolidation**: if twins only needs the `free` target (2 tasks), does the new twins bundle replicate the `default` target's structure, or pick a minimal subset? The simplest is to implement the `free` shape.
8. **State tracking**: twins does not use `uc_state`. Absorbing these notebooks means dropping every `sys.path.append('../utils'); from uc_state import add; add(CATALOG, ...)` call or replacing with twins' equivalent (if any).
9. **Idempotency retrofit**: the absorbed loaders should use `CREATE TABLE IF NOT EXISTS` + `MERGE` rather than `saveAsTable(..., mode="overwrite")`. The spec should require this pattern.
10. **Concurrency retrofit**: every scheduled job the absorbed code creates must set `max_concurrent_runs: 1`. The spec should make this a hard requirement.
