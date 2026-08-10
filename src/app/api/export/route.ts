import { NextResponse } from 'next/server'
import { scope } from '../scope'
import { exportFlow } from '@/core/exporter'
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

    // Transitional: the export node is deleted in the task that adds the
    // download dialog. Until then this reproduces what exportFlow used to do
    // internally, so this route keeps behaving the same from outside.
    const exportNodes = graph.nodes.filter((n) => n.type === 'export')
    const nodeIds = graph.edges.filter((e) => exportNodes.some((n) => n.id === e.to)).map((e) => e.from)
    const formats = exportNodes[0]?.formats.length ? exportNodes[0].formats : settings.formats
    const overlay = exportNodes[0]?.overlay

    const result = await exportFlow(db, flowId, { dir: exportsDir(), nodeIds, formats, overlay })
    // Rejections come back beside the written files rather than as an error:
    // an export where three of four formats shipped is a partial success, and
    // collapsing it into a 500 hides which three.
    return NextResponse.json({
      dir: exportsDir(),
      manifest: result.manifestPath,
      written: result.entries.map((e) => ({ file: e.file, format: e.format })),
      rejected: result.rejected.map((r) => ({
        nodeId: r.nodeId,
        format: r.format,
        reasons: r.specCheck.findings.map((f) => f.message),
      })),
      totalCostCents: result.totalCostCents,
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
