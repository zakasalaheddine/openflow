import { test, expect, type APIRequestContext } from '@playwright/test'
import { resetWorkspace, waitForLedger, uploadText } from './helpers'

// Brand voice is the one asset you rewrite rather than re-upload, and it
// composes ahead of every prompt it feeds. So a rewrite is a replacement: the
// source is versioned and everything downstream goes stale.

test.describe.configure({ mode: 'serial' })

test.beforeEach(async ({ request }) => {
  await resetWorkspace(request)
})

const sourceOf = async (request: APIRequestContext) =>
  (await (await request.get('/api/sources')).json()).sources[0]

async function noteOnCanvas(request: APIRequestContext, text: string) {
  const sourceId = await uploadText(request, text)
  await request.patch('/api/flow', {
    data: {
      nodes: [{ id: 'voice', type: 'source', sourceId, position: { x: 60, y: 80 } }],
      edges: [],
    },
  })
  return sourceId
}

test('a note feeding nothing is rewritten in place, with no dialog in the way', async ({
  page,
  request,
}) => {
  await noteOnCanvas(request, 'warm, unfussy, no hard sell')
  await page.goto('/')
  await waitForLedger(page)

  await page.getByTestId('node-text-voice-text').dblclick()
  await page.getByTestId('node-text-voice-input').fill('cold, clinical, evidence first')
  await page.keyboard.press('Meta+Enter')

  // Nothing downstream, so nothing goes stale and nothing costs money. A
  // confirmation here would be a dialog in the way of editing a sentence.
  await expect(page.getByTestId('replace-warning')).toBeHidden()
  await expect(page.getByText('cold, clinical, evidence first')).toBeVisible()

  const source = await sourceOf(request)
  expect(source.text).toBe('cold, clinical, evidence first')
  // Versioned even when free: the hash has to move, or a shot wired up later
  // would be keyed on a version that never saw this wording.
  expect(source.version).toBe(2)
})

test('rewriting a note that feeds shots is priced before it commits', async ({ page, request }) => {
  const sourceId = await noteOnCanvas(request, 'warm, unfussy, no hard sell')
  await request.patch('/api/flow', {
    data: {
      nodes: [
        { id: 'voice', type: 'source', sourceId, position: { x: 40, y: 30 } },
        {
          id: 'marble',
          type: 'image',
          position: { x: 290, y: 30 },
          prompt: 'bottle on marble',
          modelRole: 'draft',
          seed: 4401,
        },
      ],
      edges: [{ id: 'r1', from: 'voice', to: 'marble', role: 'reference', position: null }],
    },
  })

  await page.goto('/')
  await waitForLedger(page)

  await page.getByTestId('node-text-voice-text').dblclick()
  await page.getByTestId('node-text-voice-input').fill('cold, clinical, evidence first')
  await page.keyboard.press('Meta+Enter')

  // §5.3: never silently re-run. One note can invalidate two campaigns.
  await expect(page.getByTestId('replace-warning')).toContainText('1 shot')
  expect((await sourceOf(request)).version).toBe(1)

  await page.getByTestId('confirm-replace').click()
  await expect(page.getByTestId('replace-warning')).toBeHidden()

  const source = await sourceOf(request)
  expect(source.text).toBe('cold, clinical, evidence first')
  expect(source.version).toBe(2)
})

test('cancelling the price leaves the note as it was', async ({ page, request }) => {
  const sourceId = await noteOnCanvas(request, 'warm, unfussy, no hard sell')
  await request.patch('/api/flow', {
    data: {
      nodes: [
        { id: 'voice', type: 'source', sourceId, position: { x: 40, y: 30 } },
        {
          id: 'marble',
          type: 'image',
          position: { x: 290, y: 30 },
          prompt: 'bottle on marble',
          modelRole: 'draft',
          seed: 4402,
        },
      ],
      edges: [{ id: 'r1', from: 'voice', to: 'marble', role: 'reference', position: null }],
    },
  })

  await page.goto('/')
  await waitForLedger(page)

  await page.getByTestId('node-text-voice-text').dblclick()
  await page.getByTestId('node-text-voice-input').fill('cold, clinical, evidence first')
  await page.keyboard.press('Meta+Enter')

  await expect(page.getByTestId('replace-warning')).toBeVisible()
  await page.getByRole('button', { name: 'Cancel' }).click()

  const source = await sourceOf(request)
  expect(source.text).toBe('warm, unfussy, no hard sell')
  expect(source.version).toBe(1)
})

test('Escape abandons the edit and writes nothing', async ({ page, request }) => {
  await noteOnCanvas(request, 'warm, unfussy, no hard sell')
  await page.goto('/')
  await waitForLedger(page)

  await page.getByTestId('node-text-voice-text').dblclick()
  await page.getByTestId('node-text-voice-input').fill('something else entirely')
  await page.keyboard.press('Escape')

  await expect(page.getByText('warm, unfussy, no hard sell')).toBeVisible()
  expect((await sourceOf(request)).version).toBe(1)
})

test('a rewritten note stales the shots it feeds', async ({ page, request }) => {
  const sourceId = await noteOnCanvas(request, 'warm, unfussy, no hard sell')
  await request.patch('/api/flow', {
    data: {
      nodes: [
        { id: 'voice', type: 'source', sourceId, position: { x: 40, y: 30 } },
        {
          id: 'marble',
          type: 'image',
          position: { x: 290, y: 30 },
          prompt: 'bottle on marble',
          modelRole: 'draft',
          seed: 4403,
        },
      ],
      edges: [{ id: 'r1', from: 'voice', to: 'marble', role: 'reference', position: null }],
    },
  })

  await page.goto('/')
  await waitForLedger(page)
  await page.getByTestId('run-marble').click()
  await expect(page.getByTestId('status-marble')).toHaveText('done', { timeout: 30_000 })

  await page.getByTestId('node-text-voice-text').dblclick()
  await page.getByTestId('node-text-voice-input').fill('cold, clinical, evidence first')
  await page.keyboard.press('Meta+Enter')
  await page.getByTestId('confirm-replace').click()

  // The whole point of versioning the source: a shot rendered against the old
  // wording is no longer what its prompt says it is.
  await expect(page.getByTestId('status-marble')).toHaveText('stale')
})

test('editing a note does not disturb prompt editing on a shot', async ({ page, request }) => {
  // Both use the same component now. They must not share state through it.
  const sourceId = await noteOnCanvas(request, 'warm, unfussy, no hard sell')
  await request.patch('/api/flow', {
    data: {
      nodes: [
        { id: 'voice', type: 'source', sourceId, position: { x: 40, y: 30 } },
        {
          id: 'marble',
          type: 'image',
          position: { x: 290, y: 30 },
          prompt: 'bottle on marble',
          modelRole: 'draft',
          seed: 4404,
        },
      ],
      edges: [],
    },
  })

  await page.goto('/')
  await waitForLedger(page)

  await page.getByTestId('node-prompt-text').dblclick()
  await page.getByTestId('node-prompt-input').fill('bottle on wet slate')
  await page.keyboard.press('Meta+Enter')

  await expect(page.getByText('bottle on wet slate')).toBeVisible()
  await expect(page.getByText('warm, unfussy, no hard sell')).toBeVisible()
  expect((await sourceOf(request)).version).toBe(1)
})
