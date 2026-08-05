import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { createHash } from 'node:crypto'
import path from 'node:path'
import { createOpenRouter } from '@openrouter/ai-sdk-provider'
import { wrapLanguageModel, type LanguageModelMiddleware } from 'ai'
import { MockLanguageModelV4, simulateReadableStream } from 'ai/test'
import { canonicalJson, type JsonValue } from '../core/hash'
import { openrouterModel, type LlmMode } from '../env'

/**
 * THE ONE PLACE that talks to an LLM.
 *
 * The same seam as models/fal.ts, for the same reason: a recorded fixture makes
 * the chat path testable without a key, and CI can never accidentally spend.
 *
 * What comes back is still untrusted. Tool arguments are validated by their zod
 * schemas and the resulting graph by flowSchema before anything is saved.
 */
export class LlmDisabledError extends Error {
  constructor() {
    super(
      'Chat needs a model. Set OPENROUTER_API_KEY (or LLM_MODE=replay to use recorded responses).',
    )
    this.name = 'LlmDisabledError'
  }
}

export class MissingLlmFixtureError extends Error {
  constructor(file: string) {
    super(`No LLM fixture at ${file}. Record one with LLM_MODE=live OPENFLOW_RECORD_LLM=1.`)
    this.name = 'MissingLlmFixtureError'
  }
}

/**
 * Keyed by the WHOLE request, not by one prompt string.
 *
 * A chat turn is a growing array of messages and tool results. Keying on a
 * single string made every turn of one conversation collide, so replay served
 * the wrong turn and the suite went green anyway. The tool set is folded in too:
 * adding a tool changes what the model can answer, so it must change the key.
 */
export const fixtureKey = (request: { prompt: unknown; tools?: unknown }) =>
  createHash('sha256')
    .update(canonicalJson({ prompt: request.prompt, tools: request.tools } as JsonValue))
    .digest('hex')
    .slice(0, 32)

const DEFAULT_FIXTURE_DIR = path.resolve('test/fixtures/llm')

/**
 * Replay is a mock model rather than hand-rolled stream faking: ai-sdk ships
 * MockLanguageModelV4 for exactly this, and the recorded chunks are the same
 * shapes a real provider emits, so replay exercises the real code path.
 */
function replayModel(fixtureDir: string) {
  const load = (options: { prompt: unknown; tools?: unknown }) => {
    const file = path.join(fixtureDir, `${fixtureKey(options)}.json`)
    if (!existsSync(file)) throw new MissingLlmFixtureError(file)
    return JSON.parse(readFileSync(file, 'utf8')) as { chunks: unknown[] }
  }

  return new MockLanguageModelV4({
    doStream: async (options) => ({
      stream: simulateReadableStream({
        chunks: load(options).chunks as never[],
        initialDelayInMs: null,
        chunkDelayInMs: null,
      }),
    }),
  })
}

/**
 * The recording tap: `wrapLanguageModel`'s `wrapStream` middleware hook, not a
 * `MockLanguageModelV4` wrapped around a real model — `wrapStream` is what the
 * SDK ships for exactly this (observe a stream without changing what it
 * yields), and it keeps the vocabulary honest: nothing here is mocked.
 *
 * Exported so a test can prove it round-trips into replay without a live key:
 * feed it a MockLanguageModelV4, drain the tapped stream, then replay the file
 * it wrote and check the two produce the same text.
 */
export function recordingMiddleware(fixtureDir: string): LanguageModelMiddleware {
  return {
    wrapStream: async ({ doStream, params }) => {
      const { stream, ...rest } = await doStream()
      const chunks: unknown[] = []
      const tapped = stream.pipeThrough(
        new TransformStream({
          transform(chunk, controller) {
            chunks.push(chunk)
            controller.enqueue(chunk)
          },
          flush() {
            mkdirSync(fixtureDir, { recursive: true })
            writeFileSync(
              path.join(fixtureDir, `${fixtureKey(params)}.json`),
              `${JSON.stringify({ chunks }, null, 2)}\n`,
            )
          },
        }),
      )
      return { stream: tapped, ...rest }
    },
  }
}

/** Live, with an optional recording tap so a fixture is a run away, not a hand-write. */
function liveModel(fixtureDir: string) {
  const provider = createOpenRouter({ apiKey: process.env.OPENROUTER_API_KEY })
  const model = provider.chat(openrouterModel())
  if (process.env.OPENFLOW_RECORD_LLM !== '1') return model

  return wrapLanguageModel({ model, middleware: recordingMiddleware(fixtureDir) })
}

export function createChatModel(options: { mode: LlmMode; fixtureDir?: string }) {
  const fixtureDir = options.fixtureDir ?? DEFAULT_FIXTURE_DIR
  switch (options.mode) {
    case 'off':
      return new MockLanguageModelV4({
        doStream: async () => {
          throw new LlmDisabledError()
        },
      })
    case 'replay':
      return replayModel(fixtureDir)
    case 'live':
      return liveModel(fixtureDir)
  }
}
