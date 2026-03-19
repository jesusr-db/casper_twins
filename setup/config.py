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
    # orders_enriched is a Materialized View — MV sources only support full-copy
    # mode, not CONTINUOUS incremental sync. Instead we create a Postgres VIEW
    # over all_events_synced (see VIEW_SQL below) which is always live.
    # {
    #     "source": f"{SOURCE_CATALOG}.lakeflow.orders_enriched",
    #     "policy": SyncedTableSchedulingPolicy.CONTINUOUS,  # NOT SUPPORTED for MVs
    # },
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
    # Order-to-customer map — CONTINUOUS for real-time new order mapping
    {
        "source": f"{SOURCE_CATALOG}.lakeflow.order_customer_map",
        "name": f"{SOURCE_CATALOG}.lakeflow.order_customer_map_synced",
        "policy": SyncedTableSchedulingPolicy.CONTINUOUS,
        "pk": ["order_id"],
    },
]

# Postgres view over all_events_synced (CONTINUOUS sync) that replicates the
# orders_enriched MV shape. Always live — reflects the latest event stream.
VIEW_SQL = """
CREATE OR REPLACE VIEW lakeflow.orders_enriched_synced AS
WITH cutoff AS (
  -- Anchor to the simulator's current time and look back 7 days.
  -- ts is stored as text "YYYY-MM-DD HH:MM:SS.000" so we format the cutoff
  -- the same way so text comparison works correctly with the ts index.
  -- Use 24h window for fresher stage data; driver_ping included in stage ranking
  SELECT TO_CHAR(
    MAX(ts)::timestamp - INTERVAL '24 hours',
    'YYYY-MM-DD HH24:MI:SS.000'
  ) AS ts_cutoff
  FROM lakeflow.all_events_synced
),
stage_ts AS (
  SELECT
    e.order_id,
    MAX(e.location_id)                                                        AS location_id,
    MAX(CASE WHEN e.event_type = 'order_created'    THEN e.ts::timestamp END) AS created_at,
    MAX(CASE WHEN e.event_type = 'gk_started'       THEN e.ts::timestamp END) AS kitchen_started_at,
    MAX(CASE WHEN e.event_type = 'gk_ready'         THEN e.ts::timestamp END) AS kitchen_ready_at,
    MAX(CASE WHEN e.event_type = 'gk_finished'      THEN e.ts::timestamp END) AS kitchen_finished_at,
    MAX(CASE WHEN e.event_type = 'driver_arrived'   THEN e.ts::timestamp END) AS driver_arrived_at,
    MAX(CASE WHEN e.event_type = 'driver_picked_up' THEN e.ts::timestamp END) AS picked_up_at,
    MAX(CASE WHEN e.event_type = 'delivered'        THEN e.ts::timestamp END) AS delivered_at,
    MAX(CASE WHEN e.event_type = 'order_created'    THEN e.body END)          AS order_body,
    MAX(CASE WHEN e.event_type = 'driver_picked_up' THEN e.body END)          AS route_body
  FROM lakeflow.all_events_synced e
  CROSS JOIN cutoff
  WHERE e.event_type NOT IN ('driver_ping')
    AND e.ts >= cutoff.ts_cutoff
  GROUP BY e.order_id
),
latest_stage AS (
  -- Include driver_ping in stage ranking so "driver_ping" shows as current_stage
  SELECT DISTINCT ON (e.order_id)
    e.order_id, e.event_type AS current_stage
  FROM lakeflow.all_events_synced e
  CROSS JOIN cutoff
  WHERE e.ts >= cutoff.ts_cutoff
  ORDER BY e.order_id, e.ts DESC, e.sequence::INTEGER DESC
)
SELECT
  st.order_id,
  st.location_id,
  ls.current_stage,
  st.created_at,
  st.kitchen_started_at,
  st.kitchen_ready_at,
  st.kitchen_finished_at,
  st.driver_arrived_at,
  st.picked_up_at,
  -- Carryout orders have an empty driver_picked_up body (no route_points).
  -- Mark them as delivered at pickup time so they don't show as active.
  COALESCE(
    st.delivered_at,
    CASE WHEN st.route_body IS NULL OR st.route_body = '{}' THEN st.picked_up_at END
  ) AS delivered_at,
  st.order_body,
  st.route_body,
  NULL::text AS latest_ping,
  COALESCE((
    SELECT SUM((item->>'price')::float * (item->>'qty')::int)
    FROM json_array_elements((st.order_body::json)->'items') AS item
  ), 0.0) AS order_total
FROM stage_ts st
JOIN latest_stage ls ON st.order_id = ls.order_id
"""

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

CREATE INDEX IF NOT EXISTS idx_ocm_customer
  ON lakeflow.order_customer_map_synced (customer_id);

CREATE INDEX IF NOT EXISTS idx_ocm_order
  ON lakeflow.order_customer_map_synced (order_id);
"""


def get_pg_credentials(w: WorkspaceClient) -> tuple[str, str]:
    """Get Postgres username and OAuth token for the Lakebase instance."""
    cred = w.database.generate_database_credential(instance_names=[INSTANCE_NAME])
    user = w.current_user.me().user_name
    return user, cred.token
