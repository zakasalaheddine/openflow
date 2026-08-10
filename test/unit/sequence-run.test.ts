import { describe, test, expect } from 'vitest'
import { planRun, enqueueRun } from '@/core/executor'
import { LOCAL_CUT } from '@/core/runs'
import { nodeRuns } from '@/db/schema'
import { eq } from 'drizzle-orm'
import type { Flow } from '@/core/types'
import { tempDb, seedProject, seedFlow } from '../helpers/db'
import { seedRenderedNode, STUB_MP4 } from '../helpers/exports'

const clip = (id: string) =>
  ({ id, type: 'video', prompt: `shot ${id}`, durationSec: 5, audio: false, modelId: 'hailuo-2-3-pro', seed: 1 }) as const

const film = (): Flow => ({
  nodes: [clip('one'), clip('two'), { id: 'cut', type: 'sequence' }],
  edges: [
    { id: 'e1', from: 'one', to: 'cut', role: 'input', position: 0 },
    { id: 'e2', from: 'two', to: 'cut', role: 'input', position: 1 },
  ],
})

function prepared(rendered: string[]) {
  const { db } = tempDb()
  const projectId = seedProject(db)
  const flowId = seedFlow(db, projectId, film())
  for (const nodeId of rendered) {
    seedRenderedNode(db, flowId, nodeId, { file: STUB_MP4, mime: 'video/mp4', costCents: 50 })
  }
  return { db, flowId }
}

describe('a sequence in the plan', () => {
  test('is planned, and costs nothing', () => {
    const { db, flowId } = prepared([])
    const cut = planRun(db, flowId).find((p) => p.nodeId === 'cut')!

    expect(cut).toBeDefined()
    expect(cut.modelId).toBe(LOCAL_CUT)
    expect(cut.endpoint).toBe('local')
    expect(cut.estimatedCents).toBe(0)
  })

  test('reordering the shots changes its hash, so the old film is not reused', () => {
    const { db, flowId } = prepared([])
    const before = planRun(db, flowId).find((p) => p.nodeId === 'cut')!.inputHash

    const swapped: Flow = {
      ...film(),
      edges: [
        { id: 'e1', from: 'one', to: 'cut', role: 'input', position: 1 },
        { id: 'e2', from: 'two', to: 'cut', role: 'input', position: 0 },
      ],
    }
    const { db: db2 } = tempDb()
    const flow2 = seedFlow(db2, seedProject(db2), swapped)

    expect(planRun(db2, flow2).find((p) => p.nodeId === 'cut')!.inputHash).not.toBe(before)
  })

  test('enqueues a run the worker can claim, and does not touch the spend cap', () => {
    const { db, flowId } = prepared(['one', 'two'])
    const result = enqueueRun(db, flowId)

    const queued = db.select().from(nodeRuns).where(eq(nodeRuns.status, 'queued')).all()
    expect(queued.map((run) => run.nodeId)).toContain('cut')
    expect(queued.find((run) => run.nodeId === 'cut')!.modelId).toBe(LOCAL_CUT)
    // The two clips are already rendered, so the only work is the free one.
    expect(result.estimatedCents).toBe(0)
  })
})
