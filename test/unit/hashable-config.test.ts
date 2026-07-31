import { describe, test, expect } from 'vitest'
import { hashableConfig } from '@/core/hashable'
import type { FlowNode } from '@/core/types'

const imageNode: FlowNode = {
  id: 'img',
  type: 'image',
  prompt: 'bottle on marble',
  anchors: ['a1'],
  modelRole: 'draft',
  seed: 7,
  position: { x: 10, y: 20 },
}

const videoNode: FlowNode = {
  id: 'clip',
  type: 'video',
  prompt: 'slow push in',
  anchors: ['a1'],
  durationSec: 5,
  audio: true,
  modelRole: 'hero',
  position: { x: 0, y: 0 },
}

describe('hashableConfig', () => {
  // A whitelist, not a blacklist. The canvas is about to add view-only fields
  // to every node, and each one would otherwise become part of the cache key.

  test('omits canvas position', () => {
    // Dragging a node two pixels must not invalidate its subtree. At hero video
    // prices, re-billing a graph because someone tidied the layout is the most
    // expensive bug available.
    const moved = { ...imageNode, position: { x: 999, y: 999 } } as FlowNode
    expect(hashableConfig(moved)).toEqual(hashableConfig(imageNode))
  })

  test('omits a view-only field it has never heard of', () => {
    const decorated = { ...imageNode, label: 'Hero shot', collapsed: true } as FlowNode
    expect(hashableConfig(decorated)).toEqual(hashableConfig(imageNode))
  })

  test('keeps the fields that change the output', () => {
    expect(hashableConfig(imageNode)).toEqual({
      prompt: 'bottle on marble',
      anchors: ['a1'],
      modelRole: 'draft',
    })
  })

  test('keeps duration and audio on a video node', () => {
    expect(hashableConfig(videoNode)).toEqual({
      prompt: 'slow push in',
      anchors: ['a1'],
      modelRole: 'hero',
      durationSec: 5,
      audio: true,
    })
  })

  test('keeps assets on a source node', () => {
    const source: FlowNode = {
      id: 's',
      type: 'source',
      assets: [{ id: 'a', path: '/tmp/a.png', mime: 'image/png' }],
      position: { x: 1, y: 2 },
    }
    expect(hashableConfig(source)).toEqual({ assets: source.assets })
  })

  test('keeps formats, fps and codec on an export node', () => {
    const exportNode: FlowNode = {
      id: 'e',
      type: 'export',
      formats: [{ name: '1:1', w: 1080, h: 1080 }],
      fps: 30,
      position: { x: 0, y: 0 },
    }
    expect(hashableConfig(exportNode)).toEqual({
      formats: exportNode.type === 'export' ? exportNode.formats : [],
      fps: 30,
      codec: undefined,
    })
  })

  test('a prompt edit still changes the config', () => {
    const edited = { ...imageNode, prompt: 'bottle on slate' } as FlowNode
    expect(hashableConfig(edited)).not.toEqual(hashableConfig(imageNode))
  })

  test('an anchor chip toggle still changes the config', () => {
    const edited = { ...imageNode, anchors: ['a1', 'a2'] } as FlowNode
    expect(hashableConfig(edited)).not.toEqual(hashableConfig(imageNode))
  })
})
