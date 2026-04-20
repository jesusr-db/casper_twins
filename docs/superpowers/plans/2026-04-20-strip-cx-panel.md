# Strip CX Panel Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Remove every trace of the Customer Experience panel from the twins codebase — UI, backend routes, sync registrations, catalog grants, historical specs/plans, roadmap references — landing as a single atomic PR.

**Architecture:** Single branch (`feat/strip-cx-panel`), four logical commits (frontend, backend, setup/config, docs+scratch), each with its own static verification gate. Code-only removal; live Catalog/Lakebase resources are left orphaned per user decision and will be cleaned up by the next full `destroy-lakebase` cycle.

**Tech Stack:** TypeScript + React (frontend), Python + FastAPI (backend), Databricks Asset Bundles, Unity Catalog, asyncpg.

**Spec:** `docs/superpowers/specs/2026-04-20-strip-cx-panel-design.md`

---

## Task 0: Branch state check

**Files:**
- None — verification only

- [ ] **Step 1: Confirm you are on the right branch with a clean tree**

Run: `git branch --show-current && git status -sb`
Expected: branch is `feat/strip-cx-panel`; the only tracked changes (if any) relative to main are the spec and plan files in `docs/superpowers/`. Untracked files in root and tests/e2e/ are expected (user scratch).

If not on `feat/strip-cx-panel`, run: `git checkout feat/strip-cx-panel` (or create it from main: `git checkout -b feat/strip-cx-panel main`).

- [ ] **Step 2: Record the starting commit for reference**

Run: `git log -1 --oneline`
Record the SHA. If anything goes wrong, we reset to it.

No commit.

---

## Commit 1 — Frontend removal

### Task 1: Delete CX component directory

**Files:**
- Delete: `frontend/src/components/cx/` (6 files)

- [ ] **Step 1: Verify what will be deleted**

Run: `ls frontend/src/components/cx/`
Expected output:
```
CXComplaintsTab.tsx
CXGlobalView.tsx
CXOverviewTab.tsx
CXPanel.tsx
CXRefundsTab.tsx
CXStoreDetail.tsx
```

- [ ] **Step 2: Delete the directory**

Run: `git rm -r frontend/src/components/cx/`

- [ ] **Step 3: Confirm deletion**

Run: `git status`
Expected: shows 6 deleted files under `frontend/src/components/cx/`.

No commit yet — commit after Task 5 lands the full frontend change set.

---

### Task 2: Edit `frontend/src/main.tsx` — remove CX route

**Files:**
- Modify: `frontend/src/main.tsx` (lines 5 and 14)

- [ ] **Step 1: Open the file and review current content**

Current content (19 lines) — key lines:
- L5: `import { CXPanel } from "./components/cx/CXPanel";`
- L14: `<Route path="/cx" element={<CXPanel />} />`

- [ ] **Step 2: Apply the edit**

Replace the file's content entirely with:

```tsx
import React from "react";
import ReactDOM from "react-dom/client";
import { BrowserRouter, Routes, Route } from "react-router-dom";
import App from "./App";
import "./styles/dominos-theme.css";
import "maplibre-gl/dist/maplibre-gl.css";

ReactDOM.createRoot(document.getElementById("root")!).render(
  <React.StrictMode>
    <BrowserRouter>
      <Routes>
        <Route path="/" element={<App />} />
      </Routes>
    </BrowserRouter>
  </React.StrictMode>
);
```

Note: `BrowserRouter` + `Routes` stay. We still want the router in place for future routes and for correct SPA behavior. Only the `CXPanel` import and its `<Route>` element are removed.

---

### Task 3: Edit `frontend/src/App.tsx` — remove CX nav link + deep-link handler

**Files:**
- Modify: `frontend/src/App.tsx`

- [ ] **Step 1: Remove the `useSearchParams` import on L2**

The import statement on L2:
```tsx
import { Link, useSearchParams } from "react-router-dom";
```

Change to:
```tsx
import { Link } from "react-router-dom";
```

