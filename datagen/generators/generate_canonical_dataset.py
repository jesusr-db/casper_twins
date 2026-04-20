# Ported from caspers-kitchens at commit 8c756ac on 2026-04-20.
# Caspers is retired — this is now the authoritative copy.
# Modifying this file is a twins-internal decision.

"""
Canonical Dataset Generator for Domino's Digital Twin
Generates 90 days of realistic Domino's franchise event data.

Reads canonical_dataset/locations.parquet (filtered to SF by generate_dimensions.py)
and emits events only for locations in that file. With Phase 1 SF-only scope,
this produces ~250K events across 22 SF stores (vs ~1M events across 88 stores).

Uses straight-line routing with jitter (no OSM dependency).
Outputs compact parquet files (events.parquet, orders.parquet).
"""

import datetime as dt
import json
import math
import random
import string
from pathlib import Path
from typing import Dict, List, Tuple

import numpy as np
import pandas as pd

# ============================================================================
# CONFIGURATION
# ============================================================================

DAYS = 90
RANDOM_SEED = 42
PING_INTERVAL_SEC = 60
DRIVER_MPH = 25
CUSTOMER_RADIUS_MILES = 4  # Max delivery radius

# Service time parameters (minutes): [mean, std_dev]
SVC_TIMES = {
    "created_to_started": [2, 1],
    "started_to_finished": [10, 3],
    "finished_to_ready": [2, 1],
    "ready_to_pickup": [6, 2],
}

# Driver arrival distribution (beta distribution parameters)
DRIVER_ARRIVAL = {
    "after_ready_pct": 0.5,
    "alpha": 3,
    "beta": 3,
}

random.seed(RANDOM_SEED)
np.random.seed(RANDOM_SEED)

# ============================================================================
# LOAD DIMENSION TABLES
# ============================================================================

print("Loading dimension tables...")
locations_df = pd.read_parquet("canonical_dataset/locations.parquet")
brands_df = pd.read_parquet("canonical_dataset/brands.parquet")
brand_locations_df = pd.read_parquet("canonical_dataset/brand_locations.parquet")
categories_df = pd.read_parquet("canonical_dataset/categories.parquet")
items_df = pd.read_parquet("canonical_dataset/items.parquet")

# Build lookup structures
LOCATIONS = locations_df.to_dict('records')
ALL_ITEMS = items_df.to_dict('records')
ITEMS_BY_CATEGORY = {
    name: grp.to_dict('records')
    for name, grp in items_df.merge(
        categories_df[['id', 'name']], left_on='category_id', right_on='id', suffixes=('', '_cat')
    ).groupby('name_cat')
}
CATEGORY_NAMES = list(ITEMS_BY_CATEGORY.keys())

# Category weights for basket selection (~50% pizza)
CATEGORY_WEIGHTS = {
    'Specialty Pizzas': 0.30,
    'Build Your Own Pizza': 0.20,
    'Chicken': 0.10,
    'Pasta': 0.05,
    'Sandwiches': 0.05,
    'Bread & Sides': 0.15,
    'Desserts': 0.05,
    'Drinks': 0.10,
}

# Accompaniment weights (sides/drinks more likely as 2nd+ item)
ACCOMPANIMENT_WEIGHTS = {
    'Specialty Pizzas': 0.05,
    'Build Your Own Pizza': 0.05,
    'Chicken': 0.10,
    'Pasta': 0.05,
    'Sandwiches': 0.05,
    'Bread & Sides': 0.30,
    'Desserts': 0.15,
    'Drinks': 0.25,
}

# Channel distribution per location code
CHANNEL_DIST = {
    'sf':       {'app': 0.45, 'web': 0.30, 'phone': 0.15, 'walkin': 0.10},
    'sv':       {'app': 0.50, 'web': 0.25, 'phone': 0.10, 'walkin': 0.15},
    'bellevue': {'app': 0.30, 'web': 0.25, 'phone': 0.30, 'walkin': 0.15},
    'chicago':  {'app': 0.20, 'web': 0.15, 'phone': 0.50, 'walkin': 0.15},
}

