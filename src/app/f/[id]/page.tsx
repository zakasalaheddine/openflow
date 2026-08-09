import { notFound } from 'next/navigation'
import { getDb } from '@/db'
import { NoSuchFlowError, resolveFlow, flowSlug } from '@/core/workspace'
import { Canvas } from '../../canvas'

export const dynamic = 'force-dynamic'

/**
 * One workspace, one URL. Two tabs on two slugs are two independent canvases:
 * they touch different `graph_json` rows and different chat threads, and the
 * `updatedAt` guard already handles the case where they are the same one.
 *
 * Checked here rather than left to the client's first fetch — a bad slug would
 * otherwise render an empty canvas whose every save 404s, which reads as a
 * broken app instead of a dead link.
 */
export default async function FlowPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params

  try {
    resolveFlow(getDb(), id)
  } catch (error) {
    if (error instanceof NoSuchFlowError) notFound()
    throw error
  }

  // Keyed on the slug so switching workspaces remounts rather than carrying the
  // previous canvas's graph, stamp and in-flight save queue into the new one.
  return <Canvas key={id} flow={flowSlug(id)} />
}
