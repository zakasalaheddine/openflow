import { readdirSync, readFileSync } from 'node:fs'
import path from 'node:path'
import { z } from 'zod'
import { flowSchema } from './schema'
import type { Flow } from './types'

/**
 * Brief → flow. An LLM picks a template and fills its slots; it never invents
 * topology.
 *
 * The constraint is the whole design. A model that can emit arbitrary graphs
 * can emit a graph that renders forty video nodes at hero prices, and the first
 * anyone hears of it is the invoice. Picking from a fixed set of templates
 * caps the blast radius at whatever the template already costs.
 */
export class BriefError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'BriefError'
  }
}

export type FlowTemplate = {
  id: string
  name: string
  description: string
  /** Placeholders the LLM must fill. Referenced in prompts as {{slot}}. */
  slots: string[]
  flow: Flow
}

const templateSchema = z.object({
  id: z.string().min(1),
  name: z.string().min(1),
  description: z.string().min(1),
  slots: z.array(z.string().min(1)),
  flow: flowSchema,
})

/**
 * Resolved against this module, not the working directory: templates ship with
 * the package, and `npx openflow-studio` is launched from wherever the user
 * happens to be standing.
 */
export const TEMPLATES_DIR =
  process.env.OPENFLOW_TEMPLATES_DIR ?? path.resolve(import.meta.dirname, '../../flows/templates')

export function loadTemplates(dir = TEMPLATES_DIR): FlowTemplate[] {
  return readdirSync(dir)
    .filter((file) => file.endsWith('.json'))
    .sort()
    .map((file) => {
      const parsed = templateSchema.safeParse(JSON.parse(readFileSync(path.join(dir, file), 'utf8')))
      if (!parsed.success) {
        // A broken template is a repo bug, and it must not surface as a
        // mysterious brief failure at hero prices.
        throw new BriefError(`Template ${file} is invalid: ${parsed.error.message}`)
      }
      return parsed.data as FlowTemplate
    })
}

/** What the LLM is allowed to say back. Anything else is rejected. */
export const briefResponseSchema = z.object({
  templateId: z.string().min(1),
  prompts: z.record(z.string(), z.string()),
})

const SLOT = /\{\{\s*([a-zA-Z0-9_-]+)\s*\}\}/g

const fill = (text: string, prompts: Record<string, string>) =>
  text.replace(SLOT, (_, slot: string) => prompts[slot] ?? '')

/**
 * Turns an untrusted LLM response into a graph, or refuses.
 *
 * Every failure here is loud. A missing prompt field that silently became an
 * empty string would render a blank shot and bill for it, which is the exact
 * failure this validation exists to prevent.
 */
export function buildFlowFromBrief(raw: unknown, templates: FlowTemplate[]): Flow {
  const parsed = briefResponseSchema.safeParse(raw)
  if (!parsed.success) {
    throw new BriefError(`The model's response was not a brief result: ${parsed.error.message}`)
  }

  const template = templates.find((t) => t.id === parsed.data.templateId)
  if (!template) {
    throw new BriefError(
      `Unknown template '${parsed.data.templateId}'. Valid templates: ${templates.map((t) => t.id).join(', ')}.`,
    )
  }

  const missing = template.slots.filter((slot) => !parsed.data.prompts[slot]?.trim())
  if (missing.length > 0) {
    throw new BriefError(
      `Template '${template.id}' needs ${missing.join(', ')}, and the model left ${missing.length === 1 ? 'it' : 'them'} empty.`,
    )
  }

  const prompts = parsed.data.prompts
  return {
    nodes: template.flow.nodes.map((node) => {
      if ('prompt' in node) return { ...node, prompt: fill(node.prompt, prompts) }
      // Headline and CTA are slots too — the copy is as much the brief's answer
      // as the scene is, and a template that fills one but not the other ships
      // an ad with `{{headline}}` burned into it.
      if (node.type === 'export' && node.overlay) {
        return {
          ...node,
          overlay: {
            ...node.overlay,
            ...(node.overlay.headline === undefined ? {} : { headline: fill(node.overlay.headline, prompts) }),
            ...(node.overlay.cta === undefined ? {} : { cta: fill(node.overlay.cta, prompts) }),
          },
        }
      }
      return node
    }),
    edges: template.flow.edges,
  }
}

/**
 * The prompt sent to the model.
 *
 * The brand profile is sent as text, never the assets themselves. The profile
 * is a short description a person confirmed; shipping the raw files would send
 * a product photo to an LLM that cannot use it, on every brief.
 */
export function briefPrompt(
  brief: string,
  brandProfile: string,
  templates: FlowTemplate[],
): string {
  const menu = templates
    .map((t) => `- ${t.id}: ${t.description} (slots: ${t.slots.join(', ')})`)
    .join('\n')

  return [
    'Pick one template and write the prompts that fill its slots.',
    'Reply with JSON only: {"templateId": "...", "prompts": {"slot": "text"}}.',
    'Do not invent a template id and do not add nodes.',
    '',
    `Brand profile:\n${brandProfile}`,
    '',
    `Brief:\n${brief}`,
    '',
    `Templates:\n${menu}`,
  ].join('\n')
}
