import { describe, test, expect } from 'vitest'
import { MockLanguageModelV4, simulateReadableStream } from 'ai/test'
import { tempDb, seedProject, seedFlow } from '../helpers/db'
import { runTurn, loadThread } from '@/agent/loop'
import { createOps } from '@/agent/ops'
import type { Flow } from '@/core/types'

const EMPTY: Flow = { nodes: [], edges: [] }

/** A model that calls add_node once, then answers. */
function scripted(turns: unknown[][]) {
  let call = 0
  return new MockLanguageModelV4({
    doStream: async () => ({
      stream: simulateReadableStream({
        chunks: turns[call++] as never[],
        initialDelayInMs: null,
        chunkDelayInMs: null,
      }),
    }),
  })
}

const TURNS = [
  [
    { type: 'stream-start', warnings: [] },
    {
      type: 'tool-call',
      toolCallId: 'c1',
      toolName: 'add_node',
      input: JSON.stringify({ type: 'image', prompt: 'a serum on marble' }),
    },
    { type: 'finish', finishReason: 'tool-calls', usage: { inputTokens: 1, outputTokens: 1, totalTokens: 2 } },
  ],
  [
    { type: 'stream-start', warnings: [] },
    { type: 'text-start', id: 't' },
    { type: 'text-delta', id: 't', delta: 'One shot on the canvas. Press Run when you want it.' },
    { type: 'text-end', id: 't' },
    { type: 'finish', finishReason: 'stop', usage: { inputTokens: 1, outputTokens: 1, totalTokens: 2 } },
  ],
]

describe('runTurn', () => {
  test('a tool call lands on the canvas, and nothing is dispatched', async () => {
    const { db } = tempDb()
    const projectId = seedProject(db)
    const flowId = seedFlow(db, projectId, EMPTY)

    const result = runTurn({
      db,
      ids: { projectId, flowId },
      model: scripted(TURNS),
      brandProfile: 'Quiet, clinical, cold light.',
      message: 'add a hero shot of the serum on marble',
    })
    expect(await result.text).toContain('Press Run')

    const graph = createOps(db, { projectId, flowId }).listGraph()
    expect(graph.nodes).toHaveLength(1)
    expect(graph.nodes[0]).toMatchObject({ type: 'image', prompt: 'a serum on marble' })
  })

  test('the tool call is in the thread, so a retry does not add the node twice', async () => {
    const { db } = tempDb()
    const projectId = seedProject(db)
    const flowId = seedFlow(db, projectId, EMPTY)

    await runTurn({
      db,
      ids: { projectId, flowId },
      model: scripted(TURNS),
      brandProfile: '',
      message: 'add a hero shot',
    }).text

    const thread = loadThread(db, flowId)
    expect(thread.map((m) => m.role)).toEqual(['user', 'assistant', 'tool', 'assistant'])
  })

  test('a step is persisted as it finishes, so a mid-turn failure keeps its tool call', async () => {
    const { db } = tempDb()
    const projectId = seedProject(db)
    const flowId = seedFlow(db, projectId, EMPTY)

    // Step one succeeds and runs add_node; step two's provider call fails
    // outright. If persistence ever moved to the end of the turn, this test
    // would see zero rows instead of the first step's.
    let call = 0
    const model = new MockLanguageModelV4({
      doStream: async () => {
        if (call++ === 0) {
          return {
            stream: simulateReadableStream({
              chunks: TURNS[0] as never[],
              initialDelayInMs: null,
              chunkDelayInMs: null,
            }),
          }
        }
        throw new Error('provider unavailable')
      },
    })

    try {
      await runTurn({
        db,
        ids: { projectId, flowId },
        model,
        brandProfile: '',
        message: 'add a hero shot',
      }).text
    } catch {
      // Expected: the second step's provider call fails, so result.text rejects.
    }

    const thread = loadThread(db, flowId)
    expect(thread.map((m) => m.role)).toEqual(['user', 'assistant', 'tool'])
  })
})
