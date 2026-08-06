import { eq } from 'drizzle-orm'
import { NextResponse } from 'next/server'
import { getDb } from '@/db'
import { projects, messages } from '@/db/schema'
import { ensureWorkspace } from '@/core/workspace'
import { runTurn, loadThread } from '@/agent/loop'
import { createChatModel, LlmDisabledError } from '@/models/llm'
import { llmMode, isDemo } from '@/env'

export const dynamic = 'force-dynamic'

/**
 * The thread, so a reload does not lose the conversation.
 *
 * `demo` is reported separately from `enabled`, not folded into one boolean:
 * a demo visitor cannot set an environment variable, and the panel needs to
 * say the true reason chat is off rather than a fix that isn't theirs to make.
 */
export async function GET() {
  const db = getDb()
  const { flowId } = ensureWorkspace(db)
  const demo = isDemo()
  return NextResponse.json({
    enabled: llmMode() !== 'off' && !demo,
    demo,
    messages: loadThread(db, flowId),
  })
}

/**
 * A turn. Writes graph_json through the tools; dispatches nothing.
 *
 * The 403 under DEMO is not decoration: without it a public demo is an open
 * OpenRouter proxy billed to whoever deployed it.
 */
export async function POST(request: Request) {
  if (isDemo()) {
    return NextResponse.json({ error: 'This is a read-only demo.' }, { status: 403 })
  }

  const db = getDb()
  const { projectId, flowId } = ensureWorkspace(db)
  const body = (await request.json().catch(() => ({}))) as { message?: string }
  const message = (body.message ?? '').trim()

  if (!message) {
    return NextResponse.json({ error: 'Say what you want built.' }, { status: 400 })
  }

  // Checked here, not caught below. streamText never throws synchronously: a
  // provider that refuses produces a 200 with an empty body, so a missing key
  // would render as a blank reply instead of the sentence naming the variable.
  if (llmMode() === 'off') {
    return NextResponse.json({ error: new LlmDisabledError().message }, { status: 422 })
  }

  const project = db.select().from(projects).where(eq(projects.id, projectId)).get()

  const result = runTurn({
    db,
    ids: { projectId, flowId },
    model: createChatModel({ mode: llmMode() }),
    brandProfile: project?.brandProfile ?? '',
    message,
  })

  // Hand-pumped rather than `toTextStreamResponse()`, for one reason: that
  // helper swallows a mid-turn failure and closes the body, so a model that
  // dies four tool calls in looks to the reader like a model with nothing to
  // say. The tool calls already ran and the nodes are already on the canvas —
  // saying so is the difference between a bug report and a retry.
  const stream = new ReadableStream<Uint8Array>({
    async start(controller) {
      const encoder = new TextEncoder()
      try {
        for await (const chunk of result.textStream) {
          controller.enqueue(encoder.encode(chunk))
        }
      } catch (error) {
        controller.enqueue(
          encoder.encode(
            `\n\n[The model stopped: ${error instanceof Error ? error.message : String(error)}. Anything already on the canvas is saved.]`,
          ),
        )
      } finally {
        controller.close()
      }
    },
  })

  return new Response(stream, { headers: { 'content-type': 'text/plain; charset=utf-8' } })
}

/** Starting over. The graph is untouched — only the conversation is cleared. */
export async function DELETE() {
  const db = getDb()
  const { flowId } = ensureWorkspace(db)
  db.delete(messages).where(eq(messages.flowId, flowId)).run()
  return NextResponse.json({ ok: true })
}
