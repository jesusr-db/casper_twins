# Ported from caspers-kitchens at commit 8c756ac on 2026-04-20, then modified
# to filter to San Francisco locations only (Phase 1 scope decision).
# Caspers is retired — this is now the authoritative copy.
# The filter is a single line after generate_locations() returns;
# the original 88-location behavior is recoverable by removing it.

"""
Generate Domino's Pizza dimensional data for the digital twin.
Produces parquet files with identical schemas to the original Casper's Kitchens data.
Phase 1 scope: San Francisco locations only (22 rows).
Run from the data/canonical/ directory; writes into `canonical_dataset/`.
"""

import numpy as np
import pandas as pd

# Reproducible generation
np.random.seed(42)

# ---------------------------------------------------------------------------
# City definitions
# ---------------------------------------------------------------------------

CITIES = [
    {
        "code": "sf",
        "city": "San Francisco",
        "state": "CA",
        "center_lat": 37.7749,
        "center_lon": -122.4194,
        "narrative": "growing",
        "base_orders_mean": 28,
        "base_orders_std": 4,
        "growth_rate_daily_mean": 0.0020,
        "growth_rate_daily_std": 0.0008,
        "trajectory": "growing",
        "growth_rate_monthly_mean": 0.06,
        "neighborhoods": [
            "Mission", "SOMA", "Marina", "Castro", "Sunset",
            "Richmond", "Noe Valley", "Hayes Valley", "Tenderloin", "Potrero Hill",
            "Excelsior", "Bayview", "Bernal Heights", "Dogpatch", "Pacific Heights",
            "Inner Sunset", "Outer Sunset", "North Beach", "Chinatown", "Financial District",
            "Haight-Ashbury", "Glen Park",
        ],
        "streets": [
            "Mission St", "Valencia St", "Market St", "Geary Blvd", "Clement St",
            "Irving St", "Taraval St", "Columbus Ave", "Fillmore St", "Divisadero St",
            "3rd St", "24th St", "Church St", "Folsom St", "Howard St",
            "Judah St", "Noriega St", "Balboa St", "Cortland Ave", "Ocean Ave",
            "Haight St", "Guerrero St",
        ],
    },
    {
        "code": "sv",
        "city": "Silicon Valley",
        "state": "CA",
        "center_lat": 37.3861,
        "center_lon": -122.0839,
        "narrative": "growing_fast",
        "base_orders_mean": 22,
        "base_orders_std": 5,
        "growth_rate_daily_mean": 0.0040,
        "growth_rate_daily_std": 0.0012,
        "trajectory": "growing",
        "growth_rate_monthly_mean": 0.12,
        "neighborhoods": [
            "Palo Alto", "Mountain View", "Sunnyvale", "Santa Clara", "Cupertino",
            "Los Altos", "Milpitas", "Campbell", "Los Gatos", "Saratoga",
            "Menlo Park", "Redwood City", "San Mateo", "Foster City", "Fremont",
            "Newark", "Union City", "Alviso", "Stanford", "East Palo Alto",
            "San Carlos", "Burlingame",
        ],
        "streets": [
            "El Camino Real", "University Ave", "Castro St", "Stevens Creek Blvd",
            "De Anza Blvd", "Middlefield Rd", "San Antonio Rd", "Foothill Expy",
            "Lawrence Expy", "Central Expy", "Bascom Ave", "Winchester Blvd",
            "Santa Cruz Ave", "California Ave", "Page Mill Rd", "Oregon Expy",
            "Alma St", "Fremont Ave", "Saratoga Ave", "Wolfe Rd",
            "Mathilda Ave", "Mary Ave",
        ],
    },
    {
        "code": "bellevue",
        "city": "Seattle",
        "state": "WA",
        "center_lat": 47.6062,
        "center_lon": -122.3321,
        "narrative": "stagnant",
        "base_orders_mean": 25,
        "base_orders_std": 4,
        "growth_rate_daily_mean": 0.0000,
        "growth_rate_daily_std": 0.0006,
        "trajectory": "flat",
        "growth_rate_monthly_mean": 0.00,
        "neighborhoods": [
            "Capitol Hill", "Ballard", "Fremont", "Wallingford", "University District",
            "Queen Anne", "Beacon Hill", "Columbia City", "Greenwood", "Ravenna",
            "Northgate", "Lake City", "Georgetown", "SoDo", "Pioneer Square",
            "Belltown", "First Hill", "International District", "West Seattle", "Rainier Valley",
            "Magnolia", "Eastlake",
        ],
        "streets": [
            "Broadway", "Pike St", "Pine St", "Madison St", "Marion St",
            "Rainier Ave S", "Aurora Ave N", "15th Ave NE", "45th St NE", "Market St NW",
            "MLK Jr Way S", "Beacon Ave S", "California Ave SW", "35th Ave NE", "Greenwood Ave N",
            "Lake City Way NE", "Airport Way S", "1st Ave S", "Denny Way", "Mercer St",
            "Yesler Way", "Eastlake Ave E",
        ],
    },
    {
        "code": "chicago",
        "city": "Chicago",
        "state": "IL",
        "center_lat": 41.8781,
        "center_lon": -87.6298,
        "narrative": "declining",
        "base_orders_mean": 30,
        "base_orders_std": 5,
        "growth_rate_daily_mean": -0.0015,
        "growth_rate_daily_std": 0.0010,
        "trajectory": "declining",
        "growth_rate_monthly_mean": -0.05,
        "neighborhoods": [
            "Lincoln Park", "Wicker Park", "Logan Square", "Lakeview", "Pilsen",
            "Hyde Park", "Bronzeville", "Bucktown", "Humboldt Park", "Uptown",
            "Edgewater", "Rogers Park", "Ravenswood", "Roscoe Village", "Old Town",
            "River North", "West Loop", "South Loop", "Bridgeport", "Chinatown",
            "Andersonville", "Irving Park",
        ],
        "streets": [
            "Clark St", "Halsted St", "Milwaukee Ave", "Ashland Ave", "Western Ave",
            "Damen Ave", "Division St", "North Ave", "Fullerton Ave", "Belmont Ave",
            "Lincoln Ave", "Broadway", "Sheridan Rd", "Lake Shore Dr", "Michigan Ave",
            "State St", "Wabash Ave", "Wells St", "Clybourn Ave", "Armitage Ave",
            "Irving Park Rd", "Montrose Ave",
        ],
    },
]

