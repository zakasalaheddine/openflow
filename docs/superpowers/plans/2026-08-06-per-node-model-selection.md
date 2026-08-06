# Per-node model selection — Implementation Plan (phase 1)

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** A node names its own fal model, chosen in the editor from a catalog file you can edit without touching code.

**Architecture:** `models.json` in the data dir replaces the compiled `REGISTRY`. `FlowNode.modelRole` becomes `modelId`. The toolbar's Draft/Hero/Specialist override — which overruled every node at render time — is deleted, so three nodes off one source can run three different models.

**Tech Stack:** TypeScript, Next 15 App Router, drizzle + better-sqlite3, zod, vitest, playwright.

**Spec:** `docs/superpowers/specs/2026-08-06-per-node-model-selection-design.md`

## Global Constraints

- Every path resolves through `src/env.ts`. Nothing else reads `process.env.OPENFLOW_DATA_DIR` or hardcodes `./data`.
- `hashableConfig` is a whitelist. Adding a field to it says "this changes the pixels".
- Refuse rather than silently drop: an ignored anchor is a full-price render that reads as a model quality problem.
- The role → id table, used identically in every task that needs it:

  | role | image | video |
  |---|---|---|
  | draft | `flux-2-pro` | `hailuo-2-3-pro` |
  | hero | `nano-banana-pro` | `veo-3-1` |
  | specialist | `recraft-v3` | `kling-3-pro` |

- Tree is green at every commit: `npm run typecheck && npm run lint && npm run test:unit`.

---

### Task 1: The catalog, added alongside the registry

Additive. `REGISTRY` becomes the seed written to disk on first read; `resolveModel` still works, so nothing else changes yet.

**Files:**
- Modify: `src/env.ts` — add `modelsPath()`
- Modify: `src/models/registry.ts` — `SEED`, `catalog()`, `modelById()`, `defaultModelFor()`, `UnknownModelError`
- Test: `test/unit/catalog.test.ts` (create)

**Interfaces:**
- Produces: `modelsPath(): string`, `catalog(): ModelSpec[]`, `modelById(id: string): ModelSpec` (throws `UnknownModelError extends UnsupportedCapabilityError`), `defaultModelFor(format: ModelFormat): ModelSpec`, `modelSpecSchema` (zod).
- `ModelSpec` loses `role`, gains optional `default?: boolean`.

- [ ] **Step 1: Write the failing tests**

```ts
// test/unit/catalog.test.ts
test('seeds the file on first read, and the seed is what shipped', () => {
  const dir = tmp()
  vi.stubEnv('OPENFLOW_DATA_DIR', dir)
  expect(catalog().map((m) => m.id)).toContain('flux-2-pro')
  expect(existsSync(path.join(dir, 'models.json'))).toBe(true)
})

test('an edit is live without a restart', () => { /* write file, bump mtime, expect new id */ })
test('a malformed row is refused by field name', () => { /* expect toThrow(/caps.refImages/) */ })
test('modelById throws by name, and the throw is a capability error the run route already maps', () => {
  expect(() => modelById('nope')).toThrow(UnsupportedCapabilityError)
})
test('defaultModelFor honours `default: true`, else first of format', () => {})
```

- [ ] **Step 2: Run, verify fail** — `npx vitest run test/unit/catalog.test.ts`
- [ ] **Step 3: Implement.** `catalog()` reads `modelsPath()`, caches on `statSync().mtimeMs`, validates with `modelSpecSchema.array()`, and writes `SEED` when the file is absent. A parse or validation failure throws with the zod issue path — never falls back to the seed.
- [ ] **Step 4: Run, verify pass** — `npx vitest run test/unit/catalog.test.ts`
- [ ] **Step 5: Commit** — `feat(models): the model list becomes a file you can edit`

---

### Task 2: The node names its model

The swap. One commit, because `modelRole` is a type: everything that mentions it stops compiling at once. Includes the mechanical rewrite of every test fixture and shipped flow.

