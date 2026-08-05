# Adding assets in the editor

**Status:** built. Two things changed on contact with the code; §3.3 and §3.2
record what and why.

## 1. Goal

Put an asset on the canvas without dragging a file onto it.

Today there is exactly one way in, and `docs/specs/2026-07-31-assets-in-canvas.md`
§5.1 is honest that this was the whole design: drop a file on empty canvas, or
drop it on a generator to upload *and* wire in one gesture. Both are good
gestures. Neither is discoverable, and one of them is the only route to a
feature nobody will ever find.

Two holes, in order of how much they cost:

**A text source can only be made by dragging selected text from another
application.** `handleDrop` (`canvas.tsx:412`) reads `text/plain` off the
transfer and calls `createTextSource`. There is no button, no menu, no field —
brand voice, the thing §4 of the approved design says composes ahead of every
prompt on the graph, is reachable only by a gesture that is never mentioned on
screen.

**An uploaded asset that is not currently on the canvas is unreachable.**
Sources are project-level on purpose — §11 of the build plan names cross-campaign
staleness as the hardest thing in the product to copy, and that needs one
product row referenced by many flows. But `deleteSource` aside, deleting a
source *node* leaves the row behind with no way to place it again, and a second
flow cannot reference the product the first one uploaded. The indirection is
paid for and not yet spent.

## 2. What is already in place

Almost all of it. This is a wiring job, not a subsystem.

| Piece | Where | Note |
|---|---|---|
| `addSourceNode(sourceId, position, wireTo?)` | `canvas.tsx:381` | Creates the node and optionally wires it. Both new entry points end here. |
| `uploadFile(file)` | `state.ts:56` | `POST /api/sources` multipart, returns `{ id, kind }`. |
| Hidden file input + ref | `canvas.tsx`, `replaceInputRef` | The Replace button already does exactly this dance. Copy the pattern, do not invent one. |
| `freeSlot(nodes)` | `slots.ts` | Where a new card goes. Added last week for `+ image`; nothing new needed. |
| **The full source list, client-side** | `state.sources`, already in `FlowState` | `sourcesById` is built from it every render. **The picker needs no new endpoint and no new fetch.** |
| Mime allow-list | `upload.ts:6` | Drives the `accept` attribute for free. |

`GET /api/sources` exists and is already polled as part of `fetchFlow`. Nothing
in this plan adds a route, a table, a column, or a node type.

## 3. Design

### 3.1 `+ asset` in the toolbar

A fourth chip beside `+ image` `+ video` `+ export`, in the same `map`, with the
same `data-testid` shape (`add-asset`). It opens a file dialog.

```
accept=".png,.jpg,.jpeg,.webp,.mp4,.webm,.mov,.txt"   // from ALLOWED_MIME
multiple                                               // handleDrop already loops
```

On choose: `uploadFile` per file, then `addSourceNode(id, freeSlot(...))` per
result — the same two calls `handleDrop` makes, minus the drop point. Errors go
to `setNotice`, as they already do for a failed drop.

The `accept` list is a courtesy, not a check. The server refuses anything
outside `ALLOWED_MIME` at the boundary and keeps doing so; a file dialog filter
is a hint the user can override on every platform.

### 3.2 Placing an asset that already exists

The same chip, held open a beat longer: `+ asset` opens a small menu rather than
going straight to the file dialog.

```
┌──────────────────────────────┐
│  Upload a file…              │
│  Write a note…               │
├──────────────────────────────┤
│  ▣ bottle-front.jpg      v2  │
│  ▣ pack-shot.jpg         v1  │
│  ¶ warm, unfussy, no ha…     │
└──────────────────────────────┘
```

Rendered from `state.sources`, which is already in memory. Choosing a row calls
`addSourceNode(sourceId, freeSlot(...))` and nothing else — no upload, no new
row, no version bump.

**A second node for the same source is allowed.** Hashing is keyed on
`sourceId` + `version` (§3 of the approved design), so two nodes referencing one
product are two references to the same bytes and stale together. A twelve-shot
graph where the product feeds shots in two distant corners should not force a
wire across the whole canvas.

Text rows show their first line, truncated.

**Changed on contact:** image and video rows were to show "the filename tail of
the store key". They cannot. The store key is a generated UUID — `storeUpload`
deliberately never touches the uploaded filename, because a path built from an
attacker-controlled name escapes the store root — so the tail reads
`…a1b-b689-f38bef02fd92.jpg` and two product shots are indistinguishable. The
label was the one job the row had.

