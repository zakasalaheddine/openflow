import type { ModelFormat, ModelSpec } from './registry'

/**
 * Reading fal's published metadata into catalog rows.
 *
 * Pure: every function here takes what fal returned and gives back what a row
 * needs. The fetching lives in `bin/add-models.ts`, so all of this is testable
 * without a network — which matters, because two of fal's endpoints are
 * undocumented and the parsing below is the part most likely to be wrong.
 */

/** What `GET https://fal.ai/api/models` returns per row, trimmed to what we read. */
export type FalIndexEntry = {
  id: string
  title?: string
  category?: string
  deprecated?: boolean
  pricingInfoOverride?: string | null
}

/** The input properties of an endpoint's OpenAPI schema. */
export type FalInputSchema = Record<
  string,
  { type?: string; enum?: (string | number)[]; maxItems?: number | null }
>

/**
 * fal names a task, we name a medium. `image-to-image` and `text-to-image` are
 * both an image node's business; anything that is not an image or a clip has no
 * node type to live on, so it is refused rather than added as something else.
 */
export function formatFor(category: string | undefined): ModelFormat | null {
  switch (category) {
    case 'text-to-image':
    case 'image-to-image':
      return 'image'
    case 'text-to-video':
    case 'image-to-video':
    case 'video-to-video':
      return 'video'
    default:
      return null
  }
}

/** Segments that qualify the thing before them rather than naming it. */
const QUALIFIER = /^(v?\d+([.\-]\d+)*|pro|max|ultra|master|turbo|fast|lite|mini|plus|standard|hd|preview|beta)$/i

const TASK = new Set([
  'text-to-image',
  'image-to-image',
  'image-to-video',
  'text-to-video',
  'video-to-video',
  'edit',
])

/**
 * `fal-ai/bytedance/seedream/v4/text-to-image` → `seedream-v4`.
 *
 * Right to left, taking qualifiers until the first segment that actually names
 * something, so a version or a tier never becomes the whole name: `v4` alone
 * would be meaningless and `master` would collide with every other master.
 * The owner and the task are dropped — both are in `falEndpoint`, which is what
 * actually gets called.
 */
export function shortIdFor(slug: string): string {
  const segments = slug.split('/').filter(Boolean)
  const withoutOwner = segments.length > 1 ? segments.slice(1) : segments
  const withoutTask = [...withoutOwner]
  while (withoutTask.length > 1 && TASK.has(withoutTask[withoutTask.length - 1])) {
    withoutTask.pop()
  }

  const parts: string[] = []
  for (let i = withoutTask.length - 1; i >= 0; i--) {
    parts.unshift(withoutTask[i])
    if (!QUALIFIER.test(withoutTask[i])) break
  }
  return parts.join('-')
}

/**
 * What the endpoint's own input schema says it can be asked for.
 *
 * Read off field names because that is what fal actually accepts — the same
 * fields models/input.ts sends. `textRendering` is not in any schema and is
 * left false: it is a judgement about output quality, not a field, and a row
 * that claimed it would send headline work to a model that smears them.
 */
export function capsFrom(schema: FalInputSchema): ModelSpec['caps'] {
  const has = (name: string) => Object.hasOwn(schema, name)

  const durations = (schema.duration?.enum ?? [])
    .map((value) => parseFloat(String(value)))
    .filter((n) => Number.isFinite(n))

  return {
    // maxItems when fal declares one, otherwise one. Conservative on purpose:
    // too high silently drops the anchors past the real limit at full price,
    // too low refuses a wire you can fix by raising the number in models.json.
    refImages: has('image_urls') ? (schema.image_urls?.maxItems ?? 1) : 0,
    textRendering: false,
    startEndFrame: has('image_url') || has('start_image_url'),
    nativeAudio: has('generate_audio') || has('audio'),
    ...(durations.length > 0 ? { maxDurationSec: Math.max(...durations) } : {}),
  }
}

const UNITS = { image: 'image', second: 'second', megapixel: 'megapixel' } as const

/**
 * fal publishes price as a sentence, and only for about half its catalogue.
 *
 * Deliberately strict. Seedream v5's sentence reads "every additional input
 * image will cost **$0.0045**" — a surcharge on inputs, not the price of an
 * output — and a loose "first dollar figure wins" parse would file that as the
 * render price and under-quote every Run by two orders of magnitude. A number
 * has to be tied to a unit, in one direction or the other, or this returns null
 * and the caller refuses the model rather than pricing it wrong.
 */
