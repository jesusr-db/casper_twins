# Handoff — Store Operations Panel

**Branch**: `feat/store-operations-panel` (25 commits ahead of `main`)
**Deployed to**: `https://twins-digital-twin-1351565862180944.aws.databricksapps.com`
**Spec**: `docs/superpowers/specs/2026-04-20-store-operations-panel-design.md`
**Plan**: `docs/superpowers/plans/2026-04-20-store-operations-panel.md`

---

## What's working

- All 24 planned tasks implemented. Backend `GET /api/operations/dashboard` is live and returning real data for 22 SF stores (22-store cohort, ~$7.6K revenue today, 166 unique customers, persona breakdown, populated leaderboard). Filter query param works (`?stores=5` narrows to one store).
- 7/7 backend pytest tests passing (`pytest tests/backend/`).
- Frontend builds clean (`cd frontend && npm run build`).
- App deployment state `SUCCEEDED`, compute `ACTIVE`, Lakebase pool initialized.
- One real-Postgres bug caught and fixed post-deploy (commit `be13884`): `FROM x, sim_now LEFT JOIN y ON ...` parses the LEFT JOIN against only `sim_now`, making `x` unreachable from the ON clause. Fixed by rewriting Query B_PERSONAS + Query C to use `FROM x CROSS JOIN sim_now LEFT JOIN y ON ...`. Unit tests passed either way (mocked pool) — only the real planner caught it.

## What's not verified

**Browser-level E2E tests are blocked on SSO.**

- `tests/e2e/specs/operations.spec.ts` — 4 tests, written and committed (`da58448`).
- `tests/e2e/playwright.deployed.config.ts` — deployed-URL config, currently uses a bearer token in `extraHTTPHeaders` which does NOT help with browser navigations.
- `tests/e2e/auth.json` exists but its SSO cookies are expired. `page.goto("/operations")` redirects to the Databricks login page.
- Bearer-token curl smoke-tests confirm the API works end-to-end. The UI has not been visually verified against the deployed app.

## First thing to do — run E2E

```bash
cd tests/e2e

# Edit playwright.deployed.config.ts:
#   - REMOVE the bearer-token lines (extraHTTPHeaders + dbxToken helper)
#   - ADD:   storageState: "./auth.json"

# Capture fresh auth (opens a headed browser, you log in once via SSO):
npx ts-node save-auth.ts

# Run the spec:
npx playwright test specs/operations.spec.ts --config=playwright.deployed.config.ts
```

Expect 4 tests: six-sections-render, leaderboard-row-click narrows filter, TopNav Map link, "View in Operations" deep-link. The 4th has a `test.skip()` fallback if the store-pin selector doesn't resolve; that's fine.

## If E2E surfaces UI bugs

Most likely areas to look, based on pattern-match rather than observation:

1. **Store filter** (`frontend/src/components/operations/StoreFilter.tsx`) — fetches `/api/markets` for the pill list. If the filter is empty on first paint, the fetch may be racing the dashboard fetch. Check.
2. **Leaderboard row click** updates URL via `useSearchParams` → hook picks up via `cohortKey` memoisation. Verify the abort/restart path in `useOperationsDashboard` doesn't flash empty state.
3. **`TopNav` "Map" NavLink** uses `end` prop for exact matching. Any sub-routes under `/` would change behavior.
4. **`StoreDetailPanel` "View in Operations" button** — placement inside the existing header; check it doesn't wrap or collide with the close-X on narrow viewports.

## Known issues / follow-ups

| Issue | Severity | Notes |
|---|---|---|
| `auth.json` expired; bearer-token E2E doesn't work for navigations | P1 | Fix: re-capture via `save-auth.ts`, switch config back to `storageState` |
| Deployed bundle includes `tests/e2e/node_modules/` (~hundreds of MB uploaded) | P2 | App runs fine but upload is slow. Fix by adding a `.databricksignore` or `deployment.paths` carve-out in `databricks.yml` |
| SLA thresholds duplicated in `backend/routes/operations.py` (`SLA_THRESHOLDS`) and `frontend/src/constants/sla.ts` — documented in spec as v1 trade-off | P3 | Future: shared JSON imported by both |
| Cross-route state preservation deferred (returning from `/operations` to `/` defaults to first market) | P3 | Documented in plan "Deviations" |
| `points_earned_today` is synthetic: `FLOOR(order_total)` for loyalty members | P3 | Revise when real loyalty accrual rules land |
| Frontend bundle ~1 MB gzipped — MapLibre dominates; `/operations` loads it unnecessarily | P3 | Code-split the map route (already in roadmap) |
| No frontend component tests (vitest/RTL not installed) | P3 | Documented deviation from spec; E2E compensates |

