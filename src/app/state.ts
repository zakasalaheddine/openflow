import type { Flow, ModelRole } from '@/core/types'

export type NodeState = {
  status: 'stale' | 'queued' | 'claimed' | 'submitted' | 'polling' | 'succeeded' | 'failed'
  error: string | null
  costCents: number
  estimatedCents: number
  modelId: string | null
  subtree: { nodeCount: number; cents: number }
  outputs: { id: string; url: string; mime: string }[]
}

export type AnchorRow = {
  id: string
  kind: string
  refImages: string[]
  notes: string | null
  version: number
}

export type FlowState = {
  projectId: string
  flowId: string
  graph: Flow
  anchors: AnchorRow[]
  nodes: Record<string, NodeState>
  totals: { staleCount: number; estimatedCents: number; spentCents: number }
}

export const money = (cents: number) => `$${(cents / 100).toFixed(2)}`

export async function fetchFlow(role: ModelRole): Promise<FlowState> {
  const response = await fetch(`/api/flow?role=${role}`, { cache: 'no-store' })
  if (!response.ok) throw new Error('Could not load the flow')
  return response.json()
}

export async function saveGraph(graph: Flow) {
  const response = await fetch('/api/flow', {
    method: 'PATCH',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(graph),
  })
  if (!response.ok) {
    throw new Error(((await response.json()) as { error?: string }).error ?? 'Could not save')
  }
}

export type RunOutcome =
  | { kind: 'started'; enqueued: number; cached: number }
  | { kind: 'needs-confirmation'; message: string; estimatedCents: number }
  | { kind: 'refused'; message: string }

export async function startRun(role: ModelRole, confirmOverspend = false): Promise<RunOutcome> {
  const response = await fetch('/api/run', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ role, confirmOverspend }),
  })
  const body = await response.json()

  if (response.status === 409) {
    return { kind: 'needs-confirmation', message: body.error, estimatedCents: body.estimatedCents }
  }
  if (!response.ok) return { kind: 'refused', message: body.error ?? 'Run failed' }
  return { kind: 'started', enqueued: body.enqueued, cached: body.cached }
}
