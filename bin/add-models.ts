#!/usr/bin/env tsx
/**
 * `npm run models:add` — put fal slugs in a file, get catalog rows.
 *
 * You write ids. Everything else is read off fal: the medium from its category,
 * the capabilities from its OpenAPI input schema, the price from the sentence
 * on its model page. Nothing about a model is typed twice, and nothing is
 * guessed — a model fal does not publish a readable price for is reported and
 * skipped rather than added at a price that would under-quote every Run.
 *
 * Both fal endpoints used here are undocumented and unversioned. When one
 * changes shape this file is where it shows, and the fallback is the same one
 * that has always existed: write the row into models.json by hand.
 */
import { existsSync, readFileSync, writeFileSync } from 'node:fs'
import path from 'node:path'
import { catalog, ensureModelsFile } from '../src/models/catalog'
import { buildRow, type Candidate, type FalIndexEntry, type FalInputSchema } from '../src/models/fal-catalog'
import { dataDir, loadDotEnv, modelsPath } from '../src/env'
import type { ModelSpec } from '../src/models/registry'

loadDotEnv()

const INDEX = 'https://fal.ai/api/models'
const OPENAPI = 'https://fal.ai/api/openapi/queue/openapi.json'

const listPath = () => process.argv[2] ?? path.join(dataDir(), 'models.txt')

const TEMPLATE = `# One fal model id per line. Blank lines and # comments are ignored.
#
# Run \`npm run models:add\` and each id below is looked up on fal: its medium,
# its capabilities and its price are read from what fal publishes, and a row is
# appended to models.json. Ids already in the catalog are skipped.
#
# Find ids at https://fal.ai/models — the id is the part after fal.ai/models/.
#
# fal-ai/bytedance/seedream/v4/text-to-image
# fal-ai/kling-video/v3/pro/image-to-video
`

