import { randomUUID } from 'node:crypto'
import { mkdirSync, rmSync, writeFileSync } from 'node:fs'
import path from 'node:path'
import sharp from 'sharp'
import { desc, eq } from 'drizzle-orm'
import type { BetterSQLite3Database } from 'drizzle-orm/better-sqlite3'
import { assets, exports, flows, nodeRuns, projects, sources } from '../db/schema'
import { DEFAULT_SETTINGS, type ProjectSettings } from './settings'
import { planRun } from './executor'
import { checkSpec, coverCrop, type SpecCheck } from './spec'
import { boxOf, hasText, overlaySvg } from './overlay'
import { probe, ffmpeg, encoderFor } from './ffmpeg'
import { composePrompt } from './compose'
import type { AdFormat, ExportNode, Flow, NodeId } from './types'

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Db = BetterSQLite3Database<any>

export type ManifestEntry = {
  file: string
  format: string
  nodeId: NodeId
  prompt: string
  modelId: string
  seed: number | null
  /** Versions of the sources wired in, so a re-export can be reproduced. */
  sourceVersions: Record<string, number>
  runId: string
  costCents: number
  specCheck: SpecCheck
  createdAt: string
}

export type ExportResult = {
  entries: ManifestEntry[]
  /** Checked and refused. No file was written for these. */
  rejected: { nodeId: NodeId; format: string; specCheck: SpecCheck }[]
  manifestPath: string
  totalCostCents: number
}

/**
 * An empty list on the node means "whatever the project uses". A non-empty one
 * is an override — a per-node format beats the project default, which is the
 * point of having it on the node at all.
 */
export const resolveFormats = (node: ExportNode, settings: ProjectSettings): AdFormat[] =>
  node.formats.length > 0 ? node.formats : settings.formats

/** `9:16` is a fine format name and a terrible filename. */
const slug = (text: string) => text.replace(/[^a-z0-9]+/gi, '-').replace(/^-|-$/g, '').toLowerCase()

/**
 * The run that produced the pixels the graph currently describes.
 *
 * Matched on `inputHash`, never just on node id. The manifest records the
 * prompt and asset versions from the *current* graph, so exporting the newest
 * succeeded run regardless would attribute a prompt to output it never
 * produced — one prompt edit away, and provenance that lies is worse than none.
 */
function currentRun(db: Db, flowId: string, nodeId: NodeId, inputHash: string | undefined) {
  if (!inputHash) return undefined
  return db
    .select()
    .from(nodeRuns)
    .where(eq(nodeRuns.flowId, flowId))
    .orderBy(desc(nodeRuns.createdAt))
    .all()
    .find((run) => run.nodeId === nodeId && run.status === 'succeeded' && run.inputHash === inputHash)
}

const STALE_CHECK = (nodeId: NodeId, format: AdFormat): SpecCheck => ({
  pass: false,
  format: format.name,
  findings: [
    {
      rule: 'stale',
      message: `${nodeId} has no rendered output matching its current settings. Run before exporting.`,
    },
  ],
})

/**
 * Writes every format of every node feeding an export node, plus the manifest.
 *
 * A format whose spec check fails writes no file. Surfacing the reason and
 * shipping the asset anyway is the same as not checking: the rejection just
 * arrives later, from the client, with the placement already booked.
 */
