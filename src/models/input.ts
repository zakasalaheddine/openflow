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
  /** Files from every image/video source wired in as a reference. */
  anchorRefs: string[]
  /** The composed prompt: wired-in text fragments, then the node's own. */
  prompt?: string
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
        prompt: context.prompt ?? node.prompt,
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
      // kling calls frame zero `start_image_url`; hailuo and veo call it
      // `image_url`. Both fal schemas confirm it, and the distinction is not
      // cosmetic: an unknown key is dropped without complaint, so the wrong name
      // buys a full clip that never saw its start frame.
      const startField = model.id === 'kling-3-pro' ? 'start_image_url' : 'image_url'

      return {
        prompt: context.prompt ?? node.prompt,
        duration: node.durationSec,
        ...(node.seed === undefined ? {} : { seed: node.seed }),
        // `generate_audio`, per veo3.1's and kling's schemas. `audio` is not a
        // field either endpoint has, and would have been silently ignored.
        ...(model.caps.nativeAudio ? { generate_audio: node.audio } : {}),
        ...(context.startFrame ? { [startField]: context.startFrame.path } : {}),
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
