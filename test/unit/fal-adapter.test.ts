import { describe, test, expect, beforeEach, afterEach, vi } from 'vitest'
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import {
  parseOutputs,
  createAdapter,
  FalSpendBlockedError,
  MissingFixtureError,
  type FalRawResult,
} from '@/models/fal'
import { modelById } from '@/models/catalog'

const model = modelById('flux-2-pro')

describe('parseOutputs', () => {
  // Every assumption about fal's response shape lives in this one function.
  // When a live call proves it wrong, one module and its fixtures change —
  // not the executor, the worker and the asset store as well.

  test('parses an image response', () => {
    const raw: FalRawResult = {
      images: [{ url: 'https://fal.media/a.png', content_type: 'image/png', width: 1024, height: 1024 }],
    }
    expect(parseOutputs(raw)).toEqual([
      { url: 'https://fal.media/a.png', mime: 'image/png', width: 1024, height: 1024 },
    ])
  })

  test('parses a multi-image response in order', () => {
    const raw: FalRawResult = {
      images: [
        { url: 'https://fal.media/a.png', content_type: 'image/png' },
        { url: 'https://fal.media/b.png', content_type: 'image/png' },
      ],
    }
    expect(parseOutputs(raw).map((o) => o.url)).toEqual([
      'https://fal.media/a.png',
      'https://fal.media/b.png',
    ])
  })

  test('parses a single-object video response', () => {
    const raw: FalRawResult = { video: { url: 'https://fal.media/c.mp4', content_type: 'video/mp4' } }
    expect(parseOutputs(raw)).toEqual([{ url: 'https://fal.media/c.mp4', mime: 'video/mp4' }])
  })

  test('falls back to a mime guessed from the extension', () => {
    // fal omits content_type on some endpoints; a missing mime must not become
    // an asset row with an empty mime column.
    const raw: FalRawResult = { video: { url: 'https://fal.media/c.mp4' } }
    expect(parseOutputs(raw)[0].mime).toBe('video/mp4')
  })

  test('throws on a response containing no recognisable output', () => {
    // Better a loud parse failure than a succeeded run with zero assets, which
    // reads as a silent model failure and gets re-run at full price.
    expect(() => parseOutputs({} as FalRawResult)).toThrow(/no output/i)
  })

  test('throws on an output entry with no url', () => {
    expect(() => parseOutputs({ images: [{ content_type: 'image/png' }] } as FalRawResult)).toThrow()
  })
})

describe('adapter in `off` mode', () => {
  test('throws instead of dispatching', async () => {
    const adapter = createAdapter({ mode: 'off' })
    await expect(adapter.submit({ model, input: {}, hash: 'abc' })).rejects.toThrow(FalSpendBlockedError)
  })
})

