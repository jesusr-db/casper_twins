# PRD: Digital Twin App — Near-Term Roadmap Features

**App**: Domino's Digital Twin Driver Tracking
**App URL**: https://twins-digital-twin-1351565862180944.aws.databricksapps.com
**Date**: 2026-03-18
**Status**: Implemented

---

## Context

The Digital Twin app is live and fully functional with 4 markets (SF, Palo Alto, Seattle, Chicago), real-time order tracking on a map, KPI bar, pipeline stage bar, and order detail drawer. The next set of features deepens interactivity without changing the data architecture: clicking stages reveals order lists, clicking the store pin reveals store-level health, and market tabs scale gracefully as more stores are added.

---

## Feature 1: Pipeline Stage Drill-Down ✅

### Summary
Clicking a stage in the pipeline bar (New / Kitchen Prep / Ready / In Transit / Delivered) opens a side panel listing all orders in that stage, with key timing info per order.

### Behavior
- **Trigger**: Click a stage badge in `OrderPipeline.tsx`
- **Result**: A slide-in panel (300px, left side of map) lists all orders in that stage
- **Dismiss**: Click the stage again, click X, or open another stage

**Order list item shows:**
- Order ID (abbreviated: `#A3F2`)
- Time in current stage (e.g., "12 min in Kitchen Prep")
- Order total (`$24.50`)
- Status dot: green/yellow/red based on SLA thresholds

**Stage SLA thresholds:**

| Stage | Yellow | Red |
|---|---|---|
| New | >3 min | >8 min |
| Kitchen Prep | >12 min | >20 min |
| Ready | >5 min | >10 min |
| In Transit | >25 min | >40 min |

**Clicking an order in the list**: Opens the `OrderDrawer` for that order.

### Files Changed
- `frontend/src/components/OrderList.tsx` — **New**
- `frontend/src/components/OrderListItem.tsx` — **New**
- `frontend/src/constants/sla.ts` — **New** (shared SLA logic)
- `frontend/src/App.tsx` — Wraps MapView in container, renders OrderList conditionally
- `frontend/src/types/index.ts` — Extended Order with timing fields

---

## Feature 2: Store Detail Panel ✅

### Summary
Clicking the store pin on the map opens a right-rail panel showing that store's operational health: KPIs, stage breakdown, SLA alerts, and recent deliveries.

### Behavior
- **Trigger**: Click the store marker (red D pin) in `MapView.tsx`
- **Result**: A detail panel (320px) slides in from the right
- **Dismiss**: Click store pin again, click X, or open order drawer

**Panel sections:**
1. **Header**: Store name, location code, Live pulse indicator
2. **KPI Grid (2×2)**: Active Orders, Drivers Out, Avg Delivery Time, Today's Revenue
3. **Pipeline Breakdown**: Mini stage bar with counts; clicking sets `selectedStage`
4. **SLA Alerts**: Orders exceeding red thresholds, sorted by severity
5. **Recent Deliveries**: Last 5 delivered orders with time, duration, total

### Conflict Handling
Store panel and `OrderDrawer` share the right rail → mutually exclusive via `rightRailMode: null | "order" | "store"` state.

### Files Changed
- `frontend/src/components/StoreDetailPanel.tsx` — **New**
- `frontend/src/components/MapView.tsx` — Store marker now clickable
- `frontend/src/App.tsx` — rightRailMode state, handleStoreClick, StoreDetailPanel render

---

## Feature 3: Market Tab Grouping by City ✅

### Summary
Markets are grouped by city/region with collapsible sections. Infrastructure for 88-market scale.

### Behavior
- Groups: SF Bay Area (SF + Palo Alto), Pacific Northwest (Seattle), Midwest (Chicago)
- Collapsible group headers with city name + total active orders
- Groups with 1 market render as flat tabs
- Default: all groups expanded

### City Mapping
```typescript
const CITY_GROUPS = {
  sf: "SF Bay Area",
  sv: "SF Bay Area",
  paloalto: "SF Bay Area",
  pa: "SF Bay Area",
  seattle: "Pacific Northwest",
  bellevue: "Pacific Northwest",
  chicago: "Midwest",
  chi: "Midwest",
}
```

### Files Changed
- `frontend/src/components/MarketGroup.tsx` — **New**
- `frontend/src/components/MarketTabs.tsx` — Refactored with groups prop
- `frontend/src/App.tsx` — groupMarketsByCity utility + marketGroups computed

---

## Shared Constants

`frontend/src/constants/sla.ts` — SLA thresholds and helper functions used across Features 1 and 2.

---

## Implementation Notes

- `Order` type in `types/index.ts` extended with `kitchen_started_at`, `driver_arrived_at`, `picked_up_at` to support time-in-stage computation in the list view
- `usePlayback.ts` updated to include new timing fields in mock order objects
- TypeScript strict build passes — 0 errors
- Bundle size: 1006KB (MapLibre GL JS accounts for ~700KB)

---

## Verification Checklist

1. ☐ Click each pipeline stage — list appears with correct orders, counts match stage badge
2. ☐ Click an order in the list — OrderDrawer opens with correct order detail
3. ☐ Click stage again — list dismisses and map filter clears
4. ☐ Click store pin — StoreDetailPanel opens with KPIs matching KPI bar
5. ☐ SLA alerts show correct orders (compare to stage timestamps in order drawer)
6. ☐ Click order in SLA alert list — drawer opens
7. ☐ Click stage in mini-pipeline — OrderList opens, store panel closes
8. ☐ Market tabs: all 4 markets appear under correct city groups
9. ☐ Groups expand/collapse correctly; active orders aggregate per group
10. ☐ Select market from inside a group — market switches, state resets

---

## Out of Scope (Next Milestone)
- Alerting / push notifications for SLA breaches
- Multi-market overview (all-markets zoomed-out map)
- Predictive ETA (ML model)
- Crustopher / Genie analytics tab
- Real store locations (Google Places API)
