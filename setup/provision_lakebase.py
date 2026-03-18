"""Task 2: Create Lakebase Provisioned instance.

Depends on: trigger_pipeline (source tables must exist).
"""

import logging
import time

from databricks.sdk import WorkspaceClient
from databricks.sdk.service.database import DatabaseInstance

from config import INSTANCE_NAME

logging.basicConfig(level=logging.INFO, format="%(asctime)s [%(levelname)s] %(message)s")
log = logging.getLogger("provision_lakebase")


def ensure_lakebase_instance(w: WorkspaceClient) -> str:
    """Create the Lakebase Provisioned instance. Returns the read-write DNS host."""
    try:
        instance = w.database.get_database_instance(INSTANCE_NAME)
        log.info("Lakebase instance '%s' already exists (state: %s)", INSTANCE_NAME, instance.state)
    except Exception:
        log.info("Creating Lakebase Provisioned instance '%s' (CU_1)...", INSTANCE_NAME)
        instance = w.database.create_database_instance_and_wait(
            database_instance=DatabaseInstance(
                name=INSTANCE_NAME,
                capacity="CU_1",
            ),
        )
        log.info("Instance created: state=%s", instance.state)

    for _ in range(30):
        instance = w.database.get_database_instance(INSTANCE_NAME)
        state_str = str(instance.state)
        if "AVAILABLE" in state_str or "RUNNING" in state_str:
            break
        log.info("Waiting for instance... (state: %s)", instance.state)
        time.sleep(10)

    host = instance.read_write_dns
    if not host:
        raise RuntimeError(f"Instance '{INSTANCE_NAME}' has no read_write_dns")

    log.info("Lakebase host: %s", host)
    return host


def main():
    log.info("Task: provision_lakebase")
    w = WorkspaceClient()

    ensure_lakebase_instance(w)

    log.info("Lakebase instance ready")


if __name__ == "__main__":
    main()
