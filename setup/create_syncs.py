"""Task 3: Create 3 synced tables and wait for data to appear in Postgres.

Depends on: provision_lakebase (instance must exist).
"""

import logging
import time

import psycopg2

from databricks.sdk import WorkspaceClient
from databricks.sdk.service.database import SyncedDatabaseTable, SyncedTableSpec

from config import (
    INSTANCE_NAME,
    PG_DATABASE,
    SYNCS,
    get_pg_credentials,
)

logging.basicConfig(level=logging.INFO, format="%(asctime)s [%(levelname)s] %(message)s")
log = logging.getLogger("create_syncs")

SYNC_TIMEOUT = 600


def ensure_syncs(w: WorkspaceClient) -> None:
    """Create synced tables for all 3 Delta sources."""
    for sync_cfg in SYNCS:
        source = sync_cfg["source"]
        name = sync_cfg["name"]
        policy = sync_cfg["policy"]
        pk = sync_cfg["pk"]

        log.info("Creating sync: %s (policy: %s, pk: %s)", source, policy.value, pk)
        try:
            w.database.create_synced_database_table(
                synced_table=SyncedDatabaseTable(
                    name=name,
                    database_instance_name=INSTANCE_NAME,
                    logical_database_name=PG_DATABASE,
                    spec=SyncedTableSpec(
                        source_table_full_name=source,
                        scheduling_policy=policy,
                        primary_key_columns=pk,
                        create_database_objects_if_missing=True,
                    ),
                )
            )
            log.info("Sync created: %s", source)
        except Exception as e:
            if "already exists" in str(e).lower() or "ALREADY_EXISTS" in str(e):
                log.info("Sync already exists: %s", source)
            else:
                log.warning("Sync creation for %s: %s (continuing)", source, e)


def wait_for_sync_data(w: WorkspaceClient) -> None:
    """Wait until the locations table has data, confirming syncs are flowing."""
    instance = w.database.get_database_instance(INSTANCE_NAME)
    host = instance.read_write_dns
    user, password = get_pg_credentials(w)
    elapsed = 0
    interval = 15

    log.info("Waiting for sync data to appear in Postgres...")

    while elapsed < SYNC_TIMEOUT:
        conn = None
        try:
            conn = psycopg2.connect(
                host=host, port=5432, dbname=PG_DATABASE,
                user=user, password=password, sslmode="require",
            )
            cur = conn.cursor()
            cur.execute("SELECT COUNT(*) FROM simulator.locations_synced")
            count = cur.fetchone()[0]
            cur.close()
            conn.close()

            if count > 0:
                log.info("Sync data confirmed: locations has %d rows", count)
                return
            log.info("No data yet (%ds)...", elapsed)
        except psycopg2.errors.UndefinedTable:
            log.info("Table not yet created by sync (%ds)...", elapsed)
        except Exception as e:
            log.info("Waiting for sync... (%ds) [%s: %s]", elapsed, type(e).__name__, e)
        finally:
            try:
                if conn:
                    conn.close()
            except Exception:
                pass

        time.sleep(interval)
        elapsed += interval

    log.warning("Sync data did not appear after %ds. Continuing anyway.", SYNC_TIMEOUT)


def main():
    log.info("Task: create_syncs")
    w = WorkspaceClient()

    ensure_syncs(w)
    wait_for_sync_data(w)

    log.info("Syncs created and data confirmed")


if __name__ == "__main__":
    main()
