import { test, expect } from '@playwright/test'
import { resetWorkspace, waitForLedger, addAnchor, wire } from './helpers'

test.describe.configure({ mode: 'serial' })

test.beforeEach(async ({ request }) => {
  await resetWorkspace(request)
})

test('an anchor chip attaches to many nodes without creating a single edge', async ({ page, request }) => {
  // The readability guarantee. If a chip ever becomes a wire, twelve nodes
  // referencing one bottle turn the canvas into spaghetti.
  const anchorId = await addAnchor(request, 'Serum bottle')
  await request.patch('/api/flow', {
    data: {
      nodes: Array.from({ length: 4 }, (_, i) => ({
        id: `img-${i}`,
        type: 'image',
        position: { x: 60 + i * 220, y: 80 },
        prompt: `shot ${i}`,
        anchors: [],
        modelRole: 'draft',
        seed: i,
      })),
      edges: [],
    },
  })

  await page.goto('/')
  await waitForLedger(page)

  for (let i = 0; i < 4; i++) {
    await page.getByTestId(`node-img-${i}`).click()
    await page.getByTestId(`anchor-chip-${anchorId}`).click()
    await expect(page.getByTestId(`anchor-chip-${anchorId}`)).toHaveAttribute('aria-pressed', 'true')
  }

  const state = await (await request.get('/api/flow?role=draft')).json()
  expect(state.graph.edges).toHaveLength(0)
  expect(
    state.graph.nodes.every((n: { anchors: string[] }) => n.anchors.includes(anchorId)),
  ).toBe(true)
})

test('bumping an anchor prices the blast radius before committing to it', async ({ page, request }) => {
  const anchorId = await addAnchor(request, 'Serum bottle')
  await request.patch('/api/flow', {
    data: {
      nodes: [
        { id: 'img', type: 'image', position: { x: 60, y: 80 }, prompt: 'bottle', anchors: [anchorId], modelRole: 'draft', seed: 1 },
        { id: 'clip', type: 'video', position: { x: 320, y: 80 }, prompt: 'push in', anchors: [], durationSec: 5, audio: false, modelRole: 'draft', seed: 1 },
      ],
      edges: [{ id: 'e1', from: 'img', to: 'clip', role: 'start_frame', position: null }],
    },
  })

  await page.goto('/')
  await waitForLedger(page)
  await page.getByTestId(`bump-${anchorId}`).click()

  // Named count and named price, before anything is committed. Never silently
  // re-run: at hero video prices that is real money.
  const banner = page.getByRole('alertdialog', { name: 'Confirm new photos' })
  await expect(banner).toContainText('2 shots')
  await expect(banner).toContainText('$')

  // Cancelling leaves the version alone.
  await banner.getByText('Cancel').click()
  await expect(page.getByTestId(`anchor-version-${anchorId}`)).toHaveText('v1')

  await page.getByTestId(`bump-${anchorId}`).click()
  await page.getByTestId(`confirm-bump-${anchorId}`).click()
  await expect(page.getByTestId(`anchor-version-${anchorId}`)).toHaveText('v2')
})

test('editing a prompt marks the node and its descendants stale, and does not run them', async ({
  page,
  request,
}) => {
  await request.patch('/api/flow', {
    data: {
      nodes: [
        { id: 'img', type: 'image', position: { x: 60, y: 80 }, prompt: 'bottle', anchors: [], modelRole: 'draft', seed: 1 },
        { id: 'clip', type: 'video', position: { x: 320, y: 80 }, prompt: 'push in', anchors: [], durationSec: 5, audio: false, modelRole: 'draft', seed: 1 },
      ],
      edges: [{ id: 'e1', from: 'img', to: 'clip', role: 'start_frame', position: null }],
    },
  })

  await page.goto('/')
  await waitForLedger(page)
  await page.getByTestId('run').click()
  const confirm = page.getByTestId('confirm-spend')
  if (await confirm.isVisible().catch(() => false)) await confirm.click()

  await expect(page.getByTestId('ledger')).toContainText('all rendered', { timeout: 60_000 })

  await page.getByTestId('node-img').click()
  await page.getByTestId('node-prompt').fill('bottle on slate')
  await page.getByTestId('node-prompt').blur()

  // Both go stale — the edited node and the clip chained to its hash — and the
  // toolbar names the price of putting it right.
  await expect(page.getByTestId('ledger')).toContainText('2 stale')

  // Nothing re-ran on its own.
  const state = await (await request.get('/api/flow?role=draft')).json()
  expect(state.nodes.img.status).toBe('stale')
  expect(state.nodes.clip.status).toBe('stale')
})

