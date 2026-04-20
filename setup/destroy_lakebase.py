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
  - Caspers-owned schemas if any remain (complaints, recommender, food_safety,
    menu_documents). Caspers was retired as of Phase 1; those schemas are
    orphans and can be dropped manually.

Idempotent — safe to re-run. Skips resources that don't exist.

Deployed via databricks.yml as: twins-destroy-lakebase job.
"""

import logging

from databricks.sdk import WorkspaceClient

logging.basicConfig(level=logging.INFO, format="%(asctime)s [%(levelname)s] %(message)s")
log = logging.getLogger("destroy_lakebase")

# ── Configuration (must match setup config.py) ────────────────────────────────
INSTANCE_NAME = "twins"
SOURCE_CATALOG = "vdm_classic_rikfy0_catalog"

# All synced tables created by create_syncs.py — must stay in sync with config.SYNCS
SYNCED_TABLES = [
    f"{SOURCE_CATALOG}.simulator.locations_synced",
    f"{SOURCE_CATALOG}.lakeflow.all_events_synced",
    f"{SOURCE_CATALOG}.lakeflow.driver_positions_synced",
    # Synthetic customer tables (added by generate_customers + create_syncs)
    f"{SOURCE_CATALOG}.simulator.customers_synced",
    f"{SOURCE_CATALOG}.simulator.customer_address_index_synced",
]

# Tables created by the existing twins-orders-enriched pipeline.
DLT_TABLES = [
    f"{SOURCE_CATALOG}.lakeflow.orders_enriched",
    f"{SOURCE_CATALOG}.lakeflow.driver_positions",
    f"{SOURCE_CATALOG}.lakeflow.order_customer_map",
]

# Tables created by the Phase 1 twins-order-items DLT pipeline.
ABSORBED_DLT_TABLES = [
    f"{SOURCE_CATALOG}.lakeflow.all_events",
    f"{SOURCE_CATALOG}.lakeflow.silver_order_items",
    f"{SOURCE_CATALOG}.lakeflow.gold_order_header",
    f"{SOURCE_CATALOG}.lakeflow.gold_item_sales_day",
    f"{SOURCE_CATALOG}.lakeflow.gold_brand_sales_day",
    f"{SOURCE_CATALOG}.lakeflow.gold_location_sales_hourly",
]

# Simulator dim tables seeded by canonical_data.ipynb (Phase 1).
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


def _safe(fn, description: str):
    """Run fn, log success or skip on error."""
    try:
        fn()
        log.info("  Deleted: %s", description)
    except Exception as e:
        err = str(e).lower()
        if "not found" in err or "does not exist" in err or "NOT_FOUND" in str(e):
            log.info("  Not found (skip): %s", description)
        else:
            log.warning("  Failed: %s — %s", description, e)


def _pause_replay_job(w: WorkspaceClient) -> None:
    """Pause twins-datagen-replay so it can't write during destruction.

    The job is DAB-managed and will be removed by `databricks bundle destroy`,
    but pausing first prevents any in-flight scheduled runs from racing the
    drops below.
    """
    from databricks.sdk.service.jobs import CronSchedule, PauseStatus

    jobs = [j for j in w.jobs.list(name=DATAGEN_REPLAY_JOB_NAME)]
    if not jobs:
        log.info("  Not found (skip): %s", DATAGEN_REPLAY_JOB_NAME)
        return
    for job in jobs:
        try:
            # Fetch current settings to preserve schedule cron/timezone.
            full = w.jobs.get(job_id=job.job_id)
            existing_schedule = full.settings.schedule if full.settings else None
            cron = existing_schedule.quartz_cron_expression if existing_schedule else "0 0/3 * * * ?"
            tz = existing_schedule.timezone_id if existing_schedule else "UTC"
            new_settings = {
                "schedule": CronSchedule(
                    quartz_cron_expression=cron,
                    timezone_id=tz,
                    pause_status=PauseStatus.PAUSED,
                ),
            }
            w.jobs.update(job_id=job.job_id, new_settings=new_settings)
            log.info("  Paused: %s (job_id=%s)", DATAGEN_REPLAY_JOB_NAME, job.job_id)
        except Exception as e:
            log.warning("  Failed to pause %s: %s", DATAGEN_REPLAY_JOB_NAME, e)


def main():
    log.info("=" * 60)
    log.info("Digital Twins — Lakebase Destroy")
    log.info("=" * 60)

    w = WorkspaceClient()

    # ── Step 0: Pause datagen replay job (Phase 1 addition) ───────────────────
    log.info("Step 0: Pausing %s...", DATAGEN_REPLAY_JOB_NAME)
    _pause_replay_job(w)

    # ── Step 1: Delete synced tables ──────────────────────────────────────────
    log.info("Step 1: Deleting synced tables...")
    for name in SYNCED_TABLES:
        _safe(lambda n=name: w.database.delete_synced_database_table(n), name)

    # ── Step 2: Delete Lakebase instance ──────────────────────────────────────
    # Deleting the instance also drops all Postgres schemas and tables inside it,
    # so any stale Postgres tables (e.g. from a failed sync) are cleaned up here.
    log.info("Step 2: Deleting Lakebase instance '%s'...", INSTANCE_NAME)
    _safe(lambda: w.database.delete_database_instance(INSTANCE_NAME), INSTANCE_NAME)

    # ── Step 3: Drop twins-orders-enriched DLT tables ─────────────────────────
    log.info("Step 3: Dropping twins-orders-enriched DLT tables...")
    for table_name in DLT_TABLES:
        _safe(lambda t=table_name: w.tables.delete(t), table_name)

    # ── Step 4: Drop twins-order-items DLT tables (Phase 1) ───────────────────
    log.info("Step 4: Dropping twins-order-items DLT tables...")
    for table_name in ABSORBED_DLT_TABLES:
        _safe(lambda t=table_name: w.tables.delete(t), table_name)

    # ── Step 5: Drop absorbed dim tables (Phase 1) ────────────────────────────
    log.info("Step 5: Dropping absorbed simulator dim tables...")
    for table_name in ABSORBED_DIM_TABLES:
        _safe(lambda t=table_name: w.tables.delete(t), table_name)

    log.info("=" * 60)
    log.info("Destroy complete. DAB-managed resources (pipelines, jobs, volumes,")
    log.info("schemas, app) are removed separately via `databricks bundle destroy`.")
    log.info("=" * 60)


if __name__ == "__main__":
    main()