export function priceFrom(prose: string | null | undefined): ModelSpec['cost'] | null {
  if (!prose) return null
  const text = prose.replaceAll('*', '')

  const amountThenUnit = text.match(
    /\$\s*([\d.]+)\s*(?:per|\/|for each|each)\s+(image|second|megapixel|megapixels|mp)\b/i,
  )
  if (amountThenUnit) return centsFor(amountThenUnit[1], amountThenUnit[2])

  // "For every second of video you generated, you will be charged $0.084"
  const unitThenAmount = text.match(
    /(?:per|every|each)\s+(image|second|megapixel|megapixels|mp)\b[^.$]{0,120}?\$\s*([\d.]+)/i,
  )
  if (unitThenAmount) return centsFor(unitThenAmount[2], unitThenAmount[1])

  return null
}

function centsFor(amount: string, unit: string): ModelSpec['cost'] | null {
  const dollars = Number(amount)
  if (!Number.isFinite(dollars) || dollars <= 0) return null
  const key = unit.toLowerCase().replace(/s$/, '').replace(/^mp$/, 'megapixel')
  const resolved = UNITS[key as keyof typeof UNITS]
  if (!resolved) return null
  // Cents, like every other price in the ledger. Kept fractional rather than
  // rounded: $0.0045 an image is not zero, and rounding it to zero is how a
  // model becomes free in the estimate and expensive on the invoice.
  return { unit: resolved, amount: dollars * 100 }
}

export type Candidate = {
  slug: string
  entry: FalIndexEntry
  schema: FalInputSchema
  /** The `/edit` sibling's schema, when fal splits reference images onto one. */
  editSlug?: string
  editSchema?: FalInputSchema
}

export type Built =
  | { ok: true; row: ModelSpec; assumedRefLimit: boolean }
  | { ok: false; slug: string; reason: string }

/** True when fal declared `image_urls` but no `maxItems`, so the 1 is ours. */
const declaresRefLimit = (schema: FalInputSchema | undefined) =>
  typeof schema?.image_urls?.maxItems === 'number'

/**
 * A catalog row from what fal published, or a refusal naming what was missing.
 *
 * Refused only for things no number can fix: a deprecated model, or one whose
 * medium has no node to live on. A missing price is not one of those — it comes
 * back as `cost.amount: null`, because a row you can see and price is more use
 * than a slug that silently never arrived. What never happens is a row priced
 * at zero: that quotes nothing before a Run and the spend cap cannot see it,
 * which turns a $2 confirmation into whatever the model actually costs.
 */
export function buildRow(candidate: Candidate): Built {
  const { slug, entry } = candidate

  if (entry.deprecated) {
    return { ok: false, slug, reason: 'fal lists it as deprecated' }
  }

  const format = formatFor(entry.category)
  if (!format) {
    return {
      ok: false,
      slug,
      reason: `category '${entry.category ?? 'unknown'}' is neither an image nor a video model`,
    }
  }

  // Unpriced rather than refused. fal publishes no readable price for roughly
  // half its catalogue, and dropping those would mean "add the models you want"
  // quietly meant "add the ones fal wrote a sentence about". The row lands with
  // `amount: null`, which is selectable and unrunnable — Run names it and stops
  // rather than dispatching something the spend cap cannot see.
  const cost = priceFrom(entry.pricingInfoOverride) ?? {
    unit: format === 'video' ? ('second' as const) : ('image' as const),
    amount: null,
  }

  const caps = capsFrom(candidate.schema)
  const editCaps = candidate.editSchema ? capsFrom(candidate.editSchema) : null

  const refSchema = candidate.editSchema ?? candidate.schema
  return {
    ok: true,
    // Surfaced by the caller, because the wiring gate enforces this number: a
    // second reference refused against an assumed 1 reads as the model's limit
    // rather than as a line you can raise in models.json.
    assumedRefLimit: Object.hasOwn(refSchema, 'image_urls') && !declaresRefLimit(refSchema),
    row: {
      id: shortIdFor(slug),
      format,
      falEndpoint: slug,
      ...(candidate.editSlug ? { editEndpoint: candidate.editSlug } : {}),
      caps: {
        ...caps,
        // The reference limit belongs to whichever endpoint accepts references.
        refImages: Math.max(caps.refImages, editCaps?.refImages ?? 0),
      },
      cost,
      /** The unit is a guess when the price is null — correct both together. */
      // Read off a schema and a sentence, not off a render. The same warning
      // every hand-written row carries, for the same reason.
      verifiedOn: null,
      pricingNote: entry.pricingInfoOverride?.replaceAll('*', '').trim() ?? undefined,
    },
  }
}
