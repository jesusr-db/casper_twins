# QA Report — Phase 2-customers: DAB Integration & QA

Date: 2026-03-19

## Check 1: setup/generate_customers.py
**PASS**

- [x] Idempotency guard: checks `SELECT COUNT(*) AS cnt FROM {CUSTOMERS_TABLE}`, skips if > 0
- [x] Deterministic seeding: `hashlib.md5(f"{lat},{lon}".encode())` for both seed and UUID
- [x] No hardcoded catalogs: uses `SOURCE_CATALOG` from config.py throughout
- [x] Imports from config: `INSTANCE_NAME, PG_DATABASE, SOURCE_CATALOG, get_pg_credentials`
- [x] LEFT JOIN pattern: Postgres cluster query uses GROUP BY (no join needed for clustering)
- [x] psycopg2 connection follows finalize.py pattern (host from `_get_host()`, credentials from `get_pg_credentials()`)
- [x] Writes via SparkSession (available in spark_python_task): `spark.createDataFrame().write.mode("overwrite").saveAsTable()`
- [x] 5 personas implemented: lapsed, lunch_only, weekend_splurger, weeknight_regular, occasional
- [x] 40% loyalty (seed % 10 < 4), coupon propensity 30/40/30 (seed % 10 buckets 0-2/3-6/7-9)
- [x] Python syntax valid (ast.parse passes)

## Check 2: pipelines/orders_enriched.sql
**PASS**

- [x] order_customer_map STREAMING TABLE present
- [x] Uses STREAM(${source_catalog}.lakeflow.all_events) — parameterized, not hardcoded
- [x] LEFT JOIN to ${source_catalog}.simulator.customer_address_index
- [x] COALESCE(c.customer_id, 'unknown') for unmatched addresses
- [x] WHERE e.event_type = 'order_created' filter
- [x] JOIN condition: ROUND(CAST(GET_JSON_OBJECT(e.body, '$.customer_lat') AS DOUBLE), 3) matches rounded_lat
- [x] Existing pipeline code unchanged (only appended after final semicolon)

## Check 3: databricks.yml
**PASS**

- [x] Task 5 (generate_customers) present with task_key: generate_customers
- [x] depends_on: [finalize] correct
- [x] spark_python_task.python_file: setup/generate_customers.py
- [x] environment_key: setup_env (reuses existing environment)
- [x] faker>=24.0.0 added to setup_env dependencies
- [x] `databricks bundle validate` passes (Validation OK!)

## Check 4: setup/config.py
**PASS**

- [x] SYNCS count = 6 (3 original + 3 new)
- [x] customers_synced: SNAPSHOT policy, pk=[customer_id]
- [x] customer_address_index_synced: SNAPSHOT policy, pk=[customer_id]
- [x] order_customer_map_synced: CONTINUOUS policy, pk=[order_id]
- [x] 3 new indexes: idx_customers_location, idx_ocm_customer, idx_ocm_order
- [x] INDEX_SQL total: 9 indexes (6 original + 3 new)

## Check 5: Schema consistency
**PASS**

- [x] customers table: 17 columns (customer_id, location_id, name, email, phone, delivery_lat, delivery_lon, delivery_addr, persona, is_loyalty_member, loyalty_points, loyalty_join_date, coupon_propensity, preferred_item_ids, first_order_date, total_orders, total_spend)
- [x] customer_address_index: 4 columns (rounded_lat, rounded_lon, customer_id, location_id)
- [x] order_customer_map: 3 columns (order_id, location_id, customer_id)
- [x] Grants: finalize.py uses schema-level `GRANT SELECT ON ALL TABLES IN SCHEMA` + `ALTER DEFAULT PRIVILEGES` for simulator and lakeflow schemas — new tables are auto-covered. No modification needed.

## Summary

| Check | Result |
|-------|--------|
| 1. generate_customers.py | PASS |
| 2. orders_enriched.sql   | PASS |
| 3. databricks.yml        | PASS |
| 4. config.py             | PASS |
| 5. Schema consistency    | PASS |

**Overall: PASS (all 5 checks)**