**Files:**
- Modify: `src/core/types.ts` (`ImageNode`, `VideoNode`), `src/core/schema.ts`, `src/core/node-defaults.ts`, `src/core/hashable.ts`, `src/core/executor.ts`, `src/core/wiring.ts`, `src/core/preview.ts`, `src/core/run-flow.ts`, `src/core/settings.ts` (drop `defaultMode`)
- Modify: `src/app/api/flow/route.ts`, `src/app/api/run/route.ts`, `src/app/state.ts`, `src/app/canvas.tsx`, `src/app/inspector.tsx`, `bin/run.ts` (drop `--hero`)
- Modify: `src/agent/ops.ts`, `src/agent/prompt.ts`
- Modify: `flows/demo.json`, `flows/templates/*.json` (4)
- Modify: every test and e2e file spelling `modelRole:` (mechanical, per the role → id table)
- Delete: `resolveModel`, `ModelRole`, `options.role` throughout

- [ ] **Step 1: Write the failing tests**

```ts
// test/unit/hashable-config.test.ts — replace the modelRole cases
test('the model is not in the config, because inputHash folds it in as its own field', () => {
  expect(hashableConfig({ ...imageNode, modelId: 'nano-banana-pro' })).toEqual({ prompt: imageNode.prompt })
})

// test/unit/executor.test.ts
test('two nodes off one source, two models, two hashes and two prices', () => {
  // a and b identical but for modelId → different inputHash, different estimatedCents
})

// test/unit/node-defaults.test.ts
test('a fresh node gets the catalog default for its format', () => {
  expect(newNode('image', { id: 'x' })).toMatchObject({ modelId: 'flux-2-pro' })
})
```

- [ ] **Step 2: Run, verify fail** — `npx vitest run`
- [ ] **Step 3: Implement.**
  - `ImageNode`/`VideoNode`: `modelRole: ModelRole` → `modelId: string`; delete the `ModelRole` type.
  - `schema.ts`: `modelRole` enum → `modelId: z.string().min(1)`.
  - `node-defaults.ts`: `modelId: overrides.modelId ?? defaultModelFor(type === 'image' ? 'image' : 'video').id`.
  - `hashable.ts`: drop `modelRole`, add nothing.
  - `executor.ts:127`: `const model = modelById(node.modelId)`; `isRunnable` predicate → `Extract<FlowNode, { modelId: string }>`.
  - `wiring.ts`: `resolve` injection point takes an id, not `(format, role)`; both `assert*` calls read `(to as { modelId: string }).modelId`.
  - Delete `options.role` from `executor`, `preview`, `run-flow`, both routes, `state.ts`, `canvas.tsx` (the `role` state and the toggle markup), `bin/run.ts` (`--hero`), and `ProjectSettings.defaultMode`.
  - `agent/ops.ts`: the `modelRole` zod enum → `modelId: z.string()`, validated with `modelById`. `agent/prompt.ts`: list `catalog()` rows without the role word.
  - Shipped flows + every test fixture: role → id per the table.
- [ ] **Step 4: Run, verify pass** — `npm run typecheck && npm run lint && npx vitest run`
- [ ] **Step 5: Commit** — `feat(canvas): a node names its own model, and nothing overrules it`

---

### Task 3: The picker

**Files:**
- Modify: `src/app/inspector.tsx` (the `Model role` select), `src/app/node-card.tsx` (model id under the label), `src/app/api/flow/route.ts` (GET returns `models`)
- Modify: `src/app/state.ts` (`FlowState.models`)
- Test: `e2e/model-picker.spec.ts` (create)

**Interfaces:**
- Consumes: `catalog()` from Task 1, `node.modelId` from Task 2.
- Produces: `GET /api/flow` response gains `models: { id, format, cost, caps }[]`. The client never invents the list.

- [ ] **Step 1: Write the failing e2e test** — seed a flow with three image nodes off one source, set a different model on each through `[data-testid=node-model]`, assert each card shows its own id via `[data-testid=model-<nodeId>]` and the three prices differ.
- [ ] **Step 2: Run, verify fail** — `npx playwright test e2e/model-picker.spec.ts`
- [ ] **Step 3: Implement.** Select lists `models.filter(m => m.format === (node.type === 'image' ? 'image' : 'video'))`, each option `${id} — ${money(price)}/${unit}`, caps line beneath. Card shows `node.modelId` beside the existing price.
- [ ] **Step 4: Run, verify pass**
- [ ] **Step 5: Commit** — `feat(canvas): the model is a choice on the card, not a constant in the bundle`

---

### Task 4: An incompatible switch is refused

**Files:**
- Modify: `src/core/wiring.ts` — export `assertModelFits(flow, nodeId, model)`
- Modify: `src/core/workspace.ts` (`saveGraphIfCurrent`) or `src/app/api/flow/route.ts` PUT — validate every runnable node against its edges on save
- Modify: `src/app/inspector.tsx` — snap back and show the reason
- Test: `test/unit/wiring.test.ts`

