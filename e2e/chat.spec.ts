import { test, expect } from '@playwright/test'
import { resetWorkspace, waitForLedger } from './helpers'

test.beforeEach(async ({ request }) => {
  await resetWorkspace(request)
  // The recorded fixture is keyed to the whole request, brand profile
  // included. brand.spec.ts leaves one saved on the shared server this suite
  // runs against, so this spec has to put it back to empty rather than
  // inherit whatever the alphabetically-earlier spec left behind.
  await request.patch('/api/brief', { data: { brandProfile: '' } })
})

test('the agent puts a node on the canvas, and renders nothing', async ({ page }) => {
  await page.goto('/')

  // The brief bar is gone; chat is the one way to talk to a model.
  await expect(page.getByTestId('brief')).toHaveCount(0)
  await expect(page.getByTestId('chat')).toBeVisible()

  await page.getByTestId('chat-input').fill('add a hero shot of the serum on marble')
  await page.getByTestId('chat-send').click()

  // The canvas polls graph_json, so the card arrives without a reload.
  await expect(page.locator('.react-flow__node')).toHaveCount(1, { timeout: 15_000 })
  await expect(page.getByTestId('chat-log')).toContainText(/run/i)

  // The real assertion: the agent authors, it never dispatches. A chat turn
  // that rendered anything would show up here as spend or a non-stale ledger.
  await waitForLedger(page)
  await expect(page.getByTestId('ledger')).toContainText('stale')
})
