import { randomUUID } from 'node:crypto'
import { existsSync, mkdirSync, rmSync, writeFileSync } from 'node:fs'
import path from 'node:path'
import sharp from 'sharp'
import { and, desc, eq } from 'drizzle-orm'
import type { BetterSQLite3Database } from 'drizzle-orm/better-sqlite3'
import { assets, exports, flows, nodeRuns, projects, sources } from '../db/schema'
import { DEFAULT_SETTINGS, type ProjectSettings } from './settings'
import { nodeHashes } from './executor'
import { checkSpec, coverCrop, type SpecCheck } from './spec'
import { boxOf, hasText, overlaySvg } from './overlay'
import { probe, ffmpeg, encoderFor } from './ffmpeg'
import { composePrompt } from './compose'
import { sequenceInputs } from './wiring'
import { currentRun } from './runs'
import { readGraph } from './graph'
import type { AdFormat, Flow, NodeId, TextOverlay } from './types'

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

/** `9:16` is a fine format name and a terrible filename. */
const slug = (text: string) => text.replace(/[^a-z0-9]+/gi, '-').replace(/^-|-$/g, '').toLowerCase()

const STALE_CHECK = (nodeId: NodeId, format: AdFormat, reason?: string): SpecCheck => ({
  pass: false,
  format: format.name,
  findings: [
    {
      rule: 'stale',
      message: reason
        ? `${nodeId}: ${reason}`
        : `${nodeId} has no rendered output matching its current settings. Run before exporting.`,
    },
  ],
})

// Not "run it again": the succeeded run this file came from is still on
// record, so `enqueueRun` would see its hash already satisfied and skip it —
// an instruction the system will not honour. Naming the fact is honest;
// telling someone to do something that silently no-ops is not.
const MISSING_FILE_CHECK = (nodeId: NodeId, format: AdFormat): SpecCheck => ({
  pass: false,
  format: format.name,
  findings: [
    {
      rule: 'missing-file',
      message: `${nodeId}'s render file is missing from disk.`,
    },
  ],
})

/**
 * Why a node's most recent *settled* attempt didn't succeed, if there was one.
 *
 * A node that has simply never been run has no such attempt and keeps
 * `STALE_CHECK`'s generic sentence. One that has — most sharply, a sequence
 * whose cut refused because a clip went stale mid-run — has the actionable
 * reason sitting in `error` and nowhere else. On a six-shot film "cut has no
 * rendered output" names nothing; the clip's own name, read from here, does.
 *
 * Deliberately not "the newest non-succeeded run": `claimed`, `submitted` and
 * `polling` are attempts genuinely in flight right now, and `fail()` never
 * clears the previous attempt's `error` when a row is reclaimed for a retry —
 * so a run actively being retried can still carry a stale message from the
 * attempt before it, one that may be moments from being overwritten by a
 * success. Only `failed` and a `queued` row that already carries an `error`
 * (this task's shape: `fail()` requeues below the retry ceiling) are
 * attempts that have actually stopped and have something to report.
 */
function lastFailureReason(db: Db, flowId: string, nodeId: NodeId): string | undefined {
  return (
    db
      .select()
      .from(nodeRuns)
      .where(and(eq(nodeRuns.flowId, flowId), eq(nodeRuns.nodeId, nodeId)))
      .orderBy(desc(nodeRuns.createdAt))
      .all()
      .find((run) => run.status === 'failed' || (run.status === 'queued' && run.error !== null))?.error ??
    undefined
  )
}

export type DownloadRequest = {
  /** Explicit. Core does not guess what "everything" means; the caller decides. */
  nodeIds: NodeId[]
  formats: AdFormat[]
  overlay?: TextOverlay
}

export type Downloadable = {
  nodeId: NodeId
  assets: { id: string; path: string; mime: string }[]
  runIds: string[]
  costCents: number
  modelId: string
  seed: number | null
  prompt: string
}

