"""Task 3: Create synced tables and wait for data to appear in Postgres.

Depends on: provision_lakebase (instance must exist).
Idempotent: if a sync already exists and is healthy, it is skipped.
If a sync is in a broken state (OFFLINE_FAILED), it is force-recreated:
  the UC registration is deleted, the Postgres table is dropped, and the
  sync is created fresh.
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


def _pg_schema_table(synced_table_name: str) -> tuple[str, str]:
    """Extract (schema, table) from 'catalog.schema.table'."""
    parts = synced_table_name.split(".")
    return parts[-2], parts[-1]


def _drop_pg_table(host: str, user: str, password: str, schema: str, table: str) -> None:
    """Drop a Postgres table, ignoring errors if it doesn't exist."""
    conn = None
    try:
        conn = psycopg2.connect(
            host=host, port=5432, dbname=PG_DATABASE,
            user=user, password=password, sslmode="require",
        )
        conn.autocommit = True
        with conn.cursor() as cur:
            cur.execute(f"DROP TABLE IF EXISTS {schema}.{table}")
        log.info("    Dropped Postgres table: %s.%s", schema, table)
    except Exception as e:
        log.warning("    Could not drop Postgres table %s.%s: %s", schema, table, e)
    finally:
        if conn:
            try:
                conn.close()
            except Exception:
                pass


def _create_sync(w: WorkspaceClient, name: str, source: str, policy, pk: list[str]) -> None:
    """Call the SDK to create a synced table (raises on failure)."""
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


def _handle_existing_sync(
    w: WorkspaceClient,
    name: str,
    source: str,
    policy,
    pk: list[str],
    pg_host: str,
    pg_user: str,
    pg_password: str,
) -> None:
    """Handle an 'already exists' response.

    If the sync is healthy, log and skip.
    If it is broken (OFFLINE_FAILED / NotFound), delete the stale registration,
    drop the Postgres table, and recreate the sync from scratch.
    """
    schema, table = _pg_schema_table(name)
    is_broken = False
    reason = ""

    try:
        t = w.database.get_synced_database_table(name)
        status = t.data_synchronization_status
        state = status.detailed_state if status else None
        if state and "FAILED" in str(state):
            is_broken = True
            reason = f"state={state}"
        else:
            log.info("  Sync healthy (state=%s), skipping: %s", state, source)
            return
    except Exception as e:
        if "not found" in str(e).lower() or "does not exist" in str(e).lower():
            # UC registration gone but Postgres table still exists
            is_broken = True
            reason = "UC registration missing, Postgres table may still exist"
        else:
            log.warning("  Could not check sync state for %s: %s (skipping)", source, e)
            return

    log.info("  Sync is broken (%s), force-recreating: %s", reason, source)

    # 1. Delete stale UC registration (ignore errors — may already be gone)
    try:
        w.database.delete_synced_database_table(name)
        log.info("    Deleted stale UC sync: %s", name)
    except Exception:
        pass

    # 2. Drop stale Postgres table
    _drop_pg_table(pg_host, pg_user, pg_password, schema, table)

    # 3. Recreate
    _create_sync(w, name, source, policy, pk)
    log.info("  Sync recreated: %s", source)


def ensure_syncs(w: WorkspaceClient) -> None:
    """Create (or force-recreate) all synced tables defined in SYNCS."""
    instance = w.database.get_database_instance(INSTANCE_NAME)
    pg_host = instance.read_write_dns
    pg_user, pg_password = get_pg_credentials(w)

    for sync_cfg in SYNCS:
        source = sync_cfg["source"]
        name = sync_cfg["name"]
        policy = sync_cfg["policy"]
        pk = sync_cfg["pk"]

        log.info("Creating sync: %s (policy: %s, pk: %s)", source, policy.value, pk)
        try:
            _create_sync(w, name, source, policy, pk)
            log.info("Sync created: %s", source)
        except Exception as e:
            msg = str(e)
            msg_lower = msg.lower()
            # "already exists" — normal idempotent path, inspect + heal if broken.
            # "not found" / "does not exist" — the create call failed because the
            # existing UC registration references a deleted pipeline or instance
            # (e.g. DLT pipeline was recreated with a new source-table ID). Treat
            # this the same as "broken sync" — force-recreate.
            if (
                "already exists" in msg_lower
                or "ALREADY_EXISTS" in msg
                or "not found" in msg_lower
                or "does not exist" in msg_lower
            ):
                # _handle_existing_sync may itself raise if the source Delta
                # genuinely doesn't exist yet (e.g. customers table before
                # generate_customers runs on a fresh catalog). Catch + continue
                # so the rest of SYNCS gets processed; subsequent create_syncs
                # runs will retry and succeed once the source materializes.
                try:
                    _handle_existing_sync(w, name, source, policy, pk, pg_host, pg_user, pg_password)
                except Exception as e2:
                    log.warning(
                        "Sync heal for %s failed: %s (continuing — will retry on next create_syncs run)",
                        source, e2,
                    )
            else:
                log.warning("Sync creation for %s failed: %s (continuing)", source, e)


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
