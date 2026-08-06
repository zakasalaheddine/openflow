import { expect, type Page, type APIRequestContext } from '@playwright/test'

/** A 1x1 PNG, so an upload in a spec is a real file rather than a fixture path. */
export const PNG = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==',
  'base64',
)

/**
 * PATCHes `/api/flow` the same way the canvas does: read the current
 * `updatedAt`, then send it back with the write. `/api/flow` rejects a PATCH
 * that omits the stamp, so every spec that seeds or resets the graph directly
 * goes through here rather than posting a bare `{ nodes, edges }` body.
 *
 * Throws loudly on a non-2xx response — a swallowed 400 here means the spec
 * fails later on an unrelated timeout, nowhere near the actual cause.
 */
export async function setGraph(request: APIRequestContext, graph: unknown) {
  const { updatedAt } = await (await request.get('/api/flow')).json()
  const response = await request.patch('/api/flow', { data: { graph, updatedAt } })
  if (!response.ok()) {
    throw new Error(`PATCH /api/flow failed: ${response.status()} ${await response.text()}`)
  }
}

/**
 * The chat panel is open by default and overlays the right edge of the
 * canvas — it and the inspector don't both fit at the viewport this suite
 * runs at. Specs that need that strip clear (a resize handle, a card's own
 * text) close it as setup, the same way they seed the graph as setup; the
 * assertions those specs make are unchanged by this.
 */
export async function closeChat(page: Page) {
  const toggle = page.getByTestId('chat-toggle')
  if ((await toggle.getAttribute('aria-pressed')) === 'true') {
    await toggle.click()
  }
}

/**
 * One server serves every spec, so each starts from a known slate rather than
 * inheriting what the last one left. Uses the same public endpoints the UI
 * does — a test-only reset hatch would be a path nobody else exercises.
 *
 * Clears the chat thread too, not just sources and the graph. A longer
 * thread means a longer prompt means a different fixtureKey — left in place,
 * a flaking spec's CI retry (playwright.config.ts sets retries: 1) starts
 * with the previous attempt's messages still on the thread and fails on
 * MissingLlmFixtureError, deterministically, turning a transient flake into
 * a hard break. Belongs here rather than in chat.spec.ts's own beforeEach:
 * this is the one helper every spec already calls to start clean, and the
 * next spec that touches chat would otherwise inherit the same trap.
 */
export async function resetWorkspace(request: APIRequestContext) {
  const { sources } = await (await request.get('/api/sources')).json()
  for (const source of sources as { id: string }[]) {
    await request.delete(`/api/sources?id=${encodeURIComponent(source.id)}`)
  }
  await setGraph(request, { nodes: [], edges: [] })
  await request.delete('/api/chat')
}

export async function uploadSource(request: APIRequestContext, name = 'bottle.png') {
  const response = await request.post('/api/sources', {
    multipart: { file: { name, mimeType: 'image/png', buffer: PNG } },
  })
  return (await response.json()).id as string
}

export async function uploadText(request: APIRequestContext, text: string) {
  const response = await request.post('/api/sources', { multipart: { text } })
  return (await response.json()).id as string
}

export const waitForLedger = (page: Page) => page.getByTestId('ledger').waitFor()

/**
 * React Flow wires up pointer events, not HTML5 drag-and-drop, so Playwright's
 * `dragTo` completes without the canvas ever seeing a connection.
 */
export async function wire(
  page: Page,
  fromNodeId: string,
  toNodeId: string,
  options: { expectEdge?: boolean } = {},
) {
  const from = page.locator(`[data-testid="node-${fromNodeId}"] .react-flow__handle.source`)
  const to = page.locator(`[data-testid="node-${toNodeId}"] .react-flow__handle.target`)

  await from.waitFor({ state: 'visible' })
  await to.waitFor({ state: 'visible' })
  await page.waitForTimeout(150)

  const before = await page.locator('.react-flow__edge').count()
  const a = (await from.boundingBox())!
  const b = (await to.boundingBox())!

  await page.mouse.move(a.x + a.width / 2, a.y + a.height / 2)
  await page.mouse.down()
  await page.mouse.move(b.x + b.width / 2, b.y + b.height / 2, { steps: 16 })
  await page.mouse.up()

  // Wait for the canvas to show it, not just the server to store it: the client
  // re-seeds after every commit, and a drag begun inside that window is lost.
  if (options.expectEdge !== false) {
    await expect(page.locator('.react-flow__edge')).toHaveCount(before + 1, { timeout: 10_000 })
  } else {
    await page.waitForTimeout(400)
  }
}

export const graphOf = async (request: APIRequestContext) =>
  (await (await request.get('/api/flow')).json()).graph
