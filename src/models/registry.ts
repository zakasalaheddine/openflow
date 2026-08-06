import { existsSync, readFileSync, statSync, writeFileSync, mkdirSync } from 'node:fs'
import path from 'node:path'
import { z } from 'zod'
import type { ModelRole } from '../core/types'
import { modelsPath } from '../env'

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
 * Extends UnsupportedCapabilityError so the run route's existing 400 covers it.
 * A graph naming a model the catalog no longer has is the same class of problem
 * as a graph asking a model for something it cannot do: refusable, explainable,
 * and never something to discover after fal has been paid.
 */
export class UnknownModelError extends UnsupportedCapabilityError {
  constructor(id: string) {
    super(`No model '${id}' in the catalog. Add it to models.json or pick another on the node.`)
    this.name = 'UnknownModelError'
  }
}

export class InvalidCatalogError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'InvalidCatalogError'
  }
}

const modelSpecSchema = z.object({
  id: z.string().min(1),
  format: z.enum(['text', 'image', 'video']),
  default: z.boolean().optional(),
  falEndpoint: z.string().min(1),
  editEndpoint: z.string().min(1).optional(),
  caps: z.object({
    refImages: z.number().int().min(0),
    textRendering: z.boolean(),
    startEndFrame: z.boolean(),
    nativeAudio: z.boolean(),
    maxDurationSec: z.number().positive().optional(),
  }),
  cost: z.object({
    unit: z.enum(['image', 'megapixel', 'second']),
    // Cents, and never negative: a negative row would let a run cancel out real
    // cost and slip past the spend cap.
    amount: z.number().min(0),
  }),
  verifiedOn: z.string().nullable(),
})

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
 * Keyed by path, not a single slot: a suite points OPENFLOW_DATA_DIR at a fresh
 * temp dir per file, and one shared slot would serve the previous file's rows.
 */
const cache = new Map<string, { mtimeMs: number; rows: ModelSpec[] }>()

/**
 * THE model list. A file on disk, falling back to what shipped.
 *
 * Reading never writes. A unit suite that does not set OPENFLOW_DATA_DIR would
 * otherwise seed a file into the developer's real ./data the first time any
 * test touched a model. `ensureModelsFile()` does the writing, once, at boot.
 *
 * Re-read when the file's mtime moves, so editing models.json is live on the
 * next canvas reload rather than on the next restart.
 */
export function catalog(): ModelSpec[] {
  const file = modelsPath()
  if (!existsSync(file)) return SEED

  const mtimeMs = statSync(file).mtimeMs
  const hit = cache.get(file)
  if (hit && hit.mtimeMs === mtimeMs) return hit.rows

  let parsed: unknown
  try {
    parsed = JSON.parse(readFileSync(file, 'utf8'))
  } catch (error) {
    throw new InvalidCatalogError(
      `${file} is not valid JSON: ${error instanceof Error ? error.message : String(error)}`,
    )
  }

  const result = z.array(modelSpecSchema).safeParse(parsed)
  if (!result.success) {
    // Named down to the field. A catalog that half-loads is a catalog that
    // renders against a model you believe you changed, so there is no partial
    // success and no fallback to the seed.
    const issue = result.error.issues[0]
    throw new InvalidCatalogError(`${file} is not a valid model catalog: ${issue.path.join('.')} — ${issue.message}`)
  }

  cache.set(file, { mtimeMs, rows: result.data })
  return result.data
}

/**
 * Writes the seed once, at boot, so there is a file to edit. Never overwrites:
 * the file is the user's, and the seed is only ever a starting point.
 */
export function ensureModelsFile() {
  const file = modelsPath()
  if (existsSync(file)) return
  mkdirSync(path.dirname(file), { recursive: true })
  writeFileSync(file, `${JSON.stringify(SEED, null, 2)}\n`)
}

/**
 * The authoring lookup: throws, because a graph naming a model nobody has is a
 * graph that must fail before it is priced, not after it is billed.
 */
export function modelById(id: string): ModelSpec {
  const model = catalog().find((m) => m.id === id)
  if (!model) throw new UnknownModelError(id)
  return model
}

/**
 * The historical lookup: returns undefined, because the worker resolves the
 * model of a run that already happened. Deleting a row from the catalog must
 * fail that one run with a sentence, not crash the loop that claims them all.
 */
export const byId = (id: string) => catalog().find((m) => m.id === id)

/** What a brand-new node of this format gets. */
export function defaultModelFor(format: ModelFormat): ModelSpec {
  const rows = catalog().filter((m) => m.format === format)
  const model = rows.find((m) => m.default) ?? rows[0]
  if (!model) throw new UnknownModelError(`<no ${format} model>`)
  return model
}

/**
 * ponytail: the role indirection, kept alive only so this commit compiles.
 * Task 2 of the plan replaces every caller with `node.modelId` and deletes it.
 */
const ROLE_TO_ID: Record<ModelFormat, Record<ModelRole, string>> = {
  image: { draft: 'flux-2-pro', hero: 'nano-banana-pro', specialist: 'recraft-v3' },
  video: { draft: 'hailuo-2-3-pro', hero: 'veo-3-1', specialist: 'kling-3-pro' },
  text: { draft: '', hero: '', specialist: '' },
}

export function resolveModel(format: ModelFormat, role: ModelRole): ModelSpec {
  const id = ROLE_TO_ID[format][role]
  if (!id) throw new Error(`No ${format} model registered for role '${role}'.`)
  return modelById(id)
}

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
