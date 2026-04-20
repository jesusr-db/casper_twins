# Phase 1 — Absorb Caspers Event Datagen Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make twins the sole producer of `vdm_classic_rikfy0_catalog.lakeflow.all_events` and `simulator.*` dimensional tables by absorbing caspers' event generation stack (two notebooks, three generator scripts, one DLT pipeline) as first-class DAB resources in twins.

**Architecture:** Single branch (`feat/phase1-absorb-events`) carrying 5 logical commits (vendor generators, vendor notebooks, new setup/destroy code, DAB config additions, docs). Code lands atomically via one PR. Cutover (table drops + big-bang deploy + job unpause) is a post-merge operational step the user drives.

**Tech Stack:** Databricks Asset Bundles, Unity Catalog (schemas + volumes), Spark Declarative Pipelines (DLT), Python + Jupyter notebooks, Databricks CLI, Databricks Python SDK, asyncpg.

**Spec:** `docs/superpowers/specs/2026-04-20-phase1-absorb-events-design.md`
**Research**: `docs/superpowers/research/2026-04-20-caspers-full-audit.md`

---

## Task 0: Branch state check

**Files:**
- None — verification only

- [ ] **Step 1: Confirm branch + clean tree**

Run: `git branch --show-current && git status -sb`
Expected: branch is `feat/phase1-absorb-events`; only the spec file in `docs/superpowers/specs/` is committed beyond what main holds (plus the audit + investigations in `docs/superpowers/research/`).

If not on the right branch: `git checkout feat/phase1-absorb-events`.

- [ ] **Step 2: Verify caspers source paths are accessible**

Run:
```bash
ls ../caspers-kitchens/data/canonical/generate_dimensions.py \
   ../caspers-kitchens/data/canonical/generate_canonical_dataset.py \
   ../caspers-kitchens/data/canonical/regenerate_all.py \
   ../caspers-kitchens/data/canonical/canonical_generator_simple.ipynb \
   ../caspers-kitchens/stages/canonical_data.ipynb \
   ../caspers-kitchens/pipelines/order_items/transformations/transformation.py
```
Expected: all 6 files exist.

- [ ] **Step 3: Get caspers HEAD SHA (for the header comments in vendored files)**

Run: `git -C ../caspers-kitchens rev-parse HEAD`
Record the SHA. Use in Task 1 and Task 2 header comments.

No commit.

---

## Commit 1 — Vendor generators + DLT pipeline

### Task 1: Copy generator Python scripts

**Files:**
- Create: `datagen/generators/generate_dimensions.py`
- Create: `datagen/generators/generate_canonical_dataset.py`
- Create: `datagen/generators/regenerate_all.py`

- [ ] **Step 1: Create target directory**

Run: `mkdir -p datagen/generators`

- [ ] **Step 2: Copy verbatim**

Run:
```bash
cp ../caspers-kitchens/data/canonical/generate_dimensions.py datagen/generators/
cp ../caspers-kitchens/data/canonical/generate_canonical_dataset.py datagen/generators/
cp ../caspers-kitchens/data/canonical/regenerate_all.py datagen/generators/
```

- [ ] **Step 3: Prepend header comment to `generate_canonical_dataset.py` and `regenerate_all.py` (verbatim copies)**

At the top of each of these two files (before any existing docstring or imports), insert:

```python
# Ported from caspers-kitchens at commit <SHA> on 2026-04-20.
# Caspers is retired — this is now the authoritative copy.
# Modifying this file is a twins-internal decision.
```

Replace `<SHA>` with the caspers HEAD SHA from Task 0 Step 3.

- [ ] **Step 4: Apply the SF-only filter to `generate_dimensions.py`**

This generator will be modified (not verbatim) to implement Decision 8 from the spec: restrict to San Francisco locations only.

Find the block near line 313 that looks like:
```python
locations = generate_locations()
locations.to_parquet(f"{out}/locations.parquet", index=False)
print(f"locations.parquet: {len(locations)} rows")
print(f"  Cities: {locations['location_code'].value_counts().to_dict()}")
```

Replace with:
```python
locations = generate_locations()
# Phase 1 scope: San Francisco locations only (22 rows). Decision 8 in
# docs/superpowers/specs/2026-04-20-phase1-absorb-events-design.md.
# To restore the full 88-location dataset, remove this single filter line.
locations = locations[locations["location_code"] == "sf"].reset_index(drop=True)
locations.to_parquet(f"{out}/locations.parquet", index=False)
print(f"locations.parquet: {len(locations)} rows (SF only)")
print(f"  Cities: {locations['location_code'].value_counts().to_dict()}")
```

`generate_brand_locations(locations_df)` and downstream calls already iterate off the (filtered) locations DataFrame, so the filter propagates automatically to `brand_locations.parquet`. `generate_canonical_dataset.py` reads `locations.parquet` at runtime and only emits events for its contained location_ids — no edit needed there.

- [ ] **Step 5: Prepend the modified-file header comment to `generate_dimensions.py`**

At the top of `datagen/generators/generate_dimensions.py`, insert:

