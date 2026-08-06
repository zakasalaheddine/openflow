import { NextResponse } from 'next/server'
import { eq, inArray } from 'drizzle-orm'
import { getDb } from '@/db'
import { flows, nodeRuns, assets } from '@/db/schema'
import { ensureWorkspace, saveGraphIfCurrent, StaleGraphError, listSources } from '@/core/workspace'
import { previewRun } from '@/core/preview'
import { flowSchema } from '@/core/schema'
import { catalog } from '@/models/catalog'
import type { Flow } from '@/core/types'

export const dynamic = 'force-dynamic'

/**
 * The canvas is a *view* of graph_json. This route is the whole contract:
 * read the graph plus everything derived from it, write the graph back.
 * Derived state (stale set, prices, run status) is never sent by the client —
 * a client that could set its own prices could quote whatever it liked.
 */
export async function GET() {
  const db = getDb()
  const { projectId, flowId } = ensureWorkspace(db)
  const flow = db.select().from(flows).where(eq(flows.id, flowId)).get()!
  const graph = flow.graphJson as Flow
  const preview = previewRun(db, flowId)

  const runs = db.select().from(nodeRuns).where(eq(nodeRuns.flowId, flowId)).all()
  const refs = runs.flatMap((r) => (r.outputRefs as string[] | null) ?? [])
  const outputs = refs.length
    ? db.select().from(assets).where(inArray(assets.id, refs)).all()
    : []
  const assetById = new Map(outputs.map((a) => [a.id, a]))

  // Latest run per (node, hash), not per node alone: the newest row for a
  // node can belong to a different config than the one on screen (a model
  // switched back after a render on the other one), and picking newest-by-node-only
  // then filtering on hash left nothing — the card read "succeeded"
  // (previewRun matches hashes across all runs) while showing no image and no
  // cost, because the run this map returned was for the wrong hash entirely.
  const latest = new Map<string, (typeof runs)[number]>()
  for (const run of runs) {
    const key = `${run.nodeId}:${run.inputHash}`
    const current = latest.get(key)
    if (!current || run.createdAt > current.createdAt) latest.set(key, run)
  }

  return NextResponse.json({
    projectId,
    flowId,
    updatedAt: flow.updatedAt,
    graph,
    // The picker's list comes from here, never from the client: a client that
    // could invent a model could name an endpoint nobody priced.
    models: catalog()
      .filter((m) => m.format !== 'text')
      .map((m) => ({ id: m.id, format: m.format, default: m.default, caps: m.caps, cost: m.cost })),
    sources: listSources(db, projectId),
    nodes: Object.fromEntries(
      graph.nodes.map((node) => {
        const planned = [...preview.stale, ...preview.cached, ...preview.inFlight].find(
          (p) => p.nodeId === node.id,
        )
        // Matched on inputHash, never just nodeId — the same rule exporter.ts's
        // currentRun follows. Node ids are deterministic now (agent/ops.ts's
        // newId recycles a freed suffix), so a stale run for a deleted node can
        // otherwise resurface under the next node built with that same id: its
        // render, its cost and its error, on a card that never rendered.
        const currentRun = latest.get(`${node.id}:${planned?.inputHash}`)
        return [
          node.id,
          {
            status: preview.cached.some((c) => c.nodeId === node.id)
              ? 'succeeded'
              : preview.inFlight.some((f) => f.nodeId === node.id)
                ? (currentRun?.status ?? 'queued')
                : (currentRun?.status === 'failed' ? 'failed' : 'stale'),
            error: currentRun?.error ?? null,
            costCents: currentRun?.costCents ?? 0,
            estimatedCents: Math.round(planned?.estimatedCents ?? 0),
            modelId: planned?.modelId ?? null,
            subtree: (() => {
              const s = preview.subtreeCents(node.id)
              return { nodeCount: s.nodeCount, cents: Math.round(s.cents) }
            })(),
            outputs: ((currentRun?.outputRefs as string[] | null) ?? [])
              .map((id) => assetById.get(id))
              .filter(Boolean)
              .map((a) => ({ id: a!.id, url: `/assets/${a!.id}`, mime: a!.mime })),
          },
        ]
      }),
    ),
    totals: {
      staleCount: preview.stale.length,
      // A node whose render is queued or polling is neither stale nor done.
      // Folding it into either one makes the toolbar say "all rendered" while
      // fal is still working, and an export taken at that moment ships nothing.
      runningCount: preview.inFlight.length,
      // Rounded here, not in the estimator: full precision internally keeps a
      // sum of many sub-cent nodes accurate, but the UI must never print
      // "$4.594371".
      estimatedCents: Math.round(preview.estimatedCents),
      spentCents: runs.reduce((sum, r) => sum + r.costCents, 0),
    },
  })
}

export async function PATCH(request: Request) {
  const db = getDb()
  const { flowId } = ensureWorkspace(db)
  const body = (await request.json().catch(() => ({}))) as { graph?: unknown; updatedAt?: string }

  // Validated, not trusted. graph_json is the source of truth for what gets
  // dispatched and billed, so a malformed graph must be rejected at the door
  // rather than blowing up inside the worker.
  const parsed = flowSchema.safeParse(body.graph)
  if (!parsed.success) {
    return NextResponse.json({ error: parsed.error.issues[0]?.message ?? 'Invalid graph' }, { status: 400 })
  }
  if (typeof body.updatedAt !== 'string') {
    return NextResponse.json({ error: 'Missing the read this write was built on' }, { status: 400 })
  }

  try {
    const updatedAt = saveGraphIfCurrent(db, flowId, parsed.data as Flow, body.updatedAt)
    return NextResponse.json({ updatedAt })
  } catch (error) {
    // 409, not 400: the client's graph was well formed, it is just no longer
    // built on the newest state. Re-read and re-apply is the whole recovery.
    if (error instanceof StaleGraphError) {
      return NextResponse.json({ error: error.message }, { status: 409 })
    }
    throw error
  }
}