test('refuses a second start frame into one clip, and stores no edge', async ({ page, request }) => {
  // A clip has exactly one frame zero. Two would silently pick one, and the
  // result would read as a model failure rather than a wiring mistake.
  //
  // Note the refusals that are unreachable by construction: a source node
  // renders no target handle at all, so "nothing feeds a source" cannot be
  // attempted here. It is covered as a unit in core/wiring.
  await request.patch('/api/flow', {
    data: {
      nodes: [
        { id: 'a', type: 'image', position: { x: 60, y: 60 }, prompt: 'one', anchors: [], modelRole: 'draft', seed: 1 },
        { id: 'b', type: 'image', position: { x: 60, y: 380 }, prompt: 'two', anchors: [], modelRole: 'draft', seed: 2 },
        { id: 'clip', type: 'video', position: { x: 420, y: 200 }, prompt: 'push in', anchors: [], durationSec: 5, audio: false, modelRole: 'draft', seed: 1 },
      ],
      edges: [],
    },
  })

  await page.goto('/')
  await waitForLedger(page)

  await wire(page, 'a', 'clip', { expectEdge: true })
  await expect
    .poll(async () => (await (await request.get('/api/flow?role=draft')).json()).graph.edges.length)
    .toBe(1)

  await wire(page, 'b', 'clip')

  await expect(page.getByTestId('notice')).toContainText('start frame')
  const state = await (await request.get('/api/flow?role=draft')).json()
  expect(state.graph.edges).toHaveLength(1)
})

test('the draft and hero toggle changes the quoted price without touching a node', async ({
  page,
  request,
}) => {
  await request.patch('/api/flow', {
    data: {
      nodes: [
        { id: 'img', type: 'image', position: { x: 60, y: 80 }, prompt: 'bottle', anchors: [], modelRole: 'draft', seed: 1 },
      ],
      edges: [],
    },
  })

  await page.goto('/')
  await waitForLedger(page)

  const draftLedger = await page.getByTestId('ledger').textContent()
  await page.getByTestId('role-hero').click()
  await expect(page.getByTestId('ledger')).not.toHaveText(draftLedger ?? '')

  // Iterate at one price, render at another — from one switch, not fifty
  // dropdowns, and with the graph untouched.
  const state = await (await request.get('/api/flow?role=draft')).json()
  expect(state.graph.nodes[0].modelRole).toBe('draft')
})

test('dragging a node persists its position and costs nothing', async ({ page, request }) => {
  // Position is not in the input hash. If this regresses, tidying a layout
  // silently re-bills every node that moved.
  await request.patch('/api/flow', {
    data: {
      nodes: [
        { id: 'img', type: 'image', position: { x: 100, y: 100 }, prompt: 'bottle', anchors: [], modelRole: 'draft', seed: 1 },
      ],
      edges: [],
    },
  })

  await page.goto('/')
  await waitForLedger(page)
  await page.getByTestId('run').click()
  const confirm = page.getByTestId('confirm-spend')
  if (await confirm.isVisible().catch(() => false)) await confirm.click()
  await expect(page.getByTestId('ledger')).toContainText('all rendered', { timeout: 60_000 })

  const card = page.getByTestId('node-img')
  const box = (await card.boundingBox())!
  await page.mouse.move(box.x + box.width / 2, box.y + 8)
  await page.mouse.down()
  await page.mouse.move(box.x + 260, box.y + 160, { steps: 12 })
  await page.mouse.up()

  await expect
    .poll(async () => (await (await request.get('/api/flow?role=draft')).json()).graph.nodes[0].position.x)
    .not.toBe(100)

  // Still rendered. Moving a node is free.
  await expect(page.getByTestId('ledger')).toContainText('all rendered')
})
