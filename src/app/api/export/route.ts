import { NextResponse } from 'next/server'
import { mkdirSync, writeFileSync } from 'node:fs'
import path from 'node:path'
import { scope } from '../scope'
import { exportFlow, totalCostOf, type ManifestEntry, type ExportResult } from '@/core/exporter'
import { readGraph } from '@/core/graph'
import { DEFAULT_SETTINGS, type ProjectSettings } from '@/core/settings'
import { FfmpegMissingError } from '@/core/ffmpeg'
import { flows, projects } from '@/db/schema'
import { eq } from 'drizzle-orm'
import { exportsDir } from '@/env'

export const dynamic = 'force-dynamic'

export async function POST(request: Request) {
  const scoped = scope(request)
  if (scoped instanceof NextResponse) return scoped
  const { db, flowId } = scoped

  try {
    const flow = db.select().from(flows).where(eq(flows.id, flowId)).get()!
    const graph = readGraph(flow.graphJson)
    const project = db.select().from(projects).where(eq(projects.id, flow.projectId)).get()
    const settings: ProjectSettings = { ...DEFAULT_SETTINGS, ...(project?.settings as ProjectSettings) }
    const dir = exportsDir()
    // A graph with no export node still gets an (empty) manifest — the old
    // behaviour, since `exportFlow` always created the directory even when it
    // had nothing to walk.
    mkdirSync(dir, { recursive: true })

    // Transitional: the export node is deleted in the task that adds the
    // download dialog. Until then this reproduces what exportFlow used to do
    // internally — one call per export node, each with its own upstream ids,
    // its own resolved formats and its own overlay, since two export nodes on
    // one graph can each carry a different headline (see inspector.tsx) and
    // must not bleed into each other's spec check. `exportFlow` writes its
    // own manifest.json per call, so the last call would otherwise leave it
    // only describing that one node's files; it is rewritten below with the
    // union so the route keeps behaving the same from outside.
    const exportNodes = graph.nodes.filter((n) => n.type === 'export')
    const runs: ExportResult[] = []
    for (const exportNode of exportNodes) {
      const nodeIds = graph.edges.filter((e) => e.to === exportNode.id).map((e) => e.from)
      const formats = exportNode.formats.length ? exportNode.formats : settings.formats
      runs.push(await exportFlow(db, flowId, { dir, nodeIds, formats, overlay: exportNode.overlay }))
    }

    const entries: ManifestEntry[] = runs.flatMap((r) => r.entries)
    const rejected: ExportResult['rejected'] = runs.flatMap((r) => r.rejected)
    // Recomputed over the union, not summed per call: the same run shipped by
    // two export nodes must still be paid for once.
    const totalCostCents = totalCostOf(db, entries)
    const manifestPath = path.join(dir, 'manifest.json')
    writeFileSync(manifestPath, JSON.stringify({ flowId, totalCostCents, files: entries, rejected }, null, 2))

    // Rejections come back beside the written files rather than as an error:
    // an export where three of four formats shipped is a partial success, and
    // collapsing it into a 500 hides which three.
    return NextResponse.json({
      dir,
      manifest: manifestPath,
      written: entries.map((e) => ({ file: e.file, format: e.format })),
      rejected: rejected.map((r) => ({
        nodeId: r.nodeId,
        format: r.format,
        reasons: r.specCheck.findings.map((f) => f.message),
      })),
      totalCostCents,
    })
  } catch (error) {
    if (error instanceof FfmpegMissingError) {
      return NextResponse.json({ error: error.message }, { status: 422 })
    }
    return NextResponse.json(
      { error: error instanceof Error ? error.message : 'Export failed' },
      { status: 500 },
    )
  }
}
