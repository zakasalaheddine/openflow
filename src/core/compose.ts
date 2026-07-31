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

/** Files from image and video sources wired in as references, in edge order. */
export function referenceFiles(
  flow: Flow,
  nodeId: NodeId,
  sources: Map<string, Source>,
): string[] {
  return referencedSources(flow, nodeId, sources)
    .filter((source) => source.kind !== 'text')
    .flatMap((source) => (source.files as string[]) ?? [])
}
