import { test, expect } from '@playwright/test'
import { resetWorkspace, waitForLedger, graphOf } from './helpers'

// A deleted node coming back is not a delete that failed. It is one GET
// arriving out of order: the canvas polls the whole flow every 1.2s, and a poll
// issued before the delete resolves after it, replaying the pre-delete graph
// into the ref every later edit is built on. The card returns, and the next
// thing you touch saves it back to the database.
//
// Delaying one response makes that ordering deterministic instead of a race you
// can only reproduce by being unlucky.

test.describe.configure({ mode: 'serial' })

const CARDS = [
  { id: 'marble', type: 'image', position: { x: 40, y: 30 }, prompt: 'bottle on marble', modelRole: 'draft', seed: 901 },
  { id: 'slate', type: 'image', position: { x: 290, y: 30 }, prompt: 'bottle on slate', modelRole: 'draft', seed: 902 },
  { id: 'linen', type: 'image', position: { x: 540, y: 30 }, prompt: 'bottle on linen', modelRole: 'draft', seed: 903 },
]

test('a slow poll cannot resurrect a deleted node', async ({ page, request }) => {
  await resetWorkspace(request)
  await request.patch('/api/flow', { data: { nodes: CARDS, edges: [] } })

  // Armed only after the canvas has loaded, so what gets held is a *poll* —
  // issued while all three cards still existed, resolving after one is gone.
  // Holding the first read instead would just delay the page.
  let armed = false
  let caught = false
  await page.route('**/api/flow?role=*', async (route) => {
    if (route.request().method() !== 'GET' || !armed || caught) return route.continue()
    caught = true
    const response = await route.fetch()
    const body = await response.text()
    await new Promise((resolve) => setTimeout(resolve, 2500))
    await route.fulfill({ response, body })
  })

  await page.goto('/')
  await waitForLedger(page)
  await expect(page.getByTestId('node-slate')).toBeVisible()

  armed = true
  await page.waitForTimeout(1400) // a poll fires and is now held, carrying all three
  await page.getByTestId('node-slate').click()
  await page.getByTestId('delete-node').click()
  await expect(page.getByTestId('node-slate')).toHaveCount(0)

  await page.waitForTimeout(3000) // the held response lands, carrying `slate`

  // The damage is downstream and permanent: the next edit is built on whatever
  // the stale read left in the ref, and *saves* the node that was deleted. A
  // card flickering back is cosmetic; this is the flow file being wrong.
  await page.getByTestId('add-image').click()
  await page.waitForTimeout(1200)

  const graph = await graphOf(request)
  expect(graph.nodes.map((n: { id: string }) => n.id)).not.toContain('slate')
})

test('a new card never lands on a slot a surviving card is already using', async ({ page, request }) => {
  await resetWorkspace(request)
  await request.patch('/api/flow', { data: { nodes: CARDS, edges: [] } })

  await page.goto('/')
  await waitForLedger(page)

  await page.getByTestId('node-slate').click()
  await page.getByTestId('delete-node').click()
  await expect(page.getByTestId('node-slate')).toHaveCount(0)

  await page.getByTestId('add-image').click()
  await expect
    .poll(async () => (await graphOf(request)).nodes.length, { timeout: 10_000 })
    .toBe(3)

  const graph = await graphOf(request)
  const slots = graph.nodes.map(
    (n: { position: { x: number; y: number } }) => `${n.position.x},${n.position.y}`,
  )
  // Stacked exactly on a survivor, one card hides the other and the wrong one
  // takes every click.
  expect(new Set(slots).size).toBe(slots.length)
})