export async function exportFlow(
  db: Db,
  flowId: string,
  options: { dir: string },
): Promise<ExportResult> {
  const flow = db.select().from(flows).where(eq(flows.id, flowId)).get()
  if (!flow) throw new Error(`No flow ${flowId}`)

  const project = db.select().from(projects).where(eq(projects.id, flow.projectId)).get()
  const settings: ProjectSettings = { ...DEFAULT_SETTINGS, ...(project?.settings as ProjectSettings) }
  const graph = flow.graphJson as Flow
  const library = new Map(
    db.select().from(sources).where(eq(sources.projectId, flow.projectId)).all().map((r) => [r.id, r]),
  )
  const byNodeId = new Map(graph.nodes.map((n) => [n.id, n]))

  const outDir = path.resolve(options.dir)
  mkdirSync(outDir, { recursive: true })

  const entries: ManifestEntry[] = []
  const rejected: ExportResult['rejected'] = []
  // The same derivation the toolbar and the executor use, so "stale" means the
  // same thing in all three places.
  const currentHash = new Map(planRun(db, flowId).map((p) => [p.nodeId, p.inputHash]))

  for (const exportNode of graph.nodes.filter((n): n is ExportNode => n.type === 'export')) {
    const formats = resolveFormats(exportNode, settings)
    const upstream = graph.edges.filter((e) => e.to === exportNode.id).map((e) => e.from)

    for (const nodeId of upstream) {
      const node = byNodeId.get(nodeId)
      if (!node) continue

      const run = currentRun(db, flowId, nodeId, currentHash.get(nodeId))
      if (!run) {
        // Never rendered and edited-since-rendered land here together, and are
        // reported the same way: refused, with the reason, rather than shipping
        // last week's pixels under this week's prompt.
        for (const format of formats) {
          rejected.push({ nodeId, format: format.name, specCheck: STALE_CHECK(nodeId, format) })
        }
        continue
      }

      const refs = (run.outputRefs as string[] | null) ?? []
      for (const [index, assetId] of refs.entries()) {
        const asset = db.select().from(assets).where(eq(assets.id, assetId)).get()
        if (!asset) continue

        const video = asset.mime.startsWith('video/')
        // The file, not the row: a width column written from a model's promise
        // makes every check downstream a check of our own optimism.
        const measured = video
          ? await probe(asset.path)
          : await sharp(asset.path).metadata().then((m) => ({
              width: m.width ?? 0,
              height: m.height ?? 0,
              durationMs: 0,
            }))

        for (const format of formats) {
          const textBox = boxOf(exportNode.overlay)
          const specCheck = checkSpec({
            format,
            sourceWidth: measured.width,
            sourceHeight: measured.height,
            ...(video ? { durationSec: measured.durationMs / 1000 } : {}),
            ...(textBox ? { textBox } : {}),
          })

          // Named for the node and format, not the asset. A re-roll then
          // re-export overwrites its own file instead of leaving last week's
          // version sitting in ./exports looking like a deliverable — the
          // manifest is rewritten each run and would not mention it.
          const suffix = refs.length > 1 ? `-${index + 1}` : ''
          const file = path.join(
            outDir,
            `${slug(node.label ?? nodeId)}-${slug(format.name)}${suffix}${video ? '.mp4' : '.png'}`,
          )

          // The row exists on a pass and on a failure. A record that only exists
          // when the check passed cannot distinguish "checked" from "never run".
          db.insert(exports)
            .values({
              id: randomUUID(),
              flowId,
              format: format.name,
              assetId,
              specCheck,
              path: specCheck.pass ? file : '',
              createdAt: new Date().toISOString(),
            })
            .run()

          if (!specCheck.pass) {
            rejected.push({ nodeId, format: format.name, specCheck })
            continue
          }

          await render({
            source: asset.path,
            file,
            format,
            node: exportNode,
            video,
            measured,
            // Node first, project second. A per-node override that the encoder
            // ignores is a field that changes the hash and nothing on disk.
            fps: exportNode.fps ?? settings.fps,
            codec: exportNode.codec ?? settings.codec,
          })

          entries.push({
            file: path.relative(outDir, file),
            format: format.name,
            nodeId,
            prompt: composePrompt(graph, nodeId, library),
            modelId: run.modelId,
            seed: 'seed' in node ? (node.seed ?? null) : null,
            sourceVersions: sourceVersionsFor(graph, nodeId, library),
            runId: run.id,
            costCents: run.costCents,
            specCheck,
            createdAt: new Date().toISOString(),
          })
        }
      }
    }
  }

  // Summed over distinct runs, not over files: one render feeding a 9:16 and a
  // 1:1 export was paid for once. A manifest whose total disagrees with the
  // ledger is worse provenance than no manifest at all.
  const byRun = new Map(entries.map((e) => [e.runId, e.costCents]))
  const totalCostCents = [...byRun.values()].reduce((sum, cents) => sum + cents, 0)

  const manifestPath = path.join(outDir, 'manifest.json')
  writeFileSync(
    manifestPath,
    JSON.stringify({ flowId, totalCostCents, files: entries, rejected }, null, 2),
  )

  return { entries, rejected, manifestPath, totalCostCents }
}

function sourceVersionsFor(
  graph: Flow,
  nodeId: NodeId,
  library: Map<string, { version: number }>,
): Record<string, number> {
  const sourceIdOf = new Map(
    graph.nodes.filter((n) => n.type === 'source').map((n) => [n.id, n.sourceId]),
  )
  const versions: Record<string, number> = {}
  for (const edge of graph.edges.filter((e) => e.to === nodeId && e.role === 'reference')) {
    const sourceId = sourceIdOf.get(edge.from)
    const row = sourceId ? library.get(sourceId) : undefined
    if (sourceId && row) versions[sourceId] = row.version
  }
  return versions
}

async function render(input: {
  source: string
  file: string
  format: AdFormat
  node: ExportNode
  video: boolean
  measured: { width: number; height: number }
  fps: number
  codec: string
}) {
  const { source, file, format, node, video, measured, fps, codec } = input
  const crop = coverCrop(measured.width, measured.height, format)
  const overlay = hasText(node.overlay) ? Buffer.from(overlaySvg(node.overlay!, format)) : null

  if (!video) {
    const resized = sharp(source).extract(crop).resize(format.w, format.h)
    await (overlay ? resized.composite([{ input: overlay }]) : resized).png().toFile(file)
    return
  }

  const encode = ['-r', String(fps), '-c:v', encoderFor(codec), '-pix_fmt', 'yuv420p']
  const filter = `crop=${crop.width}:${crop.height}:${crop.left}:${crop.top},scale=${format.w}:${format.h}`
  if (!overlay) {
    await ffmpeg(['-i', source, '-vf', filter, ...encode, file])
    return
  }

  // The same SVG the still export uses, rasterised once and composited — one
  // text renderer, so a headline cannot sit in one place on the image and
  // somewhere else on the clip.
  const overlayPng = `${file}.overlay.png`
  await sharp(overlay).png().toFile(overlayPng)
  try {
    await ffmpeg([
      '-i', source,
      '-i', overlayPng,
      '-filter_complex', `[0:v]${filter}[base];[base][1:v]overlay=0:0`,
      ...encode,
      file,
    ])
  } finally {
    // Or ./exports fills with scratch PNGs that look like deliverables.
    rmSync(overlayPng, { force: true })
  }
}