# Radius in degrees (~5-8 miles) — used for non-SF cities.
SPREAD_LAT = 0.06  # ~4 miles
SPREAD_LON = 0.08  # ~5 miles

# Real SF neighborhood centers — lookup by neighborhood name.
# Keeps named stores on land + in their named neighborhood. Tight jitter
# (~150m) is added so successive generations aren't identical without
# drifting off the peninsula.
SF_NEIGHBORHOOD_COORDS = {
    "Mission":            (37.7599, -122.4148),
    "SOMA":               (37.7785, -122.3997),
    "Marina":             (37.8024, -122.4371),
    "Castro":             (37.7609, -122.4350),
    "Sunset":             (37.7517, -122.4938),
    "Richmond":           (37.7786, -122.4802),
    "Noe Valley":         (37.7502, -122.4337),
    "Hayes Valley":       (37.7772, -122.4251),
    "Tenderloin":         (37.7843, -122.4144),
    "Potrero Hill":       (37.7574, -122.4019),
    "Excelsior":          (37.7240, -122.4310),
    "Bayview":            (37.7316, -122.3893),
    "Bernal Heights":     (37.7383, -122.4152),
    "Dogpatch":           (37.7586, -122.3892),
    "Pacific Heights":    (37.7923, -122.4351),
    "Inner Sunset":       (37.7629, -122.4681),
    "Outer Sunset":       (37.7532, -122.4983),
    "North Beach":        (37.8003, -122.4103),
    "Chinatown":          (37.7941, -122.4078),
    "Financial District": (37.7946, -122.3999),
    "Haight-Ashbury":     (37.7693, -122.4464),
    "Glen Park":          (37.7336, -122.4345),
}
# ~150m of jitter (0.0015° lat ≈ 167m; 0.0015° lon at SF latitude ≈ 132m).
SF_STORE_JITTER_DEG = 0.0015


