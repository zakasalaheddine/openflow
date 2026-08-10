import { test, expect } from '@playwright/test'
import { resetWorkspace, setGraph, waitForLedger } from './helpers'

test.describe.configure({ mode: 'serial' })

/** One rendered shot, downloaded through the dialog rather than an export node. */
const marbleShot = () => ({
  nodes: [
    {
      id: 'marble',
      type: 'image',
      position: { x: 60, y: 80 },
      prompt: 'bottle on marble',
      modelId: 'flux-2-pro',
      seed: 1,
      label: 'marble',
    },
  ],
  edges: [],
})

async function rendered(page: import('@playwright/test').Page) {
  await page.goto('/')
  await waitForLedger(page)
  await page.getByTestId('run').click()
  await expect(page.getByTestId('ledger')).toContainText('all rendered', { timeout: 30_000 })
}

test.beforeEach(async ({ request }) => {
  await resetWorkspace(request)
})

test('a headline that violates a safe zone names the reason and does not ship', async ({
  page,
  request,
}) => {
  await setGraph(request, marbleShot())
  await rendered(page)

  await page.getByTestId('download-marble').click()
  await page.getByTestId('download-headline').fill('BUY NOW')
  // Pushed into the chrome at the top of a vertical placement — the single
  // most common rejection there is. `DEFAULT_TEXT_BOX` passes on its own (see
  // test/unit/spec-validation.test.ts's "text inside the safe zone passes"),
  // so the box has to move for this to be a real refusal.
  await page.getByTestId('download-box-y').fill('1')

  await expect(page.getByTestId('download-format-9:16')).toBeDisabled()
  // The reason, in the dialog, not just in a log: "refused" without the zone
  // sends someone hunting through a manifest.
  await expect(page.getByTestId('download-dialog')).toContainText('top safe zone')

  // Nothing can ship. Downloading anyway with a warning beside it is the same
  // as not checking — the rejection just arrives later, from the client.
  await expect(page.getByTestId('download-confirm')).toBeDisabled()
})

test('moving the headline out of the safe zone lets the same download through', async ({
  page,
  request,
}) => {
  await setGraph(request, marbleShot())
  await rendered(page)

  await page.getByTestId('download-marble').click()
  await page.getByTestId('download-headline').fill('BUY NOW')
  await page.getByTestId('download-box-y').fill('1')
  await expect(page.getByTestId('download-format-9:16')).toBeDisabled()

  // Same headline, same dialog session: only the box moves, back into the
  // frame's default safe position.
  await page.getByTestId('download-box-y').fill('55')
  await expect(page.getByTestId('download-format-9:16')).toBeEnabled()
  await expect(page.getByTestId('download-format-9:16')).toBeChecked()
  await expect(page.getByTestId('download-dialog')).not.toContainText('top safe zone')

  // Both formats pass now, so this ships as a zip rather than a bare file —
  // the point is that it ships at all, where a moment ago it could not.
  const [download] = await Promise.all([
    page.waitForEvent('download'),
    page.getByTestId('download-confirm').click(),
  ])
  expect(download.suggestedFilename()).toMatch(/\.zip$/)
})
