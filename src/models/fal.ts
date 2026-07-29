import { readFileSync, existsSync } from 'node:fs'
import path from 'node:path'
import type { ModelSpec } from './registry'
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

const fixturePathFor = (dir: string, model: ModelSpec, hash: string) =>
  path.join(dir, model.falEndpoint.replaceAll('/', '_'), `${hash}.json`)

function replayAdapter(fixtureDir: string): Adapter {
  const pending = new Map<string, FalRawResult>()

  return {
    async submit({ model, hash }) {
      const file = fixturePathFor(fixtureDir, model, hash)
      if (!existsSync(file)) throw new MissingFixtureError(file)
      const requestId = `replay:${hash}`
      pending.set(requestId, JSON.parse(readFileSync(file, 'utf8')) as FalRawResult)
      return { requestId }
    },
    async poll(requestId) {
      const raw = pending.get(requestId)
      if (!raw) return { status: 'FAILED', error: `Unknown replay request ${requestId}` }
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

  // The queue endpoint is stateless per request id, but the status URL needs the
  // endpoint back. Encoding it into the request id keeps the worker's job row
  // to a single string column.
  return {
    async submit({ model, input }) {
      requireKey()
      const body = (await call(queueBase(model.falEndpoint), {
        method: 'POST',
        body: JSON.stringify(input),
      })) as { request_id: string }
      return { requestId: `${model.falEndpoint}#${body.request_id}` }
    },
    async poll(requestId) {
      const [endpoint, id] = requestId.split('#')
      const status = (await call(`${queueBase(endpoint)}/requests/${id}/status`)) as {
        status: string
      }
      if (status.status === 'COMPLETED') {
        const raw = (await call(`${queueBase(endpoint)}/requests/${id}`)) as FalRawResult
        if (raw.error) return { status: 'FAILED', error: raw.error.message ?? 'fal error' }
        return { status: 'COMPLETED', outputs: parseOutputs(raw) }
      }
      if (status.status === 'FAILED') return { status: 'FAILED', error: 'fal reported FAILED' }
      return { status: 'IN_PROGRESS' }
    },
  }
}

export function createAdapter(options: { mode: FalMode; fixtureDir?: string }): Adapter {
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
    case 'live':
      return liveAdapter()
  }
}
