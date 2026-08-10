import { expect, test } from '@playwright/test'
import { unzipSync } from 'fflate'
import { readdirSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { resetWorkspace, setGraph, waitForLedger } from './helpers'

test.describe.configure({ mode: 'serial' })

test.beforeEach(async ({ request }) => {
  await resetWorkspace(request)
})

/** The same shot `e2e/export.spec.ts` uses, minus the export node. */
const marbleShot = () => ({
  nodes: [
    {
      id: 'marble',
      type: 'image',
      position: { x: 60, y: 80 },
      prompt: 'bottle on marble',
      modelId: 'flux-2-pro',
      seed: 1,
      label: 'marble',
    },
  ],
  edges: [],
})

async function rendered(page: import('@playwright/test').Page) {
  await page.goto('/')
  await waitForLedger(page)
  await page.getByTestId('run').click()
  await expect(page.getByTestId('ledger')).toContainText('all rendered', { timeout: 30_000 })
}

/** Anything the route's non-preview branch would have left behind. */
const orphanedDownloadDirs = () =>
  readdirSync(tmpdir()).filter((name) => name.startsWith('openflow-download-'))

test('the API refuses a format the render cannot fill, and writes nothing doing it', async ({ request }) => {
  const before = orphanedDownloadDirs().length
  // preview: true is the dialog's question. It must be free of side effects —
  // it is asked again every time the overlay goes from empty to non-empty.
  const response = await request.post('/api/download?flow=default', {
    data: { preview: true, formats: [{ name: 'huge', w: 6000, h: 6000 }] },
  })
  expect(response.ok()).toBe(true)
  const body = await response.json()
  expect(Array.isArray(body.verdicts)).toBe(true)
  expect(orphanedDownloadDirs()).toHaveLength(before)
})

test('a preview passes a fillable format, refuses an oversized one with a readable reason, and writes nothing', async ({
  page,
  request,
}) => {
  await setGraph(request, marbleShot())
  await rendered(page)

  const before = orphanedDownloadDirs().length
  // The fixture is exactly 1080x1920: '9:16' at that size is exactly fillable,
  // '6000x6000' can only be reached by upscaling, which the spec check refuses.
  const response = await request.post('/api/download?flow=default', {
    data: {
      preview: true,
      nodeIds: ['marble'],
      formats: [
        { name: '9:16', w: 1080, h: 1920 },
        { name: 'huge', w: 6000, h: 6000 },
      ],
    },
  })
  expect(response.ok()).toBe(true)
  const body = await response.json()

  expect(body.stale).toEqual([])

  const fits = body.verdicts.find((v: { format: string }) => v.format === '9:16')
  expect(fits.pass).toBe(true)

  const oversized = body.verdicts.find((v: { format: string }) => v.format === 'huge')
  expect(oversized.pass).toBe(false)
  expect(oversized.reasons.join(' ')).toMatch(/6000x6000/)

  // No directory was created to render into, let alone left behind.
  expect(orphanedDownloadDirs()).toHaveLength(before)
})

test('one node asked for two formats, one refused, ships as a zip carrying the manifest and only the format that shipped', async ({
  page,
  request,
}) => {
  await setGraph(request, marbleShot())
  await rendered(page)

  // No `preview`: this is the render branch. One node, but two formats, so a
  // bare .png here would silently drop the fact that 'huge' was refused —
  // the single-file path only fires when exactly one file could ever result.
  const response = await request.post('/api/download?flow=default', {
    data: {
      nodeIds: ['marble'],
      formats: [
        { name: '9:16', w: 1080, h: 1920 },
        { name: 'huge', w: 6000, h: 6000 },
      ],
    },
  })
  expect(response.ok()).toBe(true)
  expect(response.headers()['content-type']).toBe('application/zip')

  const entries = unzipSync(new Uint8Array(await response.body()))
  expect(Object.keys(entries)).toContain('manifest.json')
  const pngs = Object.keys(entries).filter((name) => name.endsWith('.png'))
  expect(pngs).toHaveLength(1)

  const manifest = JSON.parse(Buffer.from(entries['manifest.json']).toString('utf8'))
  expect(manifest.files.map((f: { format: string }) => f.format)).toEqual(['9:16'])
  expect(manifest.rejected.map((r: { format: string }) => r.format)).toEqual(['huge'])
})

test('one node asked for exactly one format ships as a bare file with no manifest sidecar', async ({
  page,
  request,
}) => {
  await setGraph(request, marbleShot())
  await rendered(page)

  const response = await request.post('/api/download?flow=default', {
    data: { nodeIds: ['marble'], formats: [{ name: '9:16', w: 1080, h: 1920 }] },
  })
  expect(response.ok()).toBe(true)
  expect(response.headers()['content-type']).toBe('image/png')
  expect(response.headers()['content-disposition']).toMatch(/\.png"$/)
})

test('a node with no render matching its current settings is reported stale, not dropped', async ({
  page,
  request,
}) => {
  await setGraph(request, marbleShot())
  await rendered(page)

  // Edit the prompt without re-rendering: the node's current hash no longer
  // matches the run that produced its last output, so it is stale again.
  await setGraph(request, {
    nodes: [
      {
        id: 'marble',
        type: 'image',
        position: { x: 60, y: 80 },
        prompt: 'bottle on marble, closeup',
        modelId: 'flux-2-pro',
        seed: 1,
        label: 'marble',
      },
    ],
    edges: [],
  })

  const response = await request.post('/api/download?flow=default', {
    data: { preview: true, nodeIds: ['marble'], formats: [{ name: '9:16', w: 1080, h: 1920 }] },
  })
  expect(response.ok()).toBe(true)
  const body = await response.json()

  expect(body.stale).toEqual(['marble'])
  // Stale, not silently missing: it does not show up among the verdicts either.
  expect(body.verdicts).toEqual([])
})
