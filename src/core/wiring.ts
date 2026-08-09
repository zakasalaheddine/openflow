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
  // A rendered still into another still is a reference too. This is what makes a
  // character sheet possible: generate the sheet once, then wire it into every
  // shot so the same face arrives with each prompt. Before this the edge existed
  // and meant nothing — the wire drew, the hash chained, and the file was never
  // sent, so the shot came back as a different person at full price.
  if (from.type === 'image' && to.type === 'image') return 'reference'
  // Deliberately NOT a reference, even on a video model that accepts them: a
  // still into a clip has meant frame zero since v1, and one wire that means
  // two things is a wire whose meaning you have to guess. An explicit role —
  // a second handle on the card — is what that would need.
  if (from.type === 'image' && to.type === 'video') return 'start_frame'
  return 'input'
}

/**
 * Nodes already wired into this one as references, in edge order.
 *
 * Order is the payload order — `image_urls` is a list, and a model reads the
 * first reference as the strongest. Edge order is persisted, so this is stable.
 *
 * ponytail: a text source counts against the model's `refImages` budget here
 * even though it contributes a prompt fragment and never an image. That refuses
 * a legal graph — a written character description plus four sheet stills is
 * five against `flux-2-pro`'s four — rather than rendering a wrong one, so it is
 * safe but wrong. Fixing it needs the source *kind* at wiring time, which means
 * threading the library through the canvas's `applyWire`; do that when a model
 * with a small budget turns out to be the right one for faces.
 */
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
  if (to.type === 'sequence' && from.type !== 'video') {
    // A cut is made of clips. A still into it would have to become a clip of
    // some invented length, and inventing a length is a decision the person
    // making the film should make on a video node, where it is priced.
    throw new WiringError('A sequence cuts clips together. Only a video node can feed one.')
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
  const candidate = {
    nodeIds: flow.nodes.map((n) => n.id),
    edges: [...flow.edges, edgeFor(fromId, toId, role, positionFor(flow, to))],
  }
  try {
    topoOrder(candidate)
  } catch (error) {
    if (error instanceof CycleError) throw new WiringError('That wire would create a cycle.')
    throw error
  }

  return role
}

/**
 * Where a clip lands in a cut: at the end, which is where a shot you just wired
 * belongs. Reorder afterwards with `reorderSequence`.
 *
 * `null` everywhere else. Every other node treats its inputs as a set, and a
 * number nobody reads is a number that will eventually be believed.
 */
const positionFor = (flow: Flow, to: FlowNode): number | null =>
  to.type === 'sequence' ? sequenceInputs(flow, to.id).length : null

/**
 * The clips feeding a cut, in the order they will be shown.
 *
 * Filtered on the role, like every other reader here — `applyWire` can only
 * make an `input` edge into a sequence, but a template or a hand-written flow
 * file writes its edges straight into `graph_json`, and `flowSchema` validates
 * that the role is one of the four, never that it suits the pair of nodes it
 * joins. Without this, a mistyped role in a template lands silently in the film.
 */
export const sequenceInputs = (flow: Flow, sequenceId: NodeId): NodeId[] =>
  flow.edges
    .filter((e) => e.to === sequenceId && e.role === 'input')
    // Ties broken by edge order so the result is total and stable — a hand-written
    // flow file can leave every position null and still cut in a defined order.
    .map((e, index) => ({ from: e.from, at: e.position ?? index, index }))
    .sort((a, b) => a.at - b.at || a.index - b.index)
    .map((e) => e.from)

/**
 * How long the film would be, and out of how many shots.
 *
 * From the clips' own `durationSec`, not from anything rendered: the whole
 * reason to know this is to budget a sixty-second piece before paying for it,
 * and every video row caps out at eight or ten seconds, so the arithmetic is
 * the difference between eleven shots and a guess. What the file actually
 * measures is checked again at export, against the format's own limit.
 */
export function sequenceRuntime(flow: Flow, sequenceId: NodeId) {
  const byId = new Map(flow.nodes.map((n) => [n.id, n]))
  const clips = sequenceInputs(flow, sequenceId)
    .map((id) => byId.get(id))
    .filter((node) => node?.type === 'video')

  return {
    clipCount: clips.length,
    seconds: clips.reduce((total, clip) => total + (clip?.type === 'video' ? clip.durationSec : 0), 0),
  }
}

/**
 * Rewrites the order of a cut. Every clip currently feeding it must appear
 * exactly once — a partial order would silently drop a shot you paid for.
 */
export function reorderSequence(flow: Flow, sequenceId: NodeId, order: NodeId[]): Flow {
  const current = sequenceInputs(flow, sequenceId)
  const same =
    current.length === order.length && current.every((id) => order.filter((o) => o === id).length === 1)
  if (!same) {
    throw new WiringError('That order does not list every clip in this sequence exactly once.')
  }

  return {
    ...flow,
    edges: flow.edges.map((edge) =>
      edge.to === sequenceId ? { ...edge, position: order.indexOf(edge.from) } : edge,
    ),
  }
}

const edgeFor = (from: NodeId, to: NodeId, role: Edge['role'], position: number | null): Edge => ({
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
  // Where this input sits in a cut. Null everywhere else — see positionFor.
  position,
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
  const to = flow.nodes.find((n) => n.id === toId)!
  return { ...flow, edges: [...flow.edges, edgeFor(fromId, toId, role, positionFor(flow, to))] }
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
