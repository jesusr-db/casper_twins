# Strip Customer Experience (CX) Panel from Twins

**Status:** Design — pending user review
**Date:** 2026-04-20
**Companion work:** `docs/superpowers/specs/2026-04-20-b3-roadmap-design.md` (Phase 0 deploy.sh); forthcoming Phase 1 event-datagen absorption spec.
**Scope:** Remove every trace of the Customer Experience panel from twins — UI, backend routes, sync registrations, catalog grants, historical specs/plans, roadmap references.

---

## Problem

Twins currently consumes two LLM-generated Delta tables that live in the caspers-kitchens bundle — `complaints.raw_complaints` and `recommender.refund_recommendations` — to power a Customer Experience panel shipped in commit `58ec67e` (2026-03-19). The panel was treated as an experimental feature. Lessons learned:

- Cross-bundle read coupling adds fragility without matching demo payoff.
- The B3 Phase 1 audit (`docs/superpowers/research/2026-04-20-caspers-full-audit.md`) confirmed that complaint/refund tables stay caspers-owned. Removing the twins consumer is the cleanest way to make twins self-contained.
- StoreOps AI roadmap (`docs/roadmap-storeops-ai.md`) no longer treats complaints/refunds as core tools (user decision 2026-04-20).

After this strip lands, **twins no longer depends on caspers for anything at the application layer.** It still reads `lakeflow.all_events` and `simulator.locations` from the shared catalog — those are the subject of Phase 1, not this spec.

## Goals

1. Remove every file, route, type, sync, index, grant, test, doc, and roadmap reference tied to CX.
2. Leave the codebase in a clean, self-consistent state: no dangling imports, no orphaned CSS, no stale mentions in `CLAUDE.md` or roadmap docs.
3. Land as a single atomic PR (four logical commits) that reverts cleanly if needed via `git revert`.

## Non-goals

- **Live cleanup of orphaned synced tables** — user decision: leave them. `complaints.complaints_synced` and `recommender.refund_recommendations_synced` persist in the shared catalog (and as Postgres tables inside the twins Lakebase instance) until the next full `destroy-lakebase` cycle, at which point the whole instance is wiped.
- **Revoking catalog-level service-principal grants** on `complaints` / `recommender` schemas. Harmless residue; removing is a future cleanup if ever needed.
- **Caspers-side changes.** Caspers does not consume its own complaints/refunds from twins' direction. Zero cross-bundle coordination.
- **Removing the untracked Playwright harness** (`tests/e2e/playwright.config.ts`, `auth-setup.ts`, `save-auth.mjs`, etc.). These are the user's personal dev scratch, not tracked, not ours to delete.
- **CX v2 or alternative customer-experience feature.** Deliberately not replaced. Git history preserves the previous implementation if it's ever needed again.

## Ownership after this strip

- Twins app layer is CX-free.
- Twins still reads `lakeflow.all_events` and `simulator.locations` from the shared catalog — those stay caspers-owned until Phase 1 absorbs them.
- Shared catalog `vdm_classic_rikfy0_catalog` continues to host `complaints.*` and `recommender.*` tables, produced by caspers for caspers' refund-manager app. Nobody in twins reads them.

---

## Removal inventory

### Frontend

**Delete (entire files):**
- `frontend/src/components/cx/` — all six `.tsx` components:
  - `CXComplaintsTab.tsx`
  - `CXGlobalView.tsx`
  - `CXOverviewTab.tsx`
  - `CXPanel.tsx`
  - `CXRefundsTab.tsx`
  - `CXStoreDetail.tsx`

**Edit:**
- `frontend/src/App.tsx` — remove:
  - CX nav link: `<Link to="/cx" className="cx-nav-link">CX</Link>` (≈L291).
  - `?order=` URL-param effect hook that auto-opens the order drawer (≈L204). The handler was added for CX inbound deep-links; user chose full reversal.
  - Any `<Route path="/cx">` definitions and their child routes.
- `frontend/src/main.tsx` — remove CX-specific route imports if present.
- `frontend/src/types/index.ts` — remove the "Customer Experience (CX) Panel types" block (≈L166+): `CXStoreSummary`, `CXStoreDetailResponse`, `CXComplaintRow`, `CXRefundRow`, `CXKpis`.
- `frontend/src/styles/dominos-theme.css` — remove every `.cx-*` selector (nav link, panel, tabs).

### Backend

**Delete:**
- `backend/routes/cx.py` (370 lines).
- `tests/test_cx_routes.py` (128 lines).

