import { describe, test, expect } from 'vitest'
import { tempDb, seedProject, seedFlow, seedSource } from '../helpers/db'
import { createOps } from '@/agent/ops'
import { WiringError } from '@/core/wiring'
import { UnsupportedCapabilityError } from '@/models/registry'
import type { Flow } from '@/core/types'

const EMPTY: Flow = { nodes: [], edges: [] }

function ops() {
  const { db } = tempDb()
  const projectId = seedProject(db)
  const flowId = seedFlow(db, projectId, EMPTY)
  return { db, projectId, flowId, ops: createOps(db, { projectId, flowId }) }
}

describe('add_node', () => {
  test('adds a node and hands back the id, because the next thing is to wire it', () => {
    const { ops: o } = ops()
    const { id } = o.addNode({ type: 'image', prompt: 'a serum on marble', modelRole: 'hero' })
    expect(id).toMatch(/^image-/)
    expect(o.listGraph().nodes).toHaveLength(1)
  })

  test('defaults seed to 1, matching the canvas', () => {
    // seed is folded into input_hash. A different default means a chat-built
    // node can never share a cache entry with the identical canvas-built one.
    const { ops: o } = ops()
    const { id } = o.addNode({ type: 'image', prompt: 'x' })
    const node = o.listGraph().nodes.find((n) => n.id === id)!
    expect(node).toMatchObject({ seed: 1, modelRole: 'draft' })
  })

  test('a video gets the same defaults the canvas gives it', () => {
    const { ops: o } = ops()
    const { id } = o.addNode({ type: 'video', prompt: 'push in' })
    const node = o.listGraph().nodes.find((n) => n.id === id)!
    expect(node).toMatchObject({ durationSec: 5, audio: false, modelRole: 'draft', seed: 1 })
  })

  test('the id is deterministic from the graph, not random, so a replayed conversation gets the same id twice', () => {
    const { ops: o } = ops()
    const { id: first } = o.addNode({ type: 'image', prompt: 'a' })
    const { ops: replay } = ops()
    const { id: second } = replay.addNode({ type: 'image', prompt: 'a' })
    expect(first).toBe(second)
  })

  test('deleting the lower-numbered of two nodes does not hand the next node an id already on the canvas', () => {
    // A count-based id ("one more than how many image nodes exist") would
    // regenerate image-2 here, colliding with the survivor. The id has to be
    // one more than the highest number ever assigned in this graph, not a
    // count of what is currently on it.
    const { ops: o } = ops()
    const { id: first } = o.addNode({ type: 'image', prompt: 'first' }) // image-1
    const { id: second } = o.addNode({ type: 'image', prompt: 'second' }) // image-2
    o.deleteNode({ id: first })

    const { id: third } = o.addNode({ type: 'image', prompt: 'third' })
    expect(third).not.toBe(second)
    expect(new Set(o.listGraph().nodes.map((n) => n.id)).size).toBe(o.listGraph().nodes.length)
  })

  test('places each node somewhere free, so two never land on top of each other', () => {
    const { ops: o } = ops()
    o.addNode({ type: 'image', prompt: 'a' })
    o.addNode({ type: 'image', prompt: 'b' })
    const [first, second] = o.listGraph().nodes
    expect(first.position).not.toEqual(second.position)
  })
})

describe('update_node', () => {
  test('changes only what was named', () => {
    const { ops: o } = ops()
    const { id } = o.addNode({ type: 'image', prompt: 'first', modelRole: 'draft' })
    o.updateNode({ id, prompt: 'second' })
    const node = o.listGraph().nodes.find((n) => n.id === id)!
    expect(node).toMatchObject({ prompt: 'second', modelRole: 'draft' })
  })

  test('refuses a node that is not there', () => {
    const { ops: o } = ops()
    expect(() => o.updateNode({ id: 'nope', prompt: 'x' })).toThrow(/nope/)
  })

  test('refuses a field the node type does not have, instead of silently dropping it', () => {
    // An image node has no durationSec. Accepting it would let the schema
    // strip the field, persist the unchanged node, and report success — the
    // caller here is a model, and a silent no-op teaches it the edit landed.
    const { ops: o } = ops()
    const { id } = o.addNode({ type: 'image', prompt: 'first' })
    expect(() => o.updateNode({ id, durationSec: 5 })).toThrow(/durationSec/)
    const node = o.listGraph().nodes.find((n) => n.id === id)!
    expect(node).toMatchObject({ prompt: 'first' })
    expect(node).not.toHaveProperty('durationSec')
  })
})

