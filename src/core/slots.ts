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
