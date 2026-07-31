import { randomUUID } from 'node:crypto'
import { renameSync } from 'node:fs'
import path from 'node:path'
import { eq, and, inArray, sql } from 'drizzle-orm'
import type { BetterSQLite3Database } from 'drizzle-orm/better-sqlite3'
import { nodeRuns, assets, flows, sources, projects, type NodeRun } from '../db/schema'
import { byId, estimateCostCents, type ModelSpec } from '../models/registry'
import { buildModelInput } from '../models/input'
import { localStore } from '../core/assets'
import { composePrompt, referenceFiles } from '../core/compose'
import { DEFAULT_SETTINGS, type ProjectSettings } from '../core/settings'
import { probe, ffmpeg, encoderFor, FfmpegMissingError, type Probe } from '../core/ffmpeg'
import { assetsDir } from '../env'
import type { Adapter, ParsedOutput } from '../models/fal'
import type { Flow, AssetRef } from '../core/types'

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Db = BetterSQLite3Database<any>

export const MAX_ATTEMPTS = 3
/** A claim held longer than this means the holder died between claim and dispatch. */
export const STALE_CLAIM_MS = 5 * 60_000
export const TICK_MS = 2000

const EXT_BY_MIME: Record<string, string> = {
  'image/png': '.png',
  'image/jpeg': '.jpg',
  'image/webp': '.webp',
  'video/mp4': '.mp4',
  'video/webm': '.webm',
  'video/quicktime': '.mov',
}

export type TickOptions = {
  adapter: Adapter
  /** Injected so a unit test never reaches the network to fetch an output. */
  download?: (url: string) => Promise<Buffer>
  concurrency?: number
  storeRoot?: string
}

const defaultDownload = async (url: string): Promise<Buffer> => {
  const response = await fetch(url)
  if (!response.ok) throw new Error(`Download failed ${response.status} for ${url}`)
  return Buffer.from(await response.arrayBuffer())
}

// ponytail: first project wins, not the flow's project. Correct while there is
// one workspace; join through flows when multi-project lands.
function projectSettings(db: Db): ProjectSettings {
  const project = db.select().from(projects).limit(1).get()
  return { ...DEFAULT_SETTINGS, ...(project?.settings as ProjectSettings | undefined) }
}

const projectConcurrency = (db: Db): number => projectSettings(db).concurrency

/**
 * Rebuilds a run's fal payload from the graph it came from.
 *
 * The node_runs row deliberately stores only the hash, so the prompt cannot
 * drift between what was hashed and what is sent. The cost of that is this
 * lookup: the graph is the source of truth, and a run whose node has since been
 * deleted must fail rather than dispatch an empty prompt at full price.
 */
function buildInput(db: Db, run: NodeRun, model: ModelSpec): Record<string, unknown> {
  const flow = db.select().from(flows).where(eq(flows.id, run.flowId)).get()
  if (!flow) throw new Error(`Flow ${run.flowId} no longer exists`)

  const graph = flow.graphJson as Flow
  const node = graph.nodes.find((n) => n.id === run.nodeId)
  if (!node) throw new Error(`Node ${run.nodeId} no longer exists in the graph`)

  const library = new Map(
    db.select().from(sources).where(eq(sources.projectId, flow.projectId)).all().map((r) => [r.id, r]),
  )
  const anchorRefs = referenceFiles(graph, run.nodeId, library)
  const prompt = composePrompt(graph, run.nodeId, library)

  const frameFor = (role: 'start_frame' | 'end_frame'): AssetRef | undefined => {
    const edge = graph.edges.find((e) => e.to === run.nodeId && e.role === role)
    if (!edge) return undefined
    const source = db
      .select()
      .from(nodeRuns)
      .where(and(eq(nodeRuns.flowId, run.flowId), eq(nodeRuns.nodeId, edge.from), eq(nodeRuns.status, 'succeeded')))
      .get()
    if (!source) return undefined
    const refs = (source.outputRefs as string[] | null) ?? []
    const asset = refs[0] ? db.select().from(assets).where(eq(assets.id, refs[0])).get() : undefined
    return asset ? { id: asset.id, path: asset.path, mime: asset.mime } : undefined
  }

  return buildModelInput(node, model, {
    anchorRefs,
    prompt,
    startFrame: frameFor('start_frame'),
    endFrame: frameFor('end_frame'),
  })
}

/**
 * Atomic claim. SQLite serialises writes, so the UPDATE ... WHERE status='queued'
 * either wins or affects zero rows — two ticks can never take the same run and
 * pay fal twice for one node.
 */
export function claimNext(db: Db): NodeRun | null {
  const candidate = db
    .select()
    .from(nodeRuns)
    .where(eq(nodeRuns.status, 'queued'))
    .orderBy(nodeRuns.createdAt)
    .limit(1)
    .get()
  if (!candidate) return null

  const claimedAt = new Date().toISOString()
  const result = db
    .update(nodeRuns)
    .set({ status: 'claimed', claimedAt })
    .where(and(eq(nodeRuns.id, candidate.id), eq(nodeRuns.status, 'queued')))
    .run()

  if (result.changes === 0) return null
  return { ...candidate, status: 'claimed', claimedAt }
}

