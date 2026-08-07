import { NextResponse } from 'next/server'
import { getDb } from '@/db'
import {
  ensureWorkspace,
  listFlows,
  createFlow,
  renameFlow,
  deleteFlow,
  flowSlug,
  LastFlowError,
  NoSuchFlowError,
} from '@/core/workspace'
import { isDemo } from '@/env'

export const dynamic = 'force-dynamic'

/**
 * The workspace list, and the CRUD behind the switcher.
 *
 * Slugs go out, not ids: they are what the URL carries, so a client that reads
 * this list can link straight to `/f/<slug>` without knowing the prefix rule.
 */
export async function GET() {
  const db = getDb()
  const { projectId } = ensureWorkspace(db)
  return NextResponse.json({
    flows: listFlows(db, projectId).map((flow) => ({
      slug: flowSlug(flow.id),
      name: flow.name,
      updatedAt: flow.updatedAt,
    })),
  })
}

/**
 * The demo is a public page with an editable canvas. Without this a visitor
 * fills the switcher with empty workspaces, and the next visitor lands in one.
 */
const refuseDemo = () =>
  isDemo() ? NextResponse.json({ error: 'This is a read-only demo.' }, { status: 403 }) : null

export async function POST(request: Request) {
  const refused = refuseDemo()
  if (refused) return refused

  const db = getDb()
  const { projectId } = ensureWorkspace(db)
  const { name } = (await request.json().catch(() => ({}))) as { name?: string }
  const id = createFlow(db, projectId, name ?? '')
  return NextResponse.json({ slug: flowSlug(id) })
}

export async function PATCH(request: Request) {
  const refused = refuseDemo()
  if (refused) return refused

  const db = getDb()
  const { slug, name } = (await request.json().catch(() => ({}))) as {
    slug?: string
    name?: string
  }
  if (!slug) return NextResponse.json({ error: 'Which workspace?' }, { status: 400 })

  try {
    return NextResponse.json({ name: renameFlow(db, `flow:${flowSlug(slug)}`, name ?? '') })
  } catch (error) {
    return NextResponse.json(
      { error: error instanceof Error ? error.message : 'Could not rename' },
      { status: 400 },
    )
  }
}

export async function DELETE(request: Request) {
  const refused = refuseDemo()
  if (refused) return refused

  const db = getDb()
  const slug = new URL(request.url).searchParams.get('flow')
  if (!slug) return NextResponse.json({ error: 'Which workspace?' }, { status: 400 })

  try {
    deleteFlow(db, `flow:${flowSlug(slug)}`)
    return NextResponse.json({ ok: true })
  } catch (error) {
    // 409, not 400: the request was well formed and the workspace exists — it
    // is the only one, and the fix is to make another rather than to resend.
    if (error instanceof LastFlowError) {
      return NextResponse.json({ error: error.message }, { status: 409 })
    }
    if (error instanceof NoSuchFlowError) {
      return NextResponse.json({ error: error.message }, { status: 404 })
    }
    throw error
  }
}
