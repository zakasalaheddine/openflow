#!/usr/bin/env tsx
/**
 * Phase 0 validation spike. Throwaway — this file gets deleted, FINDINGS.md
 * survives. Deliberately untested: it would be testing fal's output quality,
 * which is what the human scoring pass is for.
 *
 *   FAL_KEY=... npx tsx spike/spike.ts
 *
 * Reads spike/products.json, generates 4 scenes × 3 seeds per product against
 * two image models, downloads everything to spike/out/, and writes a scoring
 * sheet you fill in by eye.
 *
 * Everything rests on this: if a product cannot stay recognisably itself
 * across generations, the product changes shape. See build-plan.md §2 for the
 * gate (>=70% ship, 40-70% reposition, <40% stop).
 */
import { mkdirSync, writeFileSync, existsSync, readFileSync } from 'node:fs'
import path from 'node:path'

type Product = {
  /** Short slug used for output filenames. */
  id: string
  /** 4 reference photos. Public URLs — fal has to fetch them. Not stock. */
  refImages: string[]
}

const SCENES = [
  'on a marble kitchen counter, soft morning window light, shallow depth of field',
  'on wet slate, hard directional light, deep shadows, moody',
  'held in a hand against a plain studio backdrop, even softbox lighting',
  'on crumpled linen beside dried flowers, diffuse overcast light, muted palette',
]

const SEEDS = [11, 22, 33]

/** Two models, one cheap and one flagship, so the spike prices the trade-off. */
const MODELS = [
  { id: 'flux-2-pro', endpoint: 'fal-ai/flux-2/pro', estimateUsd: 0.03 },
  { id: 'nano-banana-pro', endpoint: 'fal-ai/nano-banana-pro', estimateUsd: 0.15 },
]

const OUT = path.resolve('spike/out')
const PRODUCTS_FILE = path.resolve('spike/products.json')

const key = process.env.FAL_KEY
if (!key) {
  console.error('FAL_KEY is required. This spike spends real money on purpose.')
  process.exit(1)
}

if (!existsSync(PRODUCTS_FILE)) {
  console.error(
    `Missing ${PRODUCTS_FILE}. Create it with 3 real products, 4 reference photos each:\n` +
      JSON.stringify(
        [{ id: 'serum-bottle', refImages: ['https://…/front.jpg', 'https://…/angle.jpg'] }],
        null,
        2,
      ),
  )
  process.exit(1)
}

const products = JSON.parse(readFileSync(PRODUCTS_FILE, 'utf8')) as Product[]

async function fal(endpoint: string, input: Record<string, unknown>) {
  const submit = await fetch(`https://queue.fal.run/${endpoint}`, {
    method: 'POST',
    headers: { Authorization: `Key ${key}`, 'Content-Type': 'application/json' },
    body: JSON.stringify(input),
  })
  if (!submit.ok) throw new Error(`submit ${submit.status}: ${await submit.text()}`)
  const { request_id } = (await submit.json()) as { request_id: string }

  for (;;) {
    await new Promise((r) => setTimeout(r, 2500))
    const status = await fetch(`https://queue.fal.run/${endpoint}/requests/${request_id}/status`, {
      headers: { Authorization: `Key ${key}` },
    })
    const body = (await status.json()) as { status: string }
    if (body.status === 'COMPLETED') break
    if (body.status === 'FAILED') throw new Error(`fal FAILED for ${request_id}`)
  }

  const result = await fetch(`https://queue.fal.run/${endpoint}/requests/${request_id}`, {
    headers: { Authorization: `Key ${key}` },
  })
  return (await result.json()) as { images?: { url: string }[] }
}

mkdirSync(OUT, { recursive: true })

const rows: string[] = [
  '| file | product | model | scene | seed | same product? | label legible? | colours right? | client-acceptable? |',
  '|---|---|---|---|---|---|---|---|---|',
]
let spentUsd = 0

for (const product of products) {
  for (const model of MODELS) {
    for (const [sceneIndex, scene] of SCENES.entries()) {
      for (const seed of SEEDS) {
        const name = `${product.id}__${model.id}__s${sceneIndex}__${seed}.png`
        try {
          const result = await fal(model.endpoint, {
            prompt: `the product ${scene}`,
            image_urls: product.refImages,
            seed,
          })
          const url = result.images?.[0]?.url
          if (!url) throw new Error('no image in response')

          const bytes = Buffer.from(await (await fetch(url)).arrayBuffer())
          writeFileSync(path.join(OUT, name), bytes)
          spentUsd += model.estimateUsd

          // Raw responses are the highest-value thing to carry out of the
          // spike: they become the first real test/fixtures/fal entries, so
          // Phase 1's suite validates a proven response shape, not a guess.
          writeFileSync(path.join(OUT, `${name}.json`), JSON.stringify(result, null, 2))

          rows.push(`| ${name} | ${product.id} | ${model.id} | ${sceneIndex} | ${seed} | | | | |`)
          console.log(`[spike] ${name}`)
        } catch (error) {
          console.error(`[spike] FAILED ${name}: ${error instanceof Error ? error.message : error}`)
          rows.push(`| ${name} | ${product.id} | ${model.id} | ${sceneIndex} | ${seed} | ERROR | | | |`)
        }
      }
    }
  }
}

writeFileSync(
  path.join(OUT, 'scoring.md'),
  `# Spike scoring\n\nEstimated spend: $${spentUsd.toFixed(2)}\n\n` +
    `Fill in the four judgement columns by eye, then compute the pass rate for\n` +
    `"client-acceptable?" and write build-plan.md §2's gate decision into FINDINGS.md.\n\n` +
    rows.join('\n') +
    '\n',
)

console.log(`\n[spike] done · ~$${spentUsd.toFixed(2)} · score them in spike/out/scoring.md`)
console.log('[spike] motion test is manual: take a passing image, feed it as the')
console.log('        start frame to Veo 3.1 and Kling 3 Pro at 5s, and check identity survives.')
