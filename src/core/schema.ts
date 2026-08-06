import { z } from 'zod'

/**
 * The trust boundary. `graph_json` decides what gets dispatched and billed, so
 * a graph arriving over HTTP is validated here rather than trusted and blown up
 * inside the worker — where a bad node means a half-executed, half-paid run.
 */
const position = z.object({ x: z.number(), y: z.number() }).optional()

/**
 * Floored rather than merely positive: a card small enough to be invisible is a
 * node you can neither read nor grab back, and it arrives over HTTP.
 */
const size = z.object({ w: z.number().min(80), h: z.number().min(80) }).optional()

/** Fractions of the frame, so 0..1 rather than pixels. */
const fraction = z.number().min(0).max(1)

const formatSpec = z
  .object({
    safeZone: z
      .object({ top: fraction, right: fraction, bottom: fraction, left: fraction })
      .partial()
      .optional(),
    minScale: z.number().min(0).optional(),
    maxDurationSec: z.number().min(0).optional(),
    maxTextCoverage: fraction.optional(),
  })
  .optional()

const textOverlay = z
  .object({
    headline: z.string().optional(),
    cta: z.string().optional(),
    box: z.object({ x: fraction, y: fraction, w: fraction, h: fraction }).optional(),
  })
  .optional()

export const nodeSchema = z.discriminatedUnion('type', [
  z.object({
    id: z.string().min(1),
    type: z.literal('source'),
    position,
    size,
    label: z.string().optional(),
    sourceId: z.string().min(1),
  }),
  z.object({
    id: z.string().min(1),
    type: z.literal('image'),
    position,
    size,
    label: z.string().optional(),
    prompt: z.string(),
    // Validated as a string here and against the catalog on save: schema.ts is
    // pure and has no business reading a file off disk.
    modelId: z.string().min(1),
    seed: z.number().int().optional(),
  }),
  z.object({
    id: z.string().min(1),
    type: z.literal('video'),
    position,
    size,
    label: z.string().optional(),
    prompt: z.string(),
    // Bounded: duration is priced per second, and an unbounded value from a
    // client is an unbounded invoice.
    durationSec: z.number().min(1).max(60),
    audio: z.boolean(),
    modelId: z.string().min(1),
    seed: z.number().int().optional(),
  }),
  z.object({
    id: z.string().min(1),
    type: z.literal('export'),
    position,
    size,
    label: z.string().optional(),
    formats: z.array(
      z.object({ name: z.string(), w: z.number(), h: z.number(), spec: formatSpec }),
    ),
    fps: z.number().optional(),
    codec: z.string().optional(),
    // Dropped silently before this existed, which made every spec check pass:
    // no box, no safe-zone rule, and an export that shipped its headline into
    // the platform's own chrome.
    overlay: textOverlay,
  }),
])

const edgeSchema = z.object({
  id: z.string().min(1),
  from: z.string().min(1),
  to: z.string().min(1),
  role: z.enum(['reference', 'start_frame', 'end_frame', 'input']),
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
    const edgeIds = new Set<string>()
    for (const edge of flow.edges) {
      // A dangling edge would be dropped by the graph walks anyway, but
      // accepting one lets the stored graph disagree with what the user sees.
      if (!ids.has(edge.from) || !ids.has(edge.to)) {
        ctx.addIssue({ code: 'custom', message: `Edge ${edge.id} references a node that does not exist` })
      }
      // Edge ids are now derived from their endpoints (core/wiring.ts), so a
      // duplicate id can only arrive here from outside applyWire — a hand-built
      // PATCH body. This is the trust boundary; the guard belongs here, next
      // to the node one it mirrors.
      if (edgeIds.has(edge.id)) {
        ctx.addIssue({ code: 'custom', message: `Duplicate edge id ${edge.id}` })
      }
      edgeIds.add(edge.id)
    }
  })


