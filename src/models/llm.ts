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
  constructor(file: string, model: string) {
    super(
      `No LLM fixture at ${file} for ${model}. Record one with LLM_MODE=live OPENFLOW_RECORD_LLM=1, ` +
        'or set OPENROUTER_MODEL back to the model the fixtures were recorded under.',
    )
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
 *
 * So does the model, for the same reason and one more. OPENROUTER_MODEL is one
 * line to swap Opus for Kimi or MiniMax; without the model in the key, a turn
 * recorded under the new one silently overwrites the old fixture, and replay
 * then serves an answer no configured model ever gave. Fixtures are per-model
 * because answers are.
 */
export const fixtureKey = (request: { model: string; prompt: unknown; tools?: unknown }) =>
  createHash('sha256')
    .update(
      canonicalJson({
        model: request.model,
        prompt: request.prompt,
        tools: request.tools,
      } as JsonValue),
    )
    .digest('hex')
    .slice(0, 32)

const DEFAULT_FIXTURE_DIR = path.resolve('test/fixtures/llm')

/**
 * Replay is a mock model rather than hand-rolled stream faking: ai-sdk ships
 * MockLanguageModelV4 for exactly this, and the recorded chunks are the same
 * shapes a real provider emits, so replay exercises the real code path.
 */
function replayModel(fixtureDir: string, model: string) {
  const load = (options: { prompt: unknown; tools?: unknown }) => {
    const file = path.join(fixtureDir, `${fixtureKey({ ...options, model })}.json`)
    if (!existsSync(file)) throw new MissingLlmFixtureError(file, model)
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
export function recordingMiddleware(fixtureDir: string, model: string): LanguageModelMiddleware {
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
              path.join(fixtureDir, `${fixtureKey({ ...params, model })}.json`),
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
function liveModel(fixtureDir: string, id: string) {
  const provider = createOpenRouter({ apiKey: process.env.OPENROUTER_API_KEY })
  const model = provider.chat(id)
  if (process.env.OPENFLOW_RECORD_LLM !== '1') return model

  return wrapLanguageModel({ model, middleware: recordingMiddleware(fixtureDir, id) })
}

export function createChatModel(options: { mode: LlmMode; fixtureDir?: string; model?: string }) {
  const fixtureDir = options.fixtureDir ?? DEFAULT_FIXTURE_DIR
  // Replay reads the same variable live does. A fixture belongs to the model
  // that would have been called, so swapping OPENROUTER_MODEL misses loudly
  // instead of replaying the previous model's answer.
  const model = options.model ?? openrouterModel()
  switch (options.mode) {
    case 'off':
      return new MockLanguageModelV4({
        doStream: async () => {
          throw new LlmDisabledError()
        },
      })
    case 'replay':
      return replayModel(fixtureDir, model)
    case 'live':
      return liveModel(fixtureDir, model)
  }
}
