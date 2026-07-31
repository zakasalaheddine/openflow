import type { FlowNode } from './types'
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
      return { assets: node.assets as unknown as JsonValue }
    case 'image':
      return {
        prompt: node.prompt,
        anchors: node.anchors,
        modelRole: node.modelRole,
      }
    case 'video':
      return {
        prompt: node.prompt,
        anchors: node.anchors,
        modelRole: node.modelRole,
        durationSec: node.durationSec,
        audio: node.audio,
      }
    case 'export':
      return {
        formats: node.formats as unknown as JsonValue,
        fps: node.fps,
        codec: node.codec,
      }
  }
}