# Fulfillment distribution per location code
FULFILLMENT_DIST = {
    'sf':       {'delivery': 0.70, 'carryout': 0.30},
    'sv':       {'delivery': 0.45, 'carryout': 0.55},
    'bellevue': {'delivery': 0.60, 'carryout': 0.40},
    'chicago':  {'delivery': 0.75, 'carryout': 0.25},
}

# ============================================================================
# DEMAND PATTERNS
# ============================================================================


def minute_weights():
    """Generate minute-by-minute demand weights for 24h period."""
    w = np.ones(1440)
    # Lunch peak: 11am-1:30pm
    start_m, end_m = 11 * 60, 13 * 60 + 30
    span = end_m - start_m
    for mi in range(start_m, end_m):
        x = (mi - start_m) / span
        w[mi] += (3.0 - 1) * (math.sin(math.pi * x) ** 2)
    # Dinner peak: 5pm-8pm
    start_m, end_m = 17 * 60, 20 * 60
    span = end_m - start_m
    for mi in range(start_m, end_m):
        x = (mi - start_m) / span
        w[mi] += (3.5 - 1) * (math.sin(math.pi * x) ** 2)
    return w


MINUTE_WEIGHTS = minute_weights()


def minute_weights_sv():
    """Silicon Valley has late-night spike."""
    w = minute_weights()
    start_m, end_m = 21 * 60, 24 * 60
    span = end_m - start_m
    for mi in range(start_m, end_m):
        x = (mi - start_m) / span
        w[mi] += (2.0 - 1) * (math.sin(math.pi * x) ** 2)
    for mi in range(0, 60):
        w[mi] += 1.0
    return w


MINUTE_WEIGHTS_SV = minute_weights_sv()


def day_of_week_multiplier(date: dt.date) -> float:
    """Weekend boost."""
    dow = date.strftime("%a").lower()
    mult = {
        "mon": 1.0, "tue": 1.05, "wed": 1.08, "thu": 1.10,
        "fri": 1.25, "sat": 1.35, "sun": 1.15,
    }
    return mult[dow]


def orders_for_day(day_num: int, location: dict) -> int:
    """Calculate target orders for a given day and location."""
    base = location['base_orders_day']
    growth_rate = location['growth_rate_daily']
    orders = base * ((1 + growth_rate) ** day_num)

    date = dt.date(2024, 1, 1) + dt.timedelta(days=day_num)
    if location['location_code'] != 'sv':
        orders *= day_of_week_multiplier(date)

    orders *= random.uniform(0.9, 1.1)
    return max(1, int(orders))


# ============================================================================
# LIGHTWEIGHT ROUTING (replaces osmnx)
# ============================================================================

# Approximate conversions
MILES_PER_DEG_LAT = 69.0
MILES_PER_DEG_LON_SF = 54.6   # at ~37.7N
MILES_PER_DEG_LON_CHI = 51.5  # at ~41.9N
MILES_PER_DEG_LON_SEA = 47.0  # at ~47.6N

LON_SCALE = {
    'sf': MILES_PER_DEG_LON_SF,
    'sv': MILES_PER_DEG_LON_SF,
    'bellevue': MILES_PER_DEG_LON_SEA,
    'chicago': MILES_PER_DEG_LON_CHI,
}


def haversine_miles(lat1, lon1, lat2, lon2):
    """Haversine distance in miles."""
    R = 3958.8  # Earth radius in miles
    dlat = math.radians(lat2 - lat1)
    dlon = math.radians(lon2 - lon1)
    a = (math.sin(dlat / 2) ** 2 +
         math.cos(math.radians(lat1)) * math.cos(math.radians(lat2)) *
         math.sin(dlon / 2) ** 2)
    return R * 2 * math.asin(math.sqrt(a))


def random_customer_location(store_lat, store_lon, loc_code):
    """Generate a random customer location within delivery radius of the store."""
    lon_scale = LON_SCALE.get(loc_code, MILES_PER_DEG_LON_SF)

    # Random distance (1-4 miles, skewed toward closer)
    dist_miles = np.random.exponential(1.5)
    dist_miles = min(dist_miles, CUSTOMER_RADIUS_MILES)
    dist_miles = max(dist_miles, 0.3)

    angle = np.random.uniform(0, 2 * np.pi)
    dlat = (dist_miles * math.sin(angle)) / MILES_PER_DEG_LAT
    dlon = (dist_miles * math.cos(angle)) / lon_scale

    return store_lat + dlat, store_lon + dlon


