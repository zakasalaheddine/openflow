import { describe, test, expect } from 'vitest'
import path from 'node:path'
import { eq } from 'drizzle-orm'
import { openDb } from '@/db'
import { importFlowFile, drain, type FlowFile } from '@/core/run-flow'
import { planRun, enqueueRun } from '@/core/executor'
import { createAdapter, type Adapter } from '@/models/fal'
import { tick } from '@/worker/loop'
import { nodeRuns, assets } from '@/db/schema'
import { tempDb } from '../helpers/db'
import { tempFixtureDir, recordSuccess } from '../helpers/fixtures'

// Phase 1 gate #3: "killing the process mid-run and restarting resumes
// cleanly". This is the test that will still be earning its keep in month
// three, because orphaning a $5 render is the failure nobody notices until the
// invoice arrives.

const spec: FlowFile = {
  project: 'serum',
  anchors: [{ id: 'bottle', kind: 'product', refImages: ['a.png'] }],
  flow: {
    nodes: [
      { id: 'marble', type: 'image', prompt: 'bottle on marble', anchors: ['bottle'], modelRole: 'draft', seed: 1 },
    ],
    edges: [],
  },
}

function prepared() {
  const { db, dir } = tempDb()
  const fixtureDir = tempFixtureDir()
  const { flowId } = importFlowFile(db, spec)
  for (const planned of planRun(db, flowId)) recordSuccess(fixtureDir, planned)
  return { db, dir, fixtureDir, flowId, storeRoot: path.join(dir, 'assets') }
}

/** Counts submits so "did the restart pay twice?" is directly observable. */
function countingAdapter(inner: Adapter) {
  const state = { submits: 0 }
  return {
    state,
    adapter: {
      async submit(request: Parameters<Adapter['submit']>[0]) {
        state.submits++
        return inner.submit(request)
      },
      poll: inner.poll,
    } satisfies Adapter,
  }
}

describe('crash resume', () => {
  test('re-adopts an in-flight run by fal request id instead of re-dispatching', async () => {
    const { db, fixtureDir, flowId, storeRoot } = prepared()
    enqueueRun(db, flowId)

    // Dispatch, then stop the process before the poll that would complete it.
    const first = countingAdapter({
      submit: createAdapter({ mode: 'replay', fixtureDir }).submit,
      async poll() {
        return { status: 'IN_PROGRESS' }
      },
    })
    await tick(db, { adapter: first.adapter, storeRoot })

    const midRun = db.select().from(nodeRuns).get()!
    expect(midRun.falRequestId).toBeTruthy()
    expect(['submitted', 'polling']).toContain(midRun.status)
    expect(first.state.submits).toBe(1)

    // A brand new adapter and a brand new db handle stand in for a restart.
    const second = countingAdapter(createAdapter({ mode: 'replay', fixtureDir }))
    await drain(db, flowId, { adapter: second.adapter, storeRoot })

    expect(second.state.submits).toBe(0)
    const finished = db.select().from(nodeRuns).get()!
    expect(finished.status).toBe('succeeded')
    expect(finished.falRequestId).toBe(midRun.falRequestId)
  })

  test('resumes after the database is closed and reopened', async () => {
    // The state lives in SQLite, not in worker memory. If it did not, this is
    // where it would show.
    const { dir, fixtureDir, flowId, storeRoot } = prepared()
    const dbPath = path.join(dir, 'app.db')

    const before = openDb(dbPath)
    enqueueRun(before, flowId)
    await tick(before, {
      adapter: { submit: createAdapter({ mode: 'replay', fixtureDir }).submit, async poll() { return { status: 'IN_PROGRESS' } } },
      storeRoot,
    })

    const after = openDb(dbPath)
    const resumed = countingAdapter(createAdapter({ mode: 'replay', fixtureDir }))
    await drain(after, flowId, { adapter: resumed.adapter, storeRoot })

    expect(resumed.state.submits).toBe(0)
    expect(after.select().from(nodeRuns).get()?.status).toBe('succeeded')
  })

  test('does not download the same output twice', async () => {
    const { db, fixtureDir, flowId, storeRoot } = prepared()
    enqueueRun(db, flowId)

    const adapter = createAdapter({ mode: 'replay', fixtureDir })
    await drain(db, flowId, { adapter, storeRoot })
    const afterFirst = db.select().from(assets).all().length

    // Extra ticks after settling must be inert.
    await tick(db, { adapter, storeRoot })
    await tick(db, { adapter, storeRoot })

    expect(db.select().from(assets).all()).toHaveLength(afterFirst)
  })

  test('a claim orphaned by a crash is reaped and retried, not stranded', async () => {
    const { db, fixtureDir, flowId, storeRoot } = prepared()
    enqueueRun(db, flowId)

    // Simulate dying between claim and dispatch: claimed, no request id, stale.
    const run = db.select().from(nodeRuns).get()!
    db.update(nodeRuns)
      .set({ status: 'claimed', claimedAt: new Date(Date.now() - 10 * 60_000).toISOString() })
      .where(eq(nodeRuns.id, run.id))
      .run()

    await drain(db, flowId, { adapter: createAdapter({ mode: 'replay', fixtureDir }), storeRoot })
    expect(db.select().from(nodeRuns).get()?.status).toBe('succeeded')
  })
})
