# The sequence holds the film, and export becomes a download

The export node goes away. A sequence cuts its clips and holds the result like
any other render. Getting bytes out of the app stops being a node you wire and
becomes an action you take, and the bytes arrive in your downloads folder
rather than in `./exports`.

## Why

Two problems, one cause.

`sequence` and `export` are two nodes for one job. A sequence dispatches to
nothing, costs nothing and shows nothing — the cut only exists once you wire it
into an export node and press Export, because `assembleSequence` lives inside
`exportFlow` (`src/core/exporter.ts:120`). A node that holds no output on a
canvas whose whole premise is that the card is the picture is a node that lies
about what it is.

And `./exports` is a directory the app writes into and never mentions again.
Every other artifact this tool produces is reachable from the canvas; a
deliverable is reachable only by leaving the app and opening a folder. The
manifest describing what was written is in there too, which is the one place
nobody looks.

## Decisions

Recorded because each closed a real fork.

| Question | Chosen | Rejected |
|---|---|---|
| Where do formats, overlay and spec checks go? | The shape of the Download action | Onto every node; project-settings only; drop them |
| What makes the cut happen? | Run, like any other node | Automatically when clips are fresh; only on download |
| What can you download? | Any card with a render, plus the whole flow | Per card only; flow-wide only |
| Where does `manifest.json` go? | Inside the zip; a single file downloads alone | Always zipped; drop the manifest |
| Existing `export` nodes? | Dropped on read, templates updated | Migration script; keep the type inert |
| A format that fails its check? | Still refused, no override | Warn and allow |
| Where are download bytes produced? | Temp dir, streamed, deleted | Cached in the asset store by hash; streamed with no disk |

The last one is the one most likely to be revisited. Caching derived crops in
the asset store would make a second download of unchanged output a file read,
but `assets` has no notion of a derived file and nothing would ever delete
them. The sequence cut is worth caching because a cut is expensive and every
download of that film reuses it. A crop is neither, so it is re-done. If
someone is waiting on repeated downloads of a twelve-shot campaign, that is the
knob.

## Node vocabulary

`NodeType` returns to four: `source | image | video | sequence`. The comment at
`types.ts:7` — "Scarce by design. Four in v1; a sixth requires a written case" —
becomes true again.

Deleted: `ExportNode` from `types.ts`, its arm of the discriminated union in
`schema.ts:81`, its case in `hashableConfig` (`hashable.ts:54`), its case in
`newNode` (`node-defaults.ts:80`), its entry in the toolbar's `ADD_NODE`, its
card in `node-card.tsx`, its section in `inspector.tsx`.

Kept: `AdFormat`, `FormatSpec`, `TextOverlay`, `TextBox`. They stop being node
fields and become the download request's shape. `resolveFormats` keeps its job
— an explicit list beats the project default — but takes the list itself rather
than a node to read it off.

`fps` and `codec` lose their per-node override and come from project settings
alone (`exporter.ts:343`). They were on the export node because that node was
the only place to put them; nothing in the dialog needs to ask, and a per-render
encoder setting is a preference, not a decision about one deliverable.

`SequenceNode` still carries no configuration. The order stays on
`edge.position`, for the reason its own comment gives: an ordering stored twice
is an ordering that will disagree with itself.

### A sequence is terminal

`sequence → export` was the only outgoing edge a sequence had, so with export
gone nothing may leave one, enforced in `validateWire`.

This closes a hole rather than adding a restriction. Today `sequence → image`
is not refused: `inferRole` returns `reference`, and the graph would hand a
model an mp4 where it expects a still. It was unreachable in practice only
because an export node was the obvious thing to point a sequence at. Removing
export makes it reachable.

## A sequence that runs

`isRunnable` (`executor.ts:64`) grows to include `sequence`. A planned sequence
carries `modelId: 'sequence'`, `endpoint: 'local'`, `estimatedCents: 0`.
Overloading `modelId` this way is not new — `assembleSequence` already stamps
`modelId: 'sequence'` into the manifest at `exporter.ts:188`.

