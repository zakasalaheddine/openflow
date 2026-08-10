import { test, expect } from '@playwright/test'
import { unzipSync } from 'fflate'
import { readFileSync } from 'node:fs'
import sharp from 'sharp'
import { resetWorkspace, setGraph, waitForLedger } from './helpers'

test.describe.configure({ mode: 'serial' })

/** One rendered shot. Formats and overlay come from the Download dialog now,
 * not from a node on the canvas — see download-dialog.tsx. */
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

test.beforeEach(async ({ request }) => {
  await resetWorkspace(request)
})

test('downloads every project format as a zip carrying a manifest', async ({ page, request }) => {
  await setGraph(request, marbleShot())
  await rendered(page)

  await page.getByTestId('download-flow').click()
  // The project defaults are 9:16 and 1:1, and the fixture fills both — the
  // preview is async, so wait for the dialog's own answer rather than
  // assuming a tick the instant the checkbox exists.
  await expect(page.getByTestId('download-format-9:16')).toBeChecked()
  await expect(page.getByTestId('download-format-1:1')).toBeChecked()

  const [download] = await Promise.all([
    page.waitForEvent('download'),
    page.getByTestId('download-confirm').click(),
  ])

  const path = await download.path()
  const entries = unzipSync(new Uint8Array(readFileSync(path!)))
  expect(Object.keys(entries).filter((name) => name.endsWith('.png'))).toHaveLength(2)
  expect(Object.keys(entries)).toContain('manifest.json')

  const manifest = JSON.parse(Buffer.from(entries['manifest.json']).toString('utf8'))
  expect(manifest.files.map((f: { format: string }) => f.format).sort()).toEqual(['1:1', '9:16'])
  // Provenance that names a file which is not in the archive is worse than none.
  for (const entry of manifest.files) expect(Object.keys(entries)).toContain(entry.file)
})

test('a custom format ships at its own dimensions', async ({ page, request }) => {
  // Agencies carry client-specific placements; a fixed list blocks them on day
  // one, so this is a real requirement rather than a setting nobody changes.
  //
  // Not reachable from the dialog: project formats are not writable over
  // HTTP, and the dialog never sends its own `formats` in the preview
  // request (see download-dialog.tsx), so it only ever offers the project's.
  // A custom format is still a real capability of the route itself — this
  // asserts it there, the same way download.spec.ts's own format tests do.
  await setGraph(request, marbleShot())
  await rendered(page)

  const response = await request.post('/api/download?flow=default', {
    data: { nodeIds: ['marble'], formats: [{ name: 'DOOH 4:5', w: 864, h: 1080 }] },
  })
  expect(response.ok()).toBe(true)
  // One node, one format: the bare-file path, not a zip.
  expect(response.headers()['content-disposition']).toMatch(/marble-dooh-4-5\.png"$/)

  const metadata = await sharp(await response.body()).metadata()
  expect(metadata.width).toBe(864)
  expect(metadata.height).toBe(1080)
})

test('the manifest price agrees with what the inspector shows for that node', async ({
  page,
  request,
}) => {
  // Not the toolbar ledger: that sums every run on the flow, including ones
  // from graphs this spec never built. The per-node figure is the one a
  // client is actually shown beside the file.
  await setGraph(request, marbleShot())
  await rendered(page)

  await page.getByTestId('download-flow').click()
  await expect(page.getByTestId('download-format-9:16')).toBeChecked()
  await expect(page.getByTestId('download-format-1:1')).toBeChecked()

  const [download] = await Promise.all([
    page.waitForEvent('download'),
    page.getByTestId('download-confirm').click(),
  ])

  const path = await download.path()
  const entries = unzipSync(new Uint8Array(readFileSync(path!)))
  const manifest = JSON.parse(Buffer.from(entries['manifest.json']).toString('utf8'))
  const entry = manifest.files[0]
  expect(entry.costCents).toBeGreaterThan(0)

  await page.getByTestId('node-marble').click()
  await expect(page.getByLabel('Inspector for marble')).toContainText(
    `$${(entry.costCents / 100).toFixed(2)}`,
  )
})
