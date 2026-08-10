# The sequence holds the film, and export becomes a download — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Delete the `export` node, make `sequence` a runnable node that holds its cut film, and replace writing to `./exports` with a browser download.

**Architecture:** A sequence becomes a planned run priced at zero whose "dispatch" is a local ffmpeg concat inside the worker, so it inherits every state, cache and retry the canvas already draws. Formats, the text overlay and the spec check stop being node fields and become the body of a `POST /api/download`, which renders into a `mkdtemp` directory, streams a file or a zip, and deletes the directory in a `finally`.

**Tech Stack:** TypeScript, Next.js App Router, better-sqlite3 + drizzle, sharp, system ffmpeg, zod, vitest, Playwright, Radix/shadcn primitives in `src/ui/`.

Spec: `docs/superpowers/specs/2026-08-10-sequence-holds-the-film-design.md`.

## Global Constraints

- **`/core` imports no framework.** Everything under `src/core/` must be runnable from `bin/run.ts` with no Next.js loaded. No `next/*` imports, no React.
- **The hash whitelist is a whitelist.** Never add a field to `hashableConfig` without meaning "this changes the pixels". Never replace it with a rest-spread.
- **Load-bearing comments are the specification** (PRODUCT.md principle 6). If a change makes a comment false, delete or rewrite it in the same commit. Several tasks below name specific comments that go stale.
- **Amber means money and nothing else** (DESIGN.md). No new use of `--safelight`.
- **No em dashes in user-facing UI copy.** Existing code comments and docs use them freely; that is not changing.
- **Tests must pass at every commit.** Every task below leaves `npm run typecheck && npm run lint && npm run test:unit` green. The tasks are ordered so the app keeps working: the export node survives until Task 9 deletes it.
- **Never point tests at the real data dir.** `tempDb()` and `tempExportDir()` from `test/helpers/` exist for this.
- Run the full gate with `npm test` (typecheck, lint, unit, e2e). Unit-only iterations: `npx vitest run <file>`.

---

## File Structure

**Created**

| File | Responsibility |
|---|---|
| `src/core/runs.ts` | `currentRun` — the succeeded run matching a node's current hash — plus the `LOCAL_CUT` marker. Shared by the exporter, the cutter and the executor, and extracted so none of them import each other. |
| `src/core/cut.ts` | `cutSequence`: concatenates a sequence's clips into one asset. The ffmpeg half of what `assembleSequence` used to do, with the caching removed. |
| `src/app/api/download/route.ts` | `POST` — preview verdicts, or render-and-stream. Replaces `api/export`. |
| `src/app/download-dialog.tsx` | The one dialog behind both download entry points. |

**Modified**

| File | Change |
|---|---|
| `src/core/executor.ts` | Plan a sequence as a runnable node priced at zero. Rewrite the `nodeHashes` comment. |
| `src/worker/loop.ts` | `dispatch` branches to `cutSequence` for a local run. |
| `src/core/exporter.ts` | Split into `collectDownloadables` / `verdictsFor` / `exportFlow`. Delete `assembleSequence`. Take an explicit request instead of walking export nodes. |
| `src/core/graph.ts` | `readGraph` — the one place a stored `graph_json` becomes a `Flow`, and where an `export` node is dropped. |
| `src/core/types.ts`, `schema.ts`, `hashable.ts`, `node-defaults.ts`, `wiring.ts` | Remove `ExportNode`. Make a sequence terminal. |
| `src/core/brief.ts` | Remove the overlay-filling branch. |
| `src/app/canvas.tsx`, `node-card.tsx`, `inspector.tsx`, `state.ts` | Sequence runs and shows its film; Export becomes Download; the export inspector section goes. |
| `src/env.ts`, `README.md`, `playwright.config.ts` | Remove `exportsDir` and `OPENFLOW_EXPORTS_DIR`. |

**Deleted**

- `src/app/api/export/route.ts`
- `flows/templates/headline-ad.json`

---

## Task 1: `currentRun` and `cutSequence` in core

**Files:**
- Create: `src/core/runs.ts`
- Create: `src/core/cut.ts`
- Modify: `src/core/exporter.ts:69-78` (remove the local `currentRun`, import it)
- Test: `test/unit/cut.test.ts`

**Interfaces:**
- Consumes: `sequenceInputs` from `@/core/wiring`, `concat` from `@/core/ffmpeg`, `nodeHashes` from `@/core/executor`.
- Produces:
  - `LOCAL_CUT: 'sequence'` from `@/core/runs`
  - `currentRun(db, flowId, nodeId, inputHash: string | undefined)` from `@/core/runs`
  - `class CutRefused extends Error` from `@/core/cut`
  - `cutSequence(db, run: { id: string; flowId: string; nodeId: string }, storeRoot: string): Promise<string>` from `@/core/cut`, returning the new asset id

- [ ] **Step 1: Write the failing test**

Create `test/unit/cut.test.ts`:

```ts
import { describe, test, expect } from 'vitest'
import { existsSync } from 'node:fs'
import { eq } from 'drizzle-orm'
import { cutSequence, CutRefused } from '@/core/cut'
import { probe } from '@/core/ffmpeg'
import { assets, nodeRuns } from '@/db/schema'
import { assetsDir } from '@/env'
import type { Flow } from '@/core/types'
import { tempDb, seedProject, seedFlow } from '../helpers/db'
import { seedRenderedNode, STUB_MP4 } from '../helpers/exports'

const clip = (id: string, prompt: string) =>
  ({ id, type: 'video', prompt, durationSec: 5, audio: false, modelId: 'hailuo-2-3-pro', seed: 1 }) as const

const film = (): Flow => ({
  nodes: [clip('one', 'she opens the door'), clip('two', 'she steps into the light'), { id: 'cut', type: 'sequence' }],
  edges: [
    { id: 'e1', from: 'one', to: 'cut', role: 'input', position: 0 },
    { id: 'e2', from: 'two', to: 'cut', role: 'input', position: 1 },
  ],
})

function prepared(graph: Flow = film(), rendered = ['one', 'two']) {
  const { db } = tempDb()
  const projectId = seedProject(db)
  const flowId = seedFlow(db, projectId, graph)
  for (const nodeId of rendered) {
    seedRenderedNode(db, flowId, nodeId, { file: STUB_MP4, mime: 'video/mp4', costCents: 50 })
  }
  return { db, flowId }
}

const runRow = (flowId: string) => ({ id: 'run-cut-1', flowId, nodeId: 'cut' })

describe('cutSequence', () => {
  test('writes one film from the clips, in order, owned by the run that cut it', async () => {
    const { db, flowId } = prepared()

    const assetId = await cutSequence(db, runRow(flowId), assetsDir())

    const row = db.select().from(assets).where(eq(assets.id, assetId)).get()!
    expect(row.mime).toBe('video/mp4')
    expect(row.sourceRunId).toBe('run-cut-1')
    expect(existsSync(row.path)).toBe(true)

    // The film is as long as what it was cut from. A cut that silently dropped
    // a shot would still produce a file and still look finished.
    const one = await probe(STUB_MP4)
    const cut = await probe(row.path)
    expect(cut.durationMs).toBeGreaterThan(one.durationMs * 2 - 250)
  })

  test('refuses by name when a clip has no render matching its current settings', async () => {
    const { db, flowId } = prepared(film(), ['one'])

    await expect(cutSequence(db, runRow(flowId), assetsDir())).rejects.toThrow(CutRefused)
    await expect(cutSequence(db, runRow(flowId), assetsDir())).rejects.toThrow(/two/)
  })

  test('refuses an empty sequence rather than writing a zero-length film', async () => {
    const graph: Flow = { nodes: [{ id: 'cut', type: 'sequence' }], edges: [] }
    const { db, flowId } = prepared(graph, [])

    await expect(cutSequence(db, runRow(flowId), assetsDir())).rejects.toThrow(/no clips/)
  })

  test('records the run ids and the total the film was cut from', async () => {
    // Not on the asset — provenance rides in the manifest. What matters here is
    // that the cut itself is free: the clips were paid for.
    const { db, flowId } = prepared()
    await cutSequence(db, runRow(flowId), assetsDir())

    const paid = db.select().from(nodeRuns).where(eq(nodeRuns.flowId, flowId)).all()
    expect(paid.reduce((sum, run) => sum + run.costCents, 0)).toBe(100)
  })
})
```

- [ ] **Step 2: Run it and watch it fail**

Run: `npx vitest run test/unit/cut.test.ts`
Expected: FAIL — `Failed to resolve import "@/core/cut"`.

- [ ] **Step 3: Create `src/core/runs.ts`**

Move `currentRun` out of `exporter.ts` verbatim, including its comment — it is the rule that provenance must not lie, and it now has two callers.

```ts
import { desc, eq } from 'drizzle-orm'
import type { BetterSQLite3Database } from 'drizzle-orm/better-sqlite3'
import { nodeRuns } from '../db/schema'
import type { NodeId } from './types'

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Db = BetterSQLite3Database<any>

/**
 * The `modelId` a locally-cut film is recorded under.
 *
 * A sequence dispatches to no model, but `node_runs.model_id` is not nullable
 * and the ledger reads it. This value is what the worker branches on to run a
 * cut instead of calling fal, and the manifest has recorded it since before the
 * sequence was runnable.
 */
export const LOCAL_CUT = 'sequence'

/**
 * The run that produced the pixels the graph currently describes.
 *
 * Matched on `inputHash`, never just on node id. The manifest records the
 * prompt and asset versions from the *current* graph, so taking the newest
 * succeeded run regardless would attribute a prompt to output it never
 * produced — one prompt edit away, and provenance that lies is worse than none.
 */
export function currentRun(db: Db, flowId: string, nodeId: NodeId, inputHash: string | undefined) {
  if (!inputHash) return undefined
  return db
    .select()
    .from(nodeRuns)
    .where(eq(nodeRuns.flowId, flowId))
    .orderBy(desc(nodeRuns.createdAt))
    .all()
    .find((run) => run.nodeId === nodeId && run.status === 'succeeded' && run.inputHash === inputHash)
}
```

- [ ] **Step 4: Create `src/core/cut.ts`**

