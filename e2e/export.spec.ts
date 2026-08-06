import { test, expect } from '@playwright/test'
import { existsSync, readdirSync, readFileSync, rmSync } from 'node:fs'
import path from 'node:path'
import { resetWorkspace, setGraph, waitForLedger } from './helpers'

test.describe.configure({ mode: 'serial' })

const EXPORTS = path.resolve(import.meta.dirname, '..', '.playwright-exports')

const shotThenExport = (overlay?: Record<string, unknown>, formats: unknown[] = []) => ({
  nodes: [
    { id: 'marble', type: 'image', position: { x: 60, y: 80 }, prompt: 'bottle on marble', modelId: 'flux-2-pro', seed: 1, label: 'marble' },
    { id: 'out', type: 'export', position: { x: 420, y: 80 }, formats, ...(overlay ? { overlay } : {}) },
  ],
  edges: [{ id: 'e1', from: 'marble', to: 'out', role: 'input', position: null }],
})

/** Rendered, then exported — the export path reads files, so they must exist. */
async function renderAndExport(page: import('@playwright/test').Page) {
  await page.goto('/')
  await waitForLedger(page)
  await page.getByTestId('run').click()
  await expect(page.getByTestId('ledger')).toContainText('all rendered', { timeout: 30_000 })

  await page.getByTestId('export').click()
  await expect(page.getByTestId('export-result')).toBeVisible({ timeout: 30_000 })
}

test.beforeEach(async ({ request }) => {
  await resetWorkspace(request)
  rmSync(EXPORTS, { recursive: true, force: true })
})

test('exports every project format to ./exports with a manifest', async ({ page, request }) => {
  await setGraph(request, shotThenExport())
  await renderAndExport(page)

  const files = readdirSync(EXPORTS)
  // The project defaults are 9:16 and 1:1.
  expect(files.filter((f) => f.endsWith('.png')).length).toBe(2)
  expect(files).toContain('manifest.json')

  const manifest = JSON.parse(readFileSync(path.join(EXPORTS, 'manifest.json'), 'utf8'))
  expect(manifest.files.map((f: { format: string }) => f.format).sort()).toEqual(['1:1', '9:16'])
  // Provenance that names a file which is not there is worse than none.
  for (const entry of manifest.files) expect(existsSync(path.join(EXPORTS, entry.file))).toBe(true)
})

test('a custom format exports at its own dimensions', async ({ page, request }) => {
  // Agencies carry client-specific placements; a fixed list blocks them on day
  // one, so this is a real requirement rather than a setting nobody changes.
  await setGraph(request, shotThenExport(undefined, [{ name: 'DOOH 4:5', w: 864, h: 1080 }]))
  await renderAndExport(page)

  const manifest = JSON.parse(readFileSync(path.join(EXPORTS, 'manifest.json'), 'utf8'))
  expect(manifest.files).toHaveLength(1)
  expect(manifest.files[0].format).toBe('DOOH 4:5')
})

test('the manifest price agrees with what the inspector shows for that node', async ({
  page,
  request,
}) => {
  // Not the toolbar ledger: that sums every run on the flow, including ones
  // from graphs this spec never built. The per-node figure is the one a client
  // is actually shown beside the file.
  await setGraph(request, shotThenExport())
  await renderAndExport(page)

  const manifest = JSON.parse(readFileSync(path.join(EXPORTS, 'manifest.json'), 'utf8'))
  const entry = manifest.files[0]
  expect(entry.costCents).toBeGreaterThan(0)

  await page.getByTestId('node-marble').click()
  await expect(page.getByLabel('Inspector for marble')).toContainText(
    `$${(entry.costCents / 100).toFixed(2)}`,
  )
})
