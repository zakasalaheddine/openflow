# Design

The interface is a darkroom, not an IDE.

You review a shoot under a safelight. The ground is a deep blue-black, the
generated frames read as prints on a light table, and amber is the safelight.
Amber is spent on exactly one meaning — this will be billed — so the eye learns
what it costs to look away.

Register: **product**. Design serves the task. The tool disappears into the
work; nothing here is decoration.

---

## Which styling system owns what

Two systems, one palette. This section is the rule. Break it and the palette
splits within a month.

| Layer | System | Why |
|---|---|---|
| Canvas, node card, React Flow, panels, chat | Hand-written CSS in `src/app/globals.css` | A dozen rules here are load-bearing bug fixes with the bug written above them. React Flow's own selectors (`.react-flow__edges`, `.react-flow__handle`, `.react-flow__resize-control.line.…`) can only be reached globally in the first place. |
| Interactive primitives — tooltip, toast, dialog, dropdown menu, combobox, skeleton, separator | Tailwind + shadcn in `src/ui/` | These carry real accessibility burden: focus traps, live-region politeness, roving tabindex, escape handling, `aria-describedby`. Buying that is worth a build step. Writing it again is not. |

Deciding for a new piece of UI:

- **Does it live on the canvas, or is it part of a node?** `globals.css`.
- **Is it a floating, focus-managing, keyboard-driven primitive?** shadcn.
- **Neither?** `globals.css`. The default is the hand-written layer; shadcn is
  the exception you reach for, not the other way round.

Never author a canvas or node style as Tailwind utilities, and never re-skin a
shadcn primitive by adding a global rule that matches its internals. If a
primitive needs to look different, pass `className` and let `cn()` merge it.

### How the two are bridged

`globals.css` defines the darkroom palette once, in OKLCH. A second `:root`
block maps it onto the variable names shadcn is written against
(`--background`, `--foreground`, `--muted`, `--border`, `--ring`, …), and
`@theme inline` exposes both sets to Tailwind. Colour is decided in exactly one
place: change `--panel` and every surface in both systems moves with it.

Nothing in the shadcn block introduces a hue. If a primitive needs a colour
that is not already in the palette, the palette is wrong, not the primitive.

### Tailwind is installed without preflight

`@import "tailwindcss"` would pull in `preflight.css`, which resets margins,
headings, lists and form controls across the whole document — including the
canvas layer. Instead the three layers are imported individually, minus
preflight, and the one thing preflight provided that shadcn actually depends on
is re-stated in `@layer openflow-base`:

```css
*, ::before, ::after {
  border-width: 0;
  border-style: solid;
  border-color: var(--border);
}
```

Tailwind's `border` utility sets a width and nothing else. Without a default
style and colour every bordered primitive renders as a browser-default ridge in
`currentColor`. Every border in `globals.css` is set with the shorthand, so
zeroing the width there changes nothing that already exists.

**Layer order is `theme, base, openflow-base, components, utilities`.** The base
resets are layered so every Tailwind utility outranks them — unlayered, the bare
`button` rule would beat `bg-primary` and every primitive would come out
transparent. The component rules (`.node`, `.chip`, `.react-flow__*`) stay
unlayered on purpose: they are the hand-tuned layer and must win over utilities.

`.dark` sits permanently on `<html>` with `@custom-variant dark (&:is(.dark *))`,
because shadcn components carry `dark:` utilities for the half of their styling
that only makes sense on a dark ground, and there is no light theme to switch to.

---

## Colour

OKLCH only. Strategy: **Restrained** — tinted neutrals carrying the surface, and
colour spent only where it means something.

### Surfaces — one hue, six lightness steps

| Token | Value | Use |
|---|---|---|
| `--ground` | `oklch(0.176 0.011 262)` | The canvas, and the deepest recess of any panel |
| `--panel` | `oklch(0.213 0.013 262)` | Topbar, inspector, chat, node body |
| `--raised` | `oklch(0.253 0.014 262)` | Slates, pressed chips, secondary fills |
| `--overlay` | `oklch(0.279 0.015 262)` | Menus, toasts, popovers — the floating layer |
| `--line` | `oklch(0.311 0.015 262)` | Hairlines between sections |
| `--line-bright` | `oklch(0.405 0.018 262)` | Control borders, handles |

One hue, so a surface one step up is one step up everywhere. Chroma pulls back
as lightness approaches either end. Never `#000`, never `#fff`.

### Ink

| Token | Use |
|---|---|
| `--ink` | Primary text. Warm (hue 80), because a print under a safelight is warm |
| `--slate` | Labels, secondary text |
| `--slate-dim` | Meta, disabled, the things you read only when you look for them |

### Meaning — four colours, four meanings, no overlap

