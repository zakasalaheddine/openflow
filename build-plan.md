# OpenFlow — Build Plan v2

**A local-first, open-source node editor for directing on-brand ad creative.**

Clean-room build. Nothing carried over from `spoolset`.

Supersedes v1. Changed: the variant matrix is gone, wiring is manual, the graph is a branching DAG of individually-directed shots, and output settings are configurable.

---

## 0. What it is

A **web GUI that runs on your own machine.** `npx openflow-studio` boots a local server and opens `localhost:3000`; everything after that is a normal browser app — dropzones, canvas, drag-to-wire, inspector panels, video previews. The terminal is a launcher, not the product.

Local-first means the SQLite file, the generated assets, and the fal key stay on the user's laptop. No accounts, no cloud, no credits.

**What it does:** you upload a product once, and it becomes an *anchor*. You then build a graph of shots — images, and video clips branching off those images — each with its own prompt and creative direction. The anchor keeps the product identical across every output. Change the product, bump the anchor version, and every downstream shot re-renders.

**Who it's for:** performance marketing teams and ad agencies producing high-volume creative.

**Who it's not for:** anyone wanting a general AI workflow engine. That's ComfyUI.

---

## 1. Constraints

These exist to prevent the failure mode that killed the previous attempt: unbounded generality.

| Constraint | Rule |
|---|---|
| **Node types are scarce** | Four in v1. Adding one requires a written case showing it can't be expressed by the existing four. |
| **Config is open** | Formats, fps, codec, models, spend caps, resolutions — all user-editable. Scarcity applies to node types only. |
| **Models are rows** | Adding a model = a row in a registry file. Never a class. |
| **One provider** | fal.ai only in v1. |
| **No agent loop** | LLMs at the edges (brand profile, brief→flow) only. Never in the execution path. |
| **One process** | Next.js server + in-process worker. No Redis, no external queue, no extra services. |
| **Ship W3** | Repo goes public at end of week 3, finished or not. |

Write the Non-Goals into `README.md` **before** the executor. It's the immune system, and it's also the positioning.

---

## 2. Week 0 — Validation spike (before any code)

**Everything rests on anchor consistency holding.** If a product can't stay recognisably itself across generations, the product changes shape. Find out in three days.

Throwaway `spike.ts`, no repo, no schema.

1. **Real inputs** — 3 real products, one with fine detail (labelled bottle, stitched shoe). 4 reference photos each. Not stock; stock flatters the models.
2. **Image test** — 12 images per product across 4 scenes × 3 seeds, same refs attached. Nano Banana Pro first, FLUX.2 [pro] as the cheap comparison.
3. **Video test** — take a passing image, feed as start frame to Veo 3.1 and Kling 3 Pro, 5 seconds. Does identity survive motion? Which models expose start **and** end frame control?
4. **Score** — per output: same product? label legible? colours right? client-acceptable? Record pass rate and real $.

| Result | Action |
|---|---|
| **≥70%** | Green light, build as planned |
| **40–70%** | Build, but reposition around *generate many, review fast* rather than guaranteed consistency |
| **<40%** | Stop. Re-test in 3 months; build the reporting demo instead |

**Output:** `FINDINGS.md` — pass rates, costs, winning model. Later becomes launch content.

---

## 3. Architecture

```
┌──────────────────────────────────────────┐
│  Next.js — single process, :3000         │
│  /app     canvas GUI + API routes        │
│  /core    node types, executor, hashing  │  ← zero framework imports
│  /models  registry rows + fal adapter    │
│  /worker  claim loop, fal polling        │  ← in-process
└───────────────┬──────────────────────────┘
        ./data/app.db       SQLite, WAL
        ./data/assets/      generated files
        ./exports/          user-facing output
                │
           fal.ai API       (user's own key)
```

`/core` imports no React, no Next. Enforce with an eslint boundary rule — it's what makes the headless runner and a later MCP server nearly free.

### 3.1 The four node types

