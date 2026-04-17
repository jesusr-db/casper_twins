-- =============================================================================
-- twins-orders-enriched pipeline — CONTINUOUS mode
-- =============================================================================
-- Reads from ${source_catalog}.lakeflow.all_events (caspers-kitchens DAB).
-- Pipeline runs in CONTINUOUS mode (databricks.yml: continuous: true).
--
-- TABLE 1: driver_positions (STREAMING TABLE — APPLY CHANGES SCD1)
--   True streaming — one row per active order, updated within seconds of each
--   driver_ping event. Used by the live map. CONTINUOUS Lakebase sync.
--
-- TABLE 2: orders_enriched (STREAMING TABLE — APPLY CHANGES SCD1)
--   One row per order with current stage, all stage timestamps, body fields.
--   Uses IGNORE NULL UPDATES so each event only sets its own column while
--   preserving previously-set timestamps. CONTINUOUS Lakebase sync.
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
-- APPLY CHANGES with IGNORE NULL UPDATES — each event sets only its own
-- timestamp column; previously-set columns are preserved. Latency: seconds.
-- -----------------------------------------------------------------------------
CREATE OR REFRESH STREAMING TABLE orders_enriched
COMMENT 'One row per order: current stage, all stage timestamps, body fields, order_total. Streaming via APPLY CHANGES with IGNORE NULL UPDATES. Synced to Lakebase CONTINUOUS.'
TBLPROPERTIES (
  'quality' = 'gold'
);

APPLY CHANGES INTO orders_enriched
FROM (
  SELECT
    order_id,
    location_id,
    ts,
    event_type AS current_stage,
    -- Each event sets only its own timestamp; IGNORE NULL UPDATES preserves the rest
    CASE WHEN event_type = 'order_created'    THEN ts END AS created_at,
    CASE WHEN event_type = 'gk_started'       THEN ts END AS kitchen_started_at,
    CASE WHEN event_type = 'gk_ready'         THEN ts END AS kitchen_ready_at,
    CASE WHEN event_type = 'gk_finished'      THEN ts END AS kitchen_finished_at,
    CASE WHEN event_type = 'driver_arrived'   THEN ts END AS driver_arrived_at,
    CASE WHEN event_type = 'driver_picked_up' THEN ts END AS picked_up_at,
    -- Carryout orders emit driver_picked_up with empty body {} and no subsequent
    -- driver_ping / delivered events. Treat those as delivered at pickup time so
    -- they don't clog the "active orders" / "drivers_out" counts.
    CASE
      WHEN event_type = 'delivered' THEN ts
      WHEN event_type = 'driver_picked_up' AND (body IS NULL OR body = '{}' OR body = '') THEN ts
    END AS delivered_at,
    CASE WHEN event_type = 'order_created'    THEN body END AS order_body,
    CASE WHEN event_type = 'driver_picked_up' THEN body END AS route_body,
    CASE WHEN event_type = 'driver_ping'      THEN body END AS latest_ping,
    CASE WHEN event_type = 'order_created' THEN
      COALESCE(
        AGGREGATE(
          FROM_JSON(
            GET_JSON_OBJECT(body, '$.items'),
            'ARRAY<STRUCT<name: STRING, price: DOUBLE, qty: INT>>'
          ),
          CAST(0.0 AS DOUBLE),
          (acc, item) -> acc + (item.price * item.qty)
        ),
        0.0
      )
    END AS order_total
  FROM STREAM(${source_catalog}.lakeflow.all_events)
)
KEYS (order_id)
IGNORE NULL UPDATES
SEQUENCE BY ts
STORED AS SCD TYPE 1;


-- -----------------------------------------------------------------------------
-- TABLE 3: order_customer_map
-- Maps each order to its customer via address index lookup.
-- Streaming — processes new orders as they arrive.
-- -----------------------------------------------------------------------------
CREATE OR REFRESH STREAMING TABLE order_customer_map
COMMENT 'Maps orders to customers via delivery address proximity. LEFT JOIN ensures unmatched orders get customer_id=unknown.'
TBLPROPERTIES (
  'quality' = 'gold'
)
AS
SELECT
  e.order_id,
  e.location_id,
  COALESCE(c.customer_id, 'unknown') AS customer_id
FROM STREAM(${source_catalog}.lakeflow.all_events) e
LEFT JOIN ${source_catalog}.simulator.customer_address_index c
  ON ROUND(CAST(GET_JSON_OBJECT(e.body, '$.customer_lat') AS DOUBLE), 3) = c.rounded_lat
  AND ROUND(CAST(GET_JSON_OBJECT(e.body, '$.customer_lon') AS DOUBLE), 3) = c.rounded_lon
WHERE e.event_type = 'order_created';