def generate_locations():
    """Generate ~88 Domino's locations across 4 cities (22 per city).

    Schema: location_id, location_code, name, address, lat, lon,
            narrative, base_orders_day, growth_rate_daily
    """
    locations = []
    loc_id = 1

    for city in CITIES:
        n_stores = len(city["neighborhoods"])  # 22 per city
        # Per-store base orders (gaussian around city mean)
        base_orders = np.random.normal(city["base_orders_mean"], city["base_orders_std"], n_stores)
        base_orders = np.clip(base_orders, 15, 45).astype(int)

        # Per-store growth rates (gaussian around city mean, with jitter)
        growth_rates = np.random.normal(
            city["growth_rate_daily_mean"], city["growth_rate_daily_std"], n_stores
        )

        for i in range(n_stores):
            neighborhood = city["neighborhoods"][i]

            # Prefer real neighborhood coordinates for SF (stops pins landing
            # in the Pacific or the Bay). Non-SF cities keep the random-radius
            # behavior — Phase 1 of twins only uses SF, but the generators
            # remain capable of producing the full 88-location dataset.
            if city["code"] == "sf" and neighborhood in SF_NEIGHBORHOOD_COORDS:
                base_lat, base_lon = SF_NEIGHBORHOOD_COORDS[neighborhood]
                lat = base_lat + np.random.uniform(-SF_STORE_JITTER_DEG, SF_STORE_JITTER_DEG)
                lon = base_lon + np.random.uniform(-SF_STORE_JITTER_DEG, SF_STORE_JITTER_DEG)
            else:
                # Spread stores around city center with random offsets.
                angle = np.random.uniform(0, 2 * np.pi)
                radius_frac = np.sqrt(np.random.uniform(0.05, 1.0))  # sqrt for uniform area distribution
                lat = city["center_lat"] + radius_frac * SPREAD_LAT * np.sin(angle)
                lon = city["center_lon"] + radius_frac * SPREAD_LON * np.cos(angle)
            street = city["streets"][i % len(city["streets"])]
            street_num = np.random.randint(100, 9999)

            # Narrative: most stores inherit city narrative, ~15% deviate
            if np.random.random() < 0.15:
                narratives = ["growing", "growing_fast", "stagnant", "declining"]
                narrative = np.random.choice(narratives)
            else:
                narrative = city["narrative"]

            locations.append({
                "location_id": loc_id,
                "location_code": city["code"],
                "name": f"Domino's #{loc_id} - {neighborhood}",
                "address": f"{street_num} {street}, {city['city']}, {city['state']}",
                "lat": round(lat, 6),
                "lon": round(lon, 6),
                "narrative": narrative,
                "base_orders_day": int(base_orders[i]),
                "growth_rate_daily": round(float(growth_rates[i]), 6),
            })
            loc_id += 1

    return pd.DataFrame(locations)


def generate_brands():
    """Same schema: brand_id, name, cuisine_type, avg_prep_time_min"""
    data = [
        {
            "brand_id": 1,
            "name": "Domino's Pizza",
            "cuisine_type": "Pizza & Delivery",
            "avg_prep_time_min": 12,
        },
    ]
    return pd.DataFrame(data)


