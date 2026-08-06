import { describe, test, expect, vi } from 'vitest'
import { mkdirSync, writeFileSync } from 'node:fs'
import path from 'node:path'
import { eq } from 'drizzle-orm'
import { claimNext, reapStale, tick, MAX_ATTEMPTS, STALE_CLAIM_MS } from '@/worker/loop'
import { enqueueRun } from '@/core/executor'
import { nodeRuns, assets, flows } from '@/db/schema'
import { tempDb, seedProject, seedSource, seedFlow } from '../helpers/db'
import { seedSourceFiles, PNG_1PX } from '../helpers/fixtures'
import type { Flow } from '@/core/types'
import type { Adapter, SubmitRequest } from '@/models/fal'

const flow: Flow = {
  nodes: [{ id: 'img', type: 'image', prompt: 'bottle', modelId: 'flux-2-pro', seed: 1 }],
  edges: [],
}

const twoNodeFlow: Flow = {
  nodes: [
    { id: 'a', type: 'image', prompt: 'one', modelId: 'flux-2-pro', seed: 1 },
    { id: 'b', type: 'image', prompt: 'two', modelId: 'flux-2-pro', seed: 2 },
  ],
  edges: [],
}

/** A shot, the clip cut from it, and one unrelated shot beside them. */
const clipFlow: Flow = {
  nodes: [
    { id: 'img', type: 'image', prompt: 'bottle', modelId: 'flux-2-pro', seed: 1 },
    { id: 'clip', type: 'video', prompt: 'push in', durationSec: 5, audio: false, modelId: 'hailuo-2-3-pro', seed: 2 },
    { id: 'other', type: 'image', prompt: 'slate', modelId: 'flux-2-pro', seed: 3 },
  ],
  edges: [{ id: 'e1', from: 'img', to: 'clip', role: 'start_frame', position: null }],
}

function setup(graph: Flow = flow) {
  const { db, dir } = tempDb()
  const projectId = seedProject(db)
  seedSource(db, projectId)
  const flowId = seedFlow(db, projectId, graph)
  return { db, dir, flowId }
}

