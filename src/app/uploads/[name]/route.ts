import { readFileSync, existsSync } from 'node:fs'
import path from 'node:path'
import { assetsDir } from '@/env'
import { ALLOWED_MIME } from '@/core/upload'

export const dynamic = 'force-dynamic'

const MIME_BY_EXT = Object.fromEntries(
  Object.entries(ALLOWED_MIME).map(([mime, ext]) => [ext, mime]),
)

/**
 * Serves an uploaded reference file.
 *
 * The name from the URL is untrusted, so it is matched against the exact shape
 * `storeUpload` generates — a UUID plus a known extension — before it is ever
 * joined to a path. A traversal cannot survive that, and the containment check
 * below is the second lock.
 */
export async function GET(_request: Request, context: { params: Promise<{ name: string }> }) {
  const { name } = await context.params
  if (!/^[0-9a-f-]{36}\.[a-z0-9]{2,4}$/i.test(name)) return new Response('Not found', { status: 404 })

  const root = path.join(assetsDir(), 'uploads')
  const full = path.resolve(root, name)
  if (!full.startsWith(root + path.sep)) return new Response('Forbidden', { status: 403 })
  if (!existsSync(full)) return new Response('Not found', { status: 404 })

  return new Response(new Uint8Array(readFileSync(full)), {
    headers: {
      'Content-Type': MIME_BY_EXT[path.extname(full).toLowerCase()] ?? 'application/octet-stream',
      'Cache-Control': 'public, max-age=31536000, immutable',
    },
  })
}
