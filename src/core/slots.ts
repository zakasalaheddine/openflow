import type { FlowNode, NodeSize } from './types'

export const COLUMN = 250
/** A full card plus the gutter, so consecutive rows cannot touch. */
export const ROW = 280
const COLUMNS = 4
const GUTTER = 12

/**
 * How big a card is until someone drags a corner.
 *
 * A shot is 200 wide because the frame is 5:4 and twelve of them have to be
 * reviewable on one screen; the height is that frame plus the slate, three lines
 * of direction and the lab bill. An asset is smaller and squarer — it is a
 * reference, not something you judge.
 */
export const CARD: NodeSize = { w: 200, h: 256 }
export const CARD_SOURCE: NodeSize = { w: 168, h: 216 }
export const MIN_CARD: NodeSize = { w: 150, h: 150 }

export const sizeOf = (node: FlowNode): NodeSize =>
  node.size ?? (node.type === 'source' ? CARD_SOURCE : CARD)

/**
 * How tall a card should be to hold its frame at the frame's own shape.
 *
 * The card *is* the frame now — the slate, the direction and the bill ride on
 * top of it rather than taking rows underneath — so this is just the aspect
 * ratio, with no chrome to add. That is the whole reason the paperwork moved
 * onto the image: as stacked rows this needed a constant for their combined
 * height, kept in sync with the stylesheet by hand and wrong the first time
 * anyone changed a padding.
 *
 * Only for cards nobody has sized. `node.size` is written the moment you drag a
 * corner (and, incidentally, the moment you drag the card anywhere), and from
 * then on the size you chose is the size you get — a shot that resnapped to
 * 9:16 because a re-roll came back portrait would be undoing your layout.
 *
 * Bounded at both ends, and the ceiling is the grid's own row pitch rather than
 * a round number. Every placement in this file — `slotFor`, `freeSlot`,
 * `fanOut`'s sibling offset — assumes a card fits inside one row, so a 9:16 clip
 * grown to its true 356px would sit on top of whatever the grid put underneath
 * it. Capped, a portrait output pillarboxes by a few pixels instead; drag the
 * card taller and `contain` fills it exactly, and the lightbox was always the
 * place to judge one frame at its real shape.
 */
export function fitToFrame(
  node: FlowNode,
  frame: { width: number | null; height: number | null } | undefined,
): NodeSize {
  if (node.size) return node.size
  const base = sizeOf(node)
  if (!frame?.width || !frame?.height) return base
  const height = Math.round((base.w * frame.height) / frame.width)
  return { w: base.w, h: Math.min(Math.max(height, MIN_CARD.h), ROW - GUTTER) }
}

/** Where the nth card sits on a fresh canvas. */
export const slotFor = (index: number) => ({
  x: 40 + (index % COLUMNS) * COLUMN,
  y: 30 + Math.floor(index / COLUMNS) * ROW,
})

/**
 * The first slot no card is standing on.
 *
 * Rectangles, not coordinates. `slotFor(nodes.length)` is only free while
 * nothing has ever been deleted, and comparing exact positions is only free
 * while nothing has ever been *moved* — every card you had dragged somewhere
 * deliberate became invisible to this, so the next one landed squarely on top of
 * it and read as a duplicate: two nodes, one visible, and the wrong one taking
 * the click. What matters is whether the space is occupied, not whether some
 * other card happens to share a corner.
 */
export function freeSlot(nodes: FlowNode[], size: NodeSize = CARD) {
  const taken = nodes.flatMap((node) =>
    node.position ? [{ ...node.position, ...sizeOf(node) }] : [],
  )

  // Bounded, so a canvas that somehow fills the grid cannot hang the click that
  // adds a card. Four hundred slots is a hundred rows of shots.
  for (let index = 0; index < 400; index++) {
    const slot = slotFor(index)
    const clear = taken.every(
      (card) =>
        slot.x + size.w + GUTTER <= card.x ||
        card.x + card.w + GUTTER <= slot.x ||
        slot.y + size.h + GUTTER <= card.y ||
        card.y + card.h + GUTTER <= slot.y,
    )
    if (clear) return slot
  }

  // Below everything, which is always empty.
  return { x: slotFor(0).x, y: Math.max(0, ...taken.map((c) => c.y + c.h)) + GUTTER }
}
