# Customer Experience Panel — Design Spec

**Date**: 2026-03-19
**Feature**: Customer Experience Panel (`/cx`)
**Status**: Approved for implementation

---

## Overview

A new standalone panel in the Digital Twin app for monitoring customer experience metrics — complaints and refund recommendations — across all stores and per-store. The panel is entirely read-only. Offers & Coupons are explicitly out of scope for this build.

**Data sources confirmed (100% join rate to order stream):**
- `vdm_classic_rikfy0_catalog.complaints.raw_complaints` — 48,939 records, 5 categories, 1 per order, ~9.6% of all orders. `ts` column is native TIMESTAMP (not string).
- `vdm_classic_rikfy0_catalog.recommender.refund_recommendations` — 321,572 records, AI-generated refund class + dollar amount + reason, 1 per order. `order_ts` is native TIMESTAMP. `agent_response` is a JSON **string** column — all field access in Lakebase (Postgres) must use `::json->>'field'` cast syntax (e.g., `agent_response::json->>'refund_usd'`). Do NOT use Spark `:` accessor syntax.

---

## Navigation

- New top-level route: `/cx`
- New **CX** tab in the main nav bar alongside the existing map/pipeline views
- Two views within the panel: **Global** (default) and **Store Detail**
- Store detail breadcrumb: `← Customer Experience / <Store Name>`
- Browser back or breadcrumb click returns to Global view

### Prerequisites

React Router is not yet wired into the app. Before implementing the CX panel, the following must be done as a prerequisite task:

1. Install `react-router-dom`
2. Wrap `App.tsx` root in `<BrowserRouter>`
3. Define routes: `/` (map view) and `/cx` (CX panel)
4. Add `useSearchParams` to the map view — when `?order=<id>` is present on mount, call `handleDriverClick(orderId)` (the existing function that sets `selectedOrderId` and opens the Order Drawer) to enable deep-linking from CX panel

---

## Global View

### KPI Row (4 cards)

| Card | Value |
|---|---|
| Total Complaints | Count of complaints in selected period |
| Complaint Rate | complaints / orders (%) |
| Total Refund Exposure | Sum of `refund_usd` where `refund_class != 'none'` |
| Avg Refund per Complaint | Mean `refund_usd` across partial + full refunds |

### Filter Bar

Applies to the store table below. Three filters:

1. **Market** — dropdown matching existing `MarketGroup` city groupings (All / SF Bay Area / etc.). Applied **client-side** — the summary endpoint returns all stores and the frontend filters the table by the selected market's `location_id` set.
2. **Category** — `delivery_delay` / `missing_items` / `food_quality` / `service_issue` / `other` / All. Sent as a query param to the backend.
3. **Date range** — Last 7d / Last 30d / Last 90d / All time (applied against `oe.created_at`)

### Store Table

Sortable by any column. Default sort: Complaint Rate descending.

| Column | Notes |
|---|---|
| Store | Name + location code from `simulator.locations_synced` |
| Orders | Total orders in period for this location |
| Complaints | Count of matched complaints |
| Complaint Rate | Color-coded: red >10%, yellow 7–10%, green <7% |
| Refund Exposure | Sum of `agent_response::json->>'refund_usd'` for this store |
| Top Category | Most frequent `complaint_category` for this store |

Clicking any row navigates to the **Store Detail** view for that store.

---

## Store Detail View

Reached by clicking a store row in the Global view.

### Header

- Breadcrumb: `← Customer Experience / <Store Name>`
- Store-level KPI row (same 4 cards as global, scoped to this store)

### Tabs: Overview · Complaints · Refunds

---

### Overview Tab

2×2 grid layout below the KPI row.

| Quadrant | Content |
|---|---|
| Top-left | **Complaint Trend** — bar chart, complaints per day, last 30 days |
| Top-right | **Category Breakdown** — horizontal bar chart, % share per category |
| Bottom-left | **Refund Class Split** — stacked bar (partial / none / full) |
| Bottom-right | **Top 5 Impacted Customers** — name, `is_loyalty_member` badge, complaint count |

---

### Complaints Tab

**Filter bar**: Category (same options as global) + Date range

**Table columns** (paginated, 50 rows/page):

| Column | Notes |
|---|---|
| Order ID | Linked — navigates to `/?order=<id>`, opening Order Drawer |
| Category | Color-coded badge |
| Complaint Text | Truncated to 80 chars; full text on row hover/expand |
| Date | `complaints.ts` formatted as date + time |
| Refund $ | `agent_response::json->>'refund_usd'`; blank if no refund record |
| Refund Class | Badge: partial (amber) / full (green) / none (muted) / — if no record |

---

### Refunds Tab

**Filter bar**: Refund Class (partial / full / none / error) + Date range

**Table columns** (paginated, 50 rows/page):

| Column | Notes |
|---|---|
| Order ID | Linked — same deep-link behavior as Complaints tab |
| Refund Class | Badge: partial (amber) / full (green) / none (muted) / error (red) |
| Refund $ | `agent_response::json->>'refund_usd'` |
| AI Reason | `agent_response::json->>'reason'` truncated to 100 chars; full text on hover/expand |
| Order Date | `refund_recommendations.order_ts` |

