import { describe, test, expect } from 'vitest'
import { existsSync, statSync } from 'node:fs'
import path from 'node:path'
import { eq } from 'drizzle-orm'
import { importFlowFile, runFlow, type FlowFile } from '@/core/run-flow'
import { planRun } from '@/core/executor'
import { createAdapter } from '@/models/fal'
import { nodeRuns, assets } from '@/db/schema'
import { tempDb } from '../helpers/db'
import { tempFixtureDir, recordSuccess } from '../helpers/fixtures'

// Phase 1 gate #1: "a JSON graph produces images on disk".

const spec: FlowFile = {
  project: 'serum',
  anchors: [{ id: 'bottle', kind: 'product', refImages: ['a.png', 'b.png'] }],
  flow: {
    nodes: [
      { id: 'marble', type: 'image', prompt: 'bottle on marble', anchors: ['bottle'], modelRole: 'draft', seed: 1 },
      { id: 'slate', type: 'image', prompt: 'bottle on slate', anchors: ['bottle'], modelRole: 'draft', seed: 2 },
    ],
    edges: [],
  },
}

function prepared() {
  const { db, dir } = tempDb()
  const fixtureDir = tempFixtureDir()
  const { flowId } = importFlowFile(db, spec)
  for (const planned of planRun(db, flowId)) recordSuccess(fixtureDir, planned)
  return {
    db,
    dir,
    flowId,
    options: { adapter: createAdapter({ mode: 'replay' as const, fixtureDir }), storeRoot: path.join(dir, 'assets') },
  }
}

describe('headless run', () => {
  test('produces an image file on disk per node', async () => {
    const { db, options } = prepared()
    const summary = await runFlow(db, spec, options)

    expect(summary.succeeded).toBe(2)
    expect(summary.failed).toBe(0)

    const rows = db.select().from(assets).all()
    expect(rows).toHaveLength(2)
    for (const asset of rows) {
      expect(existsSync(asset.path)).toBe(true)
      expect(statSync(asset.path).size).toBeGreaterThan(0)
    }
  })

  test('records dimensions and mime on every asset', async () => {
    // v2 sequencing needs these; probing every file retroactively is the thing
    // this column exists to avoid.
    const { db, options } = prepared()
    await runFlow(db, spec, options)

    for (const asset of db.select().from(assets).all()) {
      expect(asset.mime).toBe('image/png')
      expect(asset.width).toBe(1024)
      expect(asset.height).toBe(1024)
    }
  })

  test('writes a non-zero cost for every dispatched run', async () => {
    const { db, options } = prepared()
    const summary = await runFlow(db, spec, options)

    const runs = db.select().from(nodeRuns).all()
    expect(runs).toHaveLength(2)
    for (const run of runs) expect(run.costCents).toBeGreaterThan(0)
    expect(summary.costCents).toBe(runs.reduce((sum, r) => sum + r.costCents, 0))
  })

  test('links every asset back to the run that produced it', async () => {
    // Provenance is a headline feature; an orphan asset cannot be attributed to
    // a prompt, model or price.
    const { db, options } = prepared()
    await runFlow(db, spec, options)

    for (const asset of db.select().from(assets).all()) {
      expect(asset.sourceRunId).toBeTruthy()
      expect(db.select().from(nodeRuns).where(eq(nodeRuns.id, asset.sourceRunId!)).get()).toBeTruthy()
    }
  })
})