async function findEntry(slug: string): Promise<FalIndexEntry | null> {
  const url = `${INDEX}?keywords=${encodeURIComponent(slug)}`
  const response = await fetch(url)
  if (!response.ok) throw new Error(`fal's model index answered ${response.status}`)
  const body = (await response.json()) as { items?: FalIndexEntry[] }

  // Exact id only. The search is fuzzy — asking for veo3.1 returns its fast and
  // lite siblings too — and adding a model you did not ask for is worse than
  // adding none: you would find out at the price.
  const wanted = [slug, slug.replace(/^fal-ai\//, ''), `fal-ai/${slug}`]
  return (body.items ?? []).find((item) => wanted.includes(item.id)) ?? null
}

async function findSchema(slug: string): Promise<FalInputSchema | null> {
  const response = await fetch(`${OPENAPI}?endpoint_id=${encodeURIComponent(slug)}`)
  if (!response.ok) return null
  const body = (await response.json()) as {
    components?: { schemas?: Record<string, { properties?: FalInputSchema }> }
  }
  const schemas = body.components?.schemas ?? {}
  const input = Object.keys(schemas).find((name) => name.endsWith('Input'))
  return input ? (schemas[input].properties ?? {}) : null
}

/**
 * fal splits reference images onto a separate endpoint on some models: the
 * plain one has no `image_urls` field at all and `/edit` requires it. Looked up
 * only when the primary schema has nowhere to put a reference, because that is
 * the only case where the answer changes the row.
 */
async function findEditSibling(slug: string, schema: FalInputSchema) {
  if (Object.hasOwn(schema, 'image_urls')) return {}
  const base = slug.replace(/\/(text-to-image|image-to-image)$/, '')
  const editSlug = `${base}/edit`
  const editSchema = await findSchema(editSlug)
  return editSchema ? { editSlug, editSchema } : {}
}

function readList(file: string): string[] {
  if (!existsSync(file)) {
    writeFileSync(file, TEMPLATE)
    console.log(`[openflow] wrote ${file}. Put fal model ids in it, then run this again.`)
    return []
  }
  return readFileSync(file, 'utf8')
    .split('\n')
    .map((line) => line.replace(/#.*$/, '').trim())
    .filter(Boolean)
}

export async function addModels(file: string) {
  ensureModelsFile()
  const existing = catalog()
  const wanted = readList(file)

  const added: ModelSpec[] = []
  const skipped: string[] = []
  const assumed: string[] = []

  for (const slug of wanted) {
    // Two ways to already have it: the same endpoint under any name, or the
    // same name over any endpoint. Both are duplicates — one would render twice
    // under two ids, the other would make a node id ambiguous.
    const byEndpoint = [...existing, ...added].find(
      (row) => row.falEndpoint === slug || row.editEndpoint === slug,
    )
    if (byEndpoint) {
      skipped.push(`= ${slug} — already in the catalog as '${byEndpoint.id}'`)
      continue
    }

    let candidate: Candidate
    try {
      const entry = await findEntry(slug)
      if (!entry) {
        skipped.push(`! ${slug} — fal has no model with that id`)
        continue
      }
      const schema = await findSchema(entry.id)
      if (!schema) {
        skipped.push(`! ${slug} — fal publishes no input schema for it`)
        continue
      }
      candidate = { slug: entry.id, entry, schema, ...(await findEditSibling(entry.id, schema)) }
    } catch (error) {
      skipped.push(`! ${slug} — ${error instanceof Error ? error.message : String(error)}`)
      continue
    }

    const built = buildRow(candidate)
    if (!built.ok) {
      skipped.push(`! ${built.slug} — ${built.reason}`)
      continue
    }

    const clash = [...existing, ...added].find((row) => row.id === built.row.id)
    if (clash) {
      skipped.push(`= ${slug} — the name '${built.row.id}' is taken by ${clash.falEndpoint}`)
      continue
    }

    added.push(built.row)
    if (built.assumedRefLimit) assumed.push(built.row.id)
  }

  if (added.length > 0) {
    writeFileSync(modelsPath(), `${JSON.stringify([...existing, ...added], null, 2)}\n`)
  }

  return { added, skipped, assumed }
}

if (process.argv[1]?.endsWith('add-models.ts')) {
  const { added, skipped, assumed } = await addModels(listPath())

  for (const row of added) {
    const caps = [
      row.caps.refImages > 0 ? `${row.caps.refImages} ref` : null,
      row.caps.startEndFrame ? 'start frame' : null,
      row.caps.nativeAudio ? 'audio' : null,
      row.caps.maxDurationSec ? `${row.caps.maxDurationSec}s` : null,
    ]
      .filter(Boolean)
      .join(', ')
    const price =
      row.cost.amount === null
        ? 'UNPRICED — set cost.amount'
        : `$${(row.cost.amount / 100).toFixed(4)}/${row.cost.unit}`
    console.log(`+ ${row.id}  ${row.format}  ${price}${caps ? `  (${caps})` : ''}`)
  }
  for (const line of skipped) console.log(`  ${line}`)

  if (added.length > 0) {
    console.log(`\n[openflow] ${added.length} added to ${modelsPath()}.`)
    const unpriced = added.filter((row) => row.cost.amount === null)
    if (unpriced.length > 0) {
      console.log(
        `${unpriced.length} of them have no price: fal publishes none, so they are selectable and` +
          ' Run refuses them until you set cost.amount. ' +
          unpriced.map((row) => row.id).join(', '),
      )
    }
    if (assumed.length > 0) {
      console.log(
        `${assumed.length} accept references but fal declares no limit, so they were given 1:` +
          ` ${assumed.join(', ')}. Raise caps.refImages if the model takes more —` +
          ' the wiring gate enforces whatever is in the file.',
      )
    }
    // Said every time, because it is the one number nothing else can check: the
    // caps came from a schema, but the price came from a sentence, and fal's
    // sentences carry conditions a regex cannot ("4K is charged at double").
    console.log("Check each price against its `pricingNote` — that's the sentence it was read from.")
  } else {
    console.log('\n[openflow] nothing added.')
  }
}
