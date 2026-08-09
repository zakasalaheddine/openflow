import { describe, test, expect } from 'vitest'
import { composePrompt, hasImageReference } from '@/core/compose'
import type { Flow } from '@/core/types'
import type { Source } from '@/db/schema'

const source = (id: string, over: Partial<Source> = {}): Source =>
  ({
    id,
    projectId: 'p',
    kind: 'image',
    files: ['a.jpg'],
    text: null,
    notes: null,
    version: 1,
    createdAt: '',
    ...over,
  }) as Source

const text = (id: string, content: string) =>
  source(id, { kind: 'text', files: [], text: content })

const flow = (...edgeFroms: string[]): Flow => ({
  nodes: [
    { id: 'shot', type: 'image', prompt: 'a serum bottle on marble', modelId: 'flux-2-pro' },
    ...edgeFroms.map((id) => ({ id, type: 'source' as const, sourceId: `src:${id}` })),
  ],
  edges: edgeFroms.map((id, i) => ({
    id: `e${i}`,
    from: id,
    to: 'shot',
    role: 'reference' as const,
    position: null,
  })),
})

describe('composePrompt', () => {
  test('returns the node prompt when nothing is wired in', () => {
    expect(composePrompt(flow(), 'shot', new Map())).toBe('a serum bottle on marble')
  })

  test('puts a text fragment before the node prompt', () => {
    const sources = new Map([['src:voice', text('src:voice', 'warm, unfussy, no hard sell')]])
    expect(composePrompt(flow('voice'), 'shot', sources)).toBe(
      'warm, unfussy, no hard sell\n\na serum bottle on marble',
    )
  })

  test('orders several fragments by edge order, not by node id', () => {
    // Deterministic because it feeds the hash. Edge insertion order is
    // persisted, so the composition matches what the user actually built.
    const sources = new Map([
      ['src:zeta', text('src:zeta', 'first')],
      ['src:alpha', text('src:alpha', 'second')],
    ])
    expect(composePrompt(flow('zeta', 'alpha'), 'shot', sources)).toBe(
      'first\n\nsecond\n\na serum bottle on marble',
    )
  })

  test('composes identically twice', () => {
    const sources = new Map([['src:voice', text('src:voice', 'warm')]])
    const graph = flow('voice')
    expect(composePrompt(graph, 'shot', sources)).toBe(composePrompt(graph, 'shot', sources))
  })

  test('ignores image sources', () => {
    // An image contributes files, not words.
    const sources = new Map([['src:bottle', source('src:bottle')]])
    expect(composePrompt(flow('bottle'), 'shot', sources)).toBe('a serum bottle on marble')
  })

  test('skips a text source whose row has vanished', () => {
    // A deleted asset must not blank the prompt and silently bill for it.
    expect(composePrompt(flow('ghost'), 'shot', new Map())).toBe('a serum bottle on marble')
  })

  test('ignores an empty text fragment rather than leaving blank lines', () => {
    const sources = new Map([['src:blank', text('src:blank', '   ')]])
    expect(composePrompt(flow('blank'), 'shot', sources)).toBe('a serum bottle on marble')
  })

  test('only reads reference edges', () => {
    const graph = flow('voice')
    graph.edges[0].role = 'input'
    const sources = new Map([['src:voice', text('src:voice', 'ignored')]])
    expect(composePrompt(graph, 'shot', sources)).toBe('a serum bottle on marble')
  })
})

describe('hasImageReference', () => {
  // Picks the endpoint the plan reports and the canvas shows. Dispatch
  // re-derives it from the real payload, so this is about an honest plan.
  test('an uploaded image or video counts', () => {
    const sources = new Map([['src:bottle', source('src:bottle')]])
    expect(hasImageReference(flow('bottle'), 'shot', sources)).toBe(true)
  })

  test('a text source does not — it contributes words, not an image', () => {
    const sources = new Map([['src:voice', text('src:voice', 'warm')]])
    expect(hasImageReference(flow('voice'), 'shot', sources)).toBe(false)
  })

  test('a rendered still counts, even though its file does not exist yet', () => {
    // The character sheet case. The canvas asks this 1.2 times a second, long
    // before the sheet has rendered — answering false until then would send the
    // first render to the endpoint with nowhere to put a reference.
    const graph = flow()
    graph.nodes.push({ id: 'sheet', type: 'image', prompt: 'her, 3/4 left', modelId: 'flux-2-pro' })
    graph.edges.push({ id: 'e', from: 'sheet', to: 'shot', role: 'reference', position: null })
    expect(hasImageReference(graph, 'shot', new Map())).toBe(true)
  })

  test('a source row that has been deleted does not count', () => {
    expect(hasImageReference(flow('ghost'), 'shot', new Map())).toBe(false)
  })

  test('nothing wired in is false', () => {
    expect(hasImageReference(flow(), 'shot', new Map())).toBe(false)
  })

  test('only reference edges count', () => {
    const graph = flow('bottle')
    graph.edges[0].role = 'input'
    const sources = new Map([['src:bottle', source('src:bottle')]])
    expect(hasImageReference(graph, 'shot', sources)).toBe(false)
  })
})