The uploaded name is now recorded on `sources.notes`, a column that already
existed on the schema and that `createSource` already accepted, and which
nothing had ever written or read. Control characters stripped, 80 characters
capped, and it stays a column nothing resolves, opens or joins on — the stored
path is still a UUID. Assets uploaded before this fall back to the key and read
as gibberish; they remain pickable, and one Replace gives them a name.

Still no thumbnail grid: that is a rail by another name, and §1 of the original
design says no rail.

### 3.3 Writing a note

**Changed on contact:** the note is written *in the menu*, not on the canvas.

The plan called for an empty text source placed on the canvas immediately and
edited in place, with the row created on first commit. That needs a pending node
state, a new edit mode in `node-card.tsx`, and cleanup for a note abandoned with
Escape — all so that an empty note can briefly exist somewhere the database
refuses to hold it (`POST /api/sources` rejects empty `text` with *"That note is
empty."*).

A textarea in the menu removes every one of those. Commit creates the row and
the node together, fully formed; an empty note sends nothing and leaves nothing
to tidy up. ⌘↵ commits and Escape cancels, matching `EditablePrompt`. No
`node-card.tsx` change at all.

## 4. What changes

| File | Change |
|---|---|
| `src/app/asset-menu.tsx` *(new)* | The chip, the menu, the hidden file input, the note field. Takes `sources`, emits `onUpload` / `onNote` / `onPick`. |
| `src/app/canvas.tsx` | Mounts it; `addAssets(files)`, `addNote(text)` and `addExistingSource(id)`, all landing on `addSourceNode`. |
| `src/app/globals.css` | Menu styling, in the existing chip/panel vocabulary. |
| `src/app/api/sources/route.ts` | Records the uploaded filename on `sources.notes` — see §3.2. |
| `src/app/node-card.tsx` | Unchanged, because the note is written in the menu. |

No schema change. No new dependency. One API change, and it writes a column
that already existed.

**Placement.** Each upload is placed against the graph *as it stands*, and waits
on `queueRef` before the next: `commit` is queued, so two files chosen at once
would otherwise both read the same node list and both take the same free slot —
the exact duplicate-slot bug fixed in `e2dc570`, reintroduced through a
different door.

**Outside-click is a capture-phase listener.** React Flow stops propagation on
the pane, so a bubbling `mousedown` never hears a click on the canvas and the
menu stays open behind it.

## 5. Testing

**`e2e/add-asset.spec.ts`** — 7 specs, all passing.

- `+ asset` → choose a file → a source node appears and `GET /api/sources` has one more row, carrying the uploaded name. Playwright drives the hidden input with `setInputFiles`.
- Choosing two files at once yields two nodes on two distinct slots.
- A note is written and committed without leaving the canvas; the row is `kind: 'text'`.
- An all-whitespace note creates no row and no node.
- An existing asset picked from the menu adds a node and **no** new row — including after its original node was deleted, which is the case that was unreachable before.
- The same asset picked twice yields two nodes referencing one `sourceId`, with the row count still 1.
- The menu closes on Escape and on a click on the canvas pane.

**`test/unit/`** — nothing new. `labelFor` is the only pure logic added and it is
three lines of string handling exercised by the specs above; `freeSlot` is
already covered by `slots.test.ts`.

**Not covered:** a file chosen past the `accept` filter. The server refuses it
(`upload.ts:41`) and `upload.test.ts` covers that refusal, but no spec asserts
the message reaches the canvas. Worth adding when someone next touches this.

**`test/unit/`** — nothing. There is no new pure logic; `freeSlot` is already
tested and the upload boundary already has `upload.test.ts`. A unit test here
would be testing React, which the e2e suite does better.

## 6. Out of scope

- **Clipboard paste** (⌘V for an image or text). Same seam — one `paste` listener calling the same two functions — and worth doing next, but it is a third entry point and this change is about the two that are missing outright.
- **A thumbnail grid or asset browser.** That is the rail the original design deliberately refused.
- **Deleting a source row from the canvas.** `DELETE /api/sources` exists and nothing calls it; deleting the *node* deliberately leaves the row. Related hole, different change.
- **Reordering, tagging, or naming assets.** No evidence anyone needs it yet.

## 7. The open question, settled

`popover` gives light dismiss, Escape and the top layer for nothing. It does not
give positioning: an element in the top layer is positioned against the viewport,
so anchoring it under a toolbar chip means either CSS anchor positioning —
Chrome-only today, and this project ships to whatever the user has — or
measuring the chip in JS on every open and resize.

That is more code than the two listeners it saves, so the menu is a plain
absolutely-positioned dropdown inside a `position: relative` wrapper, with
Escape and capture-phase outside-click handled by hand. `<dialog>` stays the
pattern for the lightbox, which genuinely is modal. Revisit when anchor
positioning is broadly available.
