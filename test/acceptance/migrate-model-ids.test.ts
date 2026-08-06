import { describe, test, expect } from 'vitest'
import { eq } from 'drizzle-orm'
import { flows, nodeRuns } from '@/db/schema'
import { previewRun } from '@/core/preview'
import { tempDb, seedProject, seedSource, seedFlow } from '../helpers/db'
import { migrateModelIds } from '../../bin/migrate-model-ids'
import type { Flow } from '@/core/types'

/**
 * The graph as it was written before the swap. Typed loosely on purpose: the
 * whole point of the migration is that this shape no longer type-checks, and a
 * test that could only build the current shape would prove nothing.
 */
const oldGraph = {
  nodes: [
    { id: 'bottle', type: 'source', sourceId: 'source-1' },
    { id: 'marble', type: 'image', prompt: 'bottle on marble', modelRole: 'draft', seed: 1 },
    { id: 'slate', type: 'image', prompt: 'bottle on slate', modelRole: 'hero', seed: 2 },
  ],
  edges: [
    { id: 'e1', from: 'bottle', to: 'marble', role: 'reference', position: null },
    { id: 'e2', from: 'bottle', to: 'slate', role: 'reference', position: null },
  ],
} as unknown as Flow

/**
 * The hashes those two nodes were actually rendered under, as literals.
 *
 * Computed independently of the script — `{ prompt, modelRole }` in the config,
 * the role's resolved id as `modelId`, chained through the source node's hash —
 * so this test fails if the frozen copy inside the migration ever drifts from
 * the shape the database was written with. Deriving them from the script would
 * make both sides wrong together and the test pass anyway.
 */
const OLD_HASH = {
  marble: 'd4c01e3f3d52be3580fc34ab501e7966249e5571153e2589b4b99db4e77955bb',
  slate: 'a945a21afc98850410ad45018d51a48a496ef0bfd5f05edb72d0ea2e5630e5c0',
}

const seedRun = (db: ReturnType<typeof tempDb>['db'], nodeId: string, inputHash: string, modelId: string) =>
  db
    .insert(nodeRuns)
    .values({
      id: `run-${nodeId}`,
      flowId: 'flow-1',
      nodeId,
      inputHash,
      status: 'succeeded',
      modelId,
      costCents: 300,
      outputRefs: [],
      createdAt: new Date().toISOString(),
    })
    .run()

function setup() {
  const { db } = tempDb()
  const projectId = seedProject(db)
  seedSource(db, projectId)
  seedFlow(db, projectId, oldGraph)
  return { db, projectId }
}

describe('migrate:model-ids', () => {
  test('rewrites the graph to model ids, keeping the model each role resolved to', () => {
    const { db } = setup()
    const result = migrateModelIds(db)

    const graph = db.select().from(flows).where(eq(flows.id, 'flow-1')).get()!.graphJson as Flow
    expect(graph.nodes.map((n) => ('modelId' in n ? n.modelId : n.type))).toEqual([
      'source',
      'flux-2-pro',
      'nano-banana-pro',
    ])
    expect(graph.nodes.some((n) => 'modelRole' in n)).toBe(false)
    expect(result.nodes).toBe(2)
  })

  test('a render that was paid for is still claimed afterwards', () => {
    const { db } = setup()
    // The run rows have to carry the OLD hash, or the migration has nothing to
    // find — which is the failure mode the whole script exists to prevent.
    seedRun(db, 'marble', OLD_HASH.marble, 'flux-2-pro')
    seedRun(db, 'slate', OLD_HASH.slate, 'nano-banana-pro')

    const result = migrateModelIds(db)
    expect(result.runs).toBe(2)

    // The real assertion: nothing is stale, so the next Run spends nothing.
    const preview = previewRun(db, 'flow-1')
    expect(preview.stale).toEqual([])
    expect(preview.estimatedCents).toBe(0)
  })

  test('a second run rewrites nothing', () => {
    const { db } = setup()
    migrateModelIds(db)
    expect(migrateModelIds(db)).toMatchObject({ nodes: 0, runs: 0 })
  })

  test('a run whose node was edited since keeps its old hash, and is counted out loud', () => {
    const { db } = setup()
    seedRun(db, 'marble', OLD_HASH.marble, 'flux-2-pro')
    // A render of a prompt nobody has any more: paid for, and not findable.
    seedRun(db, 'slate', 'a'.repeat(64), 'nano-banana-pro')

    const result = migrateModelIds(db)
    expect(result.runs).toBe(1)
    expect(
      db.select().from(nodeRuns).where(eq(nodeRuns.nodeId, 'slate')).get()!.inputHash,
    ).toBe('a'.repeat(64))
  })
})
