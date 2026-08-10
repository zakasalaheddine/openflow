import { describe, test, expect } from 'vitest'
import { collectDownloadables, verdictsFor } from '@/core/exporter'
import type { Flow } from '@/core/types'
import { tempDb, seedProject, seedFlow } from '../helpers/db'
import { seedRenderedNode, STUB_PNG } from '../helpers/exports'

const shot = (id: string) =>
  ({ id, type: 'image', prompt: `shot ${id}`, modelId: 'flux-2-pro', seed: 1 }) as const

const graph = (): Flow => ({ nodes: [shot('hero'), shot('alt')], edges: [] })

function prepared(rendered: string[]) {
  const { db } = tempDb()
  const flowId = seedFlow(db, seedProject(db), graph())
  for (const nodeId of rendered) {
    seedRenderedNode(db, flowId, nodeId, { file: STUB_PNG, mime: 'image/png', costCents: 15 })
  }
  return { db, flowId }
}

describe('collectDownloadables', () => {
  test('separates what has a current render from what does not', () => {
    const { db, flowId } = prepared(['hero'])
    const { ready, stale } = collectDownloadables(db, flowId, ['hero', 'alt'])

    expect(ready.map((r) => r.nodeId)).toEqual(['hero'])
    expect(stale).toEqual(['alt'])
  })

  test('carries the provenance the manifest needs', () => {
    const { db, flowId } = prepared(['hero'])
    const [hero] = collectDownloadables(db, flowId, ['hero']).ready

    expect(hero.runIds).toHaveLength(1)
    expect(hero.costCents).toBe(15)
    expect(hero.prompt).toContain('shot hero')
  })
})

describe('verdictsFor', () => {
  test('refuses a format the render is too small to fill, and says why', async () => {
    const { db, flowId } = prepared(['hero'])
    const { ready } = collectDownloadables(db, flowId, ['hero'])

    // STUB_PNG is 1080x1920; a 4000-wide placement cannot be filled from it
    // without upscaling, which is the one thing minScale exists to refuse.
    const verdicts = await verdictsFor(ready, [
      { name: 'huge', w: 4000, h: 4000 },
      { name: 'tiny', w: 8, h: 8 },
    ])

    const huge = verdicts.find((v) => v.format === 'huge')!
    expect(huge.specCheck.pass).toBe(false)
    expect(huge.specCheck.findings.map((f) => f.rule)).toContain('min_resolution')
    expect(verdicts.find((v) => v.format === 'tiny')!.specCheck.pass).toBe(true)
  })

  test('writes nothing', async () => {
    // The whole reason preview is a separate function: the dialog asks this
    // question on every keystroke that matters, and a preview that rendered
    // files would burn a crop per character.
    const { db, flowId } = prepared(['hero'])
    const { ready } = collectDownloadables(db, flowId, ['hero'])
    await verdictsFor(ready, [{ name: '1:1', w: 64, h: 64 }])

    // Still pointing at the rendered source, not rewritten into an output dir
    // that was never created — nothing was written.
    expect(ready[0].assets.every((asset) => asset.path === STUB_PNG)).toBe(true)
  })
})
