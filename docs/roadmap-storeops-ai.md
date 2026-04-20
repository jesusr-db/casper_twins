# StoreOps AI — Integration Roadmap (PRIORITY)

**Status**: Planning Complete — Ready for Implementation
**Priority**: P0
**Target**: Integrate Crustopher AI chatbot into Twins app as "StoreOps AI" tab
**Date**: 2026-04-15
**Updated**: 2026-04-20 — complaints/refunds removed from scope (twins no longer consumes those tables; see `docs/superpowers/specs/2026-04-20-strip-cx-panel-design.md`)

---

## Overview

Embed an AI-powered store operations assistant into the Twins Digital Twin app. When a user clicks a store on the map, a "StoreOps AI" tab in the `StoreDetailPanel` provides a conversational interface to ask questions about that store's real-time data — orders, drivers, performance, weather, and free-form analytics via Genie.

**Architecture**: Tools run in-process in the twins FastAPI backend (primary path) AND are optionally exposed via MCP protocol for external clients.

---

## Data Model (Twins Lakebase — PostgreSQL)

**Source catalog**: `vdm_classic_rikfy0_catalog`
**Lakebase instance**: `twins` / database: `databricks_postgres`

### Synced Tables

| Schema | Table | Sync Policy | PK | Description |
|--------|-------|-------------|-----|-------------|
| `lakeflow` | `all_events_synced` | CONTINUOUS | `event_id` | Raw event stream: `event_id, order_id, location_id, event_type, body (JSON), ts, sequence`. Event types: `order_created`, `gk_started`, `gk_ready`, `gk_finished`, `driver_arrived`, `driver_picked_up`, `driver_ping`, `delivered` |
| `lakeflow` | `driver_positions_synced` | CONTINUOUS | `order_id` | SCD Type 1 latest driver position: `order_id, location_id, ts, loc_lat, loc_lon, progress_pct` |
| `lakeflow` | `orders_enriched_synced` | CONTINUOUS | `order_id` | One row per order: `order_id, location_id, current_stage, created_at, kitchen_started_at, kitchen_ready_at, kitchen_finished_at, driver_arrived_at, picked_up_at, delivered_at, order_body (JSON), route_body (JSON), latest_ping (JSON), order_total` |
| `simulator` | `locations_synced` | SNAPSHOT | `location_id` | Store metadata: `location_id (int), location_code, name, lat, lon` |
| `simulator` | `customers_synced` | SNAPSHOT | `customer_id` | Customer profiles: `customer_id, name, persona, is_loyalty_member, loyalty_points, coupon_propensity, location_id` |
| `simulator` | `customer_address_index_synced` | SNAPSHOT | `customer_id` | Address lookup: `customer_id, rounded_lat, rounded_lon` |

### Key Relationships
- `orders_enriched.location_id` (text) joins to `locations_synced.location_id::text` (int→text cast)
- Customer lookup: `ROUND(order_body::json->>'customer_lat', 3)` → `customer_address_index.rounded_lat/lon`

### UC Delta Tables (for Genie Space)
- `vdm_classic_rikfy0_catalog.lakeflow.all_events`
- `vdm_classic_rikfy0_catalog.lakeflow.orders_enriched`
- `vdm_classic_rikfy0_catalog.lakeflow.driver_positions`
- `vdm_classic_rikfy0_catalog.simulator.locations`
- `vdm_classic_rikfy0_catalog.simulator.customers`

---

## Phase 0: Create Genie Space + UC Function

### 0a. Genie Space for Twins Data

Create a Genie Space over the UC Delta tables for free-form analytical queries:

**Tables**: `orders_enriched`, `driver_positions`, `locations`

**Sample questions**:
- "What is the average delivery time for store 42?"
- "Which stores have the most active orders right now?"
- "What are the top 5 stores by revenue today?"
- "How many orders are currently in transit across all stores?"
- "Which stores have the longest kitchen-to-pickup gap this week?"

### 0b. UC Function — Store Performance Score