> **Note on data freshness**: `refund_recommendations_synced` uses SNAPSHOT sync policy. Refund recommendations are batch-generated and sync latency is acceptable for this use case. The UI should display a "Refund data as of [last sync time]" indicator below the Refunds tab filter bar. Last sync time is available from the Databricks synced table metadata.

---

## Data Layer

### New Lakebase Syncs (2)

| Source (Unity Catalog) | Synced Table (Lakebase) | Policy | PK |
|---|---|---|---|
| `complaints.raw_complaints` | `complaints.complaints_synced` | CONTINUOUS | `complaint_id` |
| `recommender.refund_recommendations` | `recommender.refund_recommendations_synced` | SNAPSHOT | `order_id` |

Added to `setup/config.py` SYNCS list. Lakebase schemas (`complaints`, `recommender`) created via `create_syncs.py` as part of standard provisioning.

The following indexes must be added to `INDEX_SQL` in `setup/config.py`:

```sql
CREATE INDEX IF NOT EXISTS idx_complaints_order_id
  ON complaints.complaints_synced (order_id);

CREATE INDEX IF NOT EXISTS idx_refunds_order_id
  ON recommender.refund_recommendations_synced (order_id);
```

These are required for performant joins against `orders_enriched_synced` on `order_id`.

### New Backend Endpoints (4)

All use `asyncpg` with `$N` parameterized queries.

---

#### `GET /api/cx/summary`

Query params: `category` (optional), `days` (int, default 30). Backend must validate `days` as a positive integer before passing to SQL — use `make_interval(days => $N::int)`, never string concatenation.

Market filtering is handled **client-side** — the endpoint returns all stores, and the frontend filters by the selected market's location IDs.

Category filter is applied in the **LEFT JOIN condition** (not the WHERE clause) to avoid converting the outer join to an inner join and corrupting the complaint rate denominator:

```sql
SELECT
  oe.location_id,
  loc.name,
  loc.location_code,
  COUNT(DISTINCT oe.order_id)                                              AS orders,
  COUNT(DISTINCT c.complaint_id)                                           AS complaints,
  ROUND(COUNT(DISTINCT c.complaint_id) * 100.0
    / NULLIF(COUNT(DISTINCT oe.order_id), 0), 1)                           AS complaint_rate,
  COALESCE(SUM(
    CASE WHEN rr.agent_response::json->>'refund_class' != 'none'
         THEN (rr.agent_response::json->>'refund_usd')::numeric END), 0)   AS refund_exposure,
  MODE() WITHIN GROUP (ORDER BY c.complaint_category)                      AS top_category
FROM lakeflow.orders_enriched_synced oe
JOIN simulator.locations_synced loc ON oe.location_id = loc.location_id
LEFT JOIN complaints.complaints_synced c
       ON c.order_id = oe.order_id
      AND ($2::text IS NULL OR c.complaint_category = $2)
LEFT JOIN recommender.refund_recommendations_synced rr ON rr.order_id = oe.order_id
WHERE oe.created_at >= NOW() - make_interval(days => $1::int)
GROUP BY oe.location_id, loc.name, loc.location_code
```

**Response shape**:

```json
{
  "kpis": {
    "total_complaints": 0,
    "complaint_rate": 0.0,
    "refund_exposure": 0.0,
    "avg_refund": 0.0
  },
  "stores": [
    {
      "location_id": 0,
      "name": "",
      "location_code": "",
      "orders": 0,
      "complaints": 0,
      "complaint_rate": 0.0,
      "refund_exposure": 0.0,
      "top_category": ""
    }
  ]
}
```

---

#### `GET /api/cx/stores/{location_id}`

Query params: `days` (int, default 30). Returns store-level KPIs + chart data for the Overview tab. The `days` param should match whatever the user had selected in the global filter bar when they drilled in.

**Response shape**:

```json
{
  "kpis": {
    "total_complaints": 0,
    "complaint_rate": 0.0,
    "refund_exposure": 0.0,
    "avg_refund": 0.0
  },
  "trend": [
    { "date": "2026-03-19", "complaints": 0 }
  ],
  "category_breakdown": [
    { "category": "delivery_delay", "count": 0, "pct": 0.0 }
  ],
  "refund_class_split": [
    { "refund_class": "partial", "count": 0 },
    { "refund_class": "none", "count": 0 },
    { "refund_class": "full", "count": 0 }
  ],
  "top_customers": [
    {
      "customer_id": "",
      "name": "",
      "is_loyalty_member": false,
      "complaint_count": 0
    }
  ]
}
```

> **Note on `is_loyalty_member`**: matches the `is_loyalty_member: boolean` field in the existing `CustomerInfo` type — use the same field name throughout.

Top customers join: `complaints_synced → orders_enriched_synced → customer_address_index_synced → customers_synced` using the existing address-rounding pattern. Full SQL skeleton:

