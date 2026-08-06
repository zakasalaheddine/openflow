import type { AdFormat } from './types'

/**
 * Everything here is user-editable per project, and overridable per export
 * node. Custom formats matter on day one: agencies carry client-specific
 * placements (DOOH, in-app, bumpers) and a fixed list blocks them immediately.
 */
export type ProjectSettings = {
  fps: number
  codec: string
  formats: AdFormat[]
  /** Cents. Blocks a run whose estimate exceeds it, pending confirmation. */
  spendCapPerRun: number
  concurrency: number
}

export const DEFAULT_SETTINGS: ProjectSettings = {
  fps: 30,
  codec: 'h264',
  formats: [
    { name: '9:16', w: 1080, h: 1920 },
    { name: '1:1', w: 1080, h: 1080 },
  ],
  spendCapPerRun: 5000,
  concurrency: 4,
}