describe('adapter in `replay` mode', () => {
  let fixtureDir: string

  beforeEach(() => {
    fixtureDir = mkdtempSync(path.join(tmpdir(), 'openflow-fixtures-'))
  })
  afterEach(() => rmSync(fixtureDir, { recursive: true, force: true }))

  const writeFixture = (hash: string, body: unknown) => {
    const dir = path.join(fixtureDir, model.falEndpoint.replaceAll('/', '_'))
    mkdirSync(dir, { recursive: true })
    writeFileSync(path.join(dir, `${hash}.json`), JSON.stringify(body))
  }

  test('never touches the network', async () => {
    const fetchSpy = vi.spyOn(globalThis, 'fetch')
    writeFixture('abc', { images: [{ url: 'https://fal.media/a.png', content_type: 'image/png' }] })

    const adapter = createAdapter({ mode: 'replay', fixtureDir })
    const { requestId } = await adapter.submit({ model, input: {}, hash: 'abc' })
    await adapter.poll(requestId)

    expect(fetchSpy).not.toHaveBeenCalled()
    fetchSpy.mockRestore()
  })

  test('completes immediately with the recorded outputs', async () => {
    writeFixture('abc', { images: [{ url: 'https://fal.media/a.png', content_type: 'image/png', width: 8, height: 8 }] })
    const adapter = createAdapter({ mode: 'replay', fixtureDir })
    const { requestId } = await adapter.submit({ model, input: {}, hash: 'abc' })

    const result = await adapter.poll(requestId)
    expect(result.status).toBe('COMPLETED')
    expect(result.outputs).toEqual([
      { url: 'https://fal.media/a.png', mime: 'image/png', width: 8, height: 8 },
    ])
  })

  test('names the missing fixture path so it can be recorded', async () => {
    const adapter = createAdapter({ mode: 'replay', fixtureDir })
    await expect(adapter.submit({ model, input: {}, hash: 'nope' })).rejects.toThrow(MissingFixtureError)
    await expect(adapter.submit({ model, input: {}, hash: 'nope' })).rejects.toThrow(/nope\.json/)
  })

  test('replays a recorded failure as a failure', async () => {
    // A recorded fal error must not replay as a success; the retry path needs
    // a fixture too or it is never exercised.
    writeFixture('boom', { error: { message: 'content policy violation' } })
    const adapter = createAdapter({ mode: 'replay', fixtureDir })
    const { requestId } = await adapter.submit({ model, input: {}, hash: 'boom' })

    const result = await adapter.poll(requestId)
    expect(result.status).toBe('FAILED')
    expect(result.error).toMatch(/content policy/)
  })
})

describe('adapter in `stub` mode', () => {
  // The browser suite renders through this adapter, and everything downstream
  // of the worker reads the file rather than the row. A placeholder makes the
  // probe, the transcode, the export resize and the spec check all pass on
  // bytes that are not media at all.
  const videoModel = modelById('hailuo-2-3-pro')

  const bytesOf = async (spec: typeof model) => {
    const adapter = createAdapter({ mode: 'stub' })
    const { requestId } = await adapter.submit({ model: spec, input: {}, hash: 'abc' })
    const result = await adapter.poll(requestId)
    const url = result.outputs![0].url
    return Buffer.from(url.slice(url.indexOf(',') + 1), 'base64')
  }

  test('returns a real PNG, not a placeholder', async () => {
    const bytes = await bytesOf(model)
    expect(bytes.subarray(0, 8)).toEqual(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))
    // A 1x1 PNG is ~70 bytes. Anything that small cannot be resized, checked
    // against a safe zone, or exported at a real format.
    expect(bytes.byteLength).toBeGreaterThan(150)
  })

  test('returns a real MP4 for a video model', async () => {
    const bytes = await bytesOf(videoModel)
    // ISO-BMFF: bytes 4..8 of the first box are 'ftyp'.
    expect(bytes.subarray(4, 8).toString()).toBe('ftyp')
    expect(bytes.byteLength).toBeGreaterThan(500)
  })

  test('reports the dimensions the file actually has', async () => {
    const adapter = createAdapter({ mode: 'stub' })
    const { requestId } = await adapter.submit({ model: videoModel, input: {}, hash: 'abc' })
    const [output] = (await adapter.poll(requestId)).outputs!
    expect(output).toMatchObject({ mime: 'video/mp4', width: 1080, height: 1920, durationMs: 1000 })
  })

  test('never touches the network', async () => {
    const fetchSpy = vi.spyOn(globalThis, 'fetch')
    await bytesOf(model)
    expect(fetchSpy).not.toHaveBeenCalled()
    fetchSpy.mockRestore()
  })
})

