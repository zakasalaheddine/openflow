import { readFileSync, existsSync } from 'node:fs'
import path from 'node:path'
import { endpointFor, type ModelSpec } from './registry'
import type { FalMode } from '../env'

/**
 * THE ONE PLACE that knows fal's response shape.
 *
 * The executor, the worker and the asset store consume `ParsedOutput` and know
 * nothing about `images[]` vs `video{}`. When a live call proves an assumption
 * here wrong, one module and its fixtures change instead of five call sites.
 *
 * ponytail: fixtures are hand-authored until Phase 0's spike records real
 * responses. Until then this parser is validated against a plausible shape,
 * not a proven one — do not claim the acceptance suite validates the fal
 * integration.
 */

export type FalOutputEntry = {
  url?: string
  content_type?: string
  width?: number
  height?: number
  duration?: number
}

export type FalRawResult = {
  images?: FalOutputEntry[]
  video?: FalOutputEntry
  audio?: FalOutputEntry
  error?: { message?: string }
}

export type ParsedOutput = {
  url: string
  mime: string
  width?: number
  height?: number
  durationMs?: number
}

export class FalSpendBlockedError extends Error {
  constructor() {
    super('FAL_MODE=off: dispatch refused so this run cannot spend money.')
    this.name = 'FalSpendBlockedError'
  }
}

export class MissingFixtureError extends Error {
  constructor(fixturePath: string) {
    super(
      `No fal fixture at ${fixturePath}. Record one with FAL_MODE=live, or fix the hash.`,
    )
    this.name = 'MissingFixtureError'
  }
}

const MIME_BY_EXT: Record<string, string> = {
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.webp': 'image/webp',
  '.mp4': 'video/mp4',
  '.webm': 'video/webm',
  '.mov': 'video/quicktime',
}

function toParsed(entry: FalOutputEntry): ParsedOutput {
  if (!entry?.url) {
    throw new Error('fal output entry has no url')
  }
  const ext = path.extname(new URL(entry.url).pathname).toLowerCase()
  return {
    url: entry.url,
    // A missing mime must not become an asset row with an empty mime column.
    mime: entry.content_type ?? MIME_BY_EXT[ext] ?? 'application/octet-stream',
    ...(entry.width === undefined ? {} : { width: entry.width }),
    ...(entry.height === undefined ? {} : { height: entry.height }),
    ...(entry.duration === undefined ? {} : { durationMs: Math.round(entry.duration * 1000) }),
  }
}

export function parseOutputs(raw: FalRawResult): ParsedOutput[] {
  const entries = raw?.images ?? (raw?.video ? [raw.video] : raw?.audio ? [raw.audio] : [])
  if (entries.length === 0) {
    // Loud parse failure beats a succeeded run with zero assets, which reads as
    // a silent model failure and gets re-run at full price.
    throw new Error(`fal response contained no output: ${JSON.stringify(raw).slice(0, 200)}`)
  }
  return entries.map(toParsed)
}

export type SubmitRequest = {
  model: ModelSpec
  input: Record<string, unknown>
  hash: string
}

export type PollResult = {
  status: 'IN_PROGRESS' | 'COMPLETED' | 'FAILED'
  outputs?: ParsedOutput[]
  error?: string
}

export type Adapter = {
  submit(request: SubmitRequest): Promise<{ requestId: string }>
  poll(requestId: string): Promise<PollResult>
}

const fixturePathFor = (dir: string, endpoint: string, hash: string) =>
  path.join(dir, endpoint.replaceAll('/', '_'), `${hash}.json`)

/**
 * Which of the model's endpoints this payload is for.
 *
 * Read off the payload rather than plumbed down from the graph: `image_urls` is
 * present exactly when references were wired in, and the alternative is a fourth
 * argument threaded through the worker for something the input already states.
 */
const endpointOf = ({ model, input }: SubmitRequest) =>
  endpointFor(model, Array.isArray(input.image_urls) && input.image_urls.length > 0)

/**
 * Stateless on purpose: the request id carries everything needed to find the
 * fixture again. An in-memory map would make a restarted process unable to poll
 * a request it had already submitted — which is precisely the crash-resume
 * behaviour the acceptance suite exists to prove, so the harness must not be
 * the thing that fakes it.
 */
function replayAdapter(fixtureDir: string): Adapter {
  return {
    async submit(request) {
      const endpoint = endpointOf(request)
      const file = fixturePathFor(fixtureDir, endpoint, request.hash)
      if (!existsSync(file)) throw new MissingFixtureError(file)
      return { requestId: `replay:${endpoint}#${request.hash}` }
    },
    async poll(requestId) {
      const [endpoint, hash] = requestId.replace(/^replay:/, '').split('#')
      const file = path.join(fixtureDir, endpoint.replaceAll('/', '_'), `${hash}.json`)
      if (!existsSync(file)) return { status: 'FAILED', error: `No fixture for ${requestId}` }

      const raw = JSON.parse(readFileSync(file, 'utf8')) as FalRawResult
      // A recorded fal error replays as a failure, so the retry path has a
      // fixture and is actually exercised.
      if (raw.error) return { status: 'FAILED', error: raw.error.message ?? 'fal error' }
      return { status: 'COMPLETED', outputs: parseOutputs(raw) }
    },
  }
}

