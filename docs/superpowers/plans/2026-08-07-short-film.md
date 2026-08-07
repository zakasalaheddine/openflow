# A one-minute short, with a character who stays the same person

Status: **phases 1 and 2 built** (A2, then B1). Phase 0 — the spike — has not been
run; it is still the thing that decides whether the rest is worth having, and
nothing below has been proved against a real face or a real clip.

What you described: a ~60-second piece made of several clips; each clip planned
through several candidate keyframe images; one character who has to be
recognisably the same person in every frame; a character sheet built first and
used as the reference for everything downstream.

This document says what the app does today against that, what is missing, and
the choices each missing piece forces — with the trade-offs, and a
recommendation for each.

---

## 0. Read this before the rest: the plan may not be worth building

**No video model in this app has ever returned a file.** All three video rows
carry `verifiedOn: null`, and the registry's own comment records that two
endpoint slugs were wrong when they were last checked (`fal-ai/flux-2/pro` and
`fal-ai/minimax/hailuo-02-3/pro/image-to-video` both answered `Path … not
found`). Your entire request is 6–12 video clips.

And `build-plan.md:45`, written before any of this existed, says the whole
project "rests on anchor consistency holding" — a spike that was designed for
*products* (a labelled bottle, a stitched shoe) and was never run for a *face*.
A face is the harder case. Nobody has run it here.

So the first phase is not a feature. It is a spike, and it costs a few dollars:

1. Generate a small character sheet — one person, 4–6 angles/expressions — with
   `flux-2-pro` (4 refs) or `nano-banana-pro` (6 refs).
2. Feed the sheet back in as references and generate two keyframes of that
   person in different scenes. **Is it the same person?**
3. Take one keyframe as a start frame and render 5 seconds, live, on
   `hailuo-2-3-pro` **and** `kling-3-pro`. **Does the face survive motion?**

Three outcomes, and each one rewrites what follows:

| Result | What it means for this plan |
|---|---|
| Identity holds through stills **and** motion | Build as written below. |
| Holds in stills, drifts across a clip | Gap **C** (end frames) stops being optional, and the video shortlist collapses to `kling-3-pro` — the only row exposing start **and** end frame. Clips get shorter (3–4s) and there are more of them. |
| Does not hold in stills | Stop. The premise fails, and no amount of node plumbing fixes it. Re-aim at "generate many, review fast" — which `build-plan.md:57` already names as the fallback posture. |

Step 2 of that spike is not possible today without a manual download-and-reupload.
That is gap **A**, and it is the one thing that must be built either way.

---

## 1. What already works, unchanged

Real, tested, and directly useful here:

- **Several keyframes per shot.** Add image nodes freely; alt-click a shot to
  spawn a pre-wired sibling carrying the previous prompt. Each names its own
  model, so three candidates for one scene can run on three models and be
  compared at their own prices.
- **One still into a clip as frame zero.** `image → video` is a `start_frame`
  edge, capped at exactly one, refused at wiring time rather than dropped at
  render time. The `hero-and-clips` template is already this shape.
- **Text fragments as shared direction.** A text source wired into a shot is
  prepended to its prompt by `composePrompt`, in edge order, deterministically.
  A character's written description ("35, close-cropped dark hair, faint scar
  through the left eyebrow…") is a text source wired into every shot, today,
  with no new code. Edit it and every shot using it goes stale.
- **Staleness that chains.** `planRun` folds `upstreamHashes` in for *every*
  edge regardless of role, so re-rendering a parent invalidates its whole
  subtree automatically.
- **Scheduling that waits.** `waitingOnUpstream` holds a child until every
  parent has finished — explicitly including reference edges.
- **Video normalised on arrival.** Every clip is re-encoded to the project's fps
  and codec as it lands. This is what makes assembling clips a cut rather than a
  re-encode, and it is already done.
- **Per-node cost, and a spend cap** that refuses a run above it pending
  confirmation.
- **Workspaces.** One workspace per film, or per cut of a film.

---

## 2. What is missing

Seven gaps, in the order they block you.

### A. A generated image cannot be used as a reference — the blocker

This is the character sheet gap, and everything else waits behind it.

Only `source` nodes become references. `inferRole` maps `source → image|video`
to `'reference'`; an `image → image` edge is given `'input'`, and `'input'` is
read by nothing — `referencedSources` filters to `n.type === 'source'`, so the
file never reaches the model. The wire draws, the hash chains, the child waits
for the parent, and the reference is silently absent from the payload.

The workaround that exists today: download the render, re-upload it as a source,
wire that. It works, and it costs you the live link — re-roll the sheet and
nothing downstream knows.

### B. There is no way to assemble clips into one film

