#!/usr/bin/env tsx
/**
 * Headless runner. `npx tsx bin/run.ts flows/demo.json`
 *
 * The whole point of the /core boundary rule: this file drives the same
 * executor and worker the canvas will, with no framework loaded.
 */
import { openDb } from '../src/db'
import { readFlowFile, runFlow } from '../src/core/run-flow'
import { createAdapter } from '../src/models/fal'
import { ensureModelsFile } from '../src/models/registry'
import { falMode, loadDotEnv } from '../src/env'
import type { ModelRole } from '../src/core/types'

// Before anything reads process.env. The canvas gets `.env` from Next; this
// runner has no framework to do it for us.
loadDotEnv()

const [file, ...rest] = process.argv.slice(2)

if (!file) {
  console.error('usage: tsx bin/run.ts <flow.json> [--hero] [--confirm]')
  process.exit(1)
}

const role: ModelRole | undefined = rest.includes('--hero') ? 'hero' : undefined
const confirmOverspend = rest.includes('--confirm')

const mode = falMode()
const db = openDb()
ensureModelsFile()

console.log(`[openflow] ${file} · FAL_MODE=${mode}${role ? ` · ${role}` : ''}`)

try {
  const summary = await runFlow(db, readFlowFile(file), {
    adapter: createAdapter({ mode }),
    role,
    confirmOverspend,
  })

  console.log(
    `[openflow] ${summary.succeeded} succeeded · ${summary.failed} failed · ` +
      `${summary.cached} cached · $${(summary.costCents / 100).toFixed(2)}`,
  )
  process.exit(summary.failed > 0 ? 1 : 0)
} catch (error) {
  // The spend cap lands here. Say what to do about it rather than dumping a
  // stack at someone who just wanted to know why nothing ran.
  console.error(`[openflow] ${error instanceof Error ? error.message : String(error)}`)
  process.exit(1)
}
