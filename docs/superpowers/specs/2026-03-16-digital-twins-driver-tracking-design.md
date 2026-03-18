# Digital Twins & Driver Tracking App — Design Spec

## Overview

A DPZ-branded Databricks App that visualizes a digital twin of Domino's delivery operations. Users see market-level store views with an interactive map showing drivers in real-time, an order pipeline tracking every stage from creation to delivery, and order-level drill-down showing items, lifecycle timeline, and driver route. Supports both live polling and historical playback modes.

**Purpose:** Demo for DPZ stakeholders — "art of the possible" for what a digital twin of their delivery operations could look like on Databricks.

**Databricks products showcased:**
- **Lakeflow** — Streaming pipeline producing the event data
- **Lakebase** — Operational Postgres serving layer for sub-millisecond reads
- **Databricks Apps** — Hosting the full-stack application

## Data Architecture

### Source Tables (Delta — `caspersdev_jmr.lakeflow`)

All tables exist today on the Azure workspace (`adb-984752964297111.11.azuredatabricks.net`).

| Table | Type | Rows | Description |
|---|---|---|---|
| `all_events` | Streaming Table | ~800K | Raw event stream: `order_created`, `gk_started`, `gk_ready`, `gk_finished`, `driver_arrived`, `driver_picked_up`, `driver_ping`, `delivered` |
| `silver_order_items` | Streaming Table | — | Parsed order line items with item name, price, qty, brand_id |
| `gold_order_header` | Streaming Table | ~60K | Order summaries: order_id, location_id, day, revenue, qty, items |
| `gold_location_sales_hourly` | Streaming Table | — | Hourly aggregates per market |

### Event Body Schemas

**`order_created`:**
```json
{
  "customer_lat": 41.905,
  "customer_lon": -87.631,
  "customer_addr": "7189 Main St",
  "items": [{"id": 174, "category_id": 104, "menu_id": 21, "brand_id": 21, "name": "Sausage Deep Dish", "price": 21.99, "qty": 1}]
}
```

**`driver_picked_up`:**
```json
{
  "route_points": [[41.890, -87.632], [41.891, -87.633], ...]
}
```

**`driver_ping`:**
```json
{
  "progress_pct": 72.0,
  "loc_lat": 41.886,
  "loc_lon": -87.662
}
```

### Markets

4 markets, each with multiple virtual brand storefronts. All branded as Domino's for v1.

| Market ID | Code | City | Lat/Lon | Base Orders/Day |
|---|---|---|---|---|
| 1 | sf | San Francisco | 37.791, -122.393 | 150 |
| 2 | sv | Palo Alto | 37.403, -122.111 | 50 |
| 3 | bellevue | Seattle | 47.614, -122.339 | 200 |
| 4 | chicago | Chicago | 41.891, -87.632 | 300 |

### New Streaming Table: `orders_current_state`

Defined as a **Streaming Table within the existing Lakeflow DLT pipeline** (not a standalone Materialized View — MV cannot source from a Streaming Table directly). Collapses the `all_events` stream into one row per order with current status. This is the primary sync target for Lakebase.

The pipeline uses window functions with explicit `ORDER BY ts` to ensure deterministic latest-value selection:

```sql
CREATE OR REFRESH STREAMING TABLE orders_current_state AS
WITH ranked AS (
  SELECT
    order_id,
    location_id,
    event_type,
    body,
    ts,
    CAST(sequence AS INT) as seq,
    ROW_NUMBER() OVER (PARTITION BY order_id ORDER BY ts DESC, CAST(sequence AS INT) DESC) as rn
  FROM STREAM(LIVE.all_events)
),
latest AS (
  SELECT order_id, location_id, event_type as current_stage
  FROM ranked WHERE rn = 1
),
pivoted AS (
  SELECT
    order_id,
    location_id,
    MIN(CASE WHEN event_type = 'order_created' THEN ts END) as created_at,
    MIN(CASE WHEN event_type = 'gk_started' THEN ts END) as kitchen_started_at,
    MIN(CASE WHEN event_type = 'gk_ready' THEN ts END) as kitchen_ready_at,
    MIN(CASE WHEN event_type = 'gk_finished' THEN ts END) as kitchen_finished_at,
    MIN(CASE WHEN event_type = 'driver_arrived' THEN ts END) as driver_arrived_at,
    MIN(CASE WHEN event_type = 'driver_picked_up' THEN ts END) as picked_up_at,
    MIN(CASE WHEN event_type = 'delivered' THEN ts END) as delivered_at,
    -- Deterministic first/last using subqueries with ORDER BY
    (SELECT body FROM ranked r2 WHERE r2.order_id = ranked.order_id AND r2.event_type = 'order_created' ORDER BY ts ASC LIMIT 1) as order_body,
    (SELECT body FROM ranked r2 WHERE r2.order_id = ranked.order_id AND r2.event_type = 'driver_picked_up' ORDER BY ts DESC LIMIT 1) as route_body,
    (SELECT body FROM ranked r2 WHERE r2.order_id = ranked.order_id AND r2.event_type = 'driver_ping' ORDER BY ts DESC LIMIT 1) as latest_ping
  FROM ranked
  GROUP BY order_id, location_id
)
SELECT p.*, l.current_stage
FROM pivoted p JOIN latest l USING (order_id, location_id)
```

