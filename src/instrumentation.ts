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
  const { falMode, isDemo } = await import('./env')

  const mode = falMode()
  const db = getDb()

  if (isDemo()) {
    // Pre-baked before the worker starts, so the first visitor never sees a
    // half-rendered canvas. Every node comes from a recorded fixture: zero
    // spend, zero outbound calls.
    const { seedDemo } = await import('./core/demo')
    const { rendered } = await seedDemo(db)
    console.log(`[openflow] DEMO=1 · ${rendered} node(s) pre-baked · live runs refused`)
  }

  startWorker(db, { adapter: createAdapter({ mode }) })
  console.log(`[openflow] worker started · FAL_MODE=${mode}`)
}
