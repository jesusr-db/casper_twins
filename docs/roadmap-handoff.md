# Digital Twin — Handoff Roadmap

**App**: Domino's Digital Twin Driver Tracking
**Last updated**: 2026-03-19

---

## Backlog

### B1 — Missing driver pin during pickup-to-first-ping gap

**Priority**: Low
**Effort**: Medium (backend query change)

**What happens**: When a driver picks up an order, there is a ~60-second window before the first `driver_ping` event fires. During this window:
- The order correctly shows as "In Transit" in the pipeline bar and order drawer
- `Drivers Out` KPI increments correctly
- **But no red driver dot appears on the map** — because driver markers are sourced from `driver_positions_synced`, which is only populated by `driver_ping` events, not `driver_picked_up`

**Root cause**: `driver_positions_synced` is a streaming table fed by `driver_ping` events. There is no entry until the simulator emits the first ping (~60s after pickup). The `driver_picked_up` event alone does not create a position entry.

**Proposed fix**: Add a `UNION ALL` to the drivers backend query that returns orders where `picked_up_at IS NOT NULL AND delivered_at IS NULL AND NOT EXISTS (SELECT 1 FROM driver_positions_synced WHERE order_id = oe.order_id)`, positioned at the store's lat/lon as a fallback. Show these with `progress_pct = 0`.

**Why not done yet**: First attempt at the UNION caused a 500 — the `NOT EXISTS` subquery referencing `driver_positions_synced` without a location/time filter caused a full table scan + type error. Needs a scoped subquery to be safe. Reverted to keep the app stable.

**Workaround**: None needed — the gap is ~60 seconds and resolves itself when the first ping arrives.

---

## Next Milestone

### Operations & Delivery
- Alerting / push notifications for SLA breaches
- Multi-market overview (all-markets zoomed-out map)
- Predictive ETA (ML model integration)
- Real store locations (Google Places API)

### Customer Experience
- **Refund Manager** — track and process refund requests tied to order IDs; surface refund rate as a store KPI
- **Complaint Tracker** — log and categorize customer complaints per order/store; trend view by complaint type (late, wrong item, cold food)
- **Offers & Coupons** — view active promotions per market, track redemption rates, correlate with order volume spikes

### Store Intelligence
- **In-Store Performance Scorecard** — per-store leaderboard across KPIs: avg delivery time, SLA breach rate, order volume, refund rate, complaint rate; exportable for ops reviews

### Platform
- Crustopher / Genie analytics tab — conversational analytics inside the app
- Code-splitting the frontend bundle (currently 1006KB, MapLibre GL JS is ~700KB)
