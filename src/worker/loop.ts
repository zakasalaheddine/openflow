import { randomUUID } from 'node:crypto'
import { readFileSync, renameSync } from 'node:fs'
import path from 'node:path'
import { eq, and, desc, inArray, sql } from 'drizzle-orm'
import type { BetterSQLite3Database } from 'drizzle-orm/better-sqlite3'
import { nodeRuns, assets, flows, sources, projects, type NodeRun } from '../db/schema'
import { estimateCostCents, type ModelSpec } from '../models/registry'
import { byId } from '../models/catalog'
import { buildModelInput } from '../models/input'
import { localStore, storeFor } from '../core/assets'
import { composePrompt, referenceFiles } from '../core/compose'
import { DEFAULT_SETTINGS, type ProjectSettings } from '../core/settings'
import { probe, ffmpeg, encoderFor, FfmpegMissingError, type Probe } from '../core/ffmpeg'
import { assetsDir } from '../env'
import { IN_FLIGHT } from '../core/executor'
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
const MIME_BY_EXT: Record<string, string> = Object.fromEntries(
  Object.entries(EXT_BY_MIME).map(([mime, ext]) => [ext, mime]),
)

/** 12 MB of raw bytes, which is ~16 MB of base64 in a single POST body. */
const MAX_INLINE_BYTES = 12 * 1024 * 1024

/**
 * Turns something on this machine into something fal can fetch.
 *
 * A reference is stored as a key (`uploads/x.png`) and a rendered frame as a
 * path — fal resolves neither, and says so: `file_download_error`, after the
 * render was already submitted. A location that is already an http URL is a
 * hosted asset and passes straight through; anything else is read off disk and
 * inlined as a data URI, which fal accepts anywhere it takes a URL.
 *
 * Through the store rather than `readFileSync`, so the containment check that
 * guards every other read guards this one too.
 *
 * ponytail: base64 is a third more bytes and the whole file sits in memory, so
 * this refuses above 12 MB rather than hanging on a POST nobody can debug. A
 * *video* wired in as a reference is the only unbounded path — uploads allow
 * 200 MB — and hosting those is what the store's `url()` is for.
 */