```sql
CREATE OR REPLACE FUNCTION vdm_classic_rikfy0_catalog.lakeflow.calculate_store_score(
  location_id_param STRING,
  period_days INT DEFAULT 7
)
RETURNS TABLE (
  total_orders BIGINT,
  delivered_orders BIGINT,
  completion_rate DOUBLE,
  avg_delivery_minutes DOUBLE,
  total_revenue DOUBLE
)
RETURN
  SELECT
    COUNT(*) AS total_orders,
    COUNT(CASE WHEN delivered_at IS NOT NULL THEN 1 END) AS delivered_orders,
    ROUND(COUNT(CASE WHEN delivered_at IS NOT NULL THEN 1 END) * 100.0 / NULLIF(COUNT(*), 0), 1) AS completion_rate,
    ROUND(AVG(
      CASE WHEN delivered_at IS NOT NULL AND picked_up_at IS NOT NULL
        THEN (unix_timestamp(delivered_at) - unix_timestamp(picked_up_at)) / 60.0
      END
    ), 1) AS avg_delivery_minutes,
    COALESCE(SUM(order_total), 0) AS total_revenue
  FROM vdm_classic_rikfy0_catalog.lakeflow.orders_enriched
  WHERE location_id = location_id_param
    AND (period_days = 0 OR created_at >= current_timestamp() - make_interval(0,0,0,period_days,0,0,0))
```

---

## Phase 1: Backend — Agent + Tool Framework

### New files in `twins/backend/ai/`

| File | Source | Description |
|------|--------|-------------|
| `__init__.py` | — | Empty package init |
| `agent.py` | Port from `crustopher-ui/backend/agent.py` | `TwinsAgent` class: FMAPI client, ConversationMemory, in-process tool execution, MLflow tracing |
| `prompts.py` | New (adapted from crustopher) | System prompt for twins data context |
| `governance.py` | Simplified from `crustopher-mcp/governance.py` | All-GREEN governance (read-only tools), audit logging |
| `tools/__init__.py` | — | `TOOL_REGISTRY` dict mapping tool names → async functions |
| `tools/orders.py` | — | `get_orders_summary`, `get_order_detail` |
| `tools/drivers.py` | — | `get_driver_status` |
| `tools/performance.py` | — | `get_store_performance` |
| `tools/store_info.py` | — | `get_store_info` |
| `tools/weather.py` | Port from `crustopher-mcp/tools/weather.py` | Open-Meteo API with DB lat/lon lookup |
| `tools/analytics.py` | Port from `crustopher-mcp/tools/analytics.py` | Genie Space passthrough |

### New route: `twins/backend/routes/ai.py`

```
POST /api/ai/chat  →  {location_id, store_name, message, conversation_id}  →  {message, tool_calls[], conversation_id}
```

### Wire into `twins/backend/main.py`

```python
from backend.routes import ai
app.include_router(ai.router)
```

---

## Phase 2: Tool Implementations (Lakebase SQL)

All tools use `from backend.db import get_pool` — the existing asyncpg connection pool.

### `get_orders_summary(location_id, limit=20)`
```sql
-- Stage breakdown (active + recently delivered)
SELECT current_stage, COUNT(*) AS count
FROM lakeflow.orders_enriched_synced
WHERE location_id = $1 AND (delivered_at IS NULL OR delivered_at::timestamp >= NOW() - INTERVAL '60 minutes')
GROUP BY current_stage;

-- Recent orders
SELECT order_id, current_stage, created_at, delivered_at, order_total
FROM lakeflow.orders_enriched_synced WHERE location_id = $1
ORDER BY created_at DESC LIMIT $2;
```

### `get_order_detail(order_id)`
Reuse SQL from `routes/orders.py:84-137` — order row + events join + customer address lookup.

### `get_driver_status(location_id)`
Reuse SQL from `routes/drivers.py:40-62` — driver_positions + orders join, 2h window filter.

