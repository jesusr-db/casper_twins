-- =============================================================================
-- twins-orders-enriched pipeline — CONTINUOUS mode
-- =============================================================================
-- Reads from ${source_catalog}.lakeflow.all_events (caspers-kitchens DAB).
-- Pipeline runs in CONTINUOUS mode (databricks.yml: continuous: true).
--
-- TABLE 1: driver_positions (STREAMING TABLE — APPLY CHANGES)
--   True streaming — one row per active order, updated within seconds of each
--   driver_ping event. Used by the live map. CONTINUOUS Lakebase sync.
--
-- TABLE 2: orders_enriched (MATERIALIZED VIEW)
--   One row per order with all stage timestamps, order body, and latest_ping.
--   Refreshed continuously by the pipeline engine. CONTINUOUS Lakebase sync.
-- =============================================================================


-- -----------------------------------------------------------------------------
-- TABLE 1: driver_positions
-- Latest driver location per active order. APPLY CHANGES SCD Type 1.
-- Reads only driver_ping events — processes new pings as they arrive.
-- -----------------------------------------------------------------------------
CREATE OR REFRESH STREAMING TABLE driver_positions
COMMENT 'Latest driver position per active order. True streaming via APPLY CHANGES — updates within seconds of each driver_ping event.'
TBLPROPERTIES (
  'quality' = 'gold'
);

APPLY CHANGES INTO driver_positions
FROM (
  SELECT
    order_id,
    location_id,
    ts,
    CAST(GET_JSON_OBJECT(body, '$.loc_lat')      AS DOUBLE)  AS loc_lat,
    CAST(GET_JSON_OBJECT(body, '$.loc_lon')      AS DOUBLE)  AS loc_lon,
    CAST(GET_JSON_OBJECT(body, '$.progress_pct') AS DOUBLE)  AS progress_pct
  FROM STREAM(${source_catalog}.lakeflow.all_events)
  WHERE event_type = 'driver_ping'
)
KEYS (order_id)
SEQUENCE BY ts
STORED AS SCD TYPE 1;


-- -----------------------------------------------------------------------------
-- TABLE 2: orders_enriched
-- One row per order: current stage, all stage timestamps, body fields.
-- Refreshed continuously by the pipeline engine. Latency: seconds.
-- -----------------------------------------------------------------------------
CREATE OR REFRESH MATERIALIZED VIEW orders_enriched
COMMENT 'One row per order: current stage, all stage timestamps, body fields, order_total. Synced to Lakebase for the Digital Twins app.'
TBLPROPERTIES (
  'quality' = 'gold'
)
AS
WITH stage_timestamps AS (
  SELECT
    order_id,
    location_id,
    MAX(CASE WHEN event_type = 'order_created'     THEN ts END) AS created_at,
    MAX(CASE WHEN event_type = 'gk_started'         THEN ts END) AS kitchen_started_at,
    MAX(CASE WHEN event_type = 'gk_ready'           THEN ts END) AS kitchen_ready_at,
    MAX(CASE WHEN event_type = 'gk_finished'        THEN ts END) AS kitchen_finished_at,
    MAX(CASE WHEN event_type = 'driver_arrived'      THEN ts END) AS driver_arrived_at,
    MAX(CASE WHEN event_type = 'driver_picked_up'    THEN ts END) AS picked_up_at,
    MAX(CASE WHEN event_type = 'delivered'           THEN ts END) AS delivered_at,
    MAX(CASE WHEN event_type = 'order_created'       THEN body END) AS order_body,
    MAX(CASE WHEN event_type = 'driver_picked_up'    THEN body END) AS route_body
  FROM ${source_catalog}.lakeflow.all_events
  GROUP BY order_id, location_id
),

current_stage AS (
  SELECT
    order_id,
    event_type AS current_stage
  FROM (
    SELECT
      order_id,
      event_type,
      ROW_NUMBER() OVER (
        PARTITION BY order_id
        ORDER BY ts DESC, CAST(sequence AS INT) DESC
      ) AS rn
    FROM ${source_catalog}.lakeflow.all_events
  )
  WHERE rn = 1
),

latest_pings AS (
  SELECT
    order_id,
    body AS latest_ping,
    ROW_NUMBER() OVER (
      PARTITION BY order_id
      ORDER BY ts DESC, CAST(sequence AS INT) DESC
    ) AS ping_rn
  FROM ${source_catalog}.lakeflow.all_events
  WHERE event_type = 'driver_ping'
),

latest_ping_per_order AS (
  SELECT order_id, latest_ping
  FROM latest_pings
  WHERE ping_rn = 1
)

SELECT
  cs.order_id,
  st.location_id,
  cs.current_stage,
  st.created_at,
  st.kitchen_started_at,
  st.kitchen_ready_at,
  st.kitchen_finished_at,
  st.driver_arrived_at,
  st.picked_up_at,
  st.delivered_at,
  st.order_body,
  st.route_body,
  lp.latest_ping,
  COALESCE(
    AGGREGATE(
      FROM_JSON(
        GET_JSON_OBJECT(st.order_body, '$.items'),
        'ARRAY<STRUCT<name: STRING, price: DOUBLE, qty: INT>>'
      ),
      CAST(0.0 AS DOUBLE),
      (acc, item) -> acc + (item.price * item.qty)
    ),
    0.0
  ) AS order_total
FROM current_stage cs
LEFT JOIN stage_timestamps st ON cs.order_id = st.order_id
LEFT JOIN latest_ping_per_order lp ON cs.order_id = lp.order_id;
