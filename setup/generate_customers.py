"""Task 5: Generate synthetic customer dataset from order history.

Depends on: finalize (Lakebase syncs and indexes must exist).

Clusters delivery addresses from orders_enriched_synced, assigns buyer
personas based on order patterns, generates customer records with Faker,
and writes to Delta tables for Lakebase sync.
"""

import hashlib
import json
import logging
import random
import uuid

import psycopg2
from faker import Faker

from databricks.sdk import WorkspaceClient
from pyspark.sql import SparkSession
from pyspark.sql.types import (
    BooleanType,
    DoubleType,
    IntegerType,
    StringType,
    StructField,
    StructType,
)

from config import (
    INSTANCE_NAME,
    PG_DATABASE,
    SOURCE_CATALOG,
    get_pg_credentials,
)

logging.basicConfig(level=logging.INFO, format="%(asctime)s [%(levelname)s] %(message)s")
log = logging.getLogger("generate_customers")

CUSTOMERS_TABLE = f"{SOURCE_CATALOG}.simulator.customers"
ADDRESS_INDEX_TABLE = f"{SOURCE_CATALOG}.simulator.customer_address_index"

CUSTOMERS_SCHEMA = StructType([
    StructField("customer_id", StringType(), False),
    StructField("location_id", StringType(), False),
    StructField("name", StringType(), False),
    StructField("email", StringType(), False),
    StructField("phone", StringType(), False),
    StructField("delivery_lat", DoubleType(), False),
    StructField("delivery_lon", DoubleType(), False),
    StructField("delivery_addr", StringType(), False),
    StructField("persona", StringType(), False),
    StructField("is_loyalty_member", BooleanType(), False),
    StructField("loyalty_points", IntegerType(), True),
    StructField("loyalty_join_date", StringType(), True),
    StructField("coupon_propensity", StringType(), False),
    StructField("preferred_item_ids", StringType(), False),
    StructField("first_order_date", StringType(), True),
    StructField("total_orders", IntegerType(), False),
    StructField("total_spend", DoubleType(), False),
])

ADDRESS_INDEX_SCHEMA = StructType([
    StructField("rounded_lat", DoubleType(), False),
    StructField("rounded_lon", DoubleType(), False),
    StructField("customer_id", StringType(), False),
    StructField("location_id", StringType(), False),
])

CLUSTER_QUERY = """
SELECT
  ROUND(CAST(json_extract_path_text(order_body, 'customer_lat') AS numeric), 3) AS rounded_lat,
  ROUND(CAST(json_extract_path_text(order_body, 'customer_lon') AS numeric), 3) AS rounded_lon,
  location_id,
  MIN(created_at) AS first_order,
  MAX(created_at) AS last_order,
  COUNT(*) AS order_count,
  COALESCE(SUM(order_total), 0) AS total_spend,
  AVG(EXTRACT(HOUR FROM created_at::timestamp)) AS avg_hour,
  COUNT(*) FILTER (WHERE EXTRACT(DOW FROM created_at::timestamp) IN (5, 6, 0)) AS weekend_orders,
  COUNT(*) FILTER (WHERE EXTRACT(HOUR FROM created_at::timestamp) BETWEEN 11 AND 14) AS lunch_orders
FROM lakeflow.orders_enriched_synced
WHERE order_body IS NOT NULL
GROUP BY rounded_lat, rounded_lon, location_id
"""


def _get_host(w: WorkspaceClient) -> str:
    instance = w.database.get_database_instance(INSTANCE_NAME)
    return instance.read_write_dns


