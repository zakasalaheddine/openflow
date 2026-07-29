import type { FlowNode, AssetRef } from '../core/types'
import type { ModelSpec } from './registry'

/**
 * Turns a node plus its anchors and upstream frames into a fal payload.
 *
 * Kept beside the adapter rather than in /core because the field names belong
 * to fal, not to the domain. When an endpoint's reference-image field turns out
 * to be called something else, this file changes and nothing else does.
 *
 * ponytail: field names (`image_urls`, `image_url`, `duration`) are taken from
 * fal's published schemas and are unverified until a live call — the same
 * caveat `verifiedOn: null` carries on every registry row. Correct them here,
 * per endpoint, when Phase 0 records real responses.
 */
export type BuildContext = {
  /** Resolved reference images for every anchor attached to the node. */
  anchorRefs: string[]
  /** Outputs of upstream nodes, by edge role. */
  startFrame?: AssetRef
  endFrame?: AssetRef
}

export function buildModelInput(
  node: FlowNode,
  model: ModelSpec,
  context: BuildContext,
): Record<string, unknown> {
  switch (node.type) {
    case 'image': {
      return {
        prompt: node.prompt,
        ...(node.seed === undefined ? {} : { seed: node.seed }),
        // Only sent to a model that can honour them. planRun already refuses
        // the combination, so reaching here with refs the model ignores would
        // mean the gate was bypassed.
        ...(context.anchorRefs.length > 0 && model.caps.refImages > 0
          ? { image_urls: context.anchorRefs }
          : {}),
      }
    }
    case 'video': {
      return {
        prompt: node.prompt,
        duration: node.durationSec,
        ...(node.seed === undefined ? {} : { seed: node.seed }),
        ...(model.caps.nativeAudio ? { audio: node.audio } : {}),
        ...(context.startFrame ? { image_url: context.startFrame.path } : {}),
        ...(context.endFrame ? { end_image_url: context.endFrame.path } : {}),
        ...(context.anchorRefs.length > 0 && model.caps.refImages > 0
          ? { image_urls: context.anchorRefs }
          : {}),
      }
    }
    default:
      // source and export nodes never dispatch; planRun does not plan them.
      throw new Error(`Node type '${node.type}' does not dispatch to a model.`)
  }
}
