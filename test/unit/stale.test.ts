import { describe, test, expect } from 'vitest'
import { eq } from 'drizzle-orm'
import { previewRun, staleForSource } from '@/core/preview'
import { enqueueRun } from '@/core/executor'
import { nodeRuns, sources, flows } from '@/db/schema'
import { tempDb, seedProject, seedSource, seedFlow } from '../helpers/db'
import type { Flow } from '@/core/types'

const anchored = (id: string, prompt: string, modelId = 'flux-2-pro'): Flow['nodes'][number] => ({
  id,
  type: 'image',
  prompt,
  modelId,
})

/** A source node pointing at the seeded library row, plus its reference edge. */
const bottle = (): Flow['nodes'][number] => ({ id: 'bottle', type: 'source', sourceId: 'source-1' })
const refEdge = (to: string) => ({ id: `ref-${to}`, from: 'bottle', to, role: 'reference' as const, position: null })

const chain: Flow = {
  nodes: [
    bottle(),
    anchored('img', 'bottle on marble'),
    { id: 'clip', type: 'video', prompt: 'push in', durationSec: 5, audio: false, modelId: 'hailuo-2-3-pro' },
  ],
  edges: [
    refEdge('img'),
    { id: 'e1', from: 'img', to: 'clip', role: 'start_frame', position: null },
  ],
}

function setup(graph: Flow = chain) {
  const { db } = tempDb()
  const projectId = seedProject(db)
  seedSource(db, projectId)
  const flowId = seedFlow(db, projectId, graph)
  return { db, projectId, flowId }
}

describe('previewRun', () => {
  test('reports every node as stale before anything has run', () => {
    const { db, flowId } = setup()
    const preview = previewRun(db, flowId)
    expect(preview.stale.map((s) => s.nodeId).sort()).toEqual(['clip', 'img'])
    expect(preview.cached).toHaveLength(0)
  })

  test('prices exactly what a run would dispatch', () => {
    // The toolbar and the executor must agree. Two functions computing this
    // separately is how a UI ends up quoting $11.40 and charging $19.
    const { db, flowId } = setup()
    const preview = previewRun(db, flowId)
    const enqueued = enqueueRun(db, flowId, { confirmOverspend: true })

    expect(preview.estimatedCents).toBe(enqueued.estimatedCents)
    expect(preview.stale.map((s) => s.nodeId).sort()).toEqual(
      enqueued.enqueued.map((e) => e.nodeId).sort(),
    )
  })

  test('writes nothing', () => {
    // Hovering the toolbar must not enqueue anything.
    const { db, flowId } = setup()
    previewRun(db, flowId)
    expect(db.select().from(nodeRuns).all()).toHaveLength(0)
  })

  test('drops a node from the stale set once it has succeeded', () => {
    const { db, flowId } = setup()
    enqueueRun(db, flowId, { confirmOverspend: true })
    const first = db.select().from(nodeRuns).all().find((r) => r.nodeId === 'img')!
    db.update(nodeRuns).set({ status: 'succeeded' }).where(eq(nodeRuns.id, first.id)).run()

    const preview = previewRun(db, flowId)
    expect(preview.cached.map((c) => c.nodeId)).toEqual(['img'])
    // `clip` is queued from the same enqueue, so it is in flight rather than
    // stale — money is already committed to it and pressing Run must not
    // dispatch it a second time.
    expect(preview.inFlight.map((s) => s.nodeId)).toEqual(['clip'])
    expect(preview.stale).toHaveLength(0)
  })

  test('a node whose upstream was edited becomes stale again', () => {
    const { db, flowId } = setup()
    enqueueRun(db, flowId, { confirmOverspend: true })
    db.update(nodeRuns).set({ status: 'succeeded' }).run()
    expect(previewRun(db, flowId).stale).toHaveLength(0)

    const edited: Flow = {
      ...chain,
      nodes: chain.nodes.map((n) =>
        n.id === 'img' ? ({ ...n, prompt: 'bottle on slate' } as Flow['nodes'][number]) : n,
      ),
    }
    db.update(flows).set({ graphJson: edited }).where(eq(flows.id, flowId)).run()

    // Both: the edited node, and the clip chained to its hash.
    expect(previewRun(db, flowId).stale.map((s) => s.nodeId).sort()).toEqual(['clip', 'img'])
  })

  test('costs zero when everything is cached', () => {
    const { db, flowId } = setup()
    enqueueRun(db, flowId, { confirmOverspend: true })
    db.update(nodeRuns).set({ status: 'succeeded' }).run()
    expect(previewRun(db, flowId).estimatedCents).toBe(0)
  })

  test('prices each node by its own model, so the expensive one is visibly expensive', () => {
    // What makes a comparison legible before you pay for it: the same shot on
    // two models is two prices on two cards, not one number for the board.
    const cheap = setup({ nodes: [bottle(), anchored('img', 'marble')], edges: [refEdge('img')] })
    const rich = setup({
      nodes: [bottle(), anchored('img', 'marble', 'nano-banana-pro')],
      edges: [refEdge('img')],
    })
    expect(previewRun(rich.db, rich.flowId).estimatedCents).toBeGreaterThan(
      previewRun(cheap.db, cheap.flowId).estimatedCents,
    )
  })

  test('reports the subtree cost of a single branch, not the whole graph', () => {
    // Total spend is too coarse when one branch is three video renders.
    const fan: Flow = {
      nodes: [
        bottle(),
        anchored('img', 'bottle'),
        { id: 'c1', type: 'video', prompt: 'a', durationSec: 5, audio: false, modelId: 'hailuo-2-3-pro' },
        { id: 'c2', type: 'video', prompt: 'b', durationSec: 5, audio: false, modelId: 'hailuo-2-3-pro' },
        anchored('other', 'unrelated'),
      ],
      edges: [
        refEdge('img'),
        { id: 'e1', from: 'img', to: 'c1', role: 'start_frame', position: null },
        { id: 'e2', from: 'img', to: 'c2', role: 'start_frame', position: null },
      ],
    }
    const { db, flowId } = setup(fan)
    const preview = previewRun(db, flowId)

    const subtree = preview.subtreeCents('img')
    expect(subtree.nodeCount).toBe(2)
    expect(subtree.cents).toBeLessThan(preview.estimatedCents)
    expect(preview.subtreeCents('other').nodeCount).toBe(0)
  })
})