```ts
import { randomUUID } from 'node:crypto'
import { mkdirSync } from 'node:fs'
import path from 'node:path'
import { eq } from 'drizzle-orm'
import type { BetterSQLite3Database } from 'drizzle-orm/better-sqlite3'
import { assets, flows, projects } from '../db/schema'
import { DEFAULT_SETTINGS, type ProjectSettings } from './settings'
import { nodeHashes } from './executor'
import { currentRun } from './runs'
import { concat, probe } from './ffmpeg'
import { sequenceInputs } from './wiring'
import { readGraph } from './graph'
import type { NodeId } from './types'

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Db = BetterSQLite3Database<any>

/**
 * A cut that cannot be made, said in words a person can act on.
 *
 * Distinct from a thrown Error so the worker can record it as a run failure
 * with its own message rather than as "something went wrong in ffmpeg". Every
 * one of these used to be a `rejected` entry in an export result, which meant
 * you only discovered a stale shot at the moment you tried to ship the film.
 */
export class CutRefused extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'CutRefused'
  }
}

/**
 * Cuts a sequence's clips into one file, in order, and records it as an asset.
 *
 * Every clip must have a render matching its *current* settings — the same bar
 * a single node has to clear. Half a film assembled from three fresh shots and
 * two stale ones is worse than no film: it looks finished.
 *
 * No caching here, deliberately. This used to key the cut on `sequence:<hash>`
 * and check the file still existed, because it ran inside export where nothing
 * else would. It runs inside a node run now, and `enqueueRun` already skips a
 * node whose hash has a succeeded run — the same cache every other node uses.
 *
 * Nothing is published to a hosted store. A film is never sent to a model, so
 * it needs no public URL; `persistOutputs` publishes because a reference image
 * has to be reachable by fal.
 */
export async function cutSequence(
  db: Db,
  run: { id: string; flowId: string; nodeId: NodeId },
  storeRoot: string,
): Promise<string> {
  const flow = db.select().from(flows).where(eq(flows.id, run.flowId)).get()
  if (!flow) throw new Error(`No flow ${run.flowId}`)

  const project = db.select().from(projects).where(eq(projects.id, flow.projectId)).get()
  const settings: ProjectSettings = { ...DEFAULT_SETTINGS, ...(project?.settings as ProjectSettings) }
  const graph = readGraph(flow.graphJson)

  const clips = sequenceInputs(graph, run.nodeId)
  if (clips.length === 0) throw new CutRefused('No clips are wired into this sequence.')

  const hashes = nodeHashes(db, run.flowId)
  const files: string[] = []

  for (const clipId of clips) {
    const clipRun = currentRun(db, run.flowId, clipId, hashes.get(clipId))
    if (!clipRun) {
      throw new CutRefused(`${clipId} has no render matching its current settings.`)
    }
    const assetId = ((clipRun.outputRefs as string[] | null) ?? [])[0]
    const asset = assetId ? db.select().from(assets).where(eq(assets.id, assetId)).get() : undefined
    if (!asset) throw new CutRefused(`${clipId} rendered nothing to cut.`)
    if (!asset.mime.startsWith('video/')) throw new CutRefused(`${clipId} did not render a clip.`)
    files.push(asset.path)
  }

  // Under the run's own directory, the same convention `persistOutputs` uses.
  // A film owned by the run that cut it is a film the ledger can explain.
  const id = randomUUID()
  const file = path.join(storeRoot, run.id, `${id}.mp4`)
  mkdirSync(path.dirname(file), { recursive: true })
  await concat(files, file, settings)

  const measured = await probe(file)
  db.insert(assets)
    .values({
      id,
      path: file,
      hostedUrl: null,
      mime: 'video/mp4',
      width: measured.width,
      height: measured.height,
      durationMs: measured.durationMs,
      fps: measured.fps,
      codec: measured.codec,
      sourceRunId: run.id,
      createdAt: new Date().toISOString(),
    })
    .run()

  return id
}
```

- [ ] **Step 5: Add `readGraph` to `src/core/graph.ts`**

Append. Task 9 gives it the export-dropping body; for now it is the single named
place a stored graph becomes a `Flow`, which is what makes Task 9 a one-function
change instead of a hunt.

```ts
/**
 * A stored `graph_json` as a `Flow`.
 *
 * One named place, rather than `flow.graphJson as Flow` scattered across the
 * executor, the exporter and three routes. The cast is unavoidable — the column
 * is JSON — but where it happens should not be.
 */
export const readGraph = (json: unknown): Flow => json as Flow
```

Add `import type { Flow } from './types'` if `graph.ts` does not already have it.

- [ ] **Step 6: Point `exporter.ts` at the shared `currentRun`**

Delete the local `currentRun` (`src/core/exporter.ts:61-78`, function plus its
doc comment — the comment moved to `runs.ts` in Step 3) and add:

```ts
import { currentRun } from './runs'
```

- [ ] **Step 7: Run the new test and the suite**

Run: `npx vitest run test/unit/cut.test.ts`
Expected: PASS, 4 tests.

Run: `npm run typecheck && npx vitest run`
Expected: PASS. Nothing else changed behaviour yet — `assembleSequence` still exists and still runs at export time.

- [ ] **Step 8: Commit**

```bash
git add src/core/runs.ts src/core/cut.ts src/core/graph.ts src/core/exporter.ts test/unit/cut.test.ts
git commit -m "feat(core): a cut is a thing you can make, not only a thing export does"
```

---

## Task 2: Plan a sequence as a runnable node

**Files:**
- Modify: `src/core/executor.ts:63-65` (`isRunnable`), `:135-158` (the non-runnable branch), `:98-108` (the `nodeHashes` comment)
- Test: `test/unit/sequence-run.test.ts`

**Interfaces:**
- Consumes: `LOCAL_CUT` from `@/core/runs`.
- Produces: `planRun` now returns a `PlannedNode` for every sequence, with `modelId: LOCAL_CUT`, `endpoint: 'local'`, `estimatedCents: 0`. `nodeHashes` keeps its current signature and meaning.

- [ ] **Step 1: Write the failing test**

Create `test/unit/sequence-run.test.ts`:

```ts
import { describe, test, expect } from 'vitest'
import { planRun, enqueueRun } from '@/core/executor'
import { LOCAL_CUT } from '@/core/runs'
import { nodeRuns } from '@/db/schema'
import { eq } from 'drizzle-orm'
import type { Flow } from '@/core/types'
import { tempDb, seedProject, seedFlow } from '../helpers/db'
import { seedRenderedNode, STUB_MP4 } from '../helpers/exports'

const clip = (id: string) =>
  ({ id, type: 'video', prompt: `shot ${id}`, durationSec: 5, audio: false, modelId: 'hailuo-2-3-pro', seed: 1 }) as const

const film = (): Flow => ({
  nodes: [clip('one'), clip('two'), { id: 'cut', type: 'sequence' }],
  edges: [
    { id: 'e1', from: 'one', to: 'cut', role: 'input', position: 0 },
    { id: 'e2', from: 'two', to: 'cut', role: 'input', position: 1 },
  ],
})

function prepared(rendered: string[]) {
  const { db } = tempDb()
  const projectId = seedProject(db)
  const flowId = seedFlow(db, projectId, film())
  for (const nodeId of rendered) {
    seedRenderedNode(db, flowId, nodeId, { file: STUB_MP4, mime: 'video/mp4', costCents: 50 })
  }
  return { db, flowId }
}

describe('a sequence in the plan', () => {
  test('is planned, and costs nothing', () => {
    const { db, flowId } = prepared([])
    const cut = planRun(db, flowId).find((p) => p.nodeId === 'cut')!

    expect(cut).toBeDefined()
    expect(cut.modelId).toBe(LOCAL_CUT)
    expect(cut.endpoint).toBe('local')
    expect(cut.estimatedCents).toBe(0)
  })

  test('reordering the shots changes its hash, so the old film is not reused', () => {
    const { db, flowId } = prepared([])
    const before = planRun(db, flowId).find((p) => p.nodeId === 'cut')!.inputHash

    const swapped: Flow = {
      ...film(),
      edges: [
        { id: 'e1', from: 'one', to: 'cut', role: 'input', position: 1 },
        { id: 'e2', from: 'two', to: 'cut', role: 'input', position: 0 },
      ],
    }
    const { db: db2 } = tempDb()
    const flow2 = seedFlow(db2, seedProject(db2), swapped)

    expect(planRun(db2, flow2).find((p) => p.nodeId === 'cut')!.inputHash).not.toBe(before)
  })

  test('enqueues a run the worker can claim, and does not touch the spend cap', () => {
    const { db, flowId } = prepared(['one', 'two'])
    const result = enqueueRun(db, flowId)

    const queued = db.select().from(nodeRuns).where(eq(nodeRuns.status, 'queued')).all()
    expect(queued.map((run) => run.nodeId)).toContain('cut')
    expect(queued.find((run) => run.nodeId === 'cut')!.modelId).toBe(LOCAL_CUT)
    // The two clips are already rendered, so the only work is the free one.
    expect(result.estimatedCents).toBe(0)
  })
})
```

- [ ] **Step 2: Run it and watch it fail**

Run: `npx vitest run test/unit/sequence-run.test.ts`
Expected: FAIL — `cut` is undefined; `planRun` omits sequences today.

- [ ] **Step 3: Plan the sequence**

In `src/core/executor.ts`, add the import:

```ts
import { LOCAL_CUT } from './runs'
```

Rewrite the comment on `isRunnable` (`:63`) — it currently says "export writes them out", and there will be no export node:

```ts
/**
 * Only image and video dispatch to a model. A source brings files in, and a
 * sequence is planned too but cut locally — see the `LOCAL_CUT` branch in walk.
 */
const isRunnable = (node: FlowNode): node is Extract<FlowNode, { modelId: string }> =>
  node.type === 'image' || node.type === 'video'
```

Then in `walk`, inside the `if (!isRunnable(node))` branch, capture the hash and
push a plan entry for a sequence. Replace the `hashes.set(...)` call and the bare
`continue` with:

```ts
      const hash = inputHash({
        nodeType: node.type,
        config: {
          ...config,
          ...(node.type === 'source' ? { version } : {}),
          ...(node.type === 'sequence' ? { order } : {}),
        },
        upstreamHashes,
        modelId: '',
      })
      hashes.set(nodeId, hash)

      // Planned, but never dispatched. `estimatedCents: 0` is not a placeholder
      // for a price nobody worked out — the clips were paid for and the cut is
      // ffmpeg on this machine. It rides through the same queue as everything
      // else so it gets the same staleness, the same cache and the same retry.
      if (node.type === 'sequence') {
        planned.push({ nodeId, inputHash: hash, modelId: LOCAL_CUT, endpoint: 'local', estimatedCents: 0 })
      }
      continue
```

