import { randomUUID } from 'node:crypto'
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import path from 'node:path'
import { eq, inArray } from 'drizzle-orm'
import type { BetterSQLite3Database } from 'drizzle-orm/better-sqlite3'
import { projects, sources, flows, nodeRuns } from '../db/schema'
import { enqueueRun } from './executor'
import { assetsDir } from '../env'
import { DEFAULT_SETTINGS, type ProjectSettings } from './settings'
import { tick, type TickOptions } from '../worker/loop'
import type { Flow, ModelRole } from './types'

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Db = BetterSQLite3Database<any>

/** A flow file is a project, its assets and one graph — enough to run headless. */
export type FlowFile = {
  project: string
  settings?: Partial<ProjectSettings>
  sources?: { id: string; kind: 'image' | 'video' | 'text'; files?: string[]; text?: string; version?: number }[]
  flow: Flow
  /**
   * Where the file's `sources[].files` are relative to. Set by `readFlowFile`;
   * absent on a spec built in memory, which then has nothing to copy.
   */
  baseDir?: string
}

export const readFlowFile = (file: string): FlowFile => ({
  ...(JSON.parse(readFileSync(file, 'utf8')) as FlowFile),
  baseDir: path.dirname(path.resolve(file)),
})

/**
 * Copies a source's files into the asset store and says whether the bytes moved.
 *
 * A flow file names its references by store key — `refs/bottle.jpg` — and the
 * worker reads them back through the store, because fal fetches its inputs over
 * the network and a reference has to be real bytes somewhere. Without this the
 * import records a path nothing ever wrote, and every node fails `ENOENT` on a
 * file the flow file was sitting next to the whole time.
 *
 * Changed bytes are a new product, not a new path: the caller bumps `version` so
 * descendants go stale. Overwriting without that bump is worse than not copying
 * — the store holds the new image and the cache keeps serving renders of the old
 * one, with nothing on screen to say why.
 */
function copySourceFiles(baseDir: string, files: string[]) {
  let changed = false
  for (const file of files) {
    const from = path.resolve(baseDir, file)
    const to = path.join(assetsDir(), file)
    // Loud here, or `ENOENT` three nodes later from a worker that cannot say
    // which flow file named the thing or where it was looked for. Already in the
    // store is fine — that is a reference uploaded through the canvas.
    if (!existsSync(from)) {
      if (existsSync(to)) continue
      throw new Error(`Source file not found: ${file} (looked in ${baseDir}, and in the asset store)`)
    }
    const bytes = readFileSync(from)
    if (existsSync(to) && readFileSync(to).equals(bytes)) continue
    mkdirSync(path.dirname(to), { recursive: true })
    writeFileSync(to, bytes)
    changed = true
  }
  return changed
}

/**
 * Idempotent. Re-importing the same file updates the graph in place rather than
 * creating a second project, so a second `bin/run.ts` invocation hits the cache
 * instead of rebuilding everything under new ids.
 */
export function importFlowFile(db: Db, spec: FlowFile, key = spec.project) {
  const projectId = `project:${key}`
  const flowId = `flow:${key}`
  const now = new Date().toISOString()
  const settings = { ...DEFAULT_SETTINGS, ...spec.settings }

  const existing = db.select().from(projects).where(eq(projects.id, projectId)).get()
  if (existing) {
    db.update(projects).set({ settings }).where(eq(projects.id, projectId)).run()
  } else {
    db.insert(projects).values({ id: projectId, name: spec.project, settings, createdAt: now }).run()
  }

  for (const source of spec.sources ?? []) {
    const replaced = spec.baseDir ? copySourceFiles(spec.baseDir, source.files ?? []) : false
    const found = db.select().from(sources).where(eq(sources.id, source.id)).get()
    if (found) {
      // A file that does not state a version must not reset one bumped in the
      // UI. Silently reverting a bump would un-stale every downstream node and
      // serve the old product back from cache.
      //
      // New bytes under the same path do bump it, though. Swapping the photo in
      // `refs/` is how anyone re-shoots a product, and a version that ignored
      // that would render the old bottle from cache and call it fresh.
      db.update(sources)
        .set({
          kind: source.kind,
          files: source.files ?? [],
          text: source.text ?? null,
          ...(source.version === undefined
            ? replaced
              ? { version: found.version + 1 }
              : {}
            : { version: source.version }),
        })
        .where(eq(sources.id, source.id))
        .run()
    } else {
      db.insert(sources)
        .values({
          id: source.id,
          projectId,
          kind: source.kind,
          files: source.files ?? [],
          text: source.text ?? null,
          version: source.version ?? 1,
          createdAt: now,
        })
        .run()
    }
  }

  const foundFlow = db.select().from(flows).where(eq(flows.id, flowId)).get()
  if (foundFlow) {
    db.update(flows).set({ graphJson: spec.flow, updatedAt: now }).where(eq(flows.id, flowId)).run()
  } else {
    db.insert(flows)
      .values({ id: flowId, projectId, name: spec.project, graphJson: spec.flow, updatedAt: now })
      .run()
  }

  return { projectId, flowId }
}

const TERMINAL = ['succeeded', 'failed']

/**
 * Drives ticks until nothing is left in flight. `maxTicks` is a deadlock guard,
 * not a timeout — a stuck run should surface as a failure, not hang a CLI.
 */
export async function drain(db: Db, flowId: string, options: TickOptions, maxTicks = 500) {
  for (let i = 0; i < maxTicks; i++) {
    const runs = db.select().from(nodeRuns).where(eq(nodeRuns.flowId, flowId)).all()
    if (runs.length > 0 && runs.every((r) => TERMINAL.includes(r.status))) return runs
    await tick(db, options)
  }
  throw new Error(`Flow ${flowId} did not settle within ${maxTicks} ticks`)
}

export type RunSummary = {
  flowId: string
  enqueued: number
  cached: number
  succeeded: number
  failed: number
  costCents: number
}

export async function runFlow(
  db: Db,
  spec: FlowFile,
  options: TickOptions & { role?: ModelRole; confirmOverspend?: boolean },
): Promise<RunSummary> {
  const { flowId } = importFlowFile(db, spec)
  const { enqueued, cached } = enqueueRun(db, flowId, {
    role: options.role,
    confirmOverspend: options.confirmOverspend,
  })

  if (enqueued.length > 0) await drain(db, flowId, options)

  // Only this run's own dispatches are counted. Cached nodes cost zero by
  // definition, which is what makes "a second run costs $0" checkable.
  const runs = enqueued.length
    ? db
        .select()
        .from(nodeRuns)
        .where(inArray(nodeRuns.inputHash, enqueued.map((e) => e.inputHash)))
        .all()
    : []

  return {
    flowId,
    enqueued: enqueued.length,
    cached: cached.length,
    succeeded: runs.filter((r) => r.status === 'succeeded').length,
    failed: runs.filter((r) => r.status === 'failed').length,
    costCents: runs.reduce((sum, r) => sum + r.costCents, 0),
  }
}

export const newRunId = () => randomUUID()
