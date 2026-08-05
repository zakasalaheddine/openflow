import { test, expect } from '@playwright/test'
import { resetWorkspace, setGraph, waitForLedger, wire, graphOf } from './helpers'

test.describe.configure({ mode: 'serial' })

test.beforeEach(async ({ request }) => {
  await resetWorkspace(request)
})

const shotAndClip = {
  nodes: [
    { id: 'marble', type: 'image', position: { x: 60, y: 200 }, prompt: 'bottle on marble', modelRole: 'draft', seed: 1 },
    { id: 'turn', type: 'video', position: { x: 420, y: 200 }, prompt: 'the bottle turning', durationSec: 5, audio: false, modelRole: 'draft', seed: 2 },
  ],
  edges: [],
}

test('an image wired into a clip becomes its start frame', async ({ page, request }) => {
  // Not a dialog asking what the edge means: an image feeding a video is that
  // image being frame zero, and there is nothing else it could reasonably be.
  await setGraph(request, shotAndClip)

  await page.goto('/')
  await waitForLedger(page)
  await wire(page, 'marble', 'turn')

  const graph = await graphOf(request)
  expect(graph.edges).toHaveLength(1)
  expect(graph.edges[0]).toMatchObject({ from: 'marble', to: 'turn', role: 'start_frame' })
})

test('alt-clicking a shot spawns a pre-wired sibling with the previous prompt', async ({
  page,
  request,
}) => {
  await setGraph(request, shotAndClip)

  await page.goto('/')
  await waitForLedger(page)
  await wire(page, 'marble', 'turn')

  await page.getByTestId('node-marble').click({ modifiers: ['Alt'] });

  await expect
    .poll(async () => (await graphOf(request)).nodes.length, { timeout: 10_000 })
    .toBe(3)

  const graph = await graphOf(request)
  const clips = graph.nodes.filter((n: { type: string }) => n.type === 'video')
  const spawned = clips.find((n: { id: string }) => n.id !== 'turn')!

  // The same direction with one word changed is the normal edit; retyping it
  // for the ninth clip is where a canvas starts to feel like a chore.
  expect(spawned.prompt).toBe('the bottle turning')
  // A fresh seed — an identical sibling is a re-roll, not a fan-out.
  expect(spawned.seed).not.toBe(2)

  const wired = graph.edges.find((e: { to: string }) => e.to === spawned.id)
  expect(wired).toMatchObject({ from: 'marble', role: 'start_frame' })
})

test('a second start frame into the same clip is refused', async ({ page, request }) => {
  // Two frame zeros would silently pick one, and the clip that came back would
  // look like a model failure.
  await setGraph(request, {
      nodes: [
        ...shotAndClip.nodes,
        { id: 'slate', type: 'image', position: { x: 60, y: 480 }, prompt: 'bottle on slate', modelRole: 'draft', seed: 3 },
      ],
      edges: [],
    })

  await page.goto('/')
  await waitForLedger(page)
  await wire(page, 'marble', 'turn')
  await wire(page, 'slate', 'turn', { expectEdge: false })

  await expect(page.getByTestId('notice')).toContainText('already has a start frame')
  expect((await graphOf(request)).edges).toHaveLength(1)
})
