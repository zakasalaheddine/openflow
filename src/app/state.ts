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

export type SourceRow = {
  id: string
  kind: 'image' | 'video' | 'text'
  files: string[]
  text: string | null
  notes: string | null
  version: number
}

export type FlowState = {
  projectId: string
  flowId: string
  updatedAt: string
  graph: Flow
  sources: SourceRow[]
  nodes: Record<string, NodeState>
  totals: {
    staleCount: number
    runningCount: number
    estimatedCents: number
    spentCents: number
  }
}

export const money = (cents: number) => `$${(cents / 100).toFixed(2)}`

export async function fetchFlow(role: ModelRole): Promise<FlowState> {
  const response = await fetch(`/api/flow?role=${role}`, { cache: 'no-store' })
  if (!response.ok) throw new Error('Could not load the flow')
  return response.json()
}

export class StaleGraphError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'StaleGraphError'
  }
}

/** `updatedAt` is the read this write was built on. A 409 means re-read and re-apply. */
export async function saveGraph(graph: Flow, updatedAt: string) {
  const response = await fetch('/api/flow', {
    method: 'PATCH',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ graph, updatedAt }),
  })
  if (response.status === 409) {
    throw new StaleGraphError(((await response.json()) as { error?: string }).error ?? 'Stale')
  }
  if (!response.ok) {
    throw new Error(((await response.json()) as { error?: string }).error ?? 'Could not save')
  }
}

/** Uploads a dropped file and returns the new source's id. */
export async function uploadFile(file: File): Promise<{ id: string; kind: SourceRow['kind'] }> {
  const body = new FormData()
  body.append('file', file)
  const response = await fetch('/api/sources', { method: 'POST', body })
  const json = await response.json()
  if (!response.ok) throw new Error(json.error ?? 'Upload failed')
  return json
}

export async function createTextSource(text: string): Promise<{ id: string }> {
  const body = new FormData()
  body.append('text', text)
  const response = await fetch('/api/sources', { method: 'POST', body })
  const json = await response.json()
  if (!response.ok) throw new Error(json.error ?? 'Could not save that note')
  return json
}

export type BlastRadius = { nodeCount: number; flowCount: number; estimatedCents: number }

/** What replacing this asset would invalidate, without invalidating anything. */
export async function previewReplace(id: string): Promise<BlastRadius> {
  const body = new FormData()
  body.append('id', id)
  body.append('preview', '1')
  const response = await fetch('/api/sources', { method: 'PATCH', body })
  return (await response.json()).preview
}

export async function replaceSource(id: string, next: File | string) {
  const body = new FormData()
  body.append('id', id)
  if (typeof next === 'string') body.append('text', next)
  else body.append('file', next)

  const response = await fetch('/api/sources', { method: 'PATCH', body })
  if (!response.ok) {
    throw new Error(((await response.json()) as { error?: string }).error ?? 'Could not replace')
  }
}

export type ExportOutcome = {
  dir: string
  written: { file: string; format: string }[]
  rejected: { nodeId: string; format: string; reasons: string[] }[]
}

export async function startExport(): Promise<ExportOutcome> {
  const response = await fetch('/api/export', { method: 'POST' })
  const body = await response.json()
  if (!response.ok) throw new Error(body.error ?? 'Export failed')
  return body as ExportOutcome
}

export type BriefState = {
  brandProfile: string
  enabled: boolean
  templates: { id: string; name: string; description: string }[]
}

export const fetchBrief = async (): Promise<BriefState> => (await fetch('/api/brief')).json()

export async function saveBrandProfile(brandProfile: string) {
  await fetch('/api/brief', {
    method: 'PATCH',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ brandProfile }),
  })
}

export type RunOutcome =
  | { kind: 'started'; enqueued: number; cached: number }
  | { kind: 'needs-confirmation'; message: string; estimatedCents: number }
  | { kind: 'refused'; message: string }

/** `nodeId` renders that one node plus any upstream it still needs; omit it for the whole flow. */
export async function startRun(
  role: ModelRole,
  confirmOverspend = false,
  nodeId?: string,
): Promise<RunOutcome> {
  const response = await fetch('/api/run', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ role, confirmOverspend, nodeId }),
  })
  const body = await response.json()

  if (response.status === 409) {
    return { kind: 'needs-confirmation', message: body.error, estimatedCents: body.estimatedCents }
  }
  if (!response.ok) return { kind: 'refused', message: body.error ?? 'Run failed' }
  return { kind: 'started', enqueued: body.enqueued, cached: body.cached }
}

export type ChatState = { enabled: boolean; messages: { role: string; content: unknown }[] }

export const fetchChat = async (): Promise<ChatState> =>
  (await fetch('/api/chat', { cache: 'no-store' })).json()

export const clearChat = () => fetch('/api/chat', { method: 'DELETE' })

/**
 * Streams the reply. `onText` is called with each chunk as it arrives.
 *
 * The canvas is not told to refresh: it already polls graph_json every 1200ms,
 * so nodes the agent adds appear on their own.
 *
 * A stream that ends is not necessarily a success: a mid-turn failure is
 * appended to the body as a bracketed sentence rather than raised as an HTTP
 * error, so it arrives through `onText` like any other chunk and is read by
 * whoever is looking at the transcript, same as the rest of the reply.
 */
export async function sendChat(message: string, onText: (chunk: string) => void) {
  const response = await fetch('/api/chat', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ message }),
  })

  if (!response.ok || !response.body) {
    const body = (await response.json().catch(() => ({}))) as { error?: string }
    throw new Error(body.error ?? 'Chat failed')
  }

  const reader = response.body.pipeThrough(new TextDecoderStream()).getReader()
  for (;;) {
    const { done, value } = await reader.read()
    if (done) return
    if (value) onText(value)
  }
}
