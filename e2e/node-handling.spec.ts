import { expect, test } from '@playwright/test'
import { graphOf, resetWorkspace, uploadText, waitForLedger } from './helpers'

/**
 * The gestures you make on a card, and what each of them must not disturb.
 *
 * These are all the same bug wearing four hats: a gesture aimed at one card
 * moved something else. Editing zoomed the canvas, deleting left the node in the
 * graph, adding re-framed the whole view, and resizing was not possible at all.
 */

test.beforeEach(async ({ request }) => {
  await resetWorkspace(request)
})

const seed = async (request: Parameters<typeof graphOf>[0]) => {
  await request.patch('/api/flow', {
    data: {
      nodes: [
        {
          id: 'marble',
          type: 'image',
          position: { x: 60, y: 60 },
          prompt: 'bottle on marble',
          modelRole: 'draft',
          seed: 1,
        },
      ],
      edges: [],
    },
  })
}

const viewport = (page: import('@playwright/test').Page) =>
  page.locator('.react-flow__viewport').evaluate((el) => el.style.transform)

test('editing a prompt leaves the canvas exactly where it was', async ({ page, request }) => {
  await seed(request)
  await page.goto('/')
  await waitForLedger(page)
  await page.waitForTimeout(400)

  const before = await viewport(page)
  await page.getByTestId('node-prompt-text').dblclick()
  await expect(page.getByTestId('node-prompt-input')).toBeVisible()

  // d3 puts a double-click zoom on the pane under every node, so this used to
  // zoom the canvas in on itself every single time anyone edited a direction.
  expect(await viewport(page)).toBe(before)
})

test('entering and leaving an edit does not change the size of the card', async ({
  page,
  request,
}) => {
  await seed(request)
  await page.goto('/')
  await waitForLedger(page)
  await page.waitForTimeout(400)

  const card = page.getByTestId('node-marble')
  const resting = (await card.boundingBox())!.height

  await page.getByTestId('node-prompt-text').dblclick()
  await expect(page.getByTestId('node-prompt-input')).toBeVisible()
  expect((await card.boundingBox())!.height).toBeCloseTo(resting, 0)

  await page.getByTestId('node-prompt-input').blur()
  await expect(page.getByTestId('node-prompt-text')).toBeVisible()
  expect((await card.boundingBox())!.height).toBeCloseTo(resting, 0)
})

test('a card deleted with the keyboard leaves the graph, not just the screen', async ({
  page,
  request,
}) => {
  await seed(request)
  await page.goto('/')
  await waitForLedger(page)

  await page.getByTestId('node-marble').click()
  await page.keyboard.press('Backspace')

  await expect(page.getByTestId('node-marble')).toHaveCount(0)

  // The card vanishing is not the assertion. React Flow removes it from its own
  // store on Backspace whatever the app does; the node used to stay in
  // `graph_json`, come back on the next reload, and go on being dispatched and
  // billed by a Run nobody could see it in.
  await expect
    .poll(async () => (await graphOf(request)).nodes.length, { timeout: 10_000 })
    .toBe(0)

  await page.reload()
  await waitForLedger(page)
  await expect(page.getByTestId('node-marble')).toHaveCount(0)
})

test('a card can be resized, and the size survives a reload', async ({ page, request }) => {
  await seed(request)
  await page.goto('/')
  await waitForLedger(page)
  await page.waitForTimeout(400)

  await page.getByTestId('node-marble').click()
  const grip = page.locator('.react-flow__resize-control.handle.bottom.right')
  await expect(grip).toBeVisible()

  const from = (await grip.boundingBox())!
  await page.mouse.move(from.x + from.width / 2, from.y + from.height / 2)
  await page.mouse.down()
  await page.mouse.move(from.x + from.width / 2 + 120, from.y + from.height / 2 + 90, { steps: 12 })
  await page.mouse.up()

  const stored = await expect
    .poll(async () => (await graphOf(request)).nodes[0].size?.w ?? 0, { timeout: 10_000 })
    .toBeGreaterThan(240)
    .then(async () => (await graphOf(request)).nodes[0].size)

  await page.reload()
  await waitForLedger(page)
  await page.waitForTimeout(600)

  const box = (await page.getByTestId('node-marble').boundingBox())!
  // Compared as a ratio: the canvas is drawn at whatever zoom fitView chose.
  expect(box.width / box.height).toBeCloseTo(stored!.w / stored!.h, 1)
})

test('adding a card does not re-frame the canvas, and the new card is on screen', async ({
  page,
  request,
}) => {
  await seed(request)
  await page.goto('/')
  await waitForLedger(page)
  await page.waitForTimeout(500)

  const before = await viewport(page)
  await page.getByTestId('add-image').click()

  await expect(page.locator('[data-testid^="node-image-"]')).toHaveCount(1, { timeout: 10_000 })
  await page.waitForTimeout(600)

  // Panned to the new card, never re-fitted: adding a shot used to throw away
  // the zoom and the offset you had arranged, for every card on the canvas.
  const after = await viewport(page)
  expect(after).not.toBe(before)
  expect(after).toContain(before.slice(before.indexOf('scale')))

  const added = page.locator('[data-testid^="node-image-"]')
  const box = (await added.boundingBox())!
  const pane = (await page.locator('.react-flow').boundingBox())!
  expect(box.x + box.width).toBeGreaterThan(pane.x)
  expect(box.x).toBeLessThan(pane.x + pane.width)
  expect(box.y).toBeLessThan(pane.y + pane.height)
})