```ts
type FlowNode =
  | { id; type: 'source'
      assets: AssetRef[] }                    // bring an existing file in

  | { id; type: 'image'
      prompt: string
      anchors: AnchorId[]
      modelRole: ModelRole
      seed?: number }

  | { id; type: 'video'
      prompt: string
      anchors: AnchorId[]
      durationSec: number
      audio: boolean
      modelRole: ModelRole }                  // start/end frames come from edges

  | { id; type: 'export'
      formats: AdFormat[]
      fps?: number; codec?: string }          // omitted = project default
```

Anchors are **not** a node type — they're project-level entities in the left rail, attached to nodes by chip toggle. That's what keeps the canvas readable when twelve nodes reference the same bottle.

`variants` from v1 is cut. Every node is a shot you direct, not a template being filled.

### 3.2 Edges carry meaning

```ts
type Edge = {
  id: string
  from: NodeId
  to: NodeId
  role: 'start_frame' | 'end_frame' | 'input'
  position: number | null      // reserved for v2 sequence ordering
}
```

An image → video edge with `role: 'start_frame'` literally means *this image is frame zero of that clip*. The registry's `caps.startEndFrame` flag gates the connection: a video model that can't accept a start frame cannot be wired downstream of an image node. Refused at wiring time, not silently ignored at render time.

`position` stays null in v1. It exists so v2's `sequence` node doesn't need a migration — every other node treats inputs as a set, but sequencing needs order.

### 3.3 Branching is the core interaction

One image feeding three video nodes is an ordinary DAG. Nothing special in the engine — three video runs consume one image output, each with its own prompt and therefore its own hash.

```
[marble counter] ─┬─→ [push-in]
                  ├─→ [shadow sweep]
                  └─→ [tilt up]
```

The engine doesn't care. The **UI** does — see §6.2.

### 3.4 Hash = cache = ledger

```ts
input_hash = sha256(
  nodeType + canonicalJson(config) + upstreamHashes.join(',') +
  anchorVersions.join(',') + modelId + seed
)
```

One value, three jobs: cache key, cost ledger row, and pre-baked demo mode. Do not split these.

Anchor versions being in the hash is what makes "new bottle photos → everything downstream goes stale" work for free.

---

## 4. Data model

SQLite, WAL, `./data/app.db`. Drizzle so a Postgres swap is trivial later.

```
projects    id, name, brand_profile(text), brand_profile_version,
            settings(json), created_at

anchors     id, project_id, kind, ref_images(json), notes,
            version, created_at

flows       id, project_id, name, graph_json, updated_at

node_runs   id, flow_id, node_id, input_hash, status, model_id,
            fal_request_id, cost_cents, output_refs(json),
            error, attempt, created_at

assets      id, path, mime, width, height,
            duration_ms, fps, codec, source_run_id

exports     id, flow_id, format, asset_id, spec_check(json), path
```

Indexes: `node_runs(input_hash)`, `node_runs(status)`, `node_runs(flow_id, node_id)`.

`assets.duration_ms / fps / codec` cost one migration now and save backfilling by probing every file when v2 sequencing arrives.

`projects.settings` holds the editable defaults:

```json
{
  "fps": 30,
  "codec": "h264",
  "formats": [
    { "name": "9:16", "w": 1080, "h": 1920 },
    { "name": "1:1",  "w": 1080, "h": 1080 }
  ],
  "spendCapPerRun": 50,
  "concurrency": 4,
  "defaultMode": "draft"
}
```

Everything here is user-editable, per project and overridable per export node. Custom formats matter on day one — agencies have client-specific placements (DOOH, in-app, bumpers) and a fixed list blocks them immediately.

Assets sit behind a 3-method interface — `put/get/url` — on local disk, so a hosted demo can swap in S3 without touching node code.

---

## 5. Execution

**No webhooks.** A laptop has no public URL, so fal cannot call back. Every run is a polled state machine that survives restart — orphaning a $5 render is unacceptable.

