import { randomUUID } from 'node:crypto'
import { existsSync, mkdirSync, rmSync, writeFileSync } from 'node:fs'
import path from 'node:path'
import sharp from 'sharp'
import { desc, eq } from 'drizzle-orm'
import type { BetterSQLite3Database } from 'drizzle-orm/better-sqlite3'
import { assets, exports, flows, nodeRuns, projects, sources } from '../db/schema'
import { DEFAULT_SETTINGS, type ProjectSettings } from './settings'
import { nodeHashes } from './executor'
import { checkSpec, coverCrop, type SpecCheck } from './spec'
import { boxOf, hasText, overlaySvg } from './overlay'
import { probe, ffmpeg, encoderFor, concat } from './ffmpeg'
import { composePrompt } from './compose'
import { sequenceInputs } from './wiring'
import { assetsDir } from '../env'
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
  /**
   * Every run this file was built from. One entry for an ordinary node; one per
   * clip for a cut. The total is summed over the union of these, so a clip that
   * appears in a film *and* ships on its own is paid for once.
   */
  runIds: string[]
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

const REFUSED = (nodeId: NodeId, format: AdFormat, message: string): SpecCheck => ({
  pass: false,
  format: format.name,
  findings: [{ rule: 'sequence', message: `${nodeId}: ${message}` }],
})

/** One file to export, plus the provenance that belongs to it. */
type Exportable = {
  assets: { id: string; path: string; mime: string }[]
  runIds: string[]
  costCents: number
  modelId: string
  seed: number | null
  prompt: string
}

/**
 * Cuts a sequence's clips into one file, in order.
 *
 * Every clip must have a render matching its *current* settings — the same bar
 * a single node has to clear. Half a film assembled from three fresh shots and
 * two stale ones is worse than no film: it looks finished.
 *
 * The cut is written into the asset store and given a row of its own, keyed by
 * the sequence's input hash. Re-exporting an unchanged film finds that row and
 * re-cuts nothing; changing one shot, or the order, changes the hash and
 * produces a new one — the old file stays where it is, because it may already
 * have been sent to somebody.
 */
