import { describe, test, expect } from 'vitest'
import { toLines } from '@/app/chat-panel'

describe('turning the thread into what a person actually reads', () => {
  test('keeps plain user and assistant text', () => {
    expect(
      toLines([
        { role: 'user', content: 'add a hero shot' },
        { role: 'assistant', content: 'Adding it now.' },
      ]),
    ).toEqual([
      { role: 'user', text: 'add a hero shot' },
      { role: 'assistant', text: 'Adding it now.' },
    ])
  })

  // Tool calls used to be dropped outright, which made the agent's whole effect
  // on the canvas invisible in the panel: it would say "added the hero shot" and
  // the only evidence was a card appearing somewhere off screen.
  test('joins the text parts and summarises what the turn did to the graph', () => {
    const lines = toLines([
      {
        role: 'assistant',
        content: [
          { type: 'text', text: 'Looking at the brief. ' },
          { type: 'tool-call', toolName: 'add_node' },
          { type: 'text', text: 'Added the hero shot.' },
        ],
      },
    ])
    expect(lines).toEqual([
      { role: 'assistant', text: 'Looking at the brief. Added the hero shot.' },
      { role: 'activity', tools: ['added a node'] },
    ])
  })

  test('a turn that is nothing but tool calls is activity, not an empty bubble', () => {
    expect(
      toLines([
        { role: 'assistant', content: [{ type: 'tool-call', toolName: 'add_node' }, { type: 'tool-call', toolName: 'wire' }] },
      ]),
    ).toEqual([{ role: 'activity', tools: ['added a node', 'wired two nodes'] }])
  })

  test('a tool nobody has named yet still shows up, under its own name', () => {
    expect(
      toLines([{ role: 'assistant', content: [{ type: 'tool-call', toolName: 'invent_a_lens' }] }]),
    ).toEqual([{ role: 'activity', tools: ['invent_a_lens'] }])
  })

  test('drops tool-role messages and turns with nothing in them at all', () => {
    const lines = toLines([
      { role: 'tool', content: [{ type: 'tool-result', result: 'ok' }] },
      { role: 'assistant', content: '   ' },
    ])
    expect(lines).toEqual([])
  })
})
