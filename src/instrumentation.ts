/**
 * Boots the in-process worker.
 *
 * "One process" is a constraint, not an accident — no Redis, no external queue.
 * Without this hook, pressing Run on the canvas enqueues rows that nothing ever
 * claims, and every node sits at `queued` forever.
 */
export async function register() {
  // Next runs instrumentation in the edge runtime too, where better-sqlite3
  // and the filesystem do not exist.
  if (process.env.NEXT_RUNTIME !== 'nodejs') return

  const { getDb } = await import('./db')
  const { startWorker } = await import('./worker/loop')
  const { createAdapter } = await import('./models/fal')
  const { falMode } = await import('./env')

  const mode = falMode()
  startWorker(getDb(), { adapter: createAdapter({ mode }) })
  console.log(`[openflow] worker started · FAL_MODE=${mode}`)
}