def generate_jittered_route(store_lat, store_lon, cust_lat, cust_lon):
    """Generate a route from store to customer with random waypoint jitter.

    Simulates road curvature without needing actual road network data.
    Returns list of (lat, lon) tuples.
    """
    num_waypoints = random.randint(6, 12)
    route = [(store_lat, store_lon)]

    for i in range(1, num_waypoints):
        t = i / num_waypoints
        # Linear interpolation
        lat = store_lat + t * (cust_lat - store_lat)
        lon = store_lon + t * (cust_lon - store_lon)
        # Add perpendicular jitter (simulates road curvature)
        perp_angle = math.atan2(cust_lat - store_lat, cust_lon - store_lon) + math.pi / 2
        jitter_mag = random.gauss(0, 0.002)  # ~0.1 miles
        lat += jitter_mag * math.sin(perp_angle)
        lon += jitter_mag * math.cos(perp_angle)
        route.append((round(lat, 6), round(lon, 6)))

    route.append((cust_lat, cust_lon))
    return route


# ============================================================================
# ITEM SELECTION
# ============================================================================

def _weighted_choice(dist: dict) -> str:
    """Pick a key from a {key: weight} dict."""
    keys = list(dist.keys())
    weights = np.array([dist[k] for k in keys])
    weights = weights / weights.sum()
    return np.random.choice(keys, p=weights)


def select_basket() -> List[Dict]:
    """Select items for a Domino's order."""
    cat = _weighted_choice(CATEGORY_WEIGHTS)
    cat_items = ITEMS_BY_CATEGORY.get(cat, [])
    if not cat_items:
        return []

    items = []
    first = random.choice(cat_items)
    items.append({**first, 'qty': random.randint(1, 2)})

    num_extra = random.choices([0, 1, 2, 3], weights=[0.15, 0.40, 0.30, 0.15])[0]
    used_ids = {first['id']}

    for _ in range(num_extra):
        acc_cat = _weighted_choice(ACCOMPANIMENT_WEIGHTS)
        acc_items = ITEMS_BY_CATEGORY.get(acc_cat, [])
        available = [it for it in acc_items if it['id'] not in used_ids]
        if not available:
            continue
        pick = random.choice(available)
        used_ids.add(pick['id'])
        items.append({**pick, 'qty': random.randint(1, 2)})

    return items


def assign_order_type(loc_code: str) -> Tuple[str, str]:
    """Return (channel, fulfillment) for an order at the given location."""
    channel = _weighted_choice(CHANNEL_DIST[loc_code])
    fulfillment = _weighted_choice(FULFILLMENT_DIST[loc_code])
    return channel, fulfillment


# ============================================================================
# ORDER GENERATION
# ============================================================================

def gauss_time(mean_std: List[float]) -> float:
    """Sample from gaussian, minimum 0.1 minutes."""
    return max(0.1, random.gauss(mean_std[0], mean_std[1]))


def driver_arrival_time(order_ts: dt.datetime, ready_ts: dt.datetime, pickup_ts: dt.datetime) -> dt.datetime:
    """Calculate when driver arrives at kitchen."""
    if random.random() < DRIVER_ARRIVAL['after_ready_pct']:
        base, span = ready_ts, pickup_ts - ready_ts
    else:
        base, span = order_ts, ready_ts - order_ts

    frac = np.random.beta(DRIVER_ARRIVAL['alpha'], DRIVER_ARRIVAL['beta'])
    arrival = base + span * frac

    if arrival >= pickup_ts:
        arrival = pickup_ts - dt.timedelta(microseconds=1)

    return arrival


def generate_random_order_id() -> str:
    """Generate random 6-character alphanumeric order ID."""
    chars = string.ascii_uppercase + string.digits
    return ''.join(random.choice(chars) for _ in range(6))