**Edit:**
- `backend/main.py`:
  - Remove `cx` from `from backend.routes import cx, drivers, markets, orders, playback` (L19).
  - Remove `app.include_router(cx.router)` (L89).
- `backend/db.py` — fully reverse commit `a2caca8`'s `InsufficientPrivilege` middleware and handler. User decision: full reversal; if a future route needs this pattern, re-add at that time (YAGNI).

### Setup / config

- `setup/config.py`:
  - Remove the two SYNCS entries (≈L66–80) for `complaints.raw_complaints → complaints.complaints_synced` and `recommender.refund_recommendations → recommender.refund_recommendations_synced`.
  - Remove the two index DDL blocks (≈L109–113): `idx_complaints_order_id`, `idx_refunds_order_id`.
  - After this change, `SYNCS` contains six entries (down from eight).
- `setup/finalize.py:103`:
  - Change `for schema in ["public", "simulator", "lakeflow", "complaints", "recommender"]:` to `for schema in ["public", "simulator", "lakeflow"]:`.
- `setup/destroy_lakebase.py`:
  - Remove `f"{SOURCE_CATALOG}.complaints.complaints_synced"` and `f"{SOURCE_CATALOG}.recommender.refund_recommendations_synced"` from the `SYNCED_TABLES` list.

### Docs

**Delete:**
- `docs/superpowers/specs/2026-03-19-customer-experience-panel-design.md`
- `docs/superpowers/plans/2026-03-19-customer-experience-panel.md`
- `research/cx-panel-handoff_2026-03-20.md`
- `tests/e2e/specs/cx-panel.spec.ts` (if tracked — verify with `git ls-files` during implementation)

**Edit:**
- `CLAUDE.md`:
  - Remove L27 (`_validate_days() in cx.py allows 0 …`).
  - Update L48: `Current SYNCS count in config.py: **8** (5 original + 1 orders_enriched + 2 CX)` → `**6** (5 original + 1 orders_enriched)`.
  - Add a brief note under `## Data & Schema` or a new section: "As of 2026-04-20, twins no longer consumes `complaints.*` or `recommender.*` tables. If those tables are present in the shared catalog, they are produced by caspers for caspers' own consumers and are not read by twins."
- `docs/roadmap-handoff.md`:
  - Strip the CX-related bullets under `## Next Milestone → ### Customer Experience`. Leave the rest of that section untouched.
- `docs/roadmap-storeops-ai.md`:
  - Remove `tools/complaints.py` and the `get_complaints_summary` + `get_complaint_detail` rows from the Phase 1 tools table.
  - Remove the complaint-related phase-2 SQL lookups and any complaint-related sample questions in the Genie Space section.

### Root-level scratch (untracked)

**Delete** (not tracked but clean up):
- `test-cx-panel.js`
- `test-cx-auth-redirect.png`
- `test-cx-blocked-state.png`

---

## Orphaned live resources

**What stays behind in production, intentionally:**

| Resource | Where | Impact |
|---|---|---|
| `vdm_classic_rikfy0_catalog.complaints.complaints_synced` | Shared UC catalog | SNAPSHOT sync; no consumer reads it; minimal cost |
| `vdm_classic_rikfy0_catalog.recommender.refund_recommendations_synced` | Shared UC catalog | SNAPSHOT sync; same |
| Postgres `complaints.complaints_synced` | twins Lakebase instance | Sync target; storage + minor CU |
| Postgres `recommender.refund_recommendations_synced` | twins Lakebase instance | Same |
| Sync pipelines (auto-created by Databricks when syncs were registered) | Databricks workspace | Continue on schedule, no consumer |
| Catalog grants on `complaints` / `recommender` schemas to the app SP | UC | Harmless |

**Cleanup path:** the next `bundle run destroy-lakebase` wipes the Lakebase instance (step 2 of destroy) — Postgres tables disappear with it. A subsequent fresh `setup-lakebase` does NOT recreate the syncs (since removed from config). Catalog-side UC-registered synced tables may remain as stale pointers until manually dropped.

**Monitoring note for operators:** a twins audit of the Lakebase instance will show these two schemas until the next full teardown. That's expected until someone runs destroy.

---

## Implementation ordering (4 commits, 1 PR)

### Commit 1 — Frontend removal
- Delete `frontend/src/components/cx/` directory.
- Edit `App.tsx`, `main.tsx`, `types/index.ts`, `dominos-theme.css`.
- Verify: `cd frontend && npm run build` succeeds; `npx tsc --noEmit` passes.
- Commit message: `refactor(cx): remove Customer Experience panel frontend`

