# Phase 3 — Video, Export, Ship

**Duration:** week 3. **Reference:** build-plan §8 week 3, §10.

The repo goes public at the end of this phase, finished or not.

**Cost warning:** this is the first phase where a careless test run is expensive. Everything here runs on fixtures. A test suite that reaches live fal is a bug — `FAL_MODE=off` in the units, `replay` in acceptance and e2e, and CI fails if it sees `live`.

---

## 1. Build

- [x] Video node + 3 video registry rows from the Phase 0 findings
- [x] Start/end frame wiring, gated on `caps.startEndFrame`
- [x] Alt-drag fan-out — spawns a pre-wired sibling video node pre-filled with the previous sibling's prompt. **Alt-click, not alt-drag:** a synthetic alt-drag from a node body is indistinguishable from a pan, so the drag version could not be tested honestly.
- [x] Export node; configurable formats; custom format creation
- [x] **Spec validation** — safe zones, min resolution, duration limits, text coverage. Text this project places is checked as a declared box; text an image model burned into its own output is invisible here and is not claimed to be checked.
- [x] `manifest.json` on export
- [x] brief→flow validation + 4 templates in `/flows/templates/`. **No UI entry point and no brand-profile generation** — both need an LLM provider seam (an `LLM_MODE` mirroring `FAL_MODE`), which this phase did not build.
- [ ] `npx openflow-studio` launcher; Dockerfile secondary
- [ ] `DEMO=1` mode — live runs disabled, example flows pre-baked as cache hits
- [ ] README per the §10 ordering

**Normalisation covers fps and codec, not dimensions.** There is no project-level
canvas size to normalise to, and cropping on the way in would throw away framing
the export step needs — geometry is a per-format decision, made once, at export.

## 2. TDD units

**`test/unit/normalise.test.ts`**
- a clip returned at a different fps/codec/dimension is transcoded to project settings **at the storage boundary**
- `assets.duration_ms`, `fps`, `codec` are populated from the probe, not assumed
- an already-conforming clip is not re-encoded

**`test/unit/spec-validation.test.ts`** — the highest-value unit suite in the phase; each case is a client rejection you're preventing.
- text inside the safe zone passes; text overlapping it fails, and the failure names the zone
- below minimum resolution fails
- duration outside the format's limit fails
- text coverage over threshold fails
- a passing export records `spec_check` on the row either way — the record exists on pass and fail

**`test/unit/formats.test.ts`**
- a user-created custom format persists and is selectable per export node
- a per-node format override beats the project default
- non-integer scaling picks a deterministic rounding, so the same input never yields two sizes

**`test/unit/brief-to-flow.test.ts`** — LLM output is untrusted input; validate it like any other.
- the LLM's response is parsed into `{ templateId, filled prompts }`
- an **unknown `templateId` is rejected** — the LLM picks and fills a template, it never invents topology
- a missing prompt field fails loudly rather than rendering an empty prompt at hero prices
- the brand profile text, not the raw assets, is what gets sent

**`test/unit/manifest.test.ts`**
- every exported file has an entry: source node, prompt, model, seed, anchor versions, cost, timestamp
- costs in the manifest sum to the `node_runs` total — provenance that disagrees with the ledger is worse than none

## 3. Playwright specs

**`e2e/video-wiring.spec.ts`**
- image → video with `role: 'start_frame'`; the clip renders from that frame
- alt-drag from an image spawns a pre-wired sibling **pre-filled with the previous sibling's prompt**
- a model without start-frame support is refused at wiring time

**`e2e/export.spec.ts`**
- export to 9:16 and 1:1 writes files to `./exports/`
- a custom format created in settings appears and exports at its dimensions
- `manifest.json` is written and matches the exported files

**`e2e/spec-validation.spec.ts`**
- an export that violates a safe zone surfaces the failure in the UI with the reason, and does not silently ship

**`e2e/brief-to-flow.spec.ts`** — *not written.* There is nothing to drive it
until a provider seam exists; the validation it would exercise is covered by
`test/unit/brief-to-flow.test.ts` against canned responses.
- a brief plus a confirmed brand profile produces a valid graph on the canvas
- every generated node is editable afterwards — the LLM's output is a starting point, not a commitment

**`e2e/re-roll.spec.ts`**
- `↻ re-roll` keeps the prompt and changes the seed
- prompt editing changes the hash and marks descendants stale
- the two are visually distinct — confusing them means re-rolling a bad idea forever

**`e2e/demo-mode.spec.ts`** — *not written; `DEMO=1` is not built.*
- `DEMO=1` serves pre-baked flows and **dispatches nothing**. Assert zero outbound calls: this protects your wallet on a public demo, so it is a real test, not a nicety.

## 4. Ship

- [ ] Confirm `npx openflow-studio` boots, creates the DB, opens the browser, prompts for a fal key — on a machine that has never run it
- [ ] README: one-line what-it-is → serum graph screenshot with costs → install → **Non-Goals above the fold** → registry table → architecture → contributing
- [ ] MIT license
- [ ] Repo public

## Gate

It's public, CI is green on `main`, and every Phase 1 and Phase 2 test still passes.