def _assign_persona(row: dict, max_last_order: str) -> str:
    """Assign a buyer persona based on order patterns."""
    order_count = row["order_count"]
    total_spend = float(row["total_spend"])
    avg_hour = float(row["avg_hour"]) if row["avg_hour"] is not None else 18.0
    weekend_ratio = row["weekend_orders"] / order_count if order_count > 0 else 0
    lunch_ratio = row["lunch_orders"] / order_count if order_count > 0 else 0
    avg_ticket = total_spend / order_count if order_count > 0 else 0

    # Lapsed: last order > 30 days before the most recent order in the dataset
    last_order = str(row["last_order"]) if row["last_order"] else ""
    if last_order and max_last_order:
        # Simple text comparison works for "YYYY-MM-DD HH:MM:SS.000" format
        # 30 days ~ subtract 30 from day portion is imprecise; use character comparison
        # Instead, compare raw strings — if last_order < cutoff, lapsed
        # A rough heuristic: if the last_order string is < max_last_order minus ~30 days
        # We'll do a proper comparison using Python datetime
        try:
            from datetime import datetime, timedelta
            fmt = "%Y-%m-%d %H:%M:%S.%f"
            # Handle both "YYYY-MM-DD HH:MM:SS.000" and potential variations
            last_dt = datetime.strptime(last_order[:23], fmt[:23] if len(last_order) >= 23 else "%Y-%m-%d %H:%M:%S")
            max_dt = datetime.strptime(max_last_order[:23], fmt[:23] if len(max_last_order) >= 23 else "%Y-%m-%d %H:%M:%S")
            if last_dt < max_dt - timedelta(days=30):
                return "lapsed"
        except (ValueError, TypeError):
            pass

    if lunch_ratio > 0.6:
        return "lunch_only"

    if weekend_ratio > 0.5 and avg_ticket > 25:
        return "weekend_splurger"

    if order_count >= 5 and 17 <= avg_hour <= 22:
        return "weeknight_regular"

    return "occasional"


def _generate_customer(row: dict, persona: str) -> tuple[dict, dict]:
    """Generate a single customer record and address index entry."""
    lat = float(row["rounded_lat"])
    lon = float(row["rounded_lon"])
    location_id = row["location_id"]

    # Deterministic seed from lat/lon
    key = f"{lat},{lon}"
    md5_hex = hashlib.md5(key.encode()).hexdigest()
    seed = int(md5_hex[:8], 16)

    fake = Faker()
    fake.seed_instance(seed)
    rng = random.Random(seed)

    # Deterministic UUID from lat/lon
    customer_id = str(uuid.UUID(md5_hex))

    name = fake.name()
    email_name = name.lower().replace(" ", ".").replace("'", "")
    email = f"{email_name}@{fake.free_email_domain()}"
    phone = fake.phone_number()
    delivery_addr = fake.street_address()

    # Loyalty: 40% chance (seed-based)
    is_loyalty = seed % 10 < 4
    loyalty_points = rng.randint(100, 5000) if is_loyalty else None
    loyalty_join_date = None
    if is_loyalty and row["first_order"] and row["last_order"]:
        try:
            from datetime import datetime
            fmt = "%Y-%m-%d %H:%M:%S"
            first_dt = datetime.strptime(str(row["first_order"])[:19], fmt)
            last_dt = datetime.strptime(str(row["last_order"])[:19], fmt)
            if first_dt < last_dt:
                delta = (last_dt - first_dt).days
                join_offset = rng.randint(0, max(delta, 1))
                join_dt = first_dt + __import__("datetime").timedelta(days=join_offset)
                loyalty_join_date = join_dt.strftime("%Y-%m-%d")
            else:
                loyalty_join_date = str(row["first_order"])[:10]
        except (ValueError, TypeError):
            loyalty_join_date = None

    # Coupon propensity: 30% always, 40% sometimes, 30% never
    cp_bucket = seed % 10
    if cp_bucket <= 2:
        coupon_propensity = "always"
    elif cp_bucket <= 6:
        coupon_propensity = "sometimes"
    else:
        coupon_propensity = "never"

    # Preferred item IDs: 1-3 fake item IDs
    num_items = rng.randint(1, 3)
    preferred_items = [rng.randint(1, 50) for _ in range(num_items)]
    preferred_item_ids = json.dumps(preferred_items)

    first_order_date = str(row["first_order"])[:19] if row["first_order"] else None
    total_orders = int(row["order_count"])
    total_spend = float(row["total_spend"])

    customer = {
        "customer_id": customer_id,
        "location_id": location_id,
        "name": name,
        "email": email,
        "phone": phone,
        "delivery_lat": lat,
        "delivery_lon": lon,
        "delivery_addr": delivery_addr,
        "persona": persona,
        "is_loyalty_member": is_loyalty,
        "loyalty_points": loyalty_points,
        "loyalty_join_date": loyalty_join_date,
        "coupon_propensity": coupon_propensity,
        "preferred_item_ids": preferred_item_ids,
        "first_order_date": first_order_date,
        "total_orders": total_orders,
        "total_spend": total_spend,
    }

    address_index = {
        "rounded_lat": lat,
        "rounded_lon": lon,
        "customer_id": customer_id,
        "location_id": location_id,
    }

    return customer, address_index


