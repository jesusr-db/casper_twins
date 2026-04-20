"""Shared configuration for Lakebase setup tasks."""

from databricks.sdk import WorkspaceClient
from databricks.sdk.service.database import SyncedTableSchedulingPolicy

PIPELINE_NAME = "twins-orders-enriched"
INSTANCE_NAME = "twins"
SOURCE_CATALOG = "vdm_classic_rikfy0_catalog"
PG_DATABASE = "databricks_postgres"
APP_NAME = "twins-digital-twin"

# Synced table names use the SOURCE catalog (not a separate lakebase catalog).
# The synced table is registered as a UC table under the source catalog,
# and create_database_objects_if_missing handles Postgres schema creation.
SYNCS = [
    # Reference data — rarely changes, SNAPSHOT is sufficient
    {
        "source": f"{SOURCE_CATALOG}.simulator.locations",
        "name": f"{SOURCE_CATALOG}.simulator.locations_synced",
        "policy": SyncedTableSchedulingPolicy.SNAPSHOT,
        "pk": ["location_id"],
    },
    # orders_enriched — now a Streaming Table (was MV). CONTINUOUS sync supported.
    {
        "source": f"{SOURCE_CATALOG}.lakeflow.orders_enriched",
        "name": f"{SOURCE_CATALOG}.lakeflow.orders_enriched_synced",
        "policy": SyncedTableSchedulingPolicy.CONTINUOUS,
        "pk": ["order_id"],
    },
    # Raw event stream — needed for order detail timeline view
    {
        "source": f"{SOURCE_CATALOG}.lakeflow.all_events",
        "name": f"{SOURCE_CATALOG}.lakeflow.all_events_synced",
        "policy": SyncedTableSchedulingPolicy.CONTINUOUS,
        "pk": ["event_id"],
    },
    # Live driver positions — most latency-sensitive, true streaming via APPLY CHANGES
    {
        "source": f"{SOURCE_CATALOG}.lakeflow.driver_positions",
        "name": f"{SOURCE_CATALOG}.lakeflow.driver_positions_synced",
        "policy": SyncedTableSchedulingPolicy.CONTINUOUS,
        "pk": ["order_id"],
    },
    # --- Synthetic customer tables ---
    # Customer master data — SNAPSHOT is sufficient (generated once, rarely changes)
    {
        "source": f"{SOURCE_CATALOG}.simulator.customers",
        "name": f"{SOURCE_CATALOG}.simulator.customers_synced",
        "policy": SyncedTableSchedulingPolicy.SNAPSHOT,
        "pk": ["customer_id"],
    },
    # Address lookup index for order-to-customer mapping
    {
        "source": f"{SOURCE_CATALOG}.simulator.customer_address_index",
        "name": f"{SOURCE_CATALOG}.simulator.customer_address_index_synced",
        "policy": SyncedTableSchedulingPolicy.SNAPSHOT,
        "pk": ["customer_id"],
    },
    # NOTE: order_customer_map (streaming table) is intentionally excluded.
    # DLT CONTINUOUS streaming tables accumulate duplicates when full-refreshed.
    # Customer lookups in Lakebase instead join through customer_address_index_synced:
    #   JOIN simulator.customer_address_index_synced ai
    #     ON ROUND(CAST((o.order_body::json)->>'customer_lat' AS numeric), 3) = ai.rounded_lat
    #     AND ROUND(CAST((o.order_body::json)->>'customer_lon' AS numeric), 3) = ai.rounded_lon
    #   JOIN simulator.customers_synced c ON ai.customer_id = c.customer_id
]

INDEX_SQL = """
CREATE INDEX IF NOT EXISTS idx_events_ts
  ON lakeflow.all_events_synced (ts);

CREATE INDEX IF NOT EXISTS idx_orders_location_stage
  ON lakeflow.orders_enriched_synced (location_id, current_stage);

CREATE INDEX IF NOT EXISTS idx_orders_location_created
  ON lakeflow.orders_enriched_synced (location_id, created_at DESC);

CREATE INDEX IF NOT EXISTS idx_events_order_id
  ON lakeflow.all_events_synced (order_id, ts);

CREATE INDEX IF NOT EXISTS idx_events_location_ts
  ON lakeflow.all_events_synced (location_id, ts);

CREATE INDEX IF NOT EXISTS idx_driver_positions_location
  ON lakeflow.driver_positions_synced (location_id);

CREATE INDEX IF NOT EXISTS idx_customers_location
  ON simulator.customers_synced (location_id);

CREATE INDEX IF NOT EXISTS idx_address_index_lat_lon
  ON simulator.customer_address_index_synced (rounded_lat, rounded_lon);
"""


def get_pg_credentials(w: WorkspaceClient) -> tuple[str, str]:
    """Get Postgres username and OAuth token for the Lakebase instance."""
    cred = w.database.generate_database_credential(instance_names=[INSTANCE_NAME])
    user = w.current_user.me().user_name
    return user, cred.token
