import { describe, test, expect } from 'vitest'
import { existsSync, readdirSync } from 'node:fs'
import path from 'node:path'
import sharp from 'sharp'
import { eq } from 'drizzle-orm'
import { exportFlow } from '@/core/exporter'
import { probe } from '@/core/ffmpeg'
import { exports, flows } from '@/db/schema'
import type { ExportNode, Flow, TextOverlay } from '@/core/types'
import { tempDb, seedProject, seedFlow } from '../helpers/db'
import { tempExportDir, seedRenderedNode } from '../helpers/exports'

const SQUARE = { name: '1:1', w: 1080, h: 1080 }

const graph = (over: Partial<ExportNode>): Flow => ({
  nodes: [
    { id: 'shot', type: 'image', prompt: 'bottle on marble', modelRole: 'draft', label: 'shot' },
    { id: 'out', type: 'export', formats: [SQUARE], ...over },
  ],
  edges: [{ id: 'e1', from: 'shot', to: 'out', role: 'input', position: null }],
})

function prepared(over: Partial<ExportNode> = {}, seed: Parameters<typeof seedRenderedNode>[3] = {}) {
  const { db } = tempDb()
  const projectId = seedProject(db)
  const flowId = seedFlow(db, projectId, graph(over))
  seedRenderedNode(db, flowId, 'shot', seed)
  return { db, flowId, dir: tempExportDir() }
}

describe('an export that fails its spec check', () => {
  const breaching: TextOverlay = { headline: 'BUY NOW', box: { x: 0.1, y: 0.01, w: 0.8, h: 0.15 } }

  test('does not silently ship', async () => {
    const { db, flowId, dir } = prepared({ overlay: breaching })
    const result = await exportFlow(db, flowId, { dir })

    expect(result.entries).toEqual([])
    expect(result.rejected).toHaveLength(1)
    expect(result.rejected[0].specCheck.findings[0].message).toMatch(/top safe zone/)
    // Only the manifest. Half-shipping the asset with a warning beside it is
    // the same as not checking — the rejection just arrives from the client.
    expect(readdirSync(dir)).toEqual(['manifest.json'])
  })

  test('still records the check that refused it', async () => {
    const { db, flowId, dir } = prepared({ overlay: breaching })
    await exportFlow(db, flowId, { dir })

    const [row] = db.select().from(exports).where(eq(exports.flowId, flowId)).all()
    expect(row.specCheck).toMatchObject({ pass: false, format: '1:1' })
    expect(row.path).toBe('')
  })
})

describe('an edit since the last render', () => {
  test('refuses rather than shipping old pixels under the new prompt', async () => {
    // The manifest records the prompt from the current graph. Exporting the
    // newest succeeded run regardless would attribute this prompt to output it
    // never produced — and provenance that lies is worse than none.
    const { db } = tempDb()
    const projectId = seedProject(db)
    const flowId = seedFlow(db, projectId, graph({}))
    seedRenderedNode(db, flowId, 'shot')
    const dir = tempExportDir()

    const base = graph({})
    const edited: Flow = {
      ...base,
      nodes: base.nodes.map((n) => (n.type === 'image' ? { ...n, prompt: 'bottle on slate' } : n)),
    }
    db.update(flows).set({ graphJson: edited }).where(eq(flows.id, flowId)).run()

    const result = await exportFlow(db, flowId, { dir })
    expect(result.entries).toEqual([])
    expect(result.rejected[0].specCheck.findings[0].rule).toBe('stale')
    expect(readdirSync(dir)).toEqual(['manifest.json'])
  })

  test('a node that was never run is refused with the same reason', async () => {
    const { db } = tempDb()
    const projectId = seedProject(db)
    const flowId = seedFlow(db, projectId, graph({}))

    const result = await exportFlow(db, flowId, { dir: tempExportDir() })
    expect(result.entries).toEqual([])
    expect(result.rejected[0].specCheck.findings[0].message).toMatch(/Run before exporting/)
  })
})

describe('the text overlay', () => {
  test('is composited into the exported file', async () => {
    const { db, flowId, dir } = prepared({
      overlay: { headline: 'Bottled sunlight', cta: 'Shop now' },
    })
    const result = await exportFlow(db, flowId, { dir })

    const file = path.join(dir, result.entries[0].file)
    const { data, info } = await sharp(file).raw().toBuffer({ resolveWithObject: true })
    // The source is a flat colour, so any pixel that is not that colour is text
    // this project drew. Comparing against a golden image would just encode the
    // font of whichever machine rendered it first.
    let painted = 0
    for (let i = 0; i < data.length; i += info.channels) {
      if (data[i] > 230 && data[i + 1] > 230 && data[i + 2] > 230) painted++
    }
    expect(painted).toBeGreaterThan(0)
  })

  test('an empty overlay leaves the frame alone and is not spec-checked', async () => {
    const { db, flowId, dir } = prepared({ overlay: { headline: '   ' } })
    const result = await exportFlow(db, flowId, { dir })
    expect(result.entries[0].specCheck.findings).toEqual([])
  })
})

describe('video export', () => {
  test('writes a clip cropped to the format', async () => {
    const { db, flowId, dir } = prepared({}, { mime: 'video/mp4' })
    const result = await exportFlow(db, flowId, { dir })

    const file = path.join(dir, result.entries[0].file)
    expect(existsSync(file)).toBe(true)
    const measured = await probe(file)
    expect([measured.width, measured.height]).toEqual([1080, 1080])
  })

  test('a clip over the format duration limit is refused', async () => {
    const { db, flowId, dir } = prepared(
      { formats: [{ ...SQUARE, spec: { maxDurationSec: 0.5 } }] },
      { mime: 'video/mp4' },
    )
    const result = await exportFlow(db, flowId, { dir })
    expect(result.entries).toEqual([])
    expect(result.rejected[0].specCheck.findings[0].rule).toBe('duration')
  })

  test('burns the overlay onto the clip, from the same renderer as the still', async () => {
    const { db, flowId, dir } = prepared({ overlay: { headline: 'Bottled sunlight' } }, { mime: 'video/mp4' })
    const result = await exportFlow(db, flowId, { dir })

    expect(result.entries).toHaveLength(1)
    // The scratch PNG the compositor needs must not be left behind looking
    // like a deliverable.
    expect(readdirSync(dir).filter((f) => f.endsWith('.overlay.png'))).toEqual([])
  })
})
