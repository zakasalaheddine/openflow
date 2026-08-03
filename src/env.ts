import path from 'node:path'

/**
 * Loads `.env` for the entrypoints Next does not start.
 *
 * `next dev` and `next start` read `.env` themselves, so the canvas has always
 * honoured it. The headless runner and the launcher do not — which is why
 * `FAL_KEY` in a `.env` still produced a launcher prompt asking for the key it
 * was already given. Call this first in anything with its own `main`.
 *
 * `process.loadEnvFile` is stdlib and, like Next, leaves an already-exported
 * variable alone: `FAL_MODE=off npm run …` must still win over the file, or a
 * suite that must not spend could be re-armed by a stray line in `.env`.
 *
 * ponytail: `.env` only, not `.env.local`/`.env.<mode>`. Add the cascade if
 * anyone actually needs to keep two profiles side by side.
 */
export function loadDotEnv(file = '.env') {
  try {
    process.loadEnvFile(path.resolve(file))
  } catch {
    // No `.env` is the normal case, not a failure.
  }
}

/**
 * Every path and every network-mode decision resolves through here.
 * Nothing else in the codebase may read `process.env.OPENFLOW_DATA_DIR` or
 * hardcode `./data` — tests point this at a temp dir per file, and a shared
 * DB between a test run and the dev worker destroys real, paid-for assets.
 */
export const dataDir = () =>
  path.resolve(process.env.OPENFLOW_DATA_DIR ?? './data')

/**
 * Where the package's own data lives — flow templates, the demo flow, recorded
 * fixtures.
 *
 * `process.cwd()`, not `import.meta.dirname`: the server runs from a Turbopack
 * bundle where `import.meta.dirname` is undefined, and resolving against it
 * crashes the instrumentation hook before the first request. `bin/openflow-studio.mjs`
 * spawns the server with its cwd pinned to the package root, which is the repo —
 * install is clone-only, see `docs/phases/phase-3-video-export-ship.md`.
 */
export const packageRoot = () => process.env.OPENFLOW_ROOT ?? process.cwd()

export const dbPath = () => path.join(dataDir(), 'app.db')
export const assetsDir = () => path.join(dataDir(), 'assets')
export const exportsDir = () =>
  path.resolve(process.env.OPENFLOW_EXPORTS_DIR ?? './exports')

/**
 * live   — real fal calls, real money. Dev only, never CI.
 * replay — serve recorded fixtures from test/fixtures/fal. Tests, CI, DEMO=1.
 * stub   — synthesise a placeholder for any request. Browser e2e only, where
 *          the subject is the canvas and the hashes are not known in advance.
 * off    — throw on any dispatch. Guard for suites that must not spend.
 */
export type FalMode = 'live' | 'replay' | 'stub' | 'off'

export const isDemo = () => process.env.DEMO === '1'

// Defaults to `live` because generating is the product. `replay` is forced by
// vitest.config.ts, playwright.config.ts and CI — config, not discipline, so
// nobody can forget it and bill themselves for a test run.
//
// DEMO=1 wins over an explicit FAL_MODE for the same reason. A public demo page
// is the one place where a stray environment variable costs money per visitor,
// so the mode is not left to whoever wrote the deploy config.
export const falMode = (): FalMode =>
  isDemo() ? 'replay' : ((process.env.FAL_MODE as FalMode | undefined) ?? 'live')

/**
 * The same seam as FAL_MODE, for the one LLM call in the product.
 *
 * live   — a real Claude call. Needs ANTHROPIC_API_KEY.
 * replay — serve a recorded response from test/fixtures/llm. Tests, CI, DEMO=1.
 * off    — throw on any call. The default, because unlike generating, briefing
 *          is optional: a canvas that works without a second API key should not
 *          fail differently depending on whether one happens to be exported.
 */
export type LlmMode = 'live' | 'replay' | 'off'

export const llmMode = (): LlmMode => {
  if (isDemo()) return 'replay'
  // `||`, not `??`: an exported-but-empty LLM_MODE is a variable someone
  // cleared, not a mode called "".
  return (
    (process.env.LLM_MODE as LlmMode | undefined) ||
    (process.env.ANTHROPIC_API_KEY ? 'live' : 'off')
  )
}
