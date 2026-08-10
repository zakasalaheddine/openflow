import { expect, test } from '@playwright/test'
import { unzipSync } from 'fflate'
import { readdirSync, statSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import sharp from 'sharp'
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

/** Two rendered shots, for the whole-flow dialog's own node picker. */
const twoShots = () => ({
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
    {
      id: 'second',
      type: 'image',
      position: { x: 420, y: 80 },
      prompt: 'bottle on slate',
      modelId: 'flux-2-pro',
      seed: 2,
      label: 'second',
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

// The e2e server's own asset store — the same directory playwright.config.ts
// points OPENFLOW_DATA_DIR at, so this is the one place a spec may legitimately
// reach onto disk rather than through an endpoint.
const ASSETS_DIR = path.resolve(import.meta.dirname, '..', '.playwright-data', 'assets')

/**
 * The file backing a rendered node's first output.
 *
 * FAL_MODE=stub always answers the same fixture regardless of aspect (see
 * `STUB_MEDIA` in src/models/fal.ts), so two stub renders are always the same
 * 1080x1920 — there is no lever in the UI to make one node's real dimensions
 * differ from another's. Overwriting the file a render already produced, in
 * place, is the only way to give a node a genuinely different measured size
 * for the spec check to disagree on, short of forging a live fal response.
 */
function assetFileFor(id: string): string {
  const stack = [ASSETS_DIR]
  while (stack.length > 0) {
    const dir = stack.pop()!
    for (const name of readdirSync(dir)) {
      const full = path.join(dir, name)
      if (statSync(full).isDirectory()) stack.push(full)
      else if (name.startsWith(id)) return full
    }
  }
  throw new Error(`no asset file found for ${id} under ${ASSETS_DIR}`)
}

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

test('one frame downloads as one file, no zip to unpack', async ({ page, request }) => {
  await setGraph(request, marbleShot())
  await rendered(page)

  // One node, one format ticked: the common case must not hand you an archive.
  await page.getByTestId('download-marble').click()
  await page.getByTestId('download-format-1:1').uncheck()
  const [download] = await Promise.all([
    page.waitForEvent('download'),
    page.getByTestId('download-confirm').click(),
  ])

  expect(download.suggestedFilename()).toMatch(/^marble-9-16\.png$/)
})

test('a headline in the safe zone cannot be ticked past', async ({ page, request }) => {
  // The refusal is the product rule, not a nicety: shipping it anyway is the
  // same as not checking, and the rejection arrives from the client instead,
  // with the buy already booked. Driven from the dialog's own fields, because
  // that is where the overlay lives now.
  //
  // `DEFAULT_TEXT_BOX` (see src/core/spec.ts) sits inside every default
  // format's safe zone on its own — `text inside the safe zone passes` in
  // test/unit/spec-validation.test.ts pins that down — so a headline alone
  // never disables anything. The box has to move for there to be anything to
  // refuse; the box-position field is this dialog's one deviation from the
  // brief's given control list, and the same reasoning that requires it here
  // applies to every test below that exercises a refusal.
  await setGraph(request, marbleShot())
  await rendered(page)

  await page.getByTestId('download-marble').click()
  await page.getByTestId('download-headline').fill('Bottled sunlight')
  // Into the chrome at the top of the frame — the single most common
  // rejection in a vertical placement, and the same edge the old export
  // node's inspector field moved.
  await page.getByTestId('download-box-y').fill('2')

  await expect(page.getByTestId('download-format-9:16')).toBeDisabled()
  await expect(page.getByTestId('download-confirm')).toBeDisabled()
})

test('a node that fails a placement does not disable it for every node once unticked', async ({
  page,
  request,
}) => {
  await setGraph(request, twoShots())
  await rendered(page)

  // Shrink `second`'s real output after the fact — the only way, under
  // FAL_MODE=stub, to give one node a verdict the other genuinely does not
  // share (see assetFileFor above).
  const flow = await (await request.get('/api/flow')).json()
  const assetId = (flow.nodes.second.outputs[0].url as string).split('/').pop()!
  await sharp({ create: { width: 400, height: 400, channels: 3, background: { r: 0, g: 0, b: 0 } } })
    .png()
    .toFile(assetFileFor(assetId))

  await page.getByTestId('download-flow').click()

  // Both nodes ship by default, and `second` genuinely cannot fill either
  // placement at 400x400 — both start disabled, and the reason names the
  // offending node, since a refusal with no node attached in a flow-wide
  // dialog is not something anyone could act on.
  await expect(page.getByTestId('download-format-9:16')).toBeDisabled()
  await expect(page.getByTestId('download-format-1:1')).toBeDisabled()
  await expect(page.getByTestId('download-dialog')).toContainText('second: 9:16 needs at least')

  // Drop `second`. This is client-side — no refetch fires on a node tick —
  // so what is under test is the dialog scoping `failing` to the nodes still
  // ticked, not the route: before the fix, one failing node anywhere in the
  // flow disabled a placement for good, and unticking the offender could
  // never clear it.
  await page.getByTestId('download-node-second').uncheck()
  await expect(page.getByTestId('download-format-9:16')).toBeEnabled()
  await expect(page.getByTestId('download-format-1:1')).toBeEnabled()
  await expect(page.getByTestId('download-dialog')).not.toContainText('second:')

  // Unticking every node is the same fact one level up from unticking every
  // format: nothing is left to ship, so Download has to go dead too rather
  // than produce a bare 422 on click.
  await page.getByTestId('download-node-marble').uncheck()
  await expect(page.getByTestId('download-confirm')).toBeDisabled()
  await page.getByTestId('download-node-marble').check()

  await page.getByTestId('download-format-9:16').check()
  await page.getByTestId('download-format-1:1').uncheck()
  const [download] = await Promise.all([
    page.waitForEvent('download'),
    page.getByTestId('download-confirm').click(),
  ])
  // A bare file, not a zip, and named for `marble` alone: proof `second` —
  // still unfit for either placement — was genuinely excluded rather than
  // merely hidden behind a disabled checkbox.
  expect(download.suggestedFilename()).toMatch(/^marble-9-16\.png$/)
})
