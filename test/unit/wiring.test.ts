import { describe, test, expect } from 'vitest'
import { inferRole, validateWire, applyWire, assertModelFits, WiringError } from '@/core/wiring'
import { UnsupportedCapabilityError, type ModelSpec } from '@/models/registry'
import { modelById } from '@/models/catalog'
import type { Flow, FlowNode } from '@/core/types'

/**
 * Every video row shipped today accepts a start frame, so the gate would be
 * vacuous against the real catalog. Injecting the lookup keeps it provably
 * enforced for the day a text-to-video row is added — which is the only time it
 * matters and the worst time to discover it never worked.
 */
const withoutStartFrame = (id: string): ModelSpec => {
  const model = modelById(id)
  return { ...model, caps: { ...model.caps, startEndFrame: false } }
}

const image = (id: string, modelId = 'flux-2-pro'): FlowNode => ({
  id,
  type: 'image',
  prompt: 'bottle',
  modelId,
})

const video = (id: string, modelId = 'kling-3-pro'): FlowNode => ({
  id,
  type: 'video',
  prompt: 'push in',
  durationSec: 5,
  audio: false,
  modelId,
})

const source = (id: string): FlowNode => ({ id, type: 'source', sourceId: `src:${id}` })
const exportNode = (id: string): FlowNode => ({ id, type: 'export', formats: [] })

const flowOf = (...nodes: FlowNode[]): Flow => ({ nodes, edges: [] })

describe('inferRole', () => {
  test('image into video is a start frame', () => {
    // The edge means "this image is frame zero of that clip". That meaning is
    // the point of typed edges, so it must be inferred, not chosen in a dialog.
    expect(inferRole(image('a'), video('b'))).toBe('start_frame')
  })

  test('source into image is a reference', () => {
    // The asset is an input the model must honour — the thing anchors used to
    // mean, now visible as a wire.
    expect(inferRole(source('s'), image('a'))).toBe('reference')
  })

  test('source into video is a reference', () => {
    expect(inferRole(source('s'), video('v'))).toBe('reference')
  })

  test('image into export is a plain input', () => {
    expect(inferRole(image('a'), exportNode('e'))).toBe('input')
  })

  test('video into export is a plain input', () => {
    expect(inferRole(video('v'), exportNode('e'))).toBe('input')
  })
})

describe('validateWire', () => {
  test('accepts image into a video model that supports start frames', () => {
    const flow = flowOf(image('a'), video('b'))
    expect(() => validateWire(flow, 'a', 'b', { resolve: modelById })).not.toThrow()
  })

  test('refuses a start frame into a model that cannot accept one', () => {
    // Refused at wiring time. Accepting it and dropping it at render time bills
    // for a clip that ignored its own first frame.
    const flow = flowOf(image('a'), video('b'))
    expect(() => validateWire(flow, 'a', 'b', { resolve: withoutStartFrame })).toThrow(
      UnsupportedCapabilityError,
    )
  })

  test('refuses a self-edge', () => {
    const flow = flowOf(image('a'))
    expect(() => validateWire(flow, 'a', 'a', { resolve: modelById })).toThrow(WiringError)
  })

  test('refuses a wire that would create a cycle', () => {
    const flow: Flow = {
      nodes: [image('a'), video('b')],
      edges: [{ id: 'e1', from: 'a', to: 'b', role: 'start_frame', position: null }],
    }
    expect(() => validateWire(flow, 'b', 'a', { resolve: modelById })).toThrow(WiringError)
  })

  test('refuses a duplicate edge', () => {
    const flow: Flow = {
      nodes: [image('a'), video('b')],
      edges: [{ id: 'e1', from: 'a', to: 'b', role: 'start_frame', position: null }],
    }
    expect(() => validateWire(flow, 'a', 'b', { resolve: modelById })).toThrow(WiringError)
  })

  test('refuses an unknown node', () => {
    expect(() => validateWire(flowOf(image('a')), 'a', 'ghost', { resolve: modelById })).toThrow(WiringError)
  })

  test('refuses a second start frame into the same video', () => {
    // A clip has exactly one frame zero. Two would silently pick one.
    const flow: Flow = {
      nodes: [image('a'), image('a2'), video('b')],
      edges: [{ id: 'e1', from: 'a', to: 'b', role: 'start_frame', position: null }],
    }
    expect(() => validateWire(flow, 'a2', 'b', { resolve: modelById })).toThrow(WiringError)
  })

  test('refuses anything wired into a source node', () => {
    // A source brings an existing file in; nothing feeds it.
    const flow = flowOf(image('a'), source('s'))
    expect(() => validateWire(flow, 'a', 's', { resolve: modelById })).toThrow(WiringError)
  })
})

