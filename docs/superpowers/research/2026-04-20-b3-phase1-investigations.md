# B3 Phase 1 — Investigation Findings (2026-04-20)

**Status:** Phase 1 original plan invalidated. A new spec is required before implementation.
**Context:** Pre-implementation investigations from `docs/superpowers/plans/2026-04-20-b3-roadmap.md` Tasks 1–6 revealed that the event-datagen absorption is several-fold more complex than the spec assumed. Phase 0 (`scripts/deploy.sh`) is unaffected and proceeds.

## What we thought vs. what's true

| Original spec assumption | Reality (discovered 2026-04-20) |
|---|---|
| `raw_data.ipynb` creates `lakeflow.all_events` + `simulator.locations` | Creates `simulator.{brands,menus,categories,items}` + an events **Volume**. Does NOT touch `all_events` or `locations`. |
| Notebook is idempotent | Uses `write.mode("overwrite")` — clobbers dimensional tables on every run. |
| Notebook is self-contained — copy verbatim | Reads `../data/dimensional/*.parquet`, `../data/generator/configs/*.json`; imports `../utils/`; references `../data/generator/generator` notebook. |
| Notebook is declarative | Creates Databricks jobs at runtime via the SDK — a DAB anti-pattern. |
| `canonical_data.ipynb` advances `MAX(ts)` on `all_events` directly | Writes event parquet files into `/Volumes/{CATALOG}/{SCHEMA}/{VOLUME}`. Uses a watermark file `_watermark` (no locking — concurrent runs can produce duplicates). Reads `./canonical_dataset/events.parquet` from workspace files. |

## Actual caspers event pipeline (reconstructed)

```
raw_data.ipynb (one-shot)
  ├─ Creates dim tables: simulator.{brands,menus,categories,items}
  ├─ Creates Volume:      {catalog}.simulator.{events_volume}
  └─ Creates dynamic jobs (runtime SDK)
        │
        ▼
canonical_data.ipynb (scheduled every 3 min)
  ├─ Reads last-run pointer:  /Volumes/.../misc/_watermark
  ├─ Reads canonical events:  ./canonical_dataset/events.parquet  (workspace file)
  ├─ Writes event parquet:    /Volumes/.../events/
  └─ Updates watermark
        │
        ▼
Caspers SDP pipeline  ← NOT investigated; referenced as `Spark_Declarative_Pipeline` in caspers' databricks.yml
  ├─ Reads volume parquet files
  └─ Produces lakeflow.all_events  (Delta table — this is what twins' synced table consumes)

Unknown source
  └─ Produces simulator.locations  (not created by either investigated notebook)
```

## To truly absorb events into twins, we'd need to bring over:

1. `raw_data.ipynb` (bootstrap)
2. `canonical_data.ipynb` (scheduled writer)
3. Whatever caspers SDP pipeline consumes the volume → produces `lakeflow.all_events`
4. Whatever creates `simulator.locations`
5. All workspace-file assets:
   - `../data/dimensional/*.parquet` (brands, menus, categories, items)
   - `../data/generator/configs/*.json`
   - `../data/generator/generator` (a nested notebook)
   - `./canonical_dataset/events.parquet`
   - `../utils/` Python module
6. A rewrite of the runtime-job-creation pattern into DAB-declared jobs
7. A fix for the watermark concurrency race (distributed lock, or serialize runs)

## Additional risks surfaced

- **DAB `schemas` resource behavior on pre-existing schemas is undocumented.** All four target schemas (`simulator`, `complaints`, `recommender`, `lakeflow`) already exist. Need to test DAB schema claims on a disposable schema before using on real ones.
- **Watermark file concurrency:** `canonical_data.ipynb` uses a plain text watermark. If a 3-min-scheduled run takes longer than 3 min (or manual triggers overlap), two runs race and duplicate events. Current caspers scheduler avoids this by accident, not by design.
- **Start-day behavior:** Cold-start seeds from `START_DAY + NOW.time()`. Restart after downtime jumps forward (expected but worth documenting for operators).

## What Phase 0 still achieves (unchanged)

`scripts/deploy.sh` + existing `create_syncs.py` self-heal:
- Every deploy rebuilds stale UC registrations automatically.
- Kills the silent-503 failure class we hit on 2026-04-16.
- Does NOT require absorbing caspers datagen.

Phase 0 is the right safety net even if Phase 1 takes months.

## Next steps for a future Phase 1 spec

1. **Read caspers `databricks.yml` in full** — identify every job/pipeline/notebook involved in events + locations.
2. **Find `simulator.locations` source** — trace its origin (possibly `init.ipynb`, another stage, or an external data seed).
3. **Audit relative paths** — decide whether to vendor the `../data/` tree into twins or reference via UC Volume.
4. **Decide on job-creation pattern** — rewrite runtime job creation as DAB-declared jobs.
5. **Solve watermark concurrency** — Delta-transaction-based watermark, distributed lock, or single-writer job policy.
6. **Estimate realistic effort** — likely 2–3 weeks of focused work, not the 1-week multi-day the original spec implied.

## Verdict

- Phase 0 (deploy.sh): ✅ proceed with implementation.
- Phase 1 (event datagen absorption): ⛔ original plan abandoned. New brainstorm + spec required once scope is re-scoped.

---

*Investigations performed via the superpowers:brainstorming + writing-plans + subagent-driven-development flow. Findings committed to the worktree at `.claude/worktrees/b3-impl/`.*