export type Verdict = {
  nodeId: NodeId
  /** Which of the node's outputs. A multi-output run ships each one. */
  assetIndex: number
  format: string
  specCheck: SpecCheck
  /**
   * What the file measured, carried rather than re-derived.
   *
   * `render` needs the same numbers `checkSpec` was given, and probing an mp4
   * twice per format is a subprocess per placement for an answer that cannot
   * have changed. Same measurement, same crop, by construction.
   */
  measured: { width: number; height: number; durationMs: number }
  /**
   * The file was never measured, so `specCheck` is `MISSING_FILE_CHECK` rather
   * than a real verdict. A dedicated flag, not a scan of `specCheck.findings`
   * for a rule name: a second finding ordered ahead of it would otherwise
   * resurrect a check that never ran.
   */
  missingFile: boolean
}

/**
 * Who to credit a film to, and what it really cost.
 *
 * The cut's own run costs nothing — ffmpeg on this machine — so crediting the
 * manifest with that run alone would report a film that cost $0.00. The truth is
 * the clips, which is also why `runIds` is a list: `totalCostCents` is summed
 * over distinct runs, so a clip that ships inside a film *and* on its own is
 * paid for once.
 */
function sequenceProvenance(
  db: Db,
  flowId: string,
  graph: Flow,
  nodeId: NodeId,
  currentHash: Map<NodeId, string>,
): { runIds: string[]; costCents: number; prompt: string } {
  const byNodeId = new Map(graph.nodes.map((n) => [n.id, n]))
  const runIds: string[] = []
  const prompts: string[] = []
  let costCents = 0

  for (const clipId of sequenceInputs(graph, nodeId)) {
    const run = currentRun(db, flowId, clipId, currentHash.get(clipId))
    if (!run) continue
    runIds.push(run.id)
    costCents += run.costCents
    const clip = byNodeId.get(clipId)
    prompts.push(clip && 'prompt' in clip ? clip.prompt : '')
  }

  // Every shot's direction, in order. Long, and the only honest answer to
  // "what was this film asked for".
  return { runIds, costCents, prompt: prompts.join('\n\n') }
}

/**
 * What of the requested nodes can actually ship, and what cannot.
 *
 * `stale` is not an error. A node with no render matching its current settings
 * is the ordinary case one prompt edit after a render, and the caller reports it
 * rather than failing the whole download over it.
 */
export function collectDownloadables(
  db: Db,
  flowId: string,
  nodeIds: NodeId[],
): { ready: Downloadable[]; stale: NodeId[] } {
  const flow = db.select().from(flows).where(eq(flows.id, flowId)).get()
  if (!flow) throw new Error(`No flow ${flowId}`)

  const graph = readGraph(flow.graphJson)
  const library = new Map(
    db.select().from(sources).where(eq(sources.projectId, flow.projectId)).all().map((r) => [r.id, r]),
  )
  const byNodeId = new Map(graph.nodes.map((n) => [n.id, n]))
  // The same derivation the toolbar and the executor use, so "stale" means the
  // same thing in all three places.
  // Every node, not only the ones a Run would pay for: a sequence dispatches to
  // nothing and is still keyed on its hash.
  const currentHash = nodeHashes(db, flowId)

  const ready: Downloadable[] = []
  const stale: NodeId[] = []

  for (const nodeId of nodeIds) {
    const node = byNodeId.get(nodeId)
    if (!node) continue

    // Never rendered and edited-since-rendered land here together; both are
    // the ordinary case one prompt edit after a render, and the caller
    // decides how to report it — see `lastFailureReason` for the sharper
    // message a failed cut gets.
    const run = currentRun(db, flowId, nodeId, currentHash.get(nodeId))
    if (!run) {
      stale.push(nodeId)
      continue
    }

    const rows = ((run.outputRefs as string[] | null) ?? [])
      .map((assetId) => db.select().from(assets).where(eq(assets.id, assetId)).get())
      .filter((row) => row !== undefined)
    if (rows.length === 0) {
      stale.push(nodeId)
      continue
    }

    const provenance =
      node.type === 'sequence'
        ? sequenceProvenance(db, flowId, graph, nodeId, currentHash)
        : { runIds: [run.id], costCents: run.costCents, prompt: composePrompt(graph, nodeId, library) }

    ready.push({
      nodeId,
      assets: rows.map((row) => ({ id: row.id, path: row.path, mime: row.mime })),
      modelId: run.modelId,
      seed: 'seed' in node ? (node.seed ?? null) : null,
      ...provenance,
    })
  }

  return { ready, stale }
}

