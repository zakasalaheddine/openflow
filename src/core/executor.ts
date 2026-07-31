import { randomUUID } from 'node:crypto'
import { eq, and, inArray } from 'drizzle-orm'
import type { BetterSQLite3Database } from 'drizzle-orm/better-sqlite3'
import { projects, flows, sources, nodeRuns } from '../db/schema'
import { inputHash } from './hash'
import { hashableConfig } from './hashable'
import { topoOrder, ancestors } from './graph'
import { previewRun } from './preview'
import { DEFAULT_SETTINGS, type ProjectSettings } from './settings'
import { referencesOf } from './wiring'
import { composePrompt } from './compose'
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

  const library = new Map(
    db
      .select()
      .from(sources)
      .where(eq(sources.projectId, flow.projectId))
      .all()
      .map((row) => [row.id, row] as const),
  )

  return { graph: flow.graphJson as Flow, settings, library }
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
  const { graph, library } = loadContext(db, flowId)
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

    // Whitelisted, never `{ id, type, ...rest }`: the canvas stores `position`
    // on every node and a blacklist would make dragging a node re-bill its
    // whole subtree. See core/hashable.ts.
    const config = hashableConfig(node)

    if (!isRunnable(node)) {
      // A source node folds in its row's version, which is the one place a hash
      // depends on something outside graph_json. That is what makes replacing a
      // product's files invalidate every shot built from it.
      const version = node.type === 'source' ? (library.get(node.sourceId)?.version ?? 0) : 0
      hashes.set(
        nodeId,
        inputHash({
          nodeType: node.type,
          config: { ...config, ...(node.type === 'source' ? { version } : {}) },
          upstreamHashes,
          modelId: '',
        }),
      )
      continue
    }

    const model = resolveModel(node.type === 'image' ? 'image' : 'video', options.role ?? node.modelRole)
    // References arrive as wires now, so the count comes from the graph.
    assertAnchorsSupported(model, referencesOf(graph, nodeId))

    const hash = inputHash({
      nodeType: node.type,
      // The composed prompt is what is actually sent, so it is what is hashed —
      // editing a wired-in text fragment must invalidate every shot using it.
      config: { ...config, prompt: composePrompt(graph, nodeId, library) },
      upstreamHashes,
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
 *
 * `only` narrows the run to one node and the ancestors it needs. Not the node
 * alone: a clip whose start frame was never rendered would dispatch as
 * text-to-video and be billed in full for a frame it never saw.
 */
export function enqueueRun(
  db: Db,
  flowId: string,
  options: { role?: ModelRole; confirmOverspend?: boolean; only?: NodeId } = {},
): EnqueueResult {
  const { settings, graph } = loadContext(db, flowId)

  // Same derivation the toolbar shows. One function, so the quoted price and
  // the charged price cannot drift apart.
  const preview = previewRun(db, flowId, options)
  let { stale: enqueued, cached } = preview
  let { estimatedCents } = preview

  if (options.only) {
    const shape = { nodeIds: graph.nodes.map((n) => n.id), edges: graph.edges }
    const wanted = new Set<NodeId>([options.only, ...ancestors(shape, options.only)])
    enqueued = enqueued.filter((p) => wanted.has(p.nodeId))
    cached = cached.filter((p) => wanted.has(p.nodeId))
    // Re-derived, and before the cap: quoting the whole graph's price for one
    // node makes a $0.40 click demand confirmation against a $50 cap.
    estimatedCents = enqueued.reduce((sum, p) => sum + p.estimatedCents, 0)
  }

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
