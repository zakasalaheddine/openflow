import { describe, test, expect } from 'vitest'
import { inputHash, canonicalJson, type HashInput } from '@/core/hash'

const base: HashInput = {
  nodeType: 'image',
  config: { prompt: 'a bottle on marble', anchors: ['anchor-1'] },
  upstreamHashes: [],
  anchorVersions: [1],
  modelId: 'fal-ai/flux-2/pro',
  seed: 42,
}

describe('canonicalJson', () => {
  test('is stable across key insertion order', () => {
    expect(canonicalJson({ a: 1, b: 2 })).toBe(canonicalJson({ b: 2, a: 1 }))
  })

  test('is stable for nested objects', () => {
    const left = { outer: { x: 1, y: { p: 1, q: 2 } } }
    const right = { outer: { y: { q: 2, p: 1 }, x: 1 } }
    expect(canonicalJson(left)).toBe(canonicalJson(right))
  })

  test('preserves array order', () => {
    expect(canonicalJson({ a: [1, 2] })).not.toBe(canonicalJson({ a: [2, 1] }))
  })

  test('distinguishes a missing key from an explicit undefined', () => {
    // Both must be one value, so that adding an optional field to a config
    // does not silently invalidate every cached run in the database.
    expect(canonicalJson({ a: 1, b: undefined })).toBe(canonicalJson({ a: 1 }))
  })
})

describe('inputHash', () => {
  test('is deterministic for identical input', () => {
    expect(inputHash(base)).toBe(inputHash(base))
  })

  test('returns a sha256 hex digest', () => {
    expect(inputHash(base)).toMatch(/^[0-9a-f]{64}$/)
  })

  test('ignores key order inside config', () => {
    const reordered: HashInput = {
      ...base,
      config: { anchors: ['anchor-1'], prompt: 'a bottle on marble' },
    }
    expect(inputHash(reordered)).toBe(inputHash(base))
  })

  test('changes when the prompt changes', () => {
    const edited: HashInput = { ...base, config: { ...base.config, prompt: 'a bottle on slate' } }
    expect(inputHash(edited)).not.toBe(inputHash(base))
  })

  test('changes when an upstream hash changes', () => {
    // This is what chains a graph: re-rendering a parent invalidates children.
    const a: HashInput = { ...base, upstreamHashes: ['aaa'] }
    const b: HashInput = { ...base, upstreamHashes: ['bbb'] }
    expect(inputHash(a)).not.toBe(inputHash(b))
    expect(inputHash(a)).not.toBe(inputHash(base))
  })

  test('changes when an anchor version is bumped', () => {
    // The whole "upload new product photos, eighteen nodes grey out" feature
    // is this one assertion. If it regresses, stale propagation silently dies.
    const bumped: HashInput = { ...base, anchorVersions: [2] }
    expect(inputHash(bumped)).not.toBe(inputHash(base))
  })

  test('changes when the model changes', () => {
    const other: HashInput = { ...base, modelId: 'fal-ai/nano-banana-pro' }
    expect(inputHash(other)).not.toBe(inputHash(base))
  })

  test('changes when the seed changes', () => {
    expect(inputHash({ ...base, seed: 43 })).not.toBe(inputHash(base))
  })

  test('changes when the node type changes', () => {
    expect(inputHash({ ...base, nodeType: 'video' })).not.toBe(inputHash(base))
  })

  test('treats an absent seed as distinct from a set seed', () => {
    const { seed: _seed, ...noSeed } = base
    expect(inputHash(noSeed)).not.toBe(inputHash(base))
  })

  test('is order-sensitive for upstream hashes', () => {
    // Reserved for v2 sequencing, where input order is meaningful.
    const a: HashInput = { ...base, upstreamHashes: ['aaa', 'bbb'] }
    const b: HashInput = { ...base, upstreamHashes: ['bbb', 'aaa'] }
    expect(inputHash(a)).not.toBe(inputHash(b))
  })

  test('does not collide across field boundaries', () => {
    // Naive concatenation lets one field bleed into the next, so two different
    // graphs hash identically and the cache serves the wrong asset.
    const a: HashInput = { ...base, modelId: 'model', config: { prompt: 'ab' } }
    const b: HashInput = { ...base, modelId: 'model', config: { prompt: 'a' }, upstreamHashes: ['b'] }
    expect(inputHash(a)).not.toBe(inputHash(b))
  })
})