/**
 * Only `claimed` is reaped. A `submitted` run has a fal_request_id and real
 * money attached — it is resumed by polling, never restarted, because
 * restarting it pays for the same render twice.
 */
export function reapStale(db: Db): number {
  const cutoff = new Date(Date.now() - STALE_CLAIM_MS).toISOString()
  return db
    .update(nodeRuns)
    .set({ status: 'queued', claimedAt: null })
    .where(and(eq(nodeRuns.status, 'claimed'), sql`${nodeRuns.claimedAt} < ${cutoff}`))
    .run().changes
}

function fail(db: Db, run: NodeRun, error: string) {
  const attempt = run.attempt + 1
  // Below the ceiling it goes back to `queued` so the next tick retries it;
  // at the ceiling it stops, rather than burning money in a loop.
  db.update(nodeRuns)
    .set({
      status: attempt >= MAX_ATTEMPTS ? 'failed' : 'queued',
      attempt,
      error,
      claimedAt: null,
      falRequestId: null,
    })
    .where(eq(nodeRuns.id, run.id))
    .run()
}

export type Measured = { width?: number; height?: number; durationMs?: number; fps?: number; codec?: string }

/**
 * Normalisation-on-write boundary.
 *
 * Models return wildly different fps and codecs. Normalising one clip as it
 * lands is free; fixing it retroactively across a client's whole library is
 * not, and it is what makes v2's concatenation a cut rather than a re-encode.
 *
 * The measurements come back from the probe, never from the model's own claim
 * about what it sent — a row that records what was requested turns every
 * downstream length check into a check of our own optimism.
 *
 * Dimensions are deliberately left alone. There is no project-level canvas
 * size to normalise to, and cropping a clip on the way in would throw away
 * framing the export step needs: geometry is a per-format decision, made once,
 * at export.
 */
async function normalise(
  file: string,
  output: ParsedOutput,
  settings: ProjectSettings,
): Promise<Measured> {
  if (!output.mime.startsWith('video/')) {
    return { width: output.width, height: output.height, durationMs: output.durationMs }
  }

  let measured: Probe
  try {
    measured = await probe(file)
  } catch (error) {
    // A missing ffmpeg must not lose a render that fal has already been paid
    // for. Throwing here would fail the run, return it to `queued`, and buy the
    // same clip again on the next tick — three times, then failed, with the
    // bytes sitting on disk and no row pointing at them. The file is kept with
    // the model's own claim about it; fps and codec stay null, and the loud
    // error arrives at export time, where it costs nothing.
    if (error instanceof FfmpegMissingError) {
      return { width: output.width, height: output.height, durationMs: output.durationMs }
    }
    throw error
  }

  if (measured.fps === settings.fps && measured.codec === settings.codec) {
    // Re-encoding a conforming clip costs time and a generation of quality for
    // a file that is already correct.
    return measured
  }

  const encoder = encoderFor(settings.codec)
  const normalised = `${file}.normalised${path.extname(file)}`
  await ffmpeg(['-i', file, '-r', String(settings.fps), '-c:v', encoder, '-pix_fmt', 'yuv420p', normalised])
  renameSync(normalised, file)
  return probe(file)
}

async function persistOutputs(
  db: Db,
  run: NodeRun,
  outputs: ParsedOutput[],
  download: (url: string) => Promise<Buffer>,
  storeRoot: string,
) {
  const store = localStore(storeRoot)
  const settings = projectSettings(db)
  const refs: string[] = []

  for (const output of outputs) {
    // From the mime, not the URL: a fixture carries its bytes as a data: URI,
    // which has no filename to take an extension from.
    const ext = EXT_BY_MIME[output.mime] ?? '.bin'
    const id = randomUUID()
    const key = path.join(run.id, `${id}${ext}`)
    const savedPath = store.put(key, await download(output.url))
    // In place, before the row exists: no asset may be recorded that skipped
    // this, or the library ends up half-normalised and nothing downstream can
    // assume anything.
    const measured = await normalise(savedPath, output, settings)

    db.insert(assets)
      .values({
        id,
        path: savedPath,
        mime: output.mime,
        width: measured.width ?? null,
        height: measured.height ?? null,
        durationMs: measured.durationMs ?? null,
        fps: measured.fps ?? null,
        codec: measured.codec ?? null,
        sourceRunId: run.id,
        createdAt: new Date().toISOString(),
      })
      .run()
    refs.push(id)
  }

  const model = byId(run.modelId)
  const exact = model
    ? estimateCostCents(model, {
        images: outputs.length,
        width: outputs[0]?.width,
        height: outputs[0]?.height,
        durationSec: outputs[0]?.durationMs ? outputs[0].durationMs / 1000 : undefined,
      })
    : 0
  // Rounds to the nearest cent, but a real spend never rounds down to zero:
  // a ledger that reports $0.00 for a run fal charged for defeats the whole
  // "see exactly what this creative cost" feature.
  //
  // ponytail: this is the registry's ESTIMATE, not an invoiced amount — fal
  // does not return a price with the result. Good enough to price a graph and
  // enforce a cap; reconcile against a real invoice before the README claims
  // the number is what you were charged. Integer cents also drift by up to half
  // a cent per node on a large graph.
  const costCents = exact > 0 ? Math.max(1, Math.round(exact)) : 0

  db.update(nodeRuns)
    .set({ status: 'succeeded', outputRefs: refs, costCents, error: null, claimedAt: null })
    .where(eq(nodeRuns.id, run.id))
    .run()
}

