import { randomUUID } from 'node:crypto'
import { mkdirSync } from 'node:fs'
import path from 'node:path'
import { eq } from 'drizzle-orm'
import type { BetterSQLite3Database } from 'drizzle-orm/better-sqlite3'
import { assets, flows, projects } from '../db/schema'
import { DEFAULT_SETTINGS, type ProjectSettings } from './settings'
import { nodeHashes } from './executor'
import { currentRun } from './runs'
import { concat, probe } from './ffmpeg'
import { sequenceInputs } from './wiring'
import { readGraph } from './graph'
import type { NodeId } from './types'

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Db = BetterSQLite3Database<any>

/**
 * A cut that cannot be made, said in words a person can act on.
 *
 * Distinct from a thrown Error so the worker can record it as a run failure
 * with its own message rather than as "something went wrong in ffmpeg". Every
 * one of these used to be a `rejected` entry in an export result, which meant
 * you only discovered a stale shot at the moment you tried to ship the film.
 */
export class CutRefused extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'CutRefused'
  }
}

/**
 * Cuts a sequence's clips into one file, in order, and records it as an asset.
 *
 * Every clip must have a render matching its *current* settings — the same bar
 * a single node has to clear. Half a film assembled from three fresh shots and
 * two stale ones is worse than no film: it looks finished.
 *
 * No caching here, deliberately. This used to key the cut on `sequence:<hash>`
 * and check the file still existed, because it ran inside export where nothing
 * else would. It runs inside a node run now, and `enqueueRun` already skips a
 * node whose hash has a succeeded run — the same cache every other node uses.
 *
 * Nothing is published to a hosted store. A film is never sent to a model, so
 * it needs no public URL; `persistOutputs` publishes because a reference image
 * has to be reachable by fal.
 */
export async function cutSequence(
  db: Db,
  run: { id: string; flowId: string; nodeId: NodeId },
  storeRoot: string,
): Promise<string> {
  const flow = db.select().from(flows).where(eq(flows.id, run.flowId)).get()
  if (!flow) throw new Error(`No flow ${run.flowId}`)

  const project = db.select().from(projects).where(eq(projects.id, flow.projectId)).get()
  const settings: ProjectSettings = { ...DEFAULT_SETTINGS, ...(project?.settings as ProjectSettings) }
  const graph = readGraph(flow.graphJson)

  const clips = sequenceInputs(graph, run.nodeId)
  if (clips.length === 0) throw new CutRefused('no clips are wired into this sequence.')

  const hashes = nodeHashes(db, run.flowId)
  const files: string[] = []

  for (const clipId of clips) {
    const clipRun = currentRun(db, run.flowId, clipId, hashes.get(clipId))
    if (!clipRun) {
      throw new CutRefused(`${clipId} has no render matching its current settings.`)
    }
    const assetId = ((clipRun.outputRefs as string[] | null) ?? [])[0]
    const asset = assetId ? db.select().from(assets).where(eq(assets.id, assetId)).get() : undefined
    if (!asset) throw new CutRefused(`${clipId} rendered nothing to cut.`)
    if (!asset.mime.startsWith('video/')) throw new CutRefused(`${clipId} did not render a clip.`)
    files.push(asset.path)
  }

  // Under the run's own directory, the same convention `persistOutputs` uses.
  // A film owned by the run that cut it is a film the ledger can explain.
  const id = randomUUID()
  const file = path.join(storeRoot, run.id, `${id}.mp4`)
  mkdirSync(path.dirname(file), { recursive: true })
  await concat(files, file, settings)

  const measured = await probe(file)
  db.insert(assets)
    .values({
      id,
      path: file,
      hostedUrl: null,
      mime: 'video/mp4',
      width: measured.width,
      height: measured.height,
      durationMs: measured.durationMs,
      fps: measured.fps,
      codec: measured.codec,
      sourceRunId: run.id,
      createdAt: new Date().toISOString(),
    })
    .run()

  return id
}
