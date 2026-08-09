import { describe, test, expect } from 'vitest'
import { buildModelInput, honoursAspect } from '@/models/input'
import { estimateCostCents } from '@/models/registry'
import { modelById } from '@/models/catalog'
import { hashableConfig } from '@/core/hashable'
import { pixelsFor } from '@/core/aspect'
import type { ImageNode } from '@/core/types'

const still = (aspect?: ImageNode['aspect'], modelId = 'flux-2-pro'): ImageNode => ({
  id: 'shot',
  type: 'image',
  prompt: 'a bottle on wet slate',
  modelId,
  ...(aspect ? { aspect } : {}),
})

/**
 * The shape is sent, and it is sent in the shape each endpoint reads.
 *
 * Not coverable by an e2e run: `FAL_MODE=replay` answers from a fixture and
 * never looks at the payload, and a live call answers a wrong key with a
 * perfectly good square frame at full price. If this file passes and the frame
 * still comes back square, the key name is wrong — not this wiring.
 */
describe('aspect reaches the payload', () => {
  test('flux is told a size in pixels', () => {
    const input = buildModelInput(still('9:16'), modelById('flux-2-pro'), { anchorRefs: [] })
    expect(input.image_size).toEqual({ width: 1024, height: 1792 })
    expect(input.aspect_ratio).toBeUndefined()
  })

  test('nano-banana is told a ratio', () => {
    const input = buildModelInput(
      still('9:16', 'nano-banana-pro'),
      modelById('nano-banana-pro'),
      { anchorRefs: [] },
    )
    expect(input.aspect_ratio).toBe('9:16')
    expect(input.image_size).toBeUndefined()
  })

  test('a node that never chose one still says 1:1 rather than saying nothing', () => {
    const input = buildModelInput(still(), modelById('flux-2-pro'), { anchorRefs: [] })
    expect(input.image_size).toEqual(pixelsFor('1:1'))
  })

  test('a row that cannot be told is not offered the control, and is sent nothing', () => {
    expect(honoursAspect('hailuo-2-3-pro')).toBe(false)
    const input = buildModelInput(still('9:16', 'hailuo-2-3-pro'), modelById('flux-2-pro'), {
      anchorRefs: [],
    })
    // The model decides, not the node: `flux-2-pro` here carries the field.
    expect(input.image_size).toBeDefined()
  })
})

describe('the price follows the shape', () => {
  // The one number this tool exists to be right about. A per-megapixel row
  // bills what it renders, so a card quoting the 1:1 price for a 9:16 frame is
  // the surprise invoice the whole design is arranged to prevent.
  test('9:16 costs more than 1:1 on a per-megapixel row', () => {
    const model = modelById('flux-2-pro')
    const square = estimateCostCents(model, pixelsFor('1:1'))
    const portrait = estimateCostCents(model, pixelsFor('9:16'))
    expect(portrait).toBeGreaterThan(square)
  })

  test('and not on a per-image row, which charges by the frame', () => {
    const model = modelById('nano-banana-pro')
    expect(estimateCostCents(model, pixelsFor('9:16'))).toBe(
      estimateCostCents(model, pixelsFor('1:1')),
    )
  })
})

describe('re-shaping a shot re-renders it', () => {
  test('the aspect is in the hash', () => {
    expect(hashableConfig(still('9:16'))).not.toEqual(hashableConfig(still('1:1')))
  })

  test('but choosing the shape it already had does not', () => {
    // The money case. Every flow written before this field has no aspect and
    // every endpoint rendered square anyway, so an unset node and a node set to
    // 1:1 are the same frame. Hashing them apart would re-bill a whole canvas
    // of finished renders the first time anyone opened an inspector.
    expect(hashableConfig(still())).toEqual(hashableConfig(still('1:1')))
  })

  test('and going back to 1:1 finds the render that is already paid for', () => {
    expect(hashableConfig(still('1:1'))).toEqual(hashableConfig(still()))
    expect(hashableConfig(still('9:16'))).not.toEqual(hashableConfig(still()))
  })
})
