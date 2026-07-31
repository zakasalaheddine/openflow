#!/usr/bin/env tsx
/**
 * Records fal fixtures for a flow file, keyed by each node's real input hash.
 *
 *   tsx bin/record-fixtures.ts flows/demo.json          # placeholder bytes
 *   FAL_MODE=live tsx bin/record-fixtures.ts flows/demo.json --live
 *
 * Placeholder mode exists so `FAL_MODE=replay` works out of the box for a
 * contributor with no fal key. Recording live is what makes the fixtures
 * actually prove the adapter parses a real response — until someone does that,
 * the suite validates our handling of a plausible shape, not a proven one.
 */
import { mkdirSync, writeFileSync } from 'node:fs'
import path from 'node:path'
import { openDb } from '../src/db'
import { importFlowFile, readFlowFile } from '../src/core/run-flow'
import { planRun } from '../src/core/executor'
import { byId } from '../src/models/registry'
import { createAdapter } from '../src/models/fal'
import { loadDotEnv } from '../src/env'

loadDotEnv()

const PLACEHOLDER_PNG =
  'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg=='

const [file, ...flags] = process.argv.slice(2)
if (!file) {
  console.error('usage: tsx bin/record-fixtures.ts <flow.json> [--live]')
  process.exit(1)
}

const live = flags.includes('--live')
const outDir = path.resolve('test/fixtures/fal')

// A throwaway database: recording must never touch the user's real project.
const db = openDb(path.join(process.env.OPENFLOW_DATA_DIR ?? './data', 'record.db'))
const spec = readFlowFile(file)
const { flowId } = importFlowFile(db, spec, `record:${path.basename(file)}`)

for (const planned of planRun(db, flowId)) {
  const model = byId(planned.modelId)!
  // The plan's endpoint, not the row's: a node with references wired in
  // dispatches to `/edit`, and that is the folder replay will look in.
  const dir = path.join(outDir, planned.endpoint.replaceAll('/', '_'))
  mkdirSync(dir, { recursive: true })

  let body: unknown
  if (live) {
    const adapter = createAdapter({ mode: 'live' })
    const { requestId } = await adapter.submit({ model, input: { prompt: '' }, hash: planned.inputHash })
    let result = await adapter.poll(requestId)
    while (result.status === 'IN_PROGRESS') {
      await new Promise((r) => setTimeout(r, 2000))
      result = await adapter.poll(requestId)
    }
    body = { images: result.outputs }
  } else {
    body = {
      images: [{ url: PLACEHOLDER_PNG, content_type: 'image/png', width: 1024, height: 1024 }],
    }
  }

  const target = path.join(dir, `${planned.inputHash}.json`)
  writeFileSync(target, JSON.stringify(body, null, 2) + '\n')
  console.log(`[record] ${planned.nodeId} → ${path.relative(process.cwd(), target)}`)
}
