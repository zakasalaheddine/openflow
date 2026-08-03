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
- [x] Brand profile + brief→flow + 4 templates in `/flows/templates/`, behind an
      `LLM_MODE` seam mirroring `FAL_MODE` (`live` / `replay` / `off`; `off` is
      the default, so a canvas without a second API key degrades rather than
      erroring oddly). The profile is stored on the project and confirmed by a
      person — the model is never asked to write one and save it unseen.
- [x] Launcher (`npm run studio`); Dockerfile secondary. Written as `npx
      openflow-studio`, which the cold-boot test later proved could never work — §4.
- [x] `DEMO=1` mode — live runs disabled, example flows pre-baked as cache hits
- [x] README per the §10 ordering. **No screenshot** — the serum graph shot the
      ordering calls for does not exist yet, and a broken image link is worse
      than a stated gap.

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

**`e2e/brief-to-flow.spec.ts`** — `LLM_MODE=replay` against a recorded response
keyed by prompt, so a prompt change surfaces as a missing fixture rather than a
live call CI would pay for.
- a brief plus a confirmed brand profile produces a valid graph on the canvas
- every generated node is editable afterwards — the LLM's output is a starting point, not a commitment

**`e2e/re-roll.spec.ts`**
- `↻ re-roll` keeps the prompt and changes the seed
- prompt editing changes the hash and marks descendants stale
- the two are visually distinct — confusing them means re-rolling a bad idea forever

**`e2e/demo-mode.spec.ts`** — replaced by `test/acceptance/demo-mode.test.ts`.
Playwright runs one server for the whole suite, so a `DEMO=1` browser spec means
a second build and a second port for an assertion that is stronger at the
acceptance level anyway: the test spies on `fetch` and asserts no call to a host.
- `DEMO=1` serves pre-baked flows and **dispatches nothing**. Assert zero outbound calls: this protects your wallet on a public demo, so it is a real test, not a nicety.

## 4. Ship

- [x] ~~Confirm `npx openflow-studio` boots…~~ **Run, and it fails — see below.** Replaced by
      `npm run studio` from a clone, which boots, builds on first run, creates the DB, opens
      the browser and prompts for a key. CI now boots the launcher and asserts it serves, so
      the clean-checkout case is covered by a test rather than by someone remembering to try it.
- [ ] README: one-line what-it-is → serum graph screenshot with costs → install → **Non-Goals above the fold** → registry table → architecture → contributing
- [x] MIT license
- [x] Repo public

### Cold-boot result

Run properly for the first time: `npm pack`, install the tarball to a temp prefix,
run the binary from a directory outside the repo with a scrubbed environment.
It does not boot. A Next app cannot be **built** from inside `node_modules`, and
`npx` is nothing but a `node_modules` directory.

Shipping a prebuilt `.next` does not rescue it, because Turbopack satisfies native
externals with symlinks — `.next/node_modules/better-sqlite3-<hash> →
../../node_modules/better-sqlite3` — and `npm pack` strips every nested
`node_modules`. Next then prints `✓ Ready` and dies on the first request with
`Cannot find module 'better-sqlite3-90e2652d1716b047'`: the same silent-death
shape `scripts/check-node.mjs` exists to prevent, arriving by another door.
Building on arrival instead fails from the other side — Turbopack treats anything
under `node_modules` as opaque and panics on `InstrumentationEndpoint::entry_module`;
`--webpack` gets as far as handing `src/core/demo.ts` to a parser with its types
still on, because swc-loader is excluded from `node_modules` too.

The same tarball builds and serves correctly one directory *outside* `node_modules`.
The contents are fine; the location is not. Serving from inside it does work once
the two symlinks are put back by hand — `✓ Ready`, worker started, `HTTP 200` —
so the npx path is recoverable, at the price of depending on a Turbopack
implementation detail that carries no compatibility promise.

Three things this also surfaced:

- **`npx openflow-studio` 404s regardless.** The package is `private: true` at
  `0.0.0` and unpublished. The README has been telling people to run a command
  that does not exist.
- **The database lands in the npx cache.** `dataDir()` resolves `./data` against
  cwd and the launcher pins cwd to the package root, so `app.db` and every
  paid-for asset are written inside a content-hashed cache directory and vanish
  with the next version or prune. The user's own directory stays empty. Moot
  under the clone-only resolution below — there `root` *is* the repo, so `./data`
  is exactly right, and `OPENFLOW_DATA_DIR` covers anyone who wants it elsewhere.
  Recorded because it comes back the moment anyone revives the npx path.
- **Nothing tested the entry point.** CI ran `next build && next start` under
  Playwright, which proves the app runs and never touches `bin/openflow-studio.mjs`.
  Now fixed: CI boots the launcher against its own data dir and fails if it does
  not serve.

**Resolution: npx is dropped.** The README installs from a clone, `npm run studio`
replaces `npx openflow-studio`, and `bin`/`files` are gone from `package.json` —
publishing config for a package that cannot be published is an invitation to
repeat this. The npx path is recoverable (a `prepack` build plus a launcher that
recreates the shim symlinks from `require.resolve`), but it would rest on a
Turbopack implementation detail with no compatibility promise: a Next upgrade
could break distribution without breaking a single test. Not worth it for an
install that `git clone` already covers.

## Gate

It's public, CI is green on `main`, and every Phase 1 and Phase 2 test still passes.