/**
 * One pass of the loop. Split out from `startWorker` so tests drive it
 * deterministically instead of sleeping and hoping.
 *
 * ponytail: single-threaded pass, one dispatch per tick. Fine at a 2s tick and
 * jobs measured in seconds-to-minutes; parallelise inside a tick if a large
 * graph makes the queue drain too slowly.
 */
export async function tick(db: Db, options: TickOptions): Promise<void> {
  const { adapter, download = defaultDownload } = options
  const storeRoot = options.storeRoot ?? assetsDir()
  // An explicit option wins (tests pin it); otherwise it comes from the project
  // row, which is what makes `settings.concurrency` a real setting rather than
  // a documented one.
  const concurrency = options.concurrency ?? projectConcurrency(db)

  reapStale(db)

  // Resume first. On boot this re-adopts anything the previous process left in
  // flight, by fal_request_id, before spending on anything new.
  const inFlight = db
    .select()
    .from(nodeRuns)
    .where(inArray(nodeRuns.status, ['submitted', 'polling']))
    .all()

  for (const run of inFlight) {
    if (!run.falRequestId) {
      fail(db, run, 'In flight with no fal request id')
      continue
    }
    try {
      const result = await adapter.poll(run.falRequestId)
      if (result.status === 'COMPLETED' && result.outputs) {
        await persistOutputs(db, run, result.outputs, download, storeRoot)
      } else if (result.status === 'FAILED') {
        fail(db, run, result.error ?? 'fal reported FAILED')
      } else {
        db.update(nodeRuns).set({ status: 'polling' }).where(eq(nodeRuns.id, run.id)).run()
      }
    } catch (error) {
      fail(db, run, error instanceof Error ? error.message : String(error))
    }
  }

  // Fill the budget rather than dispatching one per tick. Claiming a single run
  // per tick made `concurrency` decorative — a twelve-node graph drained at one
  // node every two seconds no matter what the project setting said.
  //
  // Claim the whole batch *before* dispatching any of it. Interleaving the two
  // lets a run that fails and returns to `queued` be re-claimed later in the
  // same loop, burning all three attempts in one tick against, say, a network
  // that is down for a second.
  const batch: NodeRun[] = []
  for (let slot = inFlight.length; slot < concurrency; slot++) {
    const run = claimNext(db)
    if (!run) break
    batch.push(run)
  }

  for (const run of batch) await dispatch(db, run, adapter)
}

async function dispatch(db: Db, run: NodeRun, adapter: Adapter) {
  const model = byId(run.modelId)
  if (!model) {
    fail(db, run, `Unknown model ${run.modelId}`)
    return
  }

  let input: Record<string, unknown>
  try {
    input = buildInput(db, run, model)
  } catch (error) {
    // Refusing beats dispatching a payload we know is wrong: an empty prompt
    // is billed exactly like a real one.
    fail(db, run, error instanceof Error ? error.message : String(error))
    return
  }

  try {
    const { requestId } = await adapter.submit({ model, input, hash: run.inputHash })
    // Persisted the instant fal accepts. A crash one line later must not orphan
    // a render that is already being billed.
    //
    // `attempt` is bumped only by fail(), so one dispatch counts once. Bumping
    // it here as well made every failure cost two attempts and the retry
    // ceiling fire after one and a half retries.
    db.update(nodeRuns)
      .set({ status: 'submitted', falRequestId: requestId })
      .where(eq(nodeRuns.id, run.id))
      .run()
  } catch (error) {
    fail(db, run, error instanceof Error ? error.message : String(error))
  }
}

export function startWorker(db: Db, options: TickOptions) {
  let stopped = false
  const run = async () => {
    while (!stopped) {
      try {
        await tick(db, options)
      } catch (error) {
        console.error('[worker] tick failed', error)
      }
      await new Promise((resolve) => setTimeout(resolve, TICK_MS))
    }
  }
  void run()
  return () => {
    stopped = true
  }
}
