import { desc, eq } from 'drizzle-orm'
import type { BetterSQLite3Database } from 'drizzle-orm/better-sqlite3'
import { nodeRuns } from '../db/schema'
import type { NodeId } from './types'

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Db = BetterSQLite3Database<any>

/**
 * The `modelId` a locally-cut film is recorded under.
 *
 * A sequence dispatches to no model, but `node_runs.model_id` is not nullable
 * and the ledger reads it. This value is what the worker branches on to run a
 * cut instead of calling fal, and the manifest has recorded it since before the
 * sequence was runnable.
 */
export const LOCAL_CUT = 'sequence'

/**
 * The run that produced the pixels the graph currently describes.
 *
 * Matched on `inputHash`, never just on node id. The manifest records the
 * prompt and asset versions from the *current* graph, so taking the newest
 * succeeded run regardless would attribute a prompt to output it never
 * produced — one prompt edit away, and provenance that lies is worse than none.
 */
export function currentRun(db: Db, flowId: string, nodeId: NodeId, inputHash: string | undefined) {
  if (!inputHash) return undefined
  return db
    .select()
    .from(nodeRuns)
    .where(eq(nodeRuns.flowId, flowId))
    .orderBy(desc(nodeRuns.createdAt))
    .all()
    .find((run) => run.nodeId === nodeId && run.status === 'succeeded' && run.inputHash === inputHash)
}
