import { describe, test, expect } from 'vitest'
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { eq } from 'drizzle-orm'
import { importFlowFile, readFlowFile, type FlowFile } from '@/core/run-flow'
import { sources } from '@/db/schema'
import { tempDb } from '../helpers/db'

// A flow file names its references by store key and keeps the bytes beside
// itself. Importing recorded the key and copied nothing, so `bin/run.ts` failed
// every node with `ENOENT` on a file that was sitting next to the flow — while
// `DEMO=1` worked, because `seedDemo` carried a copy loop of its own. One
// import, two callers, one of them right.

const RED = Buffer.from('89504e470d0a1a0a-red', 'utf8')
const BLUE = Buffer.from('89504e470d0a1a0a-blue', 'utf8')

/** Writes a flow file with its reference beside it, the way `flows/` is laid out. */
function flowFileDir(bytes: Buffer, over: Partial<FlowFile> = {}) {
  const dir = mkdtempSync(path.join(tmpdir(), 'openflow-flow-'))
  mkdirSync(path.join(dir, 'refs'), { recursive: true })
  writeFileSync(path.join(dir, 'refs/bottle.png'), bytes)

  const spec: FlowFile = {
    project: 'serum',
    sources: [{ id: 'src:bottle', kind: 'image', files: ['refs/bottle.png'] }],
    flow: { nodes: [{ id: 'bottle', type: 'source', sourceId: 'src:bottle' }], edges: [] },
    ...over,
  }
  const file = path.join(dir, 'flow.json')
  writeFileSync(file, JSON.stringify(spec))
  return { dir, file }
}

const versionOf = (db: ReturnType<typeof tempDb>['db']) =>
  db.select().from(sources).where(eq(sources.id, 'src:bottle')).get()!.version

describe('importing a flow file', () => {
  test('copies references into the asset store', () => {
    const { db, dir } = tempDb()
    const { file } = flowFileDir(RED)

    importFlowFile(db, readFlowFile(file))

    const stored = path.join(dir, 'assets/refs/bottle.png')
    expect(readFileSync(stored)).toEqual(RED)
  })

  test('a re-shot product overwrites the bytes and bumps the version', () => {
    const { db, dir } = tempDb()
    const { file } = flowFileDir(RED)
    importFlowFile(db, readFlowFile(file))
    expect(versionOf(db)).toBe(1)

    // The photo is swapped in place, which is how anyone re-shoots a product.
    writeFileSync(path.join(path.dirname(file), 'refs/bottle.png'), BLUE)
    importFlowFile(db, readFlowFile(file))

    expect(readFileSync(path.join(dir, 'assets/refs/bottle.png'))).toEqual(BLUE)
    // Without the bump the store holds the new bottle and the cache keeps
    // serving renders of the old one, with nothing on screen to explain it.
    expect(versionOf(db)).toBe(2)
  })

  test('re-importing unchanged bytes leaves the version alone', () => {
    const { db } = tempDb()
    const { file } = flowFileDir(RED)

    importFlowFile(db, readFlowFile(file))
    importFlowFile(db, readFlowFile(file))

    // A second run must hit the cache, not re-render the whole flow.
    expect(versionOf(db)).toBe(1)
  })

  test('a version stated in the file still wins over the bump', () => {
    const { db } = tempDb()
    const { file } = flowFileDir(RED)
    importFlowFile(db, readFlowFile(file))

    const spec = readFlowFile(file)
    spec.sources![0].version = 7
    writeFileSync(path.join(path.dirname(file), 'refs/bottle.png'), BLUE)
    importFlowFile(db, spec)

    expect(versionOf(db)).toBe(7)
  })

  test('a reference that exists nowhere fails at import, not three nodes later', () => {
    const { db } = tempDb()
    const { file, dir } = flowFileDir(RED)
    rmSync(path.join(dir, 'refs/bottle.png'))

    expect(() => importFlowFile(db, readFlowFile(file))).toThrow(/refs\/bottle\.png/)
  })

  test('a spec built in memory has no base dir and copies nothing', () => {
    const { db } = tempDb()
    // The canvas and the unit suites both hand `importFlowFile` a spec whose
    // files are already store keys. Nothing to resolve, nothing to throw about.
    const spec: FlowFile = {
      project: 'serum',
      sources: [{ id: 'src:bottle', kind: 'image', files: ['uploads/whatever.png'] }],
      flow: { nodes: [], edges: [] },
    }

    expect(() => importFlowFile(db, spec)).not.toThrow()
  })
})