(Keep `Link` even though after this strip we have no `<Link>` usages left — it's a trivial import and removing it triggers no lint error; we can drop it too for cleanliness. Prefer dropping entirely:)

Actually, drop `Link` too — the only use was the CX nav link. Change L2 to a blank line, or remove the import statement entirely.

Final L2 state: **remove the entire import line**. The line should be deleted, not replaced with a blank.

- [ ] **Step 2: Remove the deep-link handler (lines 204–209)**

Find and delete this block entirely (lines 204–209 in the current file):
```tsx
  // Deep-link: open order drawer when ?order=<id> is in the URL (from CX panel links)
  const [searchParams] = useSearchParams();
  useEffect(() => {
    const orderId = searchParams.get("order");
    if (orderId) handleDriverClick(orderId);
  }, []); // eslint-disable-line react-hooks/exhaustive-deps
```

- [ ] **Step 3: Remove the CX nav link (line 291)**

Find this line inside the `<div className="logo-area">` block:
```tsx
          <Link to="/cx" className="cx-nav-link">CX</Link>
```

Delete the entire line.

- [ ] **Step 4: Verify no stale `Link` or `useSearchParams` references remain**

Run: `grep -n "Link\|useSearchParams" frontend/src/App.tsx`
Expected: empty output (no matches).

If either identifier still appears, something was missed.

---

### Task 4: Edit `frontend/src/types/index.ts` — remove CX types block

**Files:**
- Modify: `frontend/src/types/index.ts` (lines 165–227)

- [ ] **Step 1: Open the file and locate the block**

Starting at L165 (`// =====…`) through L226 (end of `CXKpis` interface). That's the entire "Customer Experience (CX) Panel types" section.

- [ ] **Step 2: Delete everything from L165 onwards through the end of the file**

Remove:
```tsx
// =============================================================================
// Customer Experience (CX) Panel types
// =============================================================================

/** Store summary row from GET /api/cx/summary */
export interface CXStoreSummary {
  // ...
}

/** Full store detail response from GET /api/cx/stores/{id} */
export interface CXStoreDetailResponse {
  // ...
}

/** Row from GET /api/cx/stores/{id}/complaints */
export interface CXComplaintRow {
  // ...
}

/** Row from GET /api/cx/stores/{id}/refunds */
export interface CXRefundRow {
  // ...
}

/** KPIs shared between global and store-level views */
export interface CXKpis {
  // ...
}
```

- [ ] **Step 3: Confirm the file's last non-blank line is now `};` (closing of `STAGE_COLORS` record, L163)**

Run: `tail -5 frontend/src/types/index.ts`
Expected: the file ends cleanly after `STAGE_COLORS`, no CX types below.

---

### Task 5: Edit `frontend/src/styles/dominos-theme.css` — remove `.cx-*` selectors

**Files:**
- Modify: `frontend/src/styles/dominos-theme.css` (lines 148 and 159 and surrounding blocks)

- [ ] **Step 1: Find the exact extents of both CSS blocks**

Run: `grep -n "^\.cx-\|^\.cx-.*{$\|^}" frontend/src/styles/dominos-theme.css | head -20`

Look at L148 area: `.cx-nav-link { ... }` — find the opening `{` on L148 and scan to the matching closing `}`. Do the same for L159 (`.cx-nav-link:hover { ... }`).

- [ ] **Step 2: Delete both blocks**

Remove the entire `.cx-nav-link { ... }` block and the `.cx-nav-link:hover { ... }` block and any blank line between them. There are only 2 CX selectors per the earlier grep.

- [ ] **Step 3: Verify no CX references remain in CSS**

Run: `grep -n "cx-\|\.cx\b" frontend/src/styles/dominos-theme.css`
Expected: empty output.

---

### Task 6: Verify Commit 1 (frontend) is buildable

**Files:**
- None — verification only

- [ ] **Step 1: Run the TypeScript compiler**

Run: `cd frontend && npx tsc --noEmit`
Expected: no errors. If there are errors, they'll point to unresolved imports or dangling type references — fix them based on the error messages.

- [ ] **Step 2: Run the Vite build**

Run: `cd frontend && npm run build`
Expected: build completes, bundle is emitted to `frontend/dist/`. Warnings OK; errors not.

- [ ] **Step 3: Grep for lingering CX references in frontend/**

Run: `grep -rn "CXPanel\|CXStore\|CXComplaint\|CXRefund\|CXGlobal\|CXOverview\|cx-nav-link\|components/cx" frontend/src/`
Expected: empty output. If anything matches, go back and clean.

- [ ] **Step 4: Return to repo root**

Run: `cd ..`

---

### Task 7: Commit 1 — frontend removal

**Files:**
- None — commits the work of Tasks 1–6

- [ ] **Step 1: Stage all frontend changes**

Run:
```bash
git add frontend/src/components/cx/ frontend/src/main.tsx frontend/src/App.tsx frontend/src/types/index.ts frontend/src/styles/dominos-theme.css
```

- [ ] **Step 2: Confirm staged changes**

Run: `git status -sb`
Expected: 6 deletions under `frontend/src/components/cx/`, 4 modifications: `main.tsx`, `App.tsx`, `types/index.ts`, `dominos-theme.css`.

- [ ] **Step 3: Commit**

Run:
```bash
git commit -m "$(cat <<'EOF'
refactor(cx): remove Customer Experience panel frontend

Deletes frontend/src/components/cx/ (6 components), drops the CX nav link
and ?order=<id> deep-link handler from App.tsx, removes the CX types block,
removes .cx-* CSS selectors, and removes the /cx route from main.tsx.

Part of the CX strip (spec: docs/superpowers/specs/2026-04-20-strip-cx-panel-design.md).

Co-authored-by: Isaac
EOF
)"
```

---

## Commit 2 — Backend removal

### Task 8: Delete backend CX files

**Files:**
- Delete: `backend/routes/cx.py`
- Delete: `tests/test_cx_routes.py`

- [ ] **Step 1: Delete the files**

Run:
```bash
git rm backend/routes/cx.py tests/test_cx_routes.py
```

- [ ] **Step 2: Confirm**

Run: `git status`
Expected: both files show as deleted.

---

### Task 9: Edit `backend/main.py` — remove cx import, router include, and InsufficientPrivilege middleware

**Files:**
- Modify: `backend/main.py`

- [ ] **Step 1: Remove `cx` from the route imports (L19)**

Change:
```python
from backend.routes import cx, drivers, markets, orders, playback
```
to:
```python
from backend.routes import drivers, markets, orders, playback
```

- [ ] **Step 2: Remove the InsufficientPrivilege branch in `DBErrorMiddleware` (L73–78)**

Find and delete this block in the `DBErrorMiddleware.dispatch` method:
```python
            if "InsufficientPrivilege" in type(exc).__name__ or "permission denied" in str(exc).lower():
                logger.warning("Insufficient privileges: %s — run setup-lakebase finalize task", exc)
                return JSONResponse(
                    status_code=503,
                    content={"error": "permission_denied", "detail": "Database permissions not yet applied. Run setup-lakebase job."},
                )
```

After removal, the middleware's `dispatch` method should keep only the `UndefinedTable`/`does not exist` branch followed by `raise`. Final shape:

```python
class DBErrorMiddleware(BaseHTTPMiddleware):
    async def dispatch(self, request: Request, call_next):
        try:
            return await call_next(request)
        except Exception as exc:
            if "UndefinedTable" in type(exc).__name__ or "does not exist" in str(exc):
                table = str(exc).split('"')[1] if '"' in str(exc) else "unknown"
                logger.warning(
                    "Table not yet available: %s (type=%s, msg=%r) — run setup-lakebase job",
                    table, type(exc).__name__, str(exc),
                )
                return JSONResponse(
                    status_code=503,
                    content={"error": "data_not_ready", "detail": f"Table '{table}' not synced yet."},
                )
            raise
```

- [ ] **Step 3: Remove the `cx.router` include on L89**

Change the block of `include_router` calls from:
```python
app.include_router(markets.router)
app.include_router(orders.router)
app.include_router(drivers.router)
app.include_router(playback.router)
app.include_router(cx.router)
```
to:
```python
app.include_router(markets.router)
app.include_router(orders.router)
app.include_router(drivers.router)
app.include_router(playback.router)
```

- [ ] **Step 4: Verify backend imports cleanly**

Run:
```bash
python -c "from backend.main import app; print('ok')"
```
Expected: `ok`. If there's an ImportError, look at the error — probably a missing dependency or a typo.

Note: this import tries to initialize the Lakebase pool via `init_pool`. If you see a Databricks auth error, that's EXPECTED in a local shell without Databricks credentials — it means imports succeeded but runtime init failed. That's fine for the syntax check.

To truly isolate from runtime-init errors:
```bash
python -c "
import sys
from unittest.mock import AsyncMock, patch
with patch('backend.db.init_pool', new=AsyncMock()), patch('backend.db.close_pool', new=AsyncMock()):
    from backend.main import app
    print('ok')
"
```

- [ ] **Step 5: Run pytest collection to confirm no CX tests left**

Run: `python -m pytest tests/ --collect-only 2>&1 | grep -i "cx\|complaint\|refund" || echo "no CX tests remain"`
Expected: `no CX tests remain`.

---

### Task 10: Commit 2 — backend removal

**Files:**
- None — commits the work of Tasks 8–9

- [ ] **Step 1: Stage backend changes**

Run:
```bash
git add backend/routes/cx.py backend/main.py tests/test_cx_routes.py
```

- [ ] **Step 2: Confirm staged**

Run: `git status -sb`
Expected: `backend/routes/cx.py` deleted, `tests/test_cx_routes.py` deleted, `backend/main.py` modified.

- [ ] **Step 3: Commit**

Run:
```bash
git commit -m "$(cat <<'EOF'
refactor(cx): remove Customer Experience backend routes + middleware

Deletes backend/routes/cx.py and tests/test_cx_routes.py. In backend/main.py:
drops the cx import, the app.include_router(cx.router) call, and the
InsufficientPrivilege branch of DBErrorMiddleware (originally added for CX
route error handling in commit a2caca8).

Part of the CX strip (spec: docs/superpowers/specs/2026-04-20-strip-cx-panel-design.md).

Co-authored-by: Isaac
EOF
)"
```

---

## Commit 3 — Setup / config removal

### Task 11: Edit `setup/config.py` — remove 2 SYNCS entries and 2 indexes

**Files:**
- Modify: `setup/config.py` (lines 66–82 for SYNCS, lines 109–113 for indexes)

- [ ] **Step 1: Remove the SYNCS entries (lines 66–81)**

Find and delete this block entirely:
```python
    # Complaints — LLM-generated customer complaint records
    # SNAPSHOT (not CONTINUOUS) because the source is a managed table, not a
    # streaming table — CONTINUOUS would require an active DLT pipeline.
    {
        "source": f"{SOURCE_CATALOG}.complaints.raw_complaints",
        "name": f"{SOURCE_CATALOG}.complaints.complaints_synced",
        "policy": SyncedTableSchedulingPolicy.SNAPSHOT,
        "pk": ["complaint_id"],
    },
    # Refund recommendations — AI agent output, batch-generated
    {
        "source": f"{SOURCE_CATALOG}.recommender.refund_recommendations",
        "name": f"{SOURCE_CATALOG}.recommender.refund_recommendations_synced",
        "policy": SyncedTableSchedulingPolicy.SNAPSHOT,
        "pk": ["order_id"],
    },
```

After removal, the `SYNCS` list should contain 6 entries: `locations`, `orders_enriched`, `all_events`, `driver_positions`, `customers`, `customer_address_index`.

- [ ] **Step 2: Remove the two indexes (lines 109–113)**

Find and delete this block in the `INDEX_SQL` string:
```python

CREATE INDEX IF NOT EXISTS idx_complaints_order_id
  ON complaints.complaints_synced (order_id);

CREATE INDEX IF NOT EXISTS idx_refunds_order_id
  ON recommender.refund_recommendations_synced (order_id);
```

After removal, `INDEX_SQL` ends with `CREATE INDEX IF NOT EXISTS idx_address_index_lat_lon ON simulator.customer_address_index_synced (rounded_lat, rounded_lon);` followed by the closing `"""`.

- [ ] **Step 3: Verify file syntax**

Run: `python -m py_compile setup/config.py && echo "ok"`
Expected: `ok`.

- [ ] **Step 4: Confirm SYNCS has exactly 6 entries**

Run:
```bash
python -c "from setup.config import SYNCS; print(f'SYNCS count: {len(SYNCS)}'); [print(s['name']) for s in SYNCS]"
```
Expected output:
```
SYNCS count: 6
vdm_classic_rikfy0_catalog.simulator.locations_synced
vdm_classic_rikfy0_catalog.lakeflow.orders_enriched_synced
vdm_classic_rikfy0_catalog.lakeflow.all_events_synced
vdm_classic_rikfy0_catalog.lakeflow.driver_positions_synced
vdm_classic_rikfy0_catalog.simulator.customers_synced
vdm_classic_rikfy0_catalog.simulator.customer_address_index_synced
```

---

### Task 12: Edit `setup/finalize.py` — remove complaints and recommender from schema grant list

**Files:**
- Modify: `setup/finalize.py` (line 103)

- [ ] **Step 1: Change the schema list on L103**

Find:
```python
    for schema in ["public", "simulator", "lakeflow", "complaints", "recommender"]:
```

Replace with:
```python
    for schema in ["public", "simulator", "lakeflow"]:
```

- [ ] **Step 2: Verify file syntax**

Run: `python -m py_compile setup/finalize.py && echo "ok"`
Expected: `ok`.

---

### Task 13: Edit `setup/destroy_lakebase.py` — remove 2 synced tables

**Files:**
- Modify: `setup/destroy_lakebase.py`

- [ ] **Step 1: Check current state of `SYNCED_TABLES`**

Run: `grep -A10 "^SYNCED_TABLES" setup/destroy_lakebase.py`

The list already excludes the 2 CX synced tables in the version I read earlier (only 5 entries: 2 lakeflow + 3 simulator). Verify this is still true.

If the list DOES contain `complaints.complaints_synced` or `recommender.refund_recommendations_synced`, remove those two entries. Expected final list:

```python
SYNCED_TABLES = [
    f"{SOURCE_CATALOG}.simulator.locations_synced",
    f"{SOURCE_CATALOG}.lakeflow.all_events_synced",
    f"{SOURCE_CATALOG}.lakeflow.driver_positions_synced",
    f"{SOURCE_CATALOG}.lakeflow.orders_enriched_synced",
    f"{SOURCE_CATALOG}.simulator.customers_synced",
    f"{SOURCE_CATALOG}.simulator.customer_address_index_synced",
]
```

If the current file already matches this shape (no CX entries), **skip this task entirely** — no change needed.

- [ ] **Step 2: Verify file syntax**

Run: `python -m py_compile setup/destroy_lakebase.py && echo "ok"`
Expected: `ok`.

---

### Task 14: Commit 3 — setup / config removal

**Files:**
- None — commits the work of Tasks 11–13

- [ ] **Step 1: Stage setup changes**

Run:
```bash
git add setup/config.py setup/finalize.py setup/destroy_lakebase.py
```

- [ ] **Step 2: Confirm**

Run: `git status -sb`
Expected: `setup/config.py` modified, `setup/finalize.py` modified; `setup/destroy_lakebase.py` may or may not be modified depending on Task 13's finding.

- [ ] **Step 3: Commit**

Run:
```bash
git commit -m "$(cat <<'EOF'
refactor(cx): remove complaints/refund syncs, indexes, and grants

setup/config.py: removes the 2 CX SYNCS entries (complaints.raw_complaints →
complaints_synced and recommender.refund_recommendations →
refund_recommendations_synced) and their 2 index DDL statements. SYNCS count
drops from 8 to 6.

setup/finalize.py: removes complaints and recommender from the schema grant
list so the app service principal no longer receives USAGE/SELECT on those
schemas (they are still granted on public, simulator, lakeflow).

setup/destroy_lakebase.py: updated if it still referenced the CX synced
tables (may already be correct if a prior fix removed them).

Part of the CX strip (spec: docs/superpowers/specs/2026-04-20-strip-cx-panel-design.md).

Co-authored-by: Isaac
EOF
)"
```

---

## Commit 4 — Docs + scratch cleanup

### Task 15: Delete tracked historical spec, plan, research, and agent-team status

**Files:**
- Delete: `docs/superpowers/specs/2026-03-19-customer-experience-panel-design.md`
- Delete: `docs/superpowers/plans/2026-03-19-customer-experience-panel.md`
- Delete: `research/cx-panel-handoff_2026-03-20.md`
- Delete: `.agent-team/status/qa-cx-panel.md` (tracked per earlier `git ls-files` grep)

- [ ] **Step 1: Verify the files are tracked**

Run: `git ls-files | grep -E "cx|customer-experience" -i`
Expected output includes those 4 paths plus the files being deleted in earlier tasks.

- [ ] **Step 2: Delete them**

Run:
```bash
git rm docs/superpowers/specs/2026-03-19-customer-experience-panel-design.md \
       docs/superpowers/plans/2026-03-19-customer-experience-panel.md \
       research/cx-panel-handoff_2026-03-20.md \
       .agent-team/status/qa-cx-panel.md
```

- [ ] **Step 3: Confirm**

Run: `git status` — the 4 files should appear as deleted.

---

### Task 16: Edit `CLAUDE.md` — update SYNCS count + add orphan note + remove CX reference

**Files:**
- Modify: `CLAUDE.md`

- [ ] **Step 1: Remove the CX reference on L27**

Find this line under `## Backend / Postgres`:
```
- `_validate_days()` in `cx.py` allows 0 (= all time, no date filter) but rejects negatives.
```
Delete the line entirely.

- [ ] **Step 2: Update the SYNCS count on L48**

Find under `## Pipeline & DAB`:
```
- Current SYNCS count in `config.py`: **8** (5 original + 1 orders_enriched + 2 CX).
```

Replace with:
```
- Current SYNCS count in `config.py`: **6** (5 original + 1 orders_enriched). As of 2026-04-20, twins no longer consumes `complaints.*` or `recommender.*` tables — those remain caspers-produced. Orphaned `complaints_synced` + `refund_recommendations_synced` syncs in the shared catalog and twins Lakebase instance persist until the next `bundle run destroy-lakebase` cycle wipes the instance.
```

- [ ] **Step 3: Verify no other CX references remain**

Run: `grep -in "cx\|complaint\|refund" CLAUDE.md`
Expected: empty (or only the 2026-04-20 orphan note we just added, which mentions `complaints_synced` + `refund_recommendations_synced` — that's the one acceptable reference).

---

### Task 17: Edit `docs/roadmap-handoff.md` — strip CX section from Next Milestone

**Files:**
- Modify: `docs/roadmap-handoff.md`

- [ ] **Step 1: Find the CX section under Next Milestone**

Run: `grep -n "^### Customer Experience\|Refund Manager\|Complaint Tracker\|Offers & Coupons" docs/roadmap-handoff.md`

Expected: finds `### Customer Experience` near the end of "Next Milestone", with sub-bullets `Refund Manager`, `Complaint Tracker`, `Offers & Coupons`.

- [ ] **Step 2: Delete the `### Customer Experience` heading and its 3 bullets**

Remove the entire section. Adjacent sections (`### Store Intelligence`, `### Platform`, etc.) stay untouched.

After removal, confirm the remaining structure is intact:

Run: `grep -n "^###" docs/roadmap-handoff.md`
Expected: no `### Customer Experience` line.

---

### Task 18: Edit `docs/roadmap-storeops-ai.md` — remove complaints-related tools

**Files:**
- Modify: `docs/roadmap-storeops-ai.md`

- [ ] **Step 1: Locate complaints references**

Run: `grep -n "complaint\|refund" docs/roadmap-storeops-ai.md`

You'll see references in:
- The "Synced Tables" table (rows for `complaints_synced` and `refund_recommendations_synced`)
- The "UC Delta Tables (for Genie Space)" list (`complaints.raw_complaints`, `recommender.refund_recommendations`)
- Sample Genie questions that mention complaints
- The tools table (`tools/complaints.py` with `get_complaints_summary`, `get_complaint_detail`)
- The Phase 2 SQL section (reuse of `routes/cx.py:110-162` and `routes/cx.py:256-276`)
- Possibly the system prompt reference ("include refund recommendations with complaints")
- The frontend components table (`QuickActions` includes "Complaints")

- [ ] **Step 2: Delete each reference**

For each hit, delete the row, bullet, or sentence. Specifically:
- Drop the `complaints_synced` and `refund_recommendations_synced` rows from the Synced Tables table.
- Drop `vdm_classic_rikfy0_catalog.complaints.raw_complaints` and `...recommender.refund_recommendations` from the UC Delta Tables list.
- Drop any sample Genie question that mentions complaints or refunds.
- Drop the `tools/complaints.py` row from the tools table.
- Drop the entire `get_complaints_summary` and `get_complaint_detail` sections in Phase 2.
- Update the system prompt section to drop the refund-recommendation rule.
- Update `QuickActions` in the frontend section to drop "Complaints".

- [ ] **Step 3: Verify no CX/complaint/refund references remain**

Run: `grep -in "complaint\|refund" docs/roadmap-storeops-ai.md`
Expected: empty output.

---

### Task 19: Delete untracked root-level scratch files

**Files:**
- Delete (untracked): `test-cx-panel.js`, `test-cx-auth-redirect.png`, `test-cx-blocked-state.png`

- [ ] **Step 1: Verify files exist and are untracked**

Run: `ls test-cx-*.{png,js} 2>/dev/null && git ls-files --error-unmatch test-cx-panel.js 2>/dev/null || echo "test-cx-panel.js is untracked"`
Expected: files exist; git reports untracked.

- [ ] **Step 2: Delete them**

Run:
```bash
rm -f test-cx-panel.js test-cx-auth-redirect.png test-cx-blocked-state.png
```

No git staging needed — these weren't tracked.

---

### Task 20: Commit 4 — docs + scratch cleanup

**Files:**
- None — commits the work of Tasks 15–19

- [ ] **Step 1: Stage all doc + `.agent-team` deletions and modifications**

Run:
```bash
git add CLAUDE.md docs/roadmap-handoff.md docs/roadmap-storeops-ai.md \
        docs/superpowers/specs/2026-03-19-customer-experience-panel-design.md \
        docs/superpowers/plans/2026-03-19-customer-experience-panel.md \
        research/cx-panel-handoff_2026-03-20.md \
        .agent-team/status/qa-cx-panel.md
```

Some of these may already be staged from Task 15's `git rm` — that's fine; `git add` is idempotent.

- [ ] **Step 2: Confirm staged**

Run: `git status -sb`
Expected: 4 deletions (historical docs + agent-team status), 3 modifications (CLAUDE.md, roadmap-handoff.md, roadmap-storeops-ai.md).

- [ ] **Step 3: Commit**

Run:
```bash
git commit -m "$(cat <<'EOF'
docs(cx): remove CX specs, plans, research, and roadmap references

Deletes the 2026-03-19 Customer Experience Panel spec + plan, the
cx-panel-handoff research doc, and the qa-cx-panel agent-team status file.
Updates CLAUDE.md (SYNCS count 8 → 6 + orphan note), roadmap-handoff.md
(removes CX subsection of Next Milestone), and roadmap-storeops-ai.md
(removes complaints/refund tools from the Phase 1 plan).

Untracked scratch files (test-cx-panel.js and two PNG screenshots) deleted
from the working tree as well.

Part of the CX strip (spec: docs/superpowers/specs/2026-04-20-strip-cx-panel-design.md).

Co-authored-by: Isaac
EOF
)"
```

---

## Task 21: Full-repo verification

**Files:**
- None — verification only

- [ ] **Step 1: Check commit chain**

Run: `git log --oneline main..HEAD`
Expected: 5 commits (the spec commit + 4 refactor commits from this plan), something like:
```
<sha> docs(cx): remove CX specs, plans, research, and roadmap references
<sha> refactor(cx): remove complaints/refund syncs, indexes, and grants
<sha> refactor(cx): remove Customer Experience backend routes + middleware
<sha> refactor(cx): remove Customer Experience panel frontend
<sha> docs: CX panel strip design spec
```

- [ ] **Step 2: Grep checks (must all return empty)**

Run each and confirm empty output (except where the orphan note in `CLAUDE.md` or the spec itself legitimately mentions the names):

```bash
grep -rn "cx\.router\|from backend.routes import cx\|import cx " backend/
grep -rn "CXPanel\|CXStore\|CXComplaint\|CXRefund\|CXGlobal\|CXOverview" frontend/src/
grep -rn "complaints_synced\|refund_recommendations_synced" setup/ backend/
grep -rn "/cx\b\|className=\"cx-" frontend/src/
```

Acceptable matches:
- Inside `docs/superpowers/specs/2026-04-20-strip-cx-panel-design.md`
- Inside `docs/superpowers/plans/2026-04-20-strip-cx-panel.md` (this file)
- Inside `CLAUDE.md` orphan note (names are referenced there intentionally)

- [ ] **Step 3: Run the full static checks one more time**

Run:
```bash
cd frontend && npx tsc --noEmit && cd ..
cd frontend && npm run build && cd ..
python -m py_compile setup/config.py setup/finalize.py setup/destroy_lakebase.py backend/main.py
python -m pytest tests/ --collect-only 2>&1 | tail -5
```
Expected: TypeScript no errors, Vite build succeeds, all Python files compile, pytest collection finishes without any CX-related errors.

- [ ] **Step 4: Confirm `SYNCS` count programmatically**

Run:
```bash
python -c "from setup.config import SYNCS; assert len(SYNCS) == 6, f'expected 6, got {len(SYNCS)}'; print('SYNCS count OK')"
```
Expected: `SYNCS count OK`.

No commit.

---

## Task 22: Open PR (user-gated)

**Files:**
- None — git / GitHub operation

- [ ] **Step 1: Confirm with the user before pushing**

**DO NOT push or open a PR without explicit user approval.** This plan is executed in an autonomous run; the user has requested gating on actions that affect shared state (PRs, deploys).

Ask the user: "Phase A verification all green. Ready to push `feat/strip-cx-panel` and open the PR?"

- [ ] **Step 2: Push the branch (if user approves)**

Run: `git push -u origin HEAD`

- [ ] **Step 3: Open the PR with gh CLI (if user approves)**

Run:
```bash
gh pr create --title "refactor(cx): remove Customer Experience panel from twins" --body "$(cat <<'EOF'
## Summary

Removes every trace of the Customer Experience panel from twins — UI, backend routes, sync registrations, catalog grants, historical specs/plans, roadmap references.

**Motivation:** CX was experimental. Lessons learned captured in git history. Removing the panel makes twins self-contained (no cross-bundle read coupling to caspers for LLM-generated data) and simplifies the codebase for the planned Phase 1 event-datagen absorption.

**Spec:** `docs/superpowers/specs/2026-04-20-strip-cx-panel-design.md`

## Changes

- **Frontend**: deleted `frontend/src/components/cx/` (6 components), removed CX nav link + `?order=` deep-link handler from `App.tsx`, removed CX types, removed `.cx-*` CSS, removed `/cx` route from `main.tsx`.
- **Backend**: deleted `backend/routes/cx.py` + `tests/test_cx_routes.py`; reversed `InsufficientPrivilege` branch in `DBErrorMiddleware` added by `a2caca8`.
- **Setup**: removed 2 SYNCS entries + 2 indexes in `setup/config.py` (SYNCS 8 → 6); removed `complaints`/`recommender` from the schema grant list in `setup/finalize.py`.
- **Docs**: deleted historical CX spec + plan + research-handoff; updated `CLAUDE.md` (SYNCS count + orphan note); stripped CX sections from `docs/roadmap-handoff.md` and `docs/roadmap-storeops-ai.md`; removed `.agent-team/status/qa-cx-panel.md`.

## Out of scope

- Live cleanup of orphaned syncs in the shared catalog and twins Lakebase instance — user decision, will be resolved by next `destroy-lakebase` cycle.
- Caspers-side changes — not required; caspers' own consumers are unaffected.

## Test plan

- [x] `npx tsc --noEmit` passes
- [x] `npm run build` succeeds
- [x] `python -c "from backend.main import app"` imports cleanly
- [x] `pytest --collect-only` shows no CX tests and no collection errors
- [x] Greps for `cx.router`, `CXPanel`, `complaints_synced`, `/cx`, `className="cx-"` all return empty
- [ ] (Post-merge) Smoke-test on live app: orders load, no CX nav link, `/cx` route 404s, `?order=` no longer auto-opens drawer, all other APIs 200

This pull request was AI-assisted by Isaac.
EOF
)"
```

- [ ] **Step 4: Return the PR URL to the user**

`gh pr create` prints the URL. Share it with the user.

---

## Rollback

If anything goes wrong after merge and a revert is needed:

```bash
# Revert the merge commit on main
git revert -m 1 <merge-sha>
git push
```

The 4 refactor commits are logically grouped, but the PR merge is the single rollback unit. Everything re-emerges as it was; the CX panel resumes functioning once the Lakebase syncs rebuild (which they will on the next `setup-lakebase` run — the orphaned catalog entries will be re-registered via updated `setup/config.py`).