| Token | Means | Rule |
|---|---|---|
| `--safelight` (amber) | **This will be billed.** Stale nodes, cost owed, the due ledger | **Nothing else may use it.** Not a toast, not a warning, not a focus ring. The semantic only holds while it is exclusive. |
| `--beam` (cool blue) | Focus, selection, the thing you are pointing at | The light table. Everything that used to be amber and is not about money |
| `--fixed` (green) | Rendered, wired, valid | Generation edges, done status, live drop targets |
| `--fault` (red) | Failed, destructive | Errors, delete |

Amber exclusivity is the single most important rule in this file. If a design
needs a warning colour, it uses `--fault` or nothing.

---

## Typography

Inter for everything readable, JetBrains Mono for everything measurable. Both
variable, both self-hosted by `next/font` at build time — no runtime request
leaves the machine.

Everything measurable is typed like a call sheet: prices, ids, seeds, model
slugs, durations. Only prose is set in sans.

Fixed rem steps at roughly 1.15, not a fluid clamp. This is product UI at a
consistent DPI, and a heading that shrinks inside a 340px inspector looks worse,
not better.

| Token | px | Use |
|---|---|---|
| `--fs-1` | 11 | Slates, meta, node footers |
| `--fs-2` | 12 | Dense labels, figures |
| `--fs-3` | 13 | Controls, fields, prompts |
| `--fs-4` | 14 | Body, the base |
| `--fs-5` | 16 | Panel headings |
| `--fs-6` | 19 | The one title |

`.slate` (mono, uppercase, tracked) is a **caption treatment**, not a default.
It used to sit on nearly every label in the interface, which produced one
uniform texture and no hierarchy at all. Things above a caption are allowed to
be bigger than it.

Prose caps at 65–75ch. Data and dense UI may run tighter.

---

## Radius

Three steps, scaled to how big the thing is. A chip is not a panel.

| Token | px | Use |
|---|---|---|
| `--r-sm` | 6 | Chips, inputs, buttons, badges |
| `--r-md` | 10 | Nodes, menus, toasts, dialogs' inner surfaces |
| `--r-lg` | 14 | Panels, dialogs, the drop target |

Exceptions, both deliberate: React Flow handles are 3px (6px on a 10px box is a
circle, and a round handle reads as a port you can drag into from any angle),
and the lightbox close is a circle because it is an icon-only escape hatch.

---

## Elevation

Two layers each — a tight contact shadow so the edge reads, and a wide ambient
one so the thing sits in a room. Tinted to the ground hue, never neutral black,
or a raised surface looks like a hole punched in the canvas.

| Token | Use |
|---|---|
| `--e-1` | Node cards, resting surfaces |
| `--e-2` | Menus, toasts, selected nodes, the chat panel |
| `--e-3` | Dialogs, the lightbox |

Rings are added to elevation, never swapped for it: `box-shadow: 0 0 0 1px
var(--beam), var(--e-2)`. A selected card that loses its shadow reads as pressed
into the canvas rather than picked out of it.

**A ring is drawn with `box-shadow`, never a thicker border.** `border-width` is
layout, and a card that grows a pixel when you select it nudges the frame under
the cursor.

---

## Motion

Exponential ease-out only. Things arrive fast and settle, which is what a tool
does. No bounce, no elastic — this is a canvas someone is working on, not a page
they are being shown.

| Token | Value | Use |
|---|---|---|
| `--ease` | `cubic-bezier(0.25, 1, 0.5, 1)` (quart) | Default |
| `--ease-out` | `cubic-bezier(0.16, 1, 0.3, 1)` (expo) | Overlays entering |
| `--t-micro` | 150ms | Hover, focus, colour |
| `--t-panel` | 220ms | Panels, drawers |
| `--t-overlay` | 320ms | Dialogs, toasts |

Never animate a layout property. Motion conveys state — arrival, departure,
progress — and nothing else. `prefers-reduced-motion: reduce` disables all of
it, and that block stays.

---

## Spacing

A 4pt scale, `--s-1` (4px) through `--s-8` (48px), used with deliberate
variation. Dense inside a node, generous inside the inspector. The same padding
everywhere is the monotony this file is trying to leave behind.

---

## Bans

On top of the general ones (no gradient text, no glassmorphism as default, no
side-stripe borders, no identical card grids, no modal as a first thought):

- **Amber for anything but money.** Stated three times in this file on purpose.
- **Blur over a surface we chose ourselves.** There are exactly two blurs in the
  interface and both sit over content we do not control: the preview button on a
  node's frame (a solid fill is invisible on a dark shot and a hole in a bright
  one), and the lightbox backdrop over the canvas. A blur over `--panel` is a
  glass effect with nothing behind it — use `--overlay` and move on.
