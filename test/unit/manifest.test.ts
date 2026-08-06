import { describe, test, expect } from 'vitest'
import { readFileSync, existsSync } from 'node:fs'
import path from 'node:path'
import { eq } from 'drizzle-orm'
import { exportFlow, type ManifestEntry } from '@/core/exporter'
import { nodeRuns } from '@/db/schema'
import type { Flow } from '@/core/types'
import { tempDb, seedProject, seedSource, seedFlow } from '../helpers/db'
import { tempExportDir, seedRenderedNode } from '../helpers/exports'

// Provenance is a headline feature. Provenance that disagrees with the ledger
// is worse than none: it is a number a client can be shown and later disproved.

const graph: Flow = {
  nodes: [
    { id: 'bottle', type: 'source', sourceId: 'source-1' },
    { id: 'shot', type: 'image', prompt: 'bottle on marble', modelId: 'flux-2-pro', seed: 7, label: 'shot' },
    { id: 'out', type: 'export', formats: [{ name: '1:1', w: 1080, h: 1080 }] },
  ],
  edges: [
    { id: 'e1', from: 'bottle', to: 'shot', role: 'reference', position: null },
    { id: 'e2', from: 'shot', to: 'out', role: 'input', position: null },
  ],
}

function prepared(over: Parameters<typeof seedRenderedNode>[3] = {}) {
  const { db } = tempDb()
  const projectId = seedProject(db)
  seedSource(db, projectId, 'source-1', { version: 3 })
  const flowId = seedFlow(db, projectId, graph)
  seedRenderedNode(db, flowId, 'shot', over)
  return { db, flowId, dir: tempExportDir() }
}

const readManifest = (dir: string) =>
  JSON.parse(readFileSync(path.join(dir, 'manifest.json'), 'utf8')) as {
    flowId: string
    totalCostCents: number
    files: ManifestEntry[]
  }

describe('manifest', () => {
  test('is written beside the exported files', async () => {
    const { db, flowId, dir } = prepared()
    const result = await exportFlow(db, flowId, { dir })
    expect(existsSync(result.manifestPath)).toBe(true)
    expect(readManifest(dir).flowId).toBe(flowId)
  })

  test('every exported file has a full provenance entry', async () => {
    const { db, flowId, dir } = prepared({ modelId: 'nano-banana-pro', costCents: 15 })
    await exportFlow(db, flowId, { dir })

    const [entry] = readManifest(dir).files
    expect(entry).toMatchObject({
      format: '1:1',
      nodeId: 'shot',
      prompt: 'bottle on marble',
      modelId: 'nano-banana-pro',
      seed: 7,
      // The asset version at render time, so a re-export is reproducible rather
      // than "whatever the product looks like today".
      sourceVersions: { 'source-1': 3 },
      costCents: 15,
    })
    expect(entry.createdAt).toBeTruthy()
    expect(existsSync(path.join(dir, entry.file))).toBe(true)
  })

  test('the manifest total matches the node_runs ledger', async () => {
    const { db, flowId, dir } = prepared({ costCents: 41 })
    await exportFlow(db, flowId, { dir })

    const ledger = db
      .select()
      .from(nodeRuns)
      .where(eq(nodeRuns.flowId, flowId))
      .all()
      .reduce((sum, run) => sum + run.costCents, 0)

    expect(readManifest(dir).totalCostCents).toBe(ledger)
  })

  test('a render exported to two formats is billed once, not twice', async () => {
    // The obvious sum — add up the files — double-counts every render that
    // feeds more than one placement, and inflates the number a client is shown.
    const { db } = tempDb()
    const projectId = seedProject(db)
    seedSource(db, projectId, 'source-1', { version: 3 })
    const flowId = seedFlow(db, projectId, {
      ...graph,
      nodes: graph.nodes.map((n) =>
        n.id === 'out'
          ? { ...n, type: 'export' as const, formats: [{ name: '1:1', w: 1080, h: 1080 }, { name: '9:16', w: 1080, h: 1920 }] }
          : n,
      ),
    })
    seedRenderedNode(db, flowId, 'shot', { costCents: 30 })
    const dir = tempExportDir()

    const result = await exportFlow(db, flowId, { dir })
    expect(result.entries).toHaveLength(2)
    expect(result.totalCostCents).toBe(30)
  })
})
