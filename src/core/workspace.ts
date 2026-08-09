import { randomUUID } from 'node:crypto'
import { desc, eq } from 'drizzle-orm'
import type { BetterSQLite3Database } from 'drizzle-orm/better-sqlite3'
import { projects, flows, sources, nodeRuns, messages, exports } from '../db/schema'
import { DEFAULT_SETTINGS } from './settings'
import { assertModelFits } from './wiring'
import { byId as modelOrNone } from '../models/catalog'
import type { Flow } from './types'

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Db = BetterSQLite3Database<any>

export const DEFAULT_PROJECT_ID = 'project:default'
export const DEFAULT_FLOW_ID = 'flow:default'

const EMPTY: Flow = { nodes: [], edges: [] }

/**
 * The canvas has to open onto something. Rather than an onboarding wizard
 * nobody asked for, first boot creates one empty project and one empty flow.
 *
 * The flow is created only when the project has *none* — not when
 * `flow:default` is missing. Deleting the default workspace while others exist
 * used to bring it straight back on the next request, an empty canvas wearing
 * the name of the one you just deleted.
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

  const existing = listFlows(db, DEFAULT_PROJECT_ID)
  if (existing.length === 0) {
    db.insert(flows)
      .values({
        id: DEFAULT_FLOW_ID,
        projectId: DEFAULT_PROJECT_ID,
        name: 'Untitled flow',
        graphJson: EMPTY,
        updatedAt: now,
      })
      .run()
    return { projectId: DEFAULT_PROJECT_ID, flowId: DEFAULT_FLOW_ID }
  }

  return { projectId: DEFAULT_PROJECT_ID, flowId: landingFlowId(existing) }
}

/**
 * Ids are prefixed (`flow:default`) and a colon needs `%3A` in a path, so the
 * URL carries the suffix alone. Both spellings are accepted on the way in —
 * `demo.ts` already strips the prefix, and a link someone pasted with it should
 * not 404.
 */
export const flowSlug = (id: string) => id.replace(/^flow:/, '')
const qualify = (slug: string) => (slug.startsWith('flow:') ? slug : `flow:${slug}`)

export class NoSuchFlowError extends Error {
  constructor(slug: string) {
    super(`No workspace '${slug}'. It may have been deleted.`)
    this.name = 'NoSuchFlowError'
  }
}

export type FlowRow = { id: string; name: string; updatedAt: string }

export const listFlows = (db: Db, projectId: string): FlowRow[] =>
  db
    .select({ id: flows.id, name: flows.name, updatedAt: flows.updatedAt })
    .from(flows)
    .where(eq(flows.projectId, projectId))
    .orderBy(desc(flows.updatedAt))
    .all()

/**
 * Default first, most-recently-touched second. `DEMO=1` imports its graph into
 * `flow:default` precisely because the canvas opens onto it — a plain
 * most-recent redirect breaks the demo the moment a second workspace exists.
 */
const landingFlowId = (rows: FlowRow[]) =>
  rows.find((row) => row.id === DEFAULT_FLOW_ID)?.id ?? rows[0].id

/** Where `/` sends you. */
export const landingFlow = (db: Db) => ensureWorkspace(db).flowId

/**
 * The id the request is scoped to. `undefined` means the landing flow, so every
 * caller that predates workspaces keeps working unchanged.
 */
export function resolveFlow(db: Db, slug?: string | null) {
  const fallback = ensureWorkspace(db)
  if (!slug) return fallback

  const row = db.select().from(flows).where(eq(flows.id, qualify(slug))).get()
  if (!row) throw new NoSuchFlowError(slug)
  return { projectId: row.projectId, flowId: row.id }
}

export function createFlow(db: Db, projectId: string, name: string) {
  const id = `flow:${randomUUID().slice(0, 8)}`
  db.insert(flows)
    .values({
      id,
      projectId,
      name: name.trim() || 'Untitled flow',
      graphJson: EMPTY,
      updatedAt: new Date().toISOString(),
    })
    .run()
  return id
}

/**
 * Renaming must not touch `updated_at`: it is the optimistic-concurrency token
 * every open canvas holds, and bumping it here would make every one of them
 * think someone had rewritten the graph.
 */
export function renameFlow(db: Db, flowId: string, name: string) {
  const trimmed = name.trim()
  if (!trimmed) throw new Error('A workspace needs a name.')
  db.update(flows).set({ name: trimmed }).where(eq(flows.id, flowId)).run()
  return trimmed
}

export class LastFlowError extends Error {
  constructor() {
    super('This is the only workspace. Make another one before deleting it.')
    this.name = 'LastFlowError'
  }
}

/**
 * `node_runs`, `messages` and `exports` carry `flow_id` as a bare text column
 * with no foreign key, so nothing cascades — they are deleted by hand here.
 *
 * Leaving them is not merely untidy. Every total is scoped `where(flowId = …)`,
 * so an orphan counts toward nothing until an id is reused, and then a deleted
 * workspace's renders, costs and errors reappear on a fresh canvas.
 *
 * The files are deliberately kept — both the assets a run paid for and anything
 * already written to the exports directory. Deleting a workspace forgets the
 * build; it does not reach onto the disk and delete finished work, which may
 * already have been sent to a client.
 */
export function deleteFlow(db: Db, flowId: string) {
  const row = db.select().from(flows).where(eq(flows.id, flowId)).get()
  if (!row) throw new NoSuchFlowError(flowSlug(flowId))
  if (listFlows(db, row.projectId).length <= 1) throw new LastFlowError()

  db.delete(nodeRuns).where(eq(nodeRuns.flowId, flowId)).run()
  db.delete(messages).where(eq(messages.flowId, flowId)).run()
  db.delete(exports).where(eq(exports.flowId, flowId)).run()
  db.delete(flows).where(eq(flows.id, flowId)).run()
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
    // A model the catalog no longer has cannot be checked for fit, and refusing
    // the save would trap the graph: you could not edit your way out of a row
    // you deleted from models.json. Run refuses it instead.
    const model = modelOrNone(node.modelId)
    if (model) assertModelFits(graph, node.id, model)
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