```python
# Ported from caspers-kitchens at commit <SHA> on 2026-04-20, then modified
# to filter to San Francisco locations only (Phase 1 scope decision).
# Caspers is retired — this is now the authoritative copy.
# The filter is a single line after generate_locations() returns;
# the original 88-location behavior is recoverable by removing it.
```

Replace `<SHA>` with the caspers HEAD SHA.

- [ ] **Step 6: Verify each file compiles**

Run:
```bash
python3 -m py_compile datagen/generators/generate_dimensions.py \
                      datagen/generators/generate_canonical_dataset.py \
                      datagen/generators/regenerate_all.py && echo "ok"
```
Expected: `ok`.

- [ ] **Step 7: Smoke-test the generator locally (optional but recommended)**

Run:
```bash
cd datagen/generators && python3 generate_dimensions.py --out-dir /tmp/twins-dim-test && \
python3 -c "
import pandas as pd
df = pd.read_parquet('/tmp/twins-dim-test/locations.parquet')
assert len(df) == 22, f'expected 22 SF rows, got {len(df)}'
assert (df['location_code'] == 'sf').all(), 'non-SF rows present'
print(f'OK: {len(df)} SF locations')
" && cd ../..
```
Expected: `OK: 22 SF locations`. If the generator requires additional args beyond `--out-dir`, adapt per the file's argparse. (This step requires `pandas` + `numpy` locally; skip if you'd prefer to verify only on Databricks.)

No commit yet — commit after Task 3.

---

### Task 2: Copy DLT pipeline transformation

**Files:**
- Create: `pipelines/order_items/transformations/transformation.py`

- [ ] **Step 1: Create target directory**

Run: `mkdir -p pipelines/order_items/transformations`

- [ ] **Step 2: Copy verbatim**

Run:
```bash
cp ../caspers-kitchens/pipelines/order_items/transformations/transformation.py \
   pipelines/order_items/transformations/
```

- [ ] **Step 3: Prepend header comment**

At the top of `pipelines/order_items/transformations/transformation.py`, insert (matching whatever comment style the file uses — Python comments):

```python
# Ported from caspers-kitchens at commit <SHA> on 2026-04-20.
# Caspers is retired — this is now the authoritative copy.
# Modifying this file is a twins-internal decision.
#
# Produces DLT tables in `${RAW_DATA_CATALOG}.lakeflow.*`:
#   - all_events (Bronze, Auto Loader streaming from UC Volume)
#   - silver_order_items, gold_order_header, gold_item_sales_day,
#     gold_brand_sales_day, gold_location_sales_hourly
```

- [ ] **Step 4: Verify file compiles**

Run: `python3 -m py_compile pipelines/order_items/transformations/transformation.py && echo "ok"`
Expected: `ok`.

No commit yet.

---

### Task 3: Commit 1 — vendor generators + DLT pipeline

**Files:**
- None — commits the work of Tasks 1–2

- [ ] **Step 1: Stage**

Run: `git add datagen/generators/ pipelines/order_items/`

- [ ] **Step 2: Confirm**

Run: `git status -sb`
Expected: 3 new files under `datagen/generators/`, 1 under `pipelines/order_items/transformations/`.

- [ ] **Step 3: Commit**

Run:
```bash
git commit -m "$(cat <<'EOF'
feat(datagen): vendor caspers generators + DLT pipeline (SF-only)

Adds three Python generators:
  - datagen/generators/generate_dimensions.py (MODIFIED: SF-only filter)
  - datagen/generators/generate_canonical_dataset.py (verbatim)
  - datagen/generators/regenerate_all.py (wrapper, verbatim)

And the DLT pipeline code that produces lakeflow.all_events + silver/gold
aggregates from the events UC Volume:
  - pipelines/order_items/transformations/transformation.py

Phase 1 scope is San Francisco locations only (Decision 8 in the spec);
generate_dimensions.py carries a one-line filter after generate_locations()
restricting output to location_code='sf' (22 rows). generate_canonical_dataset.py
reads the filtered locations.parquet at runtime and emits events only for
those SF stores — ~250K events vs ~1M in the original 88-location dataset.

All files carry headers naming the caspers source SHA. Caspers is retired
per 2026-04-20 user decision; these are now the authoritative copies.

Part of Phase 1 event datagen absorption (spec:
docs/superpowers/specs/2026-04-20-phase1-absorb-events-design.md).

Co-authored-by: Isaac
EOF
)"
```

---

## Commit 2 — Vendor live-path notebooks

### Task 4: Copy `canonical_data.ipynb`

**Files:**
- Create: `datagen/canonical_data.ipynb`

- [ ] **Step 1: Copy verbatim**

Run: `cp ../caspers-kitchens/stages/canonical_data.ipynb datagen/`

- [ ] **Step 2: Prepend header comment in the first cell**

Open `datagen/canonical_data.ipynb` in an editor or use Python JSON manipulation:

```bash
python3 <<'PY'
import json
path = "datagen/canonical_data.ipynb"
with open(path) as f: nb = json.load(f)
header_cell = {
    "cell_type": "markdown",
    "metadata": {},
    "source": [
        "# canonical_data — one-shot seeder\n",
        "\n",
        "Ported from `caspers-kitchens/stages/canonical_data.ipynb` at commit <SHA> on 2026-04-20.\n",
        "Caspers is retired — this is now the authoritative copy.\n",
        "\n",
        "**Invoked by**: `setup-lakebase` job, `canonical_data` task (after `bootstrap_datagen`)."
    ]
}
nb["cells"].insert(0, header_cell)
with open(path, "w") as f: json.dump(nb, f, indent=1)
PY
```

