# Agent Core Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace the one-shot brief bar with a chat agent that authors the graph incrementally through tools over `/core`, powered by OpenRouter via ai-sdk.

**Architecture:** A new `src/agent/` layer holds three files — plain graph operations, their ai-sdk tool wrappers, and the streaming loop. Every operation loads `graph_json`, calls an existing `/core` function, and writes back through `saveGraph`; `/core` gains nothing but an optimistic-concurrency guard. `src/models/llm.ts` keeps its `off | replay | live` seam and swaps its Anthropic client for OpenRouter, re-keying fixtures on the whole request so multi-turn replay cannot silently serve the wrong turn.

**Tech Stack:** Next 16 (App Router), React 19, `ai@^7`, `@openrouter/ai-sdk-provider@^3`, zod 4, drizzle + better-sqlite3, vitest, Playwright.

**Spec:** `docs/superpowers/specs/2026-08-05-agent-core-design.md`

## Global Constraints

- Node `>=22.16.0` (`.nvmrc`). Older 22.x segfaults on `better-sqlite3`.
- `LLM_MODE` keeps exactly three values: `off`, `replay`, `live`. `vitest.config.ts` and `playwright.config.ts` force `replay`; `DEMO=1` forces `replay`. No test run may open a socket to OpenRouter.
- **No business logic in `src/agent/`.** Every tool wraps an existing `/core` function. If a tool needs behaviour `/core` lacks, add it to `/core` with a unit test and call it from both surfaces. (`docs/phases/phase-4-mcp.md`)
- **`wire` calls `applyWire` from `src/core/wiring.ts`.** Never a copy, never a re-implementation. That function is the single capability gate the canvas also calls.
- **The agent never dispatches a render.** There is no `run_flow` tool. Run stays a deliberate human click.
- `/core` may not import from `next`, `react`, or `@xyflow/react` (eslint boundary rule). `src/agent/` may import `/core`, `/models`, and `/db` — not React.
- Commit at the end of every task. Commit messages: the repo uses `type(scope): a sentence in plain language about what changed for the user`, lowercase, no trailing period. Match that.
- Run `npm run typecheck && npm run lint` before every commit.

## Deviations from the spec (both reduce work, neither loses behaviour)

1. **No `graph-changed` stream part.** `src/app/canvas.tsx:198-207` already polls `/api/flow` every 1200ms and skips the poll while the user is interacting. Nodes appear on the canvas mid-conversation for free. The chat route streams plain text.
2. **The brand profile keeps its own dialog.** The spec moved it into the chat panel header. Instead the existing Brief dialog loses its brief textarea and its chip is renamed *Brand* — the profile stays exactly where it is, one fewer moving part.

## File Structure

**Created**

| File | Responsibility |
|---|---|
| `src/agent/ops.ts` | The eight graph operations as plain functions over `/core` + their zod input schemas. No ai-sdk import. This is what the unit tests exercise. |
| `src/agent/tools.ts` | Wraps `ops.ts` in ai-sdk `tool()` definitions. Nothing else. |
| `src/agent/prompt.ts` | Builds the system prompt from the brand profile, the registry rows, the wiring rules and the current graph. |
| `src/agent/loop.ts` | `streamText` + step cap + persistence of the turn. |
| `src/app/api/chat/route.ts` | HTTP: demo gate, thread load, stream out. |
| `src/app/chat-panel.tsx` | The docked panel. |
| `test/unit/flow-conflict.test.ts` | Stale-write rejection. |
| `test/unit/agent-ops.test.ts` | The eight operations. |
| `test/unit/llm-fixture-key.test.ts` | Multi-turn fixture keying. |
| `test/acceptance/chat-authoring.test.ts` | Hash parity: chat-built flow vs canvas-built flow. |
| `e2e/chat.spec.ts` | The panel builds a node under `LLM_MODE=replay`. |

**Modified**

| File | Change |
|---|---|
| `src/core/workspace.ts` | `saveGraph` returns the new stamp; add `saveGraphIfCurrent` + `StaleGraphError`. |
| `src/app/api/flow/route.ts` | GET returns `updatedAt`; PATCH takes `{ graph, updatedAt }` and 409s on stale. |
| `src/app/state.ts` | `FlowState.updatedAt`; `saveGraph(graph, updatedAt)`; `StaleGraphError`; drop `submitBrief`; add `sendChat`, `fetchMessages`. |
| `src/app/canvas.tsx` | `commit` retries once on stale; Brief chip → Brand chip; brief textarea removed; panel mounted. |
| `src/models/llm.ts` | OpenRouter via ai-sdk; request-wide fixture key; `MockLanguageModelV4` replay. |
| `src/env.ts` | `llmMode` reads `OPENROUTER_API_KEY`; add `openrouterModel()`. |
| `src/core/brief.ts` | Delete `briefPrompt`. Everything else stays. |
| `src/app/api/brief/route.ts` | Delete POST and `RESPONSE_SCHEMA`. GET/PATCH stay. |
| `src/db/index.ts` | `messages` table DDL. |
| `src/db/schema.ts` | `messages` drizzle table. |
| `package.json`, `.env`, `.env.example`, `README.md` | Dependencies, keys, non-goal wording. |

---

### Task 1: Optimistic concurrency on graph writes

Chat is the first writer to `graph_json` that is not synchronous with the person doing the writing. `saveGraph` is a blind full-row overwrite and `canvas.tsx` PATCHes the **entire** graph from `graphRef.current` on drag-end — so an agent write that lands mid-drag is silently erased. `e4ff80d`, `08339ff` and `e2dc570` are all fixes for this same surface. Do this before anything can write concurrently.

**Files:**
- Modify: `src/core/workspace.ts:71-77`
- Modify: `src/app/api/flow/route.ts:85-101`
- Modify: `src/app/state.ts:38-53`
- Modify: `src/app/canvas.tsx:212-239`
- Test: `test/unit/flow-conflict.test.ts`

**Interfaces:**
- Produces: `saveGraph(db, flowId, graph): string` — now returns the new `updatedAt` stamp. `saveGraphIfCurrent(db, flowId, graph, expected: string): string` — throws `StaleGraphError` when `expected` is not the row's current stamp. `StaleGraphError` (name `'StaleGraphError'`).
- Produces: `FlowState.updatedAt: string`, client `saveGraph(graph: Flow, updatedAt: string): Promise<void>`, client `StaleGraphError`.
- Consumes: nothing.

- [ ] **Step 1: Write the failing test**

Create `test/unit/flow-conflict.test.ts`:

```typescript
import { describe, test, expect } from 'vitest'
import { tempDb, seedProject, seedFlow } from '../helpers/db'
import { saveGraph, saveGraphIfCurrent, StaleGraphError } from '@/core/workspace'
import type { Flow } from '@/core/types'

const graphOf = (...ids: string[]): Flow => ({
  nodes: ids.map((id) => ({ id, type: 'image', prompt: '', modelRole: 'draft', seed: 1 })),
  edges: [],
})

describe('saveGraphIfCurrent', () => {
  test('accepts a write carrying the stamp it read', () => {
    const { db } = tempDb()
    const projectId = seedProject(db)
    const flowId = seedFlow(db, projectId, graphOf())

    const first = saveGraph(db, flowId, graphOf('a'))
    const second = saveGraphIfCurrent(db, flowId, graphOf('a', 'b'), first)

    expect(second).not.toBe(first)
  })

  test('refuses a write built on a graph someone else has already replaced', () => {
    // The canvas PATCHes its whole local graph on drag-end. Without this guard
    // an agent node added mid-drag is silently erased by that PATCH.
    const { db } = tempDb()
    const projectId = seedProject(db)
    const flowId = seedFlow(db, projectId, graphOf())

    const read = saveGraph(db, flowId, graphOf('a'))
    saveGraph(db, flowId, graphOf('a', 'agent')) // the agent writes

    expect(() => saveGraphIfCurrent(db, flowId, graphOf('a'), read)).toThrow(StaleGraphError)
  })

  test('two writes in the same millisecond still get different stamps', () => {
    // Date.now() has millisecond resolution and agent tool calls land faster
    // than that. Equal stamps would let a stale write through the guard.
    const { db } = tempDb()
    const projectId = seedProject(db)
    const flowId = seedFlow(db, projectId, graphOf())

    const stamps = new Set([
      saveGraph(db, flowId, graphOf('a')),
      saveGraph(db, flowId, graphOf('a', 'b')),
      saveGraph(db, flowId, graphOf('a', 'b', 'c')),
    ])

    expect(stamps.size).toBe(3)
  })
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run test/unit/flow-conflict.test.ts`
Expected: FAIL — `saveGraphIfCurrent` and `StaleGraphError` are not exported from `@/core/workspace`.

- [ ] **Step 3: Implement in `src/core/workspace.ts`**

Replace the existing `saveGraph` (currently at `src/core/workspace.ts:71-77`) with:

```typescript
export class StaleGraphError extends Error {
  constructor() {
    super('Someone else changed this flow while you were editing. Reloading.')
    this.name = 'StaleGraphError'
  }
}

/**
 * Strictly increasing, because `updated_at` is the write token.
 *
 * `new Date().toISOString()` has millisecond resolution, and an agent turn
 * lands several tool calls inside one. Two writes sharing a stamp would let a
 * PATCH built on the *first* one pass the guard against the second, which is
 * exactly the lost update the guard exists to prevent.
 */
const stamp = (previous?: string) => {
  const now = new Date().toISOString()
  if (!previous || now > previous) return now
  return new Date(new Date(previous).getTime() + 1).toISOString()
}

/** Returns the new write token. Every caller that will write again must keep it. */
export function saveGraph(db: Db, flowId: string, graph: Flow) {
  const previous = db.select().from(flows).where(eq(flows.id, flowId)).get()?.updatedAt
  const updatedAt = stamp(previous)
  db.update(flows).set({ graphJson: graph, updatedAt }).where(eq(flows.id, flowId)).run()
  return updatedAt
}

/**
 * The guarded write, for callers that hold a whole graph assembled from a read.
 *
 * The canvas is one: it PATCHes every node it has, so a write built on a stale
 * read does not merge badly — it erases whatever arrived in between.
 */
export function saveGraphIfCurrent(db: Db, flowId: string, graph: Flow, expected: string) {
  const row = db.select().from(flows).where(eq(flows.id, flowId)).get()
  if (!row) throw new Error(`No flow ${flowId}`)
  if (row.updatedAt !== expected) throw new StaleGraphError()
  return saveGraph(db, flowId, graph)
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run test/unit/flow-conflict.test.ts`
Expected: PASS (3 tests)

- [ ] **Step 5: Return the stamp from `/api/flow` GET**

In `src/app/api/flow/route.ts`, the GET handler already reads the row into `flow`. Add `updatedAt` to the JSON body — put it directly after `flowId`:

```typescript
  return NextResponse.json({
    projectId,
    flowId,
    updatedAt: flow.updatedAt,
    graph,
    sources: listSources(db, projectId),
```

- [ ] **Step 6: Guard the PATCH**

