import { describe, test, expect } from 'vitest'
import { planRun, enqueueRun, SpendCapExceededError } from '@/core/executor'
import { UnsupportedCapabilityError } from '@/models/registry'
import { nodeRuns, sources, projects, flows } from '@/db/schema'
import { eq } from 'drizzle-orm'
import { tempDb, seedProject, seedSource, seedFlow } from '../helpers/db'
import type { Flow } from '@/core/types'
import { DEFAULT_SETTINGS } from '@/core/settings'

const imageFlow: Flow = {
  nodes: [
    { id: 'bottle', type: 'source', sourceId: 'source-1' },
    { id: 'img', type: 'image', prompt: 'bottle on marble', modelRole: 'draft', seed: 1 },
  ],
  edges: [{ id: 'e1', from: 'bottle', to: 'img', role: 'reference', position: null }],
}

const twoImageFlow: Flow = {
  nodes: [
    { id: 'a', type: 'image', prompt: 'one', modelRole: 'draft', seed: 1 },
    { id: 'b', type: 'image', prompt: 'two', modelRole: 'draft', seed: 2 },
  ],
  edges: [],
}

function setup(graph: Flow, settings = {}) {
  const { db } = tempDb()
  const projectId = seedProject(db, settings)
  seedSource(db, projectId)
  const flowId = seedFlow(db, projectId, graph)
  return { db, projectId, flowId }
}

describe('planRun', () => {
  test('produces one planned node per runnable node', () => {
    const { db, flowId } = setup(twoImageFlow)
    expect(planRun(db, flowId).map((p) => p.nodeId)).toEqual(['a', 'b'])
  })

  test('assigns a stable input hash', () => {
    const { db, flowId } = setup(imageFlow)
    expect(planRun(db, flowId)[0].inputHash).toBe(planRun(db, flowId)[0].inputHash)
  })

  test('bumping a source version changes the planned hash of everything downstream', () => {
    // The stale-propagation feature, asserted through the real code path
    // rather than only against hash.ts in isolation.
    const before = (() => {
      const { db, flowId } = setup(imageFlow)
      return planRun(db, flowId)[0].inputHash
    })()

    const { db, flowId } = setup(imageFlow)
    db.update(sources).set({ version: 2 }).where(eq(sources.id, 'source-1')).run()
    expect(planRun(db, flowId)[0].inputHash).not.toBe(before)
  })

  test('moving a node on the canvas does not change its input hash', () => {
    // End-to-end version of the hashable-config whitelist. If this regresses,
    // tidying a layout silently re-bills every node that was moved.
    const { db, flowId } = setup(imageFlow)
    const before = planRun(db, flowId)[0].inputHash

    const moved: Flow = {
      ...imageFlow,
      nodes: imageFlow.nodes.map((n) =>
        n.id === 'img' ? { ...n, position: { x: 640, y: 480 }, label: 'Hero' } : n,
      ),
    }
    db.update(flows).set({ graphJson: moved }).where(eq(flows.id, flowId)).run()

    expect(planRun(db, flowId)[0].inputHash).toBe(before)
  })

  test('estimates a cost for each node', () => {
    const { db, flowId } = setup(imageFlow)
    expect(planRun(db, flowId)[0].estimatedCents).toBeGreaterThan(0)
  })

  test('refuses an anchor on a model that cannot honour it', () => {
    const graph: Flow = {
      nodes: [
        { id: 'bottle', type: 'source', sourceId: 'source-1' },
        // specialist image row is Recraft, caps.refImages === 0
        { id: 'x', type: 'image', prompt: 'headline', modelRole: 'specialist' },
      ],
      edges: [{ id: 'e1', from: 'bottle', to: 'x', role: 'reference', position: null }],
    }
    const { db, flowId } = setup(graph)
    expect(() => planRun(db, flowId)).toThrow(UnsupportedCapabilityError)
  })

  test('resolves the model by role, so the draft/hero toggle changes the plan', () => {
    const { db, flowId } = setup(imageFlow)
    const draft = planRun(db, flowId)[0]
    const hero = planRun(db, flowId, { role: 'hero' })[0]
    expect(hero.modelId).not.toBe(draft.modelId)
    expect(hero.inputHash).not.toBe(draft.inputHash)
  })
})

