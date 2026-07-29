# Phase 1 — Core, Headless

**Duration:** week 1. **UI:** none. **Reference:** build-plan §3–§5, §8 week 1.

If this phase slips, cut a node type. Do not extend the week.

This is where the test infrastructure is built, because everything after it depends on the seams landing now.

---

## 1. Scaffold

- [x] Next.js + TypeScript + App Router
- [x] Vitest, Playwright (installed and CI-wired, **zero specs yet**), eslint
- [x] **eslint boundary rule**: `/core` may not import React, Next, or anything from `/app`. This one rule is what makes the headless runner and the Phase 4 MCP server nearly free — enforce it mechanically, not by memory.
- [x] Drizzle + SQLite in WAL mode, six tables per §4, indexes on `node_runs(input_hash)`, `node_runs(status)`, `node_runs(flow_id, node_id)`
- [x] `OPENFLOW_DATA_DIR` env var, defaulting to `./data`. **Nothing reads a hardcoded path.**
- [x] `FAL_MODE` env var: `live` | `replay` | `off`
- [x] `.gitignore`: `data/`, `exports/`, `node_modules/`, `.env*`
- [x] `README.md` with **Non-Goals written first**, before the executor exists (§1)

## 2. TDD units

Written test-first, in this order. Each bullet is a `describe` block; the sub-bullets are the cases that must fail before they pass.

**`/core/types.ts`** — the four-node union, `Edge`, `AssetRef`, `AdFormat`. No tests; it's types.

**`test/unit/hash.test.ts`** → `/core/hash.ts`
- identical config produces an identical hash
- key order in config does not change the hash (canonical JSON)
- changing the prompt changes the hash
- changing an **upstream node's** hash changes this node's hash
- **bumping an anchor version changes the hash** — this is the whole "new photos → everything goes stale" feature, and it is one assertion
- changing seed, model id, or node type each change the hash

**`test/unit/graph.test.ts`** → `/core/graph.ts`
- topological order over a branching DAG (one image → three videos)
- a cycle is rejected, not looped forever
- descendant walk returns every node downstream of an edit — powers stale propagation and the priced count
- a disconnected node still resolves

**`test/unit/registry.test.ts`** → `/models/registry.ts`
- role lookup returns the right row per format (`draft` / `hero` / `specialist`)
- `caps.refImages === 0` **refuses** an anchor attachment rather than silently dropping it
- `caps.startEndFrame === false` refuses an image→video `start_frame` edge at wiring time
- cost estimate math per unit: `image`, `megapixel`, `second`

**`test/unit/executor.test.ts`** → `/core/executor.ts`
- a cache hit on a known `input_hash` dispatches nothing
- a cache miss enqueues exactly one `node_runs` row
- spend cap: estimated total over `spendCapPerRun` blocks before dispatch, and blocks *before* spending, not after

**`test/unit/worker.test.ts`** → `/worker/loop.ts`
- claim is atomic — two concurrent claims do not take the same row
- a `claimed` row older than 5 minutes is reaped back to `queued`
- `fal_request_id` is persisted the instant fal accepts, before any polling
- a failure retries up to 3 times, then stays `failed`
- the in-flight semaphore respects `settings.concurrency`

## 3. Acceptance tests

These are the build plan's three "Done when" criteria, made executable. They run with `FAL_MODE=replay` against fixtures recorded in Phase 0.

**`test/acceptance/headless-run.test.ts`**
- `bin/run.ts flows/demo.json` produces the expected image files on disk
- each output has an `assets` row with probed width/height/mime
- each run has a `node_runs` row with a non-zero `cost_cents`

**`test/acceptance/cache-hit.test.ts`**
- running the same flow a second time creates **zero** new dispatches
- total added cost is exactly `0`
- outputs are still resolvable — a cache hit returns assets, it does not return nothing

**`test/acceptance/crash-resume.test.ts`**
- kill the worker while runs are in `submitted` / `polling`
- restart; the worker re-adopts those rows by `fal_request_id` and resumes
- no run is orphaned and no asset is downloaded twice

This last one is the test that will actually catch regressions in month three. Write it properly.

## 4. Other work

- [x] `/models/registry.ts` — 3 image rows + one generic fal adapter, `verifiedOn` from Phase 0
- [x] Asset store behind a 3-method interface — `put` / `get` / `url` — on local disk
- [x] Video normalisation-on-write hook (no video models yet; the boundary exists so Phase 3 plugs in)
- [x] `bin/run.ts` — `npx tsx bin/run.ts flows/demo.json`
- [x] `npm test` = typecheck → lint → vitest → playwright, one command
- [x] `.github/workflows/ci.yml` (see testing-strategy §5) — green on an empty Playwright suite

## Gate — met

All three acceptance tests green in CI (run 30474455533, first push):

1. A JSON graph produces images on disk. ✅
2. A second run costs $0. ✅
3. Killing the process mid-run and restarting resumes cleanly. ✅

`npm test` is one command, CI is green on push, and the `/core` boundary rule
was verified by watching it reject a real `import { useState } from 'react'`.

Verified through the CLI as well as the suite: `FAL_MODE=replay npm run -- run
flows/demo.json` reports `3 succeeded · $0.09`, and a second invocation reports
`3 cached · $0.00`.

### What Phase 1 does *not* yet prove

`verifiedOn: null` on every registry row is the honest statement: no live fal
call has been made. Fixtures are placeholders recorded by
`bin/record-fixtures.ts`, so the suite validates our *handling* of a plausible
response shape, not a proven one. The fal field names in `models/input.ts`
(`image_urls`, `image_url`, `duration`) are unverified for the same reason.

Recording once with `--live` closes this, and is the first thing Phase 2 should
do with a fal key in hand.
