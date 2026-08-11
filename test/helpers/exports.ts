import { execFileSync } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { afterEach } from 'vitest'
import { assets, nodeRuns } from '@/db/schema'
import { planRun } from '@/core/executor'
import type { Db } from '@/db'

const dirs: string[] = []
afterEach(() => {
  while (dirs.length > 0) rmSync(dirs.pop()!, { recursive: true, force: true })
})

export function tempExportDir(): string {
  const dir = mkdtempSync(path.join(tmpdir(), 'openflow-exports-'))
  dirs.push(dir)
  return dir
}

/** The real media the stub adapter serves — 1080x1920, genuinely encoded. */
export const STUB_PNG = path.resolve('test/fixtures/media/stub.png')
export const STUB_MP4 = path.resolve('test/fixtures/media/stub.mp4')

/**
 * A node that has already rendered: a succeeded run plus the asset it produced.
 *
 * Exporting reads the file, not the row, so the asset has to point at bytes
 * that are really media — a stub row over a placeholder makes every check pass
 * on something that could never be shipped.
 */
export function seedRenderedNode(
  db: Db,
  flowId: string,
  nodeId: string,
  over: {
    file?: string
    mime?: string
    modelId?: string
    costCents?: number
    /**
     * Several outputs from one run, e.g. a multi-output model response
     * (worker/loop.ts supports this). Overrides `file`/`mime` above, one pair
     * per output. Defaults to the single-asset shape every other caller uses.
     */
    assets?: { file?: string; mime?: string }[]
  } = {},
) {
  const runId = randomUUID()
  const outputs = over.assets ?? [{ file: over.file, mime: over.mime }]
  const assetIds = outputs.map(() => randomUUID())

  outputs.forEach((output, i) => {
    const video = (output.mime ?? 'image/png').startsWith('video/')
    db.insert(assets)
      .values({
        id: assetIds[i],
        path: output.file ?? (video ? STUB_MP4 : STUB_PNG),
        mime: output.mime ?? 'image/png',
        width: 1080,
        height: 1920,
        durationMs: video ? 1000 : null,
        sourceRunId: runId,
        createdAt: new Date().toISOString(),
      })
      .run()
  })

  db.insert(nodeRuns)
    .values({
      id: runId,
      flowId,
      nodeId,
      // The real hash, from the same planner the exporter consults. A made-up
      // one would make every seeded node read as stale — which is exactly the
      // check that keeps a manifest from attributing a new prompt to old pixels.
      inputHash: planRun(db, flowId).find((p) => p.nodeId === nodeId)?.inputHash ?? `hash-${nodeId}`,
      status: 'succeeded',
      modelId: over.modelId ?? 'flux-2-pro',
      costCents: over.costCents ?? 12,
      outputRefs: assetIds,
      attempt: 0,
      createdAt: new Date().toISOString(),
    })
    .run()

  return { runId, assetId: assetIds[0], assetIds }
}

/**
 * A clip encoded here rather than committed, with sound or without.
 *
 * The whole point of the pair is the difference between them, and two
 * near-identical binaries in the fixture folder would say nothing about which
 * one carries audio. `stub.mp4` is silent, so it cannot stand in for either.
 */
export function encodeClip(dir: string, name: string, sound: boolean): string {
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
