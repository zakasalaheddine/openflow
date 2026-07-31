import { z } from 'zod'

/**
 * The trust boundary. `graph_json` decides what gets dispatched and billed, so
 * a graph arriving over HTTP is validated here rather than trusted and blown up
 * inside the worker — where a bad node means a half-executed, half-paid run.
 */
const position = z.object({ x: z.number(), y: z.number() }).optional()

const assetRef = z.object({
  id: z.string(),
  path: z.string(),
  mime: z.string(),
  width: z.number().optional(),
  height: z.number().optional(),
  durationMs: z.number().optional(),
  fps: z.number().optional(),
  codec: z.string().optional(),
})

const modelRole = z.enum(['draft', 'hero', 'specialist'])

const nodeSchema = z.discriminatedUnion('type', [
  z.object({
    id: z.string().min(1),
    type: z.literal('source'),
    position,
    label: z.string().optional(),
    assets: z.array(assetRef),
  }),
  z.object({
    id: z.string().min(1),
    type: z.literal('image'),
    position,
    label: z.string().optional(),
    prompt: z.string(),
    anchors: z.array(z.string()),
    modelRole,
    seed: z.number().int().optional(),
  }),
  z.object({
    id: z.string().min(1),
    type: z.literal('video'),
    position,
    label: z.string().optional(),
    prompt: z.string(),
    anchors: z.array(z.string()),
    // Bounded: duration is priced per second, and an unbounded value from a
    // client is an unbounded invoice.
    durationSec: z.number().min(1).max(60),
    audio: z.boolean(),
    modelRole,
    seed: z.number().int().optional(),
  }),
  z.object({
    id: z.string().min(1),
    type: z.literal('export'),
    position,
    label: z.string().optional(),
    formats: z.array(z.object({ name: z.string(), w: z.number(), h: z.number() })),
    fps: z.number().optional(),
    codec: z.string().optional(),
  }),
])

const edgeSchema = z.object({
  id: z.string().min(1),
  from: z.string().min(1),
  to: z.string().min(1),
  role: z.enum(['start_frame', 'end_frame', 'input']),
  position: z.number().nullable(),
})

export const flowSchema = z
  .object({
    nodes: z.array(nodeSchema),
    edges: z.array(edgeSchema),
  })
  .superRefine((flow, ctx) => {
    const ids = new Set<string>()
    for (const node of flow.nodes) {
      if (ids.has(node.id)) {
        ctx.addIssue({ code: 'custom', message: `Duplicate node id ${node.id}` })
      }
      ids.add(node.id)
    }
    for (const edge of flow.edges) {
      // A dangling edge would be dropped by the graph walks anyway, but
      // accepting one lets the stored graph disagree with what the user sees.
      if (!ids.has(edge.from) || !ids.has(edge.to)) {
        ctx.addIssue({ code: 'custom', message: `Edge ${edge.id} references a node that does not exist` })
      }
    }
  })

export const anchorInputSchema = z.object({
  name: z.string().min(1).optional(),
  kind: z.string().min(1),
  refImages: z.array(z.string()).min(1),
  notes: z.string().optional(),
})
