# Assets in the canvas — design options

**Status:** awaiting a decision. Nothing implemented.

## What changed

The brief: **no left rail.** Every asset — image, video, text/prompt — lives in
the editor itself. You upload it there, attach it to a generator node easily,
and edit prompts on the generator nodes.

This overrides two decisions in `build-plan.md`:

- §3.1 — *"Anchors are **not** a node type — they're project-level entities in the left rail."*
- §6.2 — *"Anchor attachment is a chip, not a wire. Twelve nodes referencing one bottle produce zero extra edges."*

Both existed to stop the canvas becoming unreadable. That concern is real but it
is a *rendering* problem, and §6.2's fix is not the only one available. The rest
of this document is about which fix to take.

## What is already in place

Useful, because two of the five approaches need almost no new concepts:

- **`source` is already one of the four node types**, defined as "bring an existing file in", holding `assets: AssetRef[]`. Assets-on-canvas needs **no fifth node type**, so the §1 scarcity constraint is not touched.
- **`assets` table already exists**, and already stores generated outputs. Uploads can be rows in the same table with `source_run_id = null`.
- **`localStore` (`put`/`get`/`url`) already exists**, so upload storage is a route handler, not a subsystem.
- **`AssetRef` already carries** `mime`, `width`, `height`, `durationMs`, `fps`, `codec`.

Missing regardless of approach: an upload endpoint, drag-and-drop onto the
canvas, and inline prompt editing on the node card.

---

## The one decision that shapes everything else

**Do assets stay project-level, or become per-flow graph content?**

| | Project-level library (nodes reference it) | Per-flow (asset lives in `graph_json`) |
|---|---|---|
| Reuse across campaigns | One product, referenced by many flows | Re-upload per flow |
| "18 nodes across 2 campaigns go stale" (§11) | Works | **Gone** |
| Mental model | Node is a *reference to* an asset | Node *is* the asset |
| Storage | `assets` row + node holds the id | Bytes on disk, id in `graph_json` |
| Sidebar needed? | **No** — upload onto the canvas either way | No |

A project-level library does **not** imply a sidebar. The library is a storage
fact, not a UI. You can upload by dropping a file on the canvas, and the asset
node you get is a reference to a row. Nothing about that requires a rail.

My recommendation is to keep assets project-level, because §11 names the
cross-campaign staleness demo as the hardest thing in the product to copy, and
the cost of keeping it is one indirection nobody sees.

---

## Approach A — Everything is a node, wired with edges

Upload → a `source` node appears. Wire it into a generator. Edge `role` carries
the meaning: `reference` (identity anchor), `start_frame`, `input`.

```
[bottle.jpg] ──reference──→ [marble shot] ──start_frame──→ [push in]
      │
      ├──reference──→ [slate shot]
      └──reference──→ [linen shot]
```

**For:** one mental model, nothing hidden. Provenance is visible — you can see
what fed what. `anchors` table and the whole chip mechanism are deleted, which
removes an entire concept and a lot of code. Uses the existing `source` type.

**Against:** this is exactly what §6.2 refused. Twelve shots referencing one
bottle draws twelve edges. On the serum graph (3 shots + 9 clips) it is 3 extra
edges and looks fine; on a 30-node campaign it is a hairball.

**Effort:** medium. Delete the rail and chips, add `reference` edge role, add
upload, rework hashing to take asset ids from upstream `source` nodes.

---

## Approach B — Assets are nodes, but attach by picker, not by wire

Assets appear on the canvas and are uploaded there. A generator node shows a
small strip of attached asset thumbnails; clicking it opens a picker listing the
asset nodes on the canvas. No edge is drawn for references. Frames still wire.

**For:** canvas stays readable at any scale. Closest to today's behaviour, so the
smallest diff and the least risk to the parts that already pass their tests.

**Against:** two different attachment mechanisms, and the relationship is
invisible — you cannot see, at a glance, which shots use the bottle. That is a
real loss for a tool whose whole pitch is that the product stays consistent.

**Effort:** low.

---

## Approach C — Wires, drawn quietly (recommended)

Approach A, plus reference edges are rendered as thin dashed lines in a muted
colour, with a canvas toggle to hide them entirely (`⌥R`). Hovering an asset node
highlights everything it feeds; hiding reference edges leaves the generation
graph — the shots and clips — clean.