Replace `<SHA>` with the caspers HEAD SHA from Task 0.

- [ ] **Step 3: Verify notebook is still valid JSON**

Run: `python3 -c "import json; json.load(open('datagen/canonical_data.ipynb')); print('ok')"`
Expected: `ok`.

No commit yet.

---

### Task 5: Copy `canonical_generator_simple.ipynb`

**Files:**
- Create: `datagen/canonical_generator_simple.ipynb`

- [ ] **Step 1: Copy verbatim**

Run: `cp ../caspers-kitchens/data/canonical/canonical_generator_simple.ipynb datagen/`

- [ ] **Step 2: Prepend header cell**

Run:
```bash
python3 <<'PY'
import json
path = "datagen/canonical_generator_simple.ipynb"
with open(path) as f: nb = json.load(f)
header_cell = {
    "cell_type": "markdown",
    "metadata": {},
    "source": [
        "# canonical_generator_simple — 3-minute replay engine\n",
        "\n",
        "Ported from `caspers-kitchens/data/canonical/canonical_generator_simple.ipynb` at commit <SHA> on 2026-04-20.\n",
        "Caspers is retired — this is now the authoritative copy.\n",
        "\n",
        "**Invoked by**: `twins-datagen-replay` scheduled job (every 3 min, `max_concurrent_runs: 1`).\n",
        "\n",
        "**Reads**: `/Volumes/{CATALOG}/{SCHEMA}/canonical_seed/events.parquet` + watermark file.\n",
        "**Writes**: JSON batches to `/Volumes/{CATALOG}/{SCHEMA}/{VOLUME}/` + advances watermark."
    ]
}
nb["cells"].insert(0, header_cell)
with open(path, "w") as f: json.dump(nb, f, indent=1)
PY
```

Replace `<SHA>` with the caspers HEAD SHA.

- [ ] **Step 3: Verify**

Run: `python3 -c "import json; json.load(open('datagen/canonical_generator_simple.ipynb')); print('ok')"`
Expected: `ok`.

---

### Task 6: Commit 2 — vendor notebooks

**Files:**
- None — commits Tasks 4–5

- [ ] **Step 1: Stage**

Run: `git add datagen/canonical_data.ipynb datagen/canonical_generator_simple.ipynb`

- [ ] **Step 2: Commit**

Run:
```bash
git commit -m "$(cat <<'EOF'
feat(datagen): vendor canonical_data + canonical_generator_simple notebooks

Copied verbatim from caspers-kitchens with header cells added naming the
source SHA:
  - datagen/canonical_data.ipynb (one-shot seeder; runs in setup-lakebase)
  - datagen/canonical_generator_simple.ipynb (3-min replay engine; scheduled)

Both notebooks inherit their existing env-var contracts (CATALOG, SCHEMA,
VOLUME, SCHEDULE_MINUTES, SPEED_MULTIPLIER, START_DAY). They will be
invoked from databricks.yml with base_parameters supplying these values.

Part of Phase 1 event datagen absorption.

Co-authored-by: Isaac
EOF
)"
```

---

## Commit 3 — New setup/bootstrap + updated destroy

### Task 7: Create `setup/bootstrap_datagen.py`

**Files:**
- Create: `setup/bootstrap_datagen.py`

- [ ] **Step 1: Write the file**

Create `setup/bootstrap_datagen.py` with:

```python
"""Task 0 — Generate seed data (events.parquet + dim parquets) into a UC Volume.

Runs ahead of canonical_data.ipynb. Idempotent via a marker file.

Invoked by setup-lakebase job, bootstrap_datagen task.
"""

import logging
import os
import shutil
import subprocess
import sys
from pathlib import Path

from databricks.sdk import WorkspaceClient

logging.basicConfig(level=logging.INFO, format="%(asctime)s [%(levelname)s] %(message)s")
log = logging.getLogger("bootstrap_datagen")

CATALOG = "vdm_classic_rikfy0_catalog"
SCHEMA = "simulator"
SEED_VOLUME = "canonical_seed"
SEED_VOLUME_PATH = f"/Volumes/{CATALOG}/{SCHEMA}/{SEED_VOLUME}"
MARKER_PATH = f"{SEED_VOLUME_PATH}/.seed-complete"

# Generators live at /Workspace/.../files/datagen/generators/ when the bundle
# is deployed. Resolve from the repo root (which is sys.path[0] when the task
# runs the python file).
REPO_ROOT = Path(__file__).resolve().parent.parent
GENERATORS_DIR = REPO_ROOT / "datagen" / "generators"


def marker_exists() -> bool:
    """Check the idempotency marker via the Files API."""
    w = WorkspaceClient()
    try:
        w.files.get_metadata(MARKER_PATH)
        return True
    except Exception:
        return False


def write_marker() -> None:
    """Write the idempotency marker to the volume."""
    w = WorkspaceClient()
    w.files.upload(MARKER_PATH, io=b"complete\n", overwrite=True)
    log.info("Marker written: %s", MARKER_PATH)


def main() -> None:
    log.info("=" * 60)
    log.info("bootstrap_datagen — seed data generation")
    log.info("=" * 60)

    if marker_exists():
        log.info("Marker %s present — skipping (idempotent).", MARKER_PATH)
        return

    log.info("No marker found; generating seed data...")
    log.info("Running: %s", GENERATORS_DIR / "regenerate_all.py")

    result = subprocess.run(
        [sys.executable, str(GENERATORS_DIR / "regenerate_all.py"),
         "--out-dir", SEED_VOLUME_PATH],
        check=False,
        capture_output=True,
        text=True,
    )
    if result.returncode != 0:
        log.error("Generator failed (exit %d):\nstdout: %s\nstderr: %s",
                  result.returncode, result.stdout, result.stderr)
        raise RuntimeError("regenerate_all.py failed")

    log.info("Generator succeeded. stdout tail:\n%s", result.stdout[-2000:])
    write_marker()
    log.info("bootstrap_datagen complete.")


if __name__ == "__main__":
    main()
```

