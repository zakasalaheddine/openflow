import { describe, test, expect } from 'vitest'
import { composePrompt, referenceFiles } from '@/core/compose'
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

describe('referenceFiles', () => {
  test('collects files from image and video sources in edge order', () => {
    const sources = new Map([
      ['src:bottle', source('src:bottle', { files: ['front.jpg', 'angle.jpg'] })],
      ['src:clip', source('src:clip', { kind: 'video', files: ['ref.mp4'] })],
    ])
    expect(referenceFiles(flow('bottle', 'clip'), 'shot', sources)).toEqual([
      'front.jpg',
      'angle.jpg',
      'ref.mp4',
    ])
  })

  test('excludes text sources', () => {
    const sources = new Map([['src:voice', text('src:voice', 'warm')]])
    expect(referenceFiles(flow('voice'), 'shot', sources)).toEqual([])
  })

  test('returns nothing when no reference is wired in', () => {
    expect(referenceFiles(flow(), 'shot', new Map())).toEqual([])
  })
})
