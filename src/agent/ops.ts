import { randomUUID } from 'node:crypto'
import { eq } from 'drizzle-orm'
import { z } from 'zod'
import type { Db } from '@/db'
import { flows } from '@/db/schema'
import { saveGraph, listSources as listProjectSources } from '@/core/workspace'
import { applyWire, removeEdge, removeNode } from '@/core/wiring'
import { buildFlowFromBrief, loadTemplates } from '@/core/brief'
import { previewRun } from '@/core/preview'
import { flowSchema, nodeSchema } from '@/core/schema'
import { newNode } from '@/core/node-defaults'
import { freeSlot } from '@/core/slots'
import type { Flow, FlowNode } from '@/core/types'

/**
 * The agent's whole vocabulary, and nothing more.
 *
 * Every function here loads graph_json, calls a function that already exists in
 * /core, and writes it back. No new rules live in this file: the capability
 * gate is applyWire's, the node shape is nodeSchema's, the default node values
 * are newNode's, the template validation is buildFlowFromBrief's. A second
 * implementation of any of them would let the chat and the canvas disagree
 * about what is legal, which is the one failure this layer must not have.
 *
 * There is deliberately no run tool. The agent authors; spending stays a
 * deliberate human act, which is what keeps this inside the README's non-goal.
 */

const modelRole = z.enum(['draft', 'hero', 'specialist'])

export const listGraphInput = z.object({})
export const listSourcesInput = z.object({})

export const addNodeInput = z.object({
  type: z.enum(['source', 'image', 'video', 'export']),
  label: z.string().optional(),
  /** Required for image and video. */
  prompt: z.string().optional(),
  /** Required for source: an id from list_sources. */
  sourceId: z.string().optional(),
  modelRole: modelRole.optional(),
  durationSec: z.number().min(1).max(60).optional(),
  audio: z.boolean().optional(),
  formats: z
    .array(z.object({ name: z.string(), w: z.number(), h: z.number() }))
    .optional(),
})

export const updateNodeInput = z.object({
  id: z.string(),
  label: z.string().optional(),
  prompt: z.string().optional(),
  modelRole: modelRole.optional(),
  durationSec: z.number().min(1).max(60).optional(),
  audio: z.boolean().optional(),
  formats: z
    .array(z.object({ name: z.string(), w: z.number(), h: z.number() }))
    .optional(),
})

export const deleteNodeInput = z.object({ id: z.string() })
export const wireInput = z.object({ from: z.string(), to: z.string() })
export const unwireInput = z.object({ edgeId: z.string() })
export const applyTemplateInput = z.object({
  templateId: z.string(),
  prompts: z.record(z.string(), z.string()),
})

export type AddNodeInput = z.infer<typeof addNodeInput>
export type UpdateNodeInput = z.infer<typeof updateNodeInput>

/**
 * Ids are not hashed — hashableConfig is a whitelist that excludes id and
 * position — so the format only has to be unique and readable in a chat reply.
 */
const newId = (type: string) => `${type}-${randomUUID().slice(0, 8)}`

export type Ops = ReturnType<typeof createOps>

