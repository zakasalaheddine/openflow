import { describe, test, expect } from 'vitest'
import { writeFileSync } from 'node:fs'
import path from 'node:path'
import { eq } from 'drizzle-orm'
import { syncCosts } from '../../bin/sync-costs'
import { nodeRuns } from '@/db/schema'
import { tempDb } from '../helpers/db'
import type { Db } from '@/db'

function seedRun(
  db: Db,
  over: Partial<typeof nodeRuns.$inferInsert> & { id: string },
) {
  db.insert(nodeRuns)
    .values({
      flowId: 'flow-1',
      nodeId: 'img',
      inputHash: `hash-${over.id}`,
      status: 'succeeded',
      modelId: 'flux-2-pro',
      falRequestId: 'https://queue.fal.run/fal-ai/flux-2-pro/requests/req-1',
      costCents: 4,
      createdAt: new Date().toISOString(),
      ...over,
    })
    .run()
  return over.id
}

describe('syncCosts', () => {
  test('re-prices a finished render against what fal says it billed', async () => {
    // 4 cents is what deriving it from the output said. fal metered 2.5 units,
    // and flux-2-pro is 3 cents a unit: 7.5 -> 8.
    const { db } = tempDb()
    seedRun(db, { id: 'run-1' })

    const report = await syncCosts(db, async () => 2.5)

    expect(report.repriced).toEqual([
      { runId: 'run-1', nodeId: 'img', modelId: 'flux-2-pro', from: 4, to: 8 },
    ])
    const run = db.select().from(nodeRuns).where(eq(nodeRuns.id, 'run-1')).get()!
    expect(run.costCents).toBe(8)
    expect(run.billableUnits).toBe(2.5)
  })

  test('prices a token-metered row per billable unit, not per image', async () => {
    // gpt-image-2's per-image amount is 0.12 cents, which would price fal's
    // 0.1463 at nothing at all. Its meter is in dollars: 100 cents a unit.
    const { db, dir } = tempDb()
    writeFileSync(
      path.join(dir, 'models.json'),
      JSON.stringify([
        {
          id: 'gpt-image-2',
          format: 'image',
          falEndpoint: 'openai/gpt-image-2',
          caps: { refImages: 16, textRendering: false, startEndFrame: false, nativeAudio: false },
          cost: { unit: 'image', amount: 0.12, centsPerBillableUnit: 100 },
          verifiedOn: null,
        },
      ]),
    )
    seedRun(db, { id: 'run-2', modelId: 'gpt-image-2', costCents: 1 })

    await syncCosts(db, async () => 0.1463)

    expect(db.select().from(nodeRuns).where(eq(nodeRuns.id, 'run-2')).get()?.costCents).toBe(15)
  })

  test('leaves a run alone when fal has no units for it', async () => {
    const { db } = tempDb()
    seedRun(db, { id: 'run-3' })

    const report = await syncCosts(db, async () => undefined)

    expect(report.skipped).toHaveLength(1)
    expect(db.select().from(nodeRuns).where(eq(nodeRuns.id, 'run-3')).get()?.costCents).toBe(4)
  })

  test('one unreachable record does not abandon the rest of the ledger', async () => {
    const { db } = tempDb()
    seedRun(db, { id: 'run-4' })
    seedRun(db, { id: 'run-5' })

    const report = await syncCosts(db, async (requestId) => {
      if (requestId.endsWith('boom')) throw new Error('fal 500')
      return 2.5
    })

    expect(report.repriced).toHaveLength(2)
    expect(report.skipped).toHaveLength(0)
  })

  test('never touches a queued or failed run', async () => {
    const { db } = tempDb()
    seedRun(db, { id: 'run-6', status: 'failed', costCents: 0 })

    const report = await syncCosts(db, async () => 2.5)

    expect(report.repriced).toHaveLength(0)
    expect(db.select().from(nodeRuns).where(eq(nodeRuns.id, 'run-6')).get()?.costCents).toBe(0)
  })
})