describe('delete_node', () => {
  test('takes the node edges with it', () => {
    const { ops: o } = ops()
    const image = o.addNode({ type: 'image', prompt: 'still' }).id
    const video = o.addNode({ type: 'video', prompt: 'moving' }).id
    o.wire({ from: image, to: video })

    o.deleteNode({ id: image })

    const graph = o.listGraph()
    expect(graph.nodes.map((n) => n.id)).toEqual([video])
    expect(graph.edges).toEqual([])
  })
})

describe('wire', () => {
  test('infers the role rather than asking for one', () => {
    const { ops: o } = ops()
    const image = o.addNode({ type: 'image', prompt: 'still' }).id
    const video = o.addNode({ type: 'video', prompt: 'moving' }).id
    expect(o.wire({ from: image, to: video }).role).toBe('start_frame')
  })

  test('refuses a cycle', () => {
    const { ops: o } = ops()
    const a = o.addNode({ type: 'image', prompt: 'a' }).id
    const b = o.addNode({ type: 'video', prompt: 'b' }).id
    o.wire({ from: a, to: b })
    expect(() => o.wire({ from: b, to: a })).toThrow(WiringError)
  })

  test('refuses a second start frame', () => {
    const { ops: o } = ops()
    const first = o.addNode({ type: 'image', prompt: 'a' }).id
    const second = o.addNode({ type: 'image', prompt: 'b' }).id
    const video = o.addNode({ type: 'video', prompt: 'c' }).id
    o.wire({ from: first, to: video })
    expect(() => o.wire({ from: second, to: video })).toThrow(WiringError)
  })

  test('refuses one reference more than the model honours', () => {
    // This is the assertion that proves wire calls applyWire rather than a copy:
    // the capability gate lives there and nowhere else.
    const { db, projectId, flowId } = ops()
    const o = createOps(db, { projectId, flowId })
    const target = o.addNode({ type: 'image', prompt: 'shot', modelRole: 'draft' }).id
    const refs = Array.from({ length: 12 }, (_, i) =>
      o.addNode({ type: 'source', sourceId: seedSource(db, projectId, `source-${i}`) }).id,
    )
    expect(() => {
      for (const ref of refs) o.wire({ from: ref, to: target })
    }).toThrow(UnsupportedCapabilityError)
  })
})

describe('unwire', () => {
  test('takes just the edge, leaving both nodes', () => {
    const { ops: o } = ops()
    const image = o.addNode({ type: 'image', prompt: 'still' }).id
    const video = o.addNode({ type: 'video', prompt: 'moving' }).id
    const { edgeId } = o.wire({ from: image, to: video })

    o.unwire({ edgeId })

    const graph = o.listGraph()
    expect(graph.edges).toEqual([])
    expect(graph.nodes.map((n) => n.id).sort()).toEqual([image, video].sort())
  })

  test('refuses an edge that is not there', () => {
    const { ops: o } = ops()
    expect(() => o.unwire({ edgeId: 'nope' })).toThrow(/nope/)
  })
})

describe('list_sources', () => {
  test('lists what the project has to reference', () => {
    const { db, projectId, ops: o } = ops()
    seedSource(db, projectId, 'source-a', { kind: 'image' })
    expect(o.listSources()).toEqual([
      expect.objectContaining({ id: 'source-a', kind: 'image', version: 1 }),
    ])
  })
})

describe('apply_template', () => {
  test('fills the slots and puts the whole template on the canvas', () => {
    const { ops: o } = ops()
    const templates = o.listTemplates()
    const first = templates[0]
    const prompts = Object.fromEntries(first.slots.map((slot) => [slot, `filled ${slot}`]))

    const { nodeIds } = o.applyTemplate({ templateId: first.id, prompts })

    expect(nodeIds.length).toBeGreaterThan(0)
    expect(o.listGraph().nodes).toHaveLength(nodeIds.length)
  })

  test('refuses a template that left a slot empty', () => {
    const { ops: o } = ops()
    const first = o.listTemplates()[0]
    expect(() => o.applyTemplate({ templateId: first.id, prompts: {} })).toThrow(/needs/)
  })
})