export function createOps(db: Db, ids: { projectId: string; flowId: string }) {
  const read = (): Flow => db.select().from(flows).where(eq(flows.id, ids.flowId)).get()!.graphJson as Flow

  const write = (graph: Flow) => {
    // The same door the canvas comes through: a graph the schema refuses must
    // never reach the worker, whichever surface built it.
    const parsed = flowSchema.safeParse(graph)
    if (!parsed.success) throw new Error(parsed.error.issues[0]?.message ?? 'Invalid graph')
    // saveGraph returns the new updated_at write token. Only the canvas's
    // guarded PATCH (saveGraphIfCurrent) needs to keep it — the agent always
    // reads fresh before it writes, so there is nothing to thread it into here.
    saveGraph(db, ids.flowId, parsed.data as Flow)
  }

  const nodeOf = (graph: Flow, id: string) => {
    const node = graph.nodes.find((n) => n.id === id)
    if (!node) throw new Error(`No node ${id}. Call list_graph to see what exists.`)
    return node
  }

  return {
    listGraph() {
      const graph = read()
      const preview = previewRun(db, ids.flowId)
      const estimates = new Map(
        [...preview.stale, ...preview.cached, ...preview.inFlight].map((p) => [
          p.nodeId,
          Math.round(p.estimatedCents),
        ]),
      )
      return {
        nodes: graph.nodes.map((node) => ({ ...node, estimatedCents: estimates.get(node.id) ?? 0 })),
        edges: graph.edges,
        estimatedCents: Math.round(preview.estimatedCents),
      }
    },

    listSources() {
      return listProjectSources(db, ids.projectId).map((source) => ({
        id: source.id,
        kind: source.kind,
        notes: source.notes,
        text: source.text,
        version: source.version,
      }))
    },

    /**
     * Not a tool, and carries no input schema for that reason: `agent/prompt.ts`
     * (Task 4) calls this directly to render the template menu into the system
     * prompt text, and the model answers by passing a `templateId` string to
     * `apply_template` — there is no round trip here for a schema to guard.
     */
    listTemplates() {
      return loadTemplates().map((t) => ({
        id: t.id,
        name: t.name,
        description: t.description,
        slots: t.slots,
      }))
    },

    addNode(input: AddNodeInput) {
      const graph = read()
      const id = newId(input.type)
      // freeSlot, not a fixed point: two nodes added in one turn must not land
      // on each other. Same helper the canvas toolbar uses.
      const position = freeSlot(graph.nodes)
      // newNode carries the one set of defaults the canvas and the agent both
      // build a fresh node from — see core/node-defaults.ts.
      const node = newNode(input.type, {
        id,
        position,
        label: input.label,
        sourceId: input.sourceId,
        prompt: input.prompt,
        modelRole: input.modelRole,
        durationSec: input.durationSec,
        audio: input.audio,
        formats: input.formats,
      })

      write({ ...graph, nodes: [...graph.nodes, node] })
      return { id }
    },

    updateNode(input: UpdateNodeInput) {
      const graph = read()
      const current = nodeOf(graph, input.id)
      const { id: _id, ...patch } = input
      const provided = Object.entries(patch).filter(([, v]) => v !== undefined)
      const candidate = { ...current, ...Object.fromEntries(provided) }

      const parsed = nodeSchema.safeParse(candidate)
      if (!parsed.success) throw new Error(parsed.error.issues[0]?.message ?? 'Invalid node')

      // nodeSchema silently drops a field it doesn't recognise for this node's
      // type — durationSec on an image, say — and safeParse still succeeds, so
      // an update that changed nothing would otherwise come back looking like
      // it worked. The caller here is a model that only learns from an error
      // it's told about, so name what got dropped rather than let it move on.
      const dropped = provided.map(([key]) => key).filter((key) => !(key in parsed.data))
      if (dropped.length > 0) {
        // updateNodeInput, not a hand-written list: it's already the set of
        // fields this tool accepts, so this can only ever name a field the
        // caller could actually have sent — never internals like `position`,
        // and never `seed`, which nodeSchema allows but updateNodeInput does not.
        const patchable = new Set(Object.keys(updateNodeInput.shape).filter((key) => key !== 'id'))
        const editable = Object.keys(parsed.data).filter((key) => patchable.has(key))
        throw new Error(
          `A ${current.type} node has no ${dropped.join(', ')}. Its editable fields are: ${editable.join(', ')}.`,
        )
      }

      write({
        ...graph,
        nodes: graph.nodes.map((node) => (node.id === input.id ? (parsed.data as FlowNode) : node)),
      })
      return { id: input.id }
    },

    deleteNode(input: { id: string }) {
      const graph = read()
      nodeOf(graph, input.id)
      write(removeNode(graph, input.id))
      return { id: input.id }
    },

    wire(input: { from: string; to: string }) {
      const graph = read()
      // applyWire, not a copy: the reference cap, the one-start-frame rule and
      // the cycle check all live there, and the canvas calls the same function.
      const next = applyWire(graph, input.from, input.to)
      write(next)
      const edge = next.edges.at(-1)!
      return { edgeId: edge.id, role: edge.role }
    },

    unwire(input: { edgeId: string }) {
      const graph = read()
      if (!graph.edges.some((e) => e.id === input.edgeId)) {
        throw new Error(`No edge ${input.edgeId}. Call list_graph to see what exists.`)
      }
      write(removeEdge(graph, input.edgeId))
      return { edgeId: input.edgeId }
    },

    applyTemplate(input: { templateId: string; prompts: Record<string, string> }) {
      // Reuses the brief path's validation wholesale: an unknown template id or
      // an unfilled slot is refused there, loudly, exactly as before.
      const graph = buildFlowFromBrief(input, loadTemplates())
      write(graph)
      return { nodeIds: graph.nodes.map((n) => n.id) }
    },
  }
}
