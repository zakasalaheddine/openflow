import { expect, type Page, type APIRequestContext } from '@playwright/test'

/**
 * One server serves every spec, so each one starts from a known slate rather
 * than inheriting whatever the previous file left behind. Uses the same public
 * endpoints the UI does — a test-only reset hatch would be a code path nobody
 * else exercises.
 */
export async function resetWorkspace(request: APIRequestContext) {
  const { anchors } = await (await request.get('/api/anchors')).json()
  for (const anchor of anchors as { id: string }[]) {
    await request.delete(`/api/anchors?id=${encodeURIComponent(anchor.id)}`)
  }
  await request.patch('/api/flow', { data: { nodes: [], edges: [] } })
}

/** Waits for the canvas to reflect server state rather than sleeping. */
export async function waitForLedger(page: Page) {
  await page.getByTestId('ledger').waitFor()
}

/**
 * React Flow wires up pointer events, not HTML5 drag-and-drop, so Playwright's
 * `dragTo` completes without the canvas ever seeing a connection. Drive the
 * mouse directly, with intermediate steps — a single jump does not register
 * as a drag either.
 */
export async function wire(
  page: Page,
  fromNodeId: string,
  toNodeId: string,
  options: { expectEdge?: boolean } = {},
) {
  const from = page.locator(`[data-testid="node-${fromNodeId}"] .react-flow__handle.source`)
  const to = page.locator(`[data-testid="node-${toNodeId}"] .react-flow__handle.target`)

  // No scrollIntoViewIfNeeded: React Flow pans a transformed pane rather than
  // scrolling, so it never resolves. The canvas refits itself when the node
  // count changes, which is what keeps handles reachable — just let it settle.
  await from.waitFor({ state: 'visible' })
  await to.waitFor({ state: 'visible' })
  await page.waitForTimeout(150)

  const a = (await from.boundingBox())!
  const b = (await to.boundingBox())!

  const before = await page.locator('.react-flow__edge').count()

  await page.mouse.move(a.x + a.width / 2, a.y + a.height / 2)
  await page.mouse.down()
  await page.mouse.move(b.x + b.width / 2, b.y + b.height / 2, { steps: 16 })
  await page.mouse.up()

  // Wait for the *canvas* to show the edge, not just the server to store it:
  // the client re-seeds after every commit, and a drag started inside that
  // window is lost — exactly what a real user would hit. Opt-in, because some
  // specs wire something that is supposed to be refused.
  if (options.expectEdge) {
    await expect(page.locator('.react-flow__edge')).toHaveCount(before + 1, { timeout: 10_000 })
  } else {
    await page.waitForTimeout(400)
  }
}

export const addAnchor = async (request: APIRequestContext, name: string, refImages = ['a.jpg', 'b.jpg']) =>
  (await (await request.post('/api/anchors', { data: { kind: name, refImages } })).json()).id as string
