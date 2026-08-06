import { test, expect } from '@playwright/test'
import { closeChat, resetWorkspace, setGraph, uploadSource, waitForLedger } from './helpers'

/**
 * The workflow the whole phase exists for: one product photo, three shots off
 * it, a different model on each, priced and rendered side by side.
 *
 * Before this, the toolbar's Draft/Hero toggle overrode every node's own model
 * at render time, so the three cards could only ever run the same model. A spec
 * that only checked the select would have passed against that.
 */
test.beforeEach(async ({ request }) => {
  await resetWorkspace(request)
})

const shot = (id: string, y: number, modelId: string) => ({
  id,
  type: 'image',
  position: { x: 420, y },
  prompt: 'the serum on marble',
  modelId,
  seed: 1,
})

test('three shots off one source, three models, three prices', async ({ page, request }) => {
  const sourceId = await uploadSource(request, 'serum.png')

  await setGraph(request, {
    nodes: [
      { id: 'bottle', type: 'source', sourceId, position: { x: 60, y: 300 } },
      // flux-2-pro prices per megapixel, nano-banana-pro per image at 15c,
      // recraft-v3 per image at 4c — three rows that cannot quote the same
      // number for the same shot.
      shot('a', 40, 'flux-2-pro'),
      shot('b', 300, 'nano-banana-pro'),
      shot('c', 560, 'recraft-v3'),
    ],
    // recraft-v3 honours no reference images, so only the two that can take the
    // wire get one. That asymmetry is the capability gate doing its job, not an
    // oversight — see the refusal spec below.
    edges: [
      { id: 'r1', from: 'bottle', to: 'a', role: 'reference', position: null },
      { id: 'r2', from: 'bottle', to: 'b', role: 'reference', position: null },
    ],
  })

  await page.goto('/')
  await closeChat(page)
  await waitForLedger(page)

  // Each card names its own model, without opening the inspector three times.
  await expect(page.getByTestId('model-a')).toHaveText('flux-2-pro')
  await expect(page.getByTestId('model-b')).toHaveText('nano-banana-pro')
  await expect(page.getByTestId('model-c')).toHaveText('recraft-v3')

  // And its own price. Three identical prompts costing three different amounts
  // is the entire reason to run the comparison before committing to a model.
  const price = async (id: string) => (await page.getByTestId(`price-${id}`).innerText()).trim()
  const [a, b, c] = [await price('a'), await price('b'), await price('c')]
  expect(new Set([a, b, c]).size).toBe(3)

  // Rendering honours the node, not a toolbar. Each card's run row records the
  // model that card named.
  await page.getByTestId('run-a').click()
  await page.getByTestId('run-b').click()
  await expect(page.getByTestId('status-a')).toHaveText('done', { timeout: 20_000 })
  await expect(page.getByTestId('status-b')).toHaveText('done', { timeout: 20_000 })
  await expect(page.getByTestId('model-a')).toHaveText('flux-2-pro')
  await expect(page.getByTestId('model-b')).toHaveText('nano-banana-pro')
})

test('switching a wired shot to a model that cannot honour it is refused', async ({ page, request }) => {
  const sourceId = await uploadSource(request, 'serum.png')

  await setGraph(request, {
    nodes: [
      { id: 'bottle', type: 'source', sourceId, position: { x: 60, y: 200 } },
      shot('a', 200, 'flux-2-pro'),
    ],
    edges: [{ id: 'r1', from: 'bottle', to: 'a', role: 'reference', position: null }],
  })

  await page.goto('/')
  await closeChat(page)
  await waitForLedger(page)

  await page.getByTestId('node-a').click()
  await page.getByTestId('node-model').selectOption('recraft-v3')

  // Named, not silent — and the wire is still there.
  await expect(page.getByTestId('notice')).toContainText('recraft-v3 cannot honour reference images')
  await expect(page.getByTestId('model-a')).toHaveText('flux-2-pro')

  const graph = await (await request.get('/api/flow')).json()
  expect(graph.graph.edges).toHaveLength(1)
  expect(graph.graph.nodes.find((n: { id: string }) => n.id === 'a').modelId).toBe('flux-2-pro')
})