/** An adapter that records what it was asked to do and returns what we tell it. */
function fakeAdapter(
  over: Partial<Adapter> = {},
): Adapter & { submitted: string[]; requests: SubmitRequest[] } {
  const submitted: string[] = []
  const requests: SubmitRequest[] = []
  return {
    submitted,
    requests,
    async submit(request) {
      submitted.push(request.hash)
      requests.push(request)
      return { requestId: `req-${request.hash.slice(0, 6)}` }
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

  test('holds a clip back until the frame it is cut from has rendered', () => {
    // `tick` claims up to `concurrency` runs per pass, so without this the image
    // and the clip go out together — and the clip, finding no frame, is billed
    // for a text-to-video render that ignored its anchor.
    const { db, flowId } = setup(clipFlow)
    enqueueRun(db, flowId)

    // Everything claimable goes out; the clip is not among it.
    const firstPass = [claimNext(db)?.nodeId, claimNext(db)?.nodeId, claimNext(db)?.nodeId]
    expect(firstPass.sort()).toEqual(['img', 'other', undefined])

    db.update(nodeRuns).set({ status: 'succeeded' }).where(eq(nodeRuns.nodeId, 'img')).run()
    expect(claimNext(db)?.nodeId).toBe('clip')
  })

  test('a blocked clip does not stall an unrelated shot behind it', () => {
    const { db, flowId } = setup(clipFlow)
    enqueueRun(db, flowId)
    db.update(nodeRuns).set({ status: 'succeeded' }).where(eq(nodeRuns.nodeId, 'img')).run()
    db.update(nodeRuns).set({ status: 'queued' }).where(eq(nodeRuns.nodeId, 'img')).run()

    // img is queued again, so clip is blocked — 'other' must still be claimable.
    const claimed = [claimNext(db)?.nodeId, claimNext(db)?.nodeId]
    expect(claimed.sort()).toEqual(['img', 'other'])
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

describe('tick dispatch payload', () => {
  // Without these, the worker bills fal for N empty-prompt generations and
  // every other test still passes, because the replay adapter keys off the
  // hash and never looks at the input.

  test('sends the node prompt', async () => {
    const { db, flowId } = setup(flow)
    enqueueRun(db, flowId)

    const adapter = fakeAdapter({ poll: async () => ({ status: 'IN_PROGRESS' }) })
    await tick(db, { adapter, download: fakeDownload })

    expect(adapter.requests[0].input.prompt).toBe('bottle')
  })

  test('sends the seed', async () => {
    const { db, flowId } = setup(flow)
    enqueueRun(db, flowId)

    const adapter = fakeAdapter({ poll: async () => ({ status: 'IN_PROGRESS' }) })
    await tick(db, { adapter, download: fakeDownload })

    expect(adapter.requests[0].input.seed).toBe(1)
  })

  test('sends the files of every source wired in as a reference', async () => {
    // A reference that never reaches the model is the entire product failing
    // silently: output looks off-brand and reads as a model quality problem.
    const anchored: Flow = {
      nodes: [
        { id: 'bottle', type: 'source', sourceId: 'source-1' },
        { id: 'img', type: 'image', prompt: 'bottle', modelId: 'flux-2-pro', seed: 1 },
      ],
      edges: [{ id: 'r1', from: 'bottle', to: 'img', role: 'reference', position: null }],
    }
    const { db, dir, flowId } = setup(anchored)
    const storeRoot = path.join(dir, 'assets')
    seedSourceFiles(storeRoot, ['ref-a.png'])
    enqueueRun(db, flowId)

    const adapter = fakeAdapter({ poll: async () => ({ status: 'IN_PROGRESS' }) })
    await tick(db, { adapter, download: fakeDownload, storeRoot })

    // Inlined, not named: `ref-a.png` means nothing to fal, which fetches its
    // inputs over the network and would refuse with `file_download_error`.
    expect(adapter.requests[0].input.image_urls).toEqual([
      `data:image/png;base64,${PNG_1PX.split(',')[1]}`,
    ])
  })

  test('sends a wired-in text fragment ahead of the node prompt', async () => {
    // End to end through the worker, not just the composer: brand tone wired
    // into a shot has to actually reach fal, or the feature is decorative.
    const { db, dir } = tempDb()
    const projectId = seedProject(db)
    seedSource(db, projectId, 'voice-1', { kind: 'text', files: [], text: 'warm, unfussy' })
    const flowId = seedFlow(db, projectId, {
      nodes: [
        { id: 'voice', type: 'source', sourceId: 'voice-1' },
        { id: 'img', type: 'image', prompt: 'bottle', modelId: 'flux-2-pro', seed: 1 },
      ],
      edges: [{ id: 'r1', from: 'voice', to: 'img', role: 'reference', position: null }],
    })
    void dir
    enqueueRun(db, flowId)

    const adapter = fakeAdapter({ poll: async () => ({ status: 'IN_PROGRESS' }) })
    await tick(db, { adapter, download: fakeDownload })

    expect(adapter.requests[0].input.prompt).toBe('warm, unfussy\n\nbottle')
    // A text source contributes words, never files.
    expect(adapter.requests[0].input.image_urls).toBeUndefined()
  })

  test('sends the correct prompt when several nodes are queued', async () => {
    // Guards against dispatching by row order while reading the graph by index.
    const { db, flowId } = setup(twoNodeFlow)
    enqueueRun(db, flowId)

    const adapter = fakeAdapter({ poll: async () => ({ status: 'IN_PROGRESS' }) })
    await tick(db, { adapter, download: fakeDownload, concurrency: 10 })
    await tick(db, { adapter, download: fakeDownload, concurrency: 10 })

    expect(adapter.requests.map((r) => r.input.prompt).sort()).toEqual(['one', 'two'])
  })

  test('fails a run whose node has vanished from the graph rather than sending an empty prompt', async () => {
    const { db, flowId } = setup(flow)
    enqueueRun(db, flowId)
    db.update(flows).set({ graphJson: { nodes: [], edges: [] } }).where(eq(flows.id, flowId)).run()

    const adapter = fakeAdapter()
    await tick(db, { adapter, download: fakeDownload })

    expect(adapter.submitted).toHaveLength(0)
    expect(db.select().from(nodeRuns).get()?.error).toMatch(/node/i)
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

  test('never dispatches a clip whose start frame was never rendered', async () => {
    // The frame is gone for good — the graph still promises the clip is anchored
    // to it, and buildModelInput would quietly drop `image_url` and let fal bill
    // a full text-to-video render that ignored the anchor.
    const { db, flowId } = setup(clipFlow)
    enqueueRun(db, flowId)
    db.update(nodeRuns).set({ status: 'failed', attempt: MAX_ATTEMPTS }).where(eq(nodeRuns.nodeId, 'img')).run()

    const adapter = fakeAdapter()
    for (let i = 0; i < MAX_ATTEMPTS + 2; i++) await tick(db, { adapter, download: fakeDownload })

    const clip = db.select().from(nodeRuns).where(eq(nodeRuns.nodeId, 'clip')).get()!
    expect(clip.status).toBe('failed')
    expect(clip.error).toContain('no rendered start_frame')
    expect(adapter.submitted).not.toContain(clip.inputHash)
  })

  test('a clip anchors to the frame now on its parent card, not the first one ever rendered', async () => {
    // Edit the shot, render it again, then run the clip: the image node has two
    // succeeded rows. An unordered lookup takes the oldest, so the clip is built
    // from a frame that is no longer on screen — at full price, and reading as
    // the model having ignored its start frame.
    const { db, dir, flowId } = setup(clipFlow)
    const storeRoot = path.join(dir, 'assets')
    enqueueRun(db, flowId)
    const clipRun = db.select().from(nodeRuns).where(eq(nodeRuns.nodeId, 'clip')).get()!

    // Stand in for that history: the original frame, and the re-render that
    // replaced it on the canvas.
    db.delete(nodeRuns).where(eq(nodeRuns.nodeId, 'img')).run()
    for (const [runId, assetId, when] of [
      ['run-first', 'frame-first', '2026-01-01T00:00:00.000Z'],
      ['run-latest', 'frame-latest', '2026-06-01T00:00:00.000Z'],
    ] as const) {
      // Distinct bytes per frame: both are inlined identically otherwise, and
      // the test would pass no matter which row won.
      const file = path.join(storeRoot, 'frames', `${assetId}.png`)
      mkdirSync(path.dirname(file), { recursive: true })
      writeFileSync(file, Buffer.from(assetId))
      db.insert(assets)
        .values({
          id: assetId,
          path: path.join(storeRoot, `frames/${assetId}.png`),
          mime: 'image/png',
          sourceRunId: runId,
          createdAt: when,
        })
        .run()
      db.insert(nodeRuns)
        .values({
          id: runId,
          flowId,
          nodeId: 'img',
          inputHash: runId,
          status: 'succeeded',
          modelId: 'flux-2-pro',
          costCents: 1,
          attempt: 0,
          createdAt: when,
          outputRefs: [assetId],
        })
        .run()
    }

    const adapter = fakeAdapter()
    await tick(db, { adapter, download: fakeDownload, storeRoot })

    const dispatched = adapter.requests.find((r) => r.hash === clipRun.inputHash)!
    expect(dispatched.input.image_url).toBe(
      `data:image/png;base64,${Buffer.from('frame-latest').toString('base64')}`,
    )
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

  test('fills the concurrency budget in one tick', async () => {
    // One dispatch per tick made `concurrency` decorative: a twelve-node graph
    // drained at one node every two seconds no matter what the setting said.
    const { db, flowId } = setup(twoNodeFlow)
    enqueueRun(db, flowId)

    const adapter = fakeAdapter({ poll: async () => ({ status: 'IN_PROGRESS' }) })
    await tick(db, { adapter, download: fakeDownload, concurrency: 4 })

    expect(adapter.submitted).toHaveLength(2)
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
