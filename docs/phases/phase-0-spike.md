# Phase 0 — Validation Spike

**Duration:** 3 days. **Code kept:** none. **Reference:** build-plan §2, §12 risks 1–2.

Everything in this project rests on one unproven assumption: that a product stays recognisably itself across generations. If it doesn't, the product changes shape. Find out before writing a schema.

## No tests in this phase

Deliberate. `spike.ts` is throwaway — no repo structure, no Drizzle, no types beyond what the file needs. A test here would be testing fal's output quality, which is what the human scoring pass is for.

The TDD ladder starts in Phase 1.

## Tasks

- [ ] Gather **3 real products**, 4 reference photos each. At least one with fine detail — a labelled bottle, a stitched shoe. Not stock photography; stock flatters the models and you will get a false pass.
- [ ] `spike.ts`: 12 images per product — 4 scenes × 3 seeds, identical refs attached. Nano Banana Pro first, FLUX.2 [pro] as the cheap comparison.
- [ ] Motion test: take a passing image, use it as start frame for Veo 3.1 and Kling 3 Pro at 5 seconds. Does identity survive motion?
- [ ] Record which video models expose **start and end frame** control. This feeds `caps.startEndFrame` in the registry and decides the Phase 3 shortlist.
- [ ] Score every output: same product? label legible? colours right? client-acceptable?
- [ ] Log real dollars spent per model per output.

## Carry-forward artifacts

The spike is thrown away but three things survive into Phase 1:

1. **`FINDINGS.md`** — pass rates, cost per output, winning model per role. Becomes launch content (§11).
2. **Recorded fal responses** — save the raw JSON and the downloaded assets. These become the first `test/fixtures/fal/` entries, so Phase 1's acceptance suite starts with real response shapes instead of invented ones. *This is the highest-value thing to carry out of the spike; do not delete the responses with the script.*
3. **Verified endpoint IDs and prices** — seeds `verifiedOn` in the model registry.

## Gate

| Result | Action |
|---|---|
| **≥70%** | Green light. Proceed to Phase 1 as planned. |
| **40–70%** | Proceed, but reposition around *generate many, review fast* rather than guaranteed consistency. Update `README.md` positioning before Phase 1. |
| **<40%** | **Stop.** Re-test in 3 months. Build the reporting demo instead. |

Write `FINDINGS.md` before deciding. Deciding first and writing after is how a 55% becomes a 70%.
