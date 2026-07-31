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
  over: { file?: string; mime?: string; modelId?: string; costCents?: number } = {},
) {
  const runId = randomUUID()
  const assetId = randomUUID()
  const video = (over.mime ?? 'image/png').startsWith('video/')

  db.insert(assets)
    .values({
      id: assetId,
      path: over.file ?? (video ? STUB_MP4 : STUB_PNG),
      mime: over.mime ?? 'image/png',
      width: 1080,
      height: 1920,
      durationMs: video ? 1000 : null,
      sourceRunId: runId,
      createdAt: new Date().toISOString(),
    })
    .run()

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
      outputRefs: [assetId],
      attempt: 0,
      createdAt: new Date().toISOString(),
    })
    .run()

  return { runId, assetId }
}
