import { NextResponse } from 'next/server'
import { eq } from 'drizzle-orm'
import { getDb } from '@/db'
import { projects } from '@/db/schema'
import { ensureWorkspace } from '@/core/workspace'
import { loadTemplates } from '@/core/brief'
import { llmMode } from '@/env'

export const dynamic = 'force-dynamic'

/** The brand profile, and the templates the model may choose between. */
export async function GET() {
  const db = getDb()
  const { projectId } = ensureWorkspace(db)
  const project = db.select().from(projects).where(eq(projects.id, projectId)).get()

  return NextResponse.json({
    brandProfile: project?.brandProfile ?? '',
    enabled: llmMode() !== 'off',
    templates: loadTemplates().map((t) => ({ id: t.id, name: t.name, description: t.description })),
  })
}

/** Saves a confirmed brand profile. Never written by the model on its own. */
export async function PATCH(request: Request) {
  const db = getDb()
  const { projectId } = ensureWorkspace(db)
  const body = (await request.json().catch(() => ({}))) as { brandProfile?: string }

  db.update(projects)
    .set({ brandProfile: (body.brandProfile ?? '').trim() })
    .where(eq(projects.id, projectId))
    .run()

  return NextResponse.json({ brandProfile: (body.brandProfile ?? '').trim() })
}
