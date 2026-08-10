import { mkdtempSync, readFileSync, readdirSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { NextResponse } from 'next/server'
import { zipSync } from 'fflate'
import { z } from 'zod'
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
import type { NodeId } from '@/core/types'

export const dynamic = 'force-dynamic'

/**
 * The trust boundary for this route, the same job `flowSchema` does for
 * `graph_json` (see core/schema.ts) — a bad value refused here is a 400; the
 * same value reaching `overlaySvg`, sharp or ffmpeg unrefused is a crash deep
 * inside the worker with a person's format request as the input. There is no
 * node carrying these fields to validate on the way in any more, so the body
 * is the only place left to check them.
 */
const fraction = z.number().min(0).max(1)

const formatSpecBody = z
  .object({
    // Not `.partial()`: `FormatSpec.safeZone` is all-or-nothing (see
    // core/types.ts) — a safe zone missing an edge is a rule that silently
    // never fires on that edge, not a rule with a sensible default.
    safeZone: z.object({ top: fraction, right: fraction, bottom: fraction, left: fraction }).optional(),
    minScale: z.number().min(0).optional(),
    maxDurationSec: z.number().min(0).optional(),
    maxTextCoverage: fraction.optional(),
  })
  .optional()

const adFormatBody = z.object({
  name: z.string().min(1),
  // Positive integers, not "a number": a placement is pixels, and a zero,
  // negative or fractional edge is not a size sharp or ffmpeg can crop to.
  w: z.number().int().positive(),
  h: z.number().int().positive(),
  spec: formatSpecBody,
})

const textOverlayBody = z
  .object({
    headline: z.string().optional(),
    cta: z.string().optional(),
    box: z.object({ x: fraction, y: fraction, w: fraction, h: fraction }).optional(),
  })
  .optional()

const downloadBodySchema = z.object({
  nodeIds: z.array(z.string().min(1)).optional(),
  formats: z.array(adFormatBody).optional(),
  overlay: textOverlayBody,
  preview: z.boolean().optional(),
})

type Body = z.infer<typeof downloadBodySchema>

/**
 * Everything in this flow that could ship right now.
 *
 * Everything with a current render, not only the nodes nothing leaves. A clip
 * that feeds a film is included — the manifest's cost dedup exists precisely
 * for "shipped alone and inside a cut" — and terminal-only would silently drop
 * a hero still that feeds a clip. The dialog's tick boxes are how you drop what
 * you do not want.
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

  const raw = await request.json().catch(() => ({}))
  const parsedBody = downloadBodySchema.safeParse(raw)
  if (!parsedBody.success) {
    return NextResponse.json(
      { error: parsedBody.error.issues[0]?.message ?? 'Invalid request body' },
      { status: 400 },
    )
  }
  const body: Body = parsedBody.data

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

      // Nothing was refused, and exactly one file exists. That is the
      // property that matters, not a count of nodes or formats requested:
      // counting axes is how the previous version of this line broke — one
      // node, one format, but a multi-output run (see worker/loop.ts) that
      // shipped one asset and refused a second still left `entries.length`
      // at 1 while hiding that refusal in a bare file with no manifest to
      // carry it. `rejected.length === 0` closes that and every axis like it
      // at once: a zip is only skipped when there is truly nothing to report.
      const single = result.entries.length === 1 && result.rejected.length === 0
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

      // `level: 0` does not select fflate's stored (uncompressed) method —
      // entries are still written deflate-format, just at zero compression
      // effort. PNG and MP4 are already compressed, so spending CPU hunting
      // for redundancy that is not there would only make the response slower.
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
