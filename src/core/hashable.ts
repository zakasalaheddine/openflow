import type { FlowNode } from './types'
import { DEFAULT_ASPECT } from './aspect'
import type { JsonValue } from './hash'

/**
 * The fields of a node that actually change its output.
 *
 * A WHITELIST, deliberately. The obvious implementation is
 * `const { id, type, ...config } = node` — a blacklist — and it is a trap: the
 * canvas stores `position` on every node, so dragging a node two pixels would
 * change its input hash, grey out every descendant, and re-bill the subtree on
 * the next Run. At hero video prices that is the most expensive bug in the
 * codebase, and it arrives silently the day someone adds a UI-only field.
 *
 * Adding a field here is a deliberate act that says "this changes the pixels".
 */
export function hashableConfig(node: FlowNode): Record<string, JsonValue> {
  switch (node.type) {
    case 'source':
      // The id only. The row's `version` lives in the database, so planRun
      // folds it in — this function sees a node and nothing else, which is what
      // keeps it pure and testable without a database.
      return { sourceId: node.sourceId }
    case 'image':
      // The model is deliberately absent. inputHash folds `modelId` in as its
      // own field (executor.ts), so listing it here would hash the same fact
      // twice and make the two spellings of one change look like two changes.
      return {
        prompt: node.prompt,
        // Changes the pixels, so it changes the hash: a shot re-shaped from 1:1
        // to 9:16 is a different frame at a different price, and without this
        // it would read as already-rendered and never re-run.
        //
        // Omitted at the default rather than written as `'1:1'`, and the
        // difference is money. Every flow that predates this field has no
        // aspect, and every endpoint rendered square anyway — so an unset node
        // and a node someone set to 1:1 describe the same frame, and hashing
        // them apart would re-bill a whole canvas of finished renders the first
        // time anyone opened an inspector. Set it back to 1:1 after trying 9:16
        // and the original hash returns, with its render still in the cache.
        ...(node.aspect && node.aspect !== DEFAULT_ASPECT ? { aspect: node.aspect } : {}),
      }
    case 'video':
      return {
        prompt: node.prompt,
        durationSec: node.durationSec,
        audio: node.audio,
      }
    case 'sequence':
      // Empty on purpose: a cut has no settings, only an order, and the order
      // lives on the edges. `planRun` folds it in — the same shape as a source
      // node's `version`, which also lives outside the node.
      return {}
    case 'export':
      return {
        formats: node.formats as unknown as JsonValue,
        fps: node.fps,
        codec: node.codec,
        // Changes the exported pixels, so it changes the hash.
        overlay: (node.overlay ?? null) as unknown as JsonValue,
      }
  }
}
