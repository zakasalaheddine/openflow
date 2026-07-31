import { readFileSync, existsSync } from 'node:fs'
import { createHash } from 'node:crypto'
import path from 'node:path'
import Anthropic from '@anthropic-ai/sdk'
import type { LlmMode } from '../env'

/**
 * THE ONE PLACE that talks to an LLM.
 *
 * The same seam as models/fal.ts, for the same reason: a recorded fixture makes
 * the brief path testable without a key, and CI can never accidentally spend.
 *
 * The model is asked for JSON matching a schema rather than trusted to produce
 * it. What comes back is still untrusted input — core/brief.ts validates it
 * against the template set before a single node is created.
 */
export class LlmDisabledError extends Error {
  constructor() {
    super(
      'Brief-to-flow needs an LLM. Set ANTHROPIC_API_KEY (or LLM_MODE=replay to use recorded responses).',
    )
    this.name = 'LlmDisabledError'
  }
}

export class MissingLlmFixtureError extends Error {
  constructor(file: string) {
    super(`No LLM fixture at ${file}. Record one with LLM_MODE=live, or fix the prompt.`)
    this.name = 'MissingLlmFixtureError'
  }
}

export type JsonSchema = Record<string, unknown>

export type LlmAdapter = {
  /** Returns the model's raw JSON text. Parsing and validation happen upstream. */
  complete(request: { prompt: string; schema: JsonSchema }): Promise<string>
}

/** Keyed by prompt, so a changed prompt surfaces as a missing fixture. */
export const fixtureKey = (prompt: string) =>
  createHash('sha256').update(prompt).digest('hex').slice(0, 32)

function replayAdapter(fixtureDir: string): LlmAdapter {
  return {
    async complete({ prompt }) {
      const file = path.join(fixtureDir, `${fixtureKey(prompt)}.json`)
      if (!existsSync(file)) throw new MissingLlmFixtureError(file)
      return readFileSync(file, 'utf8')
    },
  }
}

function liveAdapter(): LlmAdapter {
  return {
    async complete({ prompt, schema }) {
      const client = new Anthropic()
      const response = await client.messages.create({
        model: 'claude-opus-5',
        max_tokens: 4096,
        // Structured outputs rather than a prefill or a "reply with JSON only"
        // plea: the response is constrained to the schema, so the failure modes
        // that remain are the ones core/brief.ts actually checks for.
        output_config: { format: { type: 'json_schema', schema } },
        messages: [{ role: 'user', content: prompt }],
      })

      if (response.stop_reason === 'refusal') {
        throw new Error('The model declined this brief.')
      }
      const text = response.content.find((block) => block.type === 'text')
      if (!text || text.type !== 'text') {
        throw new Error('The model returned no text for this brief.')
      }
      return text.text
    },
  }
}

export function createLlmAdapter(options: { mode: LlmMode; fixtureDir?: string }): LlmAdapter {
  switch (options.mode) {
    case 'off':
      return {
        async complete() {
          throw new LlmDisabledError()
        },
      }
    case 'replay':
      return replayAdapter(options.fixtureDir ?? path.resolve('test/fixtures/llm'))
    case 'live':
      return liveAdapter()
  }
}
