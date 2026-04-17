"""Task 4: Create Postgres indexes, grant app SP access, and verify.

Depends on: create_syncs (schemas/tables must exist in Postgres).
"""

import logging

import psycopg2

from databricks.sdk import WorkspaceClient
from databricks.sdk.service.database import DatabaseInstanceRole, DatabaseInstanceRoleIdentityType

from config import (
    APP_NAME,
    INDEX_SQL,
    INSTANCE_NAME,
    PG_DATABASE,
    get_pg_credentials,
)

logging.basicConfig(level=logging.INFO, format="%(asctime)s [%(levelname)s] %(message)s")
log = logging.getLogger("finalize")


def _get_host(w: WorkspaceClient) -> str:
    instance = w.database.get_database_instance(INSTANCE_NAME)
    return instance.read_write_dns


def create_indexes(w: WorkspaceClient, host: str) -> None:
    """Drop legacy matview (if any) and create performance indexes on synced tables."""
    user, password = get_pg_credentials(w)

    conn = psycopg2.connect(
        host=host, port=5432, dbname=PG_DATABASE,
        user=user, password=password, sslmode="require",
    )
    conn.autocommit = True
    cur = conn.cursor()

    # Clean up legacy materialized view / view from previous deployments.
    # orders_enriched_synced is now a CONTINUOUS-synced table, not a view.
    for cleanup in [
        "DROP MATERIALIZED VIEW IF EXISTS lakeflow.orders_enriched_synced",
        "DROP VIEW IF EXISTS lakeflow.orders_enriched_synced CASCADE",
    ]:
        try:
            cur.execute(cleanup)
        except Exception:
            pass  # Already gone or never existed

    # Create performance indexes on synced tables
    log.info("Creating Postgres indexes...")
    for stmt in INDEX_SQL.strip().split(";"):
        stmt = stmt.strip()
        if not stmt:
            continue
        try:
            cur.execute(stmt)
            log.info("Index created: %s", stmt.split("IF NOT EXISTS ")[-1].split(" ON")[0])
        except Exception as e:
            log.warning("Index creation: %s", e)

    cur.close()
    conn.close()
    log.info("Indexes ready")


def grant_app_sp_access(w: WorkspaceClient, host: str) -> None:
    """Create a Lakebase role for the app SP and grant SELECT on synced tables."""
    app = w.apps.get(APP_NAME)
    sp_client_id = app.service_principal_client_id
    if not sp_client_id:
        raise RuntimeError(f"App '{APP_NAME}' has no service_principal_client_id.")

    log.info("App SP: %s (client_id: %s)", app.service_principal_name, sp_client_id)

    try:
        w.database.create_database_instance_role(
            instance_name=INSTANCE_NAME,
            database_instance_role=DatabaseInstanceRole(
                name=sp_client_id,
                identity_type=DatabaseInstanceRoleIdentityType.SERVICE_PRINCIPAL,
            ),
        )
        log.info("Created Lakebase role for SP: %s", sp_client_id)
    except Exception as e:
        if "already exists" in str(e).lower() or "ALREADY_EXISTS" in str(e) or "conflicts" in str(e).lower():
            log.info("Lakebase role already exists for SP: %s", sp_client_id)
        else:
            log.warning("Role creation: %s (continuing)", e)

    admin_user, admin_password = get_pg_credentials(w)
    conn = psycopg2.connect(
        host=host, port=5432, dbname=PG_DATABASE,
        user=admin_user, password=admin_password, sslmode="require",
    )
    conn.autocommit = True
    cur = conn.cursor()

    quoted_sp = f'"{sp_client_id}"'
    cur.execute(f"GRANT CONNECT ON DATABASE {PG_DATABASE} TO {quoted_sp}")
    for schema in ["public", "simulator", "lakeflow", "complaints", "recommender"]:
        try:
            cur.execute(f"GRANT USAGE ON SCHEMA {schema} TO {quoted_sp}")
            cur.execute(f"GRANT SELECT ON ALL TABLES IN SCHEMA {schema} TO {quoted_sp}")
            cur.execute(f"ALTER DEFAULT PRIVILEGES IN SCHEMA {schema} GRANT SELECT ON TABLES TO {quoted_sp}")
            log.info("  Granted on schema: %s", schema)
        except Exception as e:
            log.warning("  Grant on schema %s: %s", schema, e)
            conn.rollback()
            conn.autocommit = True

    cur.close()
    conn.close()
    log.info("Postgres grants applied for SP %s", sp_client_id)


def verify(w: WorkspaceClient, host: str) -> None:
    """Run verification queries and log results."""
    user, password = get_pg_credentials(w)

    conn = psycopg2.connect(
        host=host, port=5432, dbname=PG_DATABASE,
        user=user, password=password, sslmode="require",
    )
    cur = conn.cursor()

    tables = ["simulator.locations_synced", "lakeflow.orders_enriched_synced", "lakeflow.all_events_synced", "lakeflow.driver_positions_synced"]
    log.info("--- Verification ---")
    for tbl in tables:
        try:
            cur.execute(f"SELECT COUNT(*) FROM {tbl}")
            count = cur.fetchone()[0]
            log.info("  %s: %d rows", tbl, count)
        except Exception as e:
            log.warning("  %s: %s", tbl, e)
            conn.rollback()

    cur.execute("""
        SELECT schemaname || '.' || tablename, indexname FROM pg_indexes
        WHERE schemaname IN ('simulator', 'lakeflow')
        ORDER BY schemaname, tablename, indexname
    """)
    indexes = cur.fetchall()
    log.info("  Indexes: %d", len(indexes))
    for tbl, idx in indexes:
        log.info("    %s.%s", tbl, idx)

    cur.close()
    conn.close()


def main():
    log.info("Task: finalize")
    w = WorkspaceClient()

    host = _get_host(w)
    create_indexes(w, host)
    grant_app_sp_access(w, host)
    verify(w, host)

    log.info("Finalize complete — indexes, grants, and verification done")
    log.info("NOTE: orders_enriched_synced is now a CONTINUOUS-synced table (not a view)")


if __name__ == "__main__":
    main()
