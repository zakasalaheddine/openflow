import { describe, test, expect } from 'vitest'
import path from 'node:path'
import sharp from 'sharp'
import { unzipSync } from 'fflate'
import { POST as downloadPost } from '@/app/api/download/route'
import type { Flow } from '@/core/types'
import { tempDb, seedProject, seedFlow } from '../helpers/db'
import { seedRenderedNode, tempExportDir, STUB_PNG } from '../helpers/exports'

const FORMAT = { name: '9:16', w: 1080, h: 1920 }

// One `tempDb()` call for the whole file: `getDb()` (src/db/index.ts) caches
// its connection per module instance, and route.ts reaches it through
// `scope()`. A second `tempDb()` call anywhere in this file would rewrite
// `OPENFLOW_DATA_DIR` after that cache was already primed by the first
// `downloadPost` call, silently pointing every test after it at the wrong
// database — so every test below shares this one db/project and only seeds
// its own flow.
//
// `tempDb()`'s own `afterEach` (test/helpers/db.ts) rmSync's this directory
// after the *first* test in this file finishes, not after the file — every
// test past that one is reading and writing through the already-open sqlite
// handle on an unlinked file (works on POSIX; nothing here reopens the path
// on disk). Don't add a test that expects to find something at `dir` itself.
const { db } = tempDb()
const projectId = seedProject(db)

describe('POST /api/download: one node whose run carries more than one output asset', () => {
  test('one asset refused does not collapse a two-asset node into a bare, sidecar-less file', async () => {
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

describe('POST /api/download: downloadBodySchema rejects a malformed body', () => {
  // No nodes: every test below is exercising the schema, not the render
  // pipeline behind it, and an empty graph reaches that check the same way a
  // real one would.
  const slug = 'schema-checks'
  seedFlow(db, projectId, { nodes: [], edges: [] }, `flow:${slug}`)

  function post(body: unknown) {
    return downloadPost(
      new Request(`http://localhost/api/download?flow=${slug}`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(body),
      }),
    )
  }

  test('rejects a box fraction outside 0-1', async () => {
    const response = await post({
      overlay: { box: { x: 1.5, y: 0, w: 0.5, h: 0.2 } },
    })

    expect(response.status).toBe(400)
    const json = await response.json()
    // Actionable means it names *which* field broke, not just that some
    // field did — a bare "Invalid input" would pass a looser check but leave
    // a person guessing which of four box fractions or two format dimensions
    // was the one out of range. Also not the raw zod issue array (path/code/
    // received keys and all).
    expect(typeof json.error).toBe('string')
    expect(json.error).not.toMatch(/"code"|ZodError/)
    expect(json.error).toMatch(/overlay\.box\.x/)
    expect(json.error).toMatch(/<=\s*1/)
  })

  test('rejects a format dimension that is zero, negative, or not an integer', async () => {
    for (const w of [0, -5, 100.5]) {
      const response = await post({ formats: [{ name: 'x', w, h: 100 }] })

      expect(response.status).toBe(400)
      const json = await response.json()
      expect(typeof json.error).toBe('string')
      expect(json.error).not.toMatch(/"code"|ZodError/)
      expect(json.error).toMatch(/formats\.0\.w/)
    }
  })

  test('rejects a safeZone missing an edge — it is all-or-nothing, not a partial default', async () => {
    const response = await post({
      formats: [
        {
          name: 'x',
          w: 1080,
          h: 1920,
          spec: { safeZone: { top: 0.1, right: 0.1, bottom: 0.1 } },
        },
      ],
    })

    expect(response.status).toBe(400)
    const json = await response.json()
    expect(typeof json.error).toBe('string')
    expect(json.error).not.toMatch(/"code"|ZodError/)
    expect(json.error).toMatch(/formats\.0\.spec\.safeZone\.left/)
  })

  test('a well-formed body still succeeds — the schema discriminates, not just refuses', async () => {
    const response = await post({
      nodeIds: [],
      preview: true,
      // A complete safeZone, not just an absent one: the rejection test above
      // only proves a 3-edge safeZone is refused. Without this, a schema that
      // simply forbids `safeZone` outright (`z.never()`) would pass every
      // test in this file — this is the case that catches that.
      formats: [{ ...FORMAT, spec: { safeZone: { top: 0.1, right: 0.1, bottom: 0.1, left: 0.1 } } }],
      overlay: { headline: 'Ship it', cta: 'Learn more', box: { x: 0, y: 0.7, w: 1, h: 0.3 } },
    })

    expect(response.status).toBe(200)
    const json = await response.json()
    expect(json.formats).toEqual([
      { ...FORMAT, spec: { safeZone: { top: 0.1, right: 0.1, bottom: 0.1, left: 0.1 } } },
    ])
    expect(json.verdicts).toEqual([])
  })
})