def generate_order(order_id: str, location: dict, day: int, minute_of_day: int) -> list:
    """Generate one complete order with all events."""
    loc_code = location['location_code']

    items = select_basket()
    if not items:
        return None

    channel, fulfillment = assign_order_type(loc_code)
    is_delivery = (fulfillment == 'delivery')

    if is_delivery:
        customer_lat_f, customer_lon_f = random_customer_location(
            location['lat'], location['lon'], loc_code
        )
        customer_lat_f = round(customer_lat_f, 6)
        customer_lon_f = round(customer_lon_f, 6)
        route_points = generate_jittered_route(
            location['lat'], location['lon'], customer_lat_f, customer_lon_f
        )
        dist_miles = haversine_miles(
            location['lat'], location['lon'], customer_lat_f, customer_lon_f
        )
        # Road distance is ~1.3x straight-line (Manhattan factor)
        road_miles = dist_miles * random.uniform(1.2, 1.5)
        drive_time_min = (road_miles / DRIVER_MPH) * 60
        customer_addr_str = f"{random.randint(1, 9999)} Main St"
    else:
        customer_lat_f = None
        customer_lon_f = None
        route_points = None
        drive_time_min = 0
        customer_addr_str = None

    date = dt.date(2024, 1, 1) + dt.timedelta(days=day)
    order_ts = dt.datetime.combine(date, dt.time(0, 0)) + dt.timedelta(
        minutes=minute_of_day, seconds=random.randint(0, 59)
    )

    ts_started = order_ts + dt.timedelta(minutes=gauss_time(SVC_TIMES["created_to_started"]))
    ts_finished = ts_started + dt.timedelta(minutes=gauss_time(SVC_TIMES["started_to_finished"]))
    ts_ready = ts_finished + dt.timedelta(minutes=gauss_time(SVC_TIMES["finished_to_ready"]))
    ts_pickup = ts_ready + dt.timedelta(minutes=gauss_time(SVC_TIMES["ready_to_pickup"]))

    items_json_str = json.dumps(items)

    events = []
    seq = 0

    def add_event(ts, event_type_id, **kwargs):
        nonlocal seq
        events.append({
            'order_id': order_id,
            'location_id': location['location_id'],
            'event_type_id': event_type_id,
            'ts_seconds': int(ts.timestamp()),
            'sequence': seq,
            **kwargs
        })
        seq += 1

    nulls = dict(
        customer_lat=None, customer_lon=None, customer_addr=None,
        items_json=None, route_json=None, ping_lat=None, ping_lon=None,
        ping_progress=None, channel=None, fulfillment=None,
    )

    # Event 1: order_created
    add_event(order_ts, 1,
              customer_lat=customer_lat_f, customer_lon=customer_lon_f,
              customer_addr=customer_addr_str, items_json=items_json_str,
              route_json=None, ping_lat=None, ping_lon=None, ping_progress=None,
              channel=channel, fulfillment=fulfillment)

    # Event 2: started
    add_event(ts_started, 2, **nulls)

    # Event 3: finished
    add_event(ts_finished, 3, **nulls)

    # Event 4: ready
    add_event(ts_ready, 4, **nulls)

    if is_delivery:
        # Event 5: driver arrived
        ts_arrival = driver_arrival_time(order_ts, ts_ready, ts_pickup)
        add_event(ts_arrival, 5, **nulls)

        # Event 6: picked up (with route)
        add_event(ts_pickup, 6, **{**nulls, 'route_json': json.dumps(route_points)})

        # Event 7: driver pings
        num_pings = max(1, int(drive_time_min * 60 / PING_INTERVAL_SEC))
        for i in range(1, num_pings):
            progress = i / num_pings
            ping_ts = ts_pickup + dt.timedelta(seconds=i * PING_INTERVAL_SEC)
            route_idx = int(progress * (len(route_points) - 1))
            ping_lat_val, ping_lon_val = route_points[route_idx]
            add_event(ping_ts, 7, **{
                **nulls,
                'ping_lat': float(ping_lat_val),
                'ping_lon': float(ping_lon_val),
                'ping_progress': float(progress * 100),
            })

        # Event 8: delivered
        ts_delivered = ts_pickup + dt.timedelta(minutes=drive_time_min)
        add_event(ts_delivered, 8, **{
            **nulls,
            'customer_lat': customer_lat_f,
            'customer_lon': customer_lon_f,
        })
    else:
        # Carryout: customer picks up at store
        add_event(ts_pickup, 6, **nulls)

    return events


