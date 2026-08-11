import { describe, test, expect } from 'vitest'
import { existsSync } from 'node:fs'
import path from 'node:path'
import sharp from 'sharp'
import { eq } from 'drizzle-orm'
import { exportFlow } from '@/core/exporter'
import { DEFAULT_SETTINGS } from '@/core/settings'
import { exports } from '@/db/schema'
import type { AdFormat, Flow } from '@/core/types'
import { tempDb, seedProject, seedFlow } from '../helpers/db'
import { tempExportDir, seedRenderedNode } from '../helpers/exports'

// Agencies carry client-specific placements — DOOH, in-app, bumpers — and a
// fixed list of formats blocks them on day one.

const DOOH = { name: 'DOOH 4:5', w: 864, h: 1080 }

const graph = (): Flow => ({
  nodes: [{ id: 'shot', type: 'image', prompt: 'bottle on marble', modelId: 'flux-2-pro', label: 'shot' }],
  edges: [],
})

// exportFlow takes its formats explicitly (see core/exporter.ts) — there is
// no export node to carry them, and no fallback core has to guess at. Project
// settings' default formats are applied here, at the call site, the same way
// the download route applies them.
function prepared(over: { formats?: AdFormat[] } = {}, settings = {}) {
  const { db } = tempDb()
  const projectId = seedProject(db, settings)
  const flowId = seedFlow(db, projectId, graph())
  seedRenderedNode(db, flowId, 'shot')
  const merged = { ...DEFAULT_SETTINGS, ...settings }
  const formats = over.formats?.length ? over.formats : merged.formats
  return { db, flowId, dir: tempExportDir(), nodeIds: ['shot'], formats }
}

describe('exporting', () => {
  test('writes one file per project format', async () => {
    const { db, flowId, dir, nodeIds, formats } = prepared()
    const result = await exportFlow(db, flowId, { dir, nodeIds, formats })

    expect(result.entries.map((e) => e.format).sort()).toEqual(['1:1', '9:16'])
    for (const entry of result.entries) expect(existsSync(path.join(dir, entry.file))).toBe(true)
  })

  test('a custom format persists in project settings and exports at its dimensions', async () => {
    const { db, flowId, dir, nodeIds, formats } = prepared({}, { formats: [DOOH] })
    const result = await exportFlow(db, flowId, { dir, nodeIds, formats })

    expect(result.entries).toHaveLength(1)
    const meta = await sharp(path.join(dir, result.entries[0].file)).metadata()
    expect([meta.width, meta.height]).toEqual([864, 1080])
  })

  test('records an exports row for every format, with the check that was run', async () => {
    const { db, flowId, dir, nodeIds, formats } = prepared()
    await exportFlow(db, flowId, { dir, nodeIds, formats })

    const rows = db.select().from(exports).where(eq(exports.flowId, flowId)).all()
    expect(rows).toHaveLength(2)
    for (const row of rows) expect(row.specCheck).toMatchObject({ pass: true })
  })

  test('the same input exports at the same dimensions every time', async () => {
    const odd = { name: 'odd', w: 777, h: 333 }
    const { db, flowId, dir, nodeIds, formats } = prepared({ formats: [odd] })

    const first = await exportFlow(db, flowId, { dir, nodeIds, formats })
    const second = await exportFlow(db, flowId, { dir: tempExportDir(), nodeIds, formats })

    const dims = async (base: string, file: string) => {
      const meta = await sharp(path.join(base, file)).metadata()
      return [meta.width, meta.height]
    }
    expect(await dims(dir, first.entries[0].file)).toEqual([777, 333])
    expect(await dims(dir, first.entries[0].file)).toEqual(
      await dims(path.dirname(second.manifestPath), second.entries[0].file),
    )
  })
})