`exportFlow` writes one file per (upstream node × format). Twelve clips out is
twelve files, not a 60-second cut. There is no ordering: `Edge.position` exists
on every edge and is `null` everywhere, commented "reserved for v2 sequence
ordering".

This is already designed. `build-plan.md:375` reserves the fifth node type for
`sequence` **by name**, and lists the groundwork as already laid: normalise on
write, `duration_ms`/`fps`/`codec` on assets, `position` on edges. The
"Non-Goals" rule that a fifth node type needs a written case is satisfied in
advance for this one type and no other.

### C. End-frame anchoring is unreachable

`end_frame` is a real role in `types.ts` and `schema.ts`, `buildInput` resolves
it, and `buildModelInput` sends it as `end_image_url`. Nothing can ever create
one: `applyWire → validateWire → inferRole` is the only path that makes an edge,
and `inferRole` returns only `reference`, `start_frame` and `input`. Neither the
canvas nor the agent passes a role.

So `kling-3-pro` — the row that exists *specifically* because it exposes start
**and** end frame — cannot do the thing it was added for. If the spike finds
drift across a clip, this becomes urgent rather than tidy.

### D. Nothing organises a graph this size

A 12-shot film with 3 keyframe candidates each is 12 + 36 + a sheet + sources ≈
55 cards on one flat canvas. `freeSlot` lays them out in a 4-wide grid and pans;
there is no scene, no group, no collapse, no ordering visible on screen.
Workable, ugly, and it gets worse every time you add a shot.

### E. There is no audio

Only `video.audio → generate_audio`, and only on `veo-3-1` (the one row with
`nativeAudio`). No voice-over, no music bed, no mix, no `audio` model format at
all. **You did not ask for sound, and a silent 60-second cut is a complete
deliverable** — this is listed for honesty, not for scope.

### F. A "character" is not a thing the app knows about

It would be a bundle: N reference images plus a written description, versioned
together, wired in as one unit. Today it is a handful of separate source rows
and a text note that you must remember to wire into all 48 downstream nodes
individually, one edge at a time.

### G. Nothing tracks a target runtime

Clips cap at 8–10s per model. Nothing sums a film's duration, tells you that
eleven 5-second clips is 55 seconds, or warns that you are five short. The only
duration check anywhere is `FormatSpec.maxDurationSec`, applied per file at
export.

---

## 3. The decisions, with approaches

### Decision A — how a generated image becomes a reference

**A1. Promote to asset.** A button on a rendered card (and an agent tool) that
copies its output into the `sources` table as a new row, then wires that.

- *Pro:* No change to wiring, roles, hashing, or the payload builder. Reuses the
  upload path that already exists. Possible in an afternoon.
- *Pro:* The sheet becomes a proper library asset — versioned, replaceable,
  visible in the asset menu, usable from any workspace.
- *Con:* A snapshot, not a link. Re-roll the sheet and every shot keeps the old
  face until you promote again and re-wire by hand.
- *Con:* Duplicates the file on disk and breaks provenance — the manifest records
  a source id, and nothing says which run produced it.
- *Con:* A manual step in the middle of the loop you will repeat most often.

**A2. Teach references to resolve a rendered parent.** `image → image` (and
`image → video` on a model with `refImages > 0`) infers `'reference'`, and the
reference resolver returns the parent's latest succeeded output.

- *Pro:* Three call sites, not an architecture: `inferRole` (returns `'input'`
  today), `referencedSources` (filters to `type === 'source'`), and
  `endpointFor(model, … referenceFiles(...).length > 0)` — that last one decides
  plain-vs-`/edit` endpoint, and getting it wrong means a full-price render that
  silently ignored the sheet.
- *Pro:* Everything else is already built. `upstreamHashes` chains through every
  edge, so re-rolling the sheet greys out all 48 downstream shots for free.
  `waitingOnUpstream` already blocks a child on a reference parent. The worker's
  `frameFor` already knows how to find a parent's newest succeeded output — the
  same helper, aimed at a second role.
- *Pro:* The blast-radius dialog and cost preview keep working, because they read
  the hash chain.
- *Con:* Ambiguity at the wire. `image → video` currently means "frame zero", and
  under A2 it could mean "reference" on a video model that accepts both. Needs a
  rule (frame zero wins; reference needs an explicit second handle) or it becomes
  the "silently wrong" class of bug this codebase works hardest to avoid.
- *Con:* A reference that is itself unrendered is a new failure mode. `buildInput`
  must refuse — the same refusal `frameFor` already makes — rather than dispatch
  a full-price render with no sheet attached.
- *Con:* Capability counting gets subtler: `assertAnchorsSupported` counts
  reference edges, and a 6-image sheet fed as 6 separate parents exceeds
  `flux-2-pro`'s 4.

**A3. A `character` node type.** A fifth type holding a set of images plus a
descriptor; one wire out of it delivers all of them.

