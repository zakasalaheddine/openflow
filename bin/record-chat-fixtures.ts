#!/usr/bin/env tsx
/**
 * Re-records the LLM fixtures behind `e2e/chat.spec.ts`.
 *
 *   OPENROUTER_API_KEY=… npm run record-chat
 *
 * The fixture key is a hash of the whole request, and the system prompt embeds
 * the model catalog — so adding a row to `models.json` invalidates every
 * recorded turn. The symptom is a browser suite where the agent answers
 * nothing and no card appears, which reads as a broken agent rather than a
 * stale file. This is the one command that fixes it.
 *
 * Costs one real turn against OpenRouter. Nothing else here spends money.
 *
 * Old fixtures are deleted first, on purpose: they are keyed by a hash nothing
 * will ask for again, and a directory of files nobody can explain is how you
 * end up afraid to delete any of them.
 */
import { mkdtempSync, readdirSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { openDb } from '../src/db'
import { ensureWorkspace } from '../src/core/workspace'
import { runTurn } from '../src/agent/loop'
import { createChatModel } from '../src/models/llm'
import { loadDotEnv } from '../src/env'

loadDotEnv()

// What e2e/chat.spec.ts types, against the state it types it in: an empty
// canvas, no brand profile, no thread. Anything else records a turn the spec
// will never ask for.
const MESSAGE = 'add a hero shot of the serum on marble'

// playwright.config.ts pins this. A fixture belongs to the model that produced
// it, so recording under whatever OPENROUTER_MODEL happens to say would write
// files the browser suite cannot find.
process.env.OPENROUTER_MODEL = 'anthropic/claude-opus-5'
process.env.OPENFLOW_RECORD_LLM = '1'

if (!process.env.OPENROUTER_API_KEY) {
  console.error('OPENROUTER_API_KEY is not set. Recording needs a live turn.')
  process.exit(1)
}

const fixtureDir = path.resolve('test/fixtures/llm')
for (const file of readdirSync(fixtureDir)) {
  if (file.endsWith('.json')) rmSync(path.join(fixtureDir, file))
}

// A throwaway data dir, so the catalog is seeded exactly the way the browser
// suite seeds its own rather than inheriting rows you added locally.
const dir = mkdtempSync(path.join(tmpdir(), 'openflow-record-'))
process.env.OPENFLOW_DATA_DIR = dir

const db = openDb(path.join(dir, 'app.db'))
const result = runTurn({
  db,
  ids: ensureWorkspace(db),
  model: createChatModel({ mode: 'live' }),
  brandProfile: '',
  message: MESSAGE,
})

for await (const chunk of result.textStream) process.stdout.write(chunk)

console.log(`\n\n[record] ${readdirSync(fixtureDir).join('\n[record] ')}`)
rmSync(dir, { recursive: true, force: true })
