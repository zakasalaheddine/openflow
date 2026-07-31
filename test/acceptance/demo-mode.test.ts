import { describe, test, expect, vi, afterEach } from 'vitest'
import { existsSync } from 'node:fs'
import path from 'node:path'
import { seedDemo } from '@/core/demo'
import { previewRun } from '@/core/preview'
import { assets, nodeRuns } from '@/db/schema'
import { falMode } from '@/env'
import { tempDb } from '../helpers/db'

// A hosted demo that bills per visitor is a demo you take down. This suite is
// the thing standing between the public page and a fal invoice.

afterEach(() => vi.unstubAllEnvs())

describe('DEMO=1', () => {
  test('forces replay, whatever the deploy config says', () => {
    // The one place a stray environment variable costs money per visitor, so
    // the mode is not left to whoever wrote the deploy config.
    vi.stubEnv('DEMO', '1')
    vi.stubEnv('FAL_MODE', 'live')
    expect(falMode()).toBe('replay')
  })

  test('does not override FAL_MODE when the demo flag is off', () => {
    vi.stubEnv('DEMO', '')
    vi.stubEnv('FAL_MODE', 'live')
    expect(falMode()).toBe('live')
  })
})

describe('the pre-baked demo flow', () => {
  test('renders every node without opening a socket', async () => {
    const fetchSpy = vi.spyOn(globalThis, 'fetch')
    const { db, dir } = tempDb()

    const { flowId, rendered } = await seedDemo(db)
    expect(rendered).toBeGreaterThan(0)

    // Zero calls to a host. This is the assertion that protects the wallet;
    // everything else here is a convenience. Fixtures carry their bytes as
    // `data:` URIs, which go through fetch but never leave the process — so
    // the check is on the scheme, not the call count.
    const hosts = fetchSpy.mock.calls
      .map(([input]) => String(input))
      .filter((url) => !url.startsWith('data:'))
    expect(hosts).toEqual([])
    fetchSpy.mockRestore()

    const runs = db.select().from(nodeRuns).all()
    expect(runs.length).toBe(rendered)
    for (const run of runs) expect(run.status).toBe('succeeded')

    for (const asset of db.select().from(assets).all()) {
      expect(existsSync(asset.path)).toBe(true)
      expect(asset.path.startsWith(path.resolve(dir))).toBe(true)
    }

    // A visitor lands on a finished canvas, not a greyed-out one.
    expect(previewRun(db, flowId).stale).toEqual([])
  })

  test('is idempotent — a restart re-renders nothing', async () => {
    const { db } = tempDb()
    const first = await seedDemo(db)
    const second = await seedDemo(db)

    expect(first.rendered).toBeGreaterThan(0)
    expect(second.rendered).toBe(0)
    expect(second.flowId).toBe(first.flowId)
  })

  test('seeds the flow the canvas actually opens onto', async () => {
    // A second flow nobody navigates to is the same as no demo at all.
    const { db } = tempDb()
    const { flowId } = await seedDemo(db)
    expect(flowId).toBe('flow:default')
  })
})