def generate_brand_locations(locations_df):
    """Generate brand_location rows for all locations.

    Schema: brand_location_id, brand_id, location_id, start_day, end_day,
            trajectory, growth_rate_monthly
    """
    rows = []
    for _, loc in locations_df.iterrows():
        city = next(c for c in CITIES if c["code"] == loc["location_code"])

        # Per-store trajectory matches narrative
        narrative = loc["narrative"]
        traj_map = {
            "growing": "growing",
            "growing_fast": "growing",
            "stagnant": "flat",
            "declining": "declining",
        }
        trajectory = traj_map.get(narrative, "flat")

        # Growth rate monthly with per-store jitter
        base_monthly = city["growth_rate_monthly_mean"]
        jitter = np.random.normal(0, abs(base_monthly * 0.3) + 0.01)
        growth_monthly = round(base_monthly + jitter, 4)

        rows.append({
            "brand_location_id": int(loc["location_id"]),
            "brand_id": 1,
            "location_id": int(loc["location_id"]),
            "start_day": 0,
            "end_day": None,
            "trajectory": trajectory,
            "growth_rate_monthly": growth_monthly,
        })
    return pd.DataFrame(rows)


def generate_menus():
    """Same schema: id, brand_id, name"""
    data = [
        {"id": 1, "brand_id": 1, "name": "Domino's Pizza Main Menu"},
    ]
    return pd.DataFrame(data)


def generate_categories():
    """Same schema: id, menu_id, brand_id, name"""
    data = [
        {"id": 1, "menu_id": 1, "brand_id": 1, "name": "Specialty Pizzas"},
        {"id": 2, "menu_id": 1, "brand_id": 1, "name": "Build Your Own Pizza"},
        {"id": 3, "menu_id": 1, "brand_id": 1, "name": "Chicken"},
        {"id": 4, "menu_id": 1, "brand_id": 1, "name": "Pasta"},
        {"id": 5, "menu_id": 1, "brand_id": 1, "name": "Sandwiches"},
        {"id": 6, "menu_id": 1, "brand_id": 1, "name": "Bread & Sides"},
        {"id": 7, "menu_id": 1, "brand_id": 1, "name": "Desserts"},
        {"id": 8, "menu_id": 1, "brand_id": 1, "name": "Drinks"},
    ]
    return pd.DataFrame(data)


