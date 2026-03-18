"""
Digital Twins — Lakebase Infrastructure Destroy Job

Tears down all resources created by setup tasks that are NOT managed by DAB:
  1. Delete synced tables (stops their sync pipelines)
  2. Delete Lakebase Provisioned instance (twins)
  3. Drop the orders_enriched MV from Unity Catalog (created by DAB pipeline)

Does NOT touch:
  - The Databricks App (managed by DAB)
  - The setup/destroy jobs (managed by DAB)
  - The twins-orders-enriched pipeline definition (managed by DAB)
  - Source Delta tables in vdm_classic_rikfy0_catalog (managed by caspers-kitchens DAB)

Idempotent — safe to re-run. Skips resources that don't exist.

Deployed via databricks.yml as: twins-destroy-lakebase job
"""

import logging

from databricks.sdk import WorkspaceClient

logging.basicConfig(level=logging.INFO, format="%(asctime)s [%(levelname)s] %(message)s")
log = logging.getLogger("destroy_lakebase")

# ── Configuration (must match setup config.py) ────────────────────────────────
INSTANCE_NAME = "twins"
SOURCE_CATALOG = "vdm_classic_rikfy0_catalog"

SYNCED_TABLES = [
    f"{SOURCE_CATALOG}.simulator.locations_synced",
    f"{SOURCE_CATALOG}.lakeflow.orders_enriched_synced",
    f"{SOURCE_CATALOG}.lakeflow.all_events_synced",
]

# Tables created by our DAB pipeline (not the caspers-kitchens pipeline)
DLT_TABLES = [
    f"{SOURCE_CATALOG}.lakeflow.orders_enriched",
]


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


def main():
    log.info("=" * 60)
    log.info("Digital Twins — Lakebase Destroy")
    log.info("=" * 60)

    w = WorkspaceClient()

    # ── Step 1: Delete synced tables ──────────────────────────────────────────
    log.info("Step 1: Deleting synced tables...")
    for name in SYNCED_TABLES:
        _safe(lambda n=name: w.database.delete_synced_database_table(n), name)

    # ── Step 2: Delete Lakebase instance ──────────────────────────────────────
    log.info("Step 2: Deleting Lakebase instance '%s'...", INSTANCE_NAME)
    _safe(lambda: w.database.delete_database_instance(INSTANCE_NAME), INSTANCE_NAME)

    # ── Step 3: Drop DLT-created tables from Unity Catalog ────────────────────
    log.info("Step 3: Dropping DLT-created tables from Unity Catalog...")
    for table_name in DLT_TABLES:
        _safe(lambda t=table_name: w.tables.delete(t), table_name)

    log.info("=" * 60)
    log.info("Destroy complete. All setup resources removed.")
    log.info("Run 'databricks bundle destroy' to remove DAB-managed resources.")
    log.info("=" * 60)


if __name__ == "__main__":
    main()
