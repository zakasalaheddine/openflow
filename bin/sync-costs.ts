#!/usr/bin/env tsx
/**
 * `npm run costs:sync` — re-price every finished render against fal's own meter.
 *
 * The worker does this for runs it completes. This is for the ones that finished
 * before it did: their `cost_cents` is a number derived from the file that came
 * back, which on a response carrying no dimensions was a whole megapixel guessed
 * at, and on a token-metered model was a per-image price somebody wrote down.
 *
 * Reads only fal's request records — it never re-renders anything, so it cannot
 * spend. Idempotent: asking twice writes the same numbers.
 *
 * Runs it cannot price are left exactly as they were and reported. That is a
 * fixture or stub run with no fal request behind it, or a request fal has no
 * billable units for.
 */
import { and, eq, isNotNull } from 'drizzle-orm'
import { openDb, type Db } from '../src/db'
import { nodeRuns } from '../src/db/schema'
import { byId } from '../src/models/catalog'
import { costCentsForUnits, isPriced } from '../src/models/registry'
import { fetchBillableUnits } from '../src/models/fal'
import { loadDotEnv, dataDir } from '../src/env'

export type SyncReport = {
  repriced: { runId: string; nodeId: string; modelId: string; from: number; to: number }[]
  unchanged: number
  skipped: { runId: string; reason: string }[]
}

export async function syncCosts(
  db: Db,
  lookup: (requestId: string) => Promise<number | undefined> = fetchBillableUnits,
): Promise<SyncReport> {
  const report: SyncReport = { repriced: [], unchanged: 0, skipped: [] }

  const runs = db
    .select()
    .from(nodeRuns)
    .where(and(eq(nodeRuns.status, 'succeeded'), isNotNull(nodeRuns.falRequestId)))
    .all()

  for (const run of runs) {
    const model = byId(run.modelId)
    if (!model || !isPriced(model)) {
      report.skipped.push({ runId: run.id, reason: `no priced catalog row for ${run.modelId}` })
      continue
    }

    let units: number | undefined
    try {
      units = await lookup(run.falRequestId!)
    } catch (error) {
      // One unreachable record must not abandon the rest of the ledger.
      report.skipped.push({
        runId: run.id,
        reason: error instanceof Error ? error.message : String(error),
      })
      continue
    }

    if (units === undefined) {
      report.skipped.push({ runId: run.id, reason: 'fal reports no billable units' })
      continue
    }

    // Same rounding the worker uses, so a synced row and a freshly written one
    // cannot disagree about the same render.
    const exact = costCentsForUnits(model, units)
    const costCents = exact > 0 ? Math.max(1, Math.round(exact)) : 0

    db.update(nodeRuns)
      .set({ costCents, billableUnits: units })
      .where(eq(nodeRuns.id, run.id))
      .run()

    if (costCents === run.costCents) report.unchanged++
    else
      report.repriced.push({
        runId: run.id,
        nodeId: run.nodeId,
        modelId: run.modelId,
        from: run.costCents,
        to: costCents,
      })
  }

  return report
}

const money = (cents: number) => `$${(cents / 100).toFixed(2)}`

if (process.argv[1]?.endsWith('sync-costs.ts')) {
  loadDotEnv()
  const db = openDb()
  console.log(`[openflow] syncing costs in ${dataDir()}`)

  const report = await syncCosts(db)
  for (const row of report.repriced) {
    console.log(
      `[openflow] ${row.nodeId} (${row.modelId}): ${money(row.from)} → ${money(row.to)}`,
    )
  }
  for (const row of report.skipped) {
    console.log(`[openflow] skipped ${row.runId.slice(0, 8)}: ${row.reason}`)
  }
  console.log(
    `[openflow] ${report.repriced.length} repriced · ${report.unchanged} already correct · ` +
      `${report.skipped.length} left alone`,
  )
}