- *Pro:* Solves A and F together, and solves the 6-refs-into-a-4-ref-model
  problem by making the bundle pick which images to send.
- *Pro:* One wire per shot instead of five.
- *Con:* Takes the fifth node slot that `build-plan.md` has already promised to
  `sequence` — and unlike `sequence`, no written case exists for it.
- *Con:* Largest surface: schema, canvas card, agent tools, hashing, wiring gate,
  payload builder, the picker.

**Recommendation: A2, then F on top of it later.** A2's cost is genuinely three
functions, and it buys the live re-roll link that A1 permanently gives up. A1 is
already available by hand today, so it stays as the escape hatch rather than the
plan. Resolve the ambiguity by making `image → video` continue to mean frame
zero, always.

### Decision B — assembling the film

**B1. A `sequence` node.** Fifth type. Ordered inputs via `Edge.position`,
concatenated by ffmpeg, feeding an export node.

- *Pro:* Designed and reserved. The groundwork is done and was done *for this*.
- *Pro:* `Edge.position` becomes real, which is the only place ordering can live —
  every other node treats its inputs as a set.
- *Pro:* Because clips are normalised on arrival, this is ffmpeg's concat demuxer:
  a cut, no re-encode, no generation loss.
- *Pro:* One node to hang runtime totals (gap G) and later an audio bed (gap E)
  off.
- *Con:* A fifth node type, new card, new inspector, new agent tool, new hashable
  config.
- *Con:* Ordering needs a UI. Dragging edges into an order is fiddly; a numbered
  list in the inspector is plainer and less pretty.
- *Con:* Not free: the concat still writes a 60-second file and the export step
  then re-renders it per format.

**B2. Teach the export node to concatenate.** When an export node has more than
one input and they are all video, order them and emit one file.

- *Pro:* No fifth node type.
- *Pro:* Reuses the export node's format/overlay/spec machinery directly.
- *Con:* Changes what an existing node means. Today, three clips into one export
  is three deliverables — the ad case, which is the case this app was built for.
  Silently turning that into one file breaks it; adding a mode flag makes the
  export node two nodes wearing one hat.
- *Con:* Export currently has no notion of order and no reason to grow one.
- *Con:* Fights the codebase's own written plan, so every future reader has to
  re-derive why.

**B3. Export the clips and assemble outside.** Resolve, Premiere, ffmpeg by hand.

- *Pro:* Zero code. Available today. A real editor is better at editing than
  anything built here in a month.
- *Con:* The manifest stops describing the deliverable — provenance and total cost
  cover twelve clips, not the film.
- *Con:* Every re-roll of one shot is a manual re-import.

**Recommendation: B1.** B2 looks conservative and is not — it overloads the one
node whose meaning the ad use-case depends on. B3 is the honest interim answer
while B1 is unbuilt, and worth saying out loud: you can make your first
60-second cut with B3 the day the spike passes.

### Decision C — reaching end frames

**C1. A second target handle on the video card**, labelled, wired explicitly;
`applyWire` takes the role instead of only inferring it.

- *Pro:* Visible and unambiguous — you can see which frame is which on the card.
- *Pro:* Also gives A2 its escape hatch: an explicit "reference" handle removes
  the `image → video` ambiguity entirely.
- *Con:* `inferRole` stops being the single source of truth; every caller
  (canvas, agent tool, template loader) has to be able to pass a role.
- *Con:* Two handles on a small card, and the video card is already dense.

**C2. Modifier-drag** (alt-drag makes it an end frame).

- *Pro:* No new handle, no signature change beyond an option.
- *Con:* Invisible. Nothing on screen says the modifier exists, and alt-drag is
  already taken on shot cards for fan-out.

**C3. A field on the video node** (`endFrameNodeId`) instead of an edge.

- *Pro:* No role plumbing.
- *Con:* Two ways to express one relationship. The graph stops being the whole
  truth, `removeNode` no longer cleans up after itself, and the hash chain misses
  it — which is the expensive kind of wrong.

**Recommendation: C1**, and only if the spike shows drift. If identity survives
motion on start frames alone, this stays a known dead branch and costs nothing.

### Decision D — organising 55 cards

**D1. Nothing.** Pan, zoom, `freeSlot`, and labels.

- *Pro:* Free. Might genuinely be enough — you will find out on the first real
  film, not before.
- *Con:* Gets worse monotonically.

**D2. A `scene` label on nodes**, with the canvas drawing a labelled box around
each group and offering collapse.

- *Pro:* Pure view state — never hashed, never touches cost or execution.
- *Pro:* Gives the agent a vocabulary ("add a third keyframe to scene 4").
- *Con:* Real canvas work: group bounds, collapse, drag-a-group, and the
  interaction with `freeSlot` and the existing framing rules, which have their
  own hard-won bugs recorded in comments.

