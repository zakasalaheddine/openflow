import { describe, test, expect } from 'vitest'
import { writeFileSync } from 'node:fs'
import { planRun, enqueueRun } from '@/core/executor'
import { UnpricedModelError, SEED } from '@/models/registry'
import { modelsPath } from '@/env'
import { tempDb, seedProject, seedFlow } from '../helpers/db'
import type { Flow } from '@/core/types'

/**
 * fal publishes no readable price for roughly half its catalogue, so
 * `npm run models:add` writes those rows with `cost.amount: null`. The model is
 * selectable — you can see it, compare its capabilities, and put it on a node —
 * and it cannot be run until someone writes the number down.
 *
 * Zero would have been the easy shape and the wrong one: it quotes $0.00 before
 * a Run, and the spend cap approves an invoice it never saw.
 */
function setup() {
  const { db, dir } = tempDb()
  writeFileSync(
    modelsPath(),
    JSON.stringify([
      ...SEED,
      {
        id: 'brand-new-thing',
        format: 'image',
        falEndpoint: 'fal-ai/brand-new-thing',
        caps: { refImages: 0, textRendering: false, startEndFrame: false, nativeAudio: false },
        cost: { unit: 'image', amount: null },
        verifiedOn: null,
      },
    ]),
  )

  const graph: Flow = {
    nodes: [
      { id: 'priced', type: 'image', prompt: 'on marble', modelId: 'flux-2-pro', seed: 1 },
      { id: 'unpriced', type: 'image', prompt: 'on marble', modelId: 'brand-new-thing', seed: 1 },
    ],
    edges: [],
  }
  const projectId = seedProject(db)
  const flowId = seedFlow(db, projectId, graph)
  return { db, dir, flowId }
}

describe('a model nobody has priced', () => {
  test('is left out of the plan rather than quoted at zero', () => {
    const { db, flowId } = setup()
    const planned = planRun(db, flowId)
    expect(planned.map((p) => p.nodeId)).toEqual(['priced'])
  })

  test('stops the Run by name, instead of dispatching what the cap cannot see', () => {
    const { db, flowId } = setup()
    expect(() => enqueueRun(db, flowId)).toThrow(UnpricedModelError)
    expect(() => enqueueRun(db, flowId)).toThrow(/brand-new-thing/)
  })

  test('and does not stop the rest of the canvas from loading', () => {
    // The graph naming it has to stay readable, or there is no way to reach the
    // node and price it.
    const { db, flowId } = setup()
    expect(() => planRun(db, flowId)).not.toThrow()
  })
})
