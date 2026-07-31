import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { afterEach } from 'vitest'
import { openDb, type Db } from '@/db'
import { projects, flows, sources } from '@/db/schema'
import type { Flow } from '@/core/types'
import type { ProjectSettings } from '@/core/settings'
import { DEFAULT_SETTINGS } from '@/core/settings'

const dirs: string[] = []

afterEach(() => {
  while (dirs.length > 0) rmSync(dirs.pop()!, { recursive: true, force: true })
})

/** A database per test file, in a temp dir, torn down after. Never ./data. */
export function tempDb(): { db: Db; dir: string } {
  const dir = mkdtempSync(path.join(tmpdir(), 'openflow-db-'))
  dirs.push(dir)
  process.env.OPENFLOW_DATA_DIR = dir
  return { db: openDb(path.join(dir, 'app.db')), dir }
}

export function seedProject(db: Db, settings: Partial<ProjectSettings> = {}) {
  const id = 'proj-1'
  db.insert(projects)
    .values({
      id,
      name: 'Test',
      settings: { ...DEFAULT_SETTINGS, ...settings },
      createdAt: new Date().toISOString(),
    })
    .run()
  return id
}

export function seedSource(
  db: Db,
  projectId: string,
  id = 'source-1',
  over: { kind?: 'image' | 'video' | 'text'; files?: string[]; text?: string; version?: number } = {},
) {
  db.insert(sources)
    .values({
      id,
      projectId,
      kind: over.kind ?? 'image',
      files: over.files ?? ['ref-a.png'],
      text: over.text ?? null,
      version: over.version ?? 1,
      createdAt: new Date().toISOString(),
    })
    .run()
  return id
}

export function seedFlow(db: Db, projectId: string, graph: Flow, id = 'flow-1') {
  db.insert(flows)
    .values({
      id,
      projectId,
      name: 'Test flow',
      graphJson: graph,
      updatedAt: new Date().toISOString(),
    })
    .run()
  return id
}
