"""Task 1: Trigger the twins-orders-enriched pipeline and wait for completion.

Source tables must exist before Lakebase syncs can run.
"""

import logging
import time

from databricks.sdk import WorkspaceClient

from config import PIPELINE_NAME, SOURCE_CATALOG

logging.basicConfig(level=logging.INFO, format="%(asctime)s [%(levelname)s] %(message)s")
log = logging.getLogger("trigger_pipeline")

TIMEOUT = 600


def main():
    log.info("Task: trigger_pipeline")
    w = WorkspaceClient()

    log.info("Looking for pipeline '%s'...", PIPELINE_NAME)
    pipelines = [
        p for p in w.pipelines.list_pipelines(filter=f"name LIKE '{PIPELINE_NAME}'")
        if p.name == PIPELINE_NAME
    ]
    if not pipelines:
        log.warning("Pipeline '%s' not found — it may not be deployed yet. Skipping.", PIPELINE_NAME)
        return

    pipeline_id = pipelines[0].pipeline_id
    state = pipelines[0].state
    log.info("Found pipeline %s (state: %s)", pipeline_id, state)

    # Try to start an update. For continuous pipelines there is already an active
    # update — the ResourceConflict error is expected and safe to ignore.
    try:
        w.pipelines.start_update(pipeline_id=pipeline_id)
        log.info("Pipeline update started")
    except Exception as e:
        if "ResourceConflict" in str(e) or "already exists" in str(e).lower():
            log.info("Pipeline already has an active update (continuous mode) — OK")
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
            log.info("Pipeline update completed successfully")
            break
        if "RUNNING" in update_state or "RUNNING" in pipeline_state:
            log.info("Pipeline is streaming (continuous mode) — waiting for target tables to exist")
            break
        if "FAILED" in update_state or "CANCELED" in update_state:
            raise RuntimeError(f"Pipeline update {update_state} — source tables may not be ready")

        log.info("Pipeline initializing... (state: %s, update: %s, %ds)", p.state, update_state, elapsed)
        time.sleep(interval)
        elapsed += interval
    else:
        raise RuntimeError(f"Pipeline did not reach RUNNING or COMPLETED within {TIMEOUT}s")

    # Wait until both output tables exist in UC before downstream sync tasks run.
    # The continuous pipeline creates them on first execution after deployment.
    target_tables = [
        f"{SOURCE_CATALOG}.lakeflow.orders_enriched",
        f"{SOURCE_CATALOG}.lakeflow.driver_positions",
    ]
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
        log.info("Waiting for tables to be created by pipeline (%ds): %s", wait_elapsed, missing)
        time.sleep(wait_interval)
        wait_elapsed += wait_interval

    raise RuntimeError(f"Target tables not created within {TIMEOUT}s: {missing}")


if __name__ == "__main__":
    main()
