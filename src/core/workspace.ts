import { randomUUID } from 'node:crypto'
import { eq } from 'drizzle-orm'
import type { BetterSQLite3Database } from 'drizzle-orm/better-sqlite3'
import { projects, flows, sources } from '../db/schema'
import { DEFAULT_SETTINGS } from './settings'
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

export function saveGraph(db: Db, flowId: string, graph: Flow) {
  db.update(flows)
    .set({ graphJson: graph, updatedAt: new Date().toISOString() })
    .where(eq(flows.id, flowId))
    .run()
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
