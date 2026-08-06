/**
 * Placement is framework-free and lives in /core now — `src/agent/ops.ts`
 * needs `freeSlot` too, and `src/agent/` may only import `/core`, `/models`
 * and `/db`. Re-exported here so `canvas.tsx`'s imports stay untouched.
 */
export * from '@/core/slots'
