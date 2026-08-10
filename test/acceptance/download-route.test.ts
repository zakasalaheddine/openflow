import { describe, test, expect } from 'vitest'
import path from 'node:path'
import sharp from 'sharp'
import { unzipSync } from 'fflate'
import { POST as downloadPost } from '@/app/api/download/route'
import type { Flow } from '@/core/types'
import { tempDb, seedProject, seedFlow } from '../helpers/db'
import { seedRenderedNode, tempExportDir, STUB_PNG } from '../helpers/exports'

const FORMAT = { name: '9:16', w: 1080, h: 1920 }

// Only one test in this file: `getDb()` (src/db/index.ts) caches its
// connection per module instance, and route.ts reaches it through `scope()`.
// A second `tempDb()` call in the same file would rewrite `OPENFLOW_DATA_DIR`
// after that cache was already primed by the first request, silently pointing
// this test's assertions at the wrong database.
describe('POST /api/download: one node whose run carries more than one output asset', () => {
  test('one asset refused does not collapse a two-asset node into a bare, sidecar-less file', async () => {
    const { db } = tempDb()
    const projectId = seedProject(db)
    const graph: Flow = {
      nodes: [{ id: 'shot', type: 'image', prompt: 'bottle on marble', modelId: 'flux-2-pro', label: 'shot' }],
      edges: [],
    }
    const flowId = seedFlow(db, projectId, graph, 'flow:multi-asset')

    // A multi-output model response: one image that fills '9:16' and a
    // second, undersized one that cannot without upscaling.
    const undersized = path.join(tempExportDir(), 'small.png')
    await sharp({ create: { width: 100, height: 100, channels: 3, background: '#000' } })
      .png()
      .toFile(undersized)
    seedRenderedNode(db, flowId, 'shot', { assets: [{ file: STUB_PNG }, { file: undersized }] })

    const response = await downloadPost(
      new Request('http://localhost/api/download?flow=multi-asset', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ nodeIds: ['shot'], formats: [FORMAT] }),
      }),
    )

    expect(response.status).toBe(200)
    // One node and one format asked for — the old, count-based guard would
    // have read this as "exactly one file", handed back a bare .png for the
    // asset that shipped, and silently dropped the refusal of the other.
    expect(response.headers.get('content-type')).toBe('application/zip')

    const entries = unzipSync(new Uint8Array(await response.arrayBuffer()))
    expect(Object.keys(entries)).toContain('manifest.json')
    expect(Object.keys(entries).filter((name) => name.endsWith('.png'))).toHaveLength(1)

    const manifest = JSON.parse(Buffer.from(entries['manifest.json']).toString('utf8'))
    expect(manifest.files).toHaveLength(1)
    expect(manifest.rejected).toHaveLength(1)
    expect(manifest.rejected[0].specCheck.findings[0].rule).toBe('min_resolution')
  })
})