describe('enqueueRun', () => {
  test('enqueues one node_run per planned node', () => {
    const { db, flowId } = setup(twoImageFlow)
    enqueueRun(db, flowId)
    expect(db.select().from(nodeRuns).all()).toHaveLength(2)
  })

  test('a queued run starts at status queued with no fal request id', () => {
    const { db, flowId } = setup(imageFlow)
    enqueueRun(db, flowId)
    const [run] = db.select().from(nodeRuns).all()
    expect(run.status).toBe('queued')
    expect(run.falRequestId).toBeNull()
    expect(run.attempt).toBe(0)
  })

  test('a second identical run dispatches nothing', () => {
    // "Second run costs $0" — the cache-hit gate, at the executor level.
    const { db, flowId } = setup(imageFlow)
    enqueueRun(db, flowId)
    const [first] = db.select().from(nodeRuns).all()
    db.update(nodeRuns).set({ status: 'succeeded', costCents: 15 }).where(eq(nodeRuns.id, first.id)).run()

    const result = enqueueRun(db, flowId)
    expect(result.enqueued).toHaveLength(0)
    expect(result.cached).toHaveLength(1)
    expect(db.select().from(nodeRuns).all()).toHaveLength(1)
  })

  test('a failed run is not treated as a cache hit', () => {
    // Only a success may satisfy a hash. Otherwise one content-policy refusal
    // permanently poisons that node and it can never be retried.
    const { db, flowId } = setup(imageFlow)
    enqueueRun(db, flowId)
    const [first] = db.select().from(nodeRuns).all()
    db.update(nodeRuns).set({ status: 'failed' }).where(eq(nodeRuns.id, first.id)).run()

    expect(enqueueRun(db, flowId).enqueued).toHaveLength(1)
  })

  test('does not re-enqueue a node already in flight', () => {
    // Pressing Run twice must not dispatch the same node twice and bill twice.
    const { db, flowId } = setup(imageFlow)
    enqueueRun(db, flowId)
    expect(enqueueRun(db, flowId).enqueued).toHaveLength(0)
    expect(db.select().from(nodeRuns).all()).toHaveLength(1)
  })

  test('blocks when the estimated total exceeds the spend cap', () => {
    const { db, flowId } = setup(twoImageFlow, { spendCapPerRun: 1 })
    expect(() => enqueueRun(db, flowId)).toThrow(SpendCapExceededError)
  })

  test('blocks before writing any run row', () => {
    // Blocking after enqueuing leaves rows a restarted worker would happily
    // pick up and spend against.
    const { db, flowId } = setup(twoImageFlow, { spendCapPerRun: 1 })
    expect(() => enqueueRun(db, flowId)).toThrow()
    expect(db.select().from(nodeRuns).all()).toHaveLength(0)
  })

  test('an explicit confirmation overrides the cap', () => {
    const { db, flowId } = setup(twoImageFlow, { spendCapPerRun: 1 })
    expect(enqueueRun(db, flowId, { confirmOverspend: true }).enqueued).toHaveLength(2)
  })

  test('the cap counts only what would actually be dispatched', () => {
    // A cached node costs nothing, so it must not push a run over the cap.
    const { db, flowId } = setup(twoImageFlow, { spendCapPerRun: 1000 })
    enqueueRun(db, flowId)
    db.update(nodeRuns).set({ status: 'succeeded' }).run()

    // Cap is now below what the two nodes originally cost, but both are cached,
    // so nothing would dispatch and nothing should be blocked.
    db.update(projects).set({ settings: { ...DEFAULT_SETTINGS, spendCapPerRun: 1 } }).run()
    expect(() => enqueueRun(db, flowId)).not.toThrow()
  })
})
