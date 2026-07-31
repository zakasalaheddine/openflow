import { defineConfig } from '@playwright/test'
import path from 'node:path'

const PORT = 3100
const testDataDir = path.resolve(import.meta.dirname, '.playwright-data')

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
    command: `npm run build && npx next start -p ${PORT}`,
    url: `http://127.0.0.1:${PORT}`,
    reuseExistingServer: !process.env.CI,
    timeout: 180_000,
    env: {
      // Never the dev database: the worker ticks every 2s and would delete
      // real, paid-for assets out from under you.
      OPENFLOW_DATA_DIR: testDataDir,
      // stub, not replay: these specs build graphs through the UI, so their
      // input hashes cannot be known in advance to record fixtures against.
      // Fixture-driven execution is covered by test/acceptance.
      FAL_MODE: 'stub',
    },
  },
})