### Commit 2 — Backend removal
- Delete `backend/routes/cx.py`, `tests/test_cx_routes.py`.
- Edit `backend/main.py`, `backend/db.py` (reverse `a2caca8` middleware).
- Verify: `python -c "from backend.main import app"` imports cleanly; `python -m pytest tests/ --collect-only` shows no CX tests and no collection errors.
- Commit message: `refactor(cx): remove Customer Experience backend routes + middleware`

### Commit 3 — Setup / config removal
- Edit `setup/config.py`, `setup/finalize.py`, `setup/destroy_lakebase.py`.
- Verify: `python -m py_compile setup/*.py` succeeds.
- Commit message: `refactor(cx): remove complaints/refund syncs, indexes, and grants`

### Commit 4 — Docs + scratch cleanup
- Delete spec, plan, research-handoff doc, tracked e2e CX spec, root-level scratch files.
- Edit `CLAUDE.md`, `docs/roadmap-handoff.md`, `docs/roadmap-storeops-ai.md`.
- Commit message: `docs(cx): remove CX specs, plans, research, and roadmap references`

**Why 4 commits**: reviewers can step through layer by layer and bisect if a regression ever appears. The PR is atomic (one merge).

---

## Verification

### Static checks (must all pass locally before PR)

- [ ] `cd frontend && npm run build`
- [ ] `cd frontend && npx tsc --noEmit`
- [ ] `python -c "from backend.main import app"`
- [ ] `python -m pytest tests/`
- [ ] `python -m py_compile setup/*.py`

### Grep checks (must all return empty / expected)

- [ ] `grep -rn "cx\.router\|from backend.routes import cx\|import cx " backend/` — empty
- [ ] `grep -rn "CXPanel\|CXStore\|CXComplaint\|CXRefund\|CXGlobal\|CXOverview" frontend/src/` — empty
- [ ] `grep -rn "complaints_synced\|refund_recommendations_synced" setup/ backend/` — empty
- [ ] `grep -n "complaints\|recommender" setup/finalize.py` — returns only lines that are not in the schema-grant list (i.e., comments or unrelated references; the grant list itself should no longer contain them)
- [ ] `grep -rn "/cx\b\|className=\"cx-" frontend/src/` — empty

### Post-deploy smoke test (manual, on live app after merge)

- [ ] Browser loads root URL, map + orders render as before.
- [ ] Nav bar contains no CX link.
- [ ] Navigating to `/cx` shows router no-match (404-style fallback), not a crash.
- [ ] Visiting `?order=<id>` does NOT auto-open the order drawer (deep-link reverted).
- [ ] All existing APIs return 200: `/api/health`, `/api/orders`, `/api/drivers`, `/api/markets`, `/api/playback`.
- [ ] No new errors in `databricks apps logs twins-digital-twin -p DEFAULT`.

---

## Risks + mitigations

| Risk | Likelihood | Mitigation |
|---|---|---|
| TypeScript build fails due to dangling type import | Medium | Commit 1 verification step blocks proceeding until fixed |
| `backend/db.py` middleware revert breaks non-CX routes | Low | Commit 2 verification (`from backend.main import app` + pytest) catches import-time; smoke test catches runtime |
| Hidden CX reference missed | Medium | Grep checklist in verification section is exhaustive; if one slips through, small follow-up commit |
| Deleting specs/plans loses institutional memory | Low | Git history preserves everything; commit 4 names deleted files explicitly so `git log -S "customer-experience-panel"` finds them |
| Orphaned syncs surprise a future operator | Low | `CLAUDE.md` note explicitly documents the expected-orphan state |
| User later wants CX back | Low | Resurrect from git: `git show <sha>:frontend/src/components/cx/CXPanel.tsx`, etc. Spec + plan are similarly recoverable |

---

## Deliverables

- One branch, one PR, four commits.
- All verification checks passing.
- `CLAUDE.md` updated with SYNCS count (6) and orphan note.
- Merged to main; smoke-tested on the live app.

---

## Out of scope / future work

- **Phase 0 `scripts/deploy.sh`** — separate in-flight work, independent.
- **Phase 1 event datagen absorption** — future spec, will draw on the caspers audit.
- **Catalog-side cleanup of orphaned synced tables** — happens naturally on next full destroy cycle.
- **Cost audit of the orphaned sync pipelines** — if a future audit shows material cost, drop the UC synced-table registrations manually via MCP.
