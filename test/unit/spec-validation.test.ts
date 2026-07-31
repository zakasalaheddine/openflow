import { describe, test, expect } from 'vitest'
import { checkSpec, coverCrop, DEFAULT_TEXT_BOX } from '@/core/spec'
import type { AdFormat } from '@/core/types'

// Every case here is a client rejection this project is preventing. The value
// is not that the code runs; it is that the rejection arrives at export time
// rather than after the placement is booked.

const vertical: AdFormat = { name: '9:16', w: 1080, h: 1920 }

const source = { sourceWidth: 1080, sourceHeight: 1920 }

describe('safe zones', () => {
  test('text inside the safe zone passes', () => {
    const result = checkSpec({ format: vertical, ...source, textBox: DEFAULT_TEXT_BOX })
    expect(result.pass).toBe(true)
    expect(result.findings).toEqual([])
  })

  test('text overlapping the safe zone fails, and the failure names the zone', () => {
    // "Text overlaps the safe zone" sends someone hunting; naming the edge is
    // one drag to fix.
    const result = checkSpec({
      format: vertical,
      ...source,
      textBox: { x: 0.1, y: 0.02, w: 0.8, h: 0.15 },
    })
    expect(result.pass).toBe(false)
    expect(result.findings.map((f) => f.rule)).toContain('safe_zone')
    expect(result.findings[0].message).toMatch(/top/)
  })

  test('names every breached edge, not just the first', () => {
    const result = checkSpec({
      format: vertical,
      ...source,
      textBox: { x: 0.01, y: 0.85, w: 0.98, h: 0.14 },
    })
    const message = result.findings.find((f) => f.rule === 'safe_zone')!.message
    expect(message).toMatch(/left/)
    expect(message).toMatch(/right/)
    expect(message).toMatch(/bottom/)
  })

  test('a per-format safe zone overrides the default', () => {
    const permissive: AdFormat = { ...vertical, spec: { safeZone: { top: 0, right: 0, bottom: 0, left: 0 } } }
    const box = { x: 0, y: 0, w: 0.4, h: 0.4 }
    expect(checkSpec({ format: vertical, ...source, textBox: box }).pass).toBe(false)
    expect(checkSpec({ format: permissive, ...source, textBox: box }).pass).toBe(true)
  })
})

describe('resolution', () => {
  test('below minimum resolution fails', () => {
    const result = checkSpec({ format: vertical, sourceWidth: 540, sourceHeight: 960 })
    expect(result.pass).toBe(false)
    expect(result.findings[0].rule).toBe('min_resolution')
    expect(result.findings[0].message).toMatch(/540x960/)
  })

  test('a source exactly at the format size passes', () => {
    expect(checkSpec({ format: vertical, ...source }).pass).toBe(true)
  })
})

describe('duration', () => {
  test('duration outside the format limit fails', () => {
    const result = checkSpec({
      format: { ...vertical, spec: { maxDurationSec: 6 } },
      ...source,
      durationSec: 8,
    })
    expect(result.pass).toBe(false)
    expect(result.findings[0].rule).toBe('duration')
    expect(result.findings[0].message).toMatch(/6s/)
  })

  test('a still is not checked against a duration limit', () => {
    expect(checkSpec({ format: vertical, ...source }).findings).toEqual([])
  })
})

describe('text coverage', () => {
  test('coverage over the threshold fails', () => {
    const result = checkSpec({
      format: vertical,
      ...source,
      textBox: { x: 0.1, y: 0.3, w: 0.8, h: 0.4 },
    })
    expect(result.findings.map((f) => f.rule)).toContain('text_coverage')
  })

  test('coverage is not checked when this project placed no text', () => {
    // Text a model burned into its own output is invisible here. Reporting a
    // pass on a box that does not exist would be a claim we cannot back.
    expect(checkSpec({ format: vertical, ...source }).findings).toEqual([])
  })
})

describe('the record', () => {
  test('a check produces a result on pass and on failure alike', () => {
    // A record that only exists when the check passed cannot distinguish
    // "checked and fine" from "never checked".
    for (const box of [DEFAULT_TEXT_BOX, { x: 0, y: 0, w: 1, h: 1 }]) {
      const result = checkSpec({ format: vertical, ...source, textBox: box })
      expect(result.format).toBe('9:16')
      expect(Array.isArray(result.findings)).toBe(true)
    }
  })
})

describe('coverCrop', () => {
  test('crops to the format aspect without distorting', () => {
    const crop = coverCrop(1920, 1080, { name: '1:1', w: 1080, h: 1080 })
    expect(crop.width).toBe(crop.height)
    expect(crop.height).toBe(1080)
    expect(crop.left).toBe(420)
  })

  test('non-integer scaling rounds deterministically', () => {
    // The same input must never yield two sizes: an export that floors one
    // axis and rounds the other produces a 1079px "1080p" asset on some runs
    // and nobody ever works out why.
    const format = { name: 'odd', w: 777, h: 333 }
    const first = coverCrop(1001, 667, format)
    const second = coverCrop(1001, 667, format)
    expect(first).toEqual(second)
    expect(Object.values(first).every(Number.isInteger)).toBe(true)
  })

  test('never crops outside the source', () => {
    const crop = coverCrop(1080, 1080, { name: '9:16', w: 1080, h: 1920 })
    expect(crop.left).toBeGreaterThanOrEqual(0)
    expect(crop.top).toBeGreaterThanOrEqual(0)
    expect(crop.left + crop.width).toBeLessThanOrEqual(1080)
    expect(crop.top + crop.height).toBeLessThanOrEqual(1080)
  })
})