Replace the whole PATCH handler in `src/app/api/flow/route.ts`:

```typescript
export async function PATCH(request: Request) {
  const db = getDb()
  const { flowId } = ensureWorkspace(db)
  const body = (await request.json().catch(() => ({}))) as { graph?: unknown; updatedAt?: string }

  // Validated, not trusted. graph_json is the source of truth for what gets
  // dispatched and billed, so a malformed graph must be rejected at the door
  // rather than blowing up inside the worker.
  const parsed = flowSchema.safeParse(body.graph)
  if (!parsed.success) {
    return NextResponse.json({ error: parsed.error.issues[0]?.message ?? 'Invalid graph' }, { status: 400 })
  }
  if (typeof body.updatedAt !== 'string') {
    return NextResponse.json({ error: 'Missing the read this write was built on' }, { status: 400 })
  }

  try {
    const updatedAt = saveGraphIfCurrent(db, flowId, parsed.data as Flow, body.updatedAt)
    return NextResponse.json({ updatedAt })
  } catch (error) {
    // 409, not 400: the client's graph was well formed, it is just no longer
    // built on the newest state. Re-read and re-apply is the whole recovery.
    if (error instanceof StaleGraphError) {
      return NextResponse.json({ error: error.message }, { status: 409 })
    }
    throw error
  }
}
```

Update the import at the top of the file:

```typescript
import { ensureWorkspace, saveGraphIfCurrent, StaleGraphError, listSources } from '@/core/workspace'
```

(`saveGraph` is no longer used by this route — remove it from the import list.)

- [ ] **Step 7: Carry the stamp on the client**

In `src/app/state.ts`, add `updatedAt` to `FlowState` (directly after `flowId`):

```typescript
export type FlowState = {
  projectId: string
  flowId: string
  updatedAt: string
  graph: Flow
```

Then replace the client `saveGraph`:

```typescript
export class StaleGraphError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'StaleGraphError'
  }
}

/** `updatedAt` is the read this write was built on. A 409 means re-read and re-apply. */
export async function saveGraph(graph: Flow, updatedAt: string) {
  const response = await fetch('/api/flow', {
    method: 'PATCH',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ graph, updatedAt }),
  })
  if (response.status === 409) {
    throw new StaleGraphError(((await response.json()) as { error?: string }).error ?? 'Stale')
  }
  if (!response.ok) {
    throw new Error(((await response.json()) as { error?: string }).error ?? 'Could not save')
  }
}
```

- [ ] **Step 8: Re-apply once on 409 in the canvas**

`src/app/canvas.tsx` writes through exactly one path — `commit`, serialized behind `queueRef`. Track the stamp beside the graph and retry there.

Add the ref next to `graphRef` (near `src/app/canvas.tsx:98`):

```typescript
  const graphRef = useRef<Flow>({ nodes: [], edges: [] })
  const stampRef = useRef<string>('')
```

In `absorb`, record the stamp alongside the graph:

```typescript
      setState(next)
      graphRef.current = next.graph
      stampRef.current = next.updatedAt
```

Replace the body of `commit`'s queued function:

```typescript
  const commit = useCallback(
    (update: (current: Flow) => Flow) => {
      queueRef.current = queueRef.current
        .then(async () => {
          const apply = () => {
            const next = update(graphRef.current)
            graphRef.current = next
            return next
          }

          let next: Flow
          try {
            next = apply()
          } catch (error) {
            setNotice(
              error instanceof WiringError || error instanceof UnsupportedCapabilityError
                ? error.message
                : `Could not apply that change: ${error instanceof Error ? error.message : String(error)}`,
            )
            return
          }

          try {
            await saveGraph(next, stampRef.current)
          } catch (error) {
            // Someone else — the agent — wrote while this edit was in hand. Take
            // their graph and re-apply this one change on top of it, once. A
            // second failure is a real problem, not a race.
            if (error instanceof StaleGraphError) {
              await load()
              try {
                await saveGraph(apply(), stampRef.current)
              } catch (retry) {
                setNotice(retry instanceof Error ? retry.message : 'Could not save')
              }
            } else {
              setNotice(error instanceof Error ? error.message : 'Could not save')
            }
          }
          await load()
        })
        .catch(() => undefined)
      return queueRef.current
    },
    [load],
  )
```

Add `StaleGraphError` to the `@/app/state` import at the top of `canvas.tsx`.

- [ ] **Step 9: Run the whole suite**

Run: `npm run typecheck && npm run lint && npm run test:unit && npm run test:e2e`
Expected: PASS. The e2e specs drive the canvas through `commit`, so a broken stamp shows up here.

- [ ] **Step 10: Commit**

```bash
git add src/core/workspace.ts src/app/api/flow/route.ts src/app/state.ts src/app/canvas.tsx test/unit/flow-conflict.test.ts
git commit -m "fix(canvas): a change saved while something else wrote could vanish"
```

---

### Task 2: The graph operations

Eight plain functions over `/core`, with zod schemas. No ai-sdk import in this file, so the tests exercise the real behaviour without a model.

**Files:**
- Create: `src/agent/ops.ts`
- Test: `test/unit/agent-ops.test.ts`

**Interfaces:**
- Consumes: `saveGraph(db, flowId, graph): string` from Task 1.
- Produces: `createOps(db, { projectId, flowId }): Ops` with methods `listGraph()`, `addNode(input)`, `updateNode(input)`, `deleteNode(input)`, `wire(input)`, `unwire(input)`, `applyTemplate(input)`, `listSources()`. Also exports the eight zod schemas `listGraphInput`, `addNodeInput`, `updateNodeInput`, `deleteNodeInput`, `wireInput`, `unwireInput`, `applyTemplateInput`, `listSourcesInput` — Task 3 wraps these verbatim.

- [ ] **Step 1: Write the failing test**

Create `test/unit/agent-ops.test.ts`:

```typescript
import { describe, test, expect } from 'vitest'
import { tempDb, seedProject, seedFlow, seedSource } from '../helpers/db'
import { createOps } from '@/agent/ops'
import { WiringError } from '@/core/wiring'
import { UnsupportedCapabilityError } from '@/models/registry'
import type { Flow } from '@/core/types'

const EMPTY: Flow = { nodes: [], edges: [] }

function ops() {
  const { db } = tempDb()
  const projectId = seedProject(db)
  const flowId = seedFlow(db, projectId, EMPTY)
  return { db, projectId, flowId, ops: createOps(db, { projectId, flowId }) }
}

describe('add_node', () => {
  test('adds a node and hands back the id, because the next thing is to wire it', () => {
    const { ops: o } = ops()
    const { id } = o.addNode({ type: 'image', prompt: 'a serum on marble', modelRole: 'hero' })
    expect(id).toMatch(/^image-/)
    expect(o.listGraph().nodes).toHaveLength(1)
  })

  test('defaults seed to 1, matching the canvas', () => {
    // seed is folded into input_hash. A different default means a chat-built
    // node can never share a cache entry with the identical canvas-built one.
    const { ops: o } = ops()
    const { id } = o.addNode({ type: 'image', prompt: 'x' })
    const node = o.listGraph().nodes.find((n) => n.id === id)!
    expect(node).toMatchObject({ seed: 1, modelRole: 'draft' })
  })

  test('a video gets the same defaults the canvas gives it', () => {
    const { ops: o } = ops()
    const { id } = o.addNode({ type: 'video', prompt: 'push in' })
    const node = o.listGraph().nodes.find((n) => n.id === id)!
    expect(node).toMatchObject({ durationSec: 5, audio: false, modelRole: 'draft', seed: 1 })
  })

  test('places each node somewhere free, so two never land on top of each other', () => {
    const { ops: o } = ops()
    o.addNode({ type: 'image', prompt: 'a' })
    o.addNode({ type: 'image', prompt: 'b' })
    const [first, second] = o.listGraph().nodes
    expect(first.position).not.toEqual(second.position)
  })
})

describe('update_node', () => {
  test('changes only what was named', () => {
    const { ops: o } = ops()
    const { id } = o.addNode({ type: 'image', prompt: 'first', modelRole: 'draft' })
    o.updateNode({ id, prompt: 'second' })
    const node = o.listGraph().nodes.find((n) => n.id === id)!
    expect(node).toMatchObject({ prompt: 'second', modelRole: 'draft' })
  })

  test('refuses a node that is not there', () => {
    const { ops: o } = ops()
    expect(() => o.updateNode({ id: 'nope', prompt: 'x' })).toThrow(/nope/)
  })
})

describe('delete_node', () => {
  test('takes the node edges with it', () => {
    const { ops: o } = ops()
    const image = o.addNode({ type: 'image', prompt: 'still' }).id
    const video = o.addNode({ type: 'video', prompt: 'moving' }).id
    o.wire({ from: image, to: video })

    o.deleteNode({ id: image })

    const graph = o.listGraph()
    expect(graph.nodes.map((n) => n.id)).toEqual([video])
    expect(graph.edges).toEqual([])
  })
})

describe('wire', () => {
  test('infers the role rather than asking for one', () => {
    const { ops: o } = ops()
    const image = o.addNode({ type: 'image', prompt: 'still' }).id
    const video = o.addNode({ type: 'video', prompt: 'moving' }).id
    expect(o.wire({ from: image, to: video }).role).toBe('start_frame')
  })

  test('refuses a cycle', () => {
    const { ops: o } = ops()
    const a = o.addNode({ type: 'image', prompt: 'a' }).id
    const b = o.addNode({ type: 'video', prompt: 'b' }).id
    o.wire({ from: a, to: b })
    expect(() => o.wire({ from: b, to: a })).toThrow(WiringError)
  })

  test('refuses a second start frame', () => {
    const { ops: o } = ops()
    const first = o.addNode({ type: 'image', prompt: 'a' }).id
    const second = o.addNode({ type: 'image', prompt: 'b' }).id
    const video = o.addNode({ type: 'video', prompt: 'c' }).id
    o.wire({ from: first, to: video })
    expect(() => o.wire({ from: second, to: video })).toThrow(WiringError)
  })

  test('refuses one reference more than the model honours', () => {
    // This is the assertion that proves wire calls applyWire rather than a copy:
    // the capability gate lives there and nowhere else.
    const { db, projectId, flowId } = ops()
    const o = createOps(db, { projectId, flowId })
    const target = o.addNode({ type: 'image', prompt: 'shot', modelRole: 'draft' }).id
    const refs = Array.from({ length: 12 }, (_, i) =>
      o.addNode({ type: 'source', sourceId: seedSource(db, projectId, `source-${i}`) }).id,
    )
    expect(() => {
      for (const ref of refs) o.wire({ from: ref, to: target })
    }).toThrow(UnsupportedCapabilityError)
  })
})

describe('list_sources', () => {
  test('lists what the project has to reference', () => {
    const { db, projectId, ops: o } = ops()
    seedSource(db, projectId, 'source-a', { kind: 'image' })
    expect(o.listSources()).toEqual([
      expect.objectContaining({ id: 'source-a', kind: 'image', version: 1 }),
    ])
  })
})

describe('apply_template', () => {
  test('fills the slots and puts the whole template on the canvas', () => {
    const { ops: o } = ops()
    const templates = o.listTemplates()
    const first = templates[0]
    const prompts = Object.fromEntries(first.slots.map((slot) => [slot, `filled ${slot}`]))

    const { nodeIds } = o.applyTemplate({ templateId: first.id, prompts })

    expect(nodeIds.length).toBeGreaterThan(0)
    expect(o.listGraph().nodes).toHaveLength(nodeIds.length)
  })

  test('refuses a template that left a slot empty', () => {
    const { ops: o } = ops()
    const first = o.listTemplates()[0]
    expect(() => o.applyTemplate({ templateId: first.id, prompts: {} })).toThrow(/needs/)
  })
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run test/unit/agent-ops.test.ts`
Expected: FAIL — `Cannot find module '@/agent/ops'`.

