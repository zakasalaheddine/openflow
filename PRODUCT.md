# Product

Written from `README.md`, `DESIGN.md` and the phase docs rather than from an
interview: every answer below is already stated somewhere in this repository.
Where it is not, the line says so.

## Register

product

Design serves the work. The canvas is where someone judges a shoot, and the
tool's job is to disappear into it. Nothing here is a marketing surface.

## Users

A person directing ad creative who is paying for every render out of their own
fal key, on their own machine. Usually one person, not a team: there are no
accounts, no cloud and no credit packs, and the SQLite file, the generated
assets and the key all stay local.

Their context is a working session, not a demo. They have a product photo, a
character sheet or a reference clip, and they are trying to get twelve shots out
of it that look like they belong to the same campaign. They are looking at
frames side by side and deciding which ones to pay to re-render.

The job to be done: **direct a set of shots that stay on-brand, and know what
each one costs before committing to it.** Replace the product and every shot
built on it goes stale, priced, before anything re-renders.

## Product Purpose

A local-first, open-source node editor for on-brand ad creative. Four node types:
`source`, `image`, `video`, `sequence`. A sequence cuts clips into one film.
Wire an asset into as many shots as you like, each with its own direction and
its own model, and read the bill on the card before you press Run. Getting a
render out, cropped to the placements you need, is a separate action from
paying for it, and free every time you ask.

Success is that the canvas answers a comparison: three shots off one source
differing only by their model, judged at a glance, with both prices on screen.
Failure is a tool that surprises someone with an invoice, or one where reviewing
twelve shots means clicking through twelve cards.

Per-node cost tracking is the headline feature, not a footnote. There is no
markup — you pay fal what fal charges.

## Brand Personality

**A darkroom, not an IDE.** Quiet, exact, honest about money.

Voice is a call sheet: short, declarative, no exclamation. Labels name the thing
in the vocabulary of a shoot — slate, frame, direction, bill, cut, re-roll —
because that is the work being done, and a borrowed vocabulary would make the
canvas read as a generic graph editor.

Three words: **calm, exact, unsurprising.**

The emotional goal is confidence before spend. The one moment the interface
raises its voice is amber, and amber means exactly one thing: this will be
billed.

## Anti-references

- **ComfyUI, and general AI workflow engines.** Not the goal. A fifth node type
  needs a written case that the existing four cannot express it.
- **Credit-pack SaaS dashboards.** No accounts, no cloud, no hidden markup, no
  "upgrade to render".
- **Anything that hides cost behind a hover, a dim, an abbreviation or a click.**
  The price is on the card at all times.
- **An agent in the execution path.** The chat agent authors the graph; it has
  no way to spend money. Run is a button a person presses after reading a price.
- Plus every ban in `DESIGN.md`: amber for anything but money, gradient text,
  glassmorphism, side-stripe borders, identical card grids, modal as a first
  thought, display faces in data.

## Strategic design principles

1. **The card is the picture.** Paperwork rides over the frame; it never takes
   rows away from it and never buries it.
2. **The price is never dimmed, hidden, abbreviated or behind a hover.**
   Everything else on the card can lose room first.
3. **Nothing is reachable only by hover.** Hover has no touch equivalent and no
   keyboard equivalent. Hover may enlarge what is already there; it may not be
   the only way to reach it.
4. **A change that costs money says so before it happens.** Stale is amber,
   priced, and reversible until Run.
5. **Twelve at once is the unit of review.** Any element that reads well on one
   card and turns the canvas into a wall of text on twelve is wrong.
6. **The load-bearing comments are the specification.** `globals.css` and
   `node-card.tsx` carry notes that are reverted-bug reports. Read the comment
   before changing the rule; if a change makes one false, delete it in the same
   diff.

## Accessibility

Not separately specified by the user; taken from what the code already enforces
and what `DESIGN.md` bans.

- Every control is a real `<button>`, reachable by keyboard. Tooltips are Radix,
  not `title=""` — the old attribute was invisible to the keyboard and gone on
  touch.
- Native `<dialog>` for modals, native form controls in the inspector.
- No control exists only on hover, for touch, keyboard and hit-testing alike.
- `prefers-reduced-motion: reduce` disables all motion, and that block stays.
- A component ships with all seven states or it is not done: default, hover,
  focus, active, disabled, loading, error.
- Colour is never the only carrier of state: status is a word next to its dot.
- Dark only. There is no light theme, and `DESIGN.md` says why — this is a
  safelight, and the frames are the bright thing in the room.