function liveAdapter(): Adapter {
  const requireKey = () => {
    const key = process.env.FAL_KEY
    if (!key) {
      // Checked before dispatch: discovering a missing FAL_KEY halfway through
      // a run leaves half a graph rendered and half queued.
      throw new Error('FAL_MODE=live requires FAL_KEY to be set.')
    }
    return key
  }

  const call = async (url: string, init: RequestInit = {}) => {
    const response = await fetch(url, {
      ...init,
      headers: {
        Authorization: `Key ${requireKey()}`,
        'Content-Type': 'application/json',
        ...init.headers,
      },
    })
    if (!response.ok) {
      throw new Error(`fal ${response.status}: ${(await response.text()).slice(0, 300)}`)
    }
    return response.json()
  }

  const queueBase = (endpoint: string) => `https://queue.fal.run/${endpoint}`

  /**
   * Where to poll, taken from fal rather than rebuilt from the endpoint.
   *
   * Submitting to `fal-ai/flux-2/pro` returns a result URL of
   * `…/fal-ai/flux-2/requests/{id}` — the sub-path is *dropped*. Rebuilding it
   * with the sub-path still attached is a 405 on every model whose endpoint has
   * one, which is five of the six rows in the registry: the render is submitted
   * and paid for, and the poll that would collect it can never succeed.
   *
   * A run submitted by an older build stored `endpoint#request_id` instead. It
   * is resumed on its own terms, never restarted, because it has real money
   * attached — the sub-path is dropped here the way fal drops it.
   */
  const resultUrl = (requestId: string) => {
    if (requestId.startsWith('http')) return requestId
    const [endpoint, id] = requestId.split('#')
    const [owner, app] = endpoint.split('/')
    return `${queueBase(`${owner}/${app}`)}/requests/${id}`
  }

  return {
    async submit(request) {
      requireKey()
      const body = (await call(queueBase(endpointOf(request)), {
        method: 'POST',
        body: JSON.stringify(request.input),
      })) as { request_id: string; response_url?: string }
      // fal's own URL when it gives one; the derived form is the fallback, not
      // the rule, so a future change to how fal shapes these follows for free.
      return { requestId: body.response_url ?? `${endpointOf(request)}#${body.request_id}` }
    },
    async poll(requestId) {
      const url = resultUrl(requestId)
      const status = (await call(`${url}/status`)) as { status: string }
      if (status.status === 'COMPLETED') {
        const raw = (await call(url)) as FalRawResult
        if (raw.error) return { status: 'FAILED', error: raw.error.message ?? 'fal error' }
        return { status: 'COMPLETED', outputs: parseOutputs(raw) }
      }
      if (status.status === 'FAILED') return { status: 'FAILED', error: 'fal reported FAILED' }
      return { status: 'IN_PROGRESS' }
    },
  }
}

/**
 * A test double, not a cache.
 *
 * The browser suite builds graphs through the UI, so it cannot know a node's
 * input hash ahead of time and cannot pre-record a fixture for it. This returns
 * a small real file for anything asked of it and never opens a socket.
 *
 * The bytes are genuine media, not a 1x1 placeholder: everything downstream of
 * the worker — the ffprobe, the transcode, the export resize, the spec check —
 * reads the file rather than the row, and a placeholder makes all of those pass
 * on garbage. A data URI rather than a path so the worker's one download path
 * stays the download path.
 *
 * Deliberately not the default and deliberately named: someone running with
 * this set gets obviously-fake output on the first render rather than a subtle
 * quality problem.
 */
// Real ad dimensions, not a thumbnail: the export path refuses anything below a
// format's minimum resolution, so a tiny stub would make every browser export
// fail the spec check for a reason that has nothing to do with the test.
export const STUB_MEDIA = { width: 1080, height: 1920, durationMs: 1000, fps: 2 } as const

function stubAdapter(mediaDir: string): Adapter {
  const dataUri = (file: string, mime: string) =>
    `data:${mime};base64,${readFileSync(path.join(mediaDir, file)).toString('base64')}`

  return {
    async submit({ model, hash }) {
      return { requestId: `stub:${model.format}#${hash}` }
    },
    async poll(requestId) {
      const format = requestId.replace(/^stub:/, '').split('#')[0]
      const video = format === 'video'
      return {
        status: 'COMPLETED',
        outputs: [
          {
            url: video ? dataUri('stub.mp4', 'video/mp4') : dataUri('stub.png', 'image/png'),
            mime: video ? 'video/mp4' : 'image/png',
            width: STUB_MEDIA.width,
            height: STUB_MEDIA.height,
            ...(video ? { durationMs: STUB_MEDIA.durationMs } : {}),
          },
        ],
      }
    },
  }
}

export function createAdapter(options: {
  mode: FalMode
  fixtureDir?: string
  mediaDir?: string
}): Adapter {
  switch (options.mode) {
    case 'off':
      return {
        async submit() {
          throw new FalSpendBlockedError()
        },
        async poll() {
          throw new FalSpendBlockedError()
        },
      }
    case 'replay':
      return replayAdapter(options.fixtureDir ?? path.resolve('test/fixtures/fal'))
    case 'stub':
      return stubAdapter(options.mediaDir ?? path.resolve('test/fixtures/media'))
    case 'live':
      return liveAdapter()
  }
}