test('a new card does not land on a card that has been dragged somewhere', async ({
  page,
  request,
}) => {
  // Sitting exactly where the second grid slot is, which the old exact-position
  // check could not see: it only knew a slot was taken if some card's origin
  // matched it to the pixel, so anything you had moved became invisible to it
  // and the next card landed squarely on top.
  await request.patch('/api/flow', {
    data: {
      nodes: [
        {
          id: 'moved',
          type: 'image',
          position: { x: 300, y: 40 },
          prompt: 'dragged here on purpose',
          modelRole: 'draft',
          seed: 1,
        },
      ],
      edges: [],
    },
  })
  await page.goto('/')
  await waitForLedger(page)

  await page.getByTestId('add-image').click()
  await expect(page.locator('[data-testid^="node-image-"]')).toHaveCount(1, { timeout: 10_000 })
  await expect.poll(async () => (await graphOf(request)).nodes.length, { timeout: 10_000 }).toBe(2)

  const graph = await graphOf(request)
  const [a, b] = graph.nodes as { position: { x: number; y: number } }[]
  const overlaps =
    Math.abs(a.position.x - b.position.x) < 200 && Math.abs(a.position.y - b.position.y) < 256
  expect(overlaps).toBe(false)
})

test('Escape in a field does not close the inspector out from under you', async ({
  page,
  request,
}) => {
  await seed(request)
  await page.goto('/')
  await waitForLedger(page)

  await page.getByTestId('node-marble').click()
  const name = page.getByTestId('node-label')
  await name.click()
  await name.fill('hero shot')
  await page.keyboard.press('Escape')

  // Escape belongs to the field: it puts the stored value back. The inspector
  // stays, because closing it is not what you asked for.
  await expect(page.getByTestId('node-label')).toBeVisible()
})

test('a name is saved once, when you leave the field', async ({ page, request }) => {
  await seed(request)
  await page.goto('/')
  await waitForLedger(page)

  await page.getByTestId('node-marble').click()
  await page.getByTestId('node-label').fill('hero shot')

  // Not yet: every keystroke used to be a save and a full re-read, and the poll
  // answered mid-word with what the server last knew.
  await page.waitForTimeout(1600)
  expect((await graphOf(request)).nodes[0].label).toBeUndefined()
  await expect(page.getByTestId('node-label')).toHaveValue('hero shot')

  await page.getByTestId('node-label').blur()
  await expect
    .poll(async () => (await graphOf(request)).nodes[0].label, { timeout: 10_000 })
    .toBe('hero shot')
})

test('the branch line never covers the direction you are writing', async ({ page, request }) => {
  // A shot feeding a clip, which is the shape of the work — so every image node
  // has a subtree and a branch line. The graph used to verify the rest of this
  // file had none, which is exactly how this got missed the first time.
  await request.patch('/api/flow', {
    data: {
      nodes: [
        {
          id: 'marble',
          type: 'image',
          position: { x: 60, y: 60 },
          prompt: 'bottle on marble',
          modelRole: 'draft',
          seed: 1,
        },
        {
          id: 'clip',
          type: 'video',
          position: { x: 400, y: 60 },
          prompt: 'pan across',
          durationSec: 5,
          audio: false,
          modelRole: 'draft',
          seed: 2,
        },
      ],
      edges: [{ id: 'e1', from: 'marble', to: 'clip', role: 'start_frame', position: null }],
    },
  })
  await page.goto('/')
  await waitForLedger(page)
  await page.waitForTimeout(500)

  const card = page.getByTestId('node-marble')
  await card.hover()
  await expect(page.getByTestId('subtree-marble')).toBeVisible()

  await card.getByTestId('node-prompt-text').dblclick()
  const input = page.getByTestId('node-prompt-input')
  await expect(input).toBeVisible()

  // It floats above the bill rather than sitting below it, so it hangs over the
  // last lines of the prompt. Typing through a strip you cannot see under is
  // worse than not being told what the branch costs while you write.
  const strip = card.locator('.node__foot--branch')
  expect(await strip.evaluate((el) => getComputedStyle(el).opacity)).toBe('0')

  await page.keyboard.press('Escape')
  await card.hover()
  await expect(page.getByTestId('subtree-marble')).toBeVisible()

  // And it is never over the price, whether or not anyone is typing.
  const bill = (await card.getByTestId('price-marble').boundingBox())!
  const branch = (await strip.boundingBox())!
  expect(branch.y + branch.height).toBeLessThanOrEqual(bill.y + 1)
})

test('a note keeps the height of its card while it is being rewritten', async ({
  page,
  request,
}) => {
  const sourceId = await uploadText(request, 'warm, unfussy, no hard sell')
  await request.patch('/api/flow', {
    data: {
      nodes: [{ id: 'voice', type: 'source', position: { x: 60, y: 60 }, sourceId }],
      edges: [],
    },
  })
  await page.goto('/')
  await waitForLedger(page)
  await page.waitForTimeout(400)

  const card = page.getByTestId('node-voice')
  const resting = (await card.boundingBox())!.height

  await page.getByTestId('node-text-voice-text').dblclick()
  await expect(page.getByTestId('node-text-voice-input')).toBeVisible()
  expect((await card.boundingBox())!.height).toBeCloseTo(resting, 0)
})
