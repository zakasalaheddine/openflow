import { test, expect } from '@playwright/test'
import { readdirSync, rmSync } from 'node:fs'
import path from 'node:path'
import { resetWorkspace, waitForLedger, graphOf } from './helpers'

test.describe.configure({ mode: 'serial' })

const EXPORTS = path.resolve(import.meta.dirname, '..', '.playwright-exports')

test.beforeEach(async ({ request }) => {
  await resetWorkspace(request)
  rmSync(EXPORTS, { recursive: true, force: true })
})

test('an export that violates a safe zone names the reason and does not ship', async ({
  page,
  request,
}) => {
  await request.patch('/api/flow', {
    data: {
      nodes: [
        { id: 'marble', type: 'image', position: { x: 60, y: 80 }, prompt: 'bottle on marble', modelRole: 'draft', seed: 1, label: 'marble' },
        {
          id: 'out',
          type: 'export',
          position: { x: 420, y: 80 },
          formats: [{ name: '9:16', w: 1080, h: 1920 }],
          // Headline pushed up into the chrome at the top of a vertical
          // placement — the single most common rejection there is.
          overlay: { headline: 'BUY NOW', box: { x: 0.1, y: 0.01, w: 0.8, h: 0.15 } },
        },
      ],
      edges: [{ id: 'e1', from: 'marble', to: 'out', role: 'input', position: null }],
    },
  })

  await page.goto('/')
  await waitForLedger(page)
  await page.getByTestId('run').click()
  await expect(page.getByTestId('ledger')).toContainText('all rendered', { timeout: 30_000 })

  await page.getByTestId('export').click()
  await expect(page.getByTestId('export-result')).toContainText('0 files', { timeout: 30_000 })
  // The reason, in the UI, not just in a log: "refused" without the zone sends
  // someone hunting through a manifest.
  await expect(page.getByTestId('export-refusal')).toContainText('top safe zone')

  // Nothing shipped. Writing the file with a warning beside it is the same as
  // not checking — the rejection just arrives later, from the client.
  expect(readdirSync(EXPORTS).filter((f) => f.endsWith('.png'))).toEqual([])
})

test('moving the headline out of the safe zone lets the same export through', async ({
  page,
  request,
}) => {
  await request.patch('/api/flow', {
    data: {
      nodes: [
        { id: 'marble', type: 'image', position: { x: 60, y: 80 }, prompt: 'bottle on marble', modelRole: 'draft', seed: 1, label: 'marble' },
        {
          id: 'out',
          type: 'export',
          position: { x: 420, y: 80 },
          formats: [{ name: '9:16', w: 1080, h: 1920 }],
          overlay: { headline: 'BUY NOW', box: { x: 0.1, y: 0.01, w: 0.8, h: 0.15 } },
        },
      ],
      edges: [{ id: 'e1', from: 'marble', to: 'out', role: 'input', position: null }],
    },
  })

  await page.goto('/')
  await waitForLedger(page)
  await page.getByTestId('run').click()
  await expect(page.getByTestId('ledger')).toContainText('all rendered', { timeout: 30_000 })

  await page.getByTestId('node-out').click()
  await page.getByTestId('overlay-y').fill('55')
  // The field holds its own text and commits when you leave it, so that a poll
  // landing between two keystrokes cannot put the old value back under the
  // cursor. Typing is not saving; blurring is.
  await page.getByTestId('overlay-y').blur()

  // Wait on the stored graph, not on the field: the commit is fire-and-forget
  // and the 1200ms poll re-seeds the node from the server, so an export fired
  // too early would still be checking the old box.
  await expect
    .poll(async () => {
      const graph = await graphOf(request)
      return graph.nodes.find((n: { id: string }) => n.id === 'out')?.overlay?.box?.y
    }, { timeout: 10_000 })
    .toBeCloseTo(0.55)

  await page.getByTestId('export').click()
  await expect(page.getByTestId('export-result')).toContainText('1 file', { timeout: 30_000 })
  await expect(page.getByTestId('export-refusal')).toHaveCount(0)
})
