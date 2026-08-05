import { NextResponse } from 'next/server'
import { eq, inArray } from 'drizzle-orm'
import { getDb } from '@/db'
import { flows, nodeRuns, assets } from '@/db/schema'
import { ensureWorkspace, saveGraphIfCurrent, StaleGraphError, listSources } from '@/core/workspace'
import { previewRun } from '@/core/preview'
import { flowSchema } from '@/core/schema'
import type { Flow, ModelRole } from '@/core/types'

export const dynamic = 'force-dynamic'

/**
 * The canvas is a *view* of graph_json. This route is the whole contract:
 * read the graph plus everything derived from it, write the graph back.
 * Derived state (stale set, prices, run status) is never sent by the client —
 * a client that could set its own prices could quote whatever it liked.
 */
export async function GET(request: Request) {
  const db = getDb()
  const { projectId, flowId } = ensureWorkspace(db)
  const role = (new URL(request.url).searchParams.get('role') as ModelRole | null) ?? undefined

  const flow = db.select().from(flows).where(eq(flows.id, flowId)).get()!
  const graph = flow.graphJson as Flow
  const preview = previewRun(db, flowId, { role })

  const runs = db.select().from(nodeRuns).where(eq(nodeRuns.flowId, flowId)).all()
  const refs = runs.flatMap((r) => (r.outputRefs as string[] | null) ?? [])
  const outputs = refs.length
    ? db.select().from(assets).where(inArray(assets.id, refs)).all()
    : []
  const assetById = new Map(outputs.map((a) => [a.id, a]))

  // Latest run per node, so a retried node shows its current state rather than
  // whichever row the database happened to return first.
  const latest = new Map<string, (typeof runs)[number]>()
  for (const run of runs) {
    const current = latest.get(run.nodeId)
    if (!current || run.createdAt > current.createdAt) latest.set(run.nodeId, run)
  }

  return NextResponse.json({
    projectId,
    flowId,
    updatedAt: flow.updatedAt,
    graph,
    sources: listSources(db, projectId),
    nodes: Object.fromEntries(
      graph.nodes.map((node) => {
        const run = latest.get(node.id)
        const planned = [...preview.stale, ...preview.cached, ...preview.inFlight].find(
          (p) => p.nodeId === node.id,
        )
        return [
          node.id,
          {
            status: preview.cached.some((c) => c.nodeId === node.id)
              ? 'succeeded'
              : preview.inFlight.some((f) => f.nodeId === node.id)
                ? (run?.status ?? 'queued')
                : (run?.status === 'failed' ? 'failed' : 'stale'),
            error: run?.error ?? null,
            costCents: run?.costCents ?? 0,
            estimatedCents: Math.round(planned?.estimatedCents ?? 0),
            modelId: planned?.modelId ?? null,
            subtree: (() => {
              const s = preview.subtreeCents(node.id)
              return { nodeCount: s.nodeCount, cents: Math.round(s.cents) }
            })(),
            outputs: ((run?.outputRefs as string[] | null) ?? [])
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
