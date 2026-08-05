import { streamText, stepCountIs, type LanguageModel, type ModelMessage } from 'ai'
import { eq, asc } from 'drizzle-orm'
import type { Db } from '@/db'
import { messages } from '@/db/schema'
import { createOps } from './ops'
import { createTools } from './tools'
import { systemPrompt } from './prompt'

/** Twelve steps is enough to build a three-shot flow and short of a runaway loop. */
const MAX_STEPS = 12

export const loadThread = (db: Db, flowId: string): ModelMessage[] =>
  db
    .select()
    .from(messages)
    .where(eq(messages.flowId, flowId))
    .orderBy(asc(messages.seq))
    .all()
    .map((row) => row.content as ModelMessage)

export function appendThread(db: Db, flowId: string, batch: ModelMessage[]) {
  for (const message of batch) {
    db.insert(messages)
      .values({
        flowId,
        role: message.role,
        content: message as never,
      })
      .run()
  }
}

/**
 * One turn: history in, text out, graph mutated by the tools along the way.
 *
 * The assistant messages are persisted per step, as each step finishes, rather
 * than once at the end. A stream that dies mid-turn has already run its tool
 * calls — the node is on the canvas — and a history without them makes the
 * retry add it a second time.
 */
export function runTurn(input: {
  db: Db
  ids: { projectId: string; flowId: string }
  model: LanguageModel
  brandProfile: string
  message: string
}) {
  const ops = createOps(input.db, input.ids)

  const user: ModelMessage = { role: 'user', content: input.message }
  const history = loadThread(input.db, input.ids.flowId)
  appendThread(input.db, input.ids.flowId, [user])

  const result = streamText({
    model: input.model,
    system: systemPrompt({ brandProfile: input.brandProfile, ops }),
    messages: [...history, user],
    tools: createTools(ops),
    stopWhen: stepCountIs(MAX_STEPS),
    onStepFinish: (step) => appendThread(input.db, input.ids.flowId, step.response.messages),
  })

  return result
}
