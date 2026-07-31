import { randomUUID } from 'node:crypto'
import { eq } from 'drizzle-orm'
import type { BetterSQLite3Database } from 'drizzle-orm/better-sqlite3'
import { projects, flows, anchors } from '../db/schema'
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

export function createAnchor(
  db: Db,
  projectId: string,
  input: { kind: string; refImages: string[]; notes?: string; name?: string },
) {
  const id = `anchor:${randomUUID().slice(0, 8)}`
  db.insert(anchors)
    .values({
      id,
      projectId,
      // `kind` doubles as the display name. Three products all reading
      // "product v1" in the rail is indistinguishable at a glance.
      kind: input.name ?? input.kind,
      refImages: input.refImages,
      notes: input.notes ?? null,
      version: 1,
      createdAt: new Date().toISOString(),
    })
    .run()
  return id
}

/**
 * New photos for the same product. Bumping the version is what greys out every
 * downstream node — the version is in the input hash, so nothing else has to
 * know this happened.
 */
export function bumpAnchor(db: Db, anchorId: string, refImages?: string[]) {
  const anchor = db.select().from(anchors).where(eq(anchors.id, anchorId)).get()
  if (!anchor) throw new Error(`No anchor ${anchorId}`)

  db.update(anchors)
    .set({
      version: anchor.version + 1,
      ...(refImages ? { refImages } : {}),
    })
    .where(eq(anchors.id, anchorId))
    .run()

  return anchor.version + 1
}

export const listAnchors = (db: Db, projectId: string) =>
  db.select().from(anchors).where(eq(anchors.projectId, projectId)).all()

/**
 * Removing an anchor leaves its chip on any node still holding it. Those nodes
 * hash against a version of 0 from then on, which is correct: the product they
 * were anchored to no longer exists, so they are legitimately stale.
 */
export function deleteAnchor(db: Db, anchorId: string) {
  db.delete(anchors).where(eq(anchors.id, anchorId)).run()
}