**Interfaces:**
- Produces: `assertModelFits(flow: Flow, nodeId: NodeId, model: ModelSpec): void` — throws `UnsupportedCapabilityError` with the existing sentences from `assertAnchorsSupported` / `assertStartFrameSupported`.

- [ ] **Step 1: Write the failing tests**

```ts
test('switching to a model that cannot honour references is refused, naming the count', () => {
  const flow = withReferences('shot', 3)
  expect(() => assertModelFits(flow, 'shot', modelById('recraft-v3')))
    .toThrow(/recraft-v3 cannot honour reference images/)
})
test('switching a clip off its start frame support is refused', () => {})
test('the save path refuses it too, because the agent sets modelId as well', () => {})
```

- [ ] **Step 2: Run, verify fail** — `npx vitest run test/unit/wiring.test.ts`
- [ ] **Step 3: Implement.** `assertModelFits` calls the two existing asserts against `referencesOf(flow, nodeId)` and the node's `start_frame` edge. Called on save for every image/video node; the route returns 400 with the message (`UnsupportedCapabilityError` is already mapped there for runs).
- [ ] **Step 4: Run, verify pass**
- [ ] **Step 5: Commit** — `fix(canvas): a model change that would drop your anchors is refused, not absorbed`

---

### Task 5: The migration

**Files:**
- Create: `bin/migrate-model-ids.ts`
- Modify: `package.json` (`"migrate:model-ids": "tsx bin/migrate-model-ids.ts"`)
- Test: `test/acceptance/migrate-model-ids.test.ts` (create)

**Interfaces:**
- Consumes: nothing from `src/core`. **The script carries its own frozen copy of the old shape** — the old `hashableConfig` cases and the role → id table as literals. After Task 2 the old shape is not importable, and an import would compute the new hash on both sides, rewrite nothing, and report success.
- Produces: `migrateModelIds(db: Db): { nodes: number; runs: number; unclaimed: number }`.

- [ ] **Step 1: Write the failing test**

```ts
test('an old-shape flow keeps its paid-for renders', () => {
  // seed a flow whose nodes carry modelRole, plus a node_runs row at the OLD hash
  const result = migrateModelIds(db)
  expect(result.runs).toBe(1)
  // the graph now carries modelId, and planRun's hash matches the rewritten row
  expect(previewRun(db, flowId).stale).toEqual([])
})
test('a second run rewrites nothing', () => {
  migrateModelIds(db)
  expect(migrateModelIds(db)).toMatchObject({ nodes: 0, runs: 0 })
})
```

- [ ] **Step 2: Run, verify fail** — `npx vitest run test/acceptance/migrate-model-ids.test.ts`
- [ ] **Step 3: Implement.** Per flow, in one transaction: read `graph_json`; for each node still carrying `modelRole`, compute old hash (frozen shape) and new hash (`planRun`'s), `UPDATE node_runs SET input_hash = new WHERE flow_id = ? AND node_id = ? AND input_hash = old`, write the graph back with `modelId`. Print one line per node and a total, including a count of runs left unclaimed.
- [ ] **Step 4: Run, verify pass**
- [ ] **Step 5: Commit** — `feat(db): one script so a model id does not re-bill work you already paid for`

---

### Task 6: Fixtures, docs, and the workflow spec

Last, because the system prompt lists both the catalog and `listTemplates()` — harvesting before the shipped flows are edited produces keys that change again.

**Files:**
- Modify: `test/fixtures/llm/*.json` (rename to re-harvested keys)
- Modify: `README.md`, `.env.example` (the catalog file and where it lives)
- Modify: `e2e/chat.spec.ts` if the agent's reply changes

- [ ] **Step 1: Re-harvest.** Run the canvas with `LLM_MODE=replay`, `OPENROUTER_MODEL=anthropic/claude-opus-5` against a throwaway `OPENFLOW_DATA_DIR`; POST the chat message; rename each fixture to the key its miss reports; repeat from a clean data dir for the second step.
- [ ] **Step 2: Verify** — `npx playwright test e2e/chat.spec.ts`
- [ ] **Step 3: Full suite** — `npm test`
- [ ] **Step 4: Commit** — `docs(models): the catalog is a file, and the fixtures follow the prompt`