/**
 * Every node × format verdict, measured, writing nothing.
 *
 * Measured from the file rather than the row, for the reason the row cannot be
 * trusted: a width column written from a model's promise makes every check
 * downstream a check of our own optimism.
 */
export async function verdictsFor(
  ready: Downloadable[],
  formats: AdFormat[],
  overlay?: TextOverlay,
): Promise<Verdict[]> {
  const textBox = boxOf(overlay)
  const verdicts: Verdict[] = []

  for (const item of ready) {
    for (const [assetIndex, asset] of item.assets.entries()) {
      // The row survives; the bytes don't always — space reclaimed, a data
      // dir moved. Reporting it by name beats handing a missing path to
      // ffprobe or sharp and letting a raw ENOENT stand in for a verdict.
      // Every asset kind reads its file the same way below, so this one check
      // covers stills, clips and films alike.
      if (!existsSync(asset.path)) {
        for (const format of formats) {
          verdicts.push({
            nodeId: item.nodeId,
            assetIndex,
            format: format.name,
            specCheck: MISSING_FILE_CHECK(item.nodeId, format),
            measured: { width: 0, height: 0, durationMs: 0 },
            missingFile: true,
          })
        }
        continue
      }

      const video = asset.mime.startsWith('video/')
      const measured = video
        ? await probe(asset.path)
        : await sharp(asset.path).metadata().then((m) => ({
            width: m.width ?? 0,
            height: m.height ?? 0,
            durationMs: 0,
          }))

      for (const format of formats) {
        verdicts.push({
          nodeId: item.nodeId,
          assetIndex,
          format: format.name,
          measured,
          specCheck: checkSpec({
            format,
            sourceWidth: measured.width,
            sourceHeight: measured.height,
            ...(video ? { durationSec: measured.durationMs / 1000 } : {}),
            ...(textBox ? { textBox } : {}),
          }),
          missingFile: false,
        })
      }
    }
  }

  return verdicts
}

/**
 * Writes every requested node, in every requested format, plus the manifest.
 *
 * A format whose spec check fails writes no file. Surfacing the reason and
 * shipping the asset anyway is the same as not checking: the rejection just
 * arrives later, from the client, with the placement already booked.
 */
