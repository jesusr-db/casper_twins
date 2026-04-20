"""Task 1: Trigger twins DLT pipelines and wait for completion.

Source tables must exist before Lakebase syncs can run.

As of Phase 1 (2026-04-20), twins owns two DLT pipelines:
  - twins-order-items: produces lakeflow.all_events + silver/gold aggregates
    from the events UC Volume. Depends on canonical_data having seeded the
    simulator dim tables and the volume.
  - twins-orders-enriched: produces orders_enriched + driver_positions +
    order_customer_map from all_events. Depends on the above.

Both are continuous/serverless. Missing pipelines are skipped with a
warning (useful on first deploy when the new pipeline has not yet been
created by `bundle deploy`).
"""

import logging
import time

from databricks.sdk import WorkspaceClient

from config import PIPELINE_NAME, SOURCE_CATALOG

logging.basicConfig(level=logging.INFO, format="%(asctime)s [%(levelname)s] %(message)s")
log = logging.getLogger("trigger_pipeline")

TIMEOUT = 600

# Pipelines to trigger, in dependency order. Phase 1 adds twins-order-items.
PIPELINE_NAMES = [
    "twins-order-items",       # must run first — produces lakeflow.all_events
    PIPELINE_NAME,              # twins-orders-enriched — depends on all_events
]


def trigger_and_wait(w: WorkspaceClient, name: str) -> None:
    """Start a pipeline update and wait until it reaches RUNNING or COMPLETED.

    Missing pipeline is logged and skipped (not an error).
    """
    log.info("Looking for pipeline '%s'...", name)
    pipelines = [
        p for p in w.pipelines.list_pipelines(filter=f"name LIKE '{name}'")
        if p.name == name
    ]
    if not pipelines:
        log.warning("Pipeline '%s' not found — it may not be deployed yet. Skipping.", name)
        return

    pipeline_id = pipelines[0].pipeline_id
    state = pipelines[0].state
    log.info("Found pipeline %s (state: %s)", pipeline_id, state)

    # Try to start an update. For continuous pipelines there is already an active
    # update — the ResourceConflict error is expected and safe to ignore.
    try:
        w.pipelines.start_update(pipeline_id=pipeline_id)
        log.info("Pipeline update started: %s", name)
    except Exception as e:
        if "ResourceConflict" in str(e) or "already exists" in str(e).lower():
            log.info("Pipeline '%s' already has an active update (continuous mode) — OK", name)
        else:
            raise

    # For triggered pipelines: wait for COMPLETED.
    # For continuous pipelines: wait for RUNNING — the pipeline never "completes".
    elapsed = 0
    interval = 20
    while elapsed < TIMEOUT:
        p = w.pipelines.get(pipeline_id=pipeline_id)
        latest = p.latest_updates[0] if p.latest_updates else None
        update_state = str(latest.state) if latest else "UNKNOWN"
        pipeline_state = str(p.state)

        if "COMPLETED" in update_state:
            log.info("Pipeline '%s' update completed successfully", name)
            return
        if "RUNNING" in update_state or "RUNNING" in pipeline_state:
            log.info("Pipeline '%s' is streaming (continuous mode)", name)
            return
        if "FAILED" in update_state or "CANCELED" in update_state:
            raise RuntimeError(f"Pipeline '{name}' update {update_state} — check source tables + logs")

        log.info("Pipeline '%s' initializing... (state: %s, update: %s, %ds)",
                 name, p.state, update_state, elapsed)
        time.sleep(interval)
        elapsed += interval

    raise RuntimeError(f"Pipeline '{name}' did not reach RUNNING or COMPLETED within {TIMEOUT}s")


def wait_for_tables(w: WorkspaceClient, target_tables: list[str]) -> None:
    """Wait until all target tables exist in UC before downstream syncs run.

    Continuous pipelines create them on first execution after deployment.
    """
    wait_elapsed = 0
    wait_interval = 20
    while wait_elapsed < TIMEOUT:
        missing = []
        for full_name in target_tables:
            try:
                w.tables.get(full_name=full_name)
            except Exception:
                missing.append(full_name)
        if not missing:
            log.info("All target tables exist — downstream syncs can proceed")
            return
        log.info("Waiting for tables to be created by pipelines (%ds): %s",
                 wait_elapsed, missing)
        time.sleep(wait_interval)
        wait_elapsed += wait_interval

    raise RuntimeError(f"Target tables not created within {TIMEOUT}s: {missing}")


def main():
    log.info("Task: trigger_pipeline")
    w = WorkspaceClient()

    # Trigger all twins-owned pipelines in dependency order.
    for name in PIPELINE_NAMES:
        trigger_and_wait(w, name)

    # Tables produced by both pipelines must exist before downstream syncs run.
    target_tables = [
        f"{SOURCE_CATALOG}.lakeflow.all_events",          # from twins-order-items
        f"{SOURCE_CATALOG}.lakeflow.orders_enriched",     # from twins-orders-enriched
        f"{SOURCE_CATALOG}.lakeflow.driver_positions",    # from twins-orders-enriched
    ]
    wait_for_tables(w, target_tables)


if __name__ == "__main__":
    main()