The worker branches once, before `adapter.submit`: a local run performs the
ffmpeg `concat` in-process and completes there, never reaching submit or poll.
It inherits every state the canvas already draws — queued, running, done,
failed — and retry with it.

`$0.00` on the card is not a rounding artifact. The clips were paid for; the cut
is local. A sequence contributes nothing to the spend cap.

Two consequences worth naming, because each is a deletion:

- **`assembleSequence`'s hand-rolled cache goes.** It keys the cut on
  `sequence:<hash>`, checks `existsSync`, and re-cuts in place. `enqueueRun`'s
  hash cache already does that job for every other node. The cut becomes an
  ordinary asset with a real `sourceRunId`, which retires the
  `// No sourceRunId: no single run produced this` comment rather than leaving
  it true.
- **Refusals become run failures.** "clip 3 has no render matching its current
  settings", "this sequence has no clips wired into it", "ffmpeg is not
  installed" stop being `rejected` entries in an export result and become a
  failed run carrying that message, shown on the card, retryable.

The sequence card shows the film the way a video card shows a clip, with
`3 clips · 22s · $0.00` in the footer.

**`nodeHashes` stays.** The obvious-looking deletion here is wrong and is
recorded so nobody has to rediscover it: once a sequence is planned it looks
like `planRun` could supply every hash the download path needs, but `planned` is
built only for runnable nodes, so a `source` wired straight to a download has no
hash in it. `nodeHashes` (`executor.ts:106`) is the only way to ask for the hash
of a node that never dispatches. Its comment needs rewriting, though: the
sequence it describes is no longer the reason it exists.

## Download

Two entry points, one dialog. A card holding a current render gets a download
control in its footer. The toolbar's Export becomes Download and covers the
flow.

### The dialog

- Project formats as tick boxes, with the per-format verdict beside each.
- Headline and CTA fields, which is where `TextOverlay` lives now.
- The flow-wide version adds a list of nodes, also ticked, defaulting to
  everything with a current render.

Everything-with-a-render rather than terminal-nodes-only: a clip that feeds a
film is included, because the manifest's cost dedup exists precisely for
"shipped alone and inside a cut" (`exporter.ts:368`), and because terminal-only
would silently drop a hero still that feeds a clip. The tick boxes are how you
drop what you do not want.

### Preflight

The verdict comes from the server. `checkSpec` needs measured pixels, and
`exporter.ts:287` is explicit that measuring the file rather than trusting the
row is the point — a width column written from a model's promise makes every
check downstream a check of our own optimism.

`POST /api/download` with `preview: true` returns the per-format checks and
writes nothing. This mirrors the shape `/api/sources` already uses for the
blast-radius dialog, so it is a pattern the codebase has rather than a new one.

Keeping it fresh is cheap: `boxOf` returns `DEFAULT_TEXT_BOX` for any non-empty
text, so a verdict only flips when the headline and CTA go empty ↔ non-empty,
not on every keystroke.

A failing format shows its reason and cannot be ticked. If every format fails,
the Download button is disabled rather than producing an empty file. The rule
stays what `PRODUCT.md` says it is: surfacing the reason and shipping the asset
anyway is the same as not checking, and the rejection just arrives later from
the client with the buy already booked.

### Delivery

The same POST without `preview` does the work:

1. `mkdtemp` a directory.
2. `exportFlow` writes into it, unchanged — this is what makes the temp-dir
   approach cheap.
3. Stream the result.
4. `finally`, remove the directory.

One file streams as itself with a `Content-Disposition` filename and its own
mime type. More than one file, or any flow-wide download, streams a zip
containing `manifest.json`. Filenames keep today's rule:
`${slug(label ?? nodeId)}-${slug(format.name)}${suffix}.png|mp4`.

