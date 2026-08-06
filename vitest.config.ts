import { defineConfig } from 'vitest/config'
import path from 'node:path'

export default defineConfig({
  test: {
    include: ['test/**/*.test.ts'],
    // Forced here, not left to the caller: a unit run must never reach fal or
    // OpenRouter. Without LLM_MODE pinned, llmMode() falls through to 'live'
    // for anyone who exported OPENROUTER_API_KEY per the README — config, not
    // discipline, so nobody can forget it and bill themselves for a test run.
    // OPENROUTER_MODEL is pinned for the same reason: it is part of the fixture
    // key, so an exported one would change what replay looks for.
    env: { FAL_MODE: 'off', LLM_MODE: 'off', OPENROUTER_MODEL: 'anthropic/claude-opus-5' },
  },
  resolve: {
    alias: { '@': path.resolve(import.meta.dirname, './src') },
  },
})