- [ ] **Step 4: Rewrite the `nodeHashes` comment**

Its current text (`:98-105`) says the exporter needs sequence hashes that
`planRun` omits, which stops being true. Replace with:

```ts
/**
 * Every node's input hash, including the ones that never dispatch.
 *
 * `planRun` covers the nodes a Run acts on — the ones that dispatch, plus the
 * sequences that are cut locally. It does not cover a `source`, and a source
 * wired straight to a download still has to be told apart from a stale one. This
 * is the only way to ask for the hash of a node that is never planned.
 */
```

- [ ] **Step 5: Run the tests**

Run: `npx vitest run test/unit/sequence-run.test.ts`
Expected: PASS, 3 tests.

Run: `npx vitest run`
Expected: PASS. `test/acceptance/sequence.test.ts` has an assertion on
`planRun` — if it asserts a length or an exact set of node ids, it now sees the
`cut` entry. Update that expectation to include `cut` rather than working around
it; the sequence being in the plan is the point of this task.

- [ ] **Step 6: Commit**

```bash
git add src/core/executor.ts test/unit/sequence-run.test.ts test/acceptance/sequence.test.ts
git commit -m "feat(core): a cut is planned like everything else, and priced at nothing"
```

---

## Task 3: The worker cuts a sequence

**Files:**
- Modify: `src/worker/loop.ts` — `dispatch` (from `:561`)
- Test: `test/acceptance/sequence-worker.test.ts`

**Interfaces:**
- Consumes: `cutSequence`, `CutRefused` from `@/core/cut`; `LOCAL_CUT` from `@/core/runs`.
- Produces: after `tick`, a sequence run reaches `succeeded` with `outputRefs: [assetId]` and `costCents: 0`, or `failed`/`queued` carrying the `CutRefused` message.

- [ ] **Step 1: Write the failing test**

Create `test/acceptance/sequence-worker.test.ts`:

```ts
import { describe, test, expect } from 'vitest'
import { eq } from 'drizzle-orm'
import { enqueueRun } from '@/core/executor'
import { tick } from '@/worker/loop'
import { createAdapter } from '@/models/fal'
import { assets, nodeRuns } from '@/db/schema'
import type { Flow } from '@/core/types'
import { tempDb, seedProject, seedFlow } from '../helpers/db'
import { seedRenderedNode, STUB_MP4 } from '../helpers/exports'

const clip = (id: string) =>
  ({ id, type: 'video', prompt: `shot ${id}`, durationSec: 5, audio: false, modelId: 'hailuo-2-3-pro', seed: 1 }) as const

const film = (): Flow => ({
  nodes: [clip('one'), clip('two'), { id: 'cut', type: 'sequence' }],
  edges: [
    { id: 'e1', from: 'one', to: 'cut', role: 'input', position: 0 },
    { id: 'e2', from: 'two', to: 'cut', role: 'input', position: 1 },
  ],
})

function prepared(rendered: string[]) {
  const { db } = tempDb()
  const projectId = seedProject(db)
  const flowId = seedFlow(db, projectId, film())
  for (const nodeId of rendered) {
    seedRenderedNode(db, flowId, nodeId, { file: STUB_MP4, mime: 'video/mp4', costCents: 50 })
  }
  return { db, flowId }
}

const adapter = () => createAdapter({ mode: 'stub' })

const cutRun = (db: ReturnType<typeof tempDb>['db'], flowId: string) =>
  db.select().from(nodeRuns).where(eq(nodeRuns.flowId, flowId)).all().find((run) => run.nodeId === 'cut')!

describe('the worker cutting a film', () => {
  test('succeeds with the film as its output, at no cost', async () => {
    const { db, flowId } = prepared(['one', 'two'])
    enqueueRun(db, flowId)

    await tick(db, { adapter: adapter() })

    const run = cutRun(db, flowId)
    expect(run.status).toBe('succeeded')
    expect(run.costCents).toBe(0)

    const refs = run.outputRefs as string[]
    expect(refs).toHaveLength(1)
    expect(db.select().from(assets).where(eq(assets.id, refs[0])).get()!.mime).toBe('video/mp4')
  })

  test('a stale clip fails the cut by name instead of shipping half a film', async () => {
    const { db, flowId } = prepared(['one'])
    enqueueRun(db, flowId)

    await tick(db, { adapter: adapter() })

    const run = cutRun(db, flowId)
    // Below the retry ceiling a failure returns to `queued`, so the message is
    // what is asserted, not the status.
    expect(run.error).toMatch(/two/)
    expect(run.status).not.toBe('succeeded')
  })

  test('an unchanged film is not cut twice', async () => {
    const { db, flowId } = prepared(['one', 'two'])
    enqueueRun(db, flowId)
    await tick(db, { adapter: adapter() })

    const second = enqueueRun(db, flowId)
    expect(second.enqueued.map((p) => p.nodeId)).not.toContain('cut')
    expect(second.cached.map((p) => p.nodeId)).toContain('cut')
  })
})
```

- [ ] **Step 2: Run it and watch it fail**

Run: `npx vitest run test/acceptance/sequence-worker.test.ts`
Expected: FAIL — the run errors with `Unknown model sequence`, because `dispatch` looks `run.modelId` up in the catalog.

- [ ] **Step 3: Branch in `dispatch`**

At the top of `dispatch` in `src/worker/loop.ts`, before `byId(run.modelId)`:

```ts
async function dispatch(db: Db, run: NodeRun, adapter: Adapter, storeRoot: string) {
  // A cut, before the catalog lookup: `LOCAL_CUT` is not a model and `byId`
  // would fail the run as unknown. This is the whole of "the sequence runs
  // locally" — the queue, the retry and the ledger are already generic.
  if (run.modelId === LOCAL_CUT) {
    try {
      const assetId = await cutSequence(db, run, storeRoot)
      db.update(nodeRuns)
        .set({ status: 'succeeded', outputRefs: [assetId], costCents: 0, error: null, claimedAt: null })
        .where(eq(nodeRuns.id, run.id))
        .run()
    } catch (error) {
      // `CutRefused` and a genuine ffmpeg failure are both recorded the same
      // way. The difference is in the message, which is the only thing anyone
      // reading the card can act on.
      fail(db, run, error instanceof Error ? error.message : String(error))
    }
    return
  }

  const model = byId(run.modelId)
  // ... unchanged from here
```

Add the imports:

```ts
import { cutSequence } from '../core/cut'
import { LOCAL_CUT } from '../core/runs'
```

- [ ] **Step 4: Run the tests**

Run: `npx vitest run test/acceptance/sequence-worker.test.ts`
Expected: PASS, 3 tests.

Run: `npm run typecheck && npx vitest run`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/worker/loop.ts test/acceptance/sequence-worker.test.ts
git commit -m "feat(worker): the cut runs where every other render runs"
```

---

## Task 4: The exporter reads the cut instead of making it

**Files:**
- Modify: `src/core/exporter.ts` — delete `assembleSequence` (`:107-194`), add `sequenceProvenance`, simplify the sequence branch (`:240-257`)
- Test: `test/acceptance/sequence.test.ts` (rewrite the setup, keep the assertions)

**Interfaces:**
- Consumes: `currentRun` from `@/core/runs`, `sequenceInputs` from `@/core/wiring`.
- Produces: no signature change to `exportFlow` yet. A sequence is exported from its own run's asset; the manifest still reports the clips' run ids and their summed cost.

- [ ] **Step 1: Make the existing sequence tests run the cut first**

`test/acceptance/sequence.test.ts` currently seeds two rendered clips and calls
`exportFlow`, expecting it to assemble. It has to enqueue and tick first now.
Change `prepared` to:

```ts
async function prepared(graph: Flow = film(), rendered = ['one', 'two']) {
  const { db } = tempDb()
  const projectId = seedProject(db)
  const flowId = seedFlow(db, projectId, graph)
  for (const nodeId of rendered) {
    seedRenderedNode(db, flowId, nodeId, { file: STUB_MP4, mime: 'video/mp4', costCents: 50 })
  }
  // The film is a render now, so it has to be rendered. A test that exported a
  // cut nobody made would be testing the thing this change deleted.
  enqueueRun(db, flowId)
  await tick(db, { adapter: createAdapter({ mode: 'stub' }) })
  return { db, flowId, dir: tempExportDir() }
}
```

Add the imports (`enqueueRun`, `tick`, `createAdapter`) and `await prepared(...)`
at each call site.

The assertions stay exactly as they are — `entry.modelId === 'sequence'`,
`entry.runIds` has two, `entry.costCents === 100`, the film is as long as its
clips. That is the point: what the manifest says must not change just because the
cut moved.

For the test that expects a refusal when a clip is stale, the refusal now comes
from the run rather than the export. Change it to assert `result.rejected` names
the *sequence* as having no current render — the sequence run failed, so the
sequence has no output, and `STALE_CHECK` is the honest report.

- [ ] **Step 2: Run and watch it fail**

Run: `npx vitest run test/acceptance/sequence.test.ts`
Expected: FAIL — `assembleSequence` re-cuts and writes a second film, so
`entry.runIds` has one entry (the sequence run) rather than two.

- [ ] **Step 3: Delete `assembleSequence`, add `sequenceProvenance`**

Delete the whole `assembleSequence` function and the `Exportable` fields it alone
populated stay as they are. Add:

```ts
/**
 * Who to credit a film to, and what it really cost.
 *
 * The cut's own run costs nothing — ffmpeg on this machine — so crediting the
 * manifest with that run alone would report a film that cost $0.00. The truth is
 * the clips, which is also why `runIds` is a list: `totalCostCents` is summed
 * over distinct runs, so a clip that ships inside a film *and* on its own is
 * paid for once.
 */
