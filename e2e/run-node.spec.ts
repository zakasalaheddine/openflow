import { test, expect, type APIRequestContext } from '@playwright/test'
import { resetWorkspace, setGraph, waitForLedger } from './helpers'

// Reviewing one shot is not committing to twelve. A card renders itself and
// whatever upstream it still needs — and nothing beside it.

test.describe.configure({ mode: 'serial' })

/**
 * One server and one database serve every spec, and a hash that has already
 * succeeded is served from cache forever. `take` shifts every seed, so each
 * test starts from shots that have genuinely never been rendered.
 */
async function callSheet(request: APIRequestContext, take: number) {
  await resetWorkspace(request)
  await setGraph(request, {
      nodes: [
        { id: 'marble', type: 'image', position: { x: 60, y: 80 }, prompt: 'bottle on marble', modelId: 'flux-2-pro', seed: take * 100 + 1 },
        { id: 'slate', type: 'image', position: { x: 320, y: 80 }, prompt: 'bottle on slate', modelId: 'flux-2-pro', seed: take * 100 + 2 },
        { id: 'turn', type: 'video', position: { x: 580, y: 80 }, prompt: 'slow turn', durationSec: 5, audio: false, modelId: 'hailuo-2-3-pro', seed: take * 100 + 3 },
      ],
      edges: [{ id: 'g1', from: 'marble', to: 'turn', role: 'start_frame', position: null }],
    })
}

test('a card renders on its own and leaves the rest of the call sheet alone', async ({ page, request }) => {
  await callSheet(request, 1)
  await page.goto('/')
  await waitForLedger(page)

  await page.getByTestId('run-slate').click()

  await expect(page.getByTestId('status-slate')).toHaveText('done', { timeout: 30_000 })
  await expect(page.getByTestId('status-marble')).toHaveText('stale')
  await expect(page.getByTestId('status-turn')).toHaveText('stale')
})

test('running a clip pulls in the frame it is cut from', async ({ page, request }) => {
  // Not the clip alone: a start frame that was never rendered would dispatch as
  // text-to-video and be billed in full for an anchor it never saw.
  await callSheet(request, 2)
  await page.goto('/')
  await waitForLedger(page)

  await page.getByTestId('run-turn').click()

  await expect(page.getByTestId('status-marble')).toHaveText('done', { timeout: 30_000 })
  await expect(page.getByTestId('status-turn')).toHaveText('done', { timeout: 30_000 })
  await expect(page.getByTestId('status-slate')).toHaveText('stale')
})

test('a rendered card cannot be run again by accident', async ({ page, request }) => {
  await callSheet(request, 3)
  await page.goto('/')
  await waitForLedger(page)

  await expect(page.getByTestId('run-slate')).toBeEnabled()
  await page.getByTestId('run-slate').click()

  await expect(page.getByTestId('status-slate')).toHaveText('done', { timeout: 30_000 })
  await expect(page.getByTestId('run-slate')).toBeDisabled()
})