**D3. One workspace per scene**, plus a film workspace that assembles them.

- *Pro:* Uses what was just built, and each scene stays small.
- *Con:* The `sequence` node would need inputs from other workspaces. Nothing
  crosses a workspace boundary today, and adding that undoes the isolation the
  whole feature is for.

**Recommendation: D1 first, D2 when it actually hurts.** Build one film, count
how bad it is. D3 is a trap.

### Decision E — audio (not required for your ask)

**E1. Silent cut.** Ship it, add a music bed in any editor.
**E2. Audio sources + a track on the `sequence` node**, mixed by ffmpeg at export.
**E3. A `'audio'` model format** with TTS/music rows in the registry, so VO is
generated and priced like everything else.

- E1 is free and is the right answer for now. E2 is small once B1 exists — one
  more input role on a node that already runs ffmpeg. E3 is a proper new medium:
  registry format, capability gating, cost unit, its own node.

**Recommendation: E1 now**, E2 the moment you want a music bed, E3 only if
voice-over becomes central.

### Decision F — making "character" first-class

**F1. A convention, not a feature.** A text source with the description plus N
image sources, wired in per shot.

- *Pro:* Works today. Zero code.
- *Con:* Six wires per shot × 48 shots, drawn by hand, and every one of them a
  chance to forget.

**F2. A character bundle in the project** — a row like `sources`, holding a
descriptor plus ordered images, versioned as a unit, delivered by one wire and
trimmed automatically to the target model's `refImages`.

- *Pro:* One wire per shot. Bumping the character's version greys out the film,
  which is exactly the blast-radius behaviour already built for products.
- *Pro:* Solves the 6-refs-into-`flux-2-pro`'s-4 problem in one place with one
  rule, instead of silently at 48 wiring sites.
- *Con:* New table, new library UI, new agent tools, and a second thing that
  looks like a source but is not.

**Recommendation: F1 for the first film, F2 once you have felt the wiring.**
F2 designed before that is F2 designed against a guess.

---

## 4. Suggested order

| Phase | What | Why here |
|---|---|---|
| **0** | The spike: sheet → keyframes → one live clip on two models | Decides whether phases 1–5 are worth building. Costs a few dollars. |
| **1** | **A2** — a rendered image works as a reference | The blocker. Phase 0 step 2 needs it too, by hand until it exists. |
| **2** | **B1** — the `sequence` node, ordered inputs, ffmpeg concat | Turns clips into a film. First point at which you have the actual deliverable. |
| **3** | **C1** — explicit roles, end frames reachable | Only if phase 0 showed drift. Otherwise skip. |
| **4** | **G** — runtime totals on the sequence node | Cheap once B1 exists; the node already knows every clip's duration. |
| **5** | **D2 / F2 / E2** | Only when the first real film has shown which one hurts most. |

Phases 1 and 2 are independent and could be built in either order — but a film
assembled from clips of a character who changes face between shots is not worth
assembling, so A2 first.

---

## 5. What a 60-second film costs to render

At `ESTIMATE_PIXELS` (1024×1024 ≈ 1.05 MP) and the current catalog, one complete
pass — no re-rolls:

| Part | Count | Model | Cost |
|---|---|---|---|
| Character sheet | 6 stills | `flux-2-pro` @ 3¢/MP | ~$0.20 |
| Keyframe candidates | 36 stills | `flux-2-pro` | ~$1.13 |
| Clips | 12 × 5s | `hailuo-2-3-pro` @ 10¢/s | $6.00 |
| — same, alternative | 12 × 5s | `kling-3-pro` @ 19¢/s | $11.40 |
| — same, alternative | 12 × 5s | `veo-3-1` @ 40¢/s | $24.00 |

So **$7–$25 for one clean pass**, and realistically two to three times that with
re-rolls. The default spend cap is $50 per run, which a single full-film Run on
`veo-3-1` fits under — but only just, and a re-roll of every clip would not.
Worth raising deliberately rather than discovering at the confirmation dialog.

Note the estimate is per *node*, and a re-roll only re-bills the nodes whose hash
changed — so iterating on one shot costs that shot, not the film.

---

## 6. Explicitly out of scope

Transitions and cross-fades; per-clip trimming or speed; subtitles; music and
voice-over (E, unless you say otherwise); shot-list import from a script;
anything multi-user. None of these block a 60-second silent cut with a
consistent character.

---

## Confirm before implementation

Three things to decide:

1. **Run the spike first?** Strongly recommended — a few dollars against a build
   whose premise is unverified.
2. **A2 over A1** for the character sheet — a live link at the cost of three
   functions, versus a snapshot available today.
3. **B1 over B3** — build the `sequence` node, or assemble outside the app until
   it exists.

Say which, and whether the phase order holds. Nothing is implemented yet.
