import { readFileSync, existsSync } from 'node:fs'
import path from 'node:path'
import { eq } from 'drizzle-orm'
import { getDb } from '@/db'
import { assets } from '@/db/schema'
import { assetsDir } from '@/env'

export const dynamic = 'force-dynamic'

/**
 * Serves a generated asset by its id.
 *
 * By id, never by path. A route that took a filesystem path from the URL is a
 * traversal waiting to happen; going through the assets table means the only
 * files reachable are ones this app wrote. The containment check below is the
 * second lock, in case a row is ever written with a path outside the store.
 */
export async function GET(_request: Request, context: { params: Promise<{ id: string }> }) {
  const { id } = await context.params
  const asset = getDb().select().from(assets).where(eq(assets.id, id)).get()
  if (!asset) return new Response('Not found', { status: 404 })

  const root = assetsDir()
  const full = path.resolve(asset.path)
  if (full !== root && !full.startsWith(root + path.sep)) {
    return new Response('Forbidden', { status: 403 })
  }
  if (!existsSync(full)) return new Response('Not found', { status: 404 })

  return new Response(new Uint8Array(readFileSync(full)), {
    headers: {
      'Content-Type': asset.mime,
      // Content is immutable: the id is derived from a run that can never
      // produce different bytes under the same hash.
      'Cache-Control': 'public, max-age=31536000, immutable',
    },
  })
}
