import { describe, test, expect } from 'vitest'
import path from 'node:path'
import { importFlowFile, runFlow, type FlowFile } from '@/core/run-flow'
import { planRun } from '@/core/executor'
import { createAdapter } from '@/models/fal'
import { nodeRuns, assets, sources } from '@/db/schema'
import { eq } from 'drizzle-orm'
import { tempDb } from '../helpers/db'
import { tempFixtureDir, recordSuccess, seedSourceFiles } from '../helpers/fixtures'

// Phase 1 gate #2: "a second run costs $0".

const spec: FlowFile = {
  project: 'serum',
  sources: [{ id: 'src:bottle', kind: 'image', files: ['a.png', 'b.png'] }],
  flow: {
    nodes: [
      { id: 'bottle', type: 'source', sourceId: 'src:bottle' },
      { id: 'marble', type: 'image', prompt: 'bottle on marble', modelId: 'flux-2-pro', seed: 1 },
    ],
    edges: [{ id: 'e1', from: 'bottle', to: 'marble', role: 'reference', position: null }],
  },
}

function prepared() {
  const { db, dir } = tempDb()
  const fixtureDir = tempFixtureDir()
  const { flowId } = importFlowFile(db, spec)
  // Real bytes: a dispatch inlines every reference so fal can fetch it.
  seedSourceFiles(path.join(dir, 'assets'), spec.sources?.flatMap((s) => s.files ?? []) ?? [])
  for (const planned of planRun(db, flowId)) recordSuccess(fixtureDir, planned)
  return {
    db,
    dir,
    fixtureDir,
    flowId,
    options: { adapter: createAdapter({ mode: 'replay' as const, fixtureDir }), storeRoot: path.join(dir, 'assets') },
  }
}

describe('cache hit', () => {
  test('a second identical run dispatches nothing and costs zero', async () => {
    const { db, options } = prepared()
    const first = await runFlow(db, spec, options)
    expect(first.costCents).toBeGreaterThan(0)

    const second = await runFlow(db, spec, options)
    expect(second.enqueued).toBe(0)
    expect(second.cached).toBe(1)
    expect(second.costCents).toBe(0)
  })

  test('the second run creates no new run rows and no new assets', async () => {
    const { db, options } = prepared()
    await runFlow(db, spec, options)
    const runsAfterFirst = db.select().from(nodeRuns).all().length
    const assetsAfterFirst = db.select().from(assets).all().length

    await runFlow(db, spec, options)

    expect(db.select().from(nodeRuns).all()).toHaveLength(runsAfterFirst)
    expect(db.select().from(assets).all()).toHaveLength(assetsAfterFirst)
  })

  test('a cache hit still resolves to the original outputs', async () => {
    // A hit that returns nothing is indistinguishable from a node that never
    // ran, and the canvas would render an empty thumbnail.
    const { db, options } = prepared()
    await runFlow(db, spec, options)
    await runFlow(db, spec, options)

    const run = db.select().from(nodeRuns).get()!
    expect(run.status).toBe('succeeded')
    expect(run.outputRefs).toHaveLength(1)
  })

  test('replacing an asset invalidates the cache and costs money again', async () => {
    // The demo that closes it: new product photos, everything downstream goes
    // stale. Asserted end to end, not just against the hash function.
    const { db, fixtureDir, flowId, options } = prepared()
    await runFlow(db, spec, options)

    db.update(sources).set({ version: 2 }).where(eq(sources.id, 'src:bottle')).run()
    for (const planned of planRun(db, flowId)) recordSuccess(fixtureDir, planned)

    const second = await runFlow(db, spec, options)
    expect(second.enqueued).toBe(1)
    expect(second.cached).toBe(0)
    expect(second.costCents).toBeGreaterThan(0)
  })

  test('editing a prompt invalidates only that node', async () => {
    const { db, fixtureDir, flowId, options } = prepared()
    await runFlow(db, spec, options)

    const edited: FlowFile = {
      ...spec,
      flow: {
        ...spec.flow,
        nodes: spec.flow.nodes.map((n) =>
          n.id === 'marble' ? ({ ...n, prompt: 'bottle on slate' } as (typeof spec.flow.nodes)[0]) : n,
        ),
      },
    }
    importFlowFile(db, edited)
    for (const planned of planRun(db, flowId)) recordSuccess(fixtureDir, planned)

    expect((await runFlow(db, edited, options)).enqueued).toBe(1)
    // And the original is still cached, so reverting the edit is free.
    expect((await runFlow(db, spec, options)).cached).toBe(1)
  })
})
