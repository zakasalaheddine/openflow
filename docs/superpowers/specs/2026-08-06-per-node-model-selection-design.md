# Per-node model selection — the node names its model, the catalog names the models

**Date:** 2026-08-06
**Status:** design approved, awaiting spec review
**Scope:** phase 1 of 2

## Why

A node today carries `modelRole: 'draft' | 'hero' | 'specialist'`, and
`resolveModel(format, role)` maps that to exactly one row of a six-row array
compiled into the bundle. Three image models exist, three video models exist,
and which one a node runs is chosen by editing `src/models/registry.ts`.

Worse, the choice is not the node's. The canvas toolbar holds a
Draft/Hero/Specialist toggle whose value is threaded through `/api/flow`,
`/api/run`, `run-flow`, `executor` and `wiring` as `options.role`, and it
**overrides every node's own role at render time** (`executor.ts:127`:
`options.role ?? node.modelRole`). Three nodes wired to the same product photo
cannot run on three different models. The one comparison that decides which
model to buy is the one the editor cannot express.

fal publishes 1418 models. This phase makes the node name its own model, and
makes the list of available models a file you edit rather than code you compile.

## Decomposition

| # | Phase | Ships |
|---|---|---|
| **1** | **Catalog + per-node model** — `models.json` in the data dir, `modelId` on the node, picker in the inspector, toolbar override deleted, hash migration | three nodes off one source, three models, three prices, side by side |
| 2 | Discovery — browse fal's model index, derive caps from its OpenAPI, append a row to the catalog | find a slug without leaving the canvas |

Phase 2 is pure addition and does not block phase 1. The catalog file is the
seam between them: the discovery panel and a text editor write the same thing.

## Decisions

### The catalog is a file in the data dir, not an array in the bundle

`models.json` sits beside `app.db` under `OPENFLOW_DATA_DIR`, seeded on first
boot from the six rows now in `registry.ts`. `registry.ts` stops exporting
`const REGISTRY` and exports `catalog()`, which reads and validates the file,
caching on mtime so an edit is live on the next canvas reload without a
restart.

**Rejected: a `models` table in SQLite.** Same features, but only the UI could
edit it. A JSON file is hand-editable, diffable and copyable between machines,
which is what "not in the code" is actually asking for.

**Rejected: reading fal's index as the picker's list.** fal returns no
structured price and no capability flags. The pre-run cost estimate and every
wiring refusal read exactly those two things, so a live list would cost the
ledger and the gates — the two features that keep a render from being a
surprise. fal's index is a discovery aid in phase 2, never the source of truth.

An invalid catalog is refused loudly, naming the row and the field. It never
falls back to the seed: a silent fallback renders against a model you believe
you changed, at a price you believe you set.

### A row is today's `ModelSpec`, minus the role

```jsonc
{
  "id": "flux-2-pro",
  "format": "image",              // "image" | "video"
  "falEndpoint": "fal-ai/flux-2-pro",
  "editEndpoint": "fal-ai/flux-2-pro/edit",   // optional
  "default": true,                            // optional, per format
  "caps": {
    "refImages": 4,
    "textRendering": false,
    "startEndFrame": false,
    "nativeAudio": false
  },
  "cost": { "unit": "megapixel", "amount": 3 },
  "verifiedOn": "2026-07-31"
}
```

`role` is gone. `default: true` marks what a fresh node of that format gets;
the first row of the format wins if no row claims it. `cost.amount` stays
declared by hand — fal returns no price with a result, so the ledger has no
other source, and `verifiedOn: null` keeps carrying its existing warning.

### The node stores `modelId`

`FlowNode`'s `modelRole: ModelRole` becomes `modelId: string` on image and video
nodes. Everything downstream already speaks model ids: `inputHash` takes
`modelId`, `node_runs.model_id` stores it, `worker/loop.ts` resolves it with
`byId`. The role indirection was the only thing in the way.

`hashableConfig` drops `modelRole` and does **not** add `modelId`. The hash
already folds the resolved model id in as its own field (`executor.ts:132`), so
whitelisting it would hash the same fact twice.

`resolveModel(format, role)` is deleted. `modelById(id)` replaces it and throws
by name on a miss, so a graph naming a model the catalog no longer has fails
where it can be read, not where it would be billed.

### The toolbar override is deleted, not repurposed

Removed: `role` state in `canvas.tsx`, the Draft/Hero/Specialist control,
`?role=` on `/api/flow`, `role` in the `/api/run` body, `options.role` through
`run-flow` → `executor` → `wiring`, and `ProjectSettings.defaultMode`.

The node decides, always. A bulk "set all to…" action was considered and left
out: it is an editing convenience, and nothing in the workflow this phase exists
to serve needs it. Add it when setting the same model on many nodes by hand
becomes the actual complaint.

### An incompatible model change is refused, not absorbed

`assertAnchorsSupported` and `assertStartFrameSupported` already exist, already
gate wiring, and already produce the sentence to show. The model change calls
them against the node's current edges:

> recraft-v3 cannot honour reference images, so it cannot use an anchor.

The select snaps back and the reason appears under it. Enforced in the
flow-save path on the server, not only in the React component — the agent sets
`modelId` too, and a rule that lives in a component is not a rule.

**Rejected: allow the switch and block Run on that node.** It lets the graph
sit in a state that looks runnable and is not. **Rejected: drop the
incompatible wires automatically.** It silently deletes graph you drew, which
is the exact failure the wiring rules exist to prevent.