- [ ] **Step 3: Write `src/agent/ops.ts`**

```typescript
import { randomUUID } from 'node:crypto'
import { eq } from 'drizzle-orm'
import { z } from 'zod'
import type { Db } from '@/db'
import { flows } from '@/db/schema'
import { saveGraph, listSources as listProjectSources } from '@/core/workspace'
import { applyWire, removeEdge, removeNode } from '@/core/wiring'
import { buildFlowFromBrief, loadTemplates } from '@/core/brief'
import { previewRun } from '@/core/preview'
import { flowSchema } from '@/core/schema'
import { freeSlot } from '@/app/slots'
import type { Flow, FlowNode } from '@/core/types'

/**
 * The agent's whole vocabulary, and nothing more.
 *
 * Every function here loads graph_json, calls a function that already exists in
 * /core, and writes it back. No new rules live in this file: the capability
 * gate is applyWire's, the node shape is nodeSchema's, the template validation
 * is buildFlowFromBrief's. A second implementation of any of them would let the
 * chat and the canvas disagree about what is legal, which is the one failure
 * this layer must not have.
 *
 * There is deliberately no run tool. The agent authors; spending stays a
 * deliberate human act, which is what keeps this inside the README's non-goal.
 */

const modelRole = z.enum(['draft', 'hero', 'specialist'])

export const listGraphInput = z.object({})
export const listSourcesInput = z.object({})

export const addNodeInput = z.object({
  type: z.enum(['source', 'image', 'video', 'export']),
  label: z.string().optional(),
  /** Required for image and video. */
  prompt: z.string().optional(),
  /** Required for source: an id from list_sources. */
  sourceId: z.string().optional(),
  modelRole: modelRole.optional(),
  durationSec: z.number().min(1).max(60).optional(),
  audio: z.boolean().optional(),
  formats: z
    .array(z.object({ name: z.string(), w: z.number(), h: z.number() }))
    .optional(),
})

export const updateNodeInput = z.object({
  id: z.string(),
  label: z.string().optional(),
  prompt: z.string().optional(),
  modelRole: modelRole.optional(),
  durationSec: z.number().min(1).max(60).optional(),
  audio: z.boolean().optional(),
  formats: z
    .array(z.object({ name: z.string(), w: z.number(), h: z.number() }))
    .optional(),
})

export const deleteNodeInput = z.object({ id: z.string() })
export const wireInput = z.object({ from: z.string(), to: z.string() })
export const unwireInput = z.object({ edgeId: z.string() })
export const applyTemplateInput = z.object({
  templateId: z.string(),
  prompts: z.record(z.string(), z.string()),
})

export type AddNodeInput = z.infer<typeof addNodeInput>
export type UpdateNodeInput = z.infer<typeof updateNodeInput>

/**
 * Ids are not hashed — hashableConfig is a whitelist that excludes id and
 * position — so the format only has to be unique and readable in a chat reply.
 */
const newId = (type: string) => `${type}-${randomUUID().slice(0, 8)}`

export type Ops = ReturnType<typeof createOps>

export function createOps(db: Db, ids: { projectId: string; flowId: string }) {
  const read = (): Flow => db.select().from(flows).where(eq(flows.id, ids.flowId)).get()!.graphJson as Flow

  const write = (graph: Flow) => {
    // The same door the canvas comes through: a graph the schema refuses must
    // never reach the worker, whichever surface built it.
    const parsed = flowSchema.safeParse(graph)
    if (!parsed.success) throw new Error(parsed.error.issues[0]?.message ?? 'Invalid graph')
    saveGraph(db, ids.flowId, parsed.data as Flow)
  }

  const nodeOf = (graph: Flow, id: string) => {
    const node = graph.nodes.find((n) => n.id === id)
    if (!node) throw new Error(`No node ${id}. Call list_graph to see what exists.`)
    return node
  }

  return {
    listGraph() {
      const graph = read()
      const preview = previewRun(db, ids.flowId)
      const estimates = new Map(
        [...preview.stale, ...preview.cached, ...preview.inFlight].map((p) => [
          p.nodeId,
          Math.round(p.estimatedCents),
        ]),
      )
      return {
        nodes: graph.nodes.map((node) => ({ ...node, estimatedCents: estimates.get(node.id) ?? 0 })),
        edges: graph.edges,
        estimatedCents: Math.round(preview.estimatedCents),
      }
    },

    listSources() {
      return listProjectSources(db, ids.projectId).map((source) => ({
        id: source.id,
        kind: source.kind,
        notes: source.notes,
        text: source.text,
        version: source.version,
      }))
    },

    listTemplates() {
      return loadTemplates().map((t) => ({
        id: t.id,
        name: t.name,
        description: t.description,
        slots: t.slots,
      }))
    },

    addNode(input: AddNodeInput) {
      const graph = read()
      const id = newId(input.type)
      // freeSlot, not a fixed point: two nodes added in one turn must not land
      // on each other. Same helper the canvas toolbar uses.
      const position = freeSlot(graph.nodes)

      // Defaults match canvas.tsx:420-427 exactly. seed is hashed, so a
      // different default would make identical work miss the cache.
      const node: FlowNode =
        input.type === 'source'
          ? { id, type: 'source', position, sourceId: input.sourceId ?? '' }
          : input.type === 'image'
            ? {
                id,
                type: 'image',
                position,
                prompt: input.prompt ?? '',
                modelRole: input.modelRole ?? 'draft',
                seed: 1,
              }
            : input.type === 'video'
              ? {
                  id,
                  type: 'video',
                  position,
                  prompt: input.prompt ?? '',
                  durationSec: input.durationSec ?? 5,
                  audio: input.audio ?? false,
                  modelRole: input.modelRole ?? 'draft',
                  seed: 1,
                }
              : { id, type: 'export', position, formats: input.formats ?? [] }

      write({ ...graph, nodes: [...graph.nodes, { ...node, ...(input.label ? { label: input.label } : {}) }] })
      return { id }
    },

    updateNode(input: UpdateNodeInput) {
      const graph = read()
      const current = nodeOf(graph, input.id)
      const { id: _id, ...patch } = input
      const next = Object.fromEntries(Object.entries(patch).filter(([, v]) => v !== undefined))

      write({
        ...graph,
        nodes: graph.nodes.map((node) => (node.id === input.id ? ({ ...current, ...next } as FlowNode) : node)),
      })
      return { id: input.id }
    },

    deleteNode(input: { id: string }) {
      const graph = read()
      nodeOf(graph, input.id)
      write(removeNode(graph, input.id))
      return { id: input.id }
    },

    wire(input: { from: string; to: string }) {
      const graph = read()
      // applyWire, not a copy: the reference cap, the one-start-frame rule and
      // the cycle check all live there, and the canvas calls the same function.
      const next = applyWire(graph, input.from, input.to)
      write(next)
      const edge = next.edges.at(-1)!
      return { edgeId: edge.id, role: edge.role }
    },

    unwire(input: { edgeId: string }) {
      const graph = read()
      if (!graph.edges.some((e) => e.id === input.edgeId)) {
        throw new Error(`No edge ${input.edgeId}. Call list_graph to see what exists.`)
      }
      write(removeEdge(graph, input.edgeId))
      return { edgeId: input.edgeId }
    },

    applyTemplate(input: { templateId: string; prompts: Record<string, string> }) {
      // Reuses the brief path's validation wholesale: an unknown template id or
      // an unfilled slot is refused there, loudly, exactly as before.
      const graph = buildFlowFromBrief(input, loadTemplates())
      write(graph)
      return { nodeIds: graph.nodes.map((n) => n.id) }
    },
  }
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run test/unit/agent-ops.test.ts`
Expected: PASS

If the reference-cap test does not throw, check `REGISTRY`'s draft image row: the test wires 12 sources, which must exceed `caps.refImages`. Raise the count in the test to `caps.refImages + 1` rather than weakening the assertion.

- [ ] **Step 5: Verify the eslint boundary still holds**

Run: `npm run lint`
Expected: PASS. `src/agent/ops.ts` imports `@/app/slots`, which is type-only against `/core` — if the boundary rule objects, move `freeSlot`, `slotFor`, `CARD`, `CARD_SOURCE`, `MIN_CARD`, `COLUMN` and `ROW` from `src/app/slots.ts` to `src/core/slots.ts` and re-export from the old path so `canvas.tsx` is untouched.

- [ ] **Step 6: Commit**

```bash
git add src/agent/ops.ts test/unit/agent-ops.test.ts
git commit -m "feat(agent): the eight things an agent may do to a graph"
```

---

### Task 3: OpenRouter behind the LLM_MODE seam

Swap the client and re-key the fixtures. The old `complete()` disappears with the Anthropic SDK, so the brief POST path goes in the same task — leaving it broken between tasks would be a repo that does not run.

**Files:**
- Modify: `src/models/llm.ts` (whole file)
- Modify: `src/env.ts:73-90`
- Modify: `src/core/brief.ts` — delete `briefPrompt` (currently `src/core/brief.ts:131-152`)
- Modify: `src/app/api/brief/route.ts` — delete POST and `RESPONSE_SCHEMA`
- Modify: `src/app/state.ts` — delete `submitBrief`
- Modify: `src/app/canvas.tsx` — Brief chip becomes Brand, brief textarea removed
- Modify: `package.json`, `.env`, `.env.example`
- Modify: `test/unit/llm-adapter.test.ts` (rewritten), `test/unit/brief-to-flow.test.ts` (drop `briefPrompt` cases)
- Create: `test/unit/llm-fixture-key.test.ts`, `e2e/brand.spec.ts`
- Delete: `test/fixtures/llm/04a6761f2bbbc1262db0289db991448a.json`, `e2e/brief-to-flow.spec.ts`

**Interfaces:**
- Consumes: nothing from earlier tasks.
- Produces: `createChatModel(options: { mode: LlmMode; fixtureDir?: string })` — a `LanguageModelV4` to hand to `streamText`. The OpenRouter provider reports `specificationVersion: 'v4'`, so V4 is the only shape involved; do not widen the type to a union. Also `LlmDisabledError`, `MissingLlmFixtureError`, `fixtureKey(request: { prompt: unknown; tools: unknown }): string`.
- Produces: `openrouterModel(): string` from `src/env.ts`.