def generate_customers(w: WorkspaceClient, spark: SparkSession) -> None:
    """Main generation logic: cluster orders, assign personas, generate customers."""

    # Step 1: Idempotency guard — skip if customers already exist
    try:
        count = spark.sql(f"SELECT COUNT(*) AS cnt FROM {CUSTOMERS_TABLE}").collect()[0]["cnt"]
        if count > 0:
            log.info("customers table already has %d rows — skipping generation", count)
            return
    except Exception:
        log.info("customers table does not exist yet — will create")

    # Step 2: Query order clusters from Lakebase
    host = _get_host(w)
    user, password = get_pg_credentials(w)

    log.info("Querying order clusters from Lakebase...")
    conn = psycopg2.connect(
        host=host, port=5432, dbname=PG_DATABASE,
        user=user, password=password, sslmode="require",
    )
    cur = conn.cursor()
    cur.execute(CLUSTER_QUERY)
    columns = [desc[0] for desc in cur.description]
    rows = [dict(zip(columns, row)) for row in cur.fetchall()]
    cur.close()
    conn.close()

    log.info("Found %d address clusters from order history", len(rows))

    if not rows:
        log.warning("No order clusters found — cannot generate customers. Exiting.")
        return

    # Step 3: Find max last_order for lapsed detection
    max_last_order = max(
        (str(r["last_order"]) for r in rows if r["last_order"]),
        default="",
    )

    # Step 4: Assign personas and generate customers
    customer_rows = []
    address_rows = []
    persona_counts = {}

    for row in rows:
        persona = _assign_persona(row, max_last_order)
        persona_counts[persona] = persona_counts.get(persona, 0) + 1

        customer, address_index = _generate_customer(row, persona)
        customer_rows.append(customer)
        address_rows.append(address_index)

    log.info("Generated %d customers", len(customer_rows))
    log.info("Persona distribution: %s", json.dumps(persona_counts, indent=2))
    loyalty_count = sum(1 for c in customer_rows if c["is_loyalty_member"])
    log.info("Loyalty members: %d (%.1f%%)", loyalty_count, 100.0 * loyalty_count / len(customer_rows))

    # Step 5: Write to Delta tables
    log.info("Writing customers to %s ...", CUSTOMERS_TABLE)
    # Ensure the simulator schema exists
    spark.sql(f"CREATE SCHEMA IF NOT EXISTS {SOURCE_CATALOG}.simulator")

    customers_df = spark.createDataFrame(customer_rows, schema=CUSTOMERS_SCHEMA)
    customers_df.write.mode("overwrite").saveAsTable(CUSTOMERS_TABLE)
    log.info("Wrote %d rows to %s", len(customer_rows), CUSTOMERS_TABLE)

    log.info("Writing address index to %s ...", ADDRESS_INDEX_TABLE)
    address_df = spark.createDataFrame(address_rows, schema=ADDRESS_INDEX_SCHEMA)
    address_df.write.mode("overwrite").saveAsTable(ADDRESS_INDEX_TABLE)
    log.info("Wrote %d rows to %s", len(address_rows), ADDRESS_INDEX_TABLE)


def main():
    log.info("Task: generate_customers")
    w = WorkspaceClient()
    spark = SparkSession.builder.getOrCreate()

    generate_customers(w, spark)

    log.info("Customer generation complete")


if __name__ == "__main__":
    main()
