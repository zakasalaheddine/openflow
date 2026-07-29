import type { ModelRole } from '../core/types'

export type ModelFormat = 'text' | 'image' | 'video'

export type ModelSpec = {
  id: string
  format: ModelFormat
  role: ModelRole
  falEndpoint: string
  caps: {
    /** 0 = cannot honour anchors at all. */
    refImages: number
    textRendering: boolean
    startEndFrame: boolean
    nativeAudio: boolean
    maxDurationSec?: number
  }
  cost: { unit: 'image' | 'megapixel' | 'second'; amount: number }
  /** ISO date of the last live call that worked, or null if never called. */
  verifiedOn: string | null
}

export class UnsupportedCapabilityError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'UnsupportedCapabilityError'
  }
}

/**
 * A model is a config row, never a class. Adding one is a pull request that
 * touches this array and nothing else.
 *
 * `verifiedOn` stays null until someone makes a live call against the endpoint
 * and updates it. Prices below are from public pricing pages and are estimates
 * until then.
 *
 * ponytail: prices and endpoints unverified — Phase 0's spike is what stamps
 * `verifiedOn` and corrects `cost.amount` from real invoices.
 */
export const REGISTRY: ModelSpec[] = [
  {
    id: 'flux-2-pro',
    format: 'image',
    role: 'draft',
    falEndpoint: 'fal-ai/flux-2/pro',
    caps: { refImages: 4, textRendering: false, startEndFrame: false, nativeAudio: false },
    cost: { unit: 'megapixel', amount: 3 },
    verifiedOn: null,
  },
  {
    id: 'nano-banana-pro',
    format: 'image',
    role: 'hero',
    falEndpoint: 'fal-ai/nano-banana-pro',
    caps: { refImages: 6, textRendering: true, startEndFrame: false, nativeAudio: false },
    cost: { unit: 'image', amount: 15 },
    verifiedOn: null,
  },
  {
    id: 'recraft-v3',
    format: 'image',
    role: 'specialist',
    // Ad creatives carry burned-in headlines and the general canvases render
    // text badly. That is the entire reason this row exists.
    falEndpoint: 'fal-ai/recraft/v3/text-to-image',
    caps: { refImages: 0, textRendering: true, startEndFrame: false, nativeAudio: false },
    cost: { unit: 'image', amount: 4 },
    verifiedOn: null,
  },
]

export function resolveModel(format: ModelFormat, role: ModelRole): ModelSpec {
  const model = REGISTRY.find((m) => m.format === format && m.role === role)
  if (!model) {
    throw new Error(`No ${format} model registered for role '${role}'.`)
  }
  return model
}

export const byId = (id: string) => REGISTRY.find((m) => m.id === id)

/**
 * Refuse rather than silently drop. An ignored anchor produces off-brand output
 * that reads as a model quality problem, and the user never learns why.
 */
export function assertAnchorsSupported(model: ModelSpec, anchorIds: readonly string[]) {
  if (anchorIds.length === 0) return
  if (model.caps.refImages === 0) {
    throw new UnsupportedCapabilityError(
      `${model.id} cannot honour reference images, so it cannot use an anchor.`,
    )
  }
  if (anchorIds.length > model.caps.refImages) {
    throw new UnsupportedCapabilityError(
      `${model.id} accepts at most ${model.caps.refImages} reference images, got ${anchorIds.length}.`,
    )
  }
}

/** Gates image → video wiring at wiring time, not at render time. */
export function assertStartFrameSupported(model: ModelSpec) {
  if (!model.caps.startEndFrame) {
    throw new UnsupportedCapabilityError(
      `${model.id} cannot accept a start frame, so nothing may be wired upstream of it.`,
    )
  }
}

export type CostQuantity = {
  images?: number
  width?: number
  height?: number
  durationSec?: number
}

/** Gives the pre-run estimate, and therefore the spend cap, for free. */
export function estimateCostCents(model: ModelSpec, quantity: CostQuantity): number {
  const { unit, amount } = model.cost
  let units: number
  switch (unit) {
    case 'image':
      units = quantity.images ?? 1
      break
    case 'megapixel':
      units =
        quantity.width && quantity.height ? (quantity.width * quantity.height) / 1_000_000 : 1
      break
    case 'second':
      units = quantity.durationSec ?? 1
      break
  }
  // Clamped: a negative estimate from a bad row would let a run slip past the
  // spend cap by cancelling out a real cost.
  return Math.max(0, units * amount)
}