def generate_items():
    """Same schema: id, category_id, menu_id, brand_id, name, price"""
    data = [
        # Specialty Pizzas (category_id=1)
        {"id": 1, "category_id": 1, "menu_id": 1, "brand_id": 1, "name": "MeatZZa Pizza", "price": 13.99},
        {"id": 2, "category_id": 1, "menu_id": 1, "brand_id": 1, "name": "ExtravaganZZa Pizza", "price": 14.99},
        {"id": 3, "category_id": 1, "menu_id": 1, "brand_id": 1, "name": "Pacific Veggie Pizza", "price": 13.99},
        {"id": 4, "category_id": 1, "menu_id": 1, "brand_id": 1, "name": "Philly Cheese Steak Pizza", "price": 13.99},
        {"id": 5, "category_id": 1, "menu_id": 1, "brand_id": 1, "name": "Buffalo Chicken Pizza", "price": 13.99},
        {"id": 6, "category_id": 1, "menu_id": 1, "brand_id": 1, "name": "Honolulu Hawaiian Pizza", "price": 13.99},
        # Build Your Own Pizza (category_id=2)
        {"id": 7, "category_id": 2, "menu_id": 1, "brand_id": 1, "name": "Hand Tossed Medium", "price": 9.99},
        {"id": 8, "category_id": 2, "menu_id": 1, "brand_id": 1, "name": "Brooklyn Style Large", "price": 11.99},
        {"id": 9, "category_id": 2, "menu_id": 1, "brand_id": 1, "name": "Thin Crust Medium", "price": 9.99},
        {"id": 10, "category_id": 2, "menu_id": 1, "brand_id": 1, "name": "Pan Pizza Medium", "price": 10.99},
        # Chicken (category_id=3)
        {"id": 11, "category_id": 3, "menu_id": 1, "brand_id": 1, "name": "Boneless Chicken", "price": 8.99},
        {"id": 12, "category_id": 3, "menu_id": 1, "brand_id": 1, "name": "Hot Wings", "price": 8.99},
        {"id": 13, "category_id": 3, "menu_id": 1, "brand_id": 1, "name": "BBQ Wings", "price": 8.99},
        # Pasta (category_id=4)
        {"id": 14, "category_id": 4, "menu_id": 1, "brand_id": 1, "name": "Chicken Alfredo Pasta", "price": 7.99},
        {"id": 15, "category_id": 4, "menu_id": 1, "brand_id": 1, "name": "Italian Sausage Marinara", "price": 7.99},
        # Sandwiches (category_id=5)
        {"id": 16, "category_id": 5, "menu_id": 1, "brand_id": 1, "name": "Chicken Parm Sandwich", "price": 7.99},
        {"id": 17, "category_id": 5, "menu_id": 1, "brand_id": 1, "name": "Italian Sandwich", "price": 7.99},
        # Bread & Sides (category_id=6)
        {"id": 18, "category_id": 6, "menu_id": 1, "brand_id": 1, "name": "Breadsticks", "price": 5.99},
        {"id": 19, "category_id": 6, "menu_id": 1, "brand_id": 1, "name": "Cheesy Bread", "price": 6.99},
        {"id": 20, "category_id": 6, "menu_id": 1, "brand_id": 1, "name": "Stuffed Cheesy Bread", "price": 7.99},
        {"id": 21, "category_id": 6, "menu_id": 1, "brand_id": 1, "name": "Bread Twists", "price": 5.99},
        # Desserts (category_id=7)
        {"id": 22, "category_id": 7, "menu_id": 1, "brand_id": 1, "name": "Chocolate Lava Cake", "price": 6.99},
        {"id": 23, "category_id": 7, "menu_id": 1, "brand_id": 1, "name": "Marbled Cookie Brownie", "price": 6.99},
        {"id": 24, "category_id": 7, "menu_id": 1, "brand_id": 1, "name": "Cinnamon Twists", "price": 5.99},
        # Drinks (category_id=8)
        {"id": 25, "category_id": 8, "menu_id": 1, "brand_id": 1, "name": "Coke", "price": 2.49},
        {"id": 26, "category_id": 8, "menu_id": 1, "brand_id": 1, "name": "Diet Coke", "price": 2.49},
        {"id": 27, "category_id": 8, "menu_id": 1, "brand_id": 1, "name": "Sprite", "price": 2.49},
        {"id": 28, "category_id": 8, "menu_id": 1, "brand_id": 1, "name": "Water", "price": 1.99},
        {"id": 29, "category_id": 8, "menu_id": 1, "brand_id": 1, "name": "2-Liter Coke", "price": 3.49},
    ]
    return pd.DataFrame(data)


if __name__ == "__main__":
    out = "canonical_dataset"

    locations = generate_locations()
    # Phase 1 scope: San Francisco locations only (22 rows). Decision 8 in
    # docs/superpowers/specs/2026-04-20-phase1-absorb-events-design.md.
    # To restore the full 88-location dataset, remove this single filter line.
    locations = locations[locations["location_code"] == "sf"].reset_index(drop=True)
    locations.to_parquet(f"{out}/locations.parquet", index=False)
    print(f"locations.parquet: {len(locations)} rows (SF only)")
    print(f"  Cities: {locations['location_code'].value_counts().to_dict()}")
    print(f"  Avg base_orders_day: {locations['base_orders_day'].mean():.1f}")

    brands = generate_brands()
    brands.to_parquet(f"{out}/brands.parquet", index=False)
    print(f"brands.parquet: {len(brands)} rows")

    brand_locations = generate_brand_locations(locations)
    brand_locations.to_parquet(f"{out}/brand_locations.parquet", index=False)
    print(f"brand_locations.parquet: {len(brand_locations)} rows")

    menus = generate_menus()
    menus.to_parquet(f"{out}/menus.parquet", index=False)
    print(f"menus.parquet: {len(menus)} rows")

    categories = generate_categories()
    categories.to_parquet(f"{out}/categories.parquet", index=False)
    print(f"categories.parquet: {len(categories)} rows")

    items = generate_items()
    items.to_parquet(f"{out}/items.parquet", index=False)
    print(f"items.parquet: {len(items)} rows")

    print(f"\nDone. {len(locations)} locations across {len(CITIES)} cities.")
