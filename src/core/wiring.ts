import { topoOrder, CycleError } from './graph'
import { assertStartFrameSupported, assertAnchorsSupported, type ModelSpec } from '../models/registry'
import type { Flow, FlowNode, Edge, NodeId } from './types'

export class WiringError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'WiringError'
  }
}

/**
 * How this file learns what a model can do.
 *
 * Injected rather than imported, for two reasons. The catalog reads a file, and
 * this module is imported by the canvas — importing it here would drag node:fs
 * into the browser bundle. And every shipped video row accepts a start frame
 * today, so a stub is the only way to keep the start-frame refusal tested,
 * which matters most on the day a text-to-video row is added.
 *
 * Only `id` and `caps` are read, so the trimmed rows the flow route sends the
 * canvas satisfy it as-is.
 */
export type ModelLike = Pick<ModelSpec, 'id' | 'caps'>
export type ResolveModel = (id: string) => ModelLike

export type WireOptions = { resolve?: ResolveModel }

/**
 * A wire into a generator is priced work, so it is gated on what the model can
 * accept. No resolver, no gate — and a gate that silently does not run is worse
 * than one that refuses, so its absence is the refusal.
 */
const gateWith = (options: WireOptions): ResolveModel => {
  if (!options.resolve) {
    throw new WiringError('This wire needs the model catalog to check it. Pass `resolve`.')
  }
  return options.resolve
}

/**
 * Edges carry meaning, and the meaning follows from the node types — so it is
 * inferred rather than picked in a dialog. An image feeding a video is that
 * image being frame zero of the clip; nothing else it could reasonably be.
 */
export function inferRole(from: FlowNode, to: FlowNode): Edge['role'] {
  // An asset feeding a generator is a reference the model must honour — what
  // anchors used to mean, now visible as a wire instead of hidden in a chip.
  if (from.type === 'source' && (to.type === 'image' || to.type === 'video')) return 'reference'
  if (from.type === 'image' && to.type === 'video') return 'start_frame'
  return 'input'
}

/** Sources already wired into a node as references. */
export const referencesOf = (flow: Flow, nodeId: NodeId): NodeId[] =>
  flow.edges.filter((e) => e.to === nodeId && e.role === 'reference').map((e) => e.from)

export function validateWire(
  flow: Flow,
  fromId: NodeId,
  toId: NodeId,
  options: WireOptions = {},
): Edge['role'] {
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

  if (role === 'reference') {
    // Refused here, not silently dropped at render time: an ignored reference
    // produces off-brand output that reads as a model quality problem, and
    // nobody ever learns the asset was never sent.
    const model = gateWith(options)((to as { modelId: string }).modelId)
    assertAnchorsSupported(model, [...referencesOf(flow, toId), fromId])
  }

  if (role === 'start_frame') {
    // Exactly one frame zero. Two start frames would silently pick one, and the
    // clip that came back would look like a model failure.
    if (flow.edges.some((e) => e.to === toId && e.role === 'start_frame')) {
      throw new WiringError(`${toId} already has a start frame.`)
    }
    // Refused here, not ignored at render time: rendering a clip that dropped
    // its own first frame still costs full price.
    assertStartFrameSupported(gateWith(options)((to as { modelId: string }).modelId))
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
  // Deterministic, not random — the same reason agent/ops.ts's newId is
  // deterministic: this id rides into the next model prompt (agent/prompt.ts
  // embeds the whole graph, edges included), and LLM_MODE=replay's fixture
  // key hashes the whole request, so a random id makes every fixture after a
  // wire unrecordable.
  //
  // Derived from the endpoints alone: validateWire already refuses a second
  // edge between the same from→to pair (see the "already feeds" and "already
  // has a start frame" checks above), so the pair is already unique within a
  // flow for every role — reference (many froms, one to, each pair distinct),
  // start_frame (capped to one, but still one pair), input (same argument).
  // No `node:crypto` here either: this module runs in the browser as well as
  // on the server — the canvas calls applyWire directly — and a `node:crypto`
  // import made every wiring attempt throw in the browser. The failure was
  // invisible because it was neither of the two errors onConnect catches.
  id: `${from}->${to}`,
  from,
  to,
  role,
  // Reserved for v2 sequence ordering; every other node treats inputs as a set.
  position: null,
})

/**
 * The same gate applyWire runs, aimed the other way.
 *
 * Wiring asks "may this edge join a node on that model"; changing a model asks
 * "may this model take the edges this node already has". Both refuse rather
 * than absorb: dropping the wires would silently delete graph you drew, and
 * letting it through would buy a render that ignored your anchors at full price.
 */
export function assertModelFits(flow: Flow, nodeId: NodeId, model: ModelLike) {
  assertAnchorsSupported(model, referencesOf(flow, nodeId))
  if (flow.edges.some((e) => e.to === nodeId && e.role === 'start_frame')) {
    assertStartFrameSupported(model)
  }
}

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
