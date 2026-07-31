import { expect, type Page, type APIRequestContext } from '@playwright/test'

/** A 1x1 PNG, so an upload in a spec is a real file rather than a fixture path. */
export const PNG = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==',
  'base64',
)

/**
 * One server serves every spec, so each starts from a known slate rather than
 * inheriting what the last one left. Uses the same public endpoints the UI
 * does — a test-only reset hatch would be a path nobody else exercises.
 */
export async function resetWorkspace(request: APIRequestContext) {
  const { sources } = await (await request.get('/api/sources')).json()
  for (const source of sources as { id: string }[]) {
    await request.delete(`/api/sources?id=${encodeURIComponent(source.id)}`)
  }
  await request.patch('/api/flow', { data: { nodes: [], edges: [] } })
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
  (await (await request.get('/api/flow?role=draft')).json()).graph
