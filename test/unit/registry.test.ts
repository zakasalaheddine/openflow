import { describe, test, expect } from 'vitest'
import { readFileSync, readdirSync } from 'node:fs'
import path from 'node:path'
import { SEED, assertAnchorsSupported, assertStartFrameSupported, estimateCostCents, UnsupportedCapabilityError, type ModelSpec } from '@/models/registry'
import { modelById } from '@/models/catalog'

const spec = (over: Partial<ModelSpec> = {}): ModelSpec => ({
  id: 'test/model',
  format: 'image',
  falEndpoint: 'fal-ai/test',
  caps: { refImages: 4, textRendering: false, startEndFrame: false, nativeAudio: false },
  cost: { unit: 'image', amount: 3 },
  verifiedOn: null,
  ...over,
})

describe('the shipped seed', () => {
  test('offers more than one model per format, or there is nothing to choose between', () => {
    for (const format of ['image', 'video'] as const) {
      expect(SEED.filter((m) => m.format === format).length).toBeGreaterThan(1)
    }
  })

  test('has no duplicate ids', () => {
    expect(new Set(SEED.map((m) => m.id)).size).toBe(SEED.length)
  })

  test('names exactly one default per format, so a fresh node is never ambiguous', () => {
    for (const format of ['image', 'video'] as const) {
      expect(SEED.filter((m) => m.format === format && m.default)).toHaveLength(1)
    }
  })

  test('stamps verifiedOn with a real past date, or leaves it null', () => {
    // Stamping a date on a row nobody has called is a lie that survives until a
    // broken endpoint costs a video run to discover — which is exactly how
    // `fal-ai/flux-2/pro` shipped dead. A row may only carry a date once someone
    // has actually rendered through it, so the date must at least be one that
    // has happened.
    const today = new Date().toISOString().slice(0, 10)
    for (const model of SEED) {
      if (model.verifiedOn === null) continue
      expect(model.verifiedOn).toMatch(/^\d{4}-\d{2}-\d{2}$/)
      expect(model.verifiedOn <= today).toBe(true)
    }
  })

  test('every endpoint is a fal owner/app path, and edit variants extend their own', () => {
    // Cheap standing guard on the shape. It cannot prove an endpoint exists —
    // only a live call does that — but a typo'd slug that drops the owner is
    // caught here rather than by a 404 someone pays to see.
    for (const model of SEED) {
      expect(model.falEndpoint).toMatch(/^[a-z0-9-]+\/[a-z0-9.\-/]+$/)
      if (model.editEndpoint) {
        expect(model.editEndpoint.startsWith(`${model.falEndpoint}/`)).toBe(true)
      }
    }
  })
})

describe('modelById', () => {
  test('resolves the row a node names', () => {
    const model = modelById('flux-2-pro')
    expect(model.format).toBe('image')
    expect(model.falEndpoint).toBe('fal-ai/flux-2-pro')
  })

  test('two rows of the same format are two different models, or there is nothing to compare', () => {
    expect(modelById('flux-2-pro').id).not.toBe(modelById('nano-banana-pro').id)
  })
})

describe('assertAnchorsSupported', () => {
  test('refuses a model that cannot honour reference images', () => {
    // Silently dropping the anchor produces off-brand output that looks like a
    // model quality problem, and the user never learns the anchor was ignored.
    expect(() => assertAnchorsSupported(spec({ caps: { ...spec().caps, refImages: 0 } }), ['a']))
      .toThrow(UnsupportedCapabilityError)
  })

  test('refuses more anchors than the model accepts', () => {
    expect(() => assertAnchorsSupported(spec({ caps: { ...spec().caps, refImages: 2 } }), ['a', 'b', 'c']))
      .toThrow(UnsupportedCapabilityError)
  })

  test('allows anchors within the limit', () => {
    expect(() => assertAnchorsSupported(spec(), ['a', 'b'])).not.toThrow()
  })

  test('allows zero anchors on a model that cannot honour them', () => {
    expect(() => assertAnchorsSupported(spec({ caps: { ...spec().caps, refImages: 0 } }), []))
      .not.toThrow()
  })
})

describe('assertStartFrameSupported', () => {
  test('refuses a start_frame edge into a model without the capability', () => {
    // Refused at wiring time, not silently ignored at render time.
    expect(() => assertStartFrameSupported(spec({ format: 'video' }))).toThrow(UnsupportedCapabilityError)
  })

  test('allows it when the model supports it', () => {
    const capable = spec({ format: 'video', caps: { ...spec().caps, startEndFrame: true } })
    expect(() => assertStartFrameSupported(capable)).not.toThrow()
  })
})

describe('estimateCostCents', () => {
  test('prices per image', () => {
    expect(estimateCostCents(spec({ cost: { unit: 'image', amount: 3 } }), { images: 2 })).toBe(6)
  })

  test('prices per megapixel from output dimensions', () => {
    const model = spec({ cost: { unit: 'megapixel', amount: 3 } })
    // 1024x1024 ≈ 1.048 MP → 3.15 cents
    expect(estimateCostCents(model, { width: 1024, height: 1024 })).toBeCloseTo(3.15, 1)
  })

  test('prices every image in a batch, not just the first', () => {
    // A megapixel row that ignored the count priced four frames as one — and
    // flux-2-pro, the default image row, is priced per megapixel.
    const model = spec({ cost: { unit: 'megapixel', amount: 3 } })
    expect(estimateCostCents(model, { images: 4, width: 1024, height: 1024 })).toBeCloseTo(12.6, 1)
  })

  test('prices per second of video', () => {
    const model = spec({ format: 'video', cost: { unit: 'second', amount: 49 } })
    expect(estimateCostCents(model, { durationSec: 5 })).toBe(245)
  })

  test('defaults to a single unit when no quantity is given', () => {
    expect(estimateCostCents(spec({ cost: { unit: 'image', amount: 3 } }), {})).toBe(3)
  })

  test('never returns a negative estimate', () => {
    // A negative estimate would let a bad row slip a run past the spend cap.
    expect(estimateCostCents(spec(), { images: -5 })).toBeGreaterThanOrEqual(0)
  })
})

describe('the flows that ship', () => {
  // A template naming a model a fresh install does not have is a template that
  // cannot be applied — and the person who finds out is the one who clicked it.
  const shipped = [
    'flows/demo.json',
    ...readdirSync('flows/templates').map((name) => path.join('flows/templates', name)),
  ]

  test.each(shipped)('%s names only models the seed has', (file) => {
    const spec = JSON.parse(readFileSync(file, 'utf8'))
    const nodes = (spec.flow?.nodes ?? spec.nodes) as { modelId?: string }[]
    const named = nodes.map((n) => n.modelId).filter((id): id is string => Boolean(id))

    expect(named.length).toBeGreaterThan(0)
    for (const id of named) {
      expect(SEED.map((m) => m.id)).toContain(id)
    }
  })
})