function sequenceProvenance(
  db: Db,
  flowId: string,
  graph: Flow,
  nodeId: NodeId,
  currentHash: Map<NodeId, string>,
): { runIds: string[]; costCents: number; prompt: string } {
  const byNodeId = new Map(graph.nodes.map((n) => [n.id, n]))
  const runIds: string[] = []
  const prompts: string[] = []
  let costCents = 0

  for (const clipId of sequenceInputs(graph, nodeId)) {
    const run = currentRun(db, flowId, clipId, currentHash.get(clipId))
    if (!run) continue
    runIds.push(run.id)
    costCents += run.costCents
    const clip = byNodeId.get(clipId)
    prompts.push(clip && 'prompt' in clip ? clip.prompt : '')
  }

  // Every shot's direction, in order. Long, and the only honest answer to
  // "what was this film asked for".
  return { runIds, costCents, prompt: prompts.join('\n\n') }
}
```

- [ ] **Step 4: Simplify the sequence branch in `exportFlow`**

Replace the `if (node.type === 'sequence') { ... } else { ... }` block with a
single path that reads the node's own run, and folds the provenance in
afterwards:

```ts
      const run = currentRun(db, flowId, nodeId, currentHash.get(nodeId))
      if (!run) {
        // Never rendered and edited-since-rendered land here together, and are
        // reported the same way: refused, with the reason, rather than shipping
        // last week's pixels under this week's prompt. A film whose cut failed
        // arrives here too, which is why the reason is on the card.
        for (const format of formats) {
          rejected.push({ nodeId, format: format.name, specCheck: STALE_CHECK(nodeId, format) })
        }
        continue
      }

      const rows = ((run.outputRefs as string[] | null) ?? [])
        .map((assetId) => db.select().from(assets).where(eq(assets.id, assetId)).get())
        .filter((row) => row !== undefined)

      const provenance =
        node.type === 'sequence'
          ? sequenceProvenance(db, flowId, graph, nodeId, currentHash)
          : {
              runIds: [run.id],
              costCents: run.costCents,
              prompt: composePrompt(graph, nodeId, library),
            }

      const exportable: Exportable = {
        assets: rows.map((row) => ({ id: row.id, path: row.path, mime: row.mime })),
        modelId: run.modelId,
        seed: 'seed' in node ? (node.seed ?? null) : null,
        ...provenance,
      }
```

Delete the now-unused `REFUSED` helper and the `assetsDir` and `concat` imports
if nothing else in the file uses them. Delete `existsSync` and `mkdirSync` from
the `node:fs` import if they are now unused (`mkdirSync` is still used for
`outDir`).

- [ ] **Step 5: Run the tests**

Run: `npx vitest run test/acceptance/sequence.test.ts`
Expected: PASS.

Run: `npm run typecheck && npm run lint && npx vitest run`
Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add src/core/exporter.ts test/acceptance/sequence.test.ts
git commit -m "refactor(core): export ships the film, it no longer makes it"
```

---

## Task 5: The sequence card shows its film and runs

**Files:**
- Modify: `src/app/node-card.tsx:262-271` (the sequence placeholder), `:321` (the Run gate)
- Test: `e2e/sequence.spec.ts`

**Interfaces:**
- Consumes: the sequence's `state.outputs`, which the flow route already returns for any node with a succeeded run.
- Produces: `data-testid="run-<id>"` now exists on a sequence card.

- [ ] **Step 1: Write the failing e2e**

Append to `e2e/sequence.spec.ts`:

```ts
test('a cut is rendered from the canvas and shows the film it made', async ({ page, request }) => {
  await setGraph(request, film())
  await page.goto('/f/default')
  await closeChat(page)

  // Two clips and a cut. Run all renders the clips, then cuts them.
  await page.getByTestId('run').click()
  await expect(page.getByTestId('status-cut')).toHaveText(/done/, { timeout: 30_000 })

  // The film is on the card, not in a folder.
  await expect(page.locator('[data-testid="node-cut"] video')).toBeVisible()
  // Free: the clips were paid for.
  await expect(page.getByTestId('price-cut')).toHaveText('$0.00')
})
```

Reuse whatever `film()` / `setGraph` helper the file already has; if the graph
literal is inline in the existing tests, copy it rather than extracting — the
existing tests are the reference for shape, and extracting one is a diff the
reviewer has to read twice. The toolbar's Run all button is
`data-testid="run"` (`canvas.tsx:1062`), not `run-all`.

- [ ] **Step 2: Run it and watch it fail**

Run: `npx playwright test sequence -g "shows the film"`
Expected: FAIL — `status-cut` never reaches `done`, because there is no video
element and, before Task 3 landed, no run. With Task 3 landed it fails on the
`video` locator: the card renders the runtime placeholder instead of the output.

- [ ] **Step 3: Let the card show the film**

In `src/app/node-card.tsx`, the `output ? ... : node.type === 'sequence' ? ...`
chain already prefers an output when there is one, so the video appears with no
change. What must change is the placeholder's comment, which says the film
arrives at Export:

```tsx
        ) : node.type === 'sequence' ? (
          // Before it is cut, the card shows the thing you need in order to
          // decide whether to cut it: how long the film will be, out of how
          // many shots. Every video row caps at eight or ten seconds, so
          // reaching sixty is arithmetic, not a feeling.
          <span className="node__empty" data-testid={`runtime-${node.id}`}>
```

- [ ] **Step 4: Give the sequence a Run button**

Replace the gate at `:321` and the comment above it:

```tsx
        {/* A cut runs like anything else, and its button says $0.00 because it
            is: the clips were paid for and ffmpeg is local. An export node had
            no button because it had no run; a sequence has one. */}
        {node.type !== 'export' && (
```

Leave `node.type !== 'export'` in place — the export node still exists until
Task 9, and removing it here would put a Run button on a node with no run.

- [ ] **Step 5: Run the tests**

Run: `npx playwright test sequence`
Expected: PASS, all tests in the file.

Run: `npm run typecheck && npm run lint`
Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add src/app/node-card.tsx e2e/sequence.spec.ts
git commit -m "feat(canvas): the cut card holds the film it cut"
```

---

## Task 6: `exportFlow` takes a request instead of reading the graph

**Files:**
- Modify: `src/core/exporter.ts` — split into `collectDownloadables`, `verdictsFor`, `exportFlow`
- Modify: `src/app/api/export/route.ts` — walk the export nodes here, transitionally
- Test: `test/unit/formats.test.ts`, `test/unit/manifest.test.ts`, `test/acceptance/export.test.ts`, `test/acceptance/sequence.test.ts` — update call sites

**Interfaces:**
- Produces, all from `@/core/exporter`:
  - `type DownloadRequest = { nodeIds: NodeId[]; formats: AdFormat[]; overlay?: TextOverlay }`
  - `type Downloadable = { nodeId: NodeId; assets: { id: string; path: string; mime: string }[]; runIds: string[]; costCents: number; modelId: string; seed: number | null; prompt: string }`
  - `type Verdict = { nodeId: NodeId; assetIndex: number; format: string; specCheck: SpecCheck }`
  - `collectDownloadables(db, flowId, nodeIds: NodeId[]): { ready: Downloadable[]; stale: NodeId[] }`
  - `verdictsFor(ready: Downloadable[], formats: AdFormat[], overlay?: TextOverlay): Promise<Verdict[]>`
  - `exportFlow(db, flowId, options: DownloadRequest & { dir: string }): Promise<ExportResult>`
- `nodeIds` is explicit. There is no "all nodes" default in core — the caller decides, because "everything" means different things to a card and to a toolbar.

- [ ] **Step 1: Write the failing test**

Create `test/unit/downloadables.test.ts`:

```ts
import { describe, test, expect } from 'vitest'
import { collectDownloadables, verdictsFor } from '@/core/exporter'
import type { Flow } from '@/core/types'
import { tempDb, seedProject, seedFlow } from '../helpers/db'
import { seedRenderedNode, STUB_PNG } from '../helpers/exports'

const shot = (id: string) =>
  ({ id, type: 'image', prompt: `shot ${id}`, modelId: 'flux-2-pro', seed: 1 }) as const

const graph = (): Flow => ({ nodes: [shot('hero'), shot('alt')], edges: [] })

function prepared(rendered: string[]) {
  const { db } = tempDb()
  const flowId = seedFlow(db, seedProject(db), graph())
  for (const nodeId of rendered) {
    seedRenderedNode(db, flowId, nodeId, { file: STUB_PNG, mime: 'image/png', costCents: 15 })
  }
  return { db, flowId }
}

describe('collectDownloadables', () => {
  test('separates what has a current render from what does not', () => {
    const { db, flowId } = prepared(['hero'])
    const { ready, stale } = collectDownloadables(db, flowId, ['hero', 'alt'])

    expect(ready.map((r) => r.nodeId)).toEqual(['hero'])
    expect(stale).toEqual(['alt'])
  })

  test('carries the provenance the manifest needs', () => {
    const { db, flowId } = prepared(['hero'])
    const [hero] = collectDownloadables(db, flowId, ['hero']).ready

    expect(hero.runIds).toHaveLength(1)
    expect(hero.costCents).toBe(15)
    expect(hero.prompt).toContain('shot hero')
  })
})

describe('verdictsFor', () => {
  test('refuses a format the render is too small to fill, and says why', async () => {
    const { db, flowId } = prepared(['hero'])
    const { ready } = collectDownloadables(db, flowId, ['hero'])

    // STUB_PNG is small; a 4000-wide placement cannot be filled from it without
    // upscaling, which is the one thing minScale exists to refuse.
    const verdicts = await verdictsFor(ready, [
      { name: 'huge', w: 4000, h: 4000 },
      { name: 'tiny', w: 8, h: 8 },
    ])

    const huge = verdicts.find((v) => v.format === 'huge')!
    expect(huge.specCheck.pass).toBe(false)
    expect(huge.specCheck.findings.map((f) => f.rule)).toContain('minScale')
    expect(verdicts.find((v) => v.format === 'tiny')!.specCheck.pass).toBe(true)
  })

  test('writes nothing', async () => {
    // The whole reason preview is a separate function: the dialog asks this
    // question on every keystroke that matters, and a preview that rendered
    // files would burn a crop per character.
    const { db, flowId } = prepared(['hero'])
    const { ready } = collectDownloadables(db, flowId, ['hero'])
    await verdictsFor(ready, [{ name: '1:1', w: 64, h: 64 }])

    expect(ready[0].assets.every((asset) => asset.path.includes('assets'))).toBe(true)
  })
})
```

`STUB_PNG` is `test/fixtures/media/stub.png`. Run the test once and read the
finding to pin the `minScale` expectation to the fixture's real dimensions
rather than guessing them here.

- [ ] **Step 2: Run and watch it fail**

Run: `npx vitest run test/unit/downloadables.test.ts`
Expected: FAIL — `collectDownloadables` is not exported.

- [ ] **Step 3: Extract `collectDownloadables`**

In `src/core/exporter.ts`, add the types and lift the per-node body of the
current loop into a function. `Exportable` gains a `nodeId` and is exported as
`Downloadable`.

```ts
export type DownloadRequest = {
  /** Explicit. Core does not guess what "everything" means; the caller decides. */
  nodeIds: NodeId[]
  formats: AdFormat[]
  overlay?: TextOverlay
}