- [ ] **Step 1: Add the dependencies**

```bash
npm install ai@^7.0.52 @openrouter/ai-sdk-provider@^3.0.0
npm uninstall @anthropic-ai/sdk
```

Expected: `package.json` gains `ai` and `@openrouter/ai-sdk-provider` under `dependencies`, and loses `@anthropic-ai/sdk`.

- [ ] **Step 2: Write the failing fixture-key test**

Create `test/unit/llm-fixture-key.test.ts`:

```typescript
import { describe, test, expect } from 'vitest'
import { fixtureKey } from '@/models/llm'

const tools = [{ type: 'function', name: 'add_node', inputSchema: { type: 'object' } }]

const turnOne = {
  prompt: [
    { role: 'system', content: 'You author graphs.' },
    { role: 'user', content: [{ type: 'text', text: 'add a hero shot' }] },
  ],
  tools,
}

const turnTwo = {
  prompt: [
    ...turnOne.prompt,
    { role: 'assistant', content: [{ type: 'tool-call', toolCallId: 'c1', toolName: 'add_node', input: {} }] },
    { role: 'tool', content: [{ type: 'tool-result', toolCallId: 'c1', toolName: 'add_node', output: {} }] },
  ],
  tools,
}

describe('fixtureKey', () => {
  test('two turns of one conversation are different fixtures', () => {
    // The old key hashed a single prompt string. A multi-turn conversation
    // collided on it, so replay served some other turn's answer and the test
    // still passed — the exact failure a recorded fixture exists to prevent.
    expect(fixtureKey(turnOne)).not.toBe(fixtureKey(turnTwo))
  })

  test('a changed system prompt is a different fixture', () => {
    const edited = {
      ...turnOne,
      prompt: [{ role: 'system', content: 'You author graphs. Be brief.' }, turnOne.prompt[1]],
    }
    expect(fixtureKey(edited)).not.toBe(fixtureKey(turnOne))
  })

  test('a changed tool set is a different fixture', () => {
    expect(fixtureKey({ ...turnOne, tools: [] })).not.toBe(fixtureKey(turnOne))
  })

  test('key order in the request does not change the key', () => {
    // canonicalJson sorts keys at every depth, same as the run hash. Otherwise
    // an object built in a different order looks like a different request.
    expect(fixtureKey({ tools, prompt: turnOne.prompt })).toBe(fixtureKey(turnOne))
  })
})
```

- [ ] **Step 3: Run test to verify it fails**

Run: `npx vitest run test/unit/llm-fixture-key.test.ts`
Expected: FAIL — `fixtureKey` takes a string today, so the object calls produce identical keys (or a type error).

- [ ] **Step 4: Rewrite `src/models/llm.ts`**

Replace the file:

```typescript
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { createHash } from 'node:crypto'
import path from 'node:path'
import { createOpenRouter } from '@openrouter/ai-sdk-provider'
import { MockLanguageModelV4, simulateReadableStream } from 'ai/test'
import { canonicalJson, type JsonValue } from '../core/hash'
import { openrouterModel, type LlmMode } from '../env'

/**
 * THE ONE PLACE that talks to an LLM.
 *
 * The same seam as models/fal.ts, for the same reason: a recorded fixture makes
 * the chat path testable without a key, and CI can never accidentally spend.
 *
 * What comes back is still untrusted. Tool arguments are validated by their zod
 * schemas and the resulting graph by flowSchema before anything is saved.
 */
export class LlmDisabledError extends Error {
  constructor() {
    super(
      'Chat needs a model. Set OPENROUTER_API_KEY (or LLM_MODE=replay to use recorded responses).',
    )
    this.name = 'LlmDisabledError'
  }
}

export class MissingLlmFixtureError extends Error {
  constructor(file: string) {
    super(`No LLM fixture at ${file}. Record one with LLM_MODE=live OPENFLOW_RECORD_LLM=1.`)
    this.name = 'MissingLlmFixtureError'
  }
}

/**
 * Keyed by the WHOLE request, not by one prompt string.
 *
 * A chat turn is a growing array of messages and tool results. Keying on a
 * single string made every turn of one conversation collide, so replay served
 * the wrong turn and the suite went green anyway. The tool set is folded in too:
 * adding a tool changes what the model can answer, so it must change the key.
 */
export const fixtureKey = (request: { prompt: unknown; tools: unknown }) =>
  createHash('sha256')
    .update(canonicalJson({ prompt: request.prompt, tools: request.tools } as JsonValue))
    .digest('hex')
    .slice(0, 32)

const DEFAULT_FIXTURE_DIR = path.resolve('test/fixtures/llm')

/**
 * Replay is a mock model rather than hand-rolled stream faking: ai-sdk ships
 * MockLanguageModelV4 for exactly this, and the recorded chunks are the same
 * shapes a real provider emits, so replay exercises the real code path.
 */
function replayModel(fixtureDir: string) {
  const load = (options: { prompt: unknown; tools: unknown }) => {
    const file = path.join(fixtureDir, `${fixtureKey(options)}.json`)
    if (!existsSync(file)) throw new MissingLlmFixtureError(file)
    return JSON.parse(readFileSync(file, 'utf8')) as { chunks: unknown[] }
  }

  return new MockLanguageModelV4({
    doStream: async (options) => ({
      stream: simulateReadableStream({
        chunks: load(options).chunks as never[],
        initialDelayInMs: null,
        chunkDelayInMs: null,
      }),
    }),
  })
}

/** Live, with an optional recording tap so a fixture is a run away, not a hand-write. */
function liveModel(fixtureDir: string) {
  const provider = createOpenRouter({ apiKey: process.env.OPENROUTER_API_KEY })
  const model = provider.chat(openrouterModel())
  if (process.env.OPENFLOW_RECORD_LLM !== '1') return model

  return new MockLanguageModelV4({
    doStream: async (options) => {
      const { stream } = await model.doStream(options)
      const chunks: unknown[] = []
      const tapped = stream.pipeThrough(
        new TransformStream({
          transform(chunk, controller) {
            chunks.push(chunk)
            controller.enqueue(chunk)
          },
          flush() {
            mkdirSync(fixtureDir, { recursive: true })
            writeFileSync(
              path.join(fixtureDir, `${fixtureKey(options)}.json`),
              `${JSON.stringify({ chunks }, null, 2)}\n`,
            )
          },
        }),
      )
      return { stream: tapped }
    },
  })
}

export function createChatModel(options: { mode: LlmMode; fixtureDir?: string }) {
  const fixtureDir = options.fixtureDir ?? DEFAULT_FIXTURE_DIR
  switch (options.mode) {
    case 'off':
      return new MockLanguageModelV4({
        doStream: async () => {
          throw new LlmDisabledError()
        },
      })
    case 'replay':
      return replayModel(fixtureDir)
    case 'live':
      return liveModel(fixtureDir)
  }
}
```

- [ ] **Step 5: Point `env.ts` at OpenRouter**

In `src/env.ts`, replace the `llmMode` block's doc comment and body, and add the model getter:

```typescript
/**
 * The same seam as FAL_MODE, for the chat agent.
 *
 * live   — a real OpenRouter call. Needs OPENROUTER_API_KEY.
 * replay — serve recorded turns from test/fixtures/llm. Tests, CI, DEMO=1.
 * off    — throw on any call. The default, because unlike generating, chatting
 *          is optional: a canvas that works without a second API key should not
 *          fail differently depending on whether one happens to be exported.
 */
export type LlmMode = 'live' | 'replay' | 'off'

export const llmMode = (): LlmMode => {
  if (isDemo()) return 'replay'
  // `||`, not `??`: an exported-but-empty LLM_MODE is a variable someone
  // cleared, not a mode called "".
  return (
    (process.env.LLM_MODE as LlmMode | undefined) ||
    (process.env.OPENROUTER_API_KEY ? 'live' : 'off')
  )
}

/** One line to change which model reads your briefs. No picker, no per-model UI. */
export const openrouterModel = () => process.env.OPENROUTER_MODEL || 'anthropic/claude-opus-5'
```

- [ ] **Step 6: Update `.env.example` and `.env`**

In both files, replace the `ANTHROPIC_API_KEY` line with:

```
# The chat agent. Without it LLM_MODE falls back to `off` and chat is disabled.
OPENROUTER_API_KEY=
# One line to change the model. Anything on OpenRouter that supports tool use.
OPENROUTER_MODEL=anthropic/claude-opus-5
```

- [ ] **Step 7: Delete the brief POST path**

In `src/core/brief.ts`, delete the `briefPrompt` function and its doc comment (currently the last export in the file). Keep `loadTemplates`, `briefResponseSchema`, `buildFlowFromBrief`, `BriefError`, `TEMPLATES_DIR` and the types.

In `src/app/api/brief/route.ts`, delete the `RESPONSE_SCHEMA` constant and the entire `POST` handler, and reduce the imports to:

```typescript
import { NextResponse } from 'next/server'
import { eq } from 'drizzle-orm'
import { getDb } from '@/db'
import { projects } from '@/db/schema'
import { ensureWorkspace } from '@/core/workspace'
import { loadTemplates } from '@/core/brief'
import { llmMode } from '@/env'
```

In `src/app/state.ts`, delete `submitBrief` and its doc comment.

- [ ] **Step 8: Turn the Brief dialog into a Brand dialog**

In `src/app/canvas.tsx`:

- Change the state to hold only the profile: `const [brief, setBrief] = useState<{ profile: string } | null>(null)` — and delete `const [briefing, setBriefing] = useState(false)`.
- Rename `openBrief` to `openBrand` and drop the `text` field:

```typescript
  async function openBrand() {
    const { brandProfile } = await fetchBrief()
    setBrief({ profile: brandProfile })
  }

  async function saveBrand() {
    if (!brief) return
    try {
      await saveBrandProfile(brief.profile)
      setBrief(null)
    } catch (error) {
      setNotice(error instanceof Error ? error.message : 'Could not save the brand profile')
    }
  }
```

- Delete `runBrief` entirely.
- The chip becomes:

```tsx
        <button className="chip" onClick={() => void openBrand()} data-testid="brand">
          Brand
        </button>
```

- In the dialog markup, delete the `Brief` label, its textarea (`data-testid="brief-text"`) and the submit button (`data-testid="brief-submit"`), keeping the brand-profile textarea. Its confirm button becomes:

```tsx
                <button className="run" onClick={() => void saveBrand()} data-testid="brand-save">
                  Save
                </button>
```

- Update the `aria-label` from `"Brief"` to `"Brand"`, and remove `submitBrief` from the `@/app/state` import.

- [ ] **Step 9: Update the existing tests**

Rewrite `test/unit/llm-adapter.test.ts`:

```typescript
import { describe, test, expect, vi, afterEach } from 'vitest'
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { createChatModel, fixtureKey, LlmDisabledError, MissingLlmFixtureError } from '@/models/llm'
import { llmMode, openrouterModel } from '@/env'

afterEach(() => vi.unstubAllEnvs())

const HELLO = {
  chunks: [
    { type: 'stream-start', warnings: [] },
    { type: 'text-start', id: 't' },
    { type: 'text-delta', id: 't', delta: 'two shots, then an export' },
    { type: 'text-end', id: 't' },
    { type: 'finish', finishReason: 'stop', usage: { inputTokens: 1, outputTokens: 1, totalTokens: 2 } },
  ],
}

/**
 * The model is exercised directly rather than through streamText.
 *
 * streamText turns a provider failure into AI_NoOutputGeneratedError, so a test
 * driven through it would pass whether the adapter threw LlmDisabledError, a
 * missing fixture, or nothing at all — which is the opposite of what these
 * three tests exist to prove.
 */
const request = { prompt: [{ role: 'user', content: 'what would you build' }], tools: [] }

const readText = async (stream: ReadableStream<unknown>) => {
  const reader = stream.getReader()
  let text = ''
  for (;;) {
    const { done, value } = await reader.read()
    if (done) return text
    const chunk = value as { type: string; delta?: string }
    if (chunk.type === 'text-delta') text += chunk.delta ?? ''
  }
}

describe('llmMode', () => {
  test('is off when no key is set, so chat degrades instead of erroring oddly', () => {
    vi.stubEnv('LLM_MODE', '')
    vi.stubEnv('OPENROUTER_API_KEY', '')
    vi.stubEnv('DEMO', '')
    expect(llmMode()).toBe('off')
  })

  test('goes live once a key exists', () => {
    vi.stubEnv('LLM_MODE', '')
    vi.stubEnv('OPENROUTER_API_KEY', 'sk-test')
    vi.stubEnv('DEMO', '')
    expect(llmMode()).toBe('live')
  })

  test('DEMO=1 forces replay even with a key present', () => {
    vi.stubEnv('DEMO', '1')
    vi.stubEnv('OPENROUTER_API_KEY', 'sk-test')
    expect(llmMode()).toBe('replay')
  })

  test('the model is one environment variable, with a working default', () => {
    vi.stubEnv('OPENROUTER_MODEL', '')
    expect(openrouterModel()).toBe('anthropic/claude-opus-5')
    vi.stubEnv('OPENROUTER_MODEL', 'openai/gpt-5')
    expect(openrouterModel()).toBe('openai/gpt-5')
  })
})

describe('the chat model', () => {
  test('off refuses rather than reaching for a key it does not have', async () => {
    const model = createChatModel({ mode: 'off' })
    await expect(model.doStream(request as never)).rejects.toThrow(LlmDisabledError)
  })

  test('replay serves a recorded turn and opens no socket', async () => {
    const dir = mkdtempSync(path.join(tmpdir(), 'openflow-llm-'))
    try {
      writeFileSync(path.join(dir, `${fixtureKey(request)}.json`), JSON.stringify(HELLO))

      const fetchSpy = vi.spyOn(globalThis, 'fetch')
      const model = createChatModel({ mode: 'replay', fixtureDir: dir })
      const { stream } = await model.doStream(request as never)

      expect(await readText(stream)).toContain('two shots')
      expect(fetchSpy).not.toHaveBeenCalled()
      fetchSpy.mockRestore()
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  test('an unrecorded request is a loud miss, not a stale answer', async () => {
    const dir = mkdtempSync(path.join(tmpdir(), 'openflow-llm-'))
    try {
      const model = createChatModel({ mode: 'replay', fixtureDir: dir })
      await expect(model.doStream(request as never)).rejects.toThrow(MissingLlmFixtureError)
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  test('the key is the request, so two different requests cannot share a fixture', () => {
    expect(fixtureKey({ prompt: [{ role: 'user', content: 'a' }], tools: [] })).not.toBe(
      fixtureKey({ prompt: [{ role: 'user', content: 'b' }], tools: [] }),
    )
  })
})
```

Delete the stale fixture, which was keyed the old way:

```bash
rm test/fixtures/llm/04a6761f2bbbc1262db0289db991448a.json
```

In `test/unit/brief-to-flow.test.ts`, delete any `describe`/`test` block that imports or calls `briefPrompt`. Leave the `buildFlowFromBrief` and `loadTemplates` blocks untouched.

Delete `e2e/brief-to-flow.spec.ts`. Its subject — the brief bar producing a graph — no longer exists, and it drives `data-testid="brief"`, `brief-text` and `brief-submit`, all three of which are gone. Its coverage is replaced by `e2e/chat.spec.ts` in Task 6; do not leave a rewritten stub in between.

```bash
git rm e2e/brief-to-flow.spec.ts
```

Its brand-profile assertion is worth keeping, so add this small spec in its place as `e2e/brand.spec.ts`:

```typescript
import { test, expect } from '@playwright/test'
import { resetWorkspace, waitForLedger } from './helpers'

test.beforeEach(async ({ request }) => {
  await resetWorkspace(request)
})

test('the brand profile is written by a person and survives a reload', async ({ page }) => {
  await page.goto('/')
  await waitForLedger(page)

  await page.getByTestId('brand').click()
  await page.getByTestId('brand-profile').fill('Warm, editorial, never clinical.')
  await page.getByTestId('brand-save').click()

  await page.reload()
  await waitForLedger(page)
  await page.getByTestId('brand').click()
  await expect(page.getByTestId('brand-profile')).toHaveValue('Warm, editorial, never clinical.')
})
```

- [ ] **Step 10: Run the suite**

Run: `npm run typecheck && npm run lint && npm run test:unit`
Expected: PASS

Run: `npm run test:e2e`
Expected: PASS. Grep for any remaining `brief` test ids first — `grep -rn "brief" e2e/` should return nothing but the new `brand.spec.ts` has no match at all.

- [ ] **Step 11: Commit**

```bash
git add -A
git commit -m "feat(llm): one model client, and a fixture per turn instead of per prompt"
```

---

### Task 4: The chat endpoint

The tools, the system prompt, the loop, the thread table, and the route.

**Files:**
- Create: `src/agent/tools.ts`, `src/agent/prompt.ts`, `src/agent/loop.ts`, `src/app/api/chat/route.ts`
- Modify: `src/db/schema.ts`, `src/db/index.ts`
- Test: `test/unit/agent-loop.test.ts`

**Interfaces:**
- Consumes: `createOps` and the eight zod schemas from Task 2; `createChatModel`, `LlmDisabledError` from Task 3.
- Produces: `createTools(ops: Ops): ToolSet`; `systemPrompt(input: { brandProfile: string; ops: Ops }): string`; `runTurn(input: { db, ids, model, messages }): { textStream: ReadableStream<string>; done: Promise<void> }`; drizzle table `messages`.

- [ ] **Step 1: Add the thread table**

In `src/db/schema.ts`, after `flows`:

```typescript
/**
 * The chat thread. One row per model message, in order.
 *
 * Stored as ModelMessage JSON rather than rendered text: the next turn resends
 * the whole history to the model, and a tool call that has already run must be
 * in it or the model repeats the work.
 */
export const messages = sqliteTable('messages', {
  id: text('id').primaryKey(),
  flowId: text('flow_id').notNull(),
  /** 'user' | 'assistant' | 'tool' */
  role: text('role').notNull(),
  content: text('content', { mode: 'json' }).notNull(),
  createdAt: text('created_at').notNull().$defaultFn(now),
})

export type ChatMessage = typeof messages.$inferSelect
```

In `src/db/index.ts`, add to the `sqlite.exec` DDL block, after the `flows` table:

```sql
    CREATE TABLE IF NOT EXISTS messages (
      id TEXT PRIMARY KEY,
      flow_id TEXT NOT NULL,
      role TEXT NOT NULL,
      content TEXT NOT NULL,
      created_at TEXT NOT NULL
    );

    CREATE INDEX IF NOT EXISTS messages_flow_idx ON messages(flow_id, created_at);
```

- [ ] **Step 2: Write `src/agent/tools.ts`**

```typescript
import { tool } from 'ai'
import {
  addNodeInput,
  applyTemplateInput,
  deleteNodeInput,
  listGraphInput,
  listSourcesInput,
  unwireInput,
  updateNodeInput,
  wireInput,
  type Ops,
} from './ops'

/**
 * Wrappers, and nothing else. Every description says when to reach for the
 * tool, because a description that only says what a tool does gets called less
 * than one that says when.
 *
 * There is no run tool, deliberately. See ops.ts.
 */
export const createTools = (ops: Ops) => ({
  list_graph: tool({
    description:
      'Read the current graph: every node with its settings and estimated cost, and every edge. Call this first, and again after any change you did not make yourself.',
    inputSchema: listGraphInput,
    execute: async () => ops.listGraph(),
  }),

  list_sources: tool({
    description:
      "List the project's uploaded assets. Call this before adding a source node — you need a real source id, and you cannot invent one.",
    inputSchema: listSourcesInput,
    execute: async () => ops.listSources(),
  }),

  add_node: tool({
    description:
      'Add one node and return its id. Types: source (an existing asset, needs sourceId), image (a still, needs prompt), video (a clip, needs prompt), export (the deliverable formats). Nothing renders until the person presses Run.',
    inputSchema: addNodeInput,
    execute: async (input) => ops.addNode(input),
  }),

  update_node: tool({
    description:
      'Change a node in place. Only the fields you pass change. Use this to reword a prompt or move a shot from draft to hero, rather than deleting and re-adding it.',
    inputSchema: updateNodeInput,
    execute: async (input) => ops.updateNode(input),
  }),

  delete_node: tool({
    description: 'Remove a node. Its edges go with it.',
    inputSchema: deleteNodeInput,
    execute: async (input) => ops.deleteNode(input),
  }),

  wire: tool({
    description:
      'Connect two nodes. The meaning follows from the types: an asset into a shot is a reference the model must honour, a still into a clip is that clip\'s first frame. May be refused — too many references for the chosen model, a second first frame, or a cycle. Read the refusal and adjust.',
    inputSchema: wireInput,
    execute: async (input) => ops.wire(input),
  }),

  unwire: tool({
    description: 'Remove one edge by its id, leaving both nodes in place.',
    inputSchema: unwireInput,
    execute: async (input) => ops.unwire(input),
  }),

  apply_template: tool({
    description:
      'Replace the whole graph with a ready-made shape, with its slots filled. A good opening move on an empty canvas; destructive on one with work in it, so read the graph first.',
    inputSchema: applyTemplateInput,
    execute: async (input) => ops.applyTemplate(input),
  }),
})
```

- [ ] **Step 3: Write `src/agent/prompt.ts`**

