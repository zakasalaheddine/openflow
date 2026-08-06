import { describe, test, expect } from 'vitest'
import { fixtureKey } from '@/models/llm'

const tools = [{ type: 'function', name: 'add_node', inputSchema: { type: 'object' } }]
const model = 'anthropic/claude-opus-5'

const turnOne = {
  model,
  prompt: [
    { role: 'system', content: 'You author graphs.' },
    { role: 'user', content: [{ type: 'text', text: 'add a hero shot' }] },
  ],
  tools,
}

const turnTwo = {
  model,
  prompt: [
    ...turnOne.prompt,
    { role: 'assistant', content: [{ type: 'tool-call', toolCallId: 'c1', toolName: 'add_node', input: {} }] },
    { role: 'tool', content: [{ type: 'tool-result', toolCallId: 'c1', toolName: 'add_node', output: {} }] },
  ],
  tools,
}

describe('fixtureKey', () => {
  test('two turns of one conversation are different fixtures', () => {
    // The old key hashed a single prompt string. A multi-turn conversation
    // collided on it, so replay served some other turn's answer and the test
    // still passed — the exact failure a recorded fixture exists to prevent.
    expect(fixtureKey(turnOne)).not.toBe(fixtureKey(turnTwo))
  })

  test('a changed system prompt is a different fixture', () => {
    const edited = {
      ...turnOne,
      prompt: [{ role: 'system', content: 'You author graphs. Be brief.' }, turnOne.prompt[1]],
    }
    expect(fixtureKey(edited)).not.toBe(fixtureKey(turnOne))
  })

  test('a changed tool set is a different fixture', () => {
    expect(fixtureKey({ ...turnOne, tools: [] })).not.toBe(fixtureKey(turnOne))
  })

  test('key order in the request does not change the key', () => {
    // canonicalJson sorts keys at every depth, same as the run hash. Otherwise
    // an object built in a different order looks like a different request.
    expect(fixtureKey({ tools, model, prompt: turnOne.prompt })).toBe(fixtureKey(turnOne))
  })

  test('the same turn under a second model is a different fixture', () => {
    // OPENROUTER_MODEL is one line to swap. Without the model in the key, the
    // new model's recording lands on the old one's filename and replay serves
    // an answer the configured model never gave.
    expect(fixtureKey({ ...turnOne, model: 'minimax/minimax-m2' })).not.toBe(fixtureKey(turnOne))
  })
})