```
queued → submitted → polling → succeeded
                            ↘ failed → retry ≤3 → queued
```

`fal_request_id` is persisted the instant fal accepts. On boot, the worker re-adopts anything in `submitted` or `polling` and resumes.

### Queue

No Trigger.dev, no pg-boss, no Redis. Jobs are coarse — one node run, seconds to minutes.

```
loop every 2s:
  claim   UPDATE node_runs SET status='claimed'
          WHERE id = (SELECT id FROM node_runs WHERE status='queued'
                      ORDER BY created_at LIMIT 1) RETURNING *
  dispatch → fal, persist fal_request_id, status='submitted'
  poll     status endpoint, backoff
  succeed  download assets, probe metadata, write cost_cents
  reap     'claimed' older than 5min → back to 'queued'
```

~150 lines. Semaphore of N in-flight jobs, N from settings.

### Normalisation on write

Video output is transcoded to the project's fps/codec/dimensions **at the storage boundary**. Models return wildly different specs; normalising one clip at a time is free, whereas fixing it retroactively across a client's library is not. This is what makes v2 concatenation a cut rather than a re-encode.

### Spend cap

Before dispatching a run, sum the estimated cost of all queued nodes. Exceed `spendCapPerRun` → block with a confirm dialog. Cheap insurance against a mis-set variant of anything.

---

## 6. GUI

### 6.1 Layout

- **Left rail** — the *client*: anchors with reference thumbnails and version numbers, brand profile summary. Persists across every flow in the project.
- **Canvas** — the *campaign*: free node placement, manual drag-to-wire, React Flow.
- **Inspector** — slides in from the right on node select: prompt, anchor chips, model, seed, duration, per-node cost.
- **Top bar** — project / flow breadcrumb, Draft·Hero toggle, total cost estimate, Run.

Nodes render their own output preview as a thumbnail; video nodes loop on hover. With 9–12 outputs you review **on the canvas**, in place — no separate grid.

### 6.2 The interactions that matter

**Anchor attachment is a chip, not a wire.** Click an anchor in the rail to toggle it on the selected node. Twelve nodes referencing one bottle produce zero extra edges.

**Alt-drag fans out.** Alt-drag from an image node spawns a sibling video node, pre-wired, **pre-filled with the previous sibling's prompt** — so you edit a copy rather than start blank. This is the ergonomic win the cut `variants` node was providing, without templating prompts you want to write individually.

**Stale propagation is visible and priced.** Editing a node greys out every descendant immediately, with a toolbar count: `6 nodes stale · $11.40 to refresh`. Never silently re-run — at hero video prices that's real money.

**Subtree cost on hover.** Total spend is too coarse when one branch is three video renders. Hovering an image node shows `3 clips · $1.47 draft · $12.60 hero`.

**Re-roll vs. edit is the review discipline.** Each node offers `↻ re-roll` (same prompt, new seed — fixes warping and artifacts) and prompt editing (fixes intent). Confusing the two means re-rolling a bad idea forever. Keep them visually distinct.

### 6.3 Brand profile and brief

Project setup derives a **brand profile** once: an LLM reads the uploaded logo, palette, product photos, and guidelines, and drafts a short structured text document. The human **edits and confirms it**. Version-bumped like an anchor.

Every brief afterwards reads that text instead of the raw assets — fast, cheap, and consistent across campaigns. Vision models misread guidelines; making the profile an editable artifact means the error is corrected once instead of recurring silently forever.

New flows start from a **brief box** or a **template**, and the two combine:

```
brief + brand profile → { templateId, filled prompts }
```

The LLM **picks a template and fills it in.** It does not invent topology. Structure is valid by construction; the only failure mode is wrong prompts, which are visible and editable. Templates are JSON files in `/flows/templates/`, shipped with the repo — they double as documentation and demo content.

---

## 7. Model registry

A model is a config row; one generic fal adapter reads it.

