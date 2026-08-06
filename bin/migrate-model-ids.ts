#!/usr/bin/env tsx
/**
 * One-shot: `npm run migrate:model-ids`
 *
 * Nodes used to carry `modelRole: 'draft' | 'hero' | 'specialist'`, and the role
 * rode into `input_hash` as part of the node's config. They now carry `modelId`,
 * and the config no longer names a model at all — `inputHash` already folds the
 * resolved id in as its own field.
 *
 * Every hash therefore changed, which without this would grey out every node you
 * have already rendered and re-bill the lot on the next Run. This rewrites the
 * graphs and re-points the runs that paid for them.
 *
 * Idempotent: a second run finds no `modelRole` and rewrites nothing.
 *
 * ponytail: a script, not a migration framework. db/index.ts creates its schema
 * from DDL and its comment says to reach for drizzle-kit the first time a
 * shipped database needs altering — this alters data, not schema, and adopting
 * a framework for one rewrite is more machinery than the rewrite.
 */
import { and, eq } from 'drizzle-orm'
import { openDb } from '../src/db'
import { flows, nodeRuns, sources } from '../src/db/schema'
import { topoOrder } from '../src/core/graph'
import { composePrompt } from '../src/core/compose'
import { inputHash, type JsonValue } from '../src/core/hash'
import { planRun } from '../src/core/executor'
import { loadDotEnv, dataDir } from '../src/env'
import type { Flow, FlowNode, NodeId } from '../src/core/types'

loadDotEnv()

/**
 * FROZEN. Do not import the live table — after the swap it does not exist, and
 * a lookup that resolved through today's catalog would map a role to whatever
 * models.json now calls its default. These are the six rows that shipped, which
 * is what the runs in the database were actually charged against.
 */
const ROLE_TO_ID = {
  image: { draft: 'flux-2-pro', hero: 'nano-banana-pro', specialist: 'recraft-v3' },
  video: { draft: 'hailuo-2-3-pro', hero: 'veo-3-1', specialist: 'kling-3-pro' },
} as const

type OldRole = keyof (typeof ROLE_TO_ID)['image']
type OldNode = FlowNode & { modelRole?: OldRole }

/**
 * FROZEN too: hashableConfig as it was, with the role still in it. Importing the
 * current one would compute the new shape on both sides of the comparison, match
 * nothing, rewrite nothing, and report success — the quietest possible failure.
 */
function oldHashableConfig(node: OldNode): Record<string, JsonValue> {
  switch (node.type) {
    case 'source':
      return { sourceId: node.sourceId }
    case 'image':
      return { prompt: node.prompt, modelRole: node.modelRole as string }
    case 'video':
      return {
        prompt: node.prompt,
        modelRole: node.modelRole as string,
        durationSec: node.durationSec,
        audio: node.audio,
      }
    case 'export':
      return {
        formats: node.formats as unknown as JsonValue,
        fps: node.fps,
        codec: node.codec,
        overlay: (node.overlay ?? null) as unknown as JsonValue,
      }
  }
}

const isRunnable = (node: OldNode) => node.type === 'image' || node.type === 'video'
const formatOf = (node: OldNode) => (node.type === 'image' ? 'image' : 'video')

/**
 * planRun's hashing walk, in the old shape.
 *
 * Duplicated rather than parameterised: this is the only caller that will ever
 * want the old shape, and threading a flag through the executor to serve a
 * one-shot script would leave the flag behind forever.
 */
function oldHashes(graph: Flow, library: Map<string, { version: number }>) {
  const byId = new Map(graph.nodes.map((n) => [n.id, n as OldNode]))
  const order = topoOrder({ nodeIds: graph.nodes.map((n) => n.id), edges: graph.edges })
  const hashes = new Map<NodeId, string>()

  for (const nodeId of order) {
    const node = byId.get(nodeId)
    if (!node) continue

    const upstreamHashes = graph.edges
      .filter((e) => e.to === nodeId)
      .map((e) => hashes.get(e.from))
      .filter((h): h is string => h !== undefined)

    const config = oldHashableConfig(node)

    if (!isRunnable(node)) {
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

    // A node without a role never had an old hash to find — it was written
    // after the swap — so it is skipped rather than guessed at.
    if (!node.modelRole) continue

    hashes.set(
      nodeId,
      inputHash({
        nodeType: node.type,
        config: { ...config, prompt: composePrompt(graph, nodeId, library as never) },
        upstreamHashes,
        modelId: ROLE_TO_ID[formatOf(node)][node.modelRole],
        ...(node.seed === undefined ? {} : { seed: node.seed }),
      }),
    )
  }

  return hashes
}

export function migrateModelIds(db: ReturnType<typeof openDb>) {
  let nodes = 0
  let runs = 0
  let unclaimed = 0

  for (const flow of db.select().from(flows).all()) {
    const graph = flow.graphJson as Flow
    const stale = graph.nodes.filter((n) => (n as OldNode).modelRole !== undefined)
    if (stale.length === 0) continue

    const library = new Map(
      db
        .select()
        .from(sources)
        .where(eq(sources.projectId, flow.projectId))
        .all()
        .map((row) => [row.id, row] as const),
    )
    const before = oldHashes(graph, library)

    const migrated: Flow = {
      ...graph,
      nodes: graph.nodes.map((node) => {
        const old = node as OldNode
        if (!old.modelRole) return node
        const { modelRole, ...rest } = old
        return { ...rest, modelId: ROLE_TO_ID[formatOf(old)][modelRole] } as FlowNode
      }),
    }

    // Written first: the new hashes are read back out of the executor against
    // the migrated graph, so there is one implementation of "what is this node's
    // hash now" rather than a second copy that can disagree with the app.
    db.update(flows).set({ graphJson: migrated }).where(eq(flows.id, flow.id)).run()
    nodes += stale.length

    // The app's own answer, read back off the migrated graph, so the hash a run
    // is re-pointed at is exactly the one Run will look for. One implementation
    // of "what is this node's hash now", not a second copy that can disagree.
    const planned = planRun(db, flow.id)

    for (const node of stale) {
      const oldHash = before.get(node.id)
      if (!oldHash) continue
      const newHash = planned.find((p) => p.nodeId === node.id)?.inputHash
      if (!newHash) continue

      const claimed = db
        .update(nodeRuns)
        .set({ inputHash: newHash })
        .where(
          and(
            eq(nodeRuns.flowId, flow.id),
            eq(nodeRuns.nodeId, node.id),
            eq(nodeRuns.inputHash, oldHash),
          ),
        )
        .run()

      runs += claimed.changes
      console.log(
        `[openflow] ${flow.id}/${node.id}: ${oldHash.slice(0, 12)} → ${newHash.slice(0, 12)}` +
          ` · ${claimed.changes} run(s)`,
      )
    }

    // Runs for nodes since deleted or edited keep their old hash and stay
    // unclaimed. Counted out loud rather than hidden: they are renders that were
    // paid for and will not be found again.
    unclaimed += db
      .select()
      .from(nodeRuns)
      .where(eq(nodeRuns.flowId, flow.id))
      .all()
      .filter((run) => [...before.values()].includes(run.inputHash)).length
  }

  return { nodes, runs, unclaimed }
}

if (process.argv[1]?.endsWith('migrate-model-ids.ts')) {
  const db = openDb()
  console.log(`[openflow] migrating ${dataDir()}`)
  const result = migrateModelIds(db)
  console.log(
    `[openflow] ${result.nodes} node(s) rewritten · ${result.runs} run(s) re-pointed · ` +
      `${result.unclaimed} run(s) left unclaimed`,
  )
}
