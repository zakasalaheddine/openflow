import path from 'node:path'

/**
 * Every path and every network-mode decision resolves through here.
 * Nothing else in the codebase may read `process.env.OPENFLOW_DATA_DIR` or
 * hardcode `./data` — tests point this at a temp dir per file, and a shared
 * DB between a test run and the dev worker destroys real, paid-for assets.
 */
export const dataDir = () =>
  path.resolve(process.env.OPENFLOW_DATA_DIR ?? './data')

export const dbPath = () => path.join(dataDir(), 'app.db')
export const assetsDir = () => path.join(dataDir(), 'assets')
export const exportsDir = () =>
  path.resolve(process.env.OPENFLOW_EXPORTS_DIR ?? './exports')

/**
 * live   — real fal calls, real money. Dev only, never CI.
 * replay — serve recorded fixtures from test/fixtures/fal. Tests, CI, DEMO=1.
 * off    — throw on any dispatch. Guard for suites that must not spend.
 */
export type FalMode = 'live' | 'replay' | 'off'

// Defaults to `live` because generating is the product. `replay` is forced by
// vitest.config.ts, playwright.config.ts and CI — config, not discipline, so
// nobody can forget it and bill themselves for a test run.
export const falMode = (): FalMode =>
  (process.env.FAL_MODE as FalMode | undefined) ?? 'live'

export const isDemo = () => process.env.DEMO === '1'
