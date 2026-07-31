import { describe, test, expect, vi, afterEach } from 'vitest'
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import {
  createLlmAdapter,
  fixtureKey,
  LlmDisabledError,
  MissingLlmFixtureError,
} from '@/models/llm'
import { llmMode } from '@/env'

const SCHEMA = { type: 'object' }

afterEach(() => vi.unstubAllEnvs())

describe('llmMode', () => {
  test('is off when no key is set, so briefing degrades instead of erroring oddly', () => {
    vi.stubEnv('LLM_MODE', '')
    vi.stubEnv('ANTHROPIC_API_KEY', '')
    vi.stubEnv('DEMO', '')
    expect(llmMode()).toBe('off')
  })

  test('goes live once a key exists', () => {
    vi.stubEnv('LLM_MODE', '')
    vi.stubEnv('ANTHROPIC_API_KEY', 'sk-test')
    vi.stubEnv('DEMO', '')
    expect(llmMode()).toBe('live')
  })

  test('DEMO=1 forces replay even with a key present', () => {
    vi.stubEnv('DEMO', '1')
    vi.stubEnv('ANTHROPIC_API_KEY', 'sk-test')
    expect(llmMode()).toBe('replay')
  })
})

describe('the adapter', () => {
  test('off refuses rather than reaching for a key it does not have', async () => {
    const adapter = createLlmAdapter({ mode: 'off' })
    await expect(adapter.complete({ prompt: 'x', schema: SCHEMA })).rejects.toThrow(LlmDisabledError)
  })

  test('replay serves a recorded response and opens no socket', async () => {
    const dir = mkdtempSync(path.join(tmpdir(), 'openflow-llm-'))
    try {
      const prompt = 'write me a graph'
      writeFileSync(path.join(dir, `${fixtureKey(prompt)}.json`), '{"templateId":"x","prompts":{}}')

      const fetchSpy = vi.spyOn(globalThis, 'fetch')
      const adapter = createLlmAdapter({ mode: 'replay', fixtureDir: dir })
      expect(JSON.parse(await adapter.complete({ prompt, schema: SCHEMA })).templateId).toBe('x')
      expect(fetchSpy).not.toHaveBeenCalled()
      fetchSpy.mockRestore()
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  test('a changed prompt surfaces as a missing fixture, not a stale answer', async () => {
    // Keyed by prompt on purpose: replaying the old response for a new prompt
    // would make the brief path look tested when it is not.
    const dir = mkdtempSync(path.join(tmpdir(), 'openflow-llm-'))
    try {
      const adapter = createLlmAdapter({ mode: 'replay', fixtureDir: dir })
      await expect(adapter.complete({ prompt: 'unrecorded', schema: SCHEMA })).rejects.toThrow(
        MissingLlmFixtureError,
      )
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })
})
