import { describe, test, expect } from 'vitest'
import { topoOrder, descendants, ancestors, CycleError } from '@/core/graph'
import type { Edge } from '@/core/types'

const edge = (from: string, to: string, role: Edge['role'] = 'input'): Edge => ({
  id: `${from}->${to}`,
  from,
  to,
  role,
  position: null,
})

// The serum graph from the build plan: one image fanning out to three clips.
const fanOut = {
  nodeIds: ['img', 'push-in', 'shadow-sweep', 'tilt-up'],
  edges: [
    edge('img', 'push-in', 'start_frame'),
    edge('img', 'shadow-sweep', 'start_frame'),
    edge('img', 'tilt-up', 'start_frame'),
  ],
}

describe('topoOrder', () => {
  test('places a parent before its child', () => {
    const order = topoOrder({ nodeIds: ['b', 'a'], edges: [edge('a', 'b')] })
    expect(order).toEqual(['a', 'b'])
  })

  test('orders a branching DAG with every parent before its children', () => {
    const order = topoOrder(fanOut)
    expect(order).toHaveLength(4)
    expect(order[0]).toBe('img')
    expect(new Set(order.slice(1))).toEqual(new Set(['push-in', 'shadow-sweep', 'tilt-up']))
  })

  test('orders a diamond correctly', () => {
    const order = topoOrder({
      nodeIds: ['a', 'b', 'c', 'd'],
      edges: [edge('a', 'b'), edge('a', 'c'), edge('b', 'd'), edge('c', 'd')],
    })
    expect(order.indexOf('a')).toBeLessThan(order.indexOf('b'))
    expect(order.indexOf('a')).toBeLessThan(order.indexOf('c'))
    expect(order.indexOf('b')).toBeLessThan(order.indexOf('d'))
    expect(order.indexOf('c')).toBeLessThan(order.indexOf('d'))
  })

  test('includes disconnected nodes', () => {
    const order = topoOrder({ nodeIds: ['a', 'b', 'lonely'], edges: [edge('a', 'b')] })
    expect(order).toContain('lonely')
    expect(order).toHaveLength(3)
  })

  test('is deterministic for the same input', () => {
    expect(topoOrder(fanOut)).toEqual(topoOrder(fanOut))
  })

  test('throws CycleError instead of looping forever', () => {
    const cyclic = { nodeIds: ['a', 'b'], edges: [edge('a', 'b'), edge('b', 'a')] }
    expect(() => topoOrder(cyclic)).toThrow(CycleError)
  })

  test('names the nodes involved in the cycle', () => {
    // A cycle error that does not say where it is makes a large graph
    // unfixable by hand.
    const cyclic = { nodeIds: ['a', 'b', 'c'], edges: [edge('a', 'b'), edge('b', 'c'), edge('c', 'b')] }
    expect(() => topoOrder(cyclic)).toThrow(/b|c/)
  })

  test('throws on a self-edge', () => {
    expect(() => topoOrder({ nodeIds: ['a'], edges: [edge('a', 'a')] })).toThrow(CycleError)
  })

  test('ignores edges referencing unknown nodes', () => {
    // A dangling edge left by a delete must not resurrect a phantom node.
    const order = topoOrder({ nodeIds: ['a'], edges: [edge('a', 'ghost')] })
    expect(order).toEqual(['a'])
  })
})

describe('descendants', () => {
  test('returns every node downstream of an edit', () => {
    // Powers stale propagation and the priced toolbar count.
    expect(descendants(fanOut, 'img')).toEqual(
      new Set(['push-in', 'shadow-sweep', 'tilt-up']),
    )
  })

  test('walks transitively', () => {
    const chain = { nodeIds: ['a', 'b', 'c'], edges: [edge('a', 'b'), edge('b', 'c')] }
    expect(descendants(chain, 'a')).toEqual(new Set(['b', 'c']))
  })

  test('excludes the node itself', () => {
    expect(descendants(fanOut, 'img').has('img')).toBe(false)
  })

  test('returns empty for a leaf', () => {
    expect(descendants(fanOut, 'push-in')).toEqual(new Set())
  })

  test('does not walk upstream', () => {
    expect(descendants(fanOut, 'push-in').has('img')).toBe(false)
  })

  test('counts a diamond node once', () => {
    const diamond = {
      nodeIds: ['a', 'b', 'c', 'd'],
      edges: [edge('a', 'b'), edge('a', 'c'), edge('b', 'd'), edge('c', 'd')],
    }
    expect(descendants(diamond, 'a')).toEqual(new Set(['b', 'c', 'd']))
  })

  test('terminates on a cyclic graph', () => {
    // The UI calls this on every keystroke; it must not hang even if a cycle
    // slipped past wiring validation.
    const cyclic = { nodeIds: ['a', 'b'], edges: [edge('a', 'b'), edge('b', 'a')] }
    expect(descendants(cyclic, 'a')).toEqual(new Set(['a', 'b']))
  })
})

describe('ancestors', () => {
  test('returns every upstream node', () => {
    // Feeds upstreamHashes, so the walk must be transitive.
    const chain = { nodeIds: ['a', 'b', 'c'], edges: [edge('a', 'b'), edge('b', 'c')] }
    expect(ancestors(chain, 'c')).toEqual(new Set(['a', 'b']))
  })

  test('returns empty for a root', () => {
    expect(ancestors(fanOut, 'img')).toEqual(new Set())
  })
})