```typescript
import { REGISTRY } from '@/models/registry'
import type { Ops } from './ops'

/**
 * Rebuilt every turn, because the graph is in it.
 *
 * The registry rows are included with their prices and their limits so the
 * model chooses a model rather than guessing at one, and so a wire it is about
 * to be refused for is one it can avoid asking for.
 */
export function systemPrompt(input: { brandProfile: string; ops: Ops }) {
  const models = REGISTRY.filter((m) => m.format !== 'text')
    .map(
      (m) =>
        `- ${m.format} / ${m.role}: ${m.id} — up to ${m.caps.refImages} reference image(s)` +
        `${m.caps.startEndFrame ? ', accepts a start frame' : ''}` +
        `${m.caps.textRendering ? ', renders legible text' : ''}` +
        `${m.caps.maxDurationSec ? `, max ${m.caps.maxDurationSec}s` : ''}` +
        ` — ${(m.cost.amount / 100).toFixed(3)} per ${m.cost.unit}`,
    )
    .join('\n')

  const templates = input.ops
    .listTemplates()
    .map((t) => `- ${t.id}: ${t.description} (slots: ${t.slots.join(', ')})`)
    .join('\n')

  return [
    'You direct ad creative on a node canvas. You author the graph; you never render it.',
    'Rendering costs real money and is the person\'s decision — they press Run. Never claim you have rendered, generated or produced anything. You have written a plan they can price and run.',
    '',
    'There are four node types and no others:',
    '- source: an asset already uploaded to the project. Reference an existing id from list_sources.',
    '- image: one still, from a prompt.',
    '- video: one clip, from a prompt, optionally starting from an image node.',
    '- export: the deliverable formats and any burned-in copy.',
    '',
    'Wiring rules, enforced — a refusal is information, not an error to retry blindly:',
    '- A source into an image or video is a reference the model must honour. Each model honours a fixed number; exceeding it is refused when you draw the wire, not silently ignored at render time.',
    '- An image into a video is that clip\'s first frame. A clip may have exactly one.',
    '- Nothing feeds a source node, and no wire may create a cycle.',
    '',
    `Models available:\n${models}`,
    '',
    `Templates:\n${templates}`,
    '',
    input.brandProfile
      ? `Brand profile, written by the person — treat it as direction:\n${input.brandProfile}`
      : 'No brand profile has been written yet. Ask about the brand rather than inventing one.',
    '',
    `The graph as it stands:\n${JSON.stringify(input.ops.listGraph())}`,
    '',
    'Work in small steps. Read before you write. When you are done, say plainly what is on the canvas and what it would cost to run — briefly, in prose, not a table.',
  ].join('\n')
}
```

- [ ] **Step 4: Write `src/agent/loop.ts`**

```typescript
import { randomUUID } from 'node:crypto'
import { streamText, stepCountIs, type LanguageModel, type ModelMessage } from 'ai'
import { eq, asc } from 'drizzle-orm'
import type { Db } from '@/db'
import { messages } from '@/db/schema'
import { createOps } from './ops'
import { createTools } from './tools'
import { systemPrompt } from './prompt'

/** Twelve steps is enough to build a three-shot flow and short of a runaway loop. */
const MAX_STEPS = 12

export const loadThread = (db: Db, flowId: string): ModelMessage[] =>
  db
    .select()
    .from(messages)
    .where(eq(messages.flowId, flowId))
    .orderBy(asc(messages.createdAt))
    .all()
    .map((row) => row.content as ModelMessage)

export function appendThread(db: Db, flowId: string, batch: ModelMessage[]) {
  const at = Date.now()
  for (const [index, message] of batch.entries()) {
    db.insert(messages)
      .values({
        id: randomUUID(),
        flowId,
        role: message.role,
        content: message as never,
        // Index-suffixed so a batch written inside one millisecond still reads
        // back in the order it was generated.
        createdAt: `${new Date(at).toISOString()}-${String(index).padStart(3, '0')}`,
      })
      .run()
  }
}

/**
 * One turn: history in, text out, graph mutated by the tools along the way.
 *
 * The assistant messages are persisted per step, as each step finishes, rather
 * than once at the end. A stream that dies mid-turn has already run its tool
 * calls — the node is on the canvas — and a history without them makes the
 * retry add it a second time.
 */
export function runTurn(input: {
  db: Db
  ids: { projectId: string; flowId: string }
  model: LanguageModel
  brandProfile: string
  message: string
}) {
  const ops = createOps(input.db, input.ids)

  const user: ModelMessage = { role: 'user', content: input.message }
  const history = loadThread(input.db, input.ids.flowId)
  appendThread(input.db, input.ids.flowId, [user])

  const result = streamText({
    model: input.model,
    system: systemPrompt({ brandProfile: input.brandProfile, ops }),
    messages: [...history, user],
    tools: createTools(ops),
    stopWhen: stepCountIs(MAX_STEPS),
    onStepFinish: (step) => appendThread(input.db, input.ids.flowId, step.response.messages),
  })

  return result
}
```

- [ ] **Step 5: Write `src/app/api/chat/route.ts`**

```typescript
import { eq } from 'drizzle-orm'
import { NextResponse } from 'next/server'
import { getDb } from '@/db'
import { projects, messages } from '@/db/schema'
import { ensureWorkspace } from '@/core/workspace'
import { runTurn, loadThread } from '@/agent/loop'
import { createChatModel, LlmDisabledError } from '@/models/llm'
import { llmMode, isDemo } from '@/env'

export const dynamic = 'force-dynamic'

/** The thread, so a reload does not lose the conversation. */
export async function GET() {
  const db = getDb()
  const { flowId } = ensureWorkspace(db)
  return NextResponse.json({
    enabled: llmMode() !== 'off' && !isDemo(),
    messages: loadThread(db, flowId),
  })
}

/**
 * A turn. Writes graph_json through the tools; dispatches nothing.
 *
 * The 403 under DEMO is not decoration: without it a public demo is an open
 * OpenRouter proxy billed to whoever deployed it.
 */
export async function POST(request: Request) {
  if (isDemo()) {
    return NextResponse.json({ error: 'This is a read-only demo.' }, { status: 403 })
  }

  const db = getDb()
  const { projectId, flowId } = ensureWorkspace(db)
  const body = (await request.json().catch(() => ({}))) as { message?: string }
  const message = (body.message ?? '').trim()

  if (!message) {
    return NextResponse.json({ error: 'Say what you want built.' }, { status: 400 })
  }

  // Checked here, not caught below. streamText never throws synchronously: a
  // provider that refuses produces a 200 with an empty body, so a missing key
  // would render as a blank reply instead of the sentence naming the variable.
  if (llmMode() === 'off') {
    return NextResponse.json({ error: new LlmDisabledError().message }, { status: 422 })
  }

  const project = db.select().from(projects).where(eq(projects.id, projectId)).get()

  const result = runTurn({
    db,
    ids: { projectId, flowId },
    model: createChatModel({ mode: llmMode() }),
    brandProfile: project?.brandProfile ?? '',
    message,
  })

  // Hand-pumped rather than `toTextStreamResponse()`, for one reason: that
  // helper swallows a mid-turn failure and closes the body, so a model that
  // dies four tool calls in looks to the reader like a model with nothing to
  // say. The tool calls already ran and the nodes are already on the canvas —
  // saying so is the difference between a bug report and a retry.
  const stream = new ReadableStream<Uint8Array>({
    async start(controller) {
      const encoder = new TextEncoder()
      try {
        for await (const chunk of result.textStream) {
          controller.enqueue(encoder.encode(chunk))
        }
      } catch (error) {
        controller.enqueue(
          encoder.encode(
            `\n\n[The model stopped: ${error instanceof Error ? error.message : String(error)}. Anything already on the canvas is saved.]`,
          ),
        )
      } finally {
        controller.close()
      }
    },
  })

  return new Response(stream, { headers: { 'content-type': 'text/plain; charset=utf-8' } })
}

/** Starting over. The graph is untouched — only the conversation is cleared. */
export async function DELETE() {
  const db = getDb()
  const { flowId } = ensureWorkspace(db)
  db.delete(messages).where(eq(messages.flowId, flowId)).run()
  return NextResponse.json({ ok: true })
}
```

`loadThread` does its own ordering, so this route imports no drizzle ordering helpers.

- [ ] **Step 6: Write the loop test**

Create `test/unit/agent-loop.test.ts`:

```typescript
import { describe, test, expect } from 'vitest'
import { MockLanguageModelV4, simulateReadableStream } from 'ai/test'
import { tempDb, seedProject, seedFlow } from '../helpers/db'
import { runTurn, loadThread } from '@/agent/loop'
import { createOps } from '@/agent/ops'
import type { Flow } from '@/core/types'

const EMPTY: Flow = { nodes: [], edges: [] }

/** A model that calls add_node once, then answers. */
function scripted(turns: unknown[][]) {
  let call = 0
  return new MockLanguageModelV4({
    doStream: async () => ({
      stream: simulateReadableStream({
        chunks: turns[call++] as never[],
        initialDelayInMs: null,
        chunkDelayInMs: null,
      }),
    }),
  })
}

const TURNS = [
  [
    { type: 'stream-start', warnings: [] },
    {
      type: 'tool-call',
      toolCallId: 'c1',
      toolName: 'add_node',
      input: JSON.stringify({ type: 'image', prompt: 'a serum on marble' }),
    },
    { type: 'finish', finishReason: 'tool-calls', usage: { inputTokens: 1, outputTokens: 1, totalTokens: 2 } },
  ],
  [
    { type: 'stream-start', warnings: [] },
    { type: 'text-start', id: 't' },
    { type: 'text-delta', id: 't', delta: 'One shot on the canvas. Press Run when you want it.' },
    { type: 'text-end', id: 't' },
    { type: 'finish', finishReason: 'stop', usage: { inputTokens: 1, outputTokens: 1, totalTokens: 2 } },
  ],
]

describe('runTurn', () => {
  test('a tool call lands on the canvas, and nothing is dispatched', async () => {
    const { db } = tempDb()
    const projectId = seedProject(db)
    const flowId = seedFlow(db, projectId, EMPTY)

    const result = runTurn({
      db,
      ids: { projectId, flowId },
      model: scripted(TURNS),
      brandProfile: 'Quiet, clinical, cold light.',
      message: 'add a hero shot of the serum on marble',
    })
    expect(await result.text).toContain('Press Run')

    const graph = createOps(db, { projectId, flowId }).listGraph()
    expect(graph.nodes).toHaveLength(1)
    expect(graph.nodes[0]).toMatchObject({ type: 'image', prompt: 'a serum on marble' })
  })

  test('the tool call is in the thread, so a retry does not add the node twice', async () => {
    const { db } = tempDb()
    const projectId = seedProject(db)
    const flowId = seedFlow(db, projectId, EMPTY)

    await runTurn({
      db,
      ids: { projectId, flowId },
      model: scripted(TURNS),
      brandProfile: '',
      message: 'add a hero shot',
    }).text

    const thread = loadThread(db, flowId)
    expect(thread.map((m) => m.role)).toEqual(['user', 'assistant', 'tool', 'assistant'])
  })
})
```

- [ ] **Step 7: Run the tests**

Run: `npx vitest run test/unit/agent-loop.test.ts`
Expected: PASS (2 tests)

If the first turn's `tool-call` chunk is rejected, check whether `input` must be a JSON string or an object for this provider version — the smoke test in the spec used a string. Fix the chunk, not the assertion.

- [ ] **Step 8: Run the whole suite and commit**

