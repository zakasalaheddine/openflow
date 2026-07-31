import { NextResponse } from 'next/server'
import { getDb } from '@/db'
import { ensureWorkspace, createAnchor, bumpAnchor, listAnchors, deleteAnchor } from '@/core/workspace'
import { staleForAnchor } from '@/core/preview'
import { anchorInputSchema } from '@/core/schema'

export const dynamic = 'force-dynamic'

export async function GET() {
  const db = getDb()
  const { projectId } = ensureWorkspace(db)
  return NextResponse.json({ anchors: listAnchors(db, projectId) })
}

export async function POST(request: Request) {
  const db = getDb()
  const { projectId } = ensureWorkspace(db)

  const parsed = anchorInputSchema.safeParse(await request.json())
  if (!parsed.success) {
    return NextResponse.json({ error: parsed.error.issues[0]?.message ?? 'Invalid anchor' }, { status: 400 })
  }

  return NextResponse.json({ id: createAnchor(db, projectId, parsed.data) })
}

/**
 * Bumping is the expensive action in the whole product — it invalidates every
 * downstream node in every flow. GET the blast radius first (`?preview=1`) so
 * the UI can show the count and the price before anyone commits.
 */
export async function PATCH(request: Request) {
  const db = getDb()
  const { projectId } = ensureWorkspace(db)
  const body = (await request.json().catch(() => ({}))) as {
    id?: string
    refImages?: string[]
    preview?: boolean
  }

  if (!body.id) return NextResponse.json({ error: 'id is required' }, { status: 400 })

  const affected = staleForAnchor(db, projectId, body.id)
  const summary = {
    nodeCount: affected.length,
    flowCount: new Set(affected.map((a) => a.flowId)).size,
    estimatedCents: affected.reduce((sum, a) => sum + a.estimatedCents, 0),
  }

  if (body.preview) return NextResponse.json({ preview: summary })

  return NextResponse.json({ version: bumpAnchor(db, body.id, body.refImages), affected: summary })
}

export async function DELETE(request: Request) {
  const db = getDb()
  ensureWorkspace(db)
  const id = new URL(request.url).searchParams.get('id')
  if (!id) return NextResponse.json({ error: 'id is required' }, { status: 400 })

  deleteAnchor(db, id)
  return NextResponse.json({ ok: true })
}
