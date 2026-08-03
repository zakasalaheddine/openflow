import { describe, test, expect } from 'vitest'
import { freeSlot, slotFor } from '@/app/slots'
import type { FlowNode } from '@/core/types'

const at = (id: string, index: number): FlowNode =>
  ({ id, type: 'image', prompt: '', modelRole: 'draft', seed: 1, position: slotFor(index) }) as FlowNode

describe('placing a new card', () => {
  test('fills the next slot on an untouched canvas', () => {
    expect(freeSlot([at('a', 0), at('b', 1)])).toEqual(slotFor(2))
  })

  test('fills the gap left by a deleted node rather than stacking on an occupied slot', () => {
    // Three cards, the middle one deleted. `slotFor(nodes.length)` would return
    // slot 2 — exactly where `c` still sits — and the new card would land on top
    // of it: two nodes, one visible, and the wrong one takes the click.
    const remaining = [at('a', 0), at('c', 2)]

    expect(freeSlot(remaining)).toEqual(slotFor(1))
    expect(freeSlot(remaining)).not.toEqual(slotFor(remaining.length))
  })

  test('ignores nodes that have no position of their own', () => {
    const floating = { id: 'x', type: 'export', formats: [] } as unknown as FlowNode

    expect(freeSlot([floating, at('a', 0)])).toEqual(slotFor(1))
  })
})