Run: `npm run typecheck && npm run lint && npm run test:unit`
Expected: PASS

```bash
git add src/agent src/app/api/chat src/db test/unit/agent-loop.test.ts
git commit -m "feat(agent): a conversation that builds the canvas while you watch"
```

---

### Task 5: The chat panel

**Files:**
- Create: `src/app/chat-panel.tsx`
- Modify: `src/app/state.ts` (add `sendChat`, `fetchChat`, `clearChat`)
- Modify: `src/app/canvas.tsx` (mount the panel)
- Modify: `src/app/globals.css` or wherever the canvas layout lives — check `src/app/layout.tsx` for the stylesheet import and add the panel rules there.

**Interfaces:**
- Consumes: `/api/chat` GET, POST, DELETE from Task 4.
- Produces: `<ChatPanel />` — self-contained, no props.

- [ ] **Step 1: Add the client calls to `src/app/state.ts`**

```typescript
export type ChatState = { enabled: boolean; messages: { role: string; content: unknown }[] }

export const fetchChat = async (): Promise<ChatState> =>
  (await fetch('/api/chat', { cache: 'no-store' })).json()

export const clearChat = () => fetch('/api/chat', { method: 'DELETE' })

/**
 * Streams the reply. `onText` is called with each chunk as it arrives.
 *
 * The canvas is not told to refresh: it already polls graph_json every 1200ms,
 * so nodes the agent adds appear on their own.
 */
export async function sendChat(message: string, onText: (chunk: string) => void) {
  const response = await fetch('/api/chat', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ message }),
  })

  if (!response.ok || !response.body) {
    const body = (await response.json().catch(() => ({}))) as { error?: string }
    throw new Error(body.error ?? 'Chat failed')
  }

  const reader = response.body.pipeThrough(new TextDecoderStream()).getReader()
  for (;;) {
    const { done, value } = await reader.read()
    if (done) return
    if (value) onText(value)
  }
}
```

- [ ] **Step 2: Write `src/app/chat-panel.tsx`**

```tsx
'use client'

import { useEffect, useRef, useState } from 'react'
import { fetchChat, sendChat, clearChat } from './state'

type Line = { role: 'user' | 'assistant'; text: string }

/** Model messages carry tool calls too; the panel only renders what a person wrote or read. */
function toLines(messages: { role: string; content: unknown }[]): Line[] {
  return messages.flatMap((message) => {
    if (message.role !== 'user' && message.role !== 'assistant') return []
    const text =
      typeof message.content === 'string'
        ? message.content
        : (message.content as { type: string; text?: string }[])
            .filter((part) => part.type === 'text')
            .map((part) => part.text ?? '')
            .join('')
    return text.trim() ? [{ role: message.role, text }] : []
  })
}

export function ChatPanel() {
  const [lines, setLines] = useState<Line[]>([])
  const [enabled, setEnabled] = useState(true)
  const [draft, setDraft] = useState('')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const endRef = useRef<HTMLDivElement>(null)

  useEffect(() => {
    void fetchChat().then((state) => {
      setEnabled(state.enabled)
      setLines(toLines(state.messages))
    })
  }, [])

  useEffect(() => {
    endRef.current?.scrollIntoView({ block: 'end' })
  }, [lines])

  async function send() {
    const message = draft.trim()
    if (!message || busy) return

    setDraft('')
    setError(null)
    setBusy(true)
    setLines((current) => [...current, { role: 'user', text: message }, { role: 'assistant', text: '' }])

    try {
      await sendChat(message, (chunk) =>
        setLines((current) => {
          const next = [...current]
          const last = next.at(-1)!
          next[next.length - 1] = { ...last, text: last.text + chunk }
          return next
        }),
      )
    } catch (failure) {
      setError(failure instanceof Error ? failure.message : 'Chat failed')
      setLines((current) => current.slice(0, -1))
    } finally {
      setBusy(false)
    }
  }

  return (
    <aside className="chat" data-testid="chat">
      <header className="chat__head">
        <span className="slate">Direction</span>
        <button
          className="chip"
          data-testid="chat-clear"
          onClick={() => void clearChat().then(() => setLines([]))}
        >
          Start over
        </button>
      </header>

      <div className="chat__log" data-testid="chat-log">
        {lines.length === 0 && (
          <p className="chat__empty">
            Say what the ad is for. Nodes appear on the canvas as they are written — nothing renders
            until you press Run.
          </p>
        )}
        {lines.map((line, index) => (
          <p key={index} className={`chat__line chat__line--${line.role}`}>
            {line.text || (busy && index === lines.length - 1 ? 'Thinking…' : '')}
          </p>
        ))}
        <div ref={endRef} />
      </div>

      {error && <p className="chat__error">{error}</p>}
      {!enabled && (
        <p className="chat__error">
          Set OPENROUTER_API_KEY in .env to use chat, or LLM_MODE=replay for recorded answers.
        </p>
      )}

      <form
        className="chat__compose"
        onSubmit={(event) => {
          event.preventDefault()
          void send()
        }}
      >
        <textarea
          value={draft}
          rows={3}
          disabled={!enabled || busy}
          data-testid="chat-input"
          placeholder="add a hero shot of the serum on marble"
          onChange={(event) => setDraft(event.target.value)}
          onKeyDown={(event) => {
            // Enter sends, shift+Enter is a newline — the shape of every chat
            // box, and getting it wrong is the first thing anyone notices.
            if (event.key === 'Enter' && !event.shiftKey) {
              event.preventDefault()
              void send()
            }
          }}
        />
        <button className="run" type="submit" disabled={!enabled || busy} data-testid="chat-send">
          {busy ? 'Writing…' : 'Send'}
        </button>
      </form>
    </aside>
  )
}
```

- [ ] **Step 3: Mount it**

In `src/app/canvas.tsx`, import the panel and wrap the canvas so the two sit side by side. Find the `<main className="canvas" …>` element and put it and the panel in a flex row — the smallest change is to render `<ChatPanel />` immediately after the closing `</main>` and make their shared parent `display: flex`.

```tsx
import { ChatPanel } from './chat-panel'
```

- [ ] **Step 4: Style it**

Add to the stylesheet the app already imports (check `src/app/layout.tsx` for the import). Match the existing custom-property names rather than introducing new colours:

```css
.chat {
  display: flex;
  flex-direction: column;
  width: 22rem;
  min-width: 16rem;
  max-width: 40vw;
  resize: horizontal;
  overflow: auto;
  border-left: 1px solid var(--line);
  background: var(--panel);
}
.chat__head { display: flex; justify-content: space-between; align-items: center; padding: 0.5rem 0.75rem; }
.chat__log { flex: 1; overflow-y: auto; padding: 0.75rem; display: flex; flex-direction: column; gap: 0.6rem; }
.chat__empty { opacity: 0.6; font-size: 0.85rem; }
.chat__line { white-space: pre-wrap; font-size: 0.9rem; line-height: 1.45; }
.chat__line--user { opacity: 0.7; }
.chat__error { padding: 0 0.75rem; color: var(--danger); font-size: 0.85rem; }
.chat__compose { display: flex; flex-direction: column; gap: 0.5rem; padding: 0.75rem; border-top: 1px solid var(--line); }
.chat__compose textarea { resize: vertical; width: 100%; }
```

`--line`, `--panel`, `--danger`, `--slate` and `--ink` are all defined in `src/app/globals.css` already — do not add new colour variables.

- [ ] **Step 5: Check it by hand**

Run: `LLM_MODE=off npm run dev`, open the canvas.
Expected: the panel is on the right, the composer is disabled, and the message names `OPENROUTER_API_KEY`. The canvas still works.

- [ ] **Step 6: Run the suite and commit**

Run: `npm run typecheck && npm run lint && npm run test:unit && npm run test:e2e`
Expected: PASS

```bash
git add src/app/chat-panel.tsx src/app/state.ts src/app/canvas.tsx src/app/globals.css
git commit -m "feat(canvas): a panel you can talk to, beside the canvas it writes"
```

---

### Task 6: Hash parity and the browser check

The gate `docs/phases/phase-4-mcp.md` sets: same core, two front doors. If a chat-built flow hashes differently from the identical canvas-built flow, logic has leaked into `src/agent/`.

**Files:**
- Create: `test/acceptance/chat-authoring.test.ts`
- Create: `e2e/chat.spec.ts`
- Modify: `README.md`

**Interfaces:**
- Consumes: everything from Tasks 1–5.
- Produces: nothing.

- [ ] **Step 1: Write the parity test**

Create `test/acceptance/chat-authoring.test.ts`:

