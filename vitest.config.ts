import { defineConfig } from 'vitest/config'
import path from 'node:path'

export default defineConfig({
  test: {
    include: ['test/**/*.test.ts'],
    // Forced here, not left to the caller: a unit run must never reach fal or
    // OpenRouter. Without LLM_MODE pinned, llmMode() falls through to 'live'
    // for anyone who exported OPENROUTER_API_KEY per the README — config, not
    // discipline, so nobody can forget it and bill themselves for a test run.
    env: { FAL_MODE: 'off', LLM_MODE: 'off' },
  },
  resolve: {
    alias: { '@': path.resolve(import.meta.dirname, './src') },
  },
})
