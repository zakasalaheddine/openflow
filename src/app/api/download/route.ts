import { mkdtempSync, readFileSync, readdirSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { NextResponse } from 'next/server'
import { zipSync } from 'fflate'
import { scope } from '../scope'
import {
  collectDownloadables,
  exportFlow,
  verdictsFor,
} from '@/core/exporter'
import { FfmpegMissingError } from '@/core/ffmpeg'
import { DEFAULT_SETTINGS, type ProjectSettings } from '@/core/settings'
import { readGraph } from '@/core/graph'
import { nodeHashes } from '@/core/executor'
import { currentRun } from '@/core/runs'
import { flows, projects } from '@/db/schema'
import { eq } from 'drizzle-orm'
import type { AdFormat, NodeId, TextOverlay } from '@/core/types'

export const dynamic = 'force-dynamic'

type Body = {
  nodeIds?: NodeId[]
  formats?: AdFormat[]
  overlay?: TextOverlay
  preview?: boolean
}

/**
 * Everything in this flow that could ship right now.
 *
 * Everything with a current render, not only the nodes nothing leaves. A clip
 * that feeds a film is included — the manifest's cost dedup exists precisely
 * for "shipped alone and inside a cut" — and terminal-only would silently drop
 * a hero still that feeds a clip. The dialog's tick boxes are how you drop what
 * you do not want.
 *
 * An `export` node needs no exclusion of its own: it never dispatches (see
 * `isRunnable` in executor.ts), so no `node_runs` row is ever written for one
 * and `currentRun` returns nothing for it here, same as for a node that was
 * simply never run.
 */
function everythingRendered(db: Parameters<typeof collectDownloadables>[0], flowId: string): NodeId[] {
  const flow = db.select().from(flows).where(eq(flows.id, flowId)).get()
  if (!flow) return []
  const graph = readGraph(flow.graphJson)
  const hashes = nodeHashes(db, flowId)
  return graph.nodes
    .filter((node) => node.type !== 'source')
    .filter((node) => currentRun(db, flowId, node.id, hashes.get(node.id)) !== undefined)
    .map((node) => node.id)
}

export async function POST(request: Request) {
  const scoped = scope(request)
  if (scoped instanceof NextResponse) return scoped
  const { db, flowId } = scoped

  const body = (await request.json().catch(() => ({}))) as Body

  const flow = db.select().from(flows).where(eq(flows.id, flowId)).get()
  if (!flow) return NextResponse.json({ error: 'No such workspace' }, { status: 404 })
  const project = db.select().from(projects).where(eq(projects.id, flow.projectId)).get()
  const settings: ProjectSettings = { ...DEFAULT_SETTINGS, ...(project?.settings as ProjectSettings) }

  const nodeIds = body.nodeIds ?? everythingRendered(db, flowId)
  const formats = body.formats?.length ? body.formats : settings.formats

  try {
    if (body.preview) {
      const { ready, stale } = collectDownloadables(db, flowId, nodeIds)
      const verdicts = await verdictsFor(ready, formats, body.overlay)
      return NextResponse.json({
        formats,
        stale,
        verdicts: verdicts.map((v) => ({
          nodeId: v.nodeId,
          format: v.format,
          pass: v.specCheck.pass,
          reasons: v.specCheck.findings.map((f) => f.message),
        })),
      })
    }

    // A directory nobody keeps. The alternative — caching crops in the asset
    // store keyed by hash — buys a faster second download and costs a directory
    // that grows forever with derived files nothing collects.
    const dir = mkdtempSync(path.join(tmpdir(), 'openflow-download-'))
    try {
      const result = await exportFlow(db, flowId, { dir, nodeIds, formats, overlay: body.overlay })
      if (result.entries.length === 0) {
        return NextResponse.json(
          { error: 'Nothing here can ship yet.', rejected: result.rejected },
          { status: 422 },
        )
      }

      // Exactly one node and exactly one format asked for, and it shipped.
      // `nodeIds.length === 1` alone is not enough: one node with two
      // requested formats where only one clears its spec check also leaves
      // `entries.length === 1`, and handing that back as a bare file would
      // silently drop the other placement's refusal instead of reporting it.
      // Requiring `formats.length === 1` too means the single-file path only
      // ever fires for a request that could not have produced more than one
      // file in the first place.
      const single = result.entries.length === 1 && nodeIds.length === 1 && formats.length === 1
      if (single) {
        const name = result.entries[0].file
        const bytes = readFileSync(path.join(dir, name))
        return new NextResponse(new Uint8Array(bytes), {
          headers: {
            'Content-Type': name.endsWith('.mp4') ? 'video/mp4' : 'image/png',
            'Content-Disposition': `attachment; filename="${name}"`,
          },
        })
      }

      // Stored, not deflated: PNG and MP4 are already compressed, so deflating
      // them spends CPU to save nothing.
      const files: Record<string, [Uint8Array, { level: 0 }]> = {}
      for (const name of readdirSync(dir)) {
        files[name] = [new Uint8Array(readFileSync(path.join(dir, name))), { level: 0 }]
      }
      const zip = zipSync(files)
      const label = (flow.name || 'openflow').replace(/[^a-z0-9]+/gi, '-').toLowerCase()
      return new NextResponse(zip, {
        headers: {
          'Content-Type': 'application/zip',
          'Content-Disposition': `attachment; filename="${label}.zip"`,
        },
      })
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  } catch (error) {
    if (error instanceof FfmpegMissingError) {
      return NextResponse.json({ error: error.message }, { status: 422 })
    }
    return NextResponse.json(
      { error: error instanceof Error ? error.message : 'Download failed' },
      { status: 500 },
    )
  }
}