```typescript
import { describe, test, expect } from 'vitest'
import { MockLanguageModelV4, simulateReadableStream } from 'ai/test'
import { tempDb, seedProject, seedFlow, seedSource } from '../helpers/db'
import { runTurn } from '@/agent/loop'
import { createOps } from '@/agent/ops'
import { saveGraph } from '@/core/workspace'
import { planRun } from '@/core/executor'
import { applyWire } from '@/core/wiring'
import type { Flow } from '@/core/types'

const EMPTY: Flow = { nodes: [], edges: [] }

const call = (id: string, name: string, input: unknown) => ({
  type: 'tool-call',
  toolCallId: id,
  toolName: name,
  input: JSON.stringify(input),
})

const finish = (reason: string) => ({
  type: 'finish',
  finishReason: reason,
  usage: { inputTokens: 1, outputTokens: 1, totalTokens: 2 },
})

describe('chat and canvas agree', () => {
  test('a chat-built flow hashes identically to the same flow built on the canvas', async () => {
    // The whole point of the agent layer: it is a second front door onto the
    // same core. If these hashes differ, the agent has grown logic of its own —
    // and two surfaces that disagree about a hash also disagree about the bill.
    const { db } = tempDb()
    const projectId = seedProject(db)
    const sourceId = seedSource(db, projectId, 'source-a')

    // --- built by chat ---
    const chatFlow = seedFlow(db, projectId, EMPTY, 'flow-chat')
    const model = new MockLanguageModelV4({
      doStream: (() => {
        const turns = [
          [
            { type: 'stream-start', warnings: [] },
            call('c1', 'add_node', { type: 'source', sourceId }),
            finish('tool-calls'),
          ],
          [
            { type: 'stream-start', warnings: [] },
            call('c2', 'add_node', { type: 'image', prompt: 'a serum on cold marble' }),
            finish('tool-calls'),
          ],
          [
            { type: 'stream-start', warnings: [] },
            { type: 'text-start', id: 't' },
            { type: 'text-delta', id: 't', delta: 'Done.' },
            { type: 'text-end', id: 't' },
            finish('stop'),
          ],
        ]
        let index = 0
        return async () => ({
          stream: simulateReadableStream({
            chunks: turns[index++] as never[],
            initialDelayInMs: null,
            chunkDelayInMs: null,
          }),
        })
      })(),
    })

    await runTurn({
      db,
      ids: { projectId, flowId: chatFlow },
      model,
      brandProfile: '',
      message: 'bring in the product and put it on cold marble',
    }).text

    // --- built by hand, exactly as the canvas builds it ---
    const canvasFlow = seedFlow(db, projectId, EMPTY, 'flow-canvas')
    const built: Flow = {
      nodes: [
        { id: 'asset-1', type: 'source', sourceId, position: { x: 0, y: 0 } },
        {
          id: 'image-1',
          type: 'image',
          position: { x: 250, y: 0 },
          prompt: 'a serum on cold marble',
          modelRole: 'draft',
          seed: 1,
        },
      ],
      edges: [],
    }
    saveGraph(db, canvasFlow, built)

    const hashes = (flowId: string) =>
      planRun(db, flowId)
        .map((planned) => planned.inputHash)
        .sort()

    expect(hashes(chatFlow)).toEqual(hashes(canvasFlow))
  })

  test('a clip wired to its first frame hashes the same through either door', async () => {
    // The wire is the interesting half. inputHash folds in upstreamHashes, so a
    // video node's hash depends on the edge existing AND on the role inferred
    // for it. If inferRole or applyWire were re-implemented in the agent layer,
    // this is where it shows — the first test has no edges and cannot see it.
    const { db } = tempDb()
    const projectId = seedProject(db)
    const chatFlow = seedFlow(db, projectId, EMPTY, 'flow-chat')

    // The third turn wires whatever the first two produced. A real model would
    // read the ids off add_node's return; the script reads them off the graph,
    // which is the same information arriving the same way.
    let index = 0
    const model = new MockLanguageModelV4({
      doStream: async () => {
        const nodes = createOps(db, { projectId, flowId: chatFlow }).listGraph().nodes
        const turns = [
          [
            { type: 'stream-start', warnings: [] },
            call('c1', 'add_node', { type: 'image', prompt: 'still' }),
            finish('tool-calls'),
          ],
          [
            { type: 'stream-start', warnings: [] },
            call('c2', 'add_node', { type: 'video', prompt: 'push in' }),
            finish('tool-calls'),
          ],
          [
            { type: 'stream-start', warnings: [] },
            call('c3', 'wire', {
              from: nodes.find((n) => n.type === 'image')!.id,
              to: nodes.find((n) => n.type === 'video')!.id,
            }),
            finish('tool-calls'),
          ],
          [
            { type: 'stream-start', warnings: [] },
            { type: 'text-start', id: 't' },
            { type: 'text-delta', id: 't', delta: 'Wired. Press Run when you want it.' },
            { type: 'text-end', id: 't' },
            finish('stop'),
          ],
        ]
        return {
          stream: simulateReadableStream({
            chunks: turns[index++] as never[],
            initialDelayInMs: null,
            chunkDelayInMs: null,
          }),
        }
      },
    })

    await runTurn({
      db,
      ids: { projectId, flowId: chatFlow },
      model,
      brandProfile: '',
      message: 'a still and a clip that starts from it',
    }).text

    const canvasFlow = seedFlow(db, projectId, EMPTY, 'flow-canvas')
    const base: Flow = {
      nodes: [
        { id: 'image-1', type: 'image', prompt: 'still', modelRole: 'draft', seed: 1 },
        {
          id: 'video-1',
          type: 'video',
          prompt: 'push in',
          durationSec: 5,
          audio: false,
          modelRole: 'draft',
          seed: 1,
        },
      ],
      edges: [],
    }
    saveGraph(db, canvasFlow, applyWire(base, 'image-1', 'video-1'))

    const hashes = (flowId: string) =>
      planRun(db, flowId)
        .map((planned) => planned.inputHash)
        .sort()

    // Node ids and positions are excluded from hashableConfig, so two graphs
    // built with different ids hash identically when the work is identical.
    expect(hashes(chatFlow)).toEqual(hashes(canvasFlow))
    expect(hashes(chatFlow)).toHaveLength(2)
  })
})
```

- [ ] **Step 2: Run it**

Run: `npx vitest run test/acceptance/chat-authoring.test.ts`
Expected: PASS (2 tests)

`planRun(db, flowId, options?)` is exported from `src/core/executor.ts:84` and returns `PlannedNode[]`, each carrying `inputHash` — verified, not assumed. If either assertion fails, the agent layer has grown logic the canvas does not have. Find it. Never weaken `toEqual` to a length check: a length check is what made the first draft of this test pass while proving nothing.

- [ ] **Step 3: Record an e2e fixture**

The browser test needs a real recorded turn. With a key in `.env`:

```bash
LLM_MODE=live OPENFLOW_RECORD_LLM=1 npm run dev
```

Open the canvas, send exactly `add a hero shot of the serum on marble`, wait for the reply, stop the server. New files appear under `test/fixtures/llm/`. Commit them.

If no key is available, hand-write the fixture instead: run the e2e spec once under `LLM_MODE=replay`, read the `MissingLlmFixtureError` message for the exact path, and write a `{"chunks": [...]}` file there using the chunk shapes from `test/unit/agent-loop.test.ts`. Repeat for each turn the conversation needs.

- [ ] **Step 4: Write the browser test**

Create `e2e/chat.spec.ts`, matching the conventions of the specs already in `e2e/`:

```typescript
import { test, expect } from '@playwright/test'

test('the agent puts a node on the canvas, and renders nothing', async ({ page }) => {
  await page.goto('/')

  // The brief bar is gone; chat is the one way to talk to a model.
  await expect(page.getByTestId('brief')).toHaveCount(0)
  await expect(page.getByTestId('chat')).toBeVisible()

  await page.getByTestId('chat-input').fill('add a hero shot of the serum on marble')
  await page.getByTestId('chat-send').click()

  // The canvas polls graph_json, so the card arrives without a reload.
  await expect(page.locator('.react-flow__node')).toHaveCount(1, { timeout: 15_000 })
  await expect(page.getByTestId('chat-log')).toContainText(/run/i)
})
```

- [ ] **Step 5: Run the browser test**

Run: `npm run test:e2e -- chat.spec.ts`
Expected: PASS

- [ ] **Step 6: Update the README**

In `README.md`, the Non-Goals list currently reads:

> - **No agent loop.** LLMs sit at the edges — brand profile, brief→flow — never in the execution path.

Replace with:

> - **No agent in the execution path.** The chat agent authors the graph — it adds nodes, wires them, rewords prompts. It has no way to render anything: there is no run tool, and Run is a button a person presses after reading the price.

Add to the Install section, after the fal key paragraph:

> Chat needs an OpenRouter key. Put `OPENROUTER_API_KEY` in `.env` and, if you want a different model, `OPENROUTER_MODEL` (default `anthropic/claude-opus-5`). Without a key the panel says so and the canvas works as before.

- [ ] **Step 7: Full suite and commit**

Run: `npm test`
Expected: PASS — typecheck, lint, unit, browser.

```bash
git add -A
git commit -m "test(agent): the same graph, whichever door built it"
```

---

## Self-Review

**Spec coverage**

| Spec requirement | Task |
|---|---|
| Optimistic concurrency on `graph_json` | 1 |
| Eight tools, thin wrappers over `/core` | 2 |
| `wire` calls `applyWire`, proven by a capability test | 2 |
| `add_node` returns its id; `seed: 1` matches the canvas | 2 |
| `list_graph` scoped to graph + sources + estimates | 2 |
| OpenRouter via ai-sdk; `@anthropic-ai/sdk` deleted | 3 |
| Request-wide fixture key | 3 |
| `off`/`replay`/`live` preserved; `OPENFLOW_RECORD_LLM=1` | 3 |
| `briefPrompt`, `/api/brief` POST, `submitBrief`, brief bar, `e2e/brief-to-flow.spec.ts` deleted | 3 |
| Brand profile still human-written, with a browser check | 3 (`e2e/brand.spec.ts`) |
| A missing key reaches the reader as a sentence, not a blank reply | 4 (`llmMode() === 'off'` guard before `runTurn`) |
| A mid-turn failure reaches the reader too | 4 (hand-pumped stream, not `toTextStreamResponse`) |
| `messages` table; system prompt from registry + graph | 4 |
| `stopWhen: stepCountIs(12)` | 4 |
| `isDemo()` 403 on `/api/chat` | 4 |
| Tool failures return as results, not exceptions | 4 (ai-sdk default: a thrown `execute` becomes a tool result the model reads) |
| Partial turn persisted with its tool calls | 4 (`onStepFinish`) |
| Docked panel replacing the brief bar | 5 |
| `.env` key + model, no picker | 3 |
| Unit: tool arg validation, capability refusal, fifth node type, edges deleted with node | 2 |
| Unit: fixture key covers history and system prompt | 3 |
| Unit: stale PATCH rejected | 1 |
| Acceptance: hash parity | 6 |
| E2E: message builds a node, brief bar gone | 6 |

No gaps.

**Placeholders** — none. Every code step carries the code; every test step carries the test; the two places where reality may differ from this plan (the eslint boundary on `slots.ts`, the `tool-call` chunk's `input` encoding) name the specific check and the specific fix rather than deferring.

**Type consistency** — `saveGraph` returns `string` from Task 1 and `ops.ts` in Task 2 ignores that return, which is correct: only the guarded path needs the token. `createOps` returns `Ops`, consumed by `createTools(ops)` and `systemPrompt({ ops })`. `listTemplates()` is used by both the ops test and `prompt.ts`, and is defined on `Ops` in Task 2. `createChatModel` returns a model handed to `streamText` in Task 4. `ChatState.messages` in Task 5 matches `loadThread`'s `ModelMessage[]` shape.

## Verified API facts

Checked against `ai@7.0.52` and `@openrouter/ai-sdk-provider@3.0.0` before this plan was written, not recalled:

- The OpenRouter provider reports `specificationVersion: 'v4'` — so `MockLanguageModelV4` is the matching double, not `MockLanguageModelV3`.
- `ai` exports `streamText`, `stepCountIs`, `tool`. `ai/test` exports `MockLanguageModelV4` and `simulateReadableStream`.
- `doStream(options)` receives `{ prompt, tools, ... }`; `prompt` is the full model-message array **including the system message**. That is what makes the request-wide fixture key possible.
- Stream chunk shapes: `{type:'stream-start',warnings:[]}`, `{type:'text-start',id}`, `{type:'text-delta',id,delta}`, `{type:'text-end',id}`, `{type:'tool-call',toolCallId,toolName,input}`, `{type:'finish',finishReason,usage}`.
- `steps[i].response.messages` is `ModelMessage[]` and re-feeds directly into `streamText({ messages })`.
- `result.toTextStreamResponse()` returns `200 text/plain; charset=utf-8` with the text stream as the body.
- **`streamText` never throws synchronously.** A `doStream` that throws produces a rejected `result.text` — but the rejection is `AI_NoOutputGeneratedError` ("No output generated. Check the stream for errors."), *not* the original error, and `toTextStreamResponse()` returns **200 with an empty body**. A `try { runTurn() } catch (LlmDisabledError)` in the route would never fire, and the panel would render a blank reply. Task 4 Step 5 guards `off` before the call and wraps the stream so a mid-turn failure reaches the user as text.
