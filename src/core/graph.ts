import type { GraphShape, NodeId } from './types'

export class CycleError extends Error {
  constructor(public readonly nodeIds: NodeId[]) {
    super(`Graph contains a cycle involving: ${nodeIds.join(', ')}`)
    this.name = 'CycleError'
  }
}

/**
 * Edges pointing at nodes that no longer exist are dropped rather than trusted.
 * A delete that leaves a dangling edge must not resurrect a phantom node into
 * the run order.
 */
function liveEdges({ nodeIds, edges }: GraphShape) {
  const known = new Set(nodeIds)
  return edges.filter((e) => known.has(e.from) && known.has(e.to))
}

function adjacency(graph: GraphShape, direction: 'down' | 'up') {
  const out = new Map<NodeId, NodeId[]>(graph.nodeIds.map((id) => [id, []]))
  for (const e of liveEdges(graph)) {
    const [from, to] = direction === 'down' ? [e.from, e.to] : [e.to, e.from]
    out.get(from)!.push(to)
  }
  return out
}

/**
 * Kahn's algorithm. Execution order for the executor.
 *
 * Ties break on the caller's `nodeIds` order, so the same flow always runs in
 * the same order — a run that reorders itself between invocations makes a cost
 * ledger impossible to compare.
 */
export function topoOrder(graph: GraphShape): NodeId[] {
  const children = adjacency(graph, 'down')
  const indegree = new Map<NodeId, number>(graph.nodeIds.map((id) => [id, 0]))
  for (const e of liveEdges(graph)) indegree.set(e.to, indegree.get(e.to)! + 1)

  const ready = graph.nodeIds.filter((id) => indegree.get(id) === 0)
  const order: NodeId[] = []

  while (ready.length > 0) {
    const id = ready.shift()!
    order.push(id)
    for (const child of children.get(id)!) {
      const remaining = indegree.get(child)! - 1
      indegree.set(child, remaining)
      if (remaining === 0) ready.push(child)
    }
  }

  if (order.length !== graph.nodeIds.length) {
    throw new CycleError(graph.nodeIds.filter((id) => indegree.get(id)! > 0))
  }
  return order
}

function walk(graph: GraphShape, start: NodeId, direction: 'down' | 'up'): Set<NodeId> {
  const next = adjacency(graph, direction)
  const seen = new Set<NodeId>()
  const stack = [...(next.get(start) ?? [])]

  // `seen` doubles as the cycle guard: the canvas calls this on every keystroke,
  // so it must terminate even if a cycle slipped past wiring validation.
  while (stack.length > 0) {
    const id = stack.pop()!
    if (seen.has(id)) continue
    seen.add(id)
    stack.push(...(next.get(id) ?? []))
  }
  return seen
}

/** Every node downstream of an edit. Powers stale propagation and its price tag. */
export const descendants = (graph: GraphShape, id: NodeId) => walk(graph, id, 'down')

/** Every node upstream. Feeds `upstreamHashes` when hashing a node. */
export const ancestors = (graph: GraphShape, id: NodeId) => walk(graph, id, 'up')
