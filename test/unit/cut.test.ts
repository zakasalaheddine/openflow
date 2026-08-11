import { describe, test, expect } from 'vitest'
import { execFileSync } from 'node:child_process'
import { existsSync } from 'node:fs'
import path from 'node:path'
import { eq } from 'drizzle-orm'
import { cutSequence, CutRefused } from '@/core/cut'
import { audioOf, probe } from '@/core/ffmpeg'
import { assets, nodeRuns } from '@/db/schema'
import { assetsDir } from '@/env'
import type { Flow } from '@/core/types'
import { tempDb, seedProject, seedFlow } from '../helpers/db'
import { seedRenderedNode, tempExportDir, STUB_MP4 } from '../helpers/exports'

const clip = (id: string, prompt: string) =>
  ({ id, type: 'video', prompt, durationSec: 5, audio: false, modelId: 'hailuo-2-3-pro', seed: 1 }) as const

const film = (): Flow => ({
  nodes: [clip('one', 'she opens the door'), clip('two', 'she steps into the light'), { id: 'cut', type: 'sequence' }],
  edges: [
    { id: 'e1', from: 'one', to: 'cut', role: 'input', position: 0 },
    { id: 'e2', from: 'two', to: 'cut', role: 'input', position: 1 },
  ],
})

function prepared(graph: Flow = film(), rendered = ['one', 'two']) {
  const { db } = tempDb()
  const projectId = seedProject(db)
  const flowId = seedFlow(db, projectId, graph)
  for (const nodeId of rendered) {
    seedRenderedNode(db, flowId, nodeId, { file: STUB_MP4, mime: 'video/mp4', costCents: 50 })
  }
  return { db, flowId }
}

const runRow = (flowId: string) => ({ id: 'run-cut-1', flowId, nodeId: 'cut' })

describe('cutSequence', () => {
  test('writes one film from the clips, in order, owned by the run that cut it', async () => {
    const { db, flowId } = prepared()

    const assetId = await cutSequence(db, runRow(flowId), assetsDir())

    const row = db.select().from(assets).where(eq(assets.id, assetId)).get()!
    expect(row.mime).toBe('video/mp4')
    expect(row.sourceRunId).toBe('run-cut-1')
    expect(existsSync(row.path)).toBe(true)

    // The film is as long as what it was cut from. A cut that silently dropped
    // a shot would still produce a file and still look finished.
    const one = await probe(STUB_MP4)
    const cut = await probe(row.path)
    expect(cut.durationMs).toBeGreaterThan(one.durationMs * 2 - 250)
  })

  test('refuses by name when a clip has no render matching its current settings', async () => {
    const { db, flowId } = prepared(film(), ['one'])

    await expect(cutSequence(db, runRow(flowId), assetsDir())).rejects.toThrow(CutRefused)
    await expect(cutSequence(db, runRow(flowId), assetsDir())).rejects.toThrow(/two/)
  })

  test('refuses an empty sequence rather than writing a zero-length film', async () => {
    const graph: Flow = { nodes: [{ id: 'cut', type: 'sequence' }], edges: [] }
    const { db, flowId } = prepared(graph, [])

    await expect(cutSequence(db, runRow(flowId), assetsDir())).rejects.toThrow(/no clips/)
  })

  test('cutting adds no cost of its own — the clips already paid for it', async () => {
    // Not on the asset — provenance rides in the manifest (see exporter.ts's
    // sequenceProvenance, which records the run ids). What matters here is
    // that the cut itself is free: the clips' recorded total is unchanged by
    // it, not topped up by a charge of the cut's own.
    const { db, flowId } = prepared()
    await cutSequence(db, runRow(flowId), assetsDir())

    const paid = db.select().from(nodeRuns).where(eq(nodeRuns.flowId, flowId)).all()
    expect(paid.reduce((sum, run) => sum + run.costCents, 0)).toBe(100)
  })
})

/**
 * Encoded here rather than committed: the point of these two is the difference
 * between them, and a pair of near-identical binaries in the fixture folder
 * would say nothing about which one carries sound.
 */
function encode(dir: string, name: string, sound: boolean): string {
  const file = path.join(dir, `${name}.mp4`)
  execFileSync('ffmpeg', [
    '-v', 'error', '-y',
    '-f', 'lavfi', '-i', 'testsrc=size=1080x1920:rate=30:duration=1',
    ...(sound ? ['-f', 'lavfi', '-i', 'sine=frequency=440:duration=1', '-c:a', 'aac'] : []),
    '-c:v', 'libx264', '-pix_fmt', 'yuv420p', '-shortest',
    file,
  ])
  return file
}

function preparedFrom(clips: { one: string; two: string }) {
  const { db } = tempDb()
  const projectId = seedProject(db)
  const flowId = seedFlow(db, projectId, film())
  for (const [nodeId, file] of Object.entries(clips)) {
    seedRenderedNode(db, flowId, nodeId, { file, mime: 'video/mp4', costCents: 50 })
  }
  return { db, flowId }
}

describe('a cut and its sound', () => {
  test('keeps the audio the clips were rendered with', async () => {
    const dir = tempExportDir()
    const { db, flowId } = preparedFrom({ one: encode(dir, 'one', true), two: encode(dir, 'two', true) })

    const assetId = await cutSequence(db, runRow(flowId), assetsDir())
    const row = db.select().from(assets).where(eq(assets.id, assetId)).get()!

    expect(await audioOf(row.path)).not.toBeNull()
  })

  test('gives a silent clip silence of its own length instead of muting the film', async () => {
    const dir = tempExportDir()
    const { db, flowId } = preparedFrom({ one: encode(dir, 'one', true), two: encode(dir, 'two', false) })

    const assetId = await cutSequence(db, runRow(flowId), assetsDir())
    const row = db.select().from(assets).where(eq(assets.id, assetId)).get()!

    expect(await audioOf(row.path)).not.toBeNull()
    // Both shots are in it. Padding the quiet one with silence must not have
    // cut the film down to the length of the one that had sound.
    expect((await probe(row.path)).durationMs).toBeGreaterThan(1800)
  })
})
