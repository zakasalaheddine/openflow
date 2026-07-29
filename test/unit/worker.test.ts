import { describe, test, expect, vi } from 'vitest'
import { eq } from 'drizzle-orm'
import { claimNext, reapStale, tick, MAX_ATTEMPTS, STALE_CLAIM_MS } from '@/worker/loop'
import { enqueueRun } from '@/core/executor'
import { nodeRuns, assets } from '@/db/schema'
import { tempDb, seedProject, seedAnchor, seedFlow } from '../helpers/db'
import type { Flow } from '@/core/types'
import type { Adapter } from '@/models/fal'

const flow: Flow = {
  nodes: [{ id: 'img', type: 'image', prompt: 'bottle', anchors: [], modelRole: 'draft', seed: 1 }],
  edges: [],
}

const twoNodeFlow: Flow = {
  nodes: [
    { id: 'a', type: 'image', prompt: 'one', anchors: [], modelRole: 'draft', seed: 1 },
    { id: 'b', type: 'image', prompt: 'two', anchors: [], modelRole: 'draft', seed: 2 },
  ],
  edges: [],
}

function setup(graph: Flow = flow) {
  const { db, dir } = tempDb()
  const projectId = seedProject(db)
  seedAnchor(db, projectId)
  const flowId = seedFlow(db, projectId, graph)
  return { db, dir, flowId }
}

/** An adapter that records what it was asked to do and returns what we tell it. */
function fakeAdapter(over: Partial<Adapter> = {}): Adapter & { submitted: string[] } {
  const submitted: string[] = []
  return {
    submitted,
    async submit({ hash }) {
      submitted.push(hash)
      return { requestId: `req-${hash.slice(0, 6)}` }
    },
    async poll() {
      return {
        status: 'COMPLETED',
        outputs: [{ url: 'https://fal.media/a.png', mime: 'image/png', width: 8, height: 8 }],
      }
    },
    ...over,
  }
}

/** Downloads are stubbed; the network is never touched in a unit test. */
const fakeDownload = async () => Buffer.from('fake-bytes')

describe('claimNext', () => {
  test('claims the oldest queued run', () => {
    const { db, flowId } = setup(twoNodeFlow)
    enqueueRun(db, flowId)
    const claimed = claimNext(db)
    expect(claimed?.status).toBe('claimed')
    expect(claimed?.claimedAt).not.toBeNull()
  })

  test('never hands the same row to two callers', () => {
    // The claim is the only thing standing between two worker ticks and paying
    // fal twice for one node.
    const { db, flowId } = setup(flow)
    enqueueRun(db, flowId)
    const first = claimNext(db)
    const second = claimNext(db)
    expect(first).not.toBeNull()
    expect(second).toBeNull()
  })

  test('returns null when nothing is queued', () => {
    const { db } = setup()
    expect(claimNext(db)).toBeNull()
  })
})

describe('reapStale', () => {
  test('returns a claim older than the timeout to queued', () => {
    // A process killed between claim and dispatch would otherwise strand the
    // run in `claimed` forever.
    const { db, flowId } = setup(flow)
    enqueueRun(db, flowId)
    const claimed = claimNext(db)!
    const old = new Date(Date.now() - STALE_CLAIM_MS - 1000).toISOString()
    db.update(nodeRuns).set({ claimedAt: old }).where(eq(nodeRuns.id, claimed.id)).run()

    expect(reapStale(db)).toBe(1)
    expect(db.select().from(nodeRuns).get()?.status).toBe('queued')
  })

  test('leaves a fresh claim alone', () => {
    const { db, flowId } = setup(flow)
    enqueueRun(db, flowId)
    claimNext(db)
    expect(reapStale(db)).toBe(0)
  })

  test('does not reap a submitted run', () => {
    // A submitted run has a fal_request_id and real money attached. It is
    // resumed by polling, never restarted — restarting it pays twice.
    const { db, flowId } = setup(flow)
    enqueueRun(db, flowId)
    const claimed = claimNext(db)!
    db.update(nodeRuns)
      .set({ status: 'submitted', falRequestId: 'req-1', claimedAt: new Date(0).toISOString() })
      .where(eq(nodeRuns.id, claimed.id))
      .run()

    expect(reapStale(db)).toBe(0)
    expect(db.select().from(nodeRuns).get()?.status).toBe('submitted')
  })
})