export async function exportFlow(
  db: Db,
  flowId: string,
  options: DownloadRequest & { dir: string },
): Promise<ExportResult> {
  const flow = db.select().from(flows).where(eq(flows.id, flowId)).get()
  if (!flow) throw new Error(`No flow ${flowId}`)
  const project = db.select().from(projects).where(eq(projects.id, flow.projectId)).get()
  const settings: ProjectSettings = { ...DEFAULT_SETTINGS, ...(project?.settings as ProjectSettings) }
  const graph = readGraph(flow.graphJson)
  const byNodeId = new Map(graph.nodes.map((n) => [n.id, n]))
  const library = new Map(
    db.select().from(sources).where(eq(sources.projectId, flow.projectId)).all().map((r) => [r.id, r]),
  )

  const outDir = path.resolve(options.dir)
  mkdirSync(outDir, { recursive: true })

  const { ready, stale } = collectDownloadables(db, flowId, options.nodeIds)
  const verdicts = await verdictsFor(ready, options.formats, options.overlay)

  const entries: ManifestEntry[] = []
  const rejected: ExportResult['rejected'] = []

  for (const nodeId of stale) {
    // A film whose cut failed arrives here too, which is why the reason is on
    // the card — read from the run's own `error` when there is one, so a
    // stale clip is named rather than only the sequence that could not be cut
    // around it.
    const reason = lastFailureReason(db, flowId, nodeId)
    for (const format of options.formats) {
      rejected.push({ nodeId, format: format.name, specCheck: STALE_CHECK(nodeId, format, reason) })
    }
  }

  for (const verdict of verdicts) {
    const item = ready.find((r) => r.nodeId === verdict.nodeId)!
    const asset = item.assets[verdict.assetIndex]
    const format = options.formats.find((f) => f.name === verdict.format)!
    const node = byNodeId.get(verdict.nodeId)
    const video = asset.mime.startsWith('video/')

    // A missing file was never measured, so there is nothing to ground an
    // `exports` row in — the same as a stale node, it is reported without one.
    if (verdict.missingFile) {
      rejected.push({ nodeId: verdict.nodeId, format: format.name, specCheck: verdict.specCheck })
      continue
    }

    // Named for the node and format, not the asset. A re-roll then re-export
    // overwrites its own file instead of leaving last week's version sitting
    // in ./exports looking like a deliverable — the manifest is rewritten
    // each run and would not mention it.
    const suffix = item.assets.length > 1 ? `-${verdict.assetIndex + 1}` : ''
    const file = path.join(
      outDir,
      `${slug(node?.label ?? verdict.nodeId)}-${slug(format.name)}${suffix}${video ? '.mp4' : '.png'}`,
    )

    // The row exists on a pass and on a failure — every verdict that reaches
    // this point was actually checked. `missingFile` is the one case with no
    // row at all: its bytes are gone, so there is nothing a check could have
    // measured, and it is refused above before it gets here.
    db.insert(exports)
      .values({
        id: randomUUID(),
        flowId,
        format: format.name,
        assetId: asset.id,
        specCheck: verdict.specCheck,
        // The name delivered, not a path on this machine: there is no directory
        // to point at any more.
        path: verdict.specCheck.pass ? path.basename(file) : '',
        createdAt: new Date().toISOString(),
      })
      .run()

    if (!verdict.specCheck.pass) {
      rejected.push({ nodeId: verdict.nodeId, format: format.name, specCheck: verdict.specCheck })
      continue
    }

    await render({
      source: asset.path,
      file,
      format,
      overlay: options.overlay,
      video,
      // From the verdict, not a second probe: the crop must be computed from the
      // same numbers the check passed.
      measured: verdict.measured,
      fps: settings.fps,
      codec: settings.codec,
    })

    entries.push({
      file: path.relative(outDir, file),
      format: format.name,
      nodeId: verdict.nodeId,
      prompt: item.prompt,
      modelId: item.modelId,
      seed: item.seed,
      sourceVersions: sourceVersionsFor(graph, verdict.nodeId, library),
      // The first, for readers that expect one. `runIds` is the whole truth
      // and a cut has several.
      runId: item.runIds[0],
      runIds: item.runIds,
      costCents: item.costCents,
      specCheck: verdict.specCheck,
      createdAt: new Date().toISOString(),
    })
  }

  const totalCostCents = totalCostOf(db, entries)

  const manifestPath = path.join(outDir, 'manifest.json')
  writeFileSync(
    manifestPath,
    JSON.stringify({ flowId, totalCostCents, files: entries, rejected }, null, 2),
  )

  return { entries, rejected, manifestPath, totalCostCents }
}

/**
 * Summed over distinct *runs*, not over files: one render feeding a 9:16 and
 * a 1:1 export was paid for once, and a clip that ships both on its own and
 * inside a film was paid for once too. A manifest whose total disagrees with
 * the ledger is worse provenance than no manifest at all.
 *
 * Exported so a caller that must run `exportFlow` more than once for one
 * download — the transitional route, one export node at a time — can total
 * the union of every call's entries rather than summing their totals, which
 * would double-bill a run that two export nodes both happen to ship.
 */
export function totalCostOf(db: Db, entries: ManifestEntry[]): number {
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
  return [...perRun.values()].reduce((sum, cents) => sum + cents, 0)
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
  overlay?: TextOverlay
  video: boolean
  measured: { width: number; height: number }
  fps: number
  codec: string
}) {
  const { source, file, format, overlay: text, video, measured, fps, codec } = input
  const crop = coverCrop(measured.width, measured.height, format)
  const overlay = hasText(text) ? Buffer.from(overlaySvg(text!, format)) : null

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
