import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { afterEach } from 'vitest'
import type { PlannedNode } from '@/core/executor'

const dirs: string[] = []
afterEach(() => {
  while (dirs.length > 0) rmSync(dirs.pop()!, { recursive: true, force: true })
})

/** A 1x1 PNG, inline. Fixtures carry their own bytes so the real download path
 *  runs (fetch handles data: URIs) without a network call. */
export const PNG_1PX =
  'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg=='

/**
 * Writes real bytes for a flow's source files.
 *
 * A dispatch inlines every reference so fal can fetch it, which means a source
 * row naming a file that is not on disk is now a failed run rather than a
 * silently empty reference. Fixtures have to be as real as the code assumes.
 */
export function seedSourceFiles(storeRoot: string, files: string[]) {
  const bytes = Buffer.from(PNG_1PX.split(',')[1], 'base64')
  for (const key of files) {
    const full = path.join(storeRoot, key)
    mkdirSync(path.dirname(full), { recursive: true })
    writeFileSync(full, bytes)
  }
}

export function tempFixtureDir(): string {
  const dir = mkdtempSync(path.join(tmpdir(), 'openflow-fx-'))
  dirs.push(dir)
  return dir
}

/**
 * Records a fixture for a planned node, keyed by its real input hash.
 *
 * Deriving the key from planRun rather than hardcoding it means a change to the
 * hashing scheme surfaces as a missing fixture — loudly — instead of silently
 * replaying the wrong recorded response.
 */
export function recordSuccess(
  fixtureDir: string,
  planned: PlannedNode,
  body: unknown = { images: [{ url: PNG_1PX, content_type: 'image/png', width: 1024, height: 1024 }] },
) {
  const dir = path.join(fixtureDir, planned.endpoint.replaceAll('/', '_'))
  mkdirSync(dir, { recursive: true })
  writeFileSync(path.join(dir, `${planned.inputHash}.json`), JSON.stringify(body))
}

export const recordFailure = (fixtureDir: string, planned: PlannedNode, message: string) =>
  recordSuccess(fixtureDir, planned, { error: { message } })
