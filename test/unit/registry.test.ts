import { describe, test, expect } from 'vitest'
import {
  REGISTRY,
  resolveModel,
  assertAnchorsSupported,
  assertStartFrameSupported,
  estimateCostCents,
  UnsupportedCapabilityError,
  type ModelSpec,
} from '@/models/registry'

const spec = (over: Partial<ModelSpec> = {}): ModelSpec => ({
  id: 'test/model',
  format: 'image',
  role: 'draft',
  falEndpoint: 'fal-ai/test',
  caps: { refImages: 4, textRendering: false, startEndFrame: false, nativeAudio: false },
  cost: { unit: 'image', amount: 3 },
  verifiedOn: null,
  ...over,
})

describe('REGISTRY', () => {
  test('ships a draft, hero and specialist image row', () => {
    const roles = REGISTRY.filter((m) => m.format === 'image').map((m) => m.role)
    expect(new Set(roles)).toEqual(new Set(['draft', 'hero', 'specialist']))
  })

  test('has no duplicate ids', () => {
    expect(new Set(REGISTRY.map((m) => m.id)).size).toBe(REGISTRY.length)
  })

  test('has at most one row per format and role', () => {
    const keys = REGISTRY.map((m) => `${m.format}:${m.role}`)
    expect(new Set(keys).size).toBe(keys.length)
  })

  test('stamps verifiedOn with a real past date, or leaves it null', () => {
    // Stamping a date on a row nobody has called is a lie that survives until a
    // broken endpoint costs a video run to discover — which is exactly how
    // `fal-ai/flux-2/pro` shipped dead. A row may only carry a date once someone
    // has actually rendered through it, so the date must at least be one that
    // has happened.
    const today = new Date().toISOString().slice(0, 10)
    for (const model of REGISTRY) {
      if (model.verifiedOn === null) continue
      expect(model.verifiedOn).toMatch(/^\d{4}-\d{2}-\d{2}$/)
      expect(model.verifiedOn <= today).toBe(true)
    }
  })

  test('every endpoint is a fal owner/app path, and edit variants extend their own', () => {
    // Cheap standing guard on the shape. It cannot prove an endpoint exists —
    // only a live call does that — but a typo'd slug that drops the owner is
    // caught here rather than by a 404 someone pays to see.
    for (const model of REGISTRY) {
      expect(model.falEndpoint).toMatch(/^[a-z0-9-]+\/[a-z0-9.\-/]+$/)
      if (model.editEndpoint) {
        expect(model.editEndpoint.startsWith(`${model.falEndpoint}/`)).toBe(true)
      }
    }
  })
})

describe('resolveModel', () => {
  test('selects by format and role', () => {
    const model = resolveModel('image', 'draft')
    expect(model.format).toBe('image')
    expect(model.role).toBe('draft')
  })

  test('the draft and hero rows for a format are different models', () => {
    // The graph-level Draft/Hero toggle is worth more than fifty dropdowns
    // only if it actually changes what runs.
    expect(resolveModel('image', 'draft').id).not.toBe(resolveModel('image', 'hero').id)
  })

  test('throws for a role that has no row', () => {
    // `text` specialist is deliberately empty — do not fill it for symmetry.
    expect(() => resolveModel('text', 'specialist')).toThrow()
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