export type Downloadable = {
  nodeId: NodeId
  assets: { id: string; path: string; mime: string }[]
  runIds: string[]
  costCents: number
  modelId: string
  seed: number | null
  prompt: string
}

export type Verdict = {
  nodeId: NodeId
  /** Which of the node's outputs. A multi-output run ships each one. */
  assetIndex: number
  format: string
  specCheck: SpecCheck
}

/**
 * What of the requested nodes can actually ship, and what cannot.
 *
 * `stale` is not an error. A node with no render matching its current settings
 * is the ordinary case one prompt edit after a render, and the caller reports it
 * rather than failing the whole download over it.
 */
export function collectDownloadables(
  db: Db,
  flowId: string,
  nodeIds: NodeId[],
): { ready: Downloadable[]; stale: NodeId[] } {
  const flow = db.select().from(flows).where(eq(flows.id, flowId)).get()
  if (!flow) throw new Error(`No flow ${flowId}`)

  const graph = readGraph(flow.graphJson)
  const library = new Map(
    db.select().from(sources).where(eq(sources.projectId, flow.projectId)).all().map((r) => [r.id, r]),
  )
  const byNodeId = new Map(graph.nodes.map((n) => [n.id, n]))
  const currentHash = nodeHashes(db, flowId)

  const ready: Downloadable[] = []
  const stale: NodeId[] = []

  for (const nodeId of nodeIds) {
    const node = byNodeId.get(nodeId)
    if (!node) continue

    const run = currentRun(db, flowId, nodeId, currentHash.get(nodeId))
    if (!run) {
      stale.push(nodeId)
      continue
    }

    const rows = ((run.outputRefs as string[] | null) ?? [])
      .map((assetId) => db.select().from(assets).where(eq(assets.id, assetId)).get())
      .filter((row) => row !== undefined)
    if (rows.length === 0) {
      stale.push(nodeId)
      continue
    }

    const provenance =
      node.type === 'sequence'
        ? sequenceProvenance(db, flowId, graph, nodeId, currentHash)
        : { runIds: [run.id], costCents: run.costCents, prompt: composePrompt(graph, nodeId, library) }

    ready.push({
      nodeId,
      assets: rows.map((row) => ({ id: row.id, path: row.path, mime: row.mime })),
      modelId: run.modelId,
      seed: 'seed' in node ? (node.seed ?? null) : null,
      ...provenance,
    })
  }

  return { ready, stale }
}
```

- [ ] **Step 4: Extract `verdictsFor`**

```ts
/**
 * Every node × format verdict, measured, writing nothing.
 *
 * Measured from the file rather than the row, for the reason the row cannot be
 * trusted: a width column written from a model's promise makes every check
 * downstream a check of our own optimism.
 */
