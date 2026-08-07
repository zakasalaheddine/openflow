export type ModelFormat = 'text' | 'image' | 'video'

export type ModelSpec = {
  id: string
  format: ModelFormat
  /** The row a fresh node of this format gets. First row of the format wins if nobody claims it. */
  default?: boolean
  falEndpoint: string
  /**
   * Where the same model accepts reference images, when that is a different
   * endpoint. fal splits these: `fal-ai/flux-2-pro` has no `image_urls` field at
   * all, and `fal-ai/flux-2-pro/edit` requires one. Without the split a wired-in
   * product photo passes the capability gate and is then dropped on the floor by
   * an endpoint that has nowhere to put it.
   */
  editEndpoint?: string
  caps: {
    /** 0 = cannot honour anchors at all. */
    refImages: number
    textRendering: boolean
    startEndFrame: boolean
    nativeAudio: boolean
    maxDurationSec?: number
  }
  /**
   * `amount` is null when nobody has priced it yet — fal publishes no price for
   * roughly half its catalogue, and `npm run models:add` adds those rows rather
   * than dropping them. An unpriced row is selectable and unrunnable: Run
   * refuses it by name, because a render whose cost the ledger cannot see is a
   * spend cap that cannot do its job.
   */
  cost: {
    unit: 'image' | 'megapixel' | 'second'
    amount: number | null
    /**
     * Cents per unit on *fal's* meter, when that is not `amount`.
     *
     * fal reports what it billed as a count of its own units, and for every row
     * it publishes a price for that count is in this row's unit — so `amount`
     * prices it and this field stays absent. It exists for the rows fal meters
     * per token, where `unit`/`amount` is a per-image figure someone wrote down
     * and fal's count is in something else entirely.
     *
     * `gpt-image-2` carries `100` — its counts come back as fractions (0.1463
     * for a render, 0.1933 for an edit), which is fal reporting dollars for a
     * model it has no unit price for. UNVERIFIED against an invoice: check one
     * request on fal's billing page and correct the number if it disagrees.
     */
    centsPerBillableUnit?: number
  }
  /**
   * The sentence fal published the price in, kept verbatim for rows added by
   * `npm run models:add`. The number above was read out of it by a regex, and
   * fal's pricing prose carries conditions a regex cannot ("4K outputs are
   * charged at double"), so this is what you check the number against.
   */
  pricingNote?: string
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
 * Extends UnsupportedCapabilityError so the run route's existing 400 covers it.
 * A graph naming a model the catalog no longer has is the same class of problem
 * as a graph asking a model for something it cannot do: refusable, explainable,
 * and never something to discover after fal has been paid.
 */
/** Selectable, and refused at Run until someone writes the number down. */
export class UnpricedModelError extends UnsupportedCapabilityError {
  constructor(id: string) {
    super(
      `${id} has no price. fal did not publish one — set its cost.amount in models.json before running it.`,
    )
    this.name = 'UnpricedModelError'
  }
}

export class UnknownModelError extends UnsupportedCapabilityError {
  constructor(id: string) {
    super(`No model '${id}' in the catalog. Add it to models.json or pick another on the node.`)
    this.name = 'UnknownModelError'
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
 * Every endpoint slug below has been resolved against fal's live queue and its
 * field names read off fal's published schema. Two were wrong when checked:
 * `fal-ai/flux-2/pro` and `fal-ai/minimax/hailuo-02-3/pro/image-to-video` both
 * answered `Path … not found`, which is precisely what `verifiedOn: null` was
 * there to warn about.
 *
 * ponytail: resolving is not rendering. Only `flux-2-pro` has completed a real
 * render end to end; the rest are known to exist and to accept the fields we
 * send, not known to come back with a file. Prices remain public-page estimates
 * on every row — fal returns no price with a result.
 */
export const SEED: ModelSpec[] = [
  {
    id: 'flux-2-pro',
    format: 'image',
    default: true,
    falEndpoint: 'fal-ai/flux-2-pro',
    editEndpoint: 'fal-ai/flux-2-pro/edit',
    caps: { refImages: 4, textRendering: false, startEndFrame: false, nativeAudio: false },
    cost: { unit: 'megapixel', amount: 3 },
    // One live render, 2026-07-31: submitted, polled, downloaded, on disk.
    // The endpoint and the queue round-trip are proven. `cost.amount` is not —
    // fal returns no price with a result, so it is still a public-page estimate.
    verifiedOn: '2026-07-31',
  },
  {
    id: 'nano-banana-pro',
    format: 'image',
    falEndpoint: 'fal-ai/nano-banana-pro',
    editEndpoint: 'fal-ai/nano-banana-pro/edit',
    caps: { refImages: 6, textRendering: true, startEndFrame: false, nativeAudio: false },
    cost: { unit: 'image', amount: 15 },
    verifiedOn: null,
  },
  {
    id: 'recraft-v3',
    format: 'image',
    // Ad creatives carry burned-in headlines and the general canvases render
    // text badly. That is the entire reason this row exists.
    falEndpoint: 'fal-ai/recraft/v3/text-to-image',
    caps: { refImages: 0, textRendering: true, startEndFrame: false, nativeAudio: false },
    cost: { unit: 'image', amount: 4 },
    verifiedOn: null,
  },

  // Video rows land in Phase 2 rather than Phase 3 because the canvas needs
  // them before any clip is ever rendered: wiring gates on caps.startEndFrame,
  // and the priced toolbar count needs cost.unit 'second' to say what a branch
  // of clips would cost. Phase 3 adds the execution path, not these rows.
  //
  // The video landscape is unstable; confirm availability before wiring. Every
  // row here is verifiedOn: null for exactly that reason.
  {
    id: 'hailuo-2-3-pro',
    format: 'video',
    default: true,
    falEndpoint: 'fal-ai/minimax/hailuo-02/pro/image-to-video',
    caps: {
      refImages: 0,
      textRendering: false,
      startEndFrame: true,
      nativeAudio: false,
      maxDurationSec: 10,
    },
    cost: { unit: 'second', amount: 10 },
    verifiedOn: null,
  },
  {
    id: 'veo-3-1',
    format: 'video',
    falEndpoint: 'fal-ai/veo3.1/image-to-video',
    caps: {
      refImages: 0,
      textRendering: false,
      startEndFrame: true,
      nativeAudio: true,
      maxDurationSec: 8,
    },
    cost: { unit: 'second', amount: 40 },
    verifiedOn: null,
  },
  {
    id: 'kling-3-pro',
    format: 'video',
    // The specialist slot goes to whichever model exposes start AND end frame
    // control — that capability is what end-frame anchoring depends on if
    // Phase 0 finds identity drifts across a clip.
    falEndpoint: 'fal-ai/kling-video/v3/pro/image-to-video',
    caps: {
      refImages: 0,
      textRendering: false,
      startEndFrame: true,
      nativeAudio: false,
      maxDurationSec: 10,
    },
    cost: { unit: 'second', amount: 19 },
    verifiedOn: null,
  },
]

/**
 * The endpoint that can actually accept this payload.
 *
 * Reference images are a different endpoint on the same model, not a different
 * model — the row, the price and the id all stay put, only the URL moves. An
 * unknown key is dropped without complaint, so sending `image_urls` to the plain
 * endpoint is a full-price render that silently ignored the product photo.
 */
export const endpointFor = (model: ModelSpec, hasReferences: boolean) =>
  hasReferences && model.editEndpoint ? model.editEndpoint : model.falEndpoint

/**
 * Refuse rather than silently drop. An ignored anchor produces off-brand output
 * that reads as a model quality problem, and the user never learns why.
 */
export function assertAnchorsSupported(
  // Only the id and the caps are read, so a trimmed row from the flow route
  // satisfies this as well as a full catalog row does.
  model: Pick<ModelSpec, 'id' | 'caps'>,
  anchorIds: readonly string[],
) {
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
export function assertStartFrameSupported(model: Pick<ModelSpec, 'id' | 'caps'>) {
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
  const { unit } = model.cost
  const images = quantity.images ?? 1
  let units: number
  switch (unit) {
    case 'image':
      units = images
      break
    case 'megapixel':
      // Times the image count, not instead of it. Four 1024×1024 frames are four
      // megapixels of billable output, and dropping the count here priced a
      // whole batch as one frame — on `flux-2-pro`, which is the default row.
      units =
        images *
        (quantity.width && quantity.height ? (quantity.width * quantity.height) / 1_000_000 : 1)
      break
    case 'second':
      units = quantity.durationSec ?? 1
      break
  }
  // Clamped: a negative estimate from a bad row would let a run slip past the
  // spend cap by cancelling out a real cost.
  return Math.max(0, units * priceOf(model))
}

const priceOf = (model: ModelSpec) => {
  if (model.cost.amount === null) throw new UnpricedModelError(model.id)
  return model.cost.amount
}

/**
 * What fal's own meter reading costs.
 *
 * Separate from the estimate because the two count different things: the
 * estimate counts units of `cost.unit` derived from the output, this counts
 * units of whatever fal billed in. They are the same unit on every row fal
 * priced itself, and `centsPerBillableUnit` is there for the rows where they
 * are not.
 */
export function costCentsForUnits(model: ModelSpec, units: number): number {
  return Math.max(0, units * (model.cost.centsPerBillableUnit ?? priceOf(model)))
}

/** A row nobody has put a number on yet. Selectable, never runnable. */
export const isPriced = (model: ModelSpec) => model.cost.amount !== null
