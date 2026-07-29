# Phase 1 — Core, Headless

**Duration:** week 1. **UI:** none. **Reference:** build-plan §3–§5, §8 week 1.

If this phase slips, cut a node type. Do not extend the week.

This is where the test infrastructure is built, because everything after it depends on the seams landing now.

---

## 1. Scaffold

- [ ] Next.js + TypeScript + App Router
- [ ] Vitest, Playwright (installed and CI-wired, **zero specs yet**), eslint
- [ ] **eslint boundary rule**: `/core` may not import React, Next, or anything from `/app`. This one rule is what makes the headless runner and the Phase 4 MCP server nearly free — enforce it mechanically, not by memory.
- [ ] Drizzle + SQLite in WAL mode, six tables per §4, indexes on `node_runs(input_hash)`, `node_runs(status)`, `node_runs(flow_id, node_id)`
- [ ] `OPENFLOW_DATA_DIR` env var, defaulting to `./data`. **Nothing reads a hardcoded path.**
- [ ] `FAL_MODE` env var: `live` | `replay` | `off`
- [ ] `.gitignore`: `data/`, `exports/`, `node_modules/`, `.env*`
- [ ] `README.md` with **Non-Goals written first**, before the executor exists (§1)

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

- [ ] `/models/registry.ts` — 3 image rows + one generic fal adapter, `verifiedOn` from Phase 0
- [ ] Asset store behind a 3-method interface — `put` / `get` / `url` — on local disk
- [ ] Video normalisation-on-write hook (no video models yet; the boundary exists so Phase 3 plugs in)
- [ ] `bin/run.ts` — `npx tsx bin/run.ts flows/demo.json`
- [ ] `npm test` = typecheck → lint → vitest → playwright, one command
- [ ] `.github/workflows/ci.yml` (see testing-strategy §5) — green on an empty Playwright suite

## Gate

All three acceptance tests green in CI:

1. A JSON graph produces images on disk.
2. A second run costs $0.
3. Killing the process mid-run and restarting resumes cleanly.

Plus: `npm test` is one command, CI is green on push, and `/core` imports no framework code.