async function assembleSequence(input: {
  db: Db
  flowId: string
  graph: Flow
  nodeId: NodeId
  hash: string | undefined
  settings: ProjectSettings
  currentHash: Map<NodeId, string>
  storeRoot: string
}): Promise<Exportable | { refused: string }> {
  const { db, flowId, graph, nodeId, hash, settings, currentHash, storeRoot } = input
  const clips = sequenceInputs(graph, nodeId)
  if (clips.length === 0) return { refused: 'no clips are wired into this sequence.' }
  if (!hash) return { refused: 'this sequence could not be planned.' }

  const byNodeId = new Map(graph.nodes.map((n) => [n.id, n]))
  const parts: { file: string; runId: string; costCents: number; prompt: string }[] = []

  for (const clipId of clips) {
    const run = currentRun(db, flowId, clipId, currentHash.get(clipId))
    if (!run) return { refused: `${clipId} has no render matching its current settings.` }

    const assetId = ((run.outputRefs as string[] | null) ?? [])[0]
    const asset = assetId ? db.select().from(assets).where(eq(assets.id, assetId)).get() : undefined
    if (!asset) return { refused: `${clipId} rendered nothing to cut.` }
    if (!asset.mime.startsWith('video/')) return { refused: `${clipId} did not render a clip.` }

    const clip = byNodeId.get(clipId)
    parts.push({
      file: asset.path,
      runId: run.id,
      costCents: run.costCents,
      prompt: clip && 'prompt' in clip ? clip.prompt : '',
    })
  }

  const id = `sequence:${hash}`
  const existing = db.select().from(assets).where(eq(assets.id, id)).get()
  const file = existing?.path ?? path.join(storeRoot, 'sequences', `${hash}.mp4`)
  // The row is not the film. A cut deleted off disk — space reclaimed, a data
  // dir moved — would otherwise be handed to ffprobe and fail as a tool error
  // rather than as one of the named refusals this whole function is built from.
  const cached = existing !== undefined && existsSync(existing.path)

  if (!cached) {
    mkdirSync(path.dirname(file), { recursive: true })
    await concat(parts.map((p) => p.file), file, settings)
    // Written back only when there is no row yet. A row whose file went missing
    // is re-cut in place — inserting again would collide on the primary key and
    // turn a recovered export into a crash.
    if (!existing) {
      db.insert(assets)
        .values({
          id,
          path: file,
          mime: 'video/mp4',
          // No `sourceRunId`: no single run produced this. What it was cut from
          // is in the manifest's `runIds`, the only place it could be honest.
          createdAt: new Date().toISOString(),
        })
        .run()
    }
  }

  return {
    assets: [{ id, path: file, mime: 'video/mp4' }],
    runIds: parts.map((p) => p.runId),
    costCents: parts.reduce((sum, p) => sum + p.costCents, 0),
    modelId: 'sequence',
    seed: null,
    // Every shot's direction, in order. Long, and the only honest answer to
    // "what was this film asked for".
    prompt: parts.map((p) => p.prompt).join('\n\n'),
  }
}

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
  // Every node, not only the ones a Run would pay for: a sequence dispatches to
  // nothing and is still keyed on its hash.
  const currentHash = nodeHashes(db, flowId)

  for (const exportNode of graph.nodes.filter((n): n is ExportNode => n.type === 'export')) {
    const formats = resolveFormats(exportNode, settings)
    const upstream = graph.edges.filter((e) => e.to === exportNode.id).map((e) => e.from)

    for (const nodeId of upstream) {
      const node = byNodeId.get(nodeId)
      if (!node) continue

      let exportable: Exportable

      if (node.type === 'sequence') {
        const cut = await assembleSequence({
          db,
          flowId,
          graph,
          nodeId,
          hash: currentHash.get(nodeId),
          settings,
          currentHash,
          storeRoot: assetsDir(),
        })
        if ('refused' in cut) {
          for (const format of formats) {
            rejected.push({ nodeId, format: format.name, specCheck: REFUSED(nodeId, format, cut.refused) })
          }
          continue
        }
        exportable = cut
      } else {
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
        const rows = ((run.outputRefs as string[] | null) ?? [])
          .map((assetId) => db.select().from(assets).where(eq(assets.id, assetId)).get())
          .filter((row) => row !== undefined)
        exportable = {
          assets: rows.map((row) => ({ id: row.id, path: row.path, mime: row.mime })),
          runIds: [run.id],
          costCents: run.costCents,
          modelId: run.modelId,
          seed: 'seed' in node ? (node.seed ?? null) : null,
          prompt: composePrompt(graph, nodeId, library),
        }
      }

      const refs = exportable.assets
      for (const [index, asset] of refs.entries()) {
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
              assetId: asset.id,
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
            prompt: exportable.prompt,
            modelId: exportable.modelId,
            seed: exportable.seed,
            sourceVersions: sourceVersionsFor(graph, nodeId, library),
            // The first, for readers that expect one. `runIds` is the whole
            // truth and a cut has several.
            runId: exportable.runIds[0],
            runIds: exportable.runIds,
            costCents: exportable.costCents,
            specCheck,
            createdAt: new Date().toISOString(),
          })
        }
      }
    }
  }

  // Summed over distinct *runs*, not over files: one render feeding a 9:16 and
  // a 1:1 export was paid for once, and a clip that ships both on its own and
  // inside a film was paid for once too. A manifest whose total disagrees with
  // the ledger is worse provenance than no manifest at all.
  const perRun = new Map<string, number>()
  for (const entry of entries) {
    if (entry.runIds.length === 1) {
      perRun.set(entry.runIds[0], entry.costCents)
      continue
    }
    // A cut carries the sum of its clips, so the parts have to be priced from
    // the ledger rather than from the entry.
    for (const runId of entry.runIds) {
      if (perRun.has(runId)) continue
      perRun.set(runId, db.select().from(nodeRuns).where(eq(nodeRuns.id, runId)).get()?.costCents ?? 0)
    }
  }
  const totalCostCents = [...perRun.values()].reduce((sum, cents) => sum + cents, 0)

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