### The agent moves with the schema

`add_node` and `update_node` take `modelId` instead of `modelRole`, validated
against the catalog. The system prompt already lists rows with their prices and
caps (`agent/prompt.ts:12`); it now lists ids without roles.

That changes the prompt, which changes the fixture key, so both checked-in chat
fixtures must be re-harvested — same procedure as the model-keyed fixture change
(`4b586c5`): run the canvas in `LLM_MODE=replay` against a throwaway data dir
and rename each fixture to the key its miss reports.

## Interface

### `src/models/registry.ts`

| Export | Was | Is |
|---|---|---|
| `REGISTRY` | `ModelSpec[]` const | deleted |
| `catalog()` | — | `ModelSpec[]`, read from `models.json`, mtime-cached, zod-validated |
| `resolveModel(format, role)` | `ModelSpec` | deleted |
| `byId(id)` | returns `undefined` on a miss | unchanged — the worker resolves the model of a **past** run (`worker/loop.ts:384`, `:474`) and already handles a miss by failing that run with `Unknown model <id>`. Removing a row from the catalog must not crash the loop. |
| `modelById(id)` | — | `ModelSpec`, throws `UnknownModelError` naming the id. For authoring paths only — the picker, the agent, `planRun` — where a graph naming an absent model must fail before it can be billed. |
| `defaultModelFor(format)` | — | `ModelSpec` — the row flagged `default`, else the first of that format |
| `endpointFor`, `assertAnchorsSupported`, `assertStartFrameSupported`, `estimateCostCents` | unchanged | unchanged |

The catalog path resolves through `env.ts` like every other path
(`modelsPath()`), so a test points it at a temp file and can never read the
developer's own catalog.

### Editor

- Inspector: `Model role` select → `Model` select, listing catalog rows of the
  node's format as `nano-banana-pro — $0.15/image`, with a caps line beneath
  (reference images accepted, text rendering, max duration).
- Node card: the model id under the label, beside the existing price. Without
  it, three cards off one source are indistinguishable at a glance, and that
  comparison is the point of the phase.

### Shipped flows are edited, not migrated

`flows/templates/*.json` (four templates) and `flows/demo.json` carry
`modelRole` and are repo files, not user data. They are rewritten in place to
`modelId`, and may only name ids present in the seed catalog — a template that
names a model a fresh install does not have is a template that cannot be
applied. A test asserts exactly that: every `modelId` in every shipped flow
resolves against the seed.

## Migration

One-shot script, `npm run migrate:model-ids`, operating on `OPENFLOW_DATA_DIR`.
No migration framework: `db/index.ts` is DDL-only by design and its comment
says to reach for one the first time a shipped database needs altering. This is
that time, and a single script is smaller than adopting drizzle-kit for one
rewrite.

Role → id, matching what `resolveModel` returns today:

| Role | image | video |
|---|---|---|
| draft | `flux-2-pro` | `hailuo-2-3-pro` |
| hero | `nano-banana-pro` | `veo-3-1` |
| specialist | `recraft-v3` | `kling-3-pro` |

In one transaction, per flow:

1. Read `graph_json`; map each runnable node's `modelRole` to its id.
2. Compute that node's **old** hash (role in config) and **new** hash (role
   gone), using the same inputs `planRun` uses.
3. `UPDATE node_runs SET input_hash = <new> WHERE flow_id = ? AND node_id = ?
   AND input_hash = <old>`.
4. Write `graph_json` back with `modelId`.

Idempotent: a second run matches nothing. It prints one line per node rewritten
and a total. Renders belonging to nodes since deleted or edited keep their old
hash and stay unclaimed — printed as a count, not hidden. Nothing on disk is
touched, so a bad run costs a re-render and nothing else.

## Testing

**Unit**

- Catalog loads, validates, and refuses a malformed row by field name.
- An edit to the file is picked up without a restart (mtime).
- `modelById` throws by name on a miss; `defaultModelFor` honours `default` and
  falls back to first-of-format.
- `hashableConfig` no longer carries the role, and a node's hash still changes
  when its model does (via the `modelId` hash field).
- The caps refusal on model change, both directions: references against a
  `refImages: 0` model, start frame against a model without `startEndFrame`.
- Migration: a flow with old-shape nodes and a matching `node_runs` row — after
  the run, the row is claimed by the new hash, the graph carries `modelId`, and
  a second run rewrites nothing.

**E2E** — one spec that is the workflow this phase exists for: one image source,
three image nodes wired to it, a different model on each, Run, three cards each
showing their own model id and their own price. That spec is the acceptance
test for the phase.

**Fixtures** — both chat fixtures re-harvested after the prompt change.

## Phase 2, sketch

A browse panel over `https://fal.ai/api/models` (paged; 1418 rows; filtered to
`text-to-image`, `image-to-image`, `text-to-video`, `image-to-video`), showing
thumbnail and title. Selecting one fetches
`https://fal.ai/api/openapi/queue/openapi.json?endpoint_id=<slug>` and derives
caps from the input schema — `image_urls` → reference images, `image_url` or
`start_image_url` → start frame, `duration` enum → max seconds — then prefills
the price by reading `pricingInfoOverride` prose where fal has one (present on
roughly half the catalogue, e.g. *"charged **$0.084** per second (audio off)"*).
You confirm or correct, and the row is appended to `models.json`.

Both endpoints are undocumented and unversioned. The panel degrades to "paste a
slug, fill the fields yourself" when either fails, which is the same manual path
the catalog file already supports.
