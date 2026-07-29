import { randomUUID } from 'node:crypto'
import { eq, and, inArray } from 'drizzle-orm'
import type { BetterSQLite3Database } from 'drizzle-orm/better-sqlite3'
import { projects, flows, anchors, nodeRuns } from '../db/schema'
import { inputHash, type JsonValue } from './hash'
import { topoOrder } from './graph'
import { DEFAULT_SETTINGS, type ProjectSettings } from './settings'
import type { Flow, FlowNode, ModelRole, NodeId } from './types'
import { resolveModel, assertAnchorsSupported, estimateCostCents } from '../models/registry'

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Db = BetterSQLite3Database<any>

/** Statuses that mean money is already committed to this hash. */
export const IN_FLIGHT = ['queued', 'claimed', 'submitted', 'polling'] as const

/** Default render size for a per-megapixel cost estimate before dimensions exist. */
const ESTIMATE_PIXELS = { width: 1024, height: 1024 }

export class SpendCapExceededError extends Error {
  constructor(
    readonly estimatedCents: number,
    readonly capCents: number,
  ) {
    super(
      `Run would cost about $${(estimatedCents / 100).toFixed(2)}, over the $${(capCents / 100).toFixed(2)} cap. Confirm to proceed.`,
    )
    this.name = 'SpendCapExceededError'
  }
}

export type PlannedNode = {
  nodeId: NodeId
  inputHash: string
  modelId: string
  estimatedCents: number
}

/** Only image and video nodes dispatch. Source brings files in; export writes them out. */
const isRunnable = (node: FlowNode): node is Extract<FlowNode, { modelRole: ModelRole }> =>
  node.type === 'image' || node.type === 'video'

function loadContext(db: Db, flowId: string) {
  const flow = db.select().from(flows).where(eq(flows.id, flowId)).get()
  if (!flow) throw new Error(`No flow ${flowId}`)

  const project = db.select().from(projects).where(eq(projects.id, flow.projectId)).get()
  const settings: ProjectSettings = { ...DEFAULT_SETTINGS, ...(project?.settings as ProjectSettings) }

  const anchorVersions = new Map(
    db
      .select()
      .from(anchors)
      .where(eq(anchors.projectId, flow.projectId))
      .all()
      .map((a) => [a.id, a.version] as const),
  )

  return { graph: flow.graphJson as Flow, settings, anchorVersions }
}

/**
 * Walks the graph in topological order and derives every node's input hash.
 *
 * Hashes are chained through `upstreamHashes`, which is what makes a re-render
 * of a parent invalidate its children for free. Capability gating happens here,
 * before anything is written, so an impossible graph is refused rather than
 * half-executed.
 */
export function planRun(
  db: Db,
  flowId: string,
  options: { role?: ModelRole } = {},
): PlannedNode[] {
  const { graph, anchorVersions } = loadContext(db, flowId)
  const byId = new Map(graph.nodes.map((n) => [n.id, n]))
  const order = topoOrder({ nodeIds: graph.nodes.map((n) => n.id), edges: graph.edges })

  const hashes = new Map<NodeId, string>()
  const planned: PlannedNode[] = []

  for (const nodeId of order) {
    const node = byId.get(nodeId)
    if (!node) continue

    const upstreamHashes = graph.edges
      .filter((e) => e.to === nodeId)
      .map((e) => hashes.get(e.from))
      .filter((h): h is string => h !== undefined)

    const nodeAnchors = 'anchors' in node ? node.anchors : []
    const versions = nodeAnchors.map((id) => anchorVersions.get(id) ?? 0)

    const { id: _id, type: _type, ...config } = node

    if (!isRunnable(node)) {
      // Still hashed: an export node's config feeds nothing downstream today,
      // but a source node's assets must invalidate the images built from them.
      hashes.set(
        nodeId,
        inputHash({
          nodeType: node.type,
          config: config as Record<string, JsonValue>,
          upstreamHashes,
          anchorVersions: versions,
          modelId: '',
        }),
      )
      continue
    }

    const model = resolveModel(node.type === 'image' ? 'image' : 'video', options.role ?? node.modelRole)
    assertAnchorsSupported(model, nodeAnchors)

    const hash = inputHash({
      nodeType: node.type,
      config: config as Record<string, JsonValue>,
      upstreamHashes,
      anchorVersions: versions,
      modelId: model.id,
      ...(node.seed === undefined ? {} : { seed: node.seed }),
    })
    hashes.set(nodeId, hash)

    planned.push({
      nodeId,
      inputHash: hash,
      modelId: model.id,
      estimatedCents: estimateCostCents(model, {
        ...ESTIMATE_PIXELS,
        ...(node.type === 'video' ? { durationSec: node.durationSec } : {}),
      }),
    })
  }

  return planned
}

export type EnqueueResult = {
  enqueued: PlannedNode[]
  cached: PlannedNode[]
  estimatedCents: number
}

/**
 * Enqueues everything not already satisfied or in flight.
 *
 * The spend check runs before the first insert. Blocking afterwards would leave
 * rows behind that a restarting worker picks up and spends against — the exact
 * accident the cap exists to prevent.
 */
export function enqueueRun(
  db: Db,
  flowId: string,
  options: { role?: ModelRole; confirmOverspend?: boolean } = {},
): EnqueueResult {
  const { settings } = loadContext(db, flowId)
  const planned = planRun(db, flowId, options)

  const hashes = planned.map((p) => p.inputHash)
  const existing = hashes.length
    ? db.select().from(nodeRuns).where(inArray(nodeRuns.inputHash, hashes)).all()
    : []

  // Only a success satisfies a hash. Treating a failure as a cache hit would
  // let one content-policy refusal poison a node permanently.
  const satisfied = new Set(existing.filter((r) => r.status === 'succeeded').map((r) => r.inputHash))
  const inFlight = new Set(
    existing.filter((r) => (IN_FLIGHT as readonly string[]).includes(r.status)).map((r) => r.inputHash),
  )

  const cached = planned.filter((p) => satisfied.has(p.inputHash))
  const enqueued = planned.filter((p) => !satisfied.has(p.inputHash) && !inFlight.has(p.inputHash))
  const estimatedCents = enqueued.reduce((sum, p) => sum + p.estimatedCents, 0)

  if (!options.confirmOverspend && estimatedCents > settings.spendCapPerRun) {
    throw new SpendCapExceededError(estimatedCents, settings.spendCapPerRun)
  }

  const createdAt = new Date().toISOString()
  for (const p of enqueued) {
    db.insert(nodeRuns)
      .values({
        // Not derived from the hash: a node that failed and is being retried
        // needs its own row, so the ledger keeps both attempts.
        id: randomUUID(),
        flowId,
        nodeId: p.nodeId,
        inputHash: p.inputHash,
        status: 'queued',
        modelId: p.modelId,
        costCents: 0,
        attempt: 0,
        createdAt,
      })
      .run()
  }

  return { enqueued, cached, estimatedCents }
}

/** Runs whose hash is satisfied by a previous success — the $0 second run. */
export function cachedOutputs(db: Db, hashes: string[]) {
  if (hashes.length === 0) return []
  return db
    .select()
    .from(nodeRuns)
    .where(and(inArray(nodeRuns.inputHash, hashes), eq(nodeRuns.status, 'succeeded')))
    .all()
}
