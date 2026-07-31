import path from 'node:path'
import type { BetterSQLite3Database } from 'drizzle-orm/better-sqlite3'
import { readFlowFile, importFlowFile, drain } from './run-flow'
import { enqueueRun } from './executor'
import { createAdapter } from '../models/fal'
import { assetsDir, packageRoot } from '../env'
import { DEFAULT_FLOW_ID } from './workspace'

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Db = BetterSQLite3Database<any>

/**
 * Pre-bakes the demo flow so a visitor lands on a rendered canvas.
 *
 * Every node is served from a recorded fixture, so the whole thing costs zero
 * and opens no sockets. Nobody evaluates a creative tool from a README, and
 * nobody should pay per visitor for the privilege of being evaluated.
 *
 * Idempotent by construction: `importFlowFile` updates in place and every hash
 * is already satisfied on the second boot, so a restart re-renders nothing.
 */
export async function seedDemo(db: Db, options: { file?: string } = {}) {
  const spec = readFlowFile(options.file ?? path.join(packageRoot(), 'flows/demo.json'))

  // The canvas opens onto the default flow, so the demo has to *be* that flow
  // rather than a second one nobody navigates to.
  const { flowId } = importFlowFile(db, spec, DEFAULT_FLOW_ID.replace(/^flow:/, ''))

  const adapter = createAdapter({
    mode: 'replay',
    fixtureDir: path.join(packageRoot(), 'test/fixtures/fal'),
  })

  const { enqueued } = enqueueRun(db, flowId, { confirmOverspend: true })
  if (enqueued.length > 0) {
    await drain(db, flowId, { adapter, storeRoot: assetsDir() })
  }
  return { flowId, rendered: enqueued.length }
}
