import { describe, test, expect } from 'vitest'
import { existsSync } from 'node:fs'
import path from 'node:path'
import { exportFlow } from '@/core/exporter'
import { probe } from '@/core/ffmpeg'
import { planRun, enqueueRun } from '@/core/executor'
import { tick } from '@/worker/loop'
import { createAdapter } from '@/models/fal'
import { reorderSequence } from '@/core/wiring'
import { flows } from '@/db/schema'
import { eq } from 'drizzle-orm'
import type { Flow } from '@/core/types'
import { tempDb, seedProject, seedFlow } from '../helpers/db'
import { tempExportDir, seedRenderedNode, STUB_MP4 } from '../helpers/exports'

// A film, not a folder of clips. Everything here is about the one thing a cut
// has that a node does not: an order, and a total that must not double-count.

const SEQ_FORMATS = [{ name: '9:16', w: 1080, h: 1920 }]

const clip = (id: string, prompt: string) =>
  ({ id, type: 'video', prompt, durationSec: 5, audio: false, modelId: 'hailuo-2-3-pro', seed: 1 }) as const

const film = (): Flow => ({
  nodes: [
    clip('one', 'she opens the door'),
    clip('two', 'she steps into the light'),
    { id: 'cut', type: 'sequence', label: 'film' },
  ],
  edges: [
    { id: 'e1', from: 'one', to: 'cut', role: 'input', position: 0 },
    { id: 'e2', from: 'two', to: 'cut', role: 'input', position: 1 },
  ],
})

async function prepared(graph: Flow = film(), rendered = ['one', 'two']) {
  const { db } = tempDb()
  const projectId = seedProject(db)
  const flowId = seedFlow(db, projectId, graph)
  for (const nodeId of rendered) {
    seedRenderedNode(db, flowId, nodeId, { file: STUB_MP4, mime: 'video/mp4', costCents: 50 })
  }
  // The film is a render now, so it has to be rendered. A test that exported a
  // cut nobody made would be testing the thing this change deleted.
  enqueueRun(db, flowId)
  await tick(db, { adapter: createAdapter({ mode: 'stub' }) })
  return { db, flowId, dir: tempExportDir() }
}