- [ ] **Step 2: Verify syntax**

Run: `python3 -m py_compile setup/bootstrap_datagen.py && echo "ok"`
Expected: `ok`.

No commit yet.

---

### Task 8: Update `setup/trigger_pipeline.py` to also trigger the new DLT pipeline

**Files:**
- Modify: `setup/trigger_pipeline.py`

- [ ] **Step 1: Read the current file**

Run: `cat setup/trigger_pipeline.py`

It currently triggers `twins-orders-enriched`. After Phase 1, it must also trigger `twins-order-items`.

- [ ] **Step 2: Update to trigger both pipelines**

Minimal edit: change `PIPELINE_NAMES` to a list (or add a second trigger call).

If the file has a single `PIPELINE_NAME` constant, refactor:

```python
# Before (illustrative):
PIPELINE_NAME = "twins-orders-enriched"
# ...
pipeline = find_pipeline_by_name(w, PIPELINE_NAME)
w.pipelines.start_update(pipeline.pipeline_id)

# After:
PIPELINE_NAMES = ["twins-orders-enriched", "twins-order-items"]
# ...
for name in PIPELINE_NAMES:
    pipeline = find_pipeline_by_name(w, name)
    if pipeline is None:
        log.warning("Pipeline not found: %s — skipping", name)
        continue
    log.info("Triggering pipeline: %s", name)
    w.pipelines.start_update(pipeline.pipeline_id)
```

The exact code depends on the existing `trigger_pipeline.py` shape — read the file and adapt. Keep the existing error-handling style. Skip `twins-order-items` gracefully if it's not yet deployed (first-ever deploy won't have it until `bundle deploy` lands).

- [ ] **Step 3: Verify syntax**

Run: `python3 -m py_compile setup/trigger_pipeline.py && echo "ok"`
Expected: `ok`.

No commit yet.

---

### Task 9: Update `setup/destroy_lakebase.py`

**Files:**
- Modify: `setup/destroy_lakebase.py`

- [ ] **Step 1: Read the current file**

Run: `cat setup/destroy_lakebase.py`

You'll see config, a `_safe(fn, desc)` helper, and `main()` with Step 1 (synced tables), Step 2 (Lakebase instance), Step 3 (DLT tables).

- [ ] **Step 2: Add new constants after the existing `DLT_TABLES` list**

After the `DLT_TABLES = [...]` list, add:

```python
# Twins-owned base tables produced by the absorbed DLT pipeline (Phase 1).
ABSORBED_DLT_TABLES = [
    f"{SOURCE_CATALOG}.lakeflow.all_events",
    f"{SOURCE_CATALOG}.lakeflow.silver_order_items",
    f"{SOURCE_CATALOG}.lakeflow.gold_order_header",
    f"{SOURCE_CATALOG}.lakeflow.gold_item_sales_day",
    f"{SOURCE_CATALOG}.lakeflow.gold_brand_sales_day",
    f"{SOURCE_CATALOG}.lakeflow.gold_location_sales_hourly",
]

# Twins-owned dim tables seeded by canonical_data (Phase 1).
ABSORBED_DIM_TABLES = [
    f"{SOURCE_CATALOG}.simulator.brands",
    f"{SOURCE_CATALOG}.simulator.locations",
    f"{SOURCE_CATALOG}.simulator.menus",
    f"{SOURCE_CATALOG}.simulator.categories",
    f"{SOURCE_CATALOG}.simulator.items",
    f"{SOURCE_CATALOG}.simulator.brand_locations",
]

# Scheduled job that must be paused before drops to avoid races.
DATAGEN_REPLAY_JOB_NAME = "twins-datagen-replay"
```

- [ ] **Step 3: Add a `_pause_replay_job` helper**

Right after the `_safe` helper:

