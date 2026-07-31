import { describe, test, expect } from 'vitest'
import { inferRole, validateWire, applyWire, WiringError } from '@/core/wiring'
import { UnsupportedCapabilityError, resolveModel, type ModelSpec } from '@/models/registry'
import type { Flow, FlowNode } from '@/core/types'

/**
 * Every video row shipped today is image-to-video, so the start-frame gate
 * would be vacuous against the real registry. Injecting the lookup keeps the
 * gate provably enforced for the day a text-to-video row is added — which is
 * the only time it matters and the worst time to discover it never worked.
 */
const withoutStartFrame = (format: 'image' | 'video', role: string): ModelSpec => ({
  ...resolveModel(format, role as 'draft'),
  caps: { ...resolveModel(format, role as 'draft').caps, startEndFrame: false },
})

const image = (id: string): FlowNode => ({
  id,
  type: 'image',
  prompt: 'bottle',
  anchors: [],
  modelRole: 'draft',
})

const video = (id: string, modelRole: 'draft' | 'hero' | 'specialist' = 'specialist'): FlowNode => ({
  id,
  type: 'video',
  prompt: 'push in',
  anchors: [],
  durationSec: 5,
  audio: false,
  modelRole,
})

const source = (id: string): FlowNode => ({ id, type: 'source', assets: [] })
const exportNode = (id: string): FlowNode => ({ id, type: 'export', formats: [] })

const flowOf = (...nodes: FlowNode[]): Flow => ({ nodes, edges: [] })

describe('inferRole', () => {
  test('image into video is a start frame', () => {
    // The edge means "this image is frame zero of that clip". That meaning is
    // the point of typed edges, so it must be inferred, not chosen in a dialog.
    expect(inferRole(image('a'), video('b'))).toBe('start_frame')
  })

  test('source into image is a plain input', () => {
    expect(inferRole(source('s'), image('a'))).toBe('input')
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
    expect(() => validateWire(flow, 'a', 'b')).not.toThrow()
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
    expect(() => validateWire(flow, 'a', 'a')).toThrow(WiringError)
  })

  test('refuses a wire that would create a cycle', () => {
    const flow: Flow = {
      nodes: [image('a'), video('b')],
      edges: [{ id: 'e1', from: 'a', to: 'b', role: 'start_frame', position: null }],
    }
    expect(() => validateWire(flow, 'b', 'a')).toThrow(WiringError)
  })

  test('refuses a duplicate edge', () => {
    const flow: Flow = {
      nodes: [image('a'), video('b')],
      edges: [{ id: 'e1', from: 'a', to: 'b', role: 'start_frame', position: null }],
    }
    expect(() => validateWire(flow, 'a', 'b')).toThrow(WiringError)
  })

  test('refuses an unknown node', () => {
    expect(() => validateWire(flowOf(image('a')), 'a', 'ghost')).toThrow(WiringError)
  })

  test('refuses a second start frame into the same video', () => {
    // A clip has exactly one frame zero. Two would silently pick one.
    const flow: Flow = {
      nodes: [image('a'), image('a2'), video('b')],
      edges: [{ id: 'e1', from: 'a', to: 'b', role: 'start_frame', position: null }],
    }
    expect(() => validateWire(flow, 'a2', 'b')).toThrow(WiringError)
  })

  test('refuses anything wired into a source node', () => {
    // A source brings an existing file in; nothing feeds it.
    const flow = flowOf(image('a'), source('s'))
    expect(() => validateWire(flow, 'a', 's')).toThrow(WiringError)
  })
})

describe('applyWire', () => {
  test('adds an edge with the inferred role', () => {
    const next = applyWire(flowOf(image('a'), video('b')), 'a', 'b')
    expect(next.edges).toHaveLength(1)
    expect(next.edges[0]).toMatchObject({ from: 'a', to: 'b', role: 'start_frame' })
  })

  test('leaves position null in v1', () => {
    // Reserved for v2 sequence ordering. Present so v2 needs no migration.
    const next = applyWire(flowOf(image('a'), video('b')), 'a', 'b')
    expect(next.edges[0].position).toBeNull()
  })

  test('does not mutate the input flow', () => {
    // The canvas re-reads graph_json after every change; a mutated input makes
    // the view and the stored graph disagree.
    const flow = flowOf(image('a'), video('b'))
    applyWire(flow, 'a', 'b')
    expect(flow.edges).toHaveLength(0)
  })

  test('supports one image fanning out to three clips', () => {
    // The core interaction. Three edges, no special case in the engine.
    let flow = flowOf(image('img'), video('push'), video('sweep'), video('tilt'))
    for (const to of ['push', 'sweep', 'tilt']) flow = applyWire(flow, 'img', to)

    expect(flow.edges).toHaveLength(3)
    expect(flow.edges.every((e) => e.role === 'start_frame')).toBe(true)
  })

  test('throws rather than adding an invalid edge', () => {
    expect(() =>
      applyWire(flowOf(image('a'), video('b')), 'a', 'b', { resolve: withoutStartFrame }),
    ).toThrow()
  })
})
