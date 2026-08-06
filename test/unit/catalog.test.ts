import { describe, test, expect, vi, afterEach } from 'vitest'
import { mkdtempSync, writeFileSync, rmSync, existsSync, utimesSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { SEED, UnknownModelError, UnsupportedCapabilityError } from '@/models/registry'
import { catalog, ensureModelsFile, modelById, defaultModelFor } from '@/models/catalog'
import { modelsPath } from '@/env'

const dirs: string[] = []
const tmp = () => {
  const dir = mkdtempSync(path.join(tmpdir(), 'openflow-models-'))
  dirs.push(dir)
  vi.stubEnv('OPENFLOW_DATA_DIR', dir)
  return dir
}

const write = (dir: string, rows: unknown) =>
  writeFileSync(path.join(dir, 'models.json'), JSON.stringify(rows, null, 2))

afterEach(() => {
  vi.unstubAllEnvs()
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true })
})

const row = (overrides: Record<string, unknown> = {}) => ({
  id: 'my-model',
  format: 'image',
  falEndpoint: 'fal-ai/whatever',
  caps: { refImages: 0, textRendering: false, startEndFrame: false, nativeAudio: false },
  cost: { unit: 'image', amount: 1 },
  verifiedOn: null,
  ...overrides,
})

describe('the catalog', () => {
  test('is the shipped seed until a file exists, and reading never writes one', () => {
    // Reading must not write: unit suites that never set OPENFLOW_DATA_DIR would
    // otherwise seed a file into the developer's real ./data on first import.
    const dir = tmp()
    expect(catalog().map((m) => m.id)).toEqual(SEED.map((m) => m.id))
    expect(existsSync(path.join(dir, 'models.json'))).toBe(false)
  })

  test('ensureModelsFile writes the seed once, and never overwrites an edited file', () => {
    const dir = tmp()
    ensureModelsFile()
    expect(existsSync(modelsPath())).toBe(true)

    write(dir, [row()])
    ensureModelsFile()
    expect(catalog().map((m) => m.id)).toEqual(['my-model'])
  })

  test('the file wins over the seed', () => {
    const dir = tmp()
    write(dir, [row({ id: 'kling-4-turbo' })])
    expect(catalog().map((m) => m.id)).toEqual(['kling-4-turbo'])
  })

  test('an edit is live without a restart', () => {
    const dir = tmp()
    write(dir, [row({ id: 'first' })])
    expect(catalog().map((m) => m.id)).toEqual(['first'])

    write(dir, [row({ id: 'second' })])
    // Same millisecond on a fast machine would hide the change behind the cache.
    const future = new Date(Date.now() + 2000)
    utimesSync(modelsPath(), future, future)
    expect(catalog().map((m) => m.id)).toEqual(['second'])
  })

  test('a malformed row is refused by field name, and never falls back to the seed', () => {
    // A silent fallback renders against a model you believe you changed, at a
    // price you believe you set.
    const dir = tmp()
    write(dir, [row({ caps: { refImages: 'four' } })])
    expect(() => catalog()).toThrow(/caps\.refImages/)
  })

  test('unparseable JSON names the file rather than dying inside a parser', () => {
    const dir = tmp()
    writeFileSync(path.join(dir, 'models.json'), '{ not json')
    expect(() => catalog()).toThrow(/models\.json/)
  })

  test('two formats, two ids: nothing is shared between image and video', () => {
    tmp()
    const images = catalog().filter((m) => m.format === 'image')
    const videos = catalog().filter((m) => m.format === 'video')
    expect(images.length).toBeGreaterThan(1)
    expect(videos.length).toBeGreaterThan(1)
    expect(images.some((i) => videos.some((v) => v.id === i.id))).toBe(false)
  })
})

describe('modelById', () => {
  test('resolves a seeded id', () => {
    tmp()
    expect(modelById('flux-2-pro').falEndpoint).toBe('fal-ai/flux-2-pro')
  })

  test('throws by name, as a capability error the run route already maps to a 400', () => {
    tmp()
    expect(() => modelById('nope')).toThrow(UnknownModelError)
    expect(() => modelById('nope')).toThrow(UnsupportedCapabilityError)
    expect(() => modelById('nope')).toThrow(/nope/)
  })
})

describe('defaultModelFor', () => {
  test('honours the row that claims it', () => {
    const dir = tmp()
    write(dir, [row({ id: 'a' }), row({ id: 'b', default: true })])
    expect(defaultModelFor('image').id).toBe('b')
  })

  test('falls back to the first row of that format', () => {
    const dir = tmp()
    write(dir, [row({ id: 'a' }), row({ id: 'b' })])
    expect(defaultModelFor('image').id).toBe('a')
  })

  test('throws rather than returning undefined when the format has no rows', () => {
    const dir = tmp()
    write(dir, [row({ id: 'a' })])
    expect(() => defaultModelFor('video')).toThrow(/video/)
  })

  test('the shipped seed has a default for both formats', () => {
    tmp()
    expect(defaultModelFor('image').id).toBe('flux-2-pro')
    expect(defaultModelFor('video').id).toBe('hailuo-2-3-pro')
  })
})

describe('the seeded file', () => {
  test('round-trips: what ensureModelsFile writes is what catalog validates', () => {
    tmp()
    ensureModelsFile()
    const written = JSON.parse(readFileSync(modelsPath(), 'utf8'))
    expect(written).toHaveLength(SEED.length)
    expect(catalog().map((m) => m.id)).toEqual(SEED.map((m) => m.id))
  })
})