```python
def _pause_replay_job(w: WorkspaceClient) -> None:
    """Pause twins-datagen-replay so it can't write during destruction."""
    jobs = list(w.jobs.list(name=DATAGEN_REPLAY_JOB_NAME))
    if not jobs:
        log.info("  Not found (skip): %s", DATAGEN_REPLAY_JOB_NAME)
        return
    for job in jobs:
        try:
            # Pause by setting pause_status in the schedule
            from databricks.sdk.service.jobs import CronSchedule, PauseStatus
            w.jobs.update(
                job_id=job.job_id,
                new_settings={"schedule": CronSchedule(
                    quartz_cron_expression="0 0/3 * * * ?",
                    timezone_id="UTC",
                    pause_status=PauseStatus.PAUSED,
                )},
            )
            log.info("  Paused: %s (job_id=%s)", DATAGEN_REPLAY_JOB_NAME, job.job_id)
        except Exception as e:
            log.warning("  Failed to pause %s: %s", DATAGEN_REPLAY_JOB_NAME, e)
```

(The SDK's exact API may require a slightly different call — verify against `databricks.sdk.service.jobs` documentation during implementation. The goal is to set `pause_status: PAUSED` on the existing schedule.)

- [ ] **Step 4: Update `main()` to add pre-step and post-steps**

Modify `main()` so the sequence becomes:

```python
def main():
    log.info("=" * 60)
    log.info("Digital Twins — Lakebase Destroy")
    log.info("=" * 60)

    w = WorkspaceClient()

    # ── Step 0: Pause datagen replay job (Phase 1 addition) ────────────────
    log.info("Step 0: Pausing twins-datagen-replay...")
    _pause_replay_job(w)

    # ── Step 1: Delete synced tables ──────────────────────────────────────
    log.info("Step 1: Deleting synced tables...")
    for name in SYNCED_TABLES:
        _safe(lambda n=name: w.database.delete_synced_database_table(n), name)

    # ── Step 2: Delete Lakebase instance ──────────────────────────────────
    log.info("Step 2: Deleting Lakebase instance '%s'...", INSTANCE_NAME)
    _safe(lambda: w.database.delete_database_instance(INSTANCE_NAME), INSTANCE_NAME)

    # ── Step 3: Drop twins-owned DLT tables from twins-orders-enriched ────
    log.info("Step 3: Dropping twins-orders-enriched DLT tables...")
    for table_name in DLT_TABLES:
        _safe(lambda t=table_name: w.tables.delete(t), table_name)

    # ── Step 4: Drop absorbed DLT tables from twins-order-items (Phase 1) ─
    log.info("Step 4: Dropping twins-order-items DLT tables...")
    for table_name in ABSORBED_DLT_TABLES:
        _safe(lambda t=table_name: w.tables.delete(t), table_name)

    # ── Step 5: Drop absorbed dim tables (Phase 1) ────────────────────────
    log.info("Step 5: Dropping absorbed simulator dim tables...")
    for table_name in ABSORBED_DIM_TABLES:
        _safe(lambda t=table_name: w.tables.delete(t), table_name)

    log.info("=" * 60)
    log.info("Destroy complete. DAB-managed resources (pipelines, jobs, volumes,")
    log.info("schemas, app) are removed separately via `databricks bundle destroy`.")
    log.info("=" * 60)
```

- [ ] **Step 5: Update the file's header docstring**

Replace the docstring at the top with:

```python
"""
Digital Twins — Lakebase Infrastructure Destroy Job

Tears down all twins-owned resources not managed by DAB:
  0. Pause twins-datagen-replay scheduler (so it can't write during drops)
  1. Delete synced tables (stops sync pipelines, drops UC registrations)
  2. Delete Lakebase Provisioned instance (twins) — drops all Postgres data
  3. Drop twins-orders-enriched DLT tables
  4. Drop twins-order-items DLT tables (Phase 1 addition)
  5. Drop absorbed simulator dim tables (Phase 1 addition)

Does NOT touch:
  - DAB-managed resources (app, pipelines, jobs, schemas, volumes) — use
    `databricks bundle destroy` for those.
  - Caspers-owned schemas (complaints, recommender, food_safety, menu_documents).

Idempotent — safe to re-run. Skips resources that don't exist.

Deployed via databricks.yml as: twins-destroy-lakebase job.
"""
```

- [ ] **Step 6: Verify syntax**

Run: `python3 -m py_compile setup/destroy_lakebase.py && echo "ok"`
Expected: `ok`.

---

### Task 10: Commit 3 — new setup/bootstrap + updated destroy + trigger_pipeline

**Files:**
- None — commits Tasks 7–9

- [ ] **Step 1: Stage**

Run: `git add setup/bootstrap_datagen.py setup/destroy_lakebase.py setup/trigger_pipeline.py`

- [ ] **Step 2: Commit**

Run:
```bash
git commit -m "$(cat <<'EOF'
feat(setup): bootstrap_datagen task + extended destroy + multi-pipeline trigger

Adds setup/bootstrap_datagen.py — one-shot idempotent seed-data generator.
Runs datagen/generators/regenerate_all.py into /Volumes/.../canonical_seed/
on first invocation; subsequent runs skip via a .seed-complete marker.

Extends setup/destroy_lakebase.py to:
  - Pause twins-datagen-replay before drops (new Step 0)
  - Drop twins-order-items DLT tables (new Step 4)
  - Drop absorbed simulator dim tables (new Step 5)

Updates setup/trigger_pipeline.py to also trigger twins-order-items (in
addition to twins-orders-enriched). Both triggers are graceful-skip if the
pipeline doesn't exist yet.

Part of Phase 1 event datagen absorption.

Co-authored-by: Isaac
EOF
)"
```

---

## Commit 4 — DAB configuration

### Task 11: Add `catalog` variable + schemas + volumes + pipeline + datagen-replay job to `databricks.yml`

**Files:**
- Modify: `databricks.yml`

- [ ] **Step 1: Read the current file**

Run: `cat databricks.yml`

Note the existing structure: `bundle`, `workspace`, `resources` (with `apps`, `pipelines`, `jobs`), and `sync`.

- [ ] **Step 2: Add the `catalog` variable at top level**

Near the top, before `resources`, add:

```yaml
variables:
  catalog:
    description: "UC catalog for twins data"
    default: vdm_classic_rikfy0_catalog
```

- [ ] **Step 3: Add `schemas` and `volumes` resources under `resources:`**

Under the `resources:` block, add (after `apps:` and before or alongside `pipelines:`):

```yaml
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
      comment: "JSON event files; consumed by twins-order-items DLT pipeline"
    simulator_canonical_seed:
      catalog_name: ${var.catalog}
      schema_name: simulator
      name: canonical_seed
      comment: "Generator output (events.parquet + dim parquets); filled by bootstrap_datagen"
```

- [ ] **Step 4: Add the `twins-order-items` pipeline under `resources.pipelines`**

Inside the existing `pipelines:` block (alongside `orders-enriched`), add:

```yaml
    order-items:
      name: "twins-order-items"
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
```

- [ ] **Step 5: Add the `datagen-replay` job under `resources.jobs`**

Inside the existing `jobs:` block (alongside `setup-lakebase` and `destroy-lakebase`), add:

```yaml
    datagen-replay:
      name: "twins-datagen-replay"
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

- [ ] **Step 6: Update `setup-lakebase` task graph**

Inside `resources.jobs.setup-lakebase.tasks`, prepend two tasks so the chain starts with `bootstrap_datagen` → `canonical_data` → (existing `trigger_pipeline`).

Find the existing first task (`trigger_pipeline` with no `depends_on`). Insert before it:

```yaml
        - task_key: bootstrap_datagen
          spark_python_task:
            python_file: setup/bootstrap_datagen.py
          environment_key: setup_env
        - task_key: canonical_data
          depends_on:
            - task_key: bootstrap_datagen
          notebook_task:
            notebook_path: ${workspace.root_path}/datagen/canonical_data
            base_parameters:
              CATALOG: ${var.catalog}
              SIMULATOR_SCHEMA: simulator
              EVENTS_VOLUME: events
              SEED_DIR: /Volumes/vdm_classic_rikfy0_catalog/simulator/canonical_seed
              START_DAY: "70"
              SPEED_MULTIPLIER: "60.0"
```

Then update `trigger_pipeline` to depend on `canonical_data`:

```yaml
        - task_key: trigger_pipeline
          depends_on:
            - task_key: canonical_data
          spark_python_task:
            python_file: setup/trigger_pipeline.py
          environment_key: setup_env
```

- [ ] **Step 7: Add `datagen/**` and `pipelines/order_items/**` to sync.include**

Under the bottom-level `sync:` block, update `include:`:

```yaml
sync:
  include:
    - "pipelines/**"
    - "backend/**"
    - "frontend/dist/**"
    - "setup/**"
    - "datagen/**"                 # NEW
    - "app.yaml"
    - "requirements.txt"
```

(`pipelines/**` glob already covers `pipelines/order_items/`.)

- [ ] **Step 8: Validate bundle**

Run: `databricks bundle validate -p DEFAULT`
Expected: no errors. If errors reference the catalog variable or resource structure, fix inline.

---

### Task 12: Commit 4 — DAB configuration

**Files:**
- None — commits Task 11

- [ ] **Step 1: Stage**

Run: `git add databricks.yml`

- [ ] **Step 2: Commit**

Run:
```bash
git commit -m "$(cat <<'EOF'
feat(dab): schemas, volumes, pipeline, datagen-replay job + setup-lakebase updates

databricks.yml additions:
  - Variables: catalog (default vdm_classic_rikfy0_catalog)
  - Schemas: simulator, lakeflow (bundle-tracked ownership)
  - Volumes: simulator.events, simulator.canonical_seed
  - Pipelines: twins-order-items (serverless continuous DLT)
  - Jobs: twins-datagen-replay (every 3 min, max_concurrent_runs: 1, PAUSED)

setup-lakebase task graph gains two new front tasks:
  bootstrap_datagen → canonical_data → trigger_pipeline → ...

sync.include picks up datagen/ for notebook/script uploads.

twins-datagen-replay lands PAUSED so it does not race with the canonical_data
setup task. Unpause after first successful setup run — tracked in the
cutover runbook in the PR description.

Part of Phase 1 event datagen absorption.

Co-authored-by: Isaac
EOF
)"
```

---

## Commit 5 — Docs

### Task 13: Update `CLAUDE.md`

**Files:**
- Modify: `CLAUDE.md`

- [ ] **Step 1: Read the current `Pipeline & DAB` section**

Run: `grep -n "^## \|Pipeline & DAB" CLAUDE.md | head -20`

- [ ] **Step 2: Add a new subsection paragraph**

Under `## Pipeline & DAB`, append a new bullet at the end:

```markdown
- **As of 2026-04-20, twins owns event generation.** Caspers-kitchens is retired; `lakeflow.all_events` + `simulator.*` dim tables are now produced by twins' own DAB-declared `twins-order-items` DLT pipeline (source: `pipelines/order_items/transformations/transformation.py`) and scheduled `twins-datagen-replay` job (source: `datagen/canonical_generator_simple.ipynb`). Seed data is regenerated on first setup by `setup/bootstrap_datagen.py` (idempotent via `.seed-complete` marker in `/Volumes/.../simulator/canonical_seed/`). Watermark race is prevented by `max_concurrent_runs: 1` on the scheduled job.
```

- [ ] **Step 3: Verify**

Run: `grep -A2 "twins owns event" CLAUDE.md`
Expected: the new paragraph is present.

---

### Task 14: Update `docs/roadmap-handoff.md` — mark B3 complete

**Files:**
- Modify: `docs/roadmap-handoff.md`

- [ ] **Step 1: Find the B3 section**

Run: `grep -n "^### B3" docs/roadmap-handoff.md`

- [ ] **Step 2: Update the heading to mark complete**

Change the heading from:
```
### B3 — Absorb caspers-kitchens **event datagen** into twins DAB
```
to:
```
### B3 — Absorb caspers-kitchens event datagen into twins DAB ✅ Complete 2026-04-20
```

(Drop the bold asterisks on "event datagen" for consistency with other completed backlog items; append the completion marker.)

- [ ] **Step 3: Add a completion note at the top of the B3 body**

Immediately after the `**Priority**` and `**Effort**` lines, add:

```markdown

**Completed 2026-04-20**: Phase 0 (`scripts/deploy.sh`) + Phase 1 (full event datagen absorption). Twins is now self-contained; caspers is retired. See `docs/superpowers/specs/2026-04-20-phase1-absorb-events-design.md` for the full absorption spec and `docs/superpowers/research/2026-04-20-caspers-full-audit.md` for the underlying research.

```

Leave the original "What's wrong today" / "Phase 0" / "Phase 1" bodies in place as historical record.

---

### Task 15: Commit 5 — docs

**Files:**
- None — commits Tasks 13–14

- [ ] **Step 1: Stage**

Run: `git add CLAUDE.md docs/roadmap-handoff.md`

- [ ] **Step 2: Commit**

Run:
```bash
git commit -m "$(cat <<'EOF'
docs: CLAUDE.md + roadmap-handoff.md updates for Phase 1 completion

CLAUDE.md: adds a paragraph under Pipeline & DAB noting that twins owns
event generation as of 2026-04-20, with pointers to the new DLT pipeline,
scheduled replay job, and bootstrap_datagen task.

docs/roadmap-handoff.md: marks B3 complete 2026-04-20 with a brief
completion note pointing at the Phase 1 spec + caspers audit.

Part of Phase 1 event datagen absorption.

Co-authored-by: Isaac
EOF
)"
```

---

## Task 16: Full-repo verification

**Files:**
- None — verification only

- [ ] **Step 1: Check commit chain**

Run: `git log --oneline main..HEAD`

Expected: at least 6 commits (spec + 5 refactor/feat commits from this plan). Something like:
```
<sha> docs: CLAUDE.md + roadmap-handoff.md updates for Phase 1 completion
<sha> feat(dab): schemas, volumes, pipeline, datagen-replay job + setup-lakebase updates
<sha> feat(setup): bootstrap_datagen task + extended destroy + multi-pipeline trigger
<sha> feat(datagen): vendor canonical_data + canonical_generator_simple notebooks
<sha> feat(datagen): vendor caspers generators + DLT pipeline
<sha> docs: Phase 1 (event datagen absorption) design spec
... (plus the earlier audit + investigation commits on this branch)
```

- [ ] **Step 2: DAB bundle validates**

Run: `databricks bundle validate -p DEFAULT`
Expected: no errors.

- [ ] **Step 3: Python files compile**

Run:
```bash
python3 -m py_compile setup/*.py datagen/generators/*.py pipelines/order_items/transformations/transformation.py
echo "ok"
```
Expected: `ok`.

- [ ] **Step 4: Notebook JSON is valid**

Run:
```bash
python3 -c "
import json
for path in ['datagen/canonical_data.ipynb', 'datagen/canonical_generator_simple.ipynb']:
    json.load(open(path))
    print(f'{path}: ok')
"
```
Expected: `ok` for both.

- [ ] **Step 5: Grep for dangling references**

Run: `grep -rn 'caspers-kitchens' datagen/ pipelines/order_items/ setup/bootstrap_datagen.py` (header comments expected; no code-level references).

- [ ] **Step 6: Confirm no pending local changes**

Run: `git status`
Expected: working tree clean.

No commit.

---

## Task 17: Push branch + open PR (user-gated)

**Files:**
- None — git / GitHub operation

- [ ] **Step 1: Confirm with user**

**DO NOT push without explicit user approval.** Phase 1 has real deploy/cutover implications. Ask: "All 5 commits built and verified. Ready to push `feat/phase1-absorb-events` and open the PR?"

- [ ] **Step 2: Push the branch (if approved)**

Run: `git push -u origin HEAD`

- [ ] **Step 3: Open the PR with gh CLI (if approved)**

Run:
```bash
gh pr create --title "feat: absorb caspers event datagen into twins (Phase 1)" --body "$(cat <<'EOF'
## Summary

Makes twins the sole producer of `lakeflow.all_events` and `simulator.*` dimensional tables by absorbing caspers' event generation stack and retiring caspers. Fully self-contained twins; no cross-bundle dependency remains.

**Spec:** `docs/superpowers/specs/2026-04-20-phase1-absorb-events-design.md`
**Research:** `docs/superpowers/research/2026-04-20-caspers-full-audit.md`

## Changes

- **datagen/**: 2 `.ipynb` (live-path notebooks) + 3 `.py` generators, all ported verbatim from caspers with header comments.
- **pipelines/order_items/transformations/transformation.py**: DLT code ported from caspers.
- **setup/bootstrap_datagen.py**: new idempotent one-shot to regenerate seed parquets on first setup.
- **setup/destroy_lakebase.py**: extended to pause replay job + drop Phase-1 tables + volumes.
- **setup/trigger_pipeline.py**: also triggers `twins-order-items` (in addition to `twins-orders-enriched`).
- **databricks.yml**: new `catalog` variable, 2 schema resources, 2 volume resources, 1 pipeline resource (`twins-order-items`), 1 scheduled job (`twins-datagen-replay`, lands PAUSED), updated `setup-lakebase` task graph.
- **CLAUDE.md** + **docs/roadmap-handoff.md**: note Phase 1 completion.

## Cutover runbook (execute AFTER merging this PR)

1. **Pre-flight**
   - Backup: `CREATE TABLE vdm_classic_rikfy0_catalog.default.all_events_backup_2026_04_20 AS SELECT * FROM vdm_classic_rikfy0_catalog.lakeflow.all_events WHERE ts >= current_timestamp() - INTERVAL 24 HOURS;`
   - Check caspers dormancy: `databricks pipelines list -p DEFAULT | grep -iE "caspers|spark_declarative"`; `databricks jobs list -p DEFAULT | grep -iE "canonical_data|caspers"`.

2. **Quiesce caspers** (if anything surfaced)
   - `databricks pipelines stop <id>`; `databricks pipelines delete <id>`.
   - `databricks jobs delete --job-id <id>`.

3. **Drop caspers-created tables** (via MCP `execute_sql` or SQL warehouse)
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
   **DO NOT drop**: `orders_enriched`, `driver_positions`, `order_customer_map` (twins-owned), `customers`, `customer_address_index` (twins-owned).

4. **Deploy**
   - `./scripts/deploy.sh`
   - Expected wall-time: 15–25 min (bootstrap_datagen dominates first run).

5. **Unpause replay job**
   - After setup-lakebase's `canonical_data` task completes and `simulator.locations` has **22 rows** (SF-only):
   - Edit `databricks.yml` → `pause_status: UNPAUSED` on `twins-datagen-replay` → commit → `bundle deploy`.
   - OR via CLI: `databricks jobs update --job-id <id> --json '{"new_settings": {"schedule": {"pause_status": "UNPAUSED", "quartz_cron_expression": "0 0/3 * * * ?", "timezone_id": "UTC"}}}'`.

6. **Verify** — see Test plan below.

## Test plan

- [x] `databricks bundle validate -p DEFAULT` passes
- [x] `python -m py_compile setup/*.py datagen/generators/*.py pipelines/order_items/transformations/transformation.py` passes
- [x] Notebook JSON valid
- [ ] **Post-cutover**: `twins-order-items` pipeline RUNNING; `lakeflow.all_events` has rows
- [ ] **Post-cutover**: `SELECT COUNT(*) FROM simulator.locations` == 22 (SF-only per Decision 8)
- [ ] **Post-cutover, 10 min later**: `twins-datagen-replay` has ≥3 SUCCESS runs; `MAX(ts)` advancing ~3 hours sim-time per tick
- [ ] **Post-cutover, 30 min later**: App loads; orders + drivers + KPIs render; no 503s
- [ ] **Destroy/setup cycle**: `bundle run destroy-lakebase` → `./scripts/deploy.sh` brings everything back clean

Part of the twins isolation roadmap (Work 3 of 3).

This pull request was AI-assisted by Isaac.
EOF
)"
```

- [ ] **Step 4: Return the PR URL**

`gh pr create` prints the URL. Share with the user.

---

## Rollback

If Phase 1 needs to be reverted after merge:

```bash
# Option A: revert the merge commit on main
git revert -m 1 <merge-sha>
git push

# Then restore caspers (if its code + access are still available):
cd ../caspers-kitchens
databricks bundle deploy -p DEFAULT
databricks bundle run caspers -p DEFAULT
```

Or use the `all_events_backup_2026_04_20` table as a data snapshot to recover history if caspers isn't available.

**Note**: there is no clean mid-stream rollback. Once you drop tables in Cutover Step 3 and deploy twins' new pipeline, you've committed. Plan cutover during a low-activity window and keep the backup table.
