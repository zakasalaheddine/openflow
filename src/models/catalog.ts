import { existsSync, readFileSync, statSync, writeFileSync, mkdirSync } from 'node:fs'
import path from 'node:path'
import { z } from 'zod'
import { modelsPath } from '../env'
import { SEED, UnknownModelError, type ModelFormat, type ModelSpec } from './registry'

/**
 * The catalog, read off disk. Server-only — this module touches node:fs, and
 * registry.ts stays free of it so the canvas bundle can import the capability
 * rules without dragging the filesystem into the browser.
 */

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
    // cost and slip past the spend cap. Null means unpriced — see ModelSpec.
    amount: z.number().min(0).nullable(),
    centsPerBillableUnit: z.number().min(0).optional(),
  }),
  pricingNote: z.string().optional(),
  verifiedOn: z.string().nullable(),
})


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