describe('adapter in `live` mode', () => {
  test('refuses to dispatch without a key rather than failing mid-run', async () => {
    vi.stubEnv('FAL_KEY', '')
    const adapter = createAdapter({ mode: 'live' })
    await expect(adapter.submit({ model, input: {}, hash: 'abc' })).rejects.toThrow(/FAL_KEY/)
    vi.unstubAllEnvs()
  })

  /**
   * Every model but one has a sub-path in its endpoint, and fal's queue URLs do
   * not carry it. Rebuilding the poll URL from the full endpoint is a 405 on all
   * of them — submitted and billed, and uncollectable.
   */
  test('polls the url fal handed back, not one rebuilt from the endpoint', async () => {
    vi.stubEnv('FAL_KEY', 'test-key')
    const seen: string[] = []
    const fetchMock = vi.fn(async (url: string) => {
      seen.push(url)
      const body = url.endsWith('/status')
        ? { status: 'COMPLETED' }
        : url.includes('/requests/')
          ? { images: [{ url: 'https://fal.media/a.png', content_type: 'image/png' }] }
          : {
              request_id: 'req-1',
              // The sub-path fal drops. `flux-2-pro` has none, so name one that does.
              response_url: 'https://queue.fal.run/fal-ai/minimax/requests/req-1',
            }
      return {
        ok: true,
        status: 200,
        json: async () => body,
        // What fal metered rides on the result's headers, so a stand-in for a
        // Response has to have them.
        headers: new Headers({ 'x-fal-billable-units': '2.5' }),
      } as Response
    })
    vi.stubGlobal('fetch', fetchMock)

    const adapter = createAdapter({ mode: 'live' })
    const video = modelById('hailuo-2-3-pro')
    const { requestId } = await adapter.submit({ model: video, input: {}, hash: 'abc' })
    const result = await adapter.poll(requestId)

    expect(result.status).toBe('COMPLETED')
    // Read off the result fetch's header — the only place fal states what it
    // charged for, and the difference between the ledger and a guess.
    expect(result.billableUnits).toBe(2.5)
    expect(seen[1]).toBe('https://queue.fal.run/fal-ai/minimax/requests/req-1/status')
    expect(seen[2]).toBe('https://queue.fal.run/fal-ai/minimax/requests/req-1')
    expect(seen.some((url) => url.includes('/image-to-video/requests/'))).toBe(false)

    vi.unstubAllGlobals()
    vi.unstubAllEnvs()
  })

  test('a payload carrying references goes to the endpoint that has a field for them', async () => {
    // `fal-ai/flux-2-pro` has no `image_urls` in its schema at all. Sending one
    // there is not an error — it is dropped, and a full-price render comes back
    // that never saw the product photo.
    vi.stubEnv('FAL_KEY', 'test-key')
    const seen: string[] = []
    const fetchMock = vi.fn(async (url: string) => {
      seen.push(url)
      return { ok: true, status: 200, json: async () => ({ request_id: 'r' }) } as Response
    })
    vi.stubGlobal('fetch', fetchMock)

    const adapter = createAdapter({ mode: 'live' })
    await adapter.submit({ model, input: { prompt: 'a', image_urls: ['x.png'] }, hash: 'h' })
    await adapter.submit({ model, input: { prompt: 'a' }, hash: 'h' })

    expect(seen[0]).toBe('https://queue.fal.run/fal-ai/flux-2-pro/edit')
    expect(seen[1]).toBe('https://queue.fal.run/fal-ai/flux-2-pro')

    vi.unstubAllGlobals()
    vi.unstubAllEnvs()
  })

  test('a run submitted before that fix is still resumable, sub-path dropped', async () => {
    // Never restarted: a `submitted` row has a fal request id and real money on
    // it, so the old `endpoint#id` encoding has to keep resolving.
    vi.stubEnv('FAL_KEY', 'test-key')
    const seen: string[] = []
    const fetchMock = vi.fn(async (url: string) => {
      seen.push(url)
      return { ok: true, status: 200, json: async () => ({ status: 'IN_PROGRESS' }) } as Response
    })
    vi.stubGlobal('fetch', fetchMock)

    const adapter = createAdapter({ mode: 'live' })
    const result = await adapter.poll('fal-ai/minimax/hailuo-02/pro/image-to-video#req-9')

    expect(result.status).toBe('IN_PROGRESS')
    expect(seen[0]).toBe('https://queue.fal.run/fal-ai/minimax/requests/req-9/status')

    vi.unstubAllGlobals()
    vi.unstubAllEnvs()
  })
})
