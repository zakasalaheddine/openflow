import { test, expect } from '@playwright/test'
import { resetWorkspace, setGraph, waitForLedger, uploadSource, uploadText, wire, graphOf, PNG } from './helpers'

test.describe.configure({ mode: 'serial' })

test.beforeEach(async ({ request }) => {
  await resetWorkspace(request)
})

test('an uploaded asset becomes a node on the canvas', async ({ page, request }) => {
  const sourceId = await uploadSource(request)
  await setGraph(request, {
      nodes: [{ id: 'bottle', type: 'source', sourceId, position: { x: 60, y: 80 } }],
      edges: [],
    })

  await page.goto('/')
  await waitForLedger(page)

  await expect(page.getByTestId('node-bottle')).toBeVisible()
  await expect(page.getByTestId('version-bottle')).toHaveText('v1')
})

test('one asset feeds many shots, each wire a reference', async ({ page, request }) => {
  // Twelve shots on one product is the normal case. The readability answer is
  // how the edges are drawn, never a cap on how many there may be.
  const sourceId = await uploadSource(request)
  await setGraph(request, {
      nodes: [
        { id: 'bottle', type: 'source', sourceId, position: { x: 40, y: 200 } },
        { id: 'marble', type: 'image', position: { x: 360, y: 20 }, prompt: 'on marble', modelRole: 'draft', seed: 1 },
        { id: 'slate', type: 'image', position: { x: 360, y: 300 }, prompt: 'on slate', modelRole: 'draft', seed: 2 },
        { id: 'linen', type: 'image', position: { x: 360, y: 580 }, prompt: 'on linen', modelRole: 'draft', seed: 3 },
      ],
      edges: [],
    })

  await page.goto('/')
  await waitForLedger(page)

  for (const shot of ['marble', 'slate', 'linen']) await wire(page, 'bottle', shot)

  const graph = await graphOf(request)
  expect(graph.edges).toHaveLength(3)
  expect(graph.edges.every((e: { role: string }) => e.role === 'reference')).toBe(true)
})

test('reference edges can be taken off screen, and the toolbar says how many', async ({
  page,
  request,
}) => {
  // A hidden edge that looks like no edge is how someone concludes a connection
  // vanished, so the count is always on screen.
  const sourceId = await uploadSource(request)
  await setGraph(request, {
      nodes: [
        { id: 'bottle', type: 'source', sourceId, position: { x: 40, y: 80 } },
        { id: 'marble', type: 'image', position: { x: 360, y: 20 }, prompt: 'on marble', modelRole: 'draft', seed: 1 },
        { id: 'clip', type: 'video', position: { x: 680, y: 20 }, prompt: 'push in', durationSec: 5, audio: false, modelRole: 'draft', seed: 1 },
      ],
      edges: [
        { id: 'r1', from: 'bottle', to: 'marble', role: 'reference', position: null },
        { id: 'g1', from: 'marble', to: 'clip', role: 'start_frame', position: null },
      ],
    })

  await page.goto('/')
  await waitForLedger(page)
  await expect(page.locator('.react-flow__edge')).toHaveCount(2)

  await page.getByTestId('toggle-refs').click()

  // The generation edge — the spine of the graph — stays.
  await expect(page.locator('.react-flow__edge')).toHaveCount(1)
  await expect(page.locator('.edge--generation')).toHaveCount(1)
  await expect(page.getByTestId('toggle-refs')).toContainText('1 refs hidden')

  await page.getByTestId('toggle-refs').click()
  await expect(page.locator('.react-flow__edge')).toHaveCount(2)
})

test('hovering an asset lights up everything it feeds', async ({ page, request }) => {
  // The thing the chip design could never do: see what a product touches.
  const sourceId = await uploadSource(request)
  await setGraph(request, {
      nodes: [
        { id: 'bottle', type: 'source', sourceId, position: { x: 40, y: 80 } },
        { id: 'marble', type: 'image', position: { x: 360, y: 20 }, prompt: 'on marble', modelRole: 'draft', seed: 1 },
        { id: 'other', type: 'image', position: { x: 360, y: 320 }, prompt: 'unrelated', modelRole: 'draft', seed: 2 },
      ],
      edges: [{ id: 'r1', from: 'bottle', to: 'marble', role: 'reference', position: null }],
    })

  await page.goto('/')
  await waitForLedger(page)

  await page.getByTestId('node-bottle').hover()
  await expect(page.locator('.react-flow__node.lit')).toHaveCount(1)
  await expect(page.locator('.react-flow__node.lit [data-testid="node-marble"]')).toBeVisible()
})

