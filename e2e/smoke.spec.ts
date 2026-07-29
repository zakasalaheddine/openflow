import { test, expect } from '@playwright/test'

// The suite exists from day one so `npm test` has a non-zero-spec Playwright
// run to make. Real specs land in Phase 2 when there is a canvas to drive.
test('app boots and serves the shell', async ({ page }) => {
  const response = await page.goto('/')
  expect(response?.status()).toBe(200)
  await expect(page.getByRole('heading', { name: 'OpenFlow' })).toBeVisible()
})
