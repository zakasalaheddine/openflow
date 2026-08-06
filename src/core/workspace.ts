import { randomUUID } from 'node:crypto'
import { eq } from 'drizzle-orm'
import type { BetterSQLite3Database } from 'drizzle-orm/better-sqlite3'
import { projects, flows, sources } from '../db/schema'
import { DEFAULT_SETTINGS } from './settings'
import { assertModelFits } from './wiring'
import { modelById } from '../models/catalog'
import type { Flow } from './types'

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Db = BetterSQLite3Database<any>

export const DEFAULT_PROJECT_ID = 'project:default'
export const DEFAULT_FLOW_ID = 'flow:default'

const EMPTY: Flow = { nodes: [], edges: [] }

/**
 * The canvas has to open onto something. Rather than an onboarding wizard
 * nobody asked for, first boot creates one empty project and one empty flow.
 */
export function ensureWorkspace(db: Db) {
  const now = new Date().toISOString()

  if (!db.select().from(projects).where(eq(projects.id, DEFAULT_PROJECT_ID)).get()) {
    db.insert(projects)
      .values({
        id: DEFAULT_PROJECT_ID,
        name: 'Untitled project',
        settings: DEFAULT_SETTINGS,
        createdAt: now,
      })
      .run()
  }

  if (!db.select().from(flows).where(eq(flows.id, DEFAULT_FLOW_ID)).get()) {
    db.insert(flows)
      .values({
        id: DEFAULT_FLOW_ID,
        projectId: DEFAULT_PROJECT_ID,
        name: 'Untitled flow',
        graphJson: EMPTY,
        updatedAt: now,
      })
      .run()
  }

  return { projectId: DEFAULT_PROJECT_ID, flowId: DEFAULT_FLOW_ID }
}

export class StaleGraphError extends Error {
  constructor() {
    super('Someone else changed this flow while you were editing. Reloading.')
    this.name = 'StaleGraphError'
  }
}

/**
 * Strictly increasing, because `updated_at` is the write token.
 *
 * `new Date().toISOString()` has millisecond resolution, and an agent turn
 * lands several tool calls inside one. Two writes sharing a stamp would let a
 * PATCH built on the *first* one pass the guard against the second, which is
 * exactly the lost update the guard exists to prevent.
 */
const stamp = (previous?: string) => {
  const now = new Date().toISOString()
  if (!previous || now > previous) return now
  return new Date(new Date(previous).getTime() + 1).toISOString()
}

/** Returns the new write token. Every caller that will write again must keep it. */
/**
 * Every write goes through here, so the capability gate does too.
 *
 * Not only in the inspector: the agent sets modelId, and a rule that lives in a
 * React component is not a rule. A graph whose model cannot take the wires
 * drawn into it never reaches the database, where Run would find it and bill
 * for output that ignored them.
 */
function assertModelsFit(graph: Flow) {
  for (const node of graph.nodes) {
    if (node.type !== 'image' && node.type !== 'video') continue
    assertModelFits(graph, node.id, modelById(node.modelId))
  }
}

export function saveGraph(db: Db, flowId: string, graph: Flow) {
  assertModelsFit(graph)
  const previous = db.select().from(flows).where(eq(flows.id, flowId)).get()?.updatedAt
  const updatedAt = stamp(previous)
  db.update(flows).set({ graphJson: graph, updatedAt }).where(eq(flows.id, flowId)).run()
  return updatedAt
}

/**
 * The guarded write, for callers that hold a whole graph assembled from a read.
 *
 * The canvas is one: it PATCHes every node it has, so a write built on a stale
 * read does not merge badly — it erases whatever arrived in between.
 */
export function saveGraphIfCurrent(db: Db, flowId: string, graph: Flow, expected: string) {
  const row = db.select().from(flows).where(eq(flows.id, flowId)).get()
  if (!row) throw new Error(`No flow ${flowId}`)
  if (row.updatedAt !== expected) throw new StaleGraphError()
  return saveGraph(db, flowId, graph)
}

export type SourceKind = 'image' | 'video' | 'text'

export function createSource(
  db: Db,
  projectId: string,
  input: { kind: SourceKind; files?: string[]; text?: string; notes?: string },
) {
  const id = `source:${randomUUID().slice(0, 8)}`
  db.insert(sources)
    .values({
      id,
      projectId,
      kind: input.kind,
      files: input.files ?? [],
      text: input.text ?? null,
      notes: input.notes ?? null,
      version: 1,
      createdAt: new Date().toISOString(),
    })
    .run()
  return id
}

/**
 * New files, or new text, for the same asset. Bumping the version is what greys
 * out every downstream node — planRun folds it into the source node's hash, so
 * nothing else has to know this happened.
 */
export function bumpSource(db: Db, sourceId: string, next: { files?: string[]; text?: string }) {
  const source = db.select().from(sources).where(eq(sources.id, sourceId)).get()
  if (!source) throw new Error(`No source ${sourceId}`)

  db.update(sources)
    .set({
      version: source.version + 1,
      ...(next.files ? { files: next.files } : {}),
      ...(next.text !== undefined ? { text: next.text } : {}),
    })
    .where(eq(sources.id, sourceId))
    .run()

  return source.version + 1
}

export const listSources = (db: Db, projectId: string) =>
  db.select().from(sources).where(eq(sources.projectId, projectId)).all()

/**
 * Removing an asset leaves any source node still pointing at it. Those nodes
 * hash against a version of 0 from then on, which is correct: the file they
 * referenced no longer exists, so everything built from it is legitimately
 * stale rather than quietly served from cache.
 */
export function deleteSource(db: Db, sourceId: string) {
  db.delete(sources).where(eq(sources.id, sourceId)).run()
}
