import { describe, test, expect } from 'vitest'
import { tempDb, seedProject, seedFlow } from '../helpers/db'
import { saveGraph, saveGraphIfCurrent, StaleGraphError } from '@/core/workspace'
import type { Flow } from '@/core/types'

const graphOf = (...ids: string[]): Flow => ({
  nodes: ids.map((id) => ({ id, type: 'image', prompt: '', modelId: 'flux-2-pro', seed: 1 })),
  edges: [],
})

describe('saveGraphIfCurrent', () => {
  test('accepts a write carrying the stamp it read', () => {
    const { db } = tempDb()
    const projectId = seedProject(db)
    const flowId = seedFlow(db, projectId, graphOf())

    const first = saveGraph(db, flowId, graphOf('a'))
    const second = saveGraphIfCurrent(db, flowId, graphOf('a', 'b'), first)

    expect(second).not.toBe(first)
  })

  test('refuses a write built on a graph someone else has already replaced', () => {
    // The canvas PATCHes its whole local graph on drag-end. Without this guard
    // an agent node added mid-drag is silently erased by that PATCH.
    const { db } = tempDb()
    const projectId = seedProject(db)
    const flowId = seedFlow(db, projectId, graphOf())

    const read = saveGraph(db, flowId, graphOf('a'))
    saveGraph(db, flowId, graphOf('a', 'agent')) // the agent writes

    expect(() => saveGraphIfCurrent(db, flowId, graphOf('a'), read)).toThrow(StaleGraphError)
  })

  test('two writes in the same millisecond still get different stamps', () => {
    // Date.now() has millisecond resolution and agent tool calls land faster
    // than that. Equal stamps would let a stale write through the guard.
    const { db } = tempDb()
    const projectId = seedProject(db)
    const flowId = seedFlow(db, projectId, graphOf())

    const stamps = new Set([
      saveGraph(db, flowId, graphOf('a')),
      saveGraph(db, flowId, graphOf('a', 'b')),
      saveGraph(db, flowId, graphOf('a', 'b', 'c')),
    ])

    expect(stamps.size).toBe(3)
  })
})
