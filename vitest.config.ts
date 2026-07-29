import { defineConfig } from 'vitest/config'
import path from 'node:path'

export default defineConfig({
  test: {
    include: ['test/**/*.test.ts'],
    // Forced here, not left to the caller: a unit run must never reach fal.
    env: { FAL_MODE: 'off' },
  },
  resolve: {
    alias: { '@': path.resolve(import.meta.dirname, './src') },
  },
})
