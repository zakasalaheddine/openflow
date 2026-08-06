import { describe, test, expect } from 'vitest'
import { existsSync, readFileSync, statSync } from 'node:fs'
import path from 'node:path'
import { eq } from 'drizzle-orm'
import { tick } from '@/worker/loop'
import { probe } from '@/core/ffmpeg'
import { assets, nodeRuns } from '@/db/schema'
import type { Flow } from '@/core/types'
import { tempDb, seedProject, seedFlow } from '../helpers/db'
import { STUB_MP4 } from '../helpers/exports'

// Models return wildly different fps and codecs. Normalising one clip as it
// lands is free; fixing it retroactively across a client's whole library is not.

const CONFORMING = path.resolve('test/fixtures/media/conforming.mp4')

const graph: Flow = {
  nodes: [
    { id: 'clip', type: 'video', prompt: 'the bottle turning', durationSec: 1, audio: false, modelId: 'hailuo-2-3-pro' },
  ],
  edges: [],
}

/** Serves one local file as the model's output, so no network and no fixtures. */
const servingAdapter = (file: string, mime: string) => ({
  async submit() {
    return { requestId: 'local#clip' }
  },
  async poll() {
    return {
      status: 'COMPLETED' as const,
      outputs: [{ url: `file://${file}`, mime, width: 1080, height: 1920 }],
    }
  },
})

async function renderClip(
  file: string,
  settings: Parameters<typeof seedProject>[1] = {},
  mime = 'video/mp4',
) {
  const { db, dir } = tempDb()
  const projectId = seedProject(db, settings)
  const flowId = seedFlow(db, projectId, graph)

  db.insert(nodeRuns)
    .values({
      id: 'run-1',
      flowId,
      nodeId: 'clip',
      inputHash: 'hash-clip',
      status: 'queued',
      modelId: 'hailuo-2-3-pro',
      costCents: 0,
      attempt: 0,
      createdAt: new Date().toISOString(),
    })
    .run()

  const options = {
    adapter: servingAdapter(file, mime),
    download: async (url: string) => readFileSync(url.replace('file://', '')),
    storeRoot: path.join(dir, 'assets'),
  }
  await tick(db, options) // dispatch
  await tick(db, options) // poll, persist, normalise

  const asset = db.select().from(assets).where(eq(assets.sourceRunId, 'run-1')).get()
  expect(asset, 'the run did not produce an asset').toBeTruthy()
  return { db, asset: asset! }
}

describe('normalisation on write', () => {
  test('transcodes a clip that arrives at the wrong fps', async () => {
    // The stub fixture is 2fps; the project wants 30.
    const { asset } = await renderClip(STUB_MP4)
    expect((await probe(asset.path)).fps).toBe(30)
  })

  test('records duration, fps and codec from the probe', async () => {
    // From the file, never from the model's claim about what it sent: a row
    // that records the requested duration makes every downstream length check
    // a check of our own optimism.
    const { asset } = await renderClip(CONFORMING)
    expect(asset.fps).toBe(30)
    expect(asset.codec).toBe('h264')
    expect(asset.durationMs).toBe(1000)
    expect(asset.width).toBe(1080)
    expect(asset.height).toBe(1920)
  })

  test('leaves an already-conforming clip alone', async () => {
    // Re-encoding a correct file costs time and a generation of quality.
    const { asset } = await renderClip(CONFORMING)
    expect(statSync(asset.path).size).toBe(statSync(CONFORMING).size)
  })

  test('honours a project that asks for a different frame rate', async () => {
    const { asset } = await renderClip(CONFORMING, { fps: 24 })
    expect(asset.fps).toBe(24)
  })

  test('keeps a paid render when ffmpeg is not installed', async () => {
    // Throwing here would fail the run, return it to `queued`, and buy the same
    // clip again on the next tick — three times, then failed, with the bytes on
    // disk and no row pointing at them. The loud error belongs at export time,
    // where it costs nothing.
    const realPath = process.env.PATH
    process.env.PATH = '/nonexistent'
    try {
      const { asset } = await renderClip(STUB_MP4)
      expect(existsSync(asset.path)).toBe(true)
      expect(asset.width).toBe(1080)
      // Unknown rather than guessed: nothing measured them.
      expect(asset.fps).toBeNull()
      expect(asset.codec).toBeNull()
    } finally {
      process.env.PATH = realPath
    }
  })

  test('leaves a still image untouched and never probes it', async () => {
    const png = path.resolve('test/fixtures/media/stub.png')
    const { asset } = await renderClip(png, {}, 'image/png')

    expect(statSync(asset.path).size).toBe(statSync(png).size)
    // A still has no frame rate to record, and inventing the project's default
    // here would make the column mean two different things.
    expect(asset.fps).toBeNull()
    expect(asset.codec).toBeNull()
  })
})
