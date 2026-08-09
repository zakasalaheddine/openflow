import { expect, test } from '@playwright/test'
import { closeChat, resetWorkspace, setGraph } from './helpers'

/**
 * Two builds, two URLs, one session.
 *
 * The point of the feature is that an edit in one workspace is invisible in the
 * other while both are open — so that is what this asserts, through the same
 * endpoints the canvas uses.
 */

test.beforeEach(async ({ request }) => {
  await resetWorkspace(request)
})

/**
 * Every workspace this file made, gone — whichever assertion failed.
 *
 * One server serves the whole suite and `resetWorkspace` only ever resets the
 * landing workspace, so a leftover here is inherited by every spec that runs
 * after it. Cleaning up at the end of each test is not enough: an assertion
 * that throws first skips it, and a CI retry then starts dirty.
 */
test.afterEach(async ({ request }) => {
  const { flows } = await (await request.get('/api/flows')).json()
  for (const flow of flows as { slug: string }[]) {
    if (flow.slug !== 'default') {
      await request.delete(`/api/flows?flow=${encodeURIComponent(flow.slug)}`)
    }
  }
})

test('/ lands on a workspace with a URL of its own', async ({ page }) => {
  await page.goto('/')
  await expect(page).toHaveURL(/\/f\/default$/)
})

test('a slug that does not exist is a dead link, not an empty canvas', async ({ page, request }) => {
  // Rendering the canvas anyway would leave every save 404ing behind it, which
  // reads as a broken app rather than a workspace someone deleted.
  const response = await page.goto('/f/no-such-workspace')
  expect(response?.status()).toBe(404)

  const api = await request.get('/api/flow?flow=no-such-workspace')
  expect(api.status()).toBe(404)
})

test('a node added in one workspace does not appear in the other', async ({ page, request }) => {
  await setGraph(request, {
    nodes: [
      {
        id: 'marble',
        type: 'image',
        position: { x: 60, y: 60 },
        prompt: 'bottle on marble',
        modelId: 'flux-2-pro',
        seed: 1,
      },
    ],
    edges: [],
  })

  const created = await request.post('/api/flows', { data: { name: 'spring campaign' } })
  const { slug } = await created.json()

  const fresh = await (await request.get(`/api/flow?flow=${slug}`)).json()
  expect(fresh.graph.nodes).toHaveLength(0)

  const original = await (await request.get('/api/flow?flow=default')).json()
  expect(original.graph.nodes).toHaveLength(1)

  // The canvas at the new URL shows the empty graph, not the seeded one.
  await page.goto(`/f/${slug}`)
  await closeChat(page)
  await expect(page.getByTestId('node-marble')).toHaveCount(0)
})

test('the switcher creates a workspace and navigates to it', async ({ page }) => {
  await page.goto('/f/default')
  await closeChat(page)

  await page.getByTestId('workspace-menu-toggle').click()
  await page.getByTestId('workspace-new').click()
  await page.getByTestId('workspace-new-input').fill('autumn')
  await page.getByTestId('workspace-new-save').click()

  await expect(page).not.toHaveURL(/\/f\/default$/)
  await expect(page.getByTestId('workspace-menu-toggle')).toContainText('autumn')
})

test('the only workspace cannot be deleted', async ({ request }) => {
  // The canvas has to open onto something. Allowing it would land the next
  // request on a recreated empty default wearing the name just deleted.
  const response = await request.delete('/api/flows?flow=default')
  expect(response.status()).toBe(409)
})
