import type { Flow, NodeId } from './types'
import type { Source } from '../db/schema'

/** Sources wired into a node as references, in edge order. */
function referencedSources(
  flow: Flow,
  nodeId: NodeId,
  sources: Map<string, Source>,
): Source[] {
  const byNodeId = new Map(
    flow.nodes.filter((n) => n.type === 'source').map((n) => [n.id, n.sourceId]),
  )

  return flow.edges
    .filter((e) => e.to === nodeId && e.role === 'reference')
    .map((e) => byNodeId.get(e.from))
    .map((sourceId) => (sourceId ? sources.get(sourceId) : undefined))
    // A deleted asset must not blank a prompt and then bill for the render.
    .filter((source): source is Source => source !== undefined)
}

/**
 * The prompt actually sent to the model.
 *
 * Text sources contribute fragments — brand tone reused across every shot
 * without retyping — and they come first, in the order their edges were made.
 * Edge order is persisted, so this is deterministic, which it has to be: the
 * composed prompt feeds the input hash, and a composition that reordered itself
 * would invalidate the cache on every run.
 */
export function composePrompt(
  flow: Flow,
  nodeId: NodeId,
  sources: Map<string, Source>,
): string {
  const node = flow.nodes.find((n) => n.id === nodeId)
  const own = node && 'prompt' in node ? node.prompt : ''

  const fragments = referencedSources(flow, nodeId, sources)
    .filter((source) => source.kind === 'text')
    .map((source) => (source.text ?? '').trim())
    .filter((fragment) => fragment.length > 0)

  return [...fragments, own].filter((part) => part.length > 0).join('\n\n')
}

/**
 * Whether this node has any reference that will arrive as an image.
 *
 * Not `referenceFiles(...).length > 0`, which sees uploaded assets only. A
 * rendered still wired in as a reference contributes a file the worker resolves
 * from its parent's latest run — invisible here, because the file does not exist
 * until that parent has rendered.
 *
 * This is the *planned* endpoint — what the canvas shows and what the plan
 * records. Dispatch does not trust it: `models/fal.ts` re-derives the endpoint
 * from the payload it is actually sending, so a wrong answer here misreports a
 * plan rather than buying a render that ignored its references.
 *
 * It answers from the graph alone for the same reason `planRun` does — the
 * canvas re-derives it every 1.2 seconds, long before anything has rendered.
 */
export function hasImageReference(
  flow: Flow,
  nodeId: NodeId,
  sources: Map<string, Source>,
): boolean {
  const byNodeId = new Map(flow.nodes.map((n) => [n.id, n]))

  return flow.edges
    .filter((e) => e.to === nodeId && e.role === 'reference')
    .some((e) => {
      const parent = byNodeId.get(e.from)
      if (!parent) return false
      // A rendered still. Its file arrives at dispatch, not now.
      if (parent.type === 'image') return true
      if (parent.type !== 'source') return false
      const source = sources.get(parent.sourceId)
      return source !== undefined && source.kind !== 'text'
    })
}
