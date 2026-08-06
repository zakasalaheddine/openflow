import { describe, test, expect } from 'vitest'
import { newNode } from '@/core/node-defaults'

describe('newNode', () => {
  test('an image gets the model it was given and seed 1', () => {
    expect(newNode('image', { id: 'x', modelId: 'flux-2-pro' })).toEqual({
      id: 'x',
      type: 'image',
      prompt: '',
      modelId: 'flux-2-pro',
      seed: 1,
    })
  })

  test('a video gets a silent 5-second clip and seed 1', () => {
    expect(newNode('video', { id: 'x', modelId: 'hailuo-2-3-pro' })).toEqual({
      id: 'x',
      type: 'video',
      prompt: '',
      durationSec: 5,
      audio: false,
      modelId: 'hailuo-2-3-pro',
      seed: 1,
    })
  })

  test('an export starts with no formats', () => {
    expect(newNode('export', { id: 'x' })).toEqual({ id: 'x', type: 'export', formats: [] })
  })

  test('a source starts with no sourceId', () => {
    expect(newNode('source', { id: 'x' })).toEqual({ id: 'x', type: 'source', sourceId: '' })
  })

  test('overrides win, but only the fields given', () => {
    const node = newNode('image', { id: 'x', prompt: 'a serum on marble', seed: 7, modelId: 'flux-2-pro' })
    expect(node).toMatchObject({ prompt: 'a serum on marble', seed: 7, modelId: 'flux-2-pro' })
  })

  test('never invents an id or a position', () => {
    const node = newNode('image', { id: 'x', modelId: 'flux-2-pro' })
    expect(node).not.toHaveProperty('position')
  })

  test('refuses to invent a model, because the catalog owns that choice', () => {
    // Defaulting to a hardcoded id here would put a node on a model nobody
    // picked, at a price nobody quoted, and read as a model problem later.
    expect(() => newNode('image', { id: 'x' })).toThrow(/modelId/)
  })

  test('keeps a given position and label', () => {
    const node = newNode('export', { id: 'x', position: { x: 10, y: 20 }, label: 'Final' })
    expect(node).toMatchObject({ position: { x: 10, y: 20 }, label: 'Final' })
  })
})