```ts
type ModelSpec = {
  id: string
  format: 'text' | 'image' | 'video'
  role: 'draft' | 'hero' | 'specialist'
  falEndpoint: string
  caps: {
    refImages: number        // 0 = cannot honour anchors
    textRendering: boolean
    startEndFrame: boolean
    nativeAudio: boolean
    maxDurationSec?: number
  }
  cost: { unit: 'image'|'megapixel'|'second'; amount: number }
  verifiedOn: string
}
```

`caps.refImages === 0` lets the executor **refuse** to attach an anchor to a model that can't honour it, instead of silently producing off-brand output. `cost` gives the pre-run estimate for free. `verifiedOn` because fal churns.

**Roles, not rankings** — the picks survive leaderboard churn:

| Role | Purpose |
|---|---|
| `draft` | cheap + fast, for iterating |
| `hero` | best quality, for finals |
| `specialist` | one capability others do badly |

The **Draft·Hero toggle is graph-level**, not per node. Iterate at $4, render at $38. That single switch is worth more than fifty model dropdowns — and it still works with twelve models registered, because it selects by role.

**Default registry** (three per format is a starting point, not a limit — add rows freely; verify against live fal endpoints at build time):

- **Image** — draft: FLUX.2 [pro] ~$0.03/MP · hero: Nano Banana Pro ~$0.15/img · specialist: Recraft V3 ~$0.04/img (text rendering — ad creatives have burned-in headlines, and the general canvases ignore this)
- **Video** — draft: Hailuo 2.3 Pro ~$0.49 · hero: Veo 3.1 / Kling 3 Pro · specialist: whichever exposes start **and** end frame control. Weight native audio heavily. *Video landscape is unstable — confirm availability before wiring.*
- **Text** — draft: a cheap fast model · hero: Claude Sonnet for brand profile and brief→flow · specialist: **leave empty**, don't fill for symmetry.

---

## 8. Schedule

### Week 1 — Core, headless

No UI. If W1 slips, cut a node type.

1. Next.js + TypeScript + App Router
2. Drizzle + SQLite, WAL, six tables, `./data/` gitignored
3. `/core/types.ts` — four-node union, `Edge`, `AssetRef`, `AdFormat`
4. `/core/hash.ts` — canonical JSON, upstream hash chaining
5. `/core/graph.ts` — topological order, descendant walk (powers stale propagation)
6. `/core/executor.ts` — the switch, cache lookup before dispatch
7. `/models/registry.ts` — 3 image rows + generic fal adapter
8. `/worker/loop.ts` — claim, dispatch, poll, reap, normalise
9. `bin/run.ts` — `npx tsx bin/run.ts flows/demo.json`

**Done when:** a JSON graph produces images on disk; a second run costs $0; killing the process mid-run and restarting resumes cleanly.

### Week 2 — Canvas

1. React Flow over the existing `graph_json` — the UI is a *view* of the schema, never its own model
2. Four node components with inline output previews
3. Manual wiring with `role` inference and capability gating
4. Inspector panel
5. Anchor rail — create, upload refs, bump version, chip toggle
6. Stale propagation + descendant greying + priced toolbar count
7. Subtree cost on hover; Draft·Hero toggle

**Done when:** you build the 3-image → 9-video serum graph from an empty canvas without touching JSON.

### Week 3 — Video, export, ship

1. Video node, 3 video rows, start/end frame wiring, alt-drag fan-out
2. Export node, configurable formats, custom format creation
3. **Spec validation** — safe zones, min resolution, duration limits, text coverage. Don't cut this; it's the ad-specific depth nobody else has.
4. `manifest.json` on export — per file: source node, prompt, model, seed, anchor versions, cost, timestamp
5. Brand profile generation + brief→flow + 4 templates
6. `npx openflow-studio` launcher; Dockerfile secondary
7. README

**Done when:** it's public.

### Week 4 (optional) — MCP server

Thin tools over `/core`: `create_flow`, `set_anchor`, `add_node`, `wire`, `run_flow`, `list_outputs`.