function fetchableUrl(location: string, mime: string | null, storeRoot: string): string {
  if (/^https?:\/\//.test(location)) return location

  const bytes = localStore(storeRoot).get(location)
  if (bytes.byteLength > MAX_INLINE_BYTES) {
    throw new Error(
      `${location} is ${Math.round(bytes.byteLength / 1024 / 1024)} MB, over the ${MAX_INLINE_BYTES / 1024 / 1024} MB limit for inlining into a fal request. Host it and store its URL instead.`,
    )
  }
  const resolved =
    mime ?? MIME_BY_EXT[path.extname(location).toLowerCase()] ?? 'application/octet-stream'
  return `data:${resolved};base64,${bytes.toString('base64')}`
}

function buildInput(
  db: Db,
  run: NodeRun,
  model: ModelSpec,
  storeRoot: string,
): Record<string, unknown> {
  const flow = db.select().from(flows).where(eq(flows.id, run.flowId)).get()
  if (!flow) throw new Error(`Flow ${run.flowId} no longer exists`)

  const graph = flow.graphJson as Flow
  const node = graph.nodes.find((n) => n.id === run.nodeId)
  if (!node) throw new Error(`Node ${run.nodeId} no longer exists in the graph`)

  const library = new Map(
    db.select().from(sources).where(eq(sources.projectId, flow.projectId)).all().map((r) => [r.id, r]),
  )
  // Mapped here and nowhere earlier: `referenceFiles` is also called by
  // planRun, which the canvas re-runs every 1.2s. Encoding every reference
  // image on every poll would be a base64 pass per node per tick.
  const anchorRefs = referenceFiles(graph, run.nodeId, library).map((key) =>
    fetchableUrl(key, null, storeRoot),
  )
  const prompt = composePrompt(graph, run.nodeId, library)

  const frameFor = (role: 'start_frame' | 'end_frame'): AssetRef | undefined => {
    const edge = graph.edges.find((e) => e.to === run.nodeId && e.role === role)
    if (!edge) return undefined
    // Newest first, and only then the first row. A node that has rendered more
    // than once — edit the prompt, render again, then run the clip — has two
    // succeeded rows, and an unordered `.get()` takes whichever the database
    // hands back, which is the *oldest*. The clip then anchors to a frame that
    // is no longer on the parent card, at full price, and reads as the model
    // ignoring its start frame. Same "latest run per node" rule the canvas uses
    // to decide which frame that card shows, so the two cannot disagree.
    //
    // ponytail: newest, not the one this run was hashed against — that would
    // need the run's resolved role, which the row does not carry. The two differ
    // only if the flow's role changed, or a prompt was edited back to an older
    // value, between enqueue and dispatch. Persist the role on node_runs if that
    // ever stops being exotic.
    const source = db
      .select()
      .from(nodeRuns)
      .where(and(eq(nodeRuns.flowId, run.flowId), eq(nodeRuns.nodeId, edge.from), eq(nodeRuns.status, 'succeeded')))
      .orderBy(desc(nodeRuns.createdAt))
      .get()
    const refs = (source?.outputRefs as string[] | null) ?? []
    const asset = refs[0] ? db.select().from(assets).where(eq(assets.id, refs[0])).get() : undefined
    // The edge exists, so the graph promises this clip is anchored to a frame.
    // buildModelInput would quietly omit `image_url` and fal would bill a
    // text-to-video render at full price — refusing costs nothing.
    if (!asset) throw new Error(`Upstream ${edge.from} has no rendered ${role} for ${run.nodeId}`)
    return {
      id: asset.id,
      // The hosted URL when there is one — fal fetches it directly rather than
      // having the frame base64'd into the request.
      path: fetchableUrl(asset.hostedUrl ?? asset.path, asset.mime, storeRoot),
      mime: asset.mime,
    }
  }

  return buildModelInput(node, model, {
    anchorRefs,
    prompt,
    startFrame: frameFor('start_frame'),
    endFrame: frameFor('end_frame'),
  })
}

/**
 * Whether a queued run is still waiting on a parent node.
 *
 * `tick` claims up to `concurrency` runs in one pass, so an image and the clip
 * built from it are otherwise dispatched together — and the clip, finding no
 * succeeded frame, is billed for a render that ignored its anchor. Held here
 * rather than at dispatch: dispatch failure burns an attempt, and a clip that
 * simply waited its turn would exhaust MAX_ATTEMPTS and land `failed`.
 *
 * Every parent blocks it, including `reference` edges that could in principle
 * proceed. Conservative on purpose — it costs a little parallelism, never
 * correctness.
 *
 * A parent that has genuinely `failed` is not in flight, so this stops holding
 * the child: it dispatches, buildInput refuses, and the child fails honestly
 * rather than leaving `drain` to spin out its tick budget.
 *
 * ponytail: linear scan with a graph load per candidate, called up to
 * `concurrency` times a tick. Nothing at twelve nodes; cache the flow graph for
 * the duration of a tick if a large queue makes it show.
 */
function waitingOnUpstream(db: Db, run: NodeRun): boolean {
  const flow = db.select().from(flows).where(eq(flows.id, run.flowId)).get()
  if (!flow) return false

  const parents = (flow.graphJson as Flow).edges
    .filter((e) => e.to === run.nodeId)
    .map((e) => e.from)
  if (parents.length === 0) return false

  return (
    db
      .select()
      .from(nodeRuns)
      .where(
        and(
          eq(nodeRuns.flowId, run.flowId),
          inArray(nodeRuns.nodeId, parents),
          inArray(nodeRuns.status, [...IN_FLIGHT]),
        ),
      )
      .all().length > 0
  )
}

/**
 * Atomic claim. SQLite serialises writes, so the UPDATE ... WHERE status='queued'
 * either wins or affects zero rows — two ticks can never take the same run and
 * pay fal twice for one node.
 */
export function claimNext(db: Db): NodeRun | null {
  const candidates = db
    .select()
    .from(nodeRuns)
    .where(eq(nodeRuns.status, 'queued'))
    .orderBy(nodeRuns.createdAt)
    .all()

  for (const candidate of candidates) {
    if (waitingOnUpstream(db, candidate)) continue

    const claimedAt = new Date().toISOString()
    const result = db
      .update(nodeRuns)
      .set({ status: 'claimed', claimedAt })
      .where(and(eq(nodeRuns.id, candidate.id), eq(nodeRuns.status, 'queued')))
      .run()

    // Lost the race to another tick — try the next one rather than idling.
    if (result.changes === 0) continue
    return { ...candidate, status: 'claimed', claimedAt }
  }

  return null
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
  const local = localStore(storeRoot)
  const store = storeFor(storeRoot)
  const settings = projectSettings(db)
  const refs: string[] = []

  for (const output of outputs) {
    // From the mime, not the URL: a fixture carries its bytes as a data: URI,
    // which has no filename to take an extension from.
    const ext = EXT_BY_MIME[output.mime] ?? '.bin'
    const id = randomUUID()
    const key = path.join(run.id, `${id}${ext}`)
    const savedPath = await local.put(key, await download(output.url))
    // In place, before the row exists: no asset may be recorded that skipped
    // this, or the library ends up half-normalised and nothing downstream can
    // assume anything.
    const measured = await normalise(savedPath, output, settings)

    // Published after normalising, never before: a hosted store handing out the
    // pre-transcode clip would serve a file whose fps and codec disagree with
    // the row that describes it. Local-only stores publish nothing — `hosted`
    // *is* the local store, and re-putting identical bytes would be a second
    // write for no one.
    const hostedUrl = store.hosted ? await store.put(key, readFileSync(savedPath)) : null

    db.insert(assets)
      .values({
        id,
        path: savedPath,
        hostedUrl,
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

  for (const run of batch) await dispatch(db, run, adapter, storeRoot)
}

async function dispatch(db: Db, run: NodeRun, adapter: Adapter, storeRoot: string) {
  const model = byId(run.modelId)
  if (!model) {
    fail(db, run, `Unknown model ${run.modelId}`)
    return
  }

  let input: Record<string, unknown>
  try {
    input = buildInput(db, run, model, storeRoot)
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