**Note:** The exact DLT SQL syntax may need adjustment during implementation. The key requirement is: (1) it lives in the existing Lakeflow pipeline alongside `all_events`, (2) uses deterministic ordering by `ts` + `sequence`, and (3) outputs one row per order with all stage timestamps and the latest ping.

### Lakebase Sync Targets

| Postgres Table | Delta Source | Sync Type | Purpose |
|---|---|---|---|
| `markets` | `simulator.locations` | One-time + on-change | Market metadata with lat/lon |
| `orders` | `orders_current_state` (ST) | Continuous (~5-10s) | Current state per order — the main query target |
| `order_events` | `all_events` | Continuous | Full event history for lifecycle drill-down and playback |

**Note:** The `store_kpis` sync is intentionally omitted. KPI values (active orders, drivers out, avg delivery time, today's revenue) are all derivable from the `orders` table via simple aggregates at query time. This avoids an extra sync dependency.

### Lakebase Schema: `order_events`

Synced from `all_events`. All columns carried over:

| Column | Postgres Type | Notes |
|---|---|---|
| `event_id` | `TEXT` | PK |
| `order_id` | `TEXT` | FK to orders |
| `location_id` | `TEXT` | Market ID — indexed for playback queries |
| `event_type` | `TEXT` | One of 8 event types |
| `body` | `TEXT` | JSON string, parsed by API layer |
| `ts` | `TEXT` | Event timestamp (stored as string in source) |
| `sequence` | `TEXT` | Ordering within an order's event stream |

### Lakebase Schema: `orders`

Synced from `orders_current_state`. Body columns stored as `TEXT` (JSON strings), parsed by the API layer. Using `TEXT` over `JSONB` because these are Lakebase-synced columns and the sync maps Delta STRING → Postgres TEXT.

| Column | Postgres Type | Notes |
|---|---|---|
| `order_id` | `TEXT` | PK |
| `location_id` | `TEXT` | Market ID — indexed |
| `current_stage` | `TEXT` | Latest event type for this order |
| `created_at` | `TEXT` | Timestamp |
| `kitchen_started_at` | `TEXT` | Timestamp (nullable) |
| `kitchen_ready_at` | `TEXT` | Timestamp (nullable) |
| `kitchen_finished_at` | `TEXT` | Timestamp (nullable) |
| `driver_arrived_at` | `TEXT` | Timestamp (nullable) |
| `picked_up_at` | `TEXT` | Timestamp (nullable) |
| `delivered_at` | `TEXT` | Timestamp (nullable) |
| `order_body` | `TEXT` | JSON: customer lat/lon, address, items array |
| `route_body` | `TEXT` | JSON: route_points polyline (nullable) |
| `latest_ping` | `TEXT` | JSON: progress_pct, loc_lat, loc_lon (nullable) |

### Postgres Indexes

Defined in `lakebase_sync_setup.sql` after sync tables are created:

```sql
-- Orders: primary query patterns
CREATE INDEX idx_orders_location_stage ON orders (location_id, current_stage);
CREATE INDEX idx_orders_location_created ON orders (location_id, created_at DESC);

-- Order events: lifecycle drill-down and playback
CREATE INDEX idx_events_order_id ON order_events (order_id, ts);
CREATE INDEX idx_events_location_ts ON order_events (location_id, ts);
```

## API Design (FastAPI Backend)

### Connection & Authentication

FastAPI connects to Lakebase Postgres via `asyncpg` connection pool.

**Lakebase connection mechanism:** When running as a Databricks App, the app has access to the Lakebase database as a configured resource. The connection details are:

- **Host/Port/Database:** Provided via environment variables set in `app.yaml` under the `resources` section, or retrieved at startup via the Databricks SDK (`WorkspaceClient().lakebase.get_database()`). The connection string format is: `postgresql://<user>:<token>@<host>:<port>/<database>?sslmode=require`
- **Authentication:** Uses the Databricks App service principal's OAuth token as the Postgres password. The token is obtained via `WorkspaceClient().config.authenticate()` and refreshed before expiry. The username is the service principal's application ID.
- **Token rotation:** The `asyncpg` connection pool is configured with a custom `init` callback that refreshes the OAuth token on each new connection. Alternatively, a background task refreshes the token every 30 minutes and updates the pool's connect kwargs.
- **Pool size:** Min 2, max 10 connections (sufficient for a demo with 4 markets).

```python
# db.py sketch
import asyncpg
from databricks.sdk import WorkspaceClient

w = WorkspaceClient()

async def get_pool():
    db_info = w.lakebase.get_database(database_name="twins")
    token = w.config.authenticate()
    return await asyncpg.create_pool(
        host=db_info.host, port=db_info.port,
        database=db_info.database_name,
        user=w.config.client_id,
        password=token,
        ssl="require", min_size=2, max_size=10,
    )
```

**Note:** Exact Lakebase SDK API may differ — the implementation should reference the latest `databricks-sdk` Lakebase documentation. The key requirement is: OAuth token auth, SSL required, pool with rotation.

### Endpoints

| Method | Path | Query Params | Returns |
|---|---|---|---|
| `GET` | `/api/markets` | — | All markets with lat/lon, active order count, driver count |
| `GET` | `/api/markets/{id}/orders` | `?status=<stage>` | Orders for a market, filterable by current stage. Returns all orders for the market (full replace on each poll, no delta/since logic — dataset is small enough at ~300 orders/day max). |
| `GET` | `/api/markets/{id}/drivers` | — | Latest driver positions for all active (in-transit) orders in a market |
| `GET` | `/api/orders/{id}` | — | Full order: items, lifecycle timestamps, route polyline, current driver position |
| `GET` | `/api/markets/{id}/kpis` | — | Computed from `orders` table (see KPI Calculations below) |
| `GET` | `/api/playback/{market_id}` | `?start=<ts>&end=<ts>` | Events in time window (max 2-hour window, capped at 5000 rows), sorted by `ts` |

### KPI Calculations

All KPIs are computed from the `orders` table at query time (no separate sync needed):

| KPI | SQL | Notes |
|---|---|---|
| Active Orders | `COUNT(*) WHERE location_id = $1 AND delivered_at IS NULL` | Orders not yet delivered |
| Drivers Out | `COUNT(*) WHERE location_id = $1 AND current_stage IN ('driver_picked_up', 'driver_ping') AND delivered_at IS NULL` | Orders with a driver actively delivering |
| Avg Delivery Time | `AVG(delivered_at - created_at) WHERE location_id = $1 AND delivered_at IS NOT NULL AND created_at::date = CURRENT_DATE` | Today's completed deliveries only |
| Today's Revenue | `SUM(total) WHERE location_id = $1 AND created_at::date = CURRENT_DATE` | Requires parsing `order_body` JSON for item prices × qty. Alternatively, pre-compute `order_total` as a column in the MV. |

**Note:** `order_total` should be added to `orders_current_state` as a derived field (sum of price × qty from `order_body` items array) to avoid JSON parsing at query time.

### ETA Calculation

The order drawer shows ETA and distance remaining. These are **estimated client-side** from the driver ping data:

- `progress_pct` from `latest_ping` gives completion percentage
- `elapsed = now - picked_up_at` gives time since pickup
- `estimated_total = elapsed / (progress_pct / 100)` gives projected total delivery time
- `eta = estimated_total - elapsed` gives remaining time
- `distance_remaining` is estimated from `route_points` polyline length × `(1 - progress_pct/100)`

This is a rough estimate suitable for a demo. The Roadmap section includes a Predictive ETA ML model for production accuracy.

### Playback Logic

The `/playback` endpoint returns events from `order_events` for a given market and time window. **Guardrails:** max 2-hour window, capped at 5,000 rows. If the window exceeds the cap, the API returns the first 5,000 events and a `truncated: true` flag. The frontend replays events client-side at configurable speed (1x, 2x, 5x, 10x) using `requestAnimationFrame` — no server-side timer needed.

### Polling

In live mode, the frontend polls `/orders` and `/drivers` every 3-5 seconds. Each poll fetches the full market state (full replace, not delta merge). Against Lakebase Postgres with indexed queries on `location_id`, this is sub-millisecond per request.

### Map Tiles

MapLibre GL JS requires a vector or raster tile source. The app uses **OpenFreeMap** (`https://tiles.openfreemap.org/styles/liberty`) as the tile style — a free, no-API-key-required tile server based on OpenStreetMap data. If the Databricks App environment restricts outbound internet access, fall back to a self-hosted `pmtiles` file served from the backend's static files directory (a single ~50MB file for the US).

### Error & Loading States

This is a demo app — minimal error handling:
- **Loading:** Skeleton placeholders for map, pipeline, and KPI cards while first poll completes
- **Connection error:** Banner at top: "Unable to reach server — retrying..." with exponential backoff
- **Stale data:** If a poll fails, the UI keeps showing the last successful state (no blank screen)
- **Lakebase sync lag:** Not surfaced in the UI — the 5-10s sync delay is imperceptible for a demo

## Frontend Design (React + MapLibre GL)

### Navigation Hierarchy

1. **Market selector** — Top bar tabs for 4 markets, each with mini KPI badges
2. **Store view** — Main screen: map + order pipeline (split layout)
3. **Order detail** — Slide-up drawer on order click

### Main Store View Layout

**Top bar:**
- Market tabs (SF, Palo Alto, Seattle, Chicago) — active tab highlighted in Domino's red
- KPI cards: Active Orders, Drivers Out, Avg Delivery Time, Today's Revenue
- Live/Playback toggle + speed control (top right)

**Center (map):**
- MapLibre GL JS map centered on selected market
- Store marker: Domino's-styled pin at market lat/lon
- Driver markers: Labeled with order ID, colored by delivery progress
  - Red (#E31837) = actively delivering (has `driver_picked_up` event, no `delivered` yet, progress < 100%)
  - Green (#4CAF50) = delivered (has `delivered` event, shown briefly before fading out)
  - Note: There is no "returning/idle" state in the data model — drivers only exist while associated with an order. Once delivered, the marker fades after 10 seconds.
- Route polylines: Drawn from `route_points` in `driver_picked_up` event body
- Customer pins: Yellow markers at delivery addresses
- Driver positions animate along routes as pings arrive (interpolated)

**Bottom bar:**
- Horizontal order pipeline: New → Kitchen Prep → Ready → In Transit → Delivered
- Each stage shows count badge with stage-specific color
- Click a stage to filter the map to orders in that stage

**Order drawer (slides up from bottom):**
- Order ID, total price, time since placed
- Item list with quantities and prices
- Lifecycle timeline: Horizontal dot-and-line visualization showing each stage with timestamp
- Driver card: ID, progress %, ETA, distance remaining
- Click "Follow Driver" to zoom map and track movement

### Linked Interaction

- Click order in pipeline → highlights driver on map, draws route, opens drawer
- Click driver on map → opens order drawer for that driver's order
- Click pipeline stage → filters map to show only orders in that stage
- Playback scrubber → all elements (map, pipeline, drawer) update to that point in time

### Playback Mode

When toggled to Playback:
- KPI bar is replaced by a timeline scrubber spanning the selected time range
- Play/Pause button, speed selector (1x, 2x, 5x, 10x)
- Drag scrubber to any point — map, pipeline, and all data update to that moment
- Orders appear/disappear and drivers animate along routes as time advances

### DPZ Branding

- **Primary:** Domino's Red `#E31837`
- **Secondary:** Domino's Blue `#006491`
- **Accent:** White `#FFFFFF`
- **Background:** Dark navy `#0B1D3A` (operational/mission-control feel with DPZ colors)
- **Stage colors:** Yellow (New) → Orange (Kitchen) → Blue (Ready) → Red (In Transit) → Green (Delivered)
- **Typography:** System font stack, clean and modern
- Domino's logo in top-left corner of the app

## Tech Stack

| Layer | Technology | Notes |
|---|---|---|
| Frontend | React 18 + TypeScript | SPA with Vite build |
| Map | MapLibre GL JS | Open-source, no API key needed |
| Backend | FastAPI + asyncpg | Async Python, connection pooling |
| Database | Lakebase (Postgres) | Synced from Delta tables |
| Sync | Lakebase Sync Pipeline | Delta → Postgres continuous sync |
| Pipeline | Lakeflow (existing) | Streaming tables already producing data |
| Hosting | Databricks Apps | Deployed via Asset Bundle |

## Deployment Configuration

### `app.yaml`

```yaml
command:
  - uvicorn
  - backend.main:app
  - --host=0.0.0.0
  - --port=8000

env:
  - name: LAKEBASE_DATABASE
    value: twins
  - name: LAKEBASE_CATALOG
    value: caspersdev_jmr

resources:
  - name: twins-lakebase
    type: lakebase_database
    database_name: twins
```

FastAPI serves the React production build as static files from `frontend/dist/` via `StaticFiles` mount. The Vite build output is committed or built during deployment.

### `databricks.yml`

```yaml
bundle:
  name: twins-digital-twin

workspace:
  profile: azure

resources:
  apps:
    twins-app:
      name: twins-digital-twin
      source_code_path: .
      config:
        command:
          - uvicorn
          - backend.main:app
          - --host=0.0.0.0
          - --port=8000
```

Deployed via `databricks bundle deploy -p azure`.

## Project Structure

```
twins/
├── app.yaml                           # Databricks App config
├── databricks.yml                     # Asset Bundle for deployment
├── backend/
│   ├── main.py                        # FastAPI app, static file serving
│   ├── db.py                          # Lakebase Postgres connection pool
│   ├── routes/
│   │   ├── markets.py                 # Market list + KPIs
│   │   ├── orders.py                  # Order queries + detail
│   │   ├── drivers.py                 # Driver position queries
│   │   └── playback.py               # Time-window event replay
│   └── requirements.txt
├── frontend/
│   ├── package.json
│   ├── vite.config.ts
│   ├── src/
│   │   ├── App.tsx                    # Root component, routing
│   │   ├── components/
│   │   │   ├── MarketTabs.tsx         # Market selector with KPI badges
│   │   │   ├── KpiBar.tsx            # Active orders, drivers, avg time, revenue
│   │   │   ├── MapView.tsx           # MapLibre GL map with markers/routes
│   │   │   ├── OrderPipeline.tsx     # Horizontal stage pipeline
│   │   │   ├── OrderDrawer.tsx       # Slide-up order detail with lifecycle
│   │   │   ├── DriverMarker.tsx      # Animated driver marker component
│   │   │   └── PlaybackControls.tsx  # Timeline scrubber, speed selector
│   │   ├── hooks/
│   │   │   ├── usePolling.ts         # Configurable interval polling
│   │   │   └── usePlayback.ts        # Client-side event replay engine
│   │   └── styles/
│   │       └── dominos-theme.css     # DPZ color palette, typography
├── pipelines/
│   ├── orders_materialized_view.sql  # Delta MV: collapsed order state
│   └── lakebase_sync_setup.sql       # Lakebase sync pipeline definitions
└── docs/
    └── superpowers/
        └── specs/
            └── this file
```

## Roadmap (Out of Scope for v1)

### Operations & Map
- **Pipeline stage drill-down** — Click any stage (New / Kitchen / Ready / In Transit / Delivered) to see the filtered order list with per-order timing details and SLA indicators
- **Store detail panel** — Click a store tab to open a full store view: live KPIs, active alerts, order list, and avg time-per-stage breakdown
- **Market tab grouping** — Group the 88 store tabs by city (SF / Palo Alto / Seattle / Chicago) instead of a flat list
- **Multi-market overview** — Zoomed-out map view showing all markets simultaneously with aggregate KPIs
- **Multi-brand storefronts** — Show individual virtual kitchen brands per market instead of all-Domino's branding

### Intelligence & Optimization
- **Driver assignment optimization** — Suggest optimal driver-to-order matching using real-time order and driver state
- **Predictive ETA** — ML model for delivery time estimation, replacing the client-side progress_pct heuristic
- **Alerting** — Late delivery warnings, kitchen bottleneck detection, SLA breach notifications surfaced per store

### Analytics Tab (per store)
- **Store scorecard** — Historical performance view per location: delivery time trends, on-time %, order volume, revenue, kitchen throughput, driver utilization; benchmarked against market and network averages
- **Crustopher chatbot** — Conversational AI assistant embedded in the store analytics tab; answers natural language questions about store performance ("Why was delivery time up yesterday?", "Which items are slowest to prep?")
- **Genie integration** — Databricks Genie space connected to the store's order and event data; allows ad-hoc SQL-backed exploration directly in the app tab

### Data & Integrations
- **Casper's Kitchen full integration** — Connect refund manager, loyalty module, inventory, and other Casper's Kitchen components into the event stream and surface in the ops view (e.g., refund events on order timeline, inventory alerts per store)
- **Real store locations** — Replace simulated lat/lon with actual Domino's store addresses from Google Places API; display real store names, addresses, and Google Reviews ratings on the store detail panel
- **Historical analytics** — Daily/weekly trend dashboards showing performance over time per store and market