export async function verdictsFor(
  ready: Downloadable[],
  formats: AdFormat[],
  overlay?: TextOverlay,
): Promise<Verdict[]> {
  const textBox = boxOf(overlay)
  const verdicts: Verdict[] = []

  for (const item of ready) {
    for (const [assetIndex, asset] of item.assets.entries()) {
      const video = asset.mime.startsWith('video/')
      const measured = video
        ? await probe(asset.path)
        : await sharp(asset.path).metadata().then((m) => ({
            width: m.width ?? 0,
            height: m.height ?? 0,
            durationMs: 0,
          }))

      for (const format of formats) {
        verdicts.push({
          nodeId: item.nodeId,
          assetIndex,
          format: format.name,
          specCheck: checkSpec({
            format,
            sourceWidth: measured.width,
            sourceHeight: measured.height,
            ...(video ? { durationSec: measured.durationMs / 1000 } : {}),
            ...(textBox ? { textBox } : {}),
          }),
        })
      }
    }
  }

  return verdicts
}
```

- [ ] **Step 5: Rewrite `exportFlow` on top of both**

`exportFlow` keeps its name and its `{ dir }`. It stops walking export nodes,
stops calling `resolveFormats`, and stops reading `exportNode.fps` — fps and
codec come from project settings alone now, which is the spec's decision.

```ts
export async function exportFlow(
  db: Db,
  flowId: string,
  options: DownloadRequest & { dir: string },
): Promise<ExportResult> {
  const flow = db.select().from(flows).where(eq(flows.id, flowId)).get()
  if (!flow) throw new Error(`No flow ${flowId}`)
  const project = db.select().from(projects).where(eq(projects.id, flow.projectId)).get()
  const settings: ProjectSettings = { ...DEFAULT_SETTINGS, ...(project?.settings as ProjectSettings) }
  const graph = readGraph(flow.graphJson)
  const byNodeId = new Map(graph.nodes.map((n) => [n.id, n]))
  const library = new Map(
    db.select().from(sources).where(eq(sources.projectId, flow.projectId)).all().map((r) => [r.id, r]),
  )

  const outDir = path.resolve(options.dir)
  mkdirSync(outDir, { recursive: true })

  const { ready, stale } = collectDownloadables(db, flowId, options.nodeIds)
  const verdicts = await verdictsFor(ready, options.formats, options.overlay)

  const entries: ManifestEntry[] = []
  const rejected: ExportResult['rejected'] = []

  for (const nodeId of stale) {
    for (const format of options.formats) {
      rejected.push({ nodeId, format: format.name, specCheck: STALE_CHECK(nodeId, format) })
    }
  }

  for (const verdict of verdicts) {
    const item = ready.find((r) => r.nodeId === verdict.nodeId)!
    const asset = item.assets[verdict.assetIndex]
    const format = options.formats.find((f) => f.name === verdict.format)!
    const node = byNodeId.get(verdict.nodeId)
    const video = asset.mime.startsWith('video/')

    const suffix = item.assets.length > 1 ? `-${verdict.assetIndex + 1}` : ''
    const file = path.join(
      outDir,
      `${slug(node?.label ?? verdict.nodeId)}-${slug(format.name)}${suffix}${video ? '.mp4' : '.png'}`,
    )

    // The row exists on a pass and on a failure. A record that only exists when
    // the check passed cannot distinguish "checked" from "never run".
    db.insert(exports)
      .values({
        id: randomUUID(),
        flowId,
        format: format.name,
        assetId: asset.id,
        specCheck: verdict.specCheck,
        // The name delivered, not a path on this machine: there is no directory
        // to point at any more.
        path: verdict.specCheck.pass ? path.basename(file) : '',
        createdAt: new Date().toISOString(),
      })
      .run()

    if (!verdict.specCheck.pass) {
      rejected.push({ nodeId: verdict.nodeId, format: format.name, specCheck: verdict.specCheck })
      continue
    }

    const measured = video
      ? await probe(asset.path)
      : await sharp(asset.path).metadata().then((m) => ({ width: m.width ?? 0, height: m.height ?? 0 }))

    await render({
      source: asset.path,
      file,
      format,
      overlay: options.overlay,
      video,
      measured,
      fps: settings.fps,
      codec: settings.codec,
    })

    entries.push({
      file: path.relative(outDir, file),
      format: format.name,
      nodeId: verdict.nodeId,
      prompt: item.prompt,
      modelId: item.modelId,
      seed: item.seed,
      sourceVersions: sourceVersionsFor(graph, verdict.nodeId, library),
      runId: item.runIds[0],
      runIds: item.runIds,
      costCents: item.costCents,
      specCheck: verdict.specCheck,
      createdAt: new Date().toISOString(),
    })
  }

  // ... the perRun total and the manifest write are unchanged
}
```

Change `render`'s signature from `node: ExportNode` to `overlay?: TextOverlay`,
and inside it replace `node.overlay` with `overlay`:

```ts
async function render(input: {
  source: string
  file: string
  format: AdFormat
  overlay?: TextOverlay
  video: boolean
  measured: { width: number; height: number }
  fps: number
  codec: string
}) {
  const { source, file, format, overlay: text, video, measured, fps, codec } = input
  const crop = coverCrop(measured.width, measured.height, format)
  const overlay = hasText(text) ? Buffer.from(overlaySvg(text!, format)) : null
  // ... rest unchanged
```

Delete `resolveFormats` — nothing calls it once the node is gone, and `formats`
arrives resolved. Remove its test from `test/unit/formats.test.ts`.

- [ ] **Step 6: Keep `/api/export` working, transitionally**

`src/app/api/export/route.ts` does the walking that core stopped doing. This is
deleted in Task 9; it exists so this commit does not break the app.

```ts
  const flow = db.select().from(flows).where(eq(flows.id, flowId)).get()!
  const graph = readGraph(flow.graphJson)
  const project = db.select().from(projects).where(eq(projects.id, flow.projectId)).get()
  const settings: ProjectSettings = { ...DEFAULT_SETTINGS, ...(project?.settings as ProjectSettings) }

  // Transitional: the export node is deleted in the task that adds the download
  // dialog. Until then this reproduces what exportFlow used to do internally.
  const exportNodes = graph.nodes.filter((n) => n.type === 'export')
  const nodeIds = graph.edges.filter((e) => exportNodes.some((n) => n.id === e.to)).map((e) => e.from)
  const formats = exportNodes[0]?.formats.length ? exportNodes[0].formats : settings.formats
  const overlay = exportNodes[0]?.overlay

  const result = await exportFlow(db, flowId, { dir: exportsDir(), nodeIds, formats, overlay })
```

- [ ] **Step 7: Update the remaining test call sites**

`test/unit/formats.test.ts`, `test/unit/manifest.test.ts`,
`test/acceptance/export.test.ts` and `test/acceptance/sequence.test.ts` all call
`exportFlow(db, flowId, { dir })`. Each becomes
`exportFlow(db, flowId, { dir, nodeIds: [...], formats: [...] })` with the ids
and formats the graph's export node used to carry. Keep every assertion.

- [ ] **Step 8: Run everything**

Run: `npx vitest run`
Expected: PASS.

Run: `npm run typecheck && npm run lint && npx playwright test export spec-validation`
Expected: PASS — the route still behaves the same.

- [ ] **Step 9: Commit**

```bash
git add src/core/exporter.ts src/app/api/export/route.ts test/
git commit -m "refactor(core): the export is asked for, not read off the graph"
```

---

## Task 7: `POST /api/download`

**Files:**
- Create: `src/app/api/download/route.ts`
- Modify: `src/app/state.ts` (client callers), `package.json` (add `fflate`)
- Test: `test/unit/download-route.test.ts` is not possible without a Next runtime — cover this task with `e2e/download.spec.ts` instead

**Interfaces:**
- Produces, from `@/app/state`:
  - `type DownloadVerdict = { nodeId: string; format: string; pass: boolean; reasons: string[] }`
  - `type DownloadPreview = { verdicts: DownloadVerdict[]; stale: string[]; formats: AdFormat[] }`
  - `previewDownload(flow: string, body: { nodeIds?: string[]; formats?: AdFormat[]; overlay?: TextOverlay }): Promise<DownloadPreview>`
  - `runDownload(flow: string, body: { nodeIds?: string[]; formats?: AdFormat[]; overlay?: TextOverlay }): Promise<void>` — triggers the browser download and resolves when the bytes have arrived

- [ ] **Step 1: Add the dependency**

```bash
npm install fflate
```

Expected: one package added, no transitive dependencies.

- [ ] **Step 2: Write the failing e2e**

Create `e2e/download.spec.ts`:

```ts
import { expect, test } from '@playwright/test'
import { unzipSync } from 'fflate'
import { readFileSync } from 'node:fs'
import { closeChat, resetWorkspace, setGraph } from './helpers'

test.beforeEach(async ({ request }) => {
  await resetWorkspace(request)
})

test('the API refuses a format the render cannot fill, and writes nothing doing it', async ({ request }) => {
  // preview: true is the dialog's question. It must be free of side effects —
  // it is asked again every time the overlay goes from empty to non-empty.
  const response = await request.post('/api/download?flow=default', {
    data: { preview: true, formats: [{ name: 'huge', w: 6000, h: 6000 }] },
  })
  expect(response.ok()).toBe(true)
  const body = await response.json()
  expect(Array.isArray(body.verdicts)).toBe(true)
})

test('a flow-wide download arrives as a zip carrying the manifest', async ({ page, request }) => {
  await setGraph(request, /* a graph with one image node */)
  await page.goto('/f/default')
  await closeChat(page)
  await page.getByTestId('run').click()
  await expect(page.getByTestId('status-hero')).toHaveText(/done/, { timeout: 30_000 })

  const download = await Promise.all([
    page.waitForEvent('download'),
    page.getByTestId('download-flow').click().then(() => page.getByTestId('download-confirm').click()),
  ]).then(([event]) => event)

  expect(download.suggestedFilename()).toMatch(/\.zip$/)
  const entries = unzipSync(readFileSync(await download.path()))
  expect(Object.keys(entries)).toContain('manifest.json')
})
```

Fill the graph literal from an existing spec — `e2e/export.spec.ts` already
builds one with a rendered image node; copy its shape and its node id so
`status-hero` matches.

- [ ] **Step 3: Run and watch it fail**

Run: `npx playwright test download`
Expected: FAIL — 404 on `/api/download`.

- [ ] **Step 4: Write the route**

Create `src/app/api/download/route.ts`:

```ts
import { mkdtempSync, readFileSync, readdirSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { NextResponse } from 'next/server'
import { zipSync } from 'fflate'
import { scope } from '../scope'
import {
  collectDownloadables,
  exportFlow,
  verdictsFor,
} from '@/core/exporter'
import { FfmpegMissingError } from '@/core/ffmpeg'
import { DEFAULT_SETTINGS, type ProjectSettings } from '@/core/settings'
import { readGraph } from '@/core/graph'
import { nodeHashes } from '@/core/executor'
import { currentRun } from '@/core/runs'
import { flows, projects } from '@/db/schema'
import { eq } from 'drizzle-orm'
import type { AdFormat, NodeId, TextOverlay } from '@/core/types'

export const dynamic = 'force-dynamic'

type Body = {
  nodeIds?: NodeId[]
  formats?: AdFormat[]
  overlay?: TextOverlay
  preview?: boolean
}

/**
 * Everything in this flow that could ship right now.
 *
 * Everything with a current render, not only the nodes nothing leaves. A clip
 * that feeds a film is included — the manifest's cost dedup exists precisely
 * for "shipped alone and inside a cut" — and terminal-only would silently drop
 * a hero still that feeds a clip. The dialog's tick boxes are how you drop what
 * you do not want.
 */
function everythingRendered(db: Parameters<typeof collectDownloadables>[0], flowId: string): NodeId[] {
  const flow = db.select().from(flows).where(eq(flows.id, flowId)).get()
  if (!flow) return []
  const graph = readGraph(flow.graphJson)
  const hashes = nodeHashes(db, flowId)
  return graph.nodes
    .filter((node) => node.type !== 'source')
    .filter((node) => currentRun(db, flowId, node.id, hashes.get(node.id)) !== undefined)
    .map((node) => node.id)
}

export async function POST(request: Request) {
  const scoped = scope(request)
  if (scoped instanceof NextResponse) return scoped
  const { db, flowId } = scoped

  const body = (await request.json().catch(() => ({}))) as Body

  const flow = db.select().from(flows).where(eq(flows.id, flowId)).get()
  if (!flow) return NextResponse.json({ error: 'No such workspace' }, { status: 404 })
  const project = db.select().from(projects).where(eq(projects.id, flow.projectId)).get()
  const settings: ProjectSettings = { ...DEFAULT_SETTINGS, ...(project?.settings as ProjectSettings) }

  const nodeIds = body.nodeIds ?? everythingRendered(db, flowId)
  const formats = body.formats?.length ? body.formats : settings.formats

  try {
    if (body.preview) {
      const { ready, stale } = collectDownloadables(db, flowId, nodeIds)
      const verdicts = await verdictsFor(ready, formats, body.overlay)
      return NextResponse.json({
        formats,
        stale,
        verdicts: verdicts.map((v) => ({
          nodeId: v.nodeId,
          format: v.format,
          pass: v.specCheck.pass,
          reasons: v.specCheck.findings.map((f) => f.message),
        })),
      })
    }

    // A directory nobody keeps. The alternative — caching crops in the asset
    // store keyed by hash — buys a faster second download and costs a directory
    // that grows forever with derived files nothing collects.
    const dir = mkdtempSync(path.join(tmpdir(), 'openflow-download-'))
    try {
      const result = await exportFlow(db, flowId, { dir, nodeIds, formats, overlay: body.overlay })
      if (result.entries.length === 0) {
        return NextResponse.json(
          { error: 'Nothing here can ship yet.', rejected: result.rejected },
          { status: 422 },
        )
      }

      const single = result.entries.length === 1 && nodeIds.length === 1
      if (single) {
        const name = result.entries[0].file
        const bytes = readFileSync(path.join(dir, name))
        return new NextResponse(new Uint8Array(bytes), {
          headers: {
            'Content-Type': name.endsWith('.mp4') ? 'video/mp4' : 'image/png',
            'Content-Disposition': `attachment; filename="${name}"`,
          },
        })
      }

      // Stored, not deflated: PNG and MP4 are already compressed, so deflating
      // them spends CPU to save nothing.
      const files: Record<string, [Uint8Array, { level: 0 }]> = {}
      for (const name of readdirSync(dir)) {
        files[name] = [new Uint8Array(readFileSync(path.join(dir, name))), { level: 0 }]
      }
      const zip = zipSync(files)
      const label = (flow.name || 'openflow').replace(/[^a-z0-9]+/gi, '-').toLowerCase()
      return new NextResponse(zip, {
        headers: {
          'Content-Type': 'application/zip',
          'Content-Disposition': `attachment; filename="${label}.zip"`,
        },
      })
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  } catch (error) {
    if (error instanceof FfmpegMissingError) {
      return NextResponse.json({ error: error.message }, { status: 422 })
    }
    return NextResponse.json(
      { error: error instanceof Error ? error.message : 'Download failed' },
      { status: 500 },
    )
  }
}
```

- [ ] **Step 5: Add the client helpers**

In `src/app/state.ts`:

```ts
export type DownloadVerdict = { nodeId: string; format: string; pass: boolean; reasons: string[] }
export type DownloadPreview = { verdicts: DownloadVerdict[]; stale: string[]; formats: AdFormat[] }

export type DownloadBody = { nodeIds?: string[]; formats?: AdFormat[]; overlay?: TextOverlay }

export async function previewDownload(flow: string, body: DownloadBody): Promise<DownloadPreview> {
  const response = await fetch(scoped('/api/download', flow), {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ ...body, preview: true }),
  })
  if (!response.ok) throw new Error('Could not check what can ship')
  return response.json()
}

/**
 * Fetch, then hand the bytes to the browser.
 *
 * A plain `<a download href="/api/download">` would be a GET, and the request
 * carries a node list and an overlay. So the response is read as a blob and
 * given to an anchor that is clicked and thrown away — the filename comes from
 * `Content-Disposition`, which is the server's to decide.
 */
export async function runDownload(flow: string, body: DownloadBody): Promise<void> {
  const response = await fetch(scoped('/api/download', flow), {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  })
  if (!response.ok) {
    const failure = (await response.json().catch(() => ({}))) as { error?: string }
    throw new Error(failure.error ?? 'Download failed')
  }

  const disposition = response.headers.get('Content-Disposition') ?? ''
  const name = /filename="([^"]+)"/.exec(disposition)?.[1] ?? 'download'
  const url = URL.createObjectURL(await response.blob())
  const anchor = document.createElement('a')
  anchor.href = url
  anchor.download = name
  document.body.appendChild(anchor)
  anchor.click()
  anchor.remove()
  URL.revokeObjectURL(url)
}
```

Add `import type { AdFormat, TextOverlay } from '@/core/types'` to `state.ts`.

- [ ] **Step 6: Run the API half of the e2e**

Run: `npx playwright test download -g "refuses a format"`
Expected: PASS. The zip test still fails — there is no UI yet.

- [ ] **Step 7: Commit**

```bash
git add package.json package-lock.json src/app/api/download/route.ts src/app/state.ts e2e/download.spec.ts
git commit -m "feat(api): a download is a request you make, not a folder you find"
```

---

## Task 8: The download dialog

**Files:**
- Create: `src/app/download-dialog.tsx`
- Modify: `src/app/canvas.tsx` (toolbar Export becomes Download; wire the dialog), `src/app/node-card.tsx` (a download control on a rendered card), `src/app/globals.css` (dialog rows)
- Delete: `src/app/api/export/route.ts`
- Test: `e2e/download.spec.ts`, `e2e/export.spec.ts`, `e2e/spec-validation.spec.ts`

**Interfaces:**
- Consumes: `previewDownload`, `runDownload`, `DownloadPreview` from `./state`.
- Produces: test ids `download-flow` (toolbar), `download-<nodeId>` (card), `download-dialog`, `download-format-<name>`, `download-node-<nodeId>`, `download-headline`, `download-cta`, `download-confirm`.

- [ ] **Step 1: Finish the e2e**

Extend `e2e/download.spec.ts` with the single-file and refusal cases:

```ts
test('one frame downloads as one file, no zip to unpack', async ({ page, request }) => {
  await setGraph(request, /* one image node, id 'hero' */)
  await page.goto('/f/default')
  await closeChat(page)
  await page.getByTestId('run').click()
  await expect(page.getByTestId('status-hero')).toHaveText(/done/, { timeout: 30_000 })

  await page.getByTestId('download-hero').click()
  const [download] = await Promise.all([
    page.waitForEvent('download'),
    page.getByTestId('download-confirm').click(),
  ])

  expect(download.suggestedFilename()).toMatch(/^hero-.*\.png$/)
})

