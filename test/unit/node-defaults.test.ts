import { describe, test, expect } from 'vitest'
import { newNode } from '@/core/node-defaults'

describe('newNode', () => {
  test('an image gets draft role and seed 1', () => {
    expect(newNode('image', { id: 'x' })).toEqual({
      id: 'x',
      type: 'image',
      prompt: '',
      modelRole: 'draft',
      seed: 1,
    })
  })

  test('a video gets a silent 5-second draft clip and seed 1', () => {
    expect(newNode('video', { id: 'x' })).toEqual({
      id: 'x',
      type: 'video',
      prompt: '',
      durationSec: 5,
      audio: false,
      modelRole: 'draft',
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
    const node = newNode('image', { id: 'x', prompt: 'a serum on marble', seed: 7 })
    expect(node).toMatchObject({ prompt: 'a serum on marble', seed: 7, modelRole: 'draft' })
  })

  test('never invents an id or a position', () => {
    const node = newNode('image', { id: 'x' })
    expect(node).not.toHaveProperty('position')
  })

  test('keeps a given position and label', () => {
    const node = newNode('export', { id: 'x', position: { x: 10, y: 20 }, label: 'Final' })
    expect(node).toMatchObject({ position: { x: 10, y: 20 }, label: 'Final' })
  })
})
