import { test, expect } from '@playwright/test'
import { resetWorkspace, setGraph, waitForLedger, uploadSource } from './helpers'

// The card crops to 5:4 so twelve shots fit on one screen. Judging one of them
// needs the file, not the crop.

test.describe.configure({ mode: 'serial' })

test.beforeEach(async ({ request }) => {
  await resetWorkspace(request)
})

test('a reference opens at full size and closes on Escape', async ({ page, request }) => {
  const sourceId = await uploadSource(request)
  await setGraph(request, {
      nodes: [{ id: 'bottle', type: 'source', sourceId, position: { x: 60, y: 80 } }],
      edges: [],
    })

  await page.goto('/')
  await waitForLedger(page)

  await expect(page.getByTestId('lightbox')).toBeHidden()
  await page.getByTestId('preview-bottle').click()

  const lightbox = page.getByTestId('lightbox')
  await expect(lightbox).toBeVisible()
  await expect(page.getByTestId('lightbox-image')).toBeVisible()

  // Escape is the platform's, not ours — a <dialog> opened with showModal.
  await page.keyboard.press('Escape')
  await expect(lightbox).toBeHidden()
})

test('a rendered shot opens its own output, and the close button works', async ({ page, request }) => {
  await setGraph(request, {
      nodes: [
        {
          id: 'marble',
          type: 'image',
          position: { x: 60, y: 80 },
          prompt: 'bottle on marble',
          modelId: 'flux-2-pro',
          seed: 7701,
        },
      ],
      edges: [],
    })

  await page.goto('/')
  await waitForLedger(page)
  await page.getByTestId('run-marble').click()
  await expect(page.getByTestId('status-marble')).toHaveText('done', { timeout: 30_000 })

  await page.getByTestId('preview-marble').click()
  await expect(page.getByTestId('lightbox-image')).toBeVisible()

  await page.getByTestId('lightbox-close').click()
  await expect(page.getByTestId('lightbox')).toBeHidden()
})

test('opening a frame does not run it, wire it, or fan it out', async ({ page, request }) => {
  // The frame sits in the middle of the card, where React Flow's drag handler
  // and the canvas's alt-click fan-out both live. A preview that costs money or
  // spawns a node is worse than no preview.
  const sourceId = await uploadSource(request)
  await setGraph(request, {
      nodes: [{ id: 'bottle', type: 'source', sourceId, position: { x: 60, y: 80 } }],
      edges: [],
    })

  await page.goto('/')
  await waitForLedger(page)

  await page.getByTestId('preview-bottle').click()
  await expect(page.getByTestId('lightbox')).toBeVisible()
  await page.keyboard.press('Escape')

  const graph = await (await request.get('/api/flow')).json()
  expect(graph.graph.nodes).toHaveLength(1)
  expect(graph.graph.edges).toHaveLength(0)
})