**For:** honest and explicit like A, readable like B. The "twelve edges" problem
is a rendering problem and this is the rendering fix. It also gives the thing §6.2
wanted and could not have: *"show me everything this product touches"*, on hover.

**Against:** more UI work than A or B. A hidden edge is still an edge — the toggle
has to be obvious or people will think a connection vanished.

**Effort:** medium-high — A plus the edge styling, the toggle, and hover highlight.

---

## Approach D — Floating asset tray inside the canvas

No rail, but a collapsible tray docked inside the canvas viewport. Drag an asset
from the tray onto a generator node to attach it.

**For:** direct manipulation, very little graph change, assets are never "lost"
off-screen.

**Against:** this is a sidebar with extra steps. It reads as the thing you asked
me to remove, and assets are still not really *in* the graph. Listed for
completeness; I do not recommend it.

**Effort:** low-medium.

---

## Approach E — Drop files straight onto a generator node

No asset nodes at all. Drop an image on a shot and it becomes that shot's
reference, shown as a thumbnail on the card.

**For:** fewest concepts, fastest possible path for a single shot.

**Against:** breaks the core promise. Reusing one product across twelve shots
means attaching it twelve times with no shared identity, so "the anchor keeps the
product identical across every output" stops being structurally guaranteed.
Disqualifying on its own, but it composes well *as an additional gesture* on top
of A or C — drop on a node, and an asset node is created and wired for you.

**Effort:** low.

---

## Prompt editing

Independent of the above; pick one.

1. **Inline on the card, always editable.** Click the prompt text on the node and type. Matches "adjust the prompts on the generator nodes" most literally. Cards get taller; a 12-node canvas gets noisier.
2. **Inline on double-click**, read-only otherwise. Keeps cards compact, one extra gesture.
3. **Keep it in the inspector** (today's behaviour) and add inline as a later refinement.

Recommendation: **2**. Cards stay scannable at twelve-up, which §6.1 says is the
point of reviewing on the canvas, and editing is still on the node.

A separate question the brief raises: **text/prompt as an uploadable asset.**
Under A or C, a `source` node holding text can feed several generators — a shared
prompt fragment, e.g. brand tone reused across every shot. Worth having, and it
needs no new node type. Under B it has nowhere natural to live.

---

## Recommendation

**C, with E as an added gesture, project-level assets, and prompt option 2.**

Assets are `source` nodes on the canvas, uploaded by dropping onto it or onto a
generator node directly. Reference edges are drawn quietly and can be hidden.
Assets remain rows in a project-level library, so replacing a product still
greys out every downstream node in every campaign. No rail anywhere.

If that is more than you want right now, **B is the cheap version** and can
become C later without a migration — the attachment data is the same either way.

---

## What this costs in existing work

Honest accounting, whichever is chosen:

- **Deleted:** `anchor-rail.tsx`, `/api/anchors`, the anchor chip UI in the inspector. Roughly 250 lines.
- **Reworked:** `hashable.ts` (anchors move from a node field to upstream `source` nodes), `executor.planRun` (anchor versions come from upstream instead of a table), `preview.staleForAnchor`, `models/input.ts`.
- **Rewritten tests:** the anchor cases in `executor.test.ts`, `stale.test.ts`, and `e2e/canvas.spec.ts`'s chip and bump specs. About 20 tests. They are testing real behaviour that still exists, just reached differently.
- **New:** upload endpoint + drag-drop, `reference` edge role, asset node card, inline prompt editing.
- **Unaffected:** the hash chain, the worker, the run ledger, the spend cap, the fal adapter, Phase 1's three acceptance tests.

**The open Phase 2 bug does not go away.** Only the first wire of a page session
lands. Approaches A, C and E all lean harder on wiring, so that bug should be
fixed — or proven to be a test-harness artifact — before building on top of it.
Approach B leans on it least.

## Open questions for you

1. Which approach?
2. Project-level assets, or per-flow (i.e. keep or drop the §11 cross-campaign demo)?
3. Prompt editing: inline always, inline on double-click, or leave in the inspector?
4. Fix the wiring bug first, or build the new model and fix it in passing?
