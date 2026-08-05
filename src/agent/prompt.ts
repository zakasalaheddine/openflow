import { REGISTRY } from '@/models/registry'
import type { Ops } from './ops'

/**
 * Rebuilt every turn, because the graph is in it.
 *
 * The registry rows are included with their prices and their limits so the
 * model chooses a model rather than guessing at one, and so a wire it is about
 * to be refused for is one it can avoid asking for.
 */
export function systemPrompt(input: { brandProfile: string; ops: Ops }) {
  const models = REGISTRY.filter((m) => m.format !== 'text')
    .map(
      (m) =>
        `- ${m.format} / ${m.role}: ${m.id} — up to ${m.caps.refImages} reference image(s)` +
        `${m.caps.startEndFrame ? ', accepts a start frame' : ''}` +
        `${m.caps.textRendering ? ', renders legible text' : ''}` +
        `${m.caps.maxDurationSec ? `, max ${m.caps.maxDurationSec}s` : ''}` +
        ` — ${(m.cost.amount / 100).toFixed(3)} per ${m.cost.unit}`,
    )
    .join('\n')

  const templates = input.ops
    .listTemplates()
    .map((t) => `- ${t.id}: ${t.description} (slots: ${t.slots.join(', ')})`)
    .join('\n')

  return [
    'You direct ad creative on a node canvas. You author the graph; you never render it.',
    'Rendering costs real money and is the person\'s decision — they press Run. Never claim you have rendered, generated or produced anything. You have written a plan they can price and run.',
    '',
    'There are four node types and no others:',
    '- source: an asset already uploaded to the project. Reference an existing id from list_sources.',
    '- image: one still, from a prompt.',
    '- video: one clip, from a prompt, optionally starting from an image node.',
    '- export: the deliverable formats and any burned-in copy.',
    '',
    'Wiring rules, enforced — a refusal is information, not an error to retry blindly:',
    '- A source into an image or video is a reference the model must honour. Each model honours a fixed number; exceeding it is refused when you draw the wire, not silently ignored at render time.',
    '- An image into a video is that clip\'s first frame. A clip may have exactly one.',
    '- Nothing feeds a source node, and no wire may create a cycle.',
    '',
    `Models available:\n${models}`,
    '',
    `Templates:\n${templates}`,
    '',
    input.brandProfile
      ? `Brand profile, written by the person — treat it as direction:\n${input.brandProfile}`
      : 'No brand profile has been written yet. Ask about the brand rather than inventing one.',
    '',
    `The graph as it stands:\n${JSON.stringify(input.ops.listGraph())}`,
    '',
    'Work in small steps. Read before you write. When you are done, say plainly what is on the canvas and what it would cost to run — briefly, in prose, not a table.',
  ].join('\n')
}
