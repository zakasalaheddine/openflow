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

  test('joins the text parts of a multi-part assistant message and drops the rest', () => {
    const lines = toLines([
      {
        role: 'assistant',
        content: [
          { type: 'text', text: 'Looking at the brief. ' },
          { type: 'tool-call', toolName: 'addNode' },
          { type: 'text', text: 'Added the hero shot.' },
        ],
      },
    ])
    expect(lines).toEqual([{ role: 'assistant', text: 'Looking at the brief. Added the hero shot.' }])
  })

  test('drops tool-role messages and text-only turns with nothing a person wrote', () => {
    const lines = toLines([
      { role: 'tool', content: [{ type: 'tool-result', result: 'ok' }] },
      { role: 'assistant', content: [{ type: 'tool-call', toolName: 'addNode' }] },
      { role: 'assistant', content: '   ' },
    ])
    expect(lines).toEqual([])
  })
})
