import { test, expect } from '@playwright/test'
import { closeChat, graphOf, resetWorkspace, setGraph, waitForLedger, wire } from './helpers'
import type { Edge } from '@/core/types'

test.describe.configure({ mode: 'serial' })

test.beforeEach(async ({ request }) => {
  await resetWorkspace(request)
})

const clip = (id: string, x: number) => ({
  id,
  type: 'video',
  position: { x, y: 60 },
  prompt: `shot ${id}`,
  durationSec: 5,
  audio: false,
  modelId: 'hailuo-2-3-pro',
  seed: 1,
})

const film = {
  nodes: [clip('one', 60), clip('two', 60 + 250), { id: 'cut', type: 'sequence', position: { x: 60, y: 400 }, label: 'film' }],
  edges: [],
}

test('clips cut in the order they were wired', async ({ page, request }) => {
  await setGraph(request, film)
  await page.goto('/')
  await waitForLedger(page)
  await closeChat(page)

  await wire(page, 'one', 'cut')
  await wire(page, 'two', 'cut')

  const graph = await graphOf(request)
  expect((graph.edges as Edge[]).map((e) => [e.from, e.position])).toEqual([
    ['one', 0],
    ['two', 1],
  ])
})

test('the cut can be reordered, and the new order is what is saved', async ({ page, request }) => {
  // The order is the whole content of the node. If it did not survive a save,
  // the film you watched back would not be the film you cut.
  await setGraph(request, {
    ...film,
    edges: [
      { id: 'e1', from: 'one', to: 'cut', role: 'input', position: 0 },
      { id: 'e2', from: 'two', to: 'cut', role: 'input', position: 1 },
    ],
  })
  await page.goto('/')
  await waitForLedger(page)
  await closeChat(page)

  await page.getByTestId('node-cut').click()
  await expect(page.getByTestId('cut-order')).toContainText('one')
  // The number you are working towards, before anything has rendered: two
  // five-second clips is ten seconds of film.
  await expect(page.getByTestId('cut-total')).toHaveText('10s in 2 shots')
  await expect(page.getByTestId('runtime-cut')).toHaveText('2 shots · 10s')

  await page.getByTestId('cut-down-one').click()

  await expect
    .poll(async () => ((await graphOf(request)).edges as Edge[]).find((e) => e.from === 'one')?.position)
    .toBe(1)
})

test('a still cannot feed a cut', async ({ page, request }) => {
  // It would have to become a clip of some invented length, and inventing a
  // length is a decision that belongs on a priced video node.
  await setGraph(request, {
    nodes: [
      { id: 'still', type: 'image', position: { x: 60, y: 60 }, prompt: 'her at the window', modelId: 'flux-2-pro', seed: 1 },
      { id: 'cut', type: 'sequence', position: { x: 420, y: 60 }, label: 'film' },
    ],
    edges: [],
  })
  await page.goto('/')
  await waitForLedger(page)
  await closeChat(page)

  await wire(page, 'still', 'cut', { expectEdge: false })

  await expect(page.getByTestId('notice')).toContainText('Only a video node can feed one')
  expect((await graphOf(request)).edges).toHaveLength(0)
})

test('a cut is rendered from the canvas and shows the film it made', async ({ page, request }) => {
  await setGraph(request, {
    ...film,
    edges: [
      { id: 'e1', from: 'one', to: 'cut', role: 'input', position: 0 },
      { id: 'e2', from: 'two', to: 'cut', role: 'input', position: 1 },
    ],
  })
  await page.goto('/')
  await waitForLedger(page)
  await closeChat(page)

  // The cut has its own Run button now, same as any other node.
  await expect(page.getByTestId('run-cut')).toBeEnabled()

  // Two clips and a cut. Run all renders the clips, then cuts them.
  await page.getByTestId('run').click()
  await expect(page.getByTestId('status-cut')).toHaveText(/done/, { timeout: 30_000 })

  // The film is on the card, not in a folder.
  await expect(page.locator('[data-testid="node-cut"] video')).toBeVisible()
  // Free: the clips were paid for.
  await expect(page.getByTestId('price-cut')).toHaveText('$0.00')
})
