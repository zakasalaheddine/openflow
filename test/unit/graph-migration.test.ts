import { describe, test, expect } from 'vitest'
import { readGraph } from '@/core/graph'

describe('a stored graph that predates the download', () => {
  test('loads without its export node, and without the edges into it', () => {
    const stored = {
      nodes: [
        { id: 'hero', type: 'image', prompt: 'a bottle', modelId: 'flux-2-pro', seed: 1 },
        { id: 'out', type: 'export', formats: [], overlay: { headline: 'Bottled sunlight' } },
      ],
      edges: [{ id: 'e1', from: 'hero', to: 'out', role: 'input', position: null }],
    }

    const graph = readGraph(stored)

    expect(graph.nodes.map((n) => n.id)).toEqual(['hero'])
    expect(graph.edges).toEqual([])
  })

  test('leaves a graph with no export node exactly as it was', () => {
    const stored = {
      nodes: [{ id: 'hero', type: 'image', prompt: 'a bottle', modelId: 'flux-2-pro', seed: 1 }],
      edges: [],
    }
    expect(readGraph(stored)).toEqual(stored)
  })
})