# ============================================================================
# MAIN GENERATION LOOP
# ============================================================================

num_locations = len(LOCATIONS)
print(f"\nGenerating {DAYS} days of orders across {num_locations} stores in 4 cities...")

all_events = []
generated_order_ids = set()

for day in range(DAYS):
    if day % 10 == 0:
        print(f"  Day {day}/{DAYS}...")

    for location in LOCATIONS:
        loc_code = location['location_code']
        target_orders = orders_for_day(day, location)

        if loc_code == 'sv':
            mw = MINUTE_WEIGHTS_SV
        else:
            mw = MINUTE_WEIGHTS

        lambda_by_minute = target_orders / mw.sum() * mw

        for minute in range(1440):
            num_orders = np.random.poisson(lambda_by_minute[minute])

            for _ in range(num_orders):
                order_id = generate_random_order_id()
                while order_id in generated_order_ids:
                    order_id = generate_random_order_id()
                generated_order_ids.add(order_id)

                events = generate_order(order_id, location, day, minute)
                if events:
                    all_events.extend(events)

# Count unique orders
unique_orders = len(set(e['order_id'] for e in all_events))
print(f"\nGenerated {unique_orders:,} orders with {len(all_events):,} events")

# ============================================================================
# SAVE TO PARQUET
# ============================================================================

print("\nSaving to parquet files...")

events_df = pd.DataFrame(all_events)

# Optimize dtypes
events_df['location_id'] = events_df['location_id'].astype('int16')
events_df['event_type_id'] = events_df['event_type_id'].astype('int8')
events_df['ts_seconds'] = events_df['ts_seconds'].astype('int64')
events_df['sequence'] = events_df['sequence'].astype('int8')
events_df['customer_lat'] = events_df['customer_lat'].astype('float32')
events_df['customer_lon'] = events_df['customer_lon'].astype('float32')
events_df['ping_lat'] = events_df['ping_lat'].astype('float32')
events_df['ping_lon'] = events_df['ping_lon'].astype('float32')
events_df['ping_progress'] = events_df['ping_progress'].astype('float32')

events_df.to_parquet("canonical_dataset/events.parquet", compression='snappy', index=False)

# Build orders summary table
print("Building orders summary...")
created = events_df[events_df['event_type_id'] == 1].copy()
orders_df = created[['order_id', 'location_id', 'ts_seconds', 'customer_lat', 'customer_lon',
                      'customer_addr', 'items_json', 'channel', 'fulfillment']].copy()
orders_df.to_parquet("canonical_dataset/orders.parquet", compression='snappy', index=False)

# ============================================================================
# SUMMARY
# ============================================================================

import os

print(f"\nDomino's Digital Twin dataset generated successfully!")
print(f"\nDataset summary:")
print(f"  - Orders: {unique_orders:,}")
print(f"  - Events: {len(events_df):,}")
print(f"  - Time period: 90 days (2024-01-01 to 2024-03-30)")
print(f"  - Locations: {num_locations}")
print(f"\nPer-city breakdown:")
for code in ['sf', 'sv', 'bellevue', 'chicago']:
    city_locs = [l['location_id'] for l in LOCATIONS if l['location_code'] == code]
    city_orders = created[created['location_id'].isin(city_locs)]
    print(f"  {code}: {len(city_locs)} stores, {len(city_orders):,} orders")
print(f"\nOrder breakdown:")
print(f"  - Delivery: {(created['fulfillment'] == 'delivery').sum():,}")
print(f"  - Carryout: {(created['fulfillment'] == 'carryout').sum():,}")
print(f"  - Channels: {dict(created['channel'].value_counts())}")
print(f"\nAvg orders/store/day: {unique_orders / num_locations / DAYS:.1f}")
print(f"\nFile sizes:")
events_size = os.path.getsize("canonical_dataset/events.parquet") / 1024 / 1024
orders_size = os.path.getsize("canonical_dataset/orders.parquet") / 1024 / 1024
print(f"  - events.parquet: {events_size:.1f} MB")
print(f"  - orders.parquet: {orders_size:.1f} MB")
