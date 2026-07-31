# Phase 2 — Canvas

**Duration:** week 2. **Reference:** build-plan §6, §8 week 2.

The first phase with a browser, so the first phase with Playwright specs. Phase 1's acceptance suite keeps running unchanged — if a canvas change breaks headless execution, CI says so before you notice by hand.

**The governing rule:** React Flow renders a *view* of `graph_json`. The UI never becomes a second source of truth. Every interaction below writes to the schema and re-reads it.

---

## 1. Build

- [ ] React Flow over the existing `graph_json`
- [ ] Four node components with inline output previews; video nodes loop on hover
- [ ] Manual drag-to-wire with `role` inference (`start_frame` / `end_frame` / `input`) and capability gating
- [ ] Inspector panel — prompt, anchor chips, model, seed, duration, per-node cost
- [ ] Anchor rail — create, upload refs, bump version, chip toggle onto the selected node
- [ ] Stale propagation: editing a node greys every descendant, with a priced toolbar count
- [ ] Subtree cost on hover
- [ ] Draft·Hero toggle, graph-level

## 2. TDD units

State logic stays out of components and gets unit tested. Components get covered by Playwright at the behaviour level instead.

**`test/unit/wiring.test.ts`**
- image → video infers `role: 'start_frame'`
- source → image infers `role: 'input'`
- an edge into a model with `caps.startEndFrame === false` is **refused at wiring time**, not accepted and dropped at render time
- a wire that would create a cycle is refused
- `position` stays `null` on every v1 edge

**`test/unit/stale.test.ts`**
- editing a node marks exactly its descendants stale, and nothing upstream
- bumping an anchor version marks every node holding that anchor chip, plus their descendants
- the stale count and its refresh price match what the executor would actually charge — one function, used by both, so the toolbar can never lie

**`test/unit/subtree-cost.test.ts`**
- subtree cost sums the branch, not the graph
- draft and hero totals are computed from registry rows, not hardcoded

## 3. Playwright specs

`FAL_MODE=replay`, fresh `OPENFLOW_DATA_DIR` per file.

**`e2e/serum-graph.spec.ts`** — the gate. Verbatim from the build plan: build the 3-image → 9-video serum graph from an empty canvas, without touching JSON.
- create a project, upload an anchor with reference images
- add 3 image nodes, attach the anchor by chip to all three, write prompts
- wire each image to 3 video nodes
- assert `graph_json` contains 12 nodes and 9 edges with the right roles
- run; assert every node reaches `succeeded`

**`e2e/anchor-chips.spec.ts`**
- toggling an anchor chip on 12 nodes creates **zero** edges — this is the readability guarantee, and a regression here quietly ruins the canvas
- untoggling removes it from that node only

**`e2e/stale-propagation.spec.ts`**
- editing an upstream image greys its descendants and shows `N nodes stale · $X to refresh`
- bumping an anchor version greys every node using it, across flows
- **nothing re-runs until Run is pressed** — silent re-runs at hero prices are the expensive bug

**`e2e/capability-gating.spec.ts`**
- attempting to wire into a model that can't accept a start frame shows a refusal, and no edge appears in `graph_json`

**`e2e/draft-hero.spec.ts`**
- flipping the toggle changes the estimated total and the model each node resolves to, without editing any node

## Gate — NOT MET

`e2e/serum-graph.spec.ts` is marked `test.fixme` and does not pass.

**What works:** everything else. 153 unit tests and 7 browser specs are green —
anchor chips add zero edges, anchor bumps price the blast radius across flows
before committing, prompt edits stale the node and its descendants without
re-running them, the Draft/Hero toggle re-prices without touching the graph,
dragging a node persists and costs nothing, and a second start frame into one
clip is refused.

**What does not:** only the first wire of a page session lands. The second
connection gesture never starts — React Flow draws no connection line and
`onConnect` never fires. Reloading between wires makes all nine succeed, which
places the fault in client state, not in wiring, validation or persistence.

Ruled out so far: edge-layer pointer events and z-index, node identity churn
across polls, a poisoned commit promise chain, an auto-fit loop shifting the
canvas mid-gesture, controlled-vs-uncontrolled node state, and committing
synchronously inside `onConnect`. Re-seeding nodes and edges independently
moved it from "always fails" to "fails on the second wire", so the remaining
cause is very likely still a re-seed racing the gesture.

**Next thing to try:** stop re-seeding from the server entirely after a local
edit — treat the client graph as authoritative between commits and reconcile
only on load or when another surface changes the flow.

The human check the spec can't make: build that graph yourself once and confirm it's actually pleasant. If wiring nine video nodes is tedious, alt-drag fan-out (Phase 3) is the fix — note it and move on, don't redesign here.
