import { describe, test, expect } from 'vitest'
import { randomUUID } from 'node:crypto'
import { tempDb } from '../helpers/db'
import { nodeRuns, messages } from '@/db/schema'
import {
  DEFAULT_FLOW_ID,
  DEFAULT_PROJECT_ID,
  LastFlowError,
  NoSuchFlowError,
  createFlow,
  deleteFlow,
  ensureWorkspace,
  flowSlug,
  landingFlow,
  listFlows,
  renameFlow,
  resolveFlow,
  saveGraph,
} from '@/core/workspace'
import type { Flow } from '@/core/types'

const EMPTY: Flow = { nodes: [], edges: [] }

const seedRun = (db: ReturnType<typeof tempDb>['db'], flowId: string) =>
  db
    .insert(nodeRuns)
    .values({
      id: randomUUID(),
      flowId,
      nodeId: 'image-1',
      inputHash: 'h',
      status: 'succeeded',
      modelId: 'flux-2-pro',
      costCents: 400,
      createdAt: new Date().toISOString(),
    })
    .run()

describe('workspaces', () => {
  test('first boot creates one workspace and lands on it', () => {
    const { db } = tempDb()
    expect(landingFlow(db)).toBe(DEFAULT_FLOW_ID)
    expect(listFlows(db, DEFAULT_PROJECT_ID)).toHaveLength(1)
  })

  test('an unknown slug is refused rather than quietly resolved to the default', () => {
    // Silently falling back would edit a workspace the URL never named.
    const { db } = tempDb()
    ensureWorkspace(db)
    expect(() => resolveFlow(db, 'nope')).toThrow(NoSuchFlowError)
  })

  test('a slug resolves with or without the id prefix', () => {
    const { db } = tempDb()
    ensureWorkspace(db)
    expect(resolveFlow(db, 'default').flowId).toBe(DEFAULT_FLOW_ID)
    expect(resolveFlow(db, DEFAULT_FLOW_ID).flowId).toBe(DEFAULT_FLOW_ID)
    expect(flowSlug(DEFAULT_FLOW_ID)).toBe('default')
  })

  test('workspaces share one project, so one asset library serves them all', () => {
    const { db } = tempDb()
    const { projectId } = ensureWorkspace(db)
    const second = createFlow(db, projectId, 'spring')
    expect(resolveFlow(db, flowSlug(second)).projectId).toBe(projectId)
  })

  test('editing one workspace leaves the others alone', () => {
    const { db } = tempDb()
    const { projectId, flowId } = ensureWorkspace(db)
    const second = createFlow(db, projectId, 'spring')

    saveGraph(db, flowId, {
      nodes: [{ id: 'image-1', type: 'image', prompt: 'a', modelId: 'flux-2-pro', seed: 1 }],
      edges: [],
    })

    expect(resolveFlow(db, flowSlug(second)).flowId).toBe(second)
    const rows = listFlows(db, projectId)
    expect(rows.find((r) => r.id === second)!.name).toBe('spring')
    expect(rows).toHaveLength(2)
  })

  test('renaming does not move the write token every open canvas is holding', () => {
    // `updated_at` is the optimistic-concurrency stamp. Bumping it on a rename
    // makes every open tab think the graph was rewritten under it.
    const { db } = tempDb()
    const { projectId, flowId } = ensureWorkspace(db)
    createFlow(db, projectId, 'other')
    const before = listFlows(db, projectId).find((r) => r.id === flowId)!.updatedAt

    renameFlow(db, flowId, 'winter')

    const after = listFlows(db, projectId).find((r) => r.id === flowId)!
    expect(after.name).toBe('winter')
    expect(after.updatedAt).toBe(before)
  })

  test('deleting a workspace takes its runs and its chat thread with it', () => {
    // Neither table has a foreign key, so nothing cascades. An orphan run
    // resurfaces — with its cost — under the next id that happens to match.
    const { db } = tempDb()
    const { projectId, flowId } = ensureWorkspace(db)
    createFlow(db, projectId, 'spring')

    seedRun(db, flowId)
    db.insert(messages)
      .values({ flowId, role: 'user', content: 'hello', createdAt: new Date().toISOString() })
      .run()

    deleteFlow(db, flowId)

    expect(db.select().from(nodeRuns).all()).toHaveLength(0)
    expect(db.select().from(messages).all()).toHaveLength(0)
  })

  test('the last workspace cannot be deleted', () => {
    const { db } = tempDb()
    const { flowId } = ensureWorkspace(db)
    expect(() => deleteFlow(db, flowId)).toThrow(LastFlowError)
  })

  test('a deleted default does not come back on the next request', () => {
    // ensureWorkspace used to recreate `flow:default` whenever it was missing,
    // which handed back an empty canvas wearing the name you just deleted.
    const { db } = tempDb()
    const { projectId, flowId } = ensureWorkspace(db)
    const second = createFlow(db, projectId, 'spring')

    deleteFlow(db, flowId)

    expect(landingFlow(db)).toBe(second)
    expect(listFlows(db, projectId)).toHaveLength(1)
  })

  test('the demo keeps its landing spot when other workspaces are newer', () => {
    // DEMO=1 imports its graph into `flow:default`; most-recent-wins would send
    // `/` to whichever workspace was touched last and show a blank canvas.
    const { db } = tempDb()
    const { projectId } = ensureWorkspace(db)
    const second = createFlow(db, projectId, 'spring')
    saveGraph(db, second, EMPTY)

    expect(landingFlow(db)).toBe(DEFAULT_FLOW_ID)
  })
})