describe('a sequence', () => {
  test('cuts its clips into one file, priced as the sum of what they cost', async () => {
    const { db, flowId, dir } = await prepared()
    const result = await exportFlow(db, flowId, { dir, nodeIds: ['cut'], formats: SEQ_FORMATS })

    expect(result.rejected).toEqual([])
    expect(result.entries).toHaveLength(1)

    const entry = result.entries[0]
    expect(entry.nodeId).toBe('cut')
    expect(entry.modelId).toBe('sequence')
    expect(entry.runIds).toHaveLength(2)
    expect(entry.costCents).toBe(100)
    expect(existsSync(path.join(dir, entry.file))).toBe(true)
  })

  test('the film is as long as the clips it was cut from', async () => {
    // The whole promise of the node. A cut that silently dropped a shot would
    // still export, still pass its spec check, and still look finished.
    const { db, flowId, dir } = await prepared()
    const one = await probe(STUB_MP4)
    const result = await exportFlow(db, flowId, { dir, nodeIds: ['cut'], formats: SEQ_FORMATS })

    const film = await probe(path.join(dir, result.entries[0].file))
    // Encoders round to whole frames; a quarter-second either way is the tail
    // of one clip, not a missing shot.
    expect(film.durationMs).toBeGreaterThan(one.durationMs * 2 - 250)
  })

  test('the total counts a clip once, however many ways it ships', async () => {
    // The same clip requested standalone *and* inside the film it feeds. It
    // was rendered once and paid for once; a manifest that says otherwise is a
    // number a client can be shown and later disproved.
    const { db, flowId, dir } = await prepared()

    // The caller decides what "everything" means — here, both the cut and the
    // clip it was built from.
    const result = await exportFlow(db, flowId, { dir, nodeIds: ['cut', 'one'], formats: SEQ_FORMATS })
    expect(result.entries).toHaveLength(2)
    expect(result.totalCostCents).toBe(100)
  })

  test('reports the sequence as stale when a clip has not been rendered', async () => {
    // A cut cannot run without every clip, so it cannot run at all here: 'two'
    // is still queued when the one tick ends, and 'cut' never even dispatches
    // — it is held behind it. The sequence itself has no current render, so
    // exportFlow refuses it the same way it refuses any other unrun node,
    // rather than assembling half a film that plays and looks finished.
    const { db, flowId, dir } = await prepared(film(), ['one'])
    const result = await exportFlow(db, flowId, { dir, nodeIds: ['cut'], formats: SEQ_FORMATS })

    expect(result.entries).toEqual([])
    expect(result.rejected).toHaveLength(1)
    expect(result.rejected[0].nodeId).toBe('cut')
    expect(result.rejected[0].specCheck.findings[0].message).toContain('cut has no rendered output')
  })

  test('names the clip when the cut itself refuses, rather than the generic sentence', async () => {
    // Both clips are cached at enqueue time, so nothing holds the cut and it
    // dispatches in the same tick — unlike the test above, where a clip still
    // in flight holds it back. Reshooting 'two' between enqueue and tick is
    // what makes its already-rendered output stale rather than simply
    // missing, so `cutSequence` throws naming it, and the worker records that
    // message on the cut's own run. Export must read it rather than falling
    // back to "cut has no rendered output" — on a six-shot film that sentence
    // gives no clue which shot is the problem.
    const { db } = tempDb()
    const projectId = seedProject(db)
    const flowId = seedFlow(db, projectId, film())
    seedRenderedNode(db, flowId, 'one', { file: STUB_MP4, mime: 'video/mp4', costCents: 50 })
    seedRenderedNode(db, flowId, 'two', { file: STUB_MP4, mime: 'video/mp4', costCents: 50 })
    enqueueRun(db, flowId)

    const reshot: Flow = { ...film(), nodes: film().nodes.map((n) => (n.id === 'two' ? clip('two', 'a reshot two') : n)) }
    db.update(flows).set({ graphJson: reshot }).where(eq(flows.id, flowId)).run()

    await tick(db, { adapter: createAdapter({ mode: 'stub' }) })

    const dir = tempExportDir()
    const result = await exportFlow(db, flowId, { dir, nodeIds: ['cut'], formats: SEQ_FORMATS })

    expect(result.entries).toEqual([])
    expect(result.rejected).toHaveLength(1)
    expect(result.rejected[0].nodeId).toBe('cut')
    expect(result.rejected[0].specCheck.findings[0].message).toContain('two')
  })

  test('reordering the shots refuses the export until the cut is re-run', async () => {
    // The order lives on the edges, not the node, so swapping two shots
    // changes the sequence's hash without anyone re-running it. Shipping the
    // old cut under the new order would be shipping last week's film under
    // this week's edit — export refuses until the sequence is cut again,
    // the same hash-mismatch refusal any other node gets.
    const { db, flowId, dir } = await prepared()
    const first = await exportFlow(db, flowId, { dir, nodeIds: ['cut'], formats: SEQ_FORMATS })
    expect(first.rejected).toEqual([])

    const graph = db.select().from(flows).where(eq(flows.id, flowId)).get()!.graphJson as Flow
    db.update(flows)
      .set({ graphJson: reorderSequence(graph, 'cut', ['two', 'one']) })
      .where(eq(flows.id, flowId))
      .run()

    const second = await exportFlow(db, flowId, { dir, nodeIds: ['cut'], formats: SEQ_FORMATS })
    expect(second.entries).toEqual([])
    expect(second.rejected).toHaveLength(1)
    expect(second.rejected[0].nodeId).toBe('cut')
  })

  test('a sequence is planned with zero cost', async () => {
    const { db, flowId } = await prepared()
    const planned = planRun(db, flowId)
    expect(planned.map((p) => p.nodeId).sort()).toEqual(['cut', 'one', 'two'])
    expect(planned.find((p) => p.nodeId === 'cut')?.estimatedCents).toBe(0)
  })
})
