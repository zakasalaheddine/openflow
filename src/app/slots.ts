import type { FlowNode } from '@/core/types'

export const COLUMN = 250
export const ROW = 265
const COLUMNS = 4

/** Where the nth card sits on a fresh canvas. */
export const slotFor = (index: number) => ({
  x: 40 + (index % COLUMNS) * COLUMN,
  y: 30 + Math.floor(index / COLUMNS) * ROW,
})

/**
 * The first slot nothing is sitting on.
 *
 * `slotFor(nodes.length)` is only free while nothing has ever been deleted:
 * remove a node from the middle and the count no longer matches the occupied
 * slots, so the next card lands exactly on top of an existing one and reads as a
 * duplicate — two nodes, one visible, and the wrong one takes the click.
 */
export function freeSlot(nodes: FlowNode[]) {
  const taken = new Set(
    nodes.flatMap((n) =>
      n.position ? [`${Math.round(n.position.x)},${Math.round(n.position.y)}`] : [],
    ),
  )
  for (let index = 0; ; index++) {
    const slot = slotFor(index)
    if (!taken.has(`${slot.x},${slot.y}`)) return slot
  }
}