test('replacing an asset prices the blast radius before committing', async ({ page, request }) => {
  const sourceId = await uploadSource(request)
  await setGraph(request, {
      nodes: [
        { id: 'bottle', type: 'source', sourceId, position: { x: 40, y: 80 } },
        { id: 'marble', type: 'image', position: { x: 360, y: 20 }, prompt: 'on marble', modelRole: 'draft', seed: 1 },
        { id: 'clip', type: 'video', position: { x: 680, y: 20 }, prompt: 'push in', durationSec: 5, audio: false, modelRole: 'draft', seed: 1 },
      ],
      edges: [
        { id: 'r1', from: 'bottle', to: 'marble', role: 'reference', position: null },
        { id: 'g1', from: 'marble', to: 'clip', role: 'start_frame', position: null },
      ],
    })

  await page.goto('/')
  await waitForLedger(page)
  await page.getByTestId('replace-bottle').click()

  // The shot referencing it, and the clip chained to that shot. The asset node
  // itself is not a shot and costs nothing, so it is not counted.
  const banner = page.getByRole('alertdialog', { name: 'Confirm replacement' })
  await expect(banner).toContainText('2 shots')
  await expect(banner).toContainText('$')

  await banner.getByText('Cancel').click()
  await expect(page.getByTestId('version-bottle')).toHaveText('v1')

  await page.getByTestId('replace-bottle').click()
  await page.getByTestId('replace-input').setInputFiles({
    name: 'new.png',
    mimeType: 'image/png',
    buffer: PNG,
  })
  await expect(page.getByTestId('version-bottle')).toHaveText('v2')
})

test('a text asset composes ahead of the shot prompt', async ({ page, request }) => {
  const voice = await uploadText(request, 'warm, unfussy, no hard sell')
  await setGraph(request, {
      nodes: [
        { id: 'tone', type: 'source', sourceId: voice, position: { x: 40, y: 80 } },
        { id: 'marble', type: 'image', position: { x: 360, y: 20 }, prompt: 'a serum bottle on marble', modelRole: 'draft', seed: 1 },
      ],
      edges: [{ id: 'r1', from: 'tone', to: 'marble', role: 'reference', position: null }],
    })

  await page.goto('/')
  await waitForLedger(page)

  await expect(page.getByTestId('node-tone')).toContainText('warm, unfussy')
  // Composition is asserted as a unit in core/compose; here the point is only
  // that a text asset is a first-class node you can see and wire.
  const graph = await graphOf(request)
  expect(graph.edges[0].role).toBe('reference')
})

test('double-clicking a prompt edits it in place and stales the shot', async ({ page, request }) => {
  await setGraph(request, {
      nodes: [
        { id: 'marble', type: 'image', position: { x: 60, y: 60 }, prompt: 'on marble', modelRole: 'draft', seed: 1 },
      ],
      edges: [],
    })

  await page.goto('/')
  await waitForLedger(page)
  await page.getByTestId('run').click()
  const confirm = page.getByTestId('confirm-spend')
  if (await confirm.isVisible().catch(() => false)) await confirm.click()
  await expect(page.getByTestId('ledger')).toContainText('all rendered', { timeout: 60_000 })

  await page.getByTestId('node-prompt-text').dblclick()
  await page.getByTestId('node-prompt-input').fill('on wet slate')
  await page.getByTestId('node-prompt-input').blur()

  await expect(page.getByTestId('ledger')).toContainText('1 stale')
  expect((await graphOf(request)).nodes[0].prompt).toBe('on wet slate')
})

test('refuses a sixth reference into a model that accepts four', async ({ page, request }) => {
  // flux-2-pro, the draft image row, honours four reference images. A fifth is
  // refused at wiring time — accepting it and dropping it at render time bills
  // for output that ignored the asset.
  //
  // Note the Draft/Hero toggle overrides every node's own modelRole, so a
  // node marked `specialist` still resolves to the draft row here. That is what
  // the toggle is for, and it is why this spec tests the count rather than the
  // capability flag.
  const ids = []
  for (let i = 0; i < 5; i++) ids.push(await uploadSource(request, `ref-${i}.png`))

  await setGraph(request, {
      nodes: [
        ...ids.map((sourceId, i) => ({
          id: `asset-${i}`,
          type: 'source',
          sourceId,
          position: { x: 40, y: 20 + i * 150 },
        })),
        { id: 'marble', type: 'image', position: { x: 420, y: 300 }, prompt: 'on marble', modelRole: 'draft', seed: 1 },
      ],
      edges: ids.slice(0, 4).map((_, i) => ({
        id: `r${i}`,
        from: `asset-${i}`,
        to: 'marble',
        role: 'reference',
        position: null,
      })),
    })

  await page.goto('/')
  await waitForLedger(page)
  await expect(page.locator('.react-flow__edge')).toHaveCount(4)

  await wire(page, 'asset-4', 'marble', { expectEdge: false })

  await expect(page.getByTestId('notice')).toBeVisible()
  expect((await graphOf(request)).edges).toHaveLength(4)
})