`exportFlow` keeps writing into a `{ dir }`. Its inputs change from "walk the
export nodes in the graph" to an explicit `{ nodeIds, formats, overlay }`.

### The dependency

Node has `zlib` but no zip container. Add `fflate`: zero dependencies, ~30kB,
and PNG/MP4 are already compressed so stored-only entries lose nothing. The
alternative considered and rejected was ~60 lines of hand-written local
headers, central directory and CRC32 — a well-specified format, and still a
binary writer somebody debugs at 3am.

### What goes

`exportsDir()` (`env.ts:59`), `OPENFLOW_EXPORTS_DIR`, the README line
`./exports/ user-facing output`, and the playwright config's `testExportsDir`
and its `rm -rf`.

The `exports` table stays. It is the record of every check, pass or fail, which
is why `exporter.ts:317` writes a row even on failure — a record that only
exists when the check passed cannot distinguish "checked" from "never run". Its
`path` column stops being a filesystem path and becomes the delivered filename.

## Error handling

| Condition | Before | After |
|---|---|---|
| ffmpeg missing | 422 from `/api/export` | 422 from `/api/download`, unchanged message |
| Clip has no current render | `rejected` entry, no file | Failed sequence run on the card, retryable |
| Sequence has no clips wired | `rejected` entry | Failed sequence run on the card |
| Format fails its spec check | No file written, reported | Untickable in the dialog, reason shown |
| Nothing has a current render | Empty export, manifest with no files | Download disabled, with the reason |

## Migration

Loading a graph drops any `export` node and its edges; the next write persists
the graph without them. Nothing downstream of an export node exists — it was
terminal — so nothing else is lost. No migration script and no inert node type.

Three templates lose their export node and keep working: `before-after.json`,
`hero-and-clips.json`, `three-scenes.json`.

`headline-ad.json` is deleted. Its `headline` and `cta` slots existed to fill an
overlay that is no longer graph state, and what remains after removing the
export node is one image node off a prompt — which is the canvas with one click,
not a template. Slots are read from the template JSON rather than named in code,
so deleting the file is the whole change to the agent's vocabulary.

Two code sites go with it. `buildFlowFromBrief` (`core/brief.ts:109`) has a
branch that fills `overlay.headline` and `overlay.cta` on an export node — the
only place slot filling knows about a specific node type — and it is deleted.
`test/unit/brief-to-flow.test.ts` asserts four templates by name and has a test
named "fills headline and CTA, not just scene prompts" built entirely on that
branch; the count becomes three and that test goes.

## Testing

Rewritten, because they construct export nodes:

- `test/acceptance/export.test.ts`
- `test/acceptance/sequence.test.ts` — moves the most; cutting relocates from
  export-time to a worker run
- `test/unit/formats.test.ts`
- `test/unit/manifest.test.ts`
- `test/unit/brief-to-flow.test.ts` — four templates becomes three, and the
  overlay-filling test goes with `headline-ad.json`

New coverage:

- A sequence run: stale until its clips are fresh, cuts on Run, `$0.00` in the
  ledger, an unchanged film re-runs from cache without re-cutting.
- A sequence run fails with a named reason when a clip is stale, and Run retries
  it.
- `sequence → image` is refused by `validateWire`.
- A graph containing an `export` node loads without one.
- e2e: download one frame and assert the filename off Playwright's download
  event; download the flow and assert the zip holds the files and the manifest;
  a format failing its check cannot be ticked.

`e2e/export.spec.ts` and `e2e/spec-validation.spec.ts` get rewritten against the
dialog instead of against `./exports`.

## Out of scope

- Caching derived crops. Named above as the knob if it ever hurts.
- Per-node format overrides as saved state. They were on the export node and are
  now per-download; if "this shot always ships 9:16 only" turns out to matter, it
  is a node field, not a revived node.
- Downloading anything other than current renders. A stale card offers Run, not
  Download.
- Uploading or publishing anywhere. Download means the browser's downloads
  folder.
