import { eq, inArray } from 'drizzle-orm'
import type { BetterSQLite3Database } from 'drizzle-orm/better-sqlite3'
import { flows, nodeRuns } from '../db/schema'
import { planRun, IN_FLIGHT, type PlannedNode } from './executor'
import { descendants } from './graph'
import type { Flow, NodeId } from './types'

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Db = BetterSQLite3Database<any>

export type Preview = {
  stale: PlannedNode[]
  cached: PlannedNode[]
  inFlight: PlannedNode[]
  estimatedCents: number
  /** Cost of everything downstream of one node — hover a shot, price its branch. */
  subtreeCents(nodeId: NodeId): { nodeCount: number; cents: number }
}

/**
 * What a Run would do, without doing it.
 *
 * Deliberately the same derivation `enqueueRun` uses, so the toolbar cannot
 * quote a number the executor then disagrees with. Two implementations of "what
 * would this cost" is how a UI ends up promising $11.40 and charging $19.
 */
export function previewRun(db: Db, flowId: string): Preview {
  const planned = planRun(db, flowId)
  const hashes = planned.map((p) => p.inputHash)

  const existing = hashes.length
    ? db.select().from(nodeRuns).where(inArray(nodeRuns.inputHash, hashes)).all()
    : []

  const satisfied = new Set(existing.filter((r) => r.status === 'succeeded').map((r) => r.inputHash))
  const running = new Set(
    existing.filter((r) => (IN_FLIGHT as readonly string[]).includes(r.status)).map((r) => r.inputHash),
  )

  const cached = planned.filter((p) => satisfied.has(p.inputHash))
  const inFlight = planned.filter((p) => running.has(p.inputHash))
  const stale = planned.filter((p) => !satisfied.has(p.inputHash) && !running.has(p.inputHash))

  const flow = db.select().from(flows).where(eq(flows.id, flowId)).get()
  const graph = (flow?.graphJson as Flow | undefined) ?? { nodes: [], edges: [] }
  const shape = { nodeIds: graph.nodes.map((n) => n.id), edges: graph.edges }
  const staleById = new Map(stale.map((s) => [s.nodeId, s]))

  return {
    stale,
    cached,
    inFlight,
    estimatedCents: stale.reduce((sum, p) => sum + p.estimatedCents, 0),
    subtreeCents(nodeId) {
      const below = [...descendants(shape, nodeId)]
        .map((id) => staleById.get(id))
        .filter((p): p is PlannedNode => p !== undefined)
      return {
        nodeCount: below.length,
        cents: below.reduce((sum, p) => sum + p.estimatedCents, 0),
      }
    },
  }
}

export type AffectedNode = PlannedNode & { flowId: string }

/**
 * Everything a new version of this asset would invalidate — across every flow
 * in the project, not just the one on screen.
 *
 * Scoping this per-flow is the tempting shortcut and it under-quotes the
 * refresh: the demo that sells the tool is eighteen nodes across *two*
 * campaigns greying out at once.
 */
export function staleForSource(
  db: Db,
  projectId: string,
  sourceId: string,
): AffectedNode[] {
  const projectFlows = db.select().from(flows).where(eq(flows.projectId, projectId)).all()
  const affected: AffectedNode[] = []

  for (const flow of projectFlows) {
    const graph = flow.graphJson as Flow
    const holders = graph.nodes
      .filter((n) => n.type === 'source' && n.sourceId === sourceId)
      .map((n) => n.id)
    if (holders.length === 0) continue

    const shape = { nodeIds: graph.nodes.map((n) => n.id), edges: graph.edges }
    const touched = new Set<NodeId>(holders)
    for (const id of holders) for (const child of descendants(shape, id)) touched.add(child)

    for (const planned of planRun(db, flow.id)) {
      if (touched.has(planned.nodeId)) affected.push({ ...planned, flowId: flow.id })
    }
  }

  return affected
}
