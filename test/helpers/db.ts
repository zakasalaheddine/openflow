import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { afterEach } from 'vitest'
import { openDb, type Db } from '@/db'
import { projects, flows, anchors } from '@/db/schema'
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

export function seedAnchor(db: Db, projectId: string, id = 'anchor-1', version = 1) {
  db.insert(anchors)
    .values({
      id,
      projectId,
      kind: 'product',
      refImages: ['ref-a.png'],
      version,
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