describe('reference wiring', () => {
  test('one asset may feed many shots', () => {
    // Twelve shots on one product is the normal case, not an edge case. Nothing
    // may cap it — the readability answer is how the edges are drawn.
    let flow = flowOf(source('bottle'), image('a'), image('b'), image('c'))
    for (const to of ['a', 'b', 'c']) flow = applyWire(flow, 'bottle', to, { resolve: modelById })

    expect(flow.edges).toHaveLength(3)
    expect(flow.edges.every((e) => e.role === 'reference')).toBe(true)
  })

  test('a shot may take several references', () => {
    // A product plus a brand-tone text fragment, on the same shot.
    let flow = flowOf(source('bottle'), source('voice'), image('a'))
    flow = applyWire(flow, 'bottle', 'a', { resolve: modelById })
    flow = applyWire(flow, 'voice', 'a', { resolve: modelById })
    expect(flow.edges).toHaveLength(2)
  })

  test('refuses a reference into a model that cannot honour one', () => {
    // Recraft (image specialist) has caps.refImages === 0. Silently dropping
    // the reference produces off-brand output that reads as a model problem.
    const flow: Flow = {
      nodes: [source('bottle'), { ...image('a'), modelId: 'recraft-v3' } as FlowNode],
      edges: [],
    }
    expect(() => validateWire(flow, 'bottle', 'a', { resolve: modelById })).toThrow(UnsupportedCapabilityError)
  })

  test('refuses more references than the model accepts', () => {
    const many = Array.from({ length: 8 }, (_, i) => source(`s${i}`))
    let flow = flowOf(...many, image('a'))
    // flux-2-pro accepts 4.
    for (let i = 0; i < 4; i++) flow = applyWire(flow, `s${i}`, 'a', { resolve: modelById })
    expect(() => validateWire(flow, 's4', 'a', { resolve: modelById })).toThrow(UnsupportedCapabilityError)
  })
})

describe('applyWire', () => {
  test('adds an edge with the inferred role', () => {
    const next = applyWire(flowOf(image('a'), video('b')), 'a', 'b', { resolve: modelById })
    expect(next.edges).toHaveLength(1)
    expect(next.edges[0]).toMatchObject({ from: 'a', to: 'b', role: 'start_frame' })
  })

  test('derives the edge id from its endpoints, not randomly', () => {
    // Deterministic so a chat conversation that wires nodes can be recorded as
    // an LLM_MODE=replay fixture and replayed — a random id changes on every
    // run, so it can never match a recorded fixture and made every wiring
    // conversation unrecordable. See wiring.ts's edgeFor for the full reasoning.
    const next = applyWire(flowOf(image('a'), video('b')), 'a', 'b', { resolve: modelById })
    expect(next.edges[0].id).toBe('a->b')
  })

  test('leaves position null in v1', () => {
    // Reserved for v2 sequence ordering. Present so v2 needs no migration.
    const next = applyWire(flowOf(image('a'), video('b')), 'a', 'b', { resolve: modelById })
    expect(next.edges[0].position).toBeNull()
  })

  test('does not mutate the input flow', () => {
    // The canvas re-reads graph_json after every change; a mutated input makes
    // the view and the stored graph disagree.
    const flow = flowOf(image('a'), video('b'))
    applyWire(flow, 'a', 'b', { resolve: modelById })
    expect(flow.edges).toHaveLength(0)
  })

  test('supports one image fanning out to three clips', () => {
    // The core interaction. Three edges, no special case in the engine.
    let flow = flowOf(image('img'), video('push'), video('sweep'), video('tilt'))
    for (const to of ['push', 'sweep', 'tilt']) flow = applyWire(flow, 'img', to, { resolve: modelById })

    expect(flow.edges).toHaveLength(3)
    expect(flow.edges.every((e) => e.role === 'start_frame')).toBe(true)
  })

  test('throws rather than adding an invalid edge', () => {
    expect(() =>
      applyWire(flowOf(image('a'), video('b')), 'a', 'b', { resolve: withoutStartFrame }),
    ).toThrow()
  })
})

describe('assertModelFits', () => {
  // Changing a model is the same question wiring asks, aimed the other way:
  // wiring asks whether an edge may join a node on that model, this asks
  // whether a model may take the edges the node already has.
  // Built on the six-reference row, so the wires exist before the model that
  // cannot take them is tried against them.
  const withRefs = (count: number) => {
    let flow = flowOf(
      ...Array.from({ length: count }, (_, i) => source(`s${i}`)),
      image('shot', 'nano-banana-pro'),
    )
    for (let i = 0; i < count; i++) flow = applyWire(flow, `s${i}`, 'shot', { resolve: modelById })
    return flow
  }

  test('a model that honours none of them is refused, and says so by name', () => {
    expect(() => assertModelFits(withRefs(3), 'shot', modelById('recraft-v3'))).toThrow(
      /recraft-v3 cannot honour reference images/,
    )
  })

  test('a model that honours fewer than are wired is refused with the count', () => {
    // flux-2-pro takes four. nano-banana-pro takes six, so five is fine on one
    // and refused on the other — the number is the whole point of the message.
    const five = withRefs(5)
    expect(() => assertModelFits(five, 'shot', modelById('flux-2-pro'))).toThrow(/at most 4/)
    expect(() => assertModelFits(five, 'shot', modelById('nano-banana-pro'))).not.toThrow()
  })

  test('a clip with a start frame refuses a model that cannot take one', () => {
    const flow = applyWire(flowOf(image('a'), video('b')), 'a', 'b', { resolve: modelById })
    expect(() => assertModelFits(flow, 'b', withoutStartFrame('kling-3-pro'))).toThrow(
      /cannot accept a start frame/,
    )
  })

  test('a node with no wires takes any model of its format', () => {
    expect(() => assertModelFits(flowOf(image('lonely')), 'lonely', modelById('recraft-v3'))).not.toThrow()
  })
})
