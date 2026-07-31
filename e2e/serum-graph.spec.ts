import { test, expect } from '@playwright/test'
import { resetWorkspace, waitForLedger, wire } from './helpers'

/**
 * THE PHASE 2 GATE, verbatim from the build plan:
 * "you build the 3-image → 9-video serum graph from an empty canvas without
 * touching JSON."
 *
 * Everything here goes through the UI. The moment this spec starts seeding
 * graph_json to save time, it stops testing the thing it exists to test.
 */
test.describe.configure({ mode: 'serial' })

/**
 * THE PHASE 2 GATE — NOT MET, and left failing on purpose.
 *
 * Skipping it would make CI green while the gate is unmet, which is exactly the
 * "reads as covered when it isn't" failure docs/testing-strategy.md warns about.
 * A red build here is the system working: the phase is not done.
 *
 * Symptom: the first wire lands; the second connection gesture in the same page
 * session never starts (React Flow draws no connection line, onConnect never
 * fires). Reloading the page between wires makes all nine land, which pins the
 * fault to client state rather than to wiring, validation or persistence.
 *
 * Ruled out: edge-layer pointer events and z-index, node object identity churn
 * across polls, a poisoned commit promise chain, an auto-fit loop shifting the
 * canvas mid-gesture, controlled-vs-uncontrolled node state, and committing
 * synchronously inside onConnect. Independent node/edge re-seeding got it from
 * "always fails" to "fails on the second wire", so the remaining cause is
 * almost certainly still a re-seed racing the gesture.
 */
test('builds the 3-image to 9-video serum graph from an empty canvas', async ({ page, request }) => {
  test.setTimeout(120_000)
  await resetWorkspace(request)
  await page.goto('/')
  await waitForLedger(page)

  // One anchor, from the rail — the product every shot has to keep identical.
  await page.getByTestId('add-anchor').click()
  const anchorCard = page.locator('[data-testid^="anchor-anchor:"]').first()
  await expect(anchorCard).toBeVisible()

  const scenes = [
    'the serum bottle on a marble counter, soft morning window light',
    'the serum bottle on wet slate, hard directional light',
    'the serum bottle on crumpled linen, diffuse overcast light',
  ]
  const moves = ['slow push in', 'shadow sweep across the label', 'tilt up from base to cap']

  const imageIds: string[] = []

  for (const prompt of scenes) {
    await page.getByTestId('add-image').click()
    const inspector = page.getByTestId('node-prompt')
    await expect(inspector).toBeVisible()
    await inspector.fill(prompt)
    await inspector.blur()

    // Attach the anchor by chip. This is the readability guarantee: it must not
    // create an edge.
    await page.locator('[data-testid^="anchor-chip-anchor:"]').first().click()

    const id = await page.getByTestId('delete-node').evaluate(
      (el) => el.closest('.inspector')?.querySelector('.slate')?.textContent?.split('·').pop()?.trim() ?? '',
    )
    imageIds.push(id)
    await page.keyboard.press('Escape')
  }

  expect(imageIds.filter(Boolean)).toHaveLength(3)

  const videoIds: string[] = []
  for (let i = 0; i < 9; i++) {
    await page.getByTestId('add-video').click()
    const prompt = page.getByTestId('node-prompt')
    await expect(prompt).toBeVisible()
    await prompt.fill(moves[i % 3])
    await prompt.blur()

    const id = await page.getByTestId('delete-node').evaluate(
      (el) => el.closest('.inspector')?.querySelector('.slate')?.textContent?.split('·').pop()?.trim() ?? '',
    )
    videoIds.push(id)
    await page.keyboard.press('Escape')
  }

  expect(videoIds.filter(Boolean)).toHaveLength(9)

  // Wire each image to three clips by dragging between handles. Wait for each
  // edge to land rather than trusting timing — every wire is a round trip
  // through the server, and starting the next drag mid-flight loses it.
  let expected = 0
  for (let image = 0; image < 3; image++) {
    for (let move = 0; move < 3; move++) {
      await wire(page, imageIds[image], videoIds[image * 3 + move], { expectEdge: true })
      expected++
      await expect
        .poll(
          async () => (await (await request.get('/api/flow?role=draft')).json()).graph.edges.length,
          { timeout: 10_000 },
        )
        .toBe(expected)
      await expect(page.locator('.react-flow__edge')).toHaveCount(expected)
    }
  }

  // The assertion that matters: the stored graph, not the pixels.
  const state = await (await request.get('/api/flow?role=draft')).json()
  expect(state.graph.nodes).toHaveLength(12)
  expect(state.graph.edges).toHaveLength(9)
  expect(state.graph.edges.every((e: { role: string }) => e.role === 'start_frame')).toBe(true)

  // Twelve nodes hold one anchor and it added zero edges.
  const anchored = state.graph.nodes.filter((n: { anchors?: string[] }) => (n.anchors ?? []).length > 0)
  expect(anchored.length).toBeGreaterThanOrEqual(3)

  // And it is priced before anything runs.
  await expect(page.getByTestId('ledger')).toContainText('stale')
})

test('renders every node in the graph it just built', async ({ page, request }) => {
  test.setTimeout(180_000)
  await page.goto('/')
  await waitForLedger(page)

  const before = await (await request.get('/api/flow?role=draft')).json()
  test.skip(before.graph.nodes.length === 0, 'depends on the graph built above')

  await page.getByTestId('run').click()

  // The spend cap fires on a twelve-node graph, and confirming is part of the
  // flow rather than something to route around.
  const warning = page.getByTestId('confirm-spend')
  if (await warning.isVisible().catch(() => false)) await warning.click()

  await expect
    .poll(
      async () => {
        const state = await (await request.get('/api/flow?role=draft')).json()
        return Object.values(state.nodes as Record<string, { status: string }>).filter(
          (n) => n.status === 'succeeded',
        ).length
      },
      { timeout: 150_000, intervals: [1000] },
    )
    .toBe(12)

  await expect(page.getByTestId('ledger')).toContainText('all rendered')
})
