# Assets in the canvas — design

**Status:** approved. Supersedes the options in
[`2026-07-31-assets-in-canvas.md`](./2026-07-31-assets-in-canvas.md).

**Decisions:** Approach C (wires, drawn quietly) · project-level asset library ·
inline prompt editing on double-click · reproduce the wiring bug by hand first.

Overrides `build-plan.md` §3.1 (anchors are not a node type) and §6.2 (attachment
is a chip, not a wire). Those existed to keep the canvas readable; readability is
handled here by how reference edges are drawn, not by hiding the relationship.

---

## 1. Goal

Everything you work with lives in the editor. Drop an image, video or text file
onto the canvas and it becomes a node. Wire it into a shot. Edit that shot's
prompt on the card. No sidebar anywhere.

## 2. Model

**An asset is a project-level row. A canvas node is a reference to one.**

You never see the library as a list — you upload by dropping on the canvas — but
because the row is shared, one product can be referenced from many flows, and
replacing its files greys out every downstream shot in every campaign. That is
`build-plan.md` §11's demo, preserved.

### 2.1 Node types stay at four

`source` already means "bring an existing file in". Images, video and text all
use it; the card renders differently per `kind`. No fifth node type, so §1's
scarcity constraint is untouched and no written case is required.

```ts
// was: assets: AssetRef[]
export type SourceNode = NodeBase & {
  type: 'source'
  sourceId: string        // → sources.id
}
```

`ImageNode.anchors` and `VideoNode.anchors` are **removed**. What a shot
references is now what is wired into it.

### 2.2 Tables

`anchors` is renamed to `sources`, its `ref_images` column is renamed to `files`
(it now holds video too), and it gains a `text` column. Everything else a library
asset needs was already there: `project_id`, `kind`, `version`, `notes`.

```
sources   id, project_id, kind ('image'|'video'|'text'),
          files(json)   -- stored paths; empty array for text
          text          -- content; null for image and video
          version, notes, created_at
```

`assets` is unchanged and keeps meaning **generated output**. Uploads do not go
there — an upload is authored input, a row in `assets` is something a model
produced and a run paid for. Keeping them apart keeps the cost ledger honest.

> **Migration:** none. There is no shipped database. The DDL uses
> `CREATE TABLE IF NOT EXISTS`, so an existing dev database will not pick up the
> rename — delete `./data` when pulling this change. Document it in the README.

### 2.3 Edges

A fourth role joins the existing three:

| From → To | Role | Meaning |
|---|---|---|
| `source` → `image` \| `video` | `reference` | this asset is an input the model must honour |
| `image` → `video` | `start_frame` | this image is frame zero of that clip |
| anything → `export` | `input` | feed the export |

`end_frame` stays reserved for Phase 3.

## 3. Hashing

`anchorVersions` is **removed from `inputHash` entirely**, and this is a
simplification rather than a loss.

A source node's `hashableConfig` is `{ sourceId, version }`. Because hashes chain
through `upstreamHashes`, bumping a source's version changes that source node's
hash, which changes every descendant's hash for free. The guarantee is identical;
it arrives through the existing chain instead of through a parallel field.

`hashableConfig` stays pure — it sees a node and nothing else — so it returns
only what is on the node:

| Type | Hashed |
|---|---|
| `source` | `sourceId` |
| `image` | `prompt`, `modelRole` |
| `video` | `prompt`, `modelRole`, `durationSec`, `audio` |
| `export` | `formats`, `fps`, `codec` |

The **version** lives on the `sources` row, not on the node, so `planRun` — which
has database access — looks it up and folds it into that source node's hash.
This is the one place a hash depends on something outside `graph_json`, and it is
deliberate: it is what makes replacing a file invalidate downstream work.

Still a whitelist. `position` and `label` remain unhashed — dragging a node must
never re-bill its subtree.

**The load-bearing test moves, it does not disappear.** `hash.test.ts`'s
"bumping an anchor version changes the hash" becomes an executor-level test:
bumping a source's version changes the hash of every node downstream of it.

## 4. Prompt composition

A text source wired into a shot contributes a prompt fragment — brand tone
reused across every shot, without retyping.

**Order:** text fragments first, in the order their edges appear in
`graph_json.edges`, then the node's own prompt. Joined by `\n\n`.

Edge insertion order is persisted and stable, so the composition is
deterministic — which it must be, because it feeds the hash.

```
[brand voice] ╌╌ref╌╌┐
                     ├→ [marble shot]   prompt sent to fal:
[bottle.jpg]  ╌╌ref╌╌┘                    "warm, unfussy, no hard sell
                                           
                                           a serum bottle on marble"
```

