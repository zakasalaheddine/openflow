import { test, expect, type APIRequestContext } from '@playwright/test'
import { resetWorkspace, waitForLedger, graphOf, PNG } from './helpers'

// Until this existed the only way to put an asset on the canvas was dropping a
// file on it, which made a text source reachable solely by dragging selected
// text out of another application.

test.describe.configure({ mode: 'serial' })

test.beforeEach(async ({ request }) => {
  await resetWorkspace(request)
})

const sourceCount = async (request: APIRequestContext) =>
  ((await (await request.get('/api/sources')).json()).sources as unknown[]).length

const upload = (name: string) => ({ name, mimeType: 'image/png', buffer: PNG })

test('the toolbar puts a file on the canvas', async ({ page, request }) => {
  await page.goto('/')
  await waitForLedger(page)

  await page.getByTestId('add-asset').click()
  await page.getByTestId('asset-input').setInputFiles(upload('bottle.png'))

  await expect(page.locator('.react-flow__node')).toHaveCount(1)
  expect(await sourceCount(request)).toBe(1)

  const graph = await graphOf(request)
  expect(graph.nodes[0].type).toBe('source')

  // The store key is a generated UUID, so without the uploaded name the menu
  // can only ever list assets by gibberish.
  const { sources } = await (await request.get('/api/sources')).json()
  expect(sources[0].notes).toBe('bottle.png')
  await page.getByTestId('add-asset').click()
  await expect(page.getByTestId('asset-menu')).toContainText('bottle.png')
})

test('two files chosen at once become two nodes, not two cards in one slot', async ({
  page,
  request,
}) => {
  await page.goto('/')
  await waitForLedger(page)

  await page.getByTestId('add-asset').click()
  await page.getByTestId('asset-input').setInputFiles([upload('front.png'), upload('back.png')])

  await expect(page.locator('.react-flow__node')).toHaveCount(2)
  expect(await sourceCount(request)).toBe(2)

  const graph = await graphOf(request)
  const slots = graph.nodes.map(
    (n: { position: { x: number; y: number } }) => `${n.position.x},${n.position.y}`,
  )
  expect(new Set(slots).size).toBe(2)
})

test('a note can be written without leaving the canvas', async ({ page, request }) => {
  await page.goto('/')
  await waitForLedger(page)

  await page.getByTestId('add-asset').click()
  await page.getByTestId('asset-note').click()
  await page.getByTestId('asset-note-input').fill('warm, unfussy, no hard sell')
  await page.getByTestId('asset-note-save').click()

  await expect(page.locator('.react-flow__node')).toHaveCount(1)
  await expect(page.getByText('warm, unfussy, no hard sell')).toBeVisible()

  const { sources } = await (await request.get('/api/sources')).json()
  expect(sources).toHaveLength(1)
  expect(sources[0].kind).toBe('text')
})

test('an empty note creates nothing', async ({ page, request }) => {
  await page.goto('/')
  await waitForLedger(page)

  await page.getByTestId('add-asset').click()
  await page.getByTestId('asset-note').click()
  await page.getByTestId('asset-note-input').fill('   ')
  await page.getByTestId('asset-note-save').click()

  // The API refuses an empty note, so it is never sent — no row, and no
  // half-made node on the canvas to tidy up.
  await expect(page.getByTestId('asset-menu')).toBeHidden()
  await expect(page.locator('.react-flow__node')).toHaveCount(0)
  expect(await sourceCount(request)).toBe(0)
})

test('an asset already uploaded can be placed again, and no second row is made', async ({
  page,
  request,
}) => {
  await page.goto('/')
  await waitForLedger(page)

  await page.getByTestId('add-asset').click()
  await page.getByTestId('asset-input').setInputFiles(upload('bottle.png'))
  await expect(page.locator('.react-flow__node')).toHaveCount(1)

  const { sources } = await (await request.get('/api/sources')).json()
  const sourceId = sources[0].id as string

  // Deleting the node leaves the row behind. Before this menu that asset was
  // unreachable — the whole reason sources are project-level went unspent.
  await page.locator('.react-flow__node').click()
  await page.getByTestId('delete-node').click()
  await expect(page.locator('.react-flow__node')).toHaveCount(0)

  await page.getByTestId('add-asset').click()
  await page.getByTestId(`asset-pick-${sourceId}`).click()

  await expect(page.locator('.react-flow__node')).toHaveCount(1)
  expect(await sourceCount(request)).toBe(1)
  expect((await graphOf(request)).nodes[0].sourceId).toBe(sourceId)
})

test('the same asset can sit on the canvas twice, referencing one row', async ({
  page,
  request,
}) => {
  await page.goto('/')
  await waitForLedger(page)

  await page.getByTestId('add-asset').click()
  await page.getByTestId('asset-input').setInputFiles(upload('bottle.png'))
  await expect(page.locator('.react-flow__node')).toHaveCount(1)

  const { sources } = await (await request.get('/api/sources')).json()
  const sourceId = sources[0].id as string

  await page.getByTestId('add-asset').click()
  await page.getByTestId(`asset-pick-${sourceId}`).click()

  await expect(page.locator('.react-flow__node')).toHaveCount(2)
  const graph = await graphOf(request)
  // Two nodes, one row: hashing is keyed on sourceId and version, so both are
  // references to the same bytes and go stale together.
  expect(graph.nodes.map((n: { sourceId: string }) => n.sourceId)).toEqual([sourceId, sourceId])
  expect(await sourceCount(request)).toBe(1)
})

test('the menu closes on Escape and on a click outside it', async ({ page }) => {
  await page.goto('/')
  await waitForLedger(page)

  await page.getByTestId('add-asset').click()
  await expect(page.getByTestId('asset-menu')).toBeVisible()
  await page.keyboard.press('Escape')
  await expect(page.getByTestId('asset-menu')).toBeHidden()

  await page.getByTestId('add-asset').click()
  await expect(page.getByTestId('asset-menu')).toBeVisible()
  // React Flow stops propagation on the pane, so this only works if the
  // listener is registered in the capture phase.
  await page.locator('.react-flow__pane').click({ position: { x: 400, y: 400 } })
  await expect(page.getByTestId('asset-menu')).toBeHidden()
})
