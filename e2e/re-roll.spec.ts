import { test, expect } from '@playwright/test'
import { resetWorkspace, setGraph, waitForLedger, graphOf } from './helpers'

test.describe.configure({ mode: 'serial' })

test.beforeEach(async ({ request }) => {
  await resetWorkspace(request)
  await setGraph(request, {
      nodes: [
        { id: 'marble', type: 'image', position: { x: 60, y: 80 }, prompt: 'bottle on marble', modelId: 'flux-2-pro', seed: 7 },
      ],
      edges: [],
    })
})

test('re-roll keeps the prompt and changes the seed', async ({ page, request }) => {
  await page.goto('/')
  await waitForLedger(page)

  await page.getByTestId('node-marble').click()
  await page.getByTestId('reroll').click()

  await expect
    .poll(async () => (await graphOf(request)).nodes[0].seed, { timeout: 10_000 })
    .not.toBe(7)
  expect((await graphOf(request)).nodes[0].prompt).toBe('bottle on marble')
})

test('editing the prompt changes the direction, and stales the shot', async ({ page, request }) => {
  // The two read differently on purpose. Confusing them means re-rolling a bad
  // idea forever, or losing a good frame to a typo fix.
  await page.goto('/')
  await waitForLedger(page)

  await page.getByTestId('node-prompt-text').dblclick()
  await page.getByTestId('node-prompt-input').fill('bottle on slate')
  // Blur, not Enter: the card commits when the field loses focus.
  await page.getByTestId('node-prompt-input').blur()

  await expect
    .poll(async () => (await graphOf(request)).nodes[0].prompt, { timeout: 10_000 })
    .toBe('bottle on slate')
  expect((await graphOf(request)).nodes[0].seed).toBe(7)
  await expect(page.getByTestId('ledger')).toContainText('stale')
})