Image and video sources contribute their files to `image_urls` instead, exactly
as anchors do today.

## 5. Interaction

### 5.1 Upload

- **Drop a file on empty canvas** → uploads, creates a `source` node at the drop point.
- **Drop a file on a generator node** → uploads, creates a `source` node *and* wires it in. (The approach-E gesture, on top of C.)
- **Paste text / drop a `.txt`** → a text source node.

`POST /api/sources` takes multipart, writes through `localStore`, inserts a
`sources` row, returns the id. Validated at the boundary: mime allow-list, size
cap, and a filename that cannot escape the store root — the existing
`localStore` path check is the model.

### 5.2 Reference edges, drawn quietly

- Thin, dashed, muted. Generation edges (shot → clip) stay solid and always visible.
- **`⌥R` toggles reference edges.** The control is a visible button in the toolbar as well, showing the hidden count (`⌥R · 9 refs hidden`) — a hidden edge that looks like no edge is how someone concludes a connection vanished.
- **Hovering a source node highlights every node it feeds**, which is the thing the chip design could never do.

### 5.3 Replacing an asset

Replacing a file is the expensive action in the product, so it keeps the
confirmation the rail had — moved onto the node:

```
12 shots across 2 flows go stale · $4.59 to refresh
[ Replace ]  [ Cancel ]
```

`PATCH /api/sources` with `preview: true` returns the blast radius;
without it, bumps `version`.

### 5.4 Prompts

Prompt text renders on the card. **Double-click to edit in place**; blur or `⌘↵`
commits, `Esc` cancels. Cards stay compact so twelve are reviewable at once,
which §6.1 says is the point of reviewing on the canvas.

The inspector keeps the settings that do not belong on a card: model role, seed
and re-roll, duration, audio.

## 6. What changes in existing code

**Deleted** — `src/app/anchor-rail.tsx`, `src/app/api/anchors/`, the anchor chip
block in `inspector.tsx`, the `.rail` styles. ~250 lines.

**Reworked** — `core/types.ts` (SourceNode, drop `anchors`), `core/hashable.ts`,
`core/executor.ts` (`planRun` drops `anchorVersions`; capability gating reads
upstream sources), `core/preview.ts` (`staleForAnchor` → `staleForSource`),
`core/wiring.ts` (`inferRole` gains `reference`), `models/input.ts` (refs and
prompt fragments come from upstream), `core/schema.ts`, `db/schema.ts`.

**New** — `POST/PATCH /api/sources`, drag-and-drop upload, the source node card,
reference edge styling with toggle and hover highlight, inline prompt editing.

**Untouched** — the hash chain itself, the worker, the run ledger, the spend cap,
the fal adapter, and Phase 1's three acceptance tests.

## 7. Testing

TDD as usual: unit tests first for everything in `/core` and `/models`.

**New unit tests**
- `inferRole`: source → image is `reference`; image → video is still `start_frame`
- `hashableConfig`: a source hashes `sourceId` + `version`; a shot no longer hashes `anchors`
- executor: bumping a source's version changes every downstream hash, and nothing else's
- executor: capability gating reads reference edges — wiring an image source into a model with `caps.refImages === 0` is refused
- prompt composition: fragments precede the node prompt, ordered by edge order, and the same graph composes identically twice
- `staleForSource`: spans flows; prices the refresh; has no side effects
- upload validation: mime allow-list, size cap, a filename that tries to escape the store root is rejected

**Adapted** — the anchor cases in `executor.test.ts`, `stale.test.ts` and the
chip/bump specs in `e2e/canvas.spec.ts`. They test behaviour that still exists,
reached differently; they are rewritten, not deleted.

**New e2e**
- drop an image on the canvas → a source node appears
- drop an image on a shot → source node appears *and* is wired
- `⌥R` hides reference edges and the toolbar says how many are hidden
- hovering a source highlights the shots it feeds
- replacing a file shows the priced blast radius and does not bump on cancel
- double-click a prompt, edit, blur → the shot and its descendants go stale, nothing re-runs

**The Phase 2 gate spec is rewritten** for the new model: build 3 shots + 9 clips
from an empty canvas, with one product source wired into all three shots.

## 8. Out of scope

Alt-drag fan-out, the export node, spec validation, brand profile and brief→flow
all stay in Phase 3. `end_frame` wiring stays reserved. Text sources compose by
concatenation only — no template slots — until something needs more.

## 9. Blocked on

**The wiring bug.** Only the first connection of a page session lands. Approach C
leans on wiring harder than today's UI does, so this is settled first: reproduce
by hand, and if a human can wire twice, the fault is in the test harness and the
gate spec gets rewritten to drive React Flow's API instead of synthetic pointer
events.