- **A border that changes width on a state change.** Rings are `box-shadow`.
- **`overflow: hidden` on `.node`.** Handles sit half outside the card; clipping
  them makes them visible but not hit-testable, and wiring silently stops
  working.
- **Display fonts in labels, buttons or data.** Two families, and neither is a
  display face.
- **Reinvented standard affordances.** Native `<dialog>` for modals, native
  form controls in the inspector, real `<button>`s for everything clickable.
- **A component shipped with half its states.** Default, hover, focus, active,
  disabled, loading, error. All seven or it is not done.
- **Exit animations on menus.** Radix keeps closing content mounted until its
  exit animation ends, and while it is mounted its dismissable layer still
  listens: a pointerdown on the trigger inside that window is read as a click
  outside the menu and consumed, so clicking the trigger again quickly does
  nothing. Menus enter animated and leave instantly. Dialogs may animate out —
  nothing toggles them from a Radix trigger.
- **A `bg-black/NN` scrim.** Neutral black over a blue-black canvas turns the
  page grey-green. Use `--scrim`.
- **An overlay rendered inside `.shell`.** It is a two-column grid and every
  direct child is a grid item, so a toast region or a portal host placed in
  there takes the inspector's column. Overlays go outside it.

---

## A shot card is a frame

The card is the picture. The slate, the direction and the bill ride on top of it
over a gradient scrim; they do not take rows underneath it.

- **The card takes the frame's shape.** `fitToFrame` in `src/core/slots.ts` sizes
  a card from its output's intrinsic dimensions, capped at the grid's row pitch
  so a portrait clip cannot land on whatever the grid put below it. Only for
  cards nobody has sized: `node.size` wins the moment it exists.
- **`object-fit: contain`, never `cover`.** The card already has the right shape,
  so the two agree; on a hand-resized card, letterboxing is honest and cropping
  is a lie about what you paid for.
- **The price is never dimmed, hidden, abbreviated or behind a hover.** Stale
  fades the frame, not the card, for exactly this reason.
- **The strips over the frame take no pointer input unless they are controls.**
  The slate is four words of text and it covered the preview button underneath
  it; the direction sat over the bottom of the frame at `opacity: 0` and ate the
  click that selects a card.
- **Nothing on the card may be reachable only by hover.** Hover has no touch
  equivalent, and Playwright hit-tests before it moves the pointer, so a control
  that appears on hover is a control that does not exist for either. The
  direction is one line at rest and opens on hover, selection or editing — it is
  never absent.

## Panels

- **The toolbar is grouped, and nothing is ever removed from it.** Groups are
  separated by hairlines, not by wider gaps: a gap says "further apart", a rule
  says "a different kind of thing". As the window narrows, labels drop and the
  icons carry the controls; below that the row scrolls sideways. Run all is
  sticky to the right edge, because the one control that must never be off
  screen is the one that spends money.
- **Nothing in the toolbar wraps.** `.shell` gives it a fixed 52px row, so a
  control that wraps to two lines overflows the bar rather than growing it.
- **The inspector is sections, not a stack.** A caption, a tight cluster of
  fields, then a bigger gap. One flat gap between every element is what made
  finding one control mean reading all of them.
- **The bill is pinned to the bottom of the inspector and weighted like a
  figure**, amber while owed and ink once spent — the same rule as the card.
- **Below 900px the inspector is a bottom sheet**, not a collapsed column.
  Dropping the column does not remove a grid item: the panel wrapped to a row of
  its own and took half the canvas.
- **The chat log distinguishes speakers by shape.** Your turns are right-aligned
  in a tinted box; the agent's run flush left as prose. Opacity alone made the
  log one grey wall and made the thing you wrote the quietest thing in it.
- **The agent's tool calls are summarised, never logged.** What it did to the
  graph belongs in the thread; the arguments do not — the graph is on screen,
  and a panel that reprints it is a second source of truth to keep in sync.

## The load-bearing comments

`src/app/globals.css` and `src/app/node-card.tsx` carry comments that read like
design notes and are actually bug reports. They document interactions that were
tried, shipped, and reverted — a node that could only be wired once, a card that
resized itself under the cursor, a prompt edit that zoomed the canvas into
itself. Read the comment before changing the rule above it. If a change makes
one of them false, delete the comment in the same diff; if it makes one of them
wrong, the change is wrong.

---

## The probe

`/design-probe` renders the whole palette, both radius and elevation scales, the
type ramp, the house controls and the shadcn primitives on one page. It exists
so the bridge between the two systems fails visibly there before it fails on the
canvas: if a shadcn Button renders in stock neutral grey, or a `.chip` and a
`<Button variant="outline">` sit at different radii, that is the bug and this is
where you see it.