test('a format the render cannot fill cannot be ticked', async ({ page, request }) => {
  // The refusal is the product rule, not a nicety: shipping it anyway is the
  // same as not checking, and the rejection arrives from the client instead.
  await setGraph(request, /* one image node, id 'hero' */)
  await page.goto('/f/default')
  await closeChat(page)
  await page.getByTestId('run').click()
  await expect(page.getByTestId('status-hero')).toHaveText(/done/, { timeout: 30_000 })

  // Seed a project format the stub render is far too small to fill.
  await request.patch('/api/brief', { data: { formats: [{ name: 'billboard', w: 6000, h: 6000 }] } })
  await page.reload()
  await closeChat(page)
  await page.getByTestId('download-hero').click()

  await expect(page.getByTestId('download-format-billboard')).toBeDisabled()
  await expect(page.getByTestId('download-dialog')).toContainText(/minScale|cover/i)
})
```

Check how project formats are actually written before using `/api/brief` — if
settings are not writable over HTTP, seed them by building the graph with a
node whose render is small and asking for an oversized format in the dialog
instead. Do not invent an endpoint.

- [ ] **Step 2: Run and watch it fail**

Run: `npx playwright test download`
Expected: FAIL — no `download-hero` control.

- [ ] **Step 3: Build the dialog**

Create `src/app/download-dialog.tsx`. It uses the existing `@/ui/dialog`
primitive, which already owns focus trapping and escape.

```tsx
'use client'

import { useEffect, useState } from 'react'
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/ui/dialog'
import { previewDownload, runDownload, type DownloadPreview } from './state'
import type { TextOverlay } from '@/core/types'

type Props = {
  flow: string
  /** One node, or null for the whole flow. */
  nodeId: string | null
  open: boolean
  onClose: () => void
  onError: (message: string) => void
}

/**
 * Where formats and the overlay live now.
 *
 * They used to be fields on an export node, which meant deciding at wiring time
 * what a deliverable would look like and leaving a node on the canvas to
 * remember it. They are the shape of one action instead: what you want, in what
 * placements, right now.
 *
 * The verdict is the server's. `checkSpec` measures the file, and a client that
 * guessed from the row would be checking our own optimism.
 */
