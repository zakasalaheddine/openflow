import type { FlowNode, AssetRef } from '../core/types'
import { DEFAULT_ASPECT, pixelsFor, type Aspect } from '../core/aspect'
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

/**
 * How each endpoint is told what shape to render.
 *
 * Two different shapes, not two spellings of one: flux takes `image_size` as a
 * pair of pixel counts, and nano-banana takes `aspect_ratio` as the ratio
 * written out. So this maps to a payload fragment rather than to a key name.
 *
 * The same failure mode as `start_image_url` below, and worse to spot: an
 * unknown key is dropped without complaint, so the wrong name buys a full
 * square frame at full price with nothing in the response saying why. Both key
 * names come from fal's published schemas and are unverified until a live call
 * — the caveat `verifiedOn: null` carries on every registry row.
 *
 * A row that is not in here renders at whatever the endpoint defaults to, and
 * the inspector does not offer the control for it (`honoursAspect`). Silently
 * accepting a choice that is then never sent is the one outcome worth ruling
 * out: it looks like it worked.
 *
 * **A row added by `npm run models:add` lands here with no entry**, because the
 * command derives capabilities from fal's OpenAPI schema and this map is a
 * hand-written record of field names nobody has confirmed. The new row renders
 * square and offers no control, which is safe and silent — add it here once you
 * know what its size field is called.
 */
const ASPECT_INPUT: Record<string, (aspect: Aspect) => Record<string, unknown>> = {
  'flux-2-pro': (aspect) => ({ image_size: pixelsFor(aspect) }),
  'recraft-v3': (aspect) => ({ image_size: pixelsFor(aspect) }),
  'nano-banana-pro': (aspect) => ({ aspect_ratio: aspect }),
  'gpt-image-2': (aspect) => ({ aspect_ratio: aspect }),
}

/** Whether this row can be asked for a shape at all. Read by the inspector. */
export const honoursAspect = (modelId: string) => modelId in ASPECT_INPUT

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
        // Sent whenever the row can carry it, including at 1:1 — leaving it off
        // for the default would make "square" mean two different things: the
        // shape someone chose, and the shape nobody asked about.
        ...(ASPECT_INPUT[model.id]?.(node.aspect ?? DEFAULT_ASPECT) ?? {}),
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
      // A source node is never planned at all — planRun's isRunnable check
      // excludes it, so no run ever reaches here for one. A sequence is
      // planned (see executor.ts), but dispatch branches on LOCAL_CUT before
      // it would ever call buildModelInput (worker/loop.ts's dispatch).
      throw new Error(`Node type '${node.type}' does not dispatch to a model.`)
  }
}
