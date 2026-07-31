import { test, expect } from '@playwright/test'
import { resetWorkspace, waitForLedger, graphOf } from './helpers'

test.describe.configure({ mode: 'serial' })

const PROFILE = 'Warm, editorial, never clinical.'
const BRIEF = 'Launch the serum. Three scenes for a feed test.'

test.beforeEach(async ({ request }) => {
  await resetWorkspace(request)
})

test('a brief plus a confirmed brand profile produces a valid graph', async ({ page, request }) => {
  await page.goto('/')
  await waitForLedger(page)

  await page.getByTestId('brief').click()
  await page.getByTestId('brand-profile').fill(PROFILE)
  await page.getByTestId('brief-text').fill(BRIEF)
  await page.getByTestId('brief-submit').click()

  await expect
    .poll(async () => (await graphOf(request)).nodes.length, { timeout: 15_000 })
    .toBeGreaterThan(0)

  const graph = await graphOf(request)
  // The model filled a template; it did not invent topology.
  expect(graph.nodes.filter((n: { type: string }) => n.type === 'image')).toHaveLength(3)
  expect(graph.nodes.some((n: { type: string }) => n.type === 'export')).toBe(true)
  for (const node of graph.nodes) {
    if ('prompt' in node) expect(node.prompt).not.toContain('{{')
  }

  // Nothing rendered. What comes back is a starting point, and Run stays a
  // deliberate act — a brief that silently dispatched would bill for a guess.
  await expect(page.getByTestId('ledger')).toContainText('stale')
})

test('every generated node is editable afterwards', async ({ page, request }) => {
  await page.goto('/')
  await waitForLedger(page)

  await page.getByTestId('brief').click()
  await page.getByTestId('brand-profile').fill(PROFILE)
  await page.getByTestId('brief-text').fill(BRIEF)
  await page.getByTestId('brief-submit').click()

  await expect
    .poll(async () => (await graphOf(request)).nodes.length, { timeout: 15_000 })
    .toBeGreaterThan(0)

  await page.getByTestId('node-prompt-text').first().dblclick()
  await page.getByTestId('node-prompt-input').fill('the bottle on brushed steel')
  await page.getByTestId('node-prompt-input').blur()

  await expect
    .poll(
      async () =>
        (await graphOf(request)).nodes.some(
          (n: { prompt?: string }) => n.prompt === 'the bottle on brushed steel',
        ),
      { timeout: 10_000 },
    )
    .toBe(true)
})

test('the brand profile survives and is offered back next time', async ({ page }) => {
  // It is a thing a person confirmed about their brand, not a per-brief field.
  await page.goto('/')
  await waitForLedger(page)

  await page.getByTestId('brief').click()
  await page.getByTestId('brand-profile').fill(PROFILE)
  await page.getByTestId('brief-text').fill(BRIEF)
  await page.getByTestId('brief-submit').click()
  await expect(page.getByTestId('brief-text')).toHaveCount(0, { timeout: 15_000 })

  await page.getByTestId('brief').click()
  await expect(page.getByTestId('brand-profile')).toHaveValue(PROFILE)
})