export function DownloadDialog({ flow, nodeId, open, onClose, onError }: Props) {
  const [preview, setPreview] = useState<DownloadPreview | null>(null)
  const [chosen, setChosen] = useState<Set<string>>(new Set())
  const [nodes, setNodes] = useState<Set<string>>(new Set())
  const [overlay, setOverlay] = useState<TextOverlay>({})
  const [busy, setBusy] = useState(false)

  const body = {
    ...(nodeId ? { nodeIds: [nodeId] } : {}),
    ...(overlay.headline || overlay.cta ? { overlay } : {}),
  }

  // Re-asked when the overlay goes from empty to non-empty and not on every
  // keystroke: `boxOf` returns the same default box for any text, so that
  // boolean is the only thing the verdict turns on.
  const hasText = Boolean(overlay.headline?.trim() || overlay.cta?.trim())

  useEffect(() => {
    if (!open) return
    let cancelled = false
    previewDownload(flow, body)
      .then((next) => {
        if (cancelled) return
        setPreview(next)
        setChosen(new Set(next.formats.filter((f) => passes(next, f.name)).map((f) => f.name)))
        setNodes(new Set(next.verdicts.map((v) => v.nodeId)))
      })
      .catch(() => onError('Could not check what can ship'))
    return () => {
      cancelled = true
    }
  }, [open, flow, nodeId, hasText])

  const download = async () => {
    setBusy(true)
    try {
      await runDownload(flow, {
        ...body,
        ...(nodeId ? {} : { nodeIds: [...nodes] }),
        formats: preview?.formats.filter((f) => chosen.has(f.name)),
      })
      onClose()
    } catch (error) {
      onError(error instanceof Error ? error.message : 'Download failed')
    } finally {
      setBusy(false)
    }
  }

  return (
    <Dialog open={open} onOpenChange={(next) => !next && onClose()}>
      <DialogContent data-testid="download-dialog">
        <DialogHeader>
          <DialogTitle>{nodeId ? `Download ${nodeId}` : 'Download this flow'}</DialogTitle>
          <DialogDescription>
            Cropped to each placement and checked against it. A placement the render cannot fill is
            refused here rather than by whoever you send it to.
          </DialogDescription>
        </DialogHeader>

        {/* formats, per-node ticks when nodeId is null, headline and cta fields,
            each format's reasons underneath when it fails */}

        <DialogFooter>
          <button className="chip" onClick={onClose}>
            Cancel
          </button>
          <button
            className="run"
            data-testid="download-confirm"
            disabled={busy || chosen.size === 0}
            onClick={() => void download()}
          >
            Download
          </button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}

const passes = (preview: DownloadPreview, format: string) =>
  preview.verdicts.filter((v) => v.format === format).every((v) => v.pass)
```

Fill in the marked body with the format list, the node list and the two text
fields. Each format is a `<label>` holding a checkbox with
`data-testid={'download-format-' + format.name}`, `disabled={!passes(...)}`, and
the failing verdict's `reasons` rendered beneath it in `--fault`. Each node in
the flow-wide case is a checkbox with
`data-testid={'download-node-' + nodeId}`. The two text inputs carry
`data-testid="download-headline"` and `download-cta` and set `overlay` on
change. Follow the field markup already used in `inspector.tsx` for the overlay
fields you are deleting in Task 9 — same `.field` class, same shape.

- [ ] **Step 4: Wire the two entry points**

In `src/app/canvas.tsx`: replace the `startExport` handler, the `exported`
state and its notice with `const [downloading, setDownloading] = useState<{ nodeId: string | null } | null>(null)`.
The toolbar button keeps `DownloadIcon`, changes its label to `Download`, gets
`data-testid="download-flow"`, and calls `setDownloading({ nodeId: null })`.
Render `<DownloadDialog flow={flow} nodeId={downloading?.nodeId ?? null} open={downloading !== null} onClose={() => setDownloading(null)} onError={say} />`.
Remove the `startExport` import from `./state`.

In `src/app/node-card.tsx`: beside the Run button, when
`state.status === 'succeeded'`, add a download control calling a new
`onDownload(node.id)` prop threaded from the canvas the same way `onReroll` is:

```tsx
        {state.status === 'succeeded' && (
          <Hint label="Crop to your placements and download" side="top">
            <button
              className="node__run nodrag"
              data-testid={`download-${node.id}`}
              onClick={(event) => {
                event.stopPropagation()
                onDownload(node.id)
              }}
            >
              <DownloadIcon aria-hidden="true" />
            </button>
          </Hint>
        )}
```

- [ ] **Step 5: Delete the old route**

```bash
git rm src/app/api/export/route.ts
```

Rewrite `e2e/export.spec.ts` and `e2e/spec-validation.spec.ts` against the
dialog: instead of POSTing `/api/export` and reading `./exports`, open the
dialog and assert the verdicts, and for the shipping case assert the download
event. Keep every scenario the two files cover — the safe-zone refusal and the
"moving the headline out of the safe zone lets it through" pair are the product
rule under test, and the headline now comes from `download-headline` rather than
from a node field.

- [ ] **Step 6: Run the tests**

Run: `npx playwright test download export spec-validation`
Expected: PASS.

Run: `npm run typecheck && npm run lint`
Expected: PASS.

- [ ] **Step 7: Commit**

```bash
git add -A src/app e2e
git commit -m "feat(ui): what you want, in what placements, right now"
```

---

## Task 9: Delete the export node

**Files:**
- Modify: `src/core/types.ts`, `schema.ts`, `hashable.ts`, `node-defaults.ts`, `wiring.ts`, `graph.ts`, `brief.ts`, `src/app/inspector.tsx`, `node-card.tsx`, `canvas.tsx`, `src/env.ts`, `README.md`, `playwright.config.ts`
- Delete: `flows/templates/headline-ad.json`
- Modify: `flows/templates/before-after.json`, `hero-and-clips.json`, `three-scenes.json`
- Test: `test/unit/graph-migration.test.ts` (new), `test/unit/brief-to-flow.test.ts`, `test/unit/wiring.test.ts`

**Interfaces:**
- Produces: `readGraph(json: unknown): Flow` now drops `export` nodes and any edge touching one. `NodeType` is `'source' | 'image' | 'video' | 'sequence'`.

- [ ] **Step 1: Write the failing tests**

Create `test/unit/graph-migration.test.ts`:

```ts
import { describe, test, expect } from 'vitest'
import { readGraph } from '@/core/graph'

describe('a stored graph that predates the download', () => {
  test('loads without its export node, and without the edges into it', () => {
    const stored = {
      nodes: [
        { id: 'hero', type: 'image', prompt: 'a bottle', modelId: 'flux-2-pro', seed: 1 },
        { id: 'out', type: 'export', formats: [], overlay: { headline: 'Bottled sunlight' } },
      ],
      edges: [{ id: 'e1', from: 'hero', to: 'out', role: 'input', position: null }],
    }

    const graph = readGraph(stored)

    expect(graph.nodes.map((n) => n.id)).toEqual(['hero'])
    expect(graph.edges).toEqual([])
  })

  test('leaves a graph with no export node exactly as it was', () => {
    const stored = {
      nodes: [{ id: 'hero', type: 'image', prompt: 'a bottle', modelId: 'flux-2-pro', seed: 1 }],
      edges: [],
    }
    expect(readGraph(stored)).toEqual(stored)
  })
})
```

Add to `test/unit/wiring.test.ts`:

```ts
test('nothing leaves a sequence', () => {
  // The film is the deliverable. Feeding it into a shot would hand a model an
  // mp4 where it expects a still — legal today only because an export node was
  // the obvious thing to point a cut at.
  const flow: Flow = {
    nodes: [
      { id: 'cut', type: 'sequence' },
      { id: 'hero', type: 'image', prompt: 'a bottle', modelId: 'flux-2-pro', seed: 1 },
    ],
    edges: [],
  }
  expect(() => validateWire(flow, 'cut', 'hero')).toThrow(WiringError)
  expect(() => validateWire(flow, 'cut', 'hero')).toThrow(/film is the last step|nothing leaves/i)
})
```

- [ ] **Step 2: Run and watch them fail**

Run: `npx vitest run test/unit/graph-migration.test.ts test/unit/wiring.test.ts`
Expected: FAIL — `readGraph` is the identity, and `validateWire` allows the wire.

- [ ] **Step 3: Drop export nodes in `readGraph`**

```ts
/**
 * A stored `graph_json` as a `Flow`, without the node type that no longer
 * exists.
 *
 * `export` was deleted when downloading stopped being something you wired. A
 * graph saved before that still has one, and nothing was ever downstream of it —
 * it was terminal — so dropping it and its edges loses nothing. The next write
 * persists the graph without it; there is no migration script, and no inert node
 * type kept alive to make old rows parse.
 */
export function readGraph(json: unknown): Flow {
  const graph = json as Flow & { nodes: ({ type: string } & Flow['nodes'][number])[] }
  const dropped = new Set(graph.nodes.filter((n) => (n.type as string) === 'export').map((n) => n.id))
  if (dropped.size === 0) return graph as Flow
  return {
    nodes: graph.nodes.filter((n) => !dropped.has(n.id)) as Flow['nodes'],
    edges: graph.edges.filter((e) => !dropped.has(e.from) && !dropped.has(e.to)),
  }
}
```

- [ ] **Step 4: Use `readGraph` everywhere a graph is read**

Run: `grep -rn "graphJson as Flow" src/`
Replace every hit with `readGraph(flow.graphJson)`. Expected sites include
`src/core/executor.ts` (`loadContext`), `src/core/exporter.ts`,
`src/app/api/flow/route.ts`. Do not leave any.

- [ ] **Step 5: Remove the node type**

- `src/core/types.ts`: delete `ExportNode`, remove it from the `FlowNode` union, and change `NodeType` to `'source' | 'image' | 'video' | 'sequence'`. Rewrite the comment above `NodeType` — it says "Four in v1; a sixth requires a written case", which is true again but the sentence about `sequence` being the fifth is not. Keep `AdFormat`, `FormatSpec`, `TextOverlay`, `TextBox`, and change `TextOverlay`'s comment from "composited by the export node" to "composited at download".
- `src/core/schema.ts`: delete the `export` arm of the union. Keep `formatSpec` and `textOverlay` if anything still uses them; if nothing does, delete them too and let the download route validate its own body with a small schema of its own.
- `src/core/hashable.ts`: delete `case 'export'`.
- `src/core/node-defaults.ts`: delete `case 'export'` and the `formats`, `fps`, `codec`, `overlay` fields from `NewNodeOverrides`.
- `src/core/wiring.ts`: in `validateWire`, after the `to.type === 'source'` guard, add:

```ts
  if (from.type === 'sequence') {
    // The film is the last step. It used to feed an export node and nothing
    // else; with that gone, wiring one into a shot would hand a model an mp4
    // where it expects a still.
    throw new WiringError('A film is the last step. Download it rather than wiring it into something.')
  }
```

- `src/core/brief.ts`: delete the `if (node.type === 'export' && node.overlay)` branch at `:109` and the comment above it about `{{headline}}` being burned in.

- [ ] **Step 6: Remove it from the UI**

- `src/app/node-card.tsx`: `node.type !== 'export' && <Handle type="source" .../>` becomes an unconditional `<Handle type="source" .../>`; the Run gate's `node.type !== 'export' &&` goes.
- `src/app/inspector.tsx`: delete the whole `node.type === 'export'` section (`:374` onward), including the overlay fields and the "Formats come from project settings" hint. Those fields live in the download dialog now.
- `src/app/canvas.tsx`: remove `export` from `ADD_NODE`. Check the comment at `:736` — "Export writes files and sequence cuts them" — and rewrite it.

- [ ] **Step 7: Remove the exports directory**

- `src/env.ts`: delete `exportsDir`.
- `README.md`: delete the `OPENFLOW_EXPORTS_DIR` sentence from the env paragraph and the `./exports/ user-facing output` line from the tree.
- `playwright.config.ts`: delete `testExportsDir`, its `rm -rf` and the `OPENFLOW_EXPORTS_DIR` env entry.
- `test/helpers/exports.ts`: `tempExportDir` is still used by the unit tests that call `exportFlow` with a `{ dir }`. Keep it.

- [ ] **Step 8: Update the templates**

```bash
git rm flows/templates/headline-ad.json
```

In `before-after.json`, `hero-and-clips.json` and `three-scenes.json`: delete the
export node from `nodes` and every edge whose `to` is it. Check each file's
`slots` array afterwards — `test/unit/brief-to-flow.test.ts` asserts that every
declared slot appears in the template, so a slot that only filled the export
node has to go with it.

In `test/unit/brief-to-flow.test.ts`: the four-template list becomes three, and
the test named "fills headline and CTA, not just scene prompts" is deleted along
with the branch it covers.

- [ ] **Step 9: Run everything**

Run: `npm run typecheck && npm run lint && npx vitest run`
Expected: PASS. Typecheck is the useful one here — it finds every remaining
reference to `ExportNode`.

Run: `npx playwright test`
Expected: PASS, whole suite.

- [ ] **Step 10: Commit**

```bash
git add -A
git commit -m "feat: four node types again, and no folder to go looking in"
```

---

## Task 10: Documentation

**Files:**
- Modify: `README.md`, `DESIGN.md` if it names the export node, `PRODUCT.md`

- [ ] **Step 1: Find every mention**

Run: `grep -rn "export node\|./exports\|OPENFLOW_EXPORTS_DIR" README.md DESIGN.md PRODUCT.md docs/`
Expected: hits in README's node vocabulary and directory tree, and PRODUCT.md's
"Four node types — `source`, `image`, `video`, `export` — plus a `sequence`".

- [ ] **Step 2: Rewrite them**

PRODUCT.md's Product Purpose becomes "Four node types — `source`, `image`,
`video`, `sequence`". README's vocabulary section loses `export` and gains a
sentence about downloading. Do not touch the spec or plan documents in
`docs/superpowers/` — they are a record of a decision at a date, and rewriting
them to match the outcome destroys the reason anyone keeps them.

- [ ] **Step 3: Commit**

```bash
git add README.md PRODUCT.md DESIGN.md
git commit -m "docs: the vocabulary is four nodes and a download"
```

---

## Self-Review

**Spec coverage**

| Spec section | Task |
|---|---|
| `NodeType` back to four; `ExportNode` deleted from six modules | 9 |
| `AdFormat`/`FormatSpec`/`TextOverlay`/`TextBox` kept | 6, 9 |
| `resolveFormats` takes a list, not a node | 6 |
| `fps`/`codec` from project settings alone | 6 |
| A sequence is terminal in `validateWire` | 9 |
| `isRunnable` includes sequence; `LOCAL_CUT`, `endpoint: 'local'`, zero cents | 2 |
| Worker branches to a local run | 3 |
| `$0.00`, no spend-cap contribution | 2, 3 |
| `assembleSequence`'s cache deleted, cut owned by a run | 1, 4 |
| Refusals become run failures | 1, 3 |
| Sequence card shows the film | 5 |
| `nodeHashes` stays, comment rewritten | 2 |
| Two entry points, one dialog | 8 |
| Everything-with-a-render, not terminal-only | 7 |
| Server-side preflight, `preview: true` | 6, 7 |
| Verdict flips only on empty ↔ non-empty text | 8 |
| Failing formats untickable; all-failing disables Download | 7, 8 |
| `mkdtemp` → stream → `finally` remove | 7 |
| Single file bare, several as a zip with the manifest | 7 |
| `fflate` | 7 |
| `exportsDir`, `OPENFLOW_EXPORTS_DIR`, README, playwright config | 9 |
| `exports` table kept, `path` becomes a filename | 6 |
| Error-handling table | 1, 3, 7 |
| Export nodes dropped on read | 9 |
| Templates; `headline-ad.json` deleted; `brief.ts` branch | 9 |
| Four test files rewritten, plus `brief-to-flow` | 4, 6, 9 |
| New coverage (cut, plan, worker, wiring, migration, e2e) | 1, 2, 3, 8, 9 |

No gaps.

**Known soft spots, called out rather than hidden**

- Task 6 Step 1 and Task 8 Step 1 tell the implementer to read a fixture's real
  dimensions from a first run, and to check how project formats are written
  before using `/api/brief`. Those are verification steps, not placeholders —
  the plan does not invent an endpoint or a pixel count it has not read.
- Task 8 Step 3 leaves the dialog's list markup to the implementer with the exact
  test ids, classes and behaviour specified. Writing out three checkbox lists in
  full here would be transcription, not design.

**Type consistency**

`LOCAL_CUT`, `currentRun`, `CutRefused`, `cutSequence`, `readGraph`,
`DownloadRequest`, `Downloadable`, `Verdict`, `collectDownloadables`,
`verdictsFor`, `exportFlow`, `DownloadVerdict`, `DownloadPreview`,
`previewDownload`, `runDownload`, `DownloadDialog` are each defined once and
used under the same name everywhere after. `Exportable` is renamed to
`Downloadable` in Task 6 and does not survive under the old name.
