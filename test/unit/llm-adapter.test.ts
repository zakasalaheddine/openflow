import { describe, test, expect, vi, afterEach } from 'vitest'
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { streamText, wrapLanguageModel } from 'ai'
import { MockLanguageModelV4, simulateReadableStream } from 'ai/test'
import {
  createChatModel,
  fixtureKey,
  recordingMiddleware,
  LlmDisabledError,
  MissingLlmFixtureError,
} from '@/models/llm'
import { llmMode, openrouterModel } from '@/env'

// `createChatModel` must stay assignable to `streamText`'s `model` option — the
// one thing Task 4 needs from this file. This line only has to compile; if
// `createChatModel`'s return type is ever widened away from LanguageModelV4,
// `npm run typecheck` fails here instead of in Task 4's file.
const _typeCheck: Parameters<typeof streamText>[0]['model'] = createChatModel({ mode: 'off' })

afterEach(() => vi.unstubAllEnvs())

const HELLO = {
  chunks: [
    { type: 'stream-start', warnings: [] },
    { type: 'text-start', id: 't' },
    { type: 'text-delta', id: 't', delta: 'two shots, then an export' },
    { type: 'text-end', id: 't' },
    { type: 'finish', finishReason: 'stop', usage: { inputTokens: 1, outputTokens: 1, totalTokens: 2 } },
  ],
}

/**
 * The model is exercised directly rather than through streamText.
 *
 * streamText turns a provider failure into AI_NoOutputGeneratedError, so a test
 * driven through it would pass whether the adapter threw LlmDisabledError, a
 * missing fixture, or nothing at all — which is the opposite of what these
 * three tests exist to prove.
 */
const request = { prompt: [{ role: 'user', content: 'what would you build' }], tools: [] }

const readText = async (stream: ReadableStream<unknown>) => {
  const reader = stream.getReader()
  let text = ''
  for (;;) {
    const { done, value } = await reader.read()
    if (done) return text
    const chunk = value as { type: string; delta?: string }
    if (chunk.type === 'text-delta') text += chunk.delta ?? ''
  }
}

describe('llmMode', () => {
  test('is off when no key is set, so chat degrades instead of erroring oddly', () => {
    vi.stubEnv('LLM_MODE', '')
    vi.stubEnv('OPENROUTER_API_KEY', '')
    vi.stubEnv('DEMO', '')
    expect(llmMode()).toBe('off')
  })

  test('goes live once a key exists', () => {
    vi.stubEnv('LLM_MODE', '')
    vi.stubEnv('OPENROUTER_API_KEY', 'sk-test')
    vi.stubEnv('DEMO', '')
    expect(llmMode()).toBe('live')
  })

  test('DEMO=1 forces replay even with a key present', () => {
    vi.stubEnv('DEMO', '1')
    vi.stubEnv('OPENROUTER_API_KEY', 'sk-test')
    expect(llmMode()).toBe('replay')
  })

  // The literal is asserted, not read from env: the checked-in fixtures are
  // keyed to this exact string and both test configs pin it, so bumping the
  // default in env.ts has to fail here rather than drift away from them.
  test('the model is one environment variable, with a working default', () => {
    vi.stubEnv('OPENROUTER_MODEL', '')
    expect(openrouterModel()).toBe('anthropic/claude-opus-5')
    vi.stubEnv('OPENROUTER_MODEL', 'openai/gpt-5')
    expect(openrouterModel()).toBe('openai/gpt-5')
  })
})

describe('the chat model', () => {
  test('off refuses rather than reaching for a key it does not have', async () => {
    const model = createChatModel({ mode: 'off' })
    await expect(model.doStream(request as never)).rejects.toThrow(LlmDisabledError)
  })

  test('replay serves a recorded turn and opens no socket', async () => {
    const dir = mkdtempSync(path.join(tmpdir(), 'openflow-llm-'))
    try {
      writeFileSync(
        path.join(dir, `${fixtureKey({ ...request, model: openrouterModel() })}.json`),
        JSON.stringify(HELLO),
      )

      const fetchSpy = vi.spyOn(globalThis, 'fetch')
      const model = createChatModel({ mode: 'replay', fixtureDir: dir })
      const { stream } = await model.doStream(request as never)

      expect(await readText(stream)).toContain('two shots')
      expect(fetchSpy).not.toHaveBeenCalled()
      fetchSpy.mockRestore()
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  test('an unrecorded request is a loud miss, not a stale answer', async () => {
    const dir = mkdtempSync(path.join(tmpdir(), 'openflow-llm-'))
    try {
      const model = createChatModel({ mode: 'replay', fixtureDir: dir })
      await expect(model.doStream(request as never)).rejects.toThrow(MissingLlmFixtureError)
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  test('the key is the request, so two different requests cannot share a fixture', () => {
    const model = 'anthropic/claude-opus-5'
    expect(fixtureKey({ model, prompt: [{ role: 'user', content: 'a' }], tools: [] })).not.toBe(
      fixtureKey({ model, prompt: [{ role: 'user', content: 'b' }], tools: [] }),
    )
  })

  // OPENROUTER_MODEL is one line to swap. Without this, recording the same turn
  // under a second model overwrites the first one's fixture in place, and replay
  // then serves an answer neither model gave under the model it is set to.
  test('the model is in the key, so swapping it cannot overwrite the old fixture', () => {
    const prompt = [{ role: 'user', content: 'a' }]
    expect(fixtureKey({ model: 'anthropic/claude-opus-5', prompt, tools: [] })).not.toBe(
      fixtureKey({ model: 'moonshotai/kimi-k3', prompt, tools: [] }),
    )
  })

  test('replay misses loudly when the model changed under it', async () => {
    const dir = mkdtempSync(path.join(tmpdir(), 'openflow-llm-'))
    try {
      writeFileSync(
        path.join(dir, `${fixtureKey({ ...request, model: 'anthropic/claude-opus-5' })}.json`),
        JSON.stringify(HELLO),
      )
      const model = createChatModel({
        mode: 'replay',
        fixtureDir: dir,
        model: 'moonshotai/kimi-k3',
      })
      await expect(model.doStream(request as never)).rejects.toThrow(MissingLlmFixtureError)
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })
})

/**
 * The recording tap is what makes a fixture "a run away, not a hand-write" —
 * but nothing calls it with a live key in CI. This proves it fires, without
 * one: wrap a MockLanguageModelV4 (standing in for the real OpenRouter model)
 * with the same middleware liveModel() uses, drain the tapped stream, and
 * check replay serves the file it wrote.
 */
describe('the recording tap', () => {
  test('what it taps is what replay serves back', async () => {
    const dir = mkdtempSync(path.join(tmpdir(), 'openflow-llm-'))
    try {
      const stub = new MockLanguageModelV4({
        doStream: async () => ({
          stream: simulateReadableStream({
            chunks: HELLO.chunks as never[],
            initialDelayInMs: null,
            chunkDelayInMs: null,
          }),
        }),
      })
      const tapped = wrapLanguageModel({ model: stub, middleware: recordingMiddleware(dir, openrouterModel()) })

      const { stream } = await tapped.doStream(request as never)
      expect(await readText(stream)).toContain('two shots')

      const replayed = createChatModel({ mode: 'replay', fixtureDir: dir })
      const { stream: replayedStream } = await replayed.doStream(request as never)
      expect(await readText(replayedStream)).toContain('two shots')
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })
})
