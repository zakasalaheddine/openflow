import { NextResponse } from 'next/server'
import { eq } from 'drizzle-orm'
import { getDb } from '@/db'
import { projects } from '@/db/schema'
import { ensureWorkspace, saveGraph } from '@/core/workspace'
import { buildFlowFromBrief, briefPrompt, loadTemplates, BriefError } from '@/core/brief'
import { createLlmAdapter, LlmDisabledError, MissingLlmFixtureError } from '@/models/llm'
import { llmMode, isDemo } from '@/env'

export const dynamic = 'force-dynamic'

/** The shape the model is constrained to. Validation still happens after. */
const RESPONSE_SCHEMA = {
  type: 'object',
  properties: {
    templateId: { type: 'string' },
    prompts: { type: 'object', additionalProperties: { type: 'string' } },
  },
  required: ['templateId', 'prompts'],
  additionalProperties: false,
}

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

/**
 * Brief in, graph on the canvas.
 *
 * The model picks a template and fills its slots. It never emits topology, so
 * the worst it can do is choose the wrong template — which is one undo, not a
 * surprise invoice for forty hero video nodes.
 *
 * The graph is written but nothing is dispatched. What comes back is a starting
 * point; every node is editable, and Run is still a deliberate act.
 */
export async function POST(request: Request) {
  if (isDemo()) {
    return NextResponse.json({ error: 'This is a read-only demo.' }, { status: 403 })
  }

  const db = getDb()
  const { projectId, flowId } = ensureWorkspace(db)
  const body = (await request.json().catch(() => ({}))) as { brief?: string }
  const brief = (body.brief ?? '').trim()

  if (!brief) {
    return NextResponse.json({ error: 'Say what the ad is for.' }, { status: 400 })
  }

  const project = db.select().from(projects).where(eq(projects.id, projectId)).get()
  const templates = loadTemplates()
  const prompt = briefPrompt(brief, project?.brandProfile ?? '', templates)

  try {
    const adapter = createLlmAdapter({ mode: llmMode() })
    const raw = await adapter.complete({ prompt, schema: RESPONSE_SCHEMA })
    const graph = buildFlowFromBrief(JSON.parse(raw), templates)
    saveGraph(db, flowId, graph)
    return NextResponse.json({ graph })
  } catch (error) {
    // A refused brief is a bad answer from the model, not a broken server: 422
    // so the client shows the reason and lets the user try different words.
    if (error instanceof BriefError || error instanceof SyntaxError) {
      return NextResponse.json({ error: (error as Error).message }, { status: 422 })
    }
    if (error instanceof LlmDisabledError || error instanceof MissingLlmFixtureError) {
      return NextResponse.json({ error: error.message }, { status: 422 })
    }
    return NextResponse.json(
      { error: error instanceof Error ? error.message : 'Brief failed' },
      { status: 500 },
    )
  }
}
