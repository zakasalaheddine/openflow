import { NextResponse } from 'next/server'
import { scope } from '../scope'
import { exportFlow } from '@/core/exporter'
import { FfmpegMissingError } from '@/core/ffmpeg'
import { exportsDir } from '@/env'

export const dynamic = 'force-dynamic'

export async function POST(request: Request) {
  const scoped = scope(request)
  if (scoped instanceof NextResponse) return scoped
  const { db, flowId } = scoped

  try {
    const result = await exportFlow(db, flowId, { dir: exportsDir() })
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
