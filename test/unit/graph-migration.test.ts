import { describe, test, expect } from 'vitest'
import { readGraph } from '@/core/graph'

describe('a stored graph that predates the download', () => {
  test('loads without its export node, and without any edge touching it, leaving the rest untouched', () => {
    const stored = {
      nodes: [
        { id: 'hero', type: 'image', prompt: 'a bottle', modelId: 'flux-2-pro', seed: 1 },
        { id: 'clip', type: 'video', prompt: 'push in', durationSec: 5, audio: false, modelId: 'hailuo-2-3-pro' },
        { id: 'out', type: 'export', formats: [], overlay: { headline: 'Bottled sunlight' } },
      ],
      edges: [
        // Into the export node — dropped with it.
        { id: 'e1', from: 'hero', to: 'out', role: 'input', position: null },
        // Out of the export node — the export node was always terminal, but the
        // filter that only checked `edge.to` would let this one survive and
        // dangle off a node that no longer exists.
        { id: 'e2', from: 'out', to: 'clip', role: 'reference', position: null },
        // Unrelated to the export node entirely — must survive untouched. A
        // filter that (wrongly) dropped every edge whenever *any* export node
        // was present would pass with `edges: []` and never be caught.
        { id: 'e3', from: 'hero', to: 'clip', role: 'start_frame', position: null },
      ],
    }

    const graph = readGraph(stored)

    expect(graph.nodes.map((n) => n.id)).toEqual(['hero', 'clip'])
    expect(graph.edges).toEqual([{ id: 'e3', from: 'hero', to: 'clip', role: 'start_frame', position: null }])
  })

  test('leaves a graph with no export node exactly as it was', () => {
    const stored = {
      nodes: [{ id: 'hero', type: 'image', prompt: 'a bottle', modelId: 'flux-2-pro', seed: 1 }],
      edges: [],
    }
    expect(readGraph(stored)).toEqual(stored)
  })
})