### `get_store_performance(location_id, days=7)`
```sql
SELECT
  COUNT(*) AS total_orders,
  COUNT(*) FILTER (WHERE delivered_at IS NOT NULL) AS delivered,
  ROUND(AVG(order_total)::numeric, 2) AS avg_order_value,
  ROUND(AVG(EXTRACT(EPOCH FROM (delivered_at::timestamp - picked_up_at::timestamp)) / 60.0)
    FILTER (WHERE delivered_at IS NOT NULL AND picked_up_at IS NOT NULL
            AND delivered_at > picked_up_at), 1) AS avg_delivery_min,
  COALESCE(SUM(order_total), 0) AS total_revenue
FROM lakeflow.orders_enriched_synced
WHERE location_id = $1 AND ($2 = 0 OR created_at >= NOW() - make_interval(days => $2::int));
```

### `get_store_info(location_id)`
```sql
SELECT location_id, location_code, name, lat, lon
FROM simulator.locations_synced WHERE location_id::text = $1;
```

### `get_weather(location_id)`
DB lookup for lat/lon → Open-Meteo API call (free, no key needed).

### `query_analytics(question)`
Genie Space API via `WorkspaceClient` — delegates free-form SQL generation.

---

## Phase 3: System Prompt

Scoped per-store. Key rules: lead with insights, use stage names (New/Kitchen Prep/Ready/In Transit/Delivered), flag SLA issues, be concise (320px panel), plain English.

---

## Phase 4: Frontend — StoreOps AI Tab

### Modify `StoreDetailPanel.tsx`
- Add tab bar: "Overview" (existing content) | "StoreOps AI" (new chat)
- Tab state: `useState<"overview" | "ai">`

### New components in `frontend/src/components/ai/`

| Component | Description |
|-----------|-------------|
| `StoreOpsChat.tsx` | Container: messages state, conversation UUID, reset on store change |
| `ChatMessage.tsx` | User/agent bubbles with markdown bold + tool badges |
| `ToolBadge.tsx` | Tool name + latency + green color indicator |
| `QuickActions.tsx` | Chips: Orders, Drivers, Performance, Weather |

### New types in `frontend/src/types/index.ts`
`AIToolCall`, `AIChatResponse`, `AIChatMessage`

---

## Phase 5: Configuration

| File | Changes |
|------|---------|
| `app.yaml` | Add `FMAPI_MODEL=databricks-claude-sonnet-4`, `GENIE_SPACE_ID=<id>` |
| `requirements.txt` | Add `mlflow>=2.17.0`, `httpx>=0.27.0` |
| `backend/main.py` | Wire `ai.router` |

---

## Phase 6: Optional MCP Exposure

`backend/ai/mcp_server.py` — FastMCP wrapper over same tools. Mounted at `/mcp` with graceful skip if fastmcp not installed. Enables external MCP clients (Claude Desktop, other agents) to call the same tools.

---

## Implementation Order

| # | Phase | Est. Effort | Depends On |
|---|-------|-------------|------------|
| 0 | Genie Space + UC Function | 30 min | — |
| 1 | Backend agent framework | 2-3 hrs | — |
| 2 | Tool implementations (7 tools) | 2-3 hrs | Phase 1 |
| 3 | Route + wire into main.py | 30 min | Phase 2 |
| 4 | Frontend components (5 files) | 2-3 hrs | — |
| 5 | StoreDetailPanel tab integration | 1 hr | Phase 4 |
| 6 | Config + deploy | 30 min | All above |
| 7 | MCP exposure (optional) | 1 hr | Phase 2 |

Phases 1-3 (backend) and 4-5 (frontend) can be parallelized.

---

## Verification Checklist

- [ ] Genie Space answers sample questions correctly
- [ ] UC function returns composite scores for test stores
- [ ] `POST /api/ai/chat` returns structured response with real data
- [ ] Each tool returns data matching existing route output
- [ ] StoreDetailPanel shows Overview/AI tabs
- [ ] Chat UI renders messages with tool badges
- [ ] Quick actions trigger correct tool calls
- [ ] Conversation continuity across multiple messages
- [ ] Store switching resets conversation
- [ ] MCP endpoint responds to tool listing (optional)