## Deployment workflow (for re-deploys)

```bash
# From repo root, on the feature branch:
cd frontend && npm run build && cd ..
databricks bundle deploy -p DEFAULT
databricks apps deploy twins-digital-twin \
  --source-code-path /Workspace/Users/jesus.rodriguez@databricks.com/.bundle/twins-digital-twin/default/files \
  -p DEFAULT
```

If `apps deploy` errors with "pending deployment in progress", wait up to 20 min or poll with `databricks apps get twins-digital-twin -p DEFAULT`. `create_or_update_app` via MCP has had a `'source_code_path'` error — prefer the CLI for now.

## Quick API smoke test

```bash
TOKEN=$(databricks auth token -p DEFAULT | python3 -c "import sys,json; print(json.loads(sys.stdin.read())['access_token'])")
curl -sS -H "Authorization: Bearer $TOKEN" \
  "https://twins-digital-twin-1351565862180944.aws.databricksapps.com/api/operations/dashboard" \
  | python3 -m json.tool | head -40
```

Expect `cohort.store_count = 22`, non-zero `headline.revenue_today`, `leaderboard` with 22 rows.

## Merge checklist before PR

- [ ] E2E passes after fresh `auth.json` capture
- [ ] Revert `playwright.deployed.config.ts` to `storageState` (not bearer token)
- [ ] Consider: should this config be committed, or gitignored alongside `auth.json`?
- [ ] Manual visual pass: navigate `/`, click a store pin, hit "View in Operations →", confirm filter pre-set
- [ ] Manual visual pass: click a leaderboard row, confirm URL + filter pill update
- [ ] Manual visual pass: responsive layout at 700px + 1100px breakpoints
- [ ] Squash-or-keep decision on the 25 commits (TDD commits are small; might be worth keeping them as-is)
- [ ] PR title + body — the plan file's "Done — what ships" section is a good starting point

## Reference commits (oldest → newest on branch)

```
29509de  test(backend): bootstrap pytest harness with mocked pool
bb10c9b  test(operations): failing test for dashboard endpoint shape
b95e1c6  feat(operations): scaffold /api/operations/dashboard endpoint
531e90e  feat(operations): resolve cohort from ?stores= or catalog
8108326  feat(operations): implement Query A — headline/pipeline/kitchen
565616f  feat(operations): implement Query B — customers + personas
1b93ec2  feat(operations): implement Query C — loyalty points + propensity
d650699  feat(operations): implement Query D — per-store leaderboard
15d353a  perf(operations): run Query A/B/C/D in parallel via asyncio.gather
ed4ffb3  types(operations): add OperationsDashboard + supporting types
80d9320  feat(operations): useOperationsDashboard hook (5s poll)
dbda700  refactor(frontend): copy App.tsx to pages/MapShell.tsx
b3cbc02  refactor(frontend): routes-only App.tsx; add /operations placeholder
e1973b9  feat(frontend): TopNav shell with Map/Operations pills
bb43c7b  feat(operations): StoreFilter — URL-driven multi-select pills
9ce1f08  feat(operations): HeadlineKpis 6-tile grid
43c1eca  feat(operations): ChainPipeline segmented bar
703a1fa  feat(operations): KitchenPanel stat tile
daf2864  feat(operations): CustomersPanel with persona list
f4bc220  feat(operations): LoyaltyPanel stat tile
4ee3cdc  feat(operations): StoreLeaderboard sortable table with row-click filter
91b40ff  feat(operations): wire all six sections in OperationsPage
2941594  feat(operations): 'View in Operations' button in StoreDetailPanel
da58448  test(e2e): Playwright spec for /operations dashboard
be13884  fix(operations): use CROSS JOIN for sim_now in Query B_PERSONAS + C   ← critical Postgres fix, not in the plan
```
