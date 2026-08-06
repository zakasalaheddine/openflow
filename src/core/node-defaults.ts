import type { AdFormat, FlowNode, ModelRole, NodeId, NodePosition, NodeType, TextOverlay } from './types'

/**
 * Everything a caller may set on a fresh node. `id` is the only required
 * field — the factory never invents one, and never invents a `position`
 * either, because the canvas (`freeSlot`) and the agent source both
 * differently.
 *
 * Deliberately one flat type rather than one per node type: nothing stops a
 * caller from passing `durationSec` to an image node, but nothing here would
 * read it either, and a union of four near-identical shapes bought no safety
 * worth the extra ceremony.
 */
export type NewNodeOverrides = {
  id: NodeId
  position?: NodePosition
  label?: string
  sourceId?: string
  prompt?: string
  modelRole?: ModelRole
  seed?: number
  durationSec?: number
  audio?: boolean
  formats?: AdFormat[]
  fps?: number
  codec?: string
  overlay?: TextOverlay
}

/**
 * The repo's one set of defaults for a brand-new node — draft role, seed 1, a
 * silent 5-second clip, no formats yet. Matches what the canvas toolbar has
 * always created.
 *
 * `seed` rides into `input_hash` as its own field (see hash.ts's `HashInput`,
 * populated from `node.seed` in executor.ts and models/input.ts — it is not
 * part of hashableConfig's whitelist), so this is the single function the
 * canvas and the chat agent both call to build a node. If they ever disagreed
 * here, identical work would hash differently between the two surfaces and
 * silently miss the render cache.
 */
export function newNode(type: NodeType, overrides: NewNodeOverrides): FlowNode {
  const { id, position, label } = overrides
  const base = { id, ...(position ? { position } : {}), ...(label ? { label } : {}) }

  switch (type) {
    case 'source':
      return { ...base, type, sourceId: overrides.sourceId ?? '' }
    case 'image':
      return {
        ...base,
        type,
        prompt: overrides.prompt ?? '',
        modelRole: overrides.modelRole ?? 'draft',
        seed: overrides.seed ?? 1,
      }
    case 'video':
      return {
        ...base,
        type,
        prompt: overrides.prompt ?? '',
        durationSec: overrides.durationSec ?? 5,
        audio: overrides.audio ?? false,
        modelRole: overrides.modelRole ?? 'draft',
        seed: overrides.seed ?? 1,
      }
    case 'export':
      return {
        ...base,
        type,
        formats: overrides.formats ?? [],
        ...(overrides.fps !== undefined ? { fps: overrides.fps } : {}),
        ...(overrides.codec !== undefined ? { codec: overrides.codec } : {}),
        ...(overrides.overlay !== undefined ? { overlay: overrides.overlay } : {}),
      }
  }
}