```sql
SELECT
  cust.customer_id,
  cust.name,
  cust.is_loyalty_member,
  COUNT(c.complaint_id) AS complaint_count
FROM complaints.complaints_synced c
JOIN lakeflow.orders_enriched_synced oe ON c.order_id = oe.order_id
JOIN simulator.customer_address_index_synced ai
  ON ROUND(CAST((oe.order_body::json)->>'customer_lat' AS numeric), 3) = ai.rounded_lat
 AND ROUND(CAST((oe.order_body::json)->>'customer_lon' AS numeric), 3) = ai.rounded_lon
JOIN simulator.customers_synced cust ON ai.customer_id = cust.customer_id
WHERE oe.location_id = $1
  AND oe.created_at >= NOW() - make_interval(days => $2::int)
GROUP BY cust.customer_id, cust.name, cust.is_loyalty_member
ORDER BY complaint_count DESC
LIMIT 5
```

---

#### `GET /api/cx/stores/{location_id}/complaints`

Query params: `category` (optional), `days` (int, default 30), `page` (int, default 1)

Returns complaints left-joined to refund_recommendations. Used by the **Complaints tab**.

**Response shape**:

```json
{
  "total": 0,
  "page": 1,
  "page_size": 50,
  "rows": [
    {
      "complaint_id": "",
      "order_id": "",
      "category": "",
      "complaint_text": "",
      "ts": "",
      "refund_usd": null,
      "refund_class": null
    }
  ]
}
```

---

#### `GET /api/cx/stores/{location_id}/refunds`

Query params: `refund_class` (optional), `days` (int, default 30), `page` (int, default 1)

Returns refund_recommendations left-joined to complaints. Used by the **Refunds tab**.

**Response shape**:

```json
{
  "total": 0,
  "page": 1,
  "page_size": 50,
  "last_sync_ts": "2026-03-19T12:00:00Z",
  "rows": [
    {
      "order_id": "",
      "refund_class": "",
      "refund_usd": 0.0,
      "reason": "",
      "order_ts": ""
    }
  ]
}
```

`last_sync_ts` is retrieved by the backend via:
```sql
SELECT MAX(order_ts) FROM recommender.refund_recommendations_synced
```
This is the most recent record timestamp, used as a proxy for sync freshness. The frontend displays "Refund data as of &lt;last_sync_ts&gt;" below the Refunds tab filter bar.

---

## Frontend Components

New directory: `frontend/src/components/cx/`

| File | Responsibility |
|---|---|
| `CXPanel.tsx` | Top-level route component; owns filter state, selected store, navigation |
| `CXGlobalView.tsx` | KPI bar + filter bar + store table |
| `CXStoreDetail.tsx` | Breadcrumb + tab container + store KPI bar |
| `CXOverviewTab.tsx` | 2×2 dashboard grid (trend, category, refund split, top customers) |
| `CXComplaintsTab.tsx` | Filterable complaints table with order deep-link |
| `CXRefundsTab.tsx` | Filterable refunds table with order deep-link |

New TypeScript types (added to `frontend/src/types/index.ts`):
- `CXStoreSummary` — store row shape from `/api/cx/summary`
- `CXStoreDetailResponse` — full store detail response shape (named `Response` to distinguish from the `CXStoreDetail.tsx` component)
- `CXComplaintRow` — row shape from `/api/cx/stores/{id}/complaints`
- `CXRefundRow` — row shape from `/api/cx/stores/{id}/refunds`

### Order Deep-Link

```ts
// In CXComplaintsTab.tsx and CXRefundsTab.tsx
import { useNavigate } from 'react-router-dom';
const navigate = useNavigate();
// On Order ID click:
navigate(`/?order=${orderId}`);
```

The map view (`App.tsx`) reads `?order` on mount via `useSearchParams` and calls `handleDriverClick(orderId)` — the existing function that sets `selectedOrderId` and opens the Order Drawer.

### Styling

Follows existing CSS variable system (`--dpz-red`, `--surface-card`, etc.). Component-scoped styles via `document.createElement("style")` (consistent with existing pattern). No new dependencies beyond `react-router-dom`.

---

## Out of Scope

- **Offers & Coupons** — deferred; no promotions/offers data source exists yet
- **Write operations** — no refund processing, complaint resolution, or status updates
- **Real-time polling** — CX panel loads on navigation; no auto-refresh (complaints/refunds are not latency-sensitive)
- **Export** — no CSV download in this build

---

## Open Questions (resolved)

| Question | Decision |
|---|---|
| Offers & Coupons scope | Out of scope — revisit when offer/promo data exists |
| Store drill-down pattern | Full page with tabs (Overview / Complaints / Refunds) |
| Overview tab layout | 2×2 dashboard grid (trend + category + refund split + top customers) |
| Global panel layout | KPI row + filter bar + sortable store table |
| Order deep-link | Requires React Router wiring as prerequisite task |
| Refund data freshness | SNAPSHOT sync; UI shows "data as of [last sync]" note |
| SQL join direction | Drives from `orders_enriched_synced` for correct complaint rate denominator |
