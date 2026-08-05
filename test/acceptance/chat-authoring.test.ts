import { describe, test, expect } from 'vitest'
import { MockLanguageModelV4, simulateReadableStream } from 'ai/test'
import { tempDb, seedProject, seedFlow, seedSource } from '../helpers/db'
import { runTurn } from '@/agent/loop'
import { createOps } from '@/agent/ops'
import { saveGraph } from '@/core/workspace'
import { planRun } from '@/core/executor'
import { applyWire } from '@/core/wiring'
import type { Flow } from '@/core/types'

const EMPTY: Flow = { nodes: [], edges: [] }

const call = (id: string, name: string, input: unknown) => ({
  type: 'tool-call',
  toolCallId: id,
  toolName: name,
  input: JSON.stringify(input),
})

const finish = (reason: string) => ({
  type: 'finish',
  finishReason: reason,
  usage: { inputTokens: 1, outputTokens: 1, totalTokens: 2 },
})

describe('chat and canvas agree', () => {
  test('a chat-built flow hashes identically to the same flow built on the canvas', async () => {
    // The whole point of the agent layer: it is a second front door onto the
    // same core. If these hashes differ, the agent has grown logic of its own —
    // and two surfaces that disagree about a hash also disagree about the bill.
    const { db } = tempDb()
    const projectId = seedProject(db)
    const sourceId = seedSource(db, projectId, 'source-a')

    // --- built by chat ---
    const chatFlow = seedFlow(db, projectId, EMPTY, 'flow-chat')
    const model = new MockLanguageModelV4({
      doStream: (() => {
        const turns = [
          [
            { type: 'stream-start', warnings: [] },
            call('c1', 'add_node', { type: 'source', sourceId }),
            finish('tool-calls'),
          ],
          [
            { type: 'stream-start', warnings: [] },
            call('c2', 'add_node', { type: 'image', prompt: 'a serum on cold marble' }),
            finish('tool-calls'),
          ],
          [
            { type: 'stream-start', warnings: [] },
            { type: 'text-start', id: 't' },
            { type: 'text-delta', id: 't', delta: 'Done.' },
            { type: 'text-end', id: 't' },
            finish('stop'),
          ],
        ]
        let index = 0
        return async () => ({
          stream: simulateReadableStream({
            chunks: turns[index++] as never[],
            initialDelayInMs: null,
            chunkDelayInMs: null,
          }),
        })
      })(),
    })

    await runTurn({
      db,
      ids: { projectId, flowId: chatFlow },
      model,
      brandProfile: '',
      message: 'bring in the product and put it on cold marble',
    }).text

    // --- built by hand, exactly as the canvas builds it ---
    const canvasFlow = seedFlow(db, projectId, EMPTY, 'flow-canvas')
    const built: Flow = {
      nodes: [
        { id: 'asset-1', type: 'source', sourceId, position: { x: 0, y: 0 } },
        {
          id: 'image-1',
          type: 'image',
          position: { x: 250, y: 0 },
          prompt: 'a serum on cold marble',
          modelRole: 'draft',
          seed: 1,
        },
      ],
      edges: [],
    }
    saveGraph(db, canvasFlow, built)

    const hashes = (flowId: string) =>
      planRun(db, flowId)
        .map((planned) => planned.inputHash)
        .sort()

    // Without this, an empty planRun on both sides — say, because the agent
    // added nothing — would still pass: expect([]).toEqual([]) is true. The
    // length pins the test to the graph actually having the one runnable node
    // it expects.
    expect(hashes(chatFlow)).toHaveLength(1)
    expect(hashes(chatFlow)).toEqual(hashes(canvasFlow))
  })

  test('a clip wired to its first frame hashes the same through either door', async () => {
    // The wire is the interesting half. inputHash folds in upstreamHashes, so a
    // video node's hash depends on the edge existing AND on the role inferred
    // for it. If inferRole or applyWire were re-implemented in the agent layer,
    // this is where it shows — the first test has no edges and cannot see it.
    const { db } = tempDb()
    const projectId = seedProject(db)
    const chatFlow = seedFlow(db, projectId, EMPTY, 'flow-chat')

    // The third turn wires whatever the first two produced. A real model would
    // read the ids off add_node's return; the script reads them off the graph,
    // which is the same information arriving the same way.
    //
    // Each turn's chunks are built only when that turn is reached, not up
    // front: a plain array of all four turns would evaluate the wire turn's
    // `nodes.find(...)` eagerly on the very first call, before any node
    // exists, and throw before the mock ever gets to run turn one.
    let index = 0
    const model = new MockLanguageModelV4({
      doStream: async () => {
        const turn = index++
        const chunks =
          turn === 0
            ? [
                { type: 'stream-start', warnings: [] },
                call('c1', 'add_node', { type: 'image', prompt: 'still' }),
                finish('tool-calls'),
              ]
            : turn === 1
              ? [
                  { type: 'stream-start', warnings: [] },
                  call('c2', 'add_node', { type: 'video', prompt: 'push in' }),
                  finish('tool-calls'),
                ]
              : turn === 2
                ? (() => {
                    const nodes = createOps(db, { projectId, flowId: chatFlow }).listGraph().nodes
                    return [
                      { type: 'stream-start', warnings: [] },
                      call('c3', 'wire', {
                        from: nodes.find((n) => n.type === 'image')!.id,
                        to: nodes.find((n) => n.type === 'video')!.id,
                      }),
                      finish('tool-calls'),
                    ]
                  })()
                : [
                    { type: 'stream-start', warnings: [] },
                    { type: 'text-start', id: 't' },
                    { type: 'text-delta', id: 't', delta: 'Wired. Press Run when you want it.' },
                    { type: 'text-end', id: 't' },
                    finish('stop'),
                  ]
        return {
          stream: simulateReadableStream({
            chunks: chunks as never[],
            initialDelayInMs: null,
            chunkDelayInMs: null,
          }),
        }
      },
    })

    await runTurn({
      db,
      ids: { projectId, flowId: chatFlow },
      model,
      brandProfile: '',
      message: 'a still and a clip that starts from it',
    }).text

    const canvasFlow = seedFlow(db, projectId, EMPTY, 'flow-canvas')
    const base: Flow = {
      nodes: [
        { id: 'image-1', type: 'image', prompt: 'still', modelRole: 'draft', seed: 1 },
        {
          id: 'video-1',
          type: 'video',
          prompt: 'push in',
          durationSec: 5,
          audio: false,
          modelRole: 'draft',
          seed: 1,
        },
      ],
      edges: [],
    }
    saveGraph(db, canvasFlow, applyWire(base, 'image-1', 'video-1'))

    const hashes = (flowId: string) =>
      planRun(db, flowId)
        .map((planned) => planned.inputHash)
        .sort()

    // Node ids and positions are excluded from hashableConfig, so two graphs
    // built with different ids hash identically when the work is identical.
    expect(hashes(chatFlow)).toEqual(hashes(canvasFlow))
    expect(hashes(chatFlow)).toHaveLength(2)
  })
})
