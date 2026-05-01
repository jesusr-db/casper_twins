# Store Operations Panel — Design

**Date**: 2026-04-20
**Status**: Approved — ready for implementation planning
**Scope**: v1 — live chain-wide operations dashboard at `/operations`

---

## Goal

A full-page "Store Operations" view that gives a live, chain-wide snapshot of the delivery operation — revenue, orders, kitchen, drivers, customers, loyalty — with a multi-select store filter and a sortable per-store leaderboard. Accessible from a new top-nav, and from the existing map's `StoreDetailPanel` via a "View in Operations" button.

## Non-goals (v1)

- 7-day / 30-day trend charts
- StoreOps AI conversational tab (tracked separately in `docs/roadmap-storeops-ai.md`)
- Rich per-store drill-in (recent orders list, kitchen queue detail, customer cohort list) — filter=1 store recomputes the same six sections against that one store
- Saved views / pinned stores / user preferences
- CSV / export
- Alerts / SLA breach notifications
- Playback-mode cursor integration (read `MAX(ts)` as "now" same as other routes, but playback scrubbing isn't wired to this route)

## Architecture

### Routing

- Add `react-router-dom` `<Routes>` inside `App.tsx`:
  - `/` — existing map layout (MarketTabs + KpiBar + MapView + right-rail)
  - `/operations` — new `<OperationsPage />`
- Render a new `<TopNav />` once, above `<Routes />`, with `Map · Operations` pills.
- `MarketTabs` and `KpiBar` render only on `/`. `/operations` owns its full page below the top-nav.
- `activeMarketId` and `rightRailMode` stay at `App` level so cross-route navigation preserves them.

### Filter state

The store filter is URL-driven:

- `/operations` → cohort = all stores
- `/operations?stores=123,456` → cohort = those stores

`StoreFilter` reads/writes `?stores=` via `useSearchParams`. Leaderboard row clicks, "View in Operations" button, and filter pill interactions all update the URL. Back-button and link sharing work.

### Cross-route link

Add one button to `frontend/src/components/StoreDetailPanel.tsx` header:

```
[ View in Operations → ]   onClick = navigate(`/operations?stores=${location_id}`)
```

---

## Backend

### New file

`backend/routes/operations.py`

### Endpoint

```
GET /api/operations/dashboard?stores=<comma-separated location_ids>
```

- `stores` is optional. Empty / omitted = all stores in the current cohort (22 SF stores today).
- Response is atomic — one composite payload — so every section reflects the same moment in time.

### Response shape

```jsonc
{
  "cohort": {
    "store_count": 22,
    "store_ids": ["1", "2", ...]
  },
  "headline": {
    "revenue_today": 12480.00,        // SUM(order_total) WHERE delivered_at >= sim-day start
    "orders_active": 147,              // WHERE delivered_at IS NULL
    "drivers_out": 89,                 // COUNT DISTINCT order_id in driver_positions, 2h window
    "kitchens_busy": { "n": 18, "of": 22 },
    "avg_delivery_min": 24.0,          // AVG(delivered_at - picked_up_at), today, delivered only
    "sla_health_pct": 94.0             // % of active orders in green SLA (see sla.ts thresholds)
  },
  "pipeline": {                        // counts across the cohort
    "new": 34,
    "kitchen": 58,
    "ready": 22,
    "transit": 89,
    "delivered_today": 312
  },
  "kitchen": {
    "in_kitchen": 58,                  // kitchen_started_at IS NOT NULL AND kitchen_finished_at IS NULL
    "ready_waiting": 22,               // kitchen_finished_at IS NOT NULL AND picked_up_at IS NULL
    "backlogged_stores": 4,            // stores with >= 5 orders in_kitchen
    "avg_kitchen_min": 6.2             // AVG(kitchen_finished_at - kitchen_started_at), today
  },
  "customers": {
    "unique_today": 312,               // DISTINCT customer_id matched today
    "avg_order_value": 39.90,
    "top_personas": [                  // top 3 by share of matched customers today
      { "name": "Family Night", "pct": 28.0 },
      { "name": "Late Crew",     "pct": 19.0 },
      { "name": "Solo Snacker",  "pct": 14.0 }
    ]
  },
  "loyalty": {
    "loyalty_order_pct": 64.0,         // % of matched-customer orders where is_loyalty_member
    "points_earned_today": 8240,       // synthetic: SUM(loyalty_points increment) — see "metric definitions"
    "avg_coupon_propensity": 0.58
  },
  "leaderboard": [
    {
      "location_id": "1",
      "location_code": "sf-mission",
      "name": "SF — Mission St",
      "active_orders": 12,
      "drivers_out": 7,
      "revenue_today": 820.00,
      "avg_delivery_min": 22.0,
      "in_kitchen": 4,                 // orders currently being cooked
      "sla_status": "green"            // "green" | "yellow" | "red"
    }
    // ... one row per store in cohort, default sort: active_orders DESC
  ]
}
```

### SQL strategy

One FastAPI handler, four Lakebase queries in parallel via `asyncio.gather`:

- **Query A** — headline + pipeline + kitchen aggregates + loyalty order pct. Single aggregation over `lakeflow.orders_enriched_synced` filtered by cohort, joined to `simulator.customers_synced` (via `customer_address_index_synced`) for the loyalty flag.
- **Query B** — customers today (unique matched customers, AOV, top personas). Same join chain, different aggregates.
- **Query C** — loyalty points earned today + avg coupon propensity. Same join chain.
- **Query D** — leaderboard (per-store roll-up). `GROUP BY location_id`.

All queries use parameterized `location_id = ANY($1::text[])` with `NULL` meaning "all". All queries apply the 24h sim-time filter used elsewhere (see `routes/orders.py`) to exclude loop-duplicate replays.

### Metric definitions (canonical)

- **"Today"** = from start of the simulator's current sim-day (floor of `MAX(ts)` in `all_events_synced` to midnight).
- **`delivered_at IS NOT NULL`** always wins over `current_stage` (DLT sync lag — see CLAUDE.md).
- **`kitchens_busy`** = count of stores with `>= 1` order where `kitchen_started_at IS NOT NULL AND kitchen_finished_at IS NULL`.
- **`backlogged_stores`** = stores with `>= 5` orders in `in_kitchen` state.
- **`sla_health_pct`** = active orders in "green" SLA state ÷ total active orders. SLA thresholds (minutes-per-stage before yellow / red) are currently defined only in `frontend/src/constants/sla.ts`. For v1 the backend duplicates the constant block in `backend/routes/operations.py` with a `# keep in sync with frontend/src/constants/sla.ts` comment. A shared source (e.g., a small JSON file imported by both) is out of scope for v1 but noted as follow-up.
- **Per-store `sla_status`** (leaderboard column) = red if any active order at that store is red; else yellow if any is yellow; else green. Empty store (no active orders) = green.
- **`points_earned_today`** = sum of a synthetic per-order loyalty point increment. v1 formula: `FLOOR(order_total)` for orders where `is_loyalty_member = true`. Documented in code; open to revision.
- **Customer match** — via rounded lat/lon through `customer_address_index_synced`. Some orders won't match. All customer/loyalty section numbers are denominated by **matched** customers, not all orders. UI labels this ("matched customers today") so numbers aren't mis-read as chain totals.

### Caching / freshness

None for v1. 5-second poll from the frontend is fine against Lakebase primary for the ≤22-store cohort. Each query is expected to complete < 250ms.

---

## Frontend

### File tree

```
frontend/src/
  pages/
    OperationsPage.tsx              # route — orchestrates fetch + section render
  components/
    TopNav.tsx                      # Map · Operations pill bar
    operations/
      StoreFilter.tsx               # multi-select pill row, URL-driven
      HeadlineKpis.tsx              # 6-tile row
      ChainPipeline.tsx             # all-stores stage bar
      KitchenPanel.tsx
      CustomersPanel.tsx
      LoyaltyPanel.tsx
      StoreLeaderboard.tsx          # sortable table
  hooks/
    useOperationsDashboard.ts       # 5s poll-after-completion wrapper
  types/
    index.ts                        # add OperationsDashboard, StoreLeaderboardRow, PersonaBreakdown
```

### State model

- **Filter state** → URL (`useSearchParams`). Single source of truth. Default (no `stores` param) = all stores.
- **Dashboard data** → `useOperationsDashboard(storeIds)` returns `{ data, isLoading, error }`. Internally uses the same setTimeout-loop pattern as `frontend/src/hooks/usePolling.ts` (5 s cadence, abort on cohort change). `OperationsPage` passes `data` into each section component.
- **Leaderboard sort state** → local `useState` in `StoreLeaderboard`. Not persisted. Default sort: `active_orders DESC`.
- **Right-rail** → `rightRailMode` stays at App level. Leaderboard row click does NOT open the panel — it narrows the URL filter. (If we want row-click to also open the panel later, it's additive.)

### Components

**`<TopNav />`**
- 44 px high, sticky `top: 0`.
- Left: app brand / title.
- Center: two pills, `NavLink`-driven.
- Right: sim-time string + "N stores" count.
- Uses existing color tokens (`dominos-theme.css`).

**`<StoreFilter />`**
- Horizontal pill row. First pill: "All stores" (active when `?stores=` is empty). Followed by pills for each store in the current catalog (sourced from existing `/api/markets`).
- Click behavior: toggle pill ↔ add/remove from URL `?stores=` list. Clicking "All stores" clears the param.
- Pill styling: same as `MarketTabs` pills.

**`<HeadlineKpis />`**
- 6-tile grid (CSS grid, responsive: 6-col desktop, 3-col @ < 1100 px, 2-col @ < 700 px).
- Each tile: label (uppercase 10 px) + value (20 px, weight 700) + optional unit.
- Reuses `KpiCard` styling from `KpiBar.tsx` with color override prop.

**`<ChainPipeline />`**
- Horizontal flex bar. One segment per stage: `new`, `kitchen`, `ready`, `transit`. Each segment width ∝ count. Stage colors from existing `STAGE_COLORS`.
- Below: "Delivered today: N" line.
- Click on a segment = future work (v1: not interactive).

**`<KitchenPanel />` / `<CustomersPanel />` / `<LoyaltyPanel />`**
- Two-column tile each: left = numeric stats block, right = supporting detail (personas list for Customers; % breakdown for Loyalty).
- No charts in v1 — just numeric tiles + small lists.

**`<StoreLeaderboard />`**
- Table. Columns: Store name · Active · Drivers · Rev today · Avg deliv · Kitchen · SLA.
- Column header click = toggle sort asc/desc. Arrow indicator on active column.
- Row click = update URL `?stores=<that_store_id>` (via `navigate`). The filter pill bar immediately reflects this.
- SLA column = colored dot (green/yellow/red).

**`<OperationsPage />`**
- Lays out: `<StoreFilter />` at top, then `<HeadlineKpis />`, then 4-section grid (`ChainPipeline + KitchenPanel` row, `CustomersPanel + LoyaltyPanel` row), then `<StoreLeaderboard />` full-width.
- Shows a loading skeleton on first load; subsequent polls swap data without skeleton flash.
- On 5xx from the backend, shows a banner: "Live data unavailable — retrying in 5s."

### Styling

Follow existing patterns:
- Per-component `document.createElement("style")` blocks (matches codebase convention).
- All colors, spacings, radii from `dominos-theme.css` CSS custom properties.
- No new design tokens.

---

## Integration points

### `App.tsx` changes

- Wrap routed content in `<Routes>`:
  - `<Route path="/" element={<MapShell />} />`
  - `<Route path="/operations" element={<OperationsPage />} />`
- Extract current map layout into `<MapShell />` to keep `App` uncluttered.
- Render `<TopNav />` once, above `<Routes />`.
- Keep `activeMarketId`, `rightRailMode`, `selectedOrderId` in `App` state so both routes share them.

### `StoreDetailPanel.tsx` change

- Add one button in the panel header, right-aligned:
  ```
  [ View in Operations → ]
  ```
- `onClick`: `navigate(`/operations?stores=${market.location_id}`)`.
- No other changes to the panel.

### `main.tsx`

- Already wraps `<App />` in `<BrowserRouter>` — no change.

---

## Testing

### Backend

- `tests/backend/test_operations_dashboard.py` — mock `backend.db.init_pool` / `close_pool` at import-time (per CLAUDE.md), fixtures for:
  - all-stores cohort
  - single-store cohort
  - empty cohort (no matching stores — should return zeros, not error)
  - loop-duplicate-safety: fixture that seeds duplicate orders outside the 24h sim-time window, verify they're excluded.
- Assert response shape matches the documented schema.

### Frontend

- Component tests (Vitest + Testing Library):
  - `StoreFilter`: pill click updates URL; reading URL pre-selects pills.
  - `StoreLeaderboard`: column click toggles sort; row click calls `navigate` with correct URL.
  - `HeadlineKpis`: renders all six tiles with formatted values (dollar signs, min/hh:mm formats).

### E2E (Playwright)

- New spec: `tests/e2e/specs/operations-dashboard.spec.ts`
  - Navigate to `/operations`. Verify all six sections render with non-empty data.
  - Click a leaderboard row. Verify URL updates to `?stores=<id>`, filter pills update, headline numbers change.
  - From `/`, click a store pin → StoreDetailPanel → "View in Operations" button → verify navigation to `/operations?stores=<id>`.
  - Top-nav: click "Map" → returns to `/`, market context preserved.

---

## Known risks & sharp edges

1. **Loop-duplicate orders** — must apply 24h sim-time filter (same as `routes/orders.py`) or revenue/counts balloon.
2. **`delivered_at` vs `current_stage`** — always prefer `delivered_at IS NOT NULL` (DLT sync lag; CLAUDE.md).
3. **Customer join is lossy** — via rounded lat/lon through `customer_address_index_synced`. Label customer/loyalty metrics as "matched customers today" to avoid mis-reading.
4. **Persona breakdown denominator** = matched customers today. Documented inline in UI.
5. **`points_earned_today`** is synthetic (`FLOOR(order_total)` for loyalty members). Call out in code comment that this is a v1 placeholder formula, revise when real loyalty accrual rules land.
6. **Playback mode** reads `MAX(ts)` for "now" (consistent with other routes) but playback scrub isn't wired — document as out-of-scope; `/operations` shows live chain state only for v1.
7. **Phase 1 SF-only** — only 22 stores today. Leaderboard fits on one screen without virtualization. If/when the full 88-location dataset returns, leaderboard may need virtualization or pagination.
8. **Bundle size** — no new heavy deps. Existing bundle is 1006 KB (roadmap notes MapLibre is ~700 KB of that); `/operations` doesn't load MapLibre, so code-split the map route later would be a natural follow-up (already on the roadmap).

---

## File manifest

**New files**:
- `backend/routes/operations.py`
- `tests/backend/test_operations_dashboard.py`
- `frontend/src/pages/OperationsPage.tsx`
- `frontend/src/components/TopNav.tsx`
- `frontend/src/components/operations/StoreFilter.tsx`
- `frontend/src/components/operations/HeadlineKpis.tsx`
- `frontend/src/components/operations/ChainPipeline.tsx`
- `frontend/src/components/operations/KitchenPanel.tsx`
- `frontend/src/components/operations/CustomersPanel.tsx`
- `frontend/src/components/operations/LoyaltyPanel.tsx`
- `frontend/src/components/operations/StoreLeaderboard.tsx`
- `frontend/src/hooks/useOperationsDashboard.ts`
- `tests/e2e/specs/operations-dashboard.spec.ts`

**Modified files**:
- `backend/main.py` — register `operations.router`
- `frontend/src/App.tsx` — `<Routes>`, `<TopNav />`, extract `<MapShell />`
- `frontend/src/components/StoreDetailPanel.tsx` — add "View in Operations" button
- `frontend/src/types/index.ts` — add `OperationsDashboard`, `StoreLeaderboardRow`, `PersonaBreakdown` types

---

## Roadmap relationship

- **Replaces / supersedes** the "In-Store Performance Scorecard" bullet in `docs/roadmap-handoff.md` (Store Intelligence section) for the leaderboard piece — that work is folded into this panel.
- **Complements** the StoreOps AI plan in `docs/roadmap-storeops-ai.md` — that work adds a conversational tab inside `StoreDetailPanel` and is unaffected. When both ship, the "View in Operations" button and the "StoreOps AI" tab are the two ways to drill deeper from a store.
- **Independent of** B1 (driver-pin gap) and the "Map: Store Pins + Delivery Drill-Down" milestone bullet.
