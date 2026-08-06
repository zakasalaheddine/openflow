import { defineConfig } from '@playwright/test'
import path from 'node:path'

const PORT = 3100
const testDataDir = path.resolve(import.meta.dirname, '.playwright-data')
const testExportsDir = path.resolve(import.meta.dirname, '.playwright-exports')

export default defineConfig({
  testDir: './e2e',
  // One server, one SQLite file, one worker loop — the app is single-process by
  // design, so the suite has to be too. Run in parallel and specs reset the
  // workspace out from under each other.
  fullyParallel: false,
  workers: 1,
  forbidOnly: !!process.env.CI,
  retries: process.env.CI ? 1 : 0,
  reporter: process.env.CI ? [['html'], ['list']] : 'list',
  use: {
    baseURL: `http://127.0.0.1:${PORT}`,
    trace: 'retain-on-failure',
  },
  webServer: {
    // The wipe belongs here, not in globalSetup: the server opens the SQLite
    // file at boot, and deleting it afterwards leaves the in-process worker
    // holding a deleted inode while the route handlers open a fresh one. The
    // symptom is a queue nothing ever claims — every node stuck at `queued`.
    command: `rm -rf ${testDataDir} ${testExportsDir} && npm run build && npx next start -p ${PORT}`,
    url: `http://127.0.0.1:${PORT}`,
    // Never reused: globalSetup deletes the test database, and a server already
    // holding it open would keep writing to the deleted file and serving what
    // used to be in it.
    reuseExistingServer: false,
    timeout: 180_000,
    env: {
      // Never the dev database: the worker ticks every 2s and would delete
      // real, paid-for assets out from under you.
      OPENFLOW_DATA_DIR: testDataDir,
      // Never ./exports: a spec run would sit among real deliverables and the
      // next `rm -rf` cleanup would take both.
      OPENFLOW_EXPORTS_DIR: testExportsDir,
      // stub, not replay: these specs build graphs through the UI, so their
      // input hashes cannot be known in advance to record fixtures against.
      // Fixture-driven execution is covered by test/acceptance.
      FAL_MODE: 'stub',
      // Recorded responses, keyed by prompt. A prompt change surfaces as a
      // missing fixture rather than a live call CI would pay for.
      LLM_MODE: 'replay',
      // Pinned because the model is part of the fixture key. Left unset, `next
      // start` reads OPENROUTER_MODEL from whatever .env the developer keeps,
      // and the checked-in fixtures stop matching for everyone who swapped it.
      OPENROUTER_MODEL: 'anthropic/claude-opus-5',
    },
  },
})
