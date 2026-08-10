import { describe, test, expect } from 'vitest'
import { eq } from 'drizzle-orm'
import { enqueueRun } from '@/core/executor'
import { tick } from '@/worker/loop'
import { createAdapter } from '@/models/fal'
import { assets, nodeRuns, flows } from '@/db/schema'
import type { Flow } from '@/core/types'
import { tempDb, seedProject, seedFlow } from '../helpers/db'
import { seedRenderedNode, STUB_MP4 } from '../helpers/exports'

const clip = (id: string, prompt = `shot ${id}`) =>
  ({ id, type: 'video', prompt, durationSec: 5, audio: false, modelId: 'hailuo-2-3-pro', seed: 1 }) as const

// `twoPrompt` lets a test reshoot 'two' after it has already rendered, which is
// what makes its old render stale rather than simply missing.
const film = (twoPrompt?: string): Flow => ({
  nodes: [clip('one'), clip('two', twoPrompt), { id: 'cut', type: 'sequence' }],
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

const adapter = () => createAdapter({ mode: 'stub' })

const cutRun = (db: ReturnType<typeof tempDb>['db'], flowId: string) =>
  db.select().from(nodeRuns).where(eq(nodeRuns.flowId, flowId)).all().find((run) => run.nodeId === 'cut')!

describe('the worker cutting a film', () => {
  test('succeeds with the film as its output, at no cost', async () => {
    const { db, flowId } = prepared(['one', 'two'])
    enqueueRun(db, flowId)

    await tick(db, { adapter: adapter() })

    const run = cutRun(db, flowId)
    expect(run.status).toBe('succeeded')
    expect(run.costCents).toBe(0)

    const refs = run.outputRefs as string[]
    expect(refs).toHaveLength(1)
    expect(db.select().from(assets).where(eq(assets.id, refs[0])).get()!.mime).toBe('video/mp4')
  })

  test('a stale clip fails the cut by name instead of shipping half a film', async () => {
    const { db, flowId } = prepared(['one', 'two'])
    enqueueRun(db, flowId)

    // 'two' is reshot after the cut is already queued: both clips are cached at
    // enqueue time (no new rows, so `cut` is never held on an in-flight
    // render), and the graph update below is what makes the already-rendered
    // 'two' stale rather than simply missing — the same bar a single node has
    // to clear.
    db.update(flows).set({ graphJson: film('a reshot two') }).where(eq(flows.id, flowId)).run()

    await tick(db, { adapter: adapter() })

    const run = cutRun(db, flowId)
    // Below the retry ceiling a failure returns to `queued`, so the message is
    // what is asserted, not the status.
    expect(run.error).toMatch(/two/)
    expect(run.status).not.toBe('succeeded')
  })

  test('an unchanged film is not cut twice', async () => {
    const { db, flowId } = prepared(['one', 'two'])
    enqueueRun(db, flowId)
    await tick(db, { adapter: adapter() })

    const second = enqueueRun(db, flowId)
    expect(second.enqueued.map((p) => p.nodeId)).not.toContain('cut')
    expect(second.cached.map((p) => p.nodeId)).toContain('cut')
  })
})