Makes Claude an **authoring** surface, not a review surface — language for structure, eyes for judgment. Demonstrates both the *Custom MCP Server* and *AI Ad Creative Engine* offers from one build.

---

## 9. v2 — planned, not built

- **`sequence` node** — cuts multiple clips into one spot. Takes the fifth node slot. Groundwork already in v1: normalised video on write, `duration_ms`/`fps` on assets, `position` on edges.
- **Client approval links** — shareable review URLs with comments. Contradicts local-first; needs auth and public URLs. Exactly the kind of thing an agency pays to have built for them.
- **Optional fan-out node** — if the "4 hook variations of this exact shot" case turns out to matter.

---

## 10. Distribution and positioning

**Install:** `npx openflow-studio` — boots, creates the DB, opens the browser, prompts for a fal key. Docker second. `npx` converts curious → running in 30 seconds; compose converts a third as many.

**License: MIT.** Adoption is the point. AGPL protects a SaaS you don't have and quietly blocks the agencies you want.

**README order:** one-line what-it-is → screenshot of the serum graph with costs → `npx openflow-studio` → **Non-Goals above the fold** → model registry table → architecture → contributing (*model rows welcome; node types need a written case*).

**Hosted demo:** same codebase, `DEMO=1`, live runs disabled, example flows pre-baked as cache hits. $0 per visitor. Nobody evaluates a creative tool from a README.

**The pitch is not "free."** Models cost what they cost; fal bills either way. It's **no markup and visible cost** — bring your own key, pay $0.03/image at cost, instead of buying credit packs at someone's margin. Per-node cost tracking makes "see exactly what this creative cost" a headline feature the closed canvases will never ship.

**Local-first is the distribution; installation is the service.** The creative lead never opens a terminal. You install it on their machine, wire it to their assets and fal account, build their first flows. That's the onboarding engagement and the natural retainer entry.

**Don't sell workflow templates.** They're JSON, they get shared free within a week, and it puts you in conflict with the users who are your funnel. The product is you.

---

## 11. Launch

**Launch the artifact, not the repo.** One real product → 3 scenes → 9 clips → total spend → side-by-side with UGC agency pricing. The repo is the link at the bottom. `FINDINGS.md` from Week 0 is half the content already.

**The demo that closes it:** upload redesigned product photos, bump the anchor version, watch eighteen nodes across two campaigns grey out with a price tag, hit run. Nothing else in the tool is as hard to copy.

Channels: Show HN, r/advertising, r/PPC, LinkedIn, the fal community.

**Cheap pre-test:** publish the cost-comparison artifact *before* the build is done. If it doesn't move, you've learned something for a weekend.

---

## 12. Risks

| # | Risk | Mitigation |
|---|---|---|
| 1 | **Anchor consistency doesn't hold** | Week 0 spike, before any code. Non-negotiable. |
| 2 | **Identity drifts across a 5s clip** even when the start frame is perfect | Test in Week 0. If bad, end-frame anchoring becomes mandatory, not optional — and the video model shortlist shrinks accordingly. |
| 3 | **Krea/Freepik ship ad-format awareness** | Defend with depth in the ad layer — spec validation, safe zones, provenance — never breadth. |
| 4 | **Generality creep from contributors** | Non-Goals above the fold. Node types need a written case. Say no publicly and often. |
| 5 | **fal model churn** | Models are rows; `verifiedOn` per row; a break is a config edit. |
| 6 | **Video spend blows up in dev** | Draft default, spend cap, aggressive caching. |
| 7 | **Nobody cares** | Pre-test the cost artifact before finishing. |

---

## 13. First five actions

1. Run the Week 0 spike — 3 products, 12 images each, plus the 5s motion test
2. Write `FINDINGS.md` with pass rates and real spend
3. Pass the ≥70% gate, or change course per §2
4. Pick a name — one hour maximum
5. Create the repo with `README.md` Non-Goals written **first**, before any code