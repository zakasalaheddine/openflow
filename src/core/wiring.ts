import { topoOrder, CycleError } from './graph'
import { resolveModel, assertStartFrameSupported, type ModelSpec } from '../models/registry'
import type { Flow, FlowNode, Edge, NodeId, ModelRole } from './types'

export class WiringError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'WiringError'
  }
}

/**
 * Lets a caller resolve against a role override (the Draft·Hero toggle) or a
 * stubbed registry. Every shipped video row is image-to-video today, so without
 * this the start-frame gate would be untestable — and an untested gate is one
 * that quietly stops working before the row that needs it is ever added.
 */
export type ResolveModel = (format: 'image' | 'video', role: ModelRole) => ModelSpec

const defaultResolve: ResolveModel = (format, role) => resolveModel(format, role)

export type WireOptions = { role?: ModelRole; resolve?: ResolveModel }

/**
 * Edges carry meaning, and the meaning follows from the node types — so it is
 * inferred rather than picked in a dialog. An image feeding a video is that
 * image being frame zero of the clip; nothing else it could reasonably be.
 */
export function inferRole(from: FlowNode, to: FlowNode): Edge['role'] {
  if (from.type === 'image' && to.type === 'video') return 'start_frame'
  return 'input'
}

export function validateWire(
  flow: Flow,
  fromId: NodeId,
  toId: NodeId,
  options: WireOptions = {},
): Edge['role'] {
  const resolve = options.resolve ?? defaultResolve
  const from = flow.nodes.find((n) => n.id === fromId)
  const to = flow.nodes.find((n) => n.id === toId)

  if (!from) throw new WiringError(`No node ${fromId}`)
  if (!to) throw new WiringError(`No node ${toId}`)
  if (fromId === toId) throw new WiringError('A node cannot feed itself.')
  if (to.type === 'source') {
    throw new WiringError('A source node brings an existing file in; nothing feeds it.')
  }
  if (flow.edges.some((e) => e.from === fromId && e.to === toId)) {
    throw new WiringError(`${fromId} already feeds ${toId}.`)
  }

  const role = inferRole(from, to)

  if (role === 'start_frame') {
    // Exactly one frame zero. Two start frames would silently pick one, and the
    // clip that came back would look like a model failure.
    if (flow.edges.some((e) => e.to === toId && e.role === 'start_frame')) {
      throw new WiringError(`${toId} already has a start frame.`)
    }
    // Refused here, not ignored at render time: rendering a clip that dropped
    // its own first frame still costs full price.
    assertStartFrameSupported(resolve('video', options.role ?? (to as { modelRole: ModelRole }).modelRole))
  }

  // Cheaper to detect on the candidate graph than to explain a cycle later.
  const candidate = { nodeIds: flow.nodes.map((n) => n.id), edges: [...flow.edges, edgeFor(fromId, toId, role)] }
  try {
    topoOrder(candidate)
  } catch (error) {
    if (error instanceof CycleError) throw new WiringError('That wire would create a cycle.')
    throw error
  }

  return role
}

const edgeFor = (from: NodeId, to: NodeId, role: Edge['role']): Edge => ({
  // Web Crypto, not node:crypto. This module runs in the browser as well as on
  // the server — the canvas calls applyWire directly — and a `node:crypto`
  // import made every wiring attempt throw in the browser. The failure was
  // invisible because it was neither of the two errors onConnect catches.
  id: globalThis.crypto.randomUUID(),
  from,
  to,
  role,
  // Reserved for v2 sequence ordering; every other node treats inputs as a set.
  position: null,
})

/** Returns a new flow. The canvas re-reads graph_json, so mutating would desync the view. */
export function applyWire(flow: Flow, fromId: NodeId, toId: NodeId, options: WireOptions = {}): Flow {
  const role = validateWire(flow, fromId, toId, options)
  return { ...flow, edges: [...flow.edges, edgeFor(fromId, toId, role)] }
}

export const removeEdge = (flow: Flow, edgeId: string): Flow => ({
  ...flow,
  edges: flow.edges.filter((e) => e.id !== edgeId),
})

/** Removing a node takes its edges with it, or the graph keeps dangling references. */
export const removeNode = (flow: Flow, nodeId: NodeId): Flow => ({
  nodes: flow.nodes.filter((n) => n.id !== nodeId),
  edges: flow.edges.filter((e) => e.from !== nodeId && e.to !== nodeId),
})
