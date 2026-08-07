import { describe, test, expect } from 'vitest'
import { existsSync, rmSync } from 'node:fs'
import path from 'node:path'
import { exportFlow } from '@/core/exporter'
import { probe } from '@/core/ffmpeg'
import { planRun } from '@/core/executor'
import { reorderSequence } from '@/core/wiring'
import { assets, exports, flows } from '@/db/schema'
import { eq } from 'drizzle-orm'
import type { Flow } from '@/core/types'
import { tempDb, seedProject, seedFlow } from '../helpers/db'
import { tempExportDir, seedRenderedNode, STUB_MP4 } from '../helpers/exports'

// A film, not a folder of clips. Everything here is about the one thing a cut
// has that a node does not: an order, and a total that must not double-count.

const clip = (id: string, prompt: string) =>
  ({ id, type: 'video', prompt, durationSec: 5, audio: false, modelId: 'hailuo-2-3-pro', seed: 1 }) as const

const film = (): Flow => ({
  nodes: [
    clip('one', 'she opens the door'),
    clip('two', 'she steps into the light'),
    { id: 'cut', type: 'sequence', label: 'film' },
    { id: 'out', type: 'export', formats: [{ name: '9:16', w: 1080, h: 1920 }] },
  ],
  edges: [
    { id: 'e1', from: 'one', to: 'cut', role: 'input', position: 0 },
    { id: 'e2', from: 'two', to: 'cut', role: 'input', position: 1 },
    { id: 'e3', from: 'cut', to: 'out', role: 'input', position: null },
  ],
})

function prepared(graph: Flow = film(), rendered = ['one', 'two']) {
  const { db } = tempDb()
  const projectId = seedProject(db)
  const flowId = seedFlow(db, projectId, graph)
  for (const nodeId of rendered) {
    seedRenderedNode(db, flowId, nodeId, { file: STUB_MP4, mime: 'video/mp4', costCents: 50 })
  }
  return { db, flowId, dir: tempExportDir() }
}

describe('a sequence', () => {
  test('cuts its clips into one file, priced as the sum of what they cost', async () => {
    const { db, flowId, dir } = prepared()
    const result = await exportFlow(db, flowId, { dir })

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
    const { db, flowId, dir } = prepared()
    const one = await probe(STUB_MP4)
    const result = await exportFlow(db, flowId, { dir })

    const film = await probe(path.join(dir, result.entries[0].file))
    // Encoders round to whole frames; a quarter-second either way is the tail
    // of one clip, not a missing shot.
    expect(film.durationMs).toBeGreaterThan(one.durationMs * 2 - 250)
  })

  test('the total counts a clip once, however many ways it ships', async () => {
    // The same clip wired into the film *and* straight into the export. It was
    // rendered once and paid for once; a manifest that says otherwise is a
    // number a client can be shown and later disproved.
    const graph = film()
    graph.edges.push({ id: 'e4', from: 'one', to: 'out', role: 'input', position: null })
    const { db, flowId, dir } = prepared(graph)

    const result = await exportFlow(db, flowId, { dir })
    expect(result.entries).toHaveLength(2)
    expect(result.totalCostCents).toBe(100)
  })

  test('refuses to cut a film around a shot that has not been rendered', async () => {
    // Half a film assembled from one fresh clip and one missing one is worse
    // than no film: it exports, it plays, and it looks finished.
    const { db, flowId, dir } = prepared(film(), ['one'])
    const result = await exportFlow(db, flowId, { dir })

    expect(result.entries).toEqual([])
    expect(result.rejected).toHaveLength(1)
    expect(result.rejected[0].specCheck.findings[0].message).toContain('two has no render')
  })

  test('refuses an empty sequence rather than writing a zero-length file', async () => {
    const graph = film()
    graph.edges = graph.edges.filter((e) => e.to !== 'cut')
    const { db, flowId, dir } = prepared(graph, [])

    const result = await exportFlow(db, flowId, { dir })
    expect(result.entries).toEqual([])
    expect(result.rejected[0].specCheck.findings[0].message).toContain('no clips')
  })

  test('re-exporting an unchanged film re-cuts nothing', async () => {
    // The cut is keyed by the sequence's input hash, so the second export finds
    // the file it made the first time.
    const { db, flowId, dir } = prepared()
    const first = await exportFlow(db, flowId, { dir })
    const second = await exportFlow(db, flowId, { dir })
    expect(second.entries[0].runIds).toEqual(first.entries[0].runIds)
  })

  test('reordering the shots cuts a different film', async () => {
    // `upstreamHashes` cannot see this: reordering rewrites each edge's
    // `position`, not the edge array itself. Without the order folded into the
    // sequence's hash, swapping two shots re-serves the cut made before the
    // swap — same file, same manifest, wrong film.
    //
    // The cut's asset id is `sequence:<hash>`, so it is the hash, observable.
    const { db, flowId, dir } = prepared()
    await exportFlow(db, flowId, { dir })
    const before = db.select().from(exports).all().at(-1)!.assetId

    const graph = db.select().from(flows).where(eq(flows.id, flowId)).get()!.graphJson as Flow
    db.update(flows)
      .set({ graphJson: reorderSequence(graph, 'cut', ['two', 'one']) })
      .where(eq(flows.id, flowId))
      .run()

    await exportFlow(db, flowId, { dir })
    expect(db.select().from(exports).all().at(-1)!.assetId).not.toBe(before)
  })

  test('a sequence is never planned as a run — the cut costs nothing', async () => {
    const { db, flowId } = prepared()
    expect(planRun(db, flowId).map((p) => p.nodeId).sort()).toEqual(['one', 'two'])
  })

  test('re-cuts a film whose file has gone from disk', async () => {
    // The row is not the film. Space reclaimed, a data dir moved — and the
    // cached path would otherwise be handed to ffprobe and fail as a tool
    // error rather than as one of this function's named refusals.
    const { db, flowId, dir } = prepared()
    const first = await exportFlow(db, flowId, { dir })
    const cut = db.select().from(assets).all().find((a) => a.id.startsWith('sequence:'))!
    rmSync(cut.path)

    const second = await exportFlow(db, flowId, { dir })
    expect(second.rejected).toEqual([])
    expect(second.entries[0].file).toBe(first.entries[0].file)
    expect(existsSync(cut.path)).toBe(true)
  })
})