describe('tick', () => {
  test('dispatches a queued run and persists the fal request id immediately', async () => {
    // Persisted before any polling: a crash between dispatch and the first poll
    // must not orphan a render that fal is already billing for.
    const { db, flowId } = setup(flow)
    enqueueRun(db, flowId)

    const adapter = fakeAdapter({
      poll: async () => ({ status: 'IN_PROGRESS' }),
    })
    await tick(db, { adapter, download: fakeDownload })

    const run = db.select().from(nodeRuns).get()!
    expect(run.falRequestId).toBe('req-' + run.inputHash.slice(0, 6))
    expect(['submitted', 'polling']).toContain(run.status)
  })

  test('completes a run, writes an asset row and records the cost', async () => {
    const { db, flowId } = setup(flow)
    enqueueRun(db, flowId)

    const adapter = fakeAdapter()
    await tick(db, { adapter, download: fakeDownload })
    await tick(db, { adapter, download: fakeDownload })

    const run = db.select().from(nodeRuns).get()!
    expect(run.status).toBe('succeeded')
    expect(run.costCents).toBeGreaterThan(0)

    const asset = db.select().from(assets).get()!
    expect(asset.mime).toBe('image/png')
    expect(asset.sourceRunId).toBe(run.id)
  })

  test('resumes a submitted run after a restart without re-dispatching', async () => {
    // The crash-resume guarantee: re-adopt by fal_request_id, never re-submit.
    const { db, flowId } = setup(flow)
    enqueueRun(db, flowId)

    const adapter = fakeAdapter({ poll: async () => ({ status: 'IN_PROGRESS' }) })
    await tick(db, { adapter, download: fakeDownload })
    expect(adapter.submitted).toHaveLength(1)

    // A fresh adapter stands in for a restarted process.
    const resumed = fakeAdapter()
    await tick(db, { adapter: resumed, download: fakeDownload })

    expect(resumed.submitted).toHaveLength(0)
    expect(db.select().from(nodeRuns).get()?.status).toBe('succeeded')
  })

  test('retries a failure up to MAX_ATTEMPTS, then stops', async () => {
    const { db, flowId } = setup(flow)
    enqueueRun(db, flowId)

    const adapter = fakeAdapter({ poll: async () => ({ status: 'FAILED', error: 'model exploded' }) })
    for (let i = 0; i < MAX_ATTEMPTS * 2 + 2; i++) {
      await tick(db, { adapter, download: fakeDownload })
    }

    const run = db.select().from(nodeRuns).get()!
    expect(run.status).toBe('failed')
    expect(run.attempt).toBe(MAX_ATTEMPTS)
    expect(run.error).toMatch(/model exploded/)
    expect(adapter.submitted).toHaveLength(MAX_ATTEMPTS)
  })

  test('a dispatch that throws leaves the run retryable, not stuck in claimed', async () => {
    const { db, flowId } = setup(flow)
    enqueueRun(db, flowId)

    const adapter = fakeAdapter({
      submit: async () => {
        throw new Error('network down')
      },
    })
    await tick(db, { adapter, download: fakeDownload })

    const run = db.select().from(nodeRuns).get()!
    expect(run.status).toBe('queued')
    expect(run.attempt).toBe(1)
  })

  test('respects the concurrency limit', async () => {
    const { db, flowId } = setup(twoNodeFlow)
    enqueueRun(db, flowId)

    const adapter = fakeAdapter({ poll: async () => ({ status: 'IN_PROGRESS' }) })
    await tick(db, { adapter, download: fakeDownload, concurrency: 1 })

    expect(adapter.submitted).toHaveLength(1)
  })

  test('does nothing when the queue is empty', async () => {
    const { db } = setup()
    const adapter = fakeAdapter()
    await expect(tick(db, { adapter, download: fakeDownload })).resolves.not.toThrow()
    expect(adapter.submitted).toHaveLength(0)
  })

  test('never calls the network itself', async () => {
    const fetchSpy = vi.spyOn(globalThis, 'fetch')
    const { db, flowId } = setup(flow)
    enqueueRun(db, flowId)

    const adapter = fakeAdapter()
    await tick(db, { adapter, download: fakeDownload })
    await tick(db, { adapter, download: fakeDownload })

    expect(fetchSpy).not.toHaveBeenCalled()
    fetchSpy.mockRestore()
  })
})
