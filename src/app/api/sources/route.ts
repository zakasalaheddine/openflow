import { NextResponse } from 'next/server'
import { getDb } from '@/db'
import { ensureWorkspace, createSource, bumpSource, listSources, deleteSource } from '@/core/workspace'
import { staleForSource } from '@/core/preview'
import { storeUpload, UploadRejected } from '@/core/upload'
import { assetsDir } from '@/env'

export const dynamic = 'force-dynamic'

export async function GET() {
  const db = getDb()
  const { projectId } = ensureWorkspace(db)
  return NextResponse.json({ sources: listSources(db, projectId) })
}

/**
 * Upload. Accepts a file, or `text` for a text source.
 *
 * Everything the client sends is untrusted: the mime is checked against an
 * allow-list, the size against a cap, and the stored path is generated rather
 * than taken from the filename.
 */
export async function POST(request: Request) {
  const db = getDb()
  const { projectId } = ensureWorkspace(db)

  try {
    const form = await request.formData()
    const text = form.get('text')

    if (typeof text === 'string') {
      if (!text.trim()) return NextResponse.json({ error: 'That note is empty.' }, { status: 400 })
      return NextResponse.json({
        id: createSource(db, projectId, { kind: 'text', text, files: [] }),
      })
    }

    const file = form.get('file')
    if (!(file instanceof File)) {
      return NextResponse.json({ error: 'Send a file or some text.' }, { status: 400 })
    }

    const stored = await storeUpload(assetsDir(), {
      mime: file.type,
      bytes: Buffer.from(await file.arrayBuffer()),
    })

    return NextResponse.json({
      id: createSource(db, projectId, { kind: stored.kind, files: [stored.reference] }),
      kind: stored.kind,
    })
  } catch (error) {
    if (error instanceof UploadRejected) {
      return NextResponse.json({ error: error.message }, { status: 400 })
    }
    return NextResponse.json(
      { error: error instanceof Error ? error.message : 'Upload failed' },
      { status: 500 },
    )
  }
}

/**
 * Replace an asset's contents, or price what replacing it would cost.
 *
 * The most expensive action in the product — one bump can invalidate two
 * campaigns — so `preview: true` returns the blast radius and changes nothing.
 */
export async function PATCH(request: Request) {
  const db = getDb()
  const { projectId } = ensureWorkspace(db)

  const form = await request.formData()
  const id = form.get('id')
  if (typeof id !== 'string') {
    return NextResponse.json({ error: 'id is required' }, { status: 400 })
  }

  const affected = staleForSource(db, projectId, id)
  const summary = {
    nodeCount: affected.length,
    flowCount: new Set(affected.map((a) => a.flowId)).size,
    estimatedCents: Math.round(affected.reduce((sum, a) => sum + a.estimatedCents, 0)),
  }

  if (form.get('preview') === '1') return NextResponse.json({ preview: summary })

  try {
    const text = form.get('text')
    const file = form.get('file')

    const next =
      typeof text === 'string'
        ? { text }
        : file instanceof File
          ? {
              files: [
                (
                  await storeUpload(assetsDir(), {
                    mime: file.type,
                    bytes: Buffer.from(await file.arrayBuffer()),
                  })
                ).reference,
              ],
            }
          : {}

    return NextResponse.json({ version: bumpSource(db, id, next), affected: summary })
  } catch (error) {
    if (error instanceof UploadRejected) {
      return NextResponse.json({ error: error.message }, { status: 400 })
    }
    throw error
  }
}

export async function DELETE(request: Request) {
  const db = getDb()
  ensureWorkspace(db)
  const id = new URL(request.url).searchParams.get('id')
  if (!id) return NextResponse.json({ error: 'id is required' }, { status: 400 })

  deleteSource(db, id)
  return NextResponse.json({ ok: true })
}