describe('staleForSource', () => {
  test('finds nodes holding the anchor, plus their descendants', () => {
    const { db, projectId } = setup()
    const affected = staleForSource(db, projectId, 'source-1')
    expect(affected.map((a) => a.nodeId).sort()).toEqual(['clip', 'img'])
  })

  test('spans every flow in the project', () => {
    // Bumping an anchor greys nodes across two campaigns. A per-flow walk finds
    // only half of them, and the toolbar under-quotes the refresh.
    const { db, projectId } = setup()
    seedFlow(
      db,
      projectId,
      {
        nodes: [{ id: 'bottle', type: 'source', sourceId: 'source-1' }, anchored('other-img', 'second campaign')],
        edges: [{ id: 'r2', from: 'bottle', to: 'other-img', role: 'reference', position: null }],
      },
      'flow-2',
    )

    const affected = staleForSource(db, projectId, 'source-1')
    expect(affected.map((a) => a.nodeId).sort()).toEqual(['clip', 'img', 'other-img'])
    expect(new Set(affected.map((a) => a.flowId)).size).toBe(2)
  })

  test('ignores nodes that do not hold the anchor', () => {
    const { db, projectId, flowId } = setup()
    db.update(flows)
      .set({ graphJson: { nodes: [anchored('img', 'x')], edges: [] } })
      .where(eq(flows.id, flowId))
      .run()

    expect(staleForSource(db, projectId, 'source-1')).toHaveLength(0)
  })

  test('prices the refresh', () => {
    const { db, projectId } = setup()
    const affected = staleForSource(db, projectId, 'source-1')
    expect(affected.reduce((sum, a) => sum + a.estimatedCents, 0)).toBeGreaterThan(0)
  })

  test('returns nothing for an anchor no node uses', () => {
    const { db, projectId } = setup()
    seedSource(db, projectId, 'unused-source')
    expect(staleForSource(db, projectId, 'unused-source')).toHaveLength(0)
  })

  test('does not bump the version itself', () => {
    // Previewing the blast radius must be free of side effects.
    const { db, projectId } = setup()
    staleForSource(db, projectId, 'source-1')
    expect(db.select().from(sources).where(eq(sources.id, 'source-1')).get()?.version).toBe(1)
  })
})
