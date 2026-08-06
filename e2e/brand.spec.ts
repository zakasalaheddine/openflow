import { test, expect } from '@playwright/test'
import { resetWorkspace, waitForLedger } from './helpers'

test.beforeEach(async ({ request }) => {
  await resetWorkspace(request)
})

test('the brand profile is written by a person and survives a reload', async ({ page }) => {
  await page.goto('/')
  await waitForLedger(page)

  await page.getByTestId('brand').click()
  await page.getByTestId('brand-profile').fill('Warm, editorial, never clinical.')
  await page.getByTestId('brand-save').click()

  await page.reload()
  await waitForLedger(page)
  await page.getByTestId('brand').click()
  await expect(page.getByTestId('brand-profile')).toHaveValue('Warm, editorial, never clinical.')
})
