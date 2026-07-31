'use client'

import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import {
  ReactFlow,
  ReactFlowProvider,
  Background,
  Controls,
  useNodesState,
  useEdgesState,
  useReactFlow,
  type Connection,
  type Node as RfNode,
  type Edge as RfEdge,
} from '@xyflow/react'
import { applyWire, removeNode, WiringError } from '@/core/wiring'
import { UnsupportedCapabilityError } from '@/models/registry'
import type { Flow, FlowNode, ModelRole, NodeId } from '@/core/types'
import { NodeCard } from './node-card'
import { Inspector } from './inspector'
import {
  fetchFlow,
  saveGraph,
  startRun,
  startExport,
  fetchBrief,
  saveBrandProfile,
  submitBrief,
  uploadFile,
  createTextSource,
  previewReplace,
  replaceSource,
  money,
  type BlastRadius,
  type FlowState,
  type NodeState,
} from './state'

const nodeTypes = { card: NodeCard }

const COLUMN = 250
const ROW = 265
const COLUMNS = 4

const slotFor = (index: number) => ({
  x: 40 + (index % COLUMNS) * COLUMN,
  y: 30 + Math.floor(index / COLUMNS) * ROW,
})

const BLANK: NodeState = {
  status: 'stale',
  error: null,
  costCents: 0,
  estimatedCents: 0,
  modelId: null,
  subtree: { nodeCount: 0, cents: 0 },
  outputs: [],
}

let counter = 0
const newId = (type: string) => `${type}-${++counter}-${Math.random().toString(36).slice(2, 6)}`

const nodeShapeOf = (graph: Flow) => graph.nodes.map((n) => n.id).join('|')
const edgeShapeOf = (graph: Flow) => graph.edges.map((e) => `${e.from}>${e.to}:${e.role}`).join('|')

export function Canvas() {
  return (
    <ReactFlowProvider>
      <CanvasInner />
    </ReactFlowProvider>
  )
}

function CanvasInner() {
  const { fitView, screenToFlowPosition } = useReactFlow()

  const [role, setRole] = useState<ModelRole>('draft')
  const [state, setState] = useState<FlowState | null>(null)
  const [selectedId, setSelectedId] = useState<NodeId | null>(null)
  const [notice, setNotice] = useState<string | null>(null)
  // Carries the node so "Render anyway" repeats the click that was refused,
  // rather than silently widening one shot into the whole flow.
  const [confirming, setConfirming] = useState<{ message: string; nodeId?: NodeId } | null>(null)
  const [showRefs, setShowRefs] = useState(true)
  const [hovered, setHovered] = useState<NodeId | null>(null)
  const [replacing, setReplacing] = useState<{ id: string; radius: BlastRadius } | null>(null)
  const [dropping, setDropping] = useState(false)
  const [exported, setExported] = useState<{ written: number; refusals: string[] } | null>(null)
  const [brief, setBrief] = useState<{ text: string; profile: string } | null>(null)
  const [briefing, setBriefing] = useState(false)

  const [rfNodes, setRfNodes, onNodesChange] = useNodesState<RfNode>([])
  const [rfEdges, setRfEdges, onEdgesChange] = useEdgesState<RfEdge>([])

  const graphRef = useRef<Flow>({ nodes: [], edges: [] })
  const nodeShapeRef = useRef<string>('')
  const edgeShapeRef = useRef<string>('')
  const queueRef = useRef<Promise<void>>(Promise.resolve())
  const interactingRef = useRef(false)
  const draggingRef = useRef(false)
  const fitViewRef = useRef(fitView)
  const replaceInputRef = useRef<HTMLInputElement>(null)

  useEffect(() => {
    fitViewRef.current = fitView
  }, [fitView])

  const absorb = useCallback(
    (next: FlowState) => {
      setState(next)
      graphRef.current = next.graph

      const edgeShape = edgeShapeOf(next.graph)
      if (edgeShape !== edgeShapeRef.current) {
        edgeShapeRef.current = edgeShape
        setRfEdges(
          next.graph.edges.map((e) => ({
            id: e.id,
            source: e.from,
            target: e.to,
            data: { role: e.role },
            className: e.role === 'reference' ? 'edge--reference' : 'edge--generation',
          })),
        )
      }

      const nodeShape = nodeShapeOf(next.graph)
      if (nodeShape !== nodeShapeRef.current) {
        nodeShapeRef.current = nodeShape
        setRfNodes(
          next.graph.nodes.map((node, index) => ({
            id: node.id,
            type: 'card',
            position: node.position ?? slotFor(index),
            data: { node, state: next.nodes[node.id] ?? BLANK },
          })),
        )
        return
      }

      // Same nodes: refresh only what each card displays, and only when it
      // actually changed, so React Flow's handle registrations survive.
      setRfNodes((current) =>
        current.map((rf) => {
          const node = next.graph.nodes.find((n) => n.id === rf.id)
          if (!node) return rf
          const nodeState = next.nodes[rf.id] ?? BLANK
          const previous = rf.data as { node: FlowNode; state: NodeState }
          if (
            JSON.stringify(previous.node) === JSON.stringify(node) &&
            JSON.stringify(previous.state) === JSON.stringify(nodeState)
          ) {
            return rf
          }
          return { ...rf, data: { node, state: nodeState } }
        }),
      )
    },
    [setRfEdges, setRfNodes],
  )

  useEffect(() => {
    let alive = true
    const pull = async () => {
      if (interactingRef.current) return
      try {
        const next = await fetchFlow(role)
        if (alive) absorb(next)
      } catch (error) {
        if (alive) setNotice(error instanceof Error ? error.message : 'Could not load the flow')
      }
    }
    void pull()
    const id = setInterval(pull, 1200)
    return () => {
      alive = false
      clearInterval(id)
    }
  }, [role, absorb])

  const load = useCallback(async () => {
    try {
      absorb(await fetchFlow(role))
    } catch (error) {
      setNotice(error instanceof Error ? error.message : 'Could not load the flow')
    }
  }, [role, absorb])

  const commit = useCallback(
    (update: (current: Flow) => Flow) => {
      queueRef.current = queueRef.current
        .then(async () => {
          let next: Flow
          try {
            next = update(graphRef.current)
          } catch (error) {
            setNotice(
              error instanceof WiringError || error instanceof UnsupportedCapabilityError
                ? error.message
                : `Could not apply that change: ${error instanceof Error ? error.message : String(error)}`,
            )
            return
          }

          graphRef.current = next
          try {
            await saveGraph(next)
          } catch (error) {
            setNotice(error instanceof Error ? error.message : 'Could not save')
          }
          await load()
        })
        .catch(() => undefined)
      return queueRef.current
    },
    [load],
  )

  const nodeCount = state?.graph.nodes.length ?? 0
  useEffect(() => {
    if (nodeCount === 0) return
    const id = setTimeout(() => void fitViewRef.current({ padding: 0.15, duration: 0 }), 80)
    return () => clearTimeout(id)
  }, [nodeCount])

  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (event.key === 'Escape') setSelectedId(null)
      // ⌥R. The generation graph — shots and clips — is what you review; the
      // references are what make it correct, and they need not always be on
      // screen to be true.
      if (event.altKey && event.code === 'KeyR') {
        event.preventDefault()
        setShowRefs((on) => !on)
      }
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [])

  const graph = state?.graph
  const selected = graph?.nodes.find((n) => n.id === selectedId) ?? null
  const sourcesById = useMemo(() => new Map((state?.sources ?? []).map((s) => [s.id, s])), [state])

  /** Everything the hovered asset feeds — "what does this product touch", in one gesture. */
  const litUp = useMemo(() => {
    if (!hovered || !graph) return new Set<NodeId>()
    const lit = new Set<NodeId>()
    const walk = (id: NodeId) => {
      for (const edge of graph.edges) {
        if (edge.from === id && !lit.has(edge.to)) {
          lit.add(edge.to)
          walk(edge.to)
        }
      }
    }
    walk(hovered)
    return lit
  }, [hovered, graph])

  const onPrompt = useCallback(
    (nodeId: string, prompt: string) => {
      void commit((current) => ({
        ...current,
        nodes: current.nodes.map((n) => (n.id === nodeId ? ({ ...n, prompt } as FlowNode) : n)),
      }))
    },
    [commit],
  )

  const onReplace = useCallback(async (sourceId: string) => {
    setReplacing({ id: sourceId, radius: await previewReplace(sourceId) })
  }, [])

  /**
   * One Run, two scopes. Without `nodeId` it is the toolbar's whole-flow run;
   * with one it is a single card's, and the executor pulls in whatever upstream
   * that card still needs rather than dispatching it unanchored.
   */
  const run = useCallback(
    async (options: { nodeId?: NodeId; confirmOverspend?: boolean } = {}) => {
      const outcome = await startRun(role, options.confirmOverspend === true, options.nodeId)
      if (outcome.kind === 'needs-confirmation') {
        setConfirming({ message: outcome.message, nodeId: options.nodeId })
        return
      }
      setConfirming(null)
      setNotice(
        outcome.kind === 'refused'
          ? outcome.message
          : // Nothing enqueued reads as a dead button. It means the hash is
            // already satisfied — say so, and name the way to render it again.
            outcome.enqueued === 0
            ? 'Already rendered at these settings. Re-roll the seed to render it again.'
            : null,
      )
      await load()
    },
    [role, load],
  )

  const onRun = useCallback((nodeId: NodeId) => void run({ nodeId }), [run])

  const decorated = useMemo(
    () =>
      rfNodes.map((n) => {
        const node = (n.data as { node: FlowNode }).node
        return {
          ...n,
          className: hovered && litUp.has(n.id) ? 'lit' : undefined,
          data: {
            ...n.data,
            selected: n.id === selectedId,
            source: node.type === 'source' ? sourcesById.get(node.sourceId) : undefined,
            onPrompt,
            onReplace,
            onRun,
          },
        }
      }),
    [rfNodes, selectedId, sourcesById, hovered, litUp, onPrompt, onReplace, onRun],
  )

  const visibleEdges = useMemo(
    () => (showRefs ? rfEdges : rfEdges.filter((e) => e.data?.role !== 'reference')),
    [rfEdges, showRefs],
  )
  const hiddenRefs = rfEdges.length - visibleEdges.length

  function addNode(type: 'image' | 'video' | 'export') {
    const id = newId(type)
    const position = slotFor(graphRef.current.nodes.length)
    const node =
      type === 'image'
        ? { id, type, position, prompt: '', modelRole: 'draft' as const, seed: 1 }
        : type === 'video'
          ? { id, type, position, prompt: '', durationSec: 5, audio: false, modelRole: 'draft' as const, seed: 1 }
          : { id, type, position, formats: [] }

    void commit((current) => ({ ...current, nodes: [...current.nodes, node as FlowNode] }))
    setSelectedId(id)
  }

  /**
   * One gesture, another clip off the same frame — the shape of the work is
   * three shots and nine clips, and building the ninth by hand is where a
   * canvas starts to feel like a chore.
   *
   * The new clip inherits the previous sibling's prompt because that is what
   * you are almost always doing: the same direction with one word changed.
   * A fresh seed, though — an identical sibling is a re-roll, not a fan-out.
   *
   * ponytail: alt-click rather than the alt-drag the plan named. Same gesture
   * count, and a synthetic alt-drag from a node body is indistinguishable from
   * a pan, so the drag version could not be tested honestly.
   */
  function fanOut(fromId: NodeId) {
    const current = graphRef.current
    const from = current.nodes.find((n) => n.id === fromId)
    if (from?.type !== 'image') return

    const siblings = current.edges.filter((e) => e.from === fromId && e.role === 'start_frame')
    const previous = current.nodes.find((n) => n.id === siblings.at(-1)?.to)
    const anchor = from.position ?? slotFor(current.nodes.indexOf(from))

    const id = newId('video')
    const node: FlowNode = {
      id,
      type: 'video',
      position: { x: anchor.x + COLUMN, y: anchor.y + siblings.length * ROW },
      prompt: previous && 'prompt' in previous ? previous.prompt : '',
      durationSec: 5,
      audio: false,
      modelRole: 'draft',
      seed: Math.floor(Math.random() * 1_000_000),
    }

    void commit((graph) => applyWire({ ...graph, nodes: [...graph.nodes, node] }, fromId, id, { role }))
    setSelectedId(id)
  }

  /** Adds a source node for an already-uploaded asset, optionally wiring it in. */
  function addSourceNode(sourceId: string, position: { x: number; y: number }, wireTo?: string) {
    const id = newId('asset')
    void commit((current) => {
      const withNode: Flow = {
        ...current,
        nodes: [...current.nodes, { id, type: 'source', sourceId, position }],
      }
      return wireTo ? applyWire(withNode, id, wireTo, { role }) : withNode
    })
  }

  async function handleDrop(event: React.DragEvent) {
    event.preventDefault()
    setDropping(false)

    const point = screenToFlowPosition({ x: event.clientX, y: event.clientY })
    // Dropping onto a shot uploads *and* wires it in — the shortest path from a
    // file on your desktop to a reference the model will honour.
    const onNode = (event.target as HTMLElement).closest('[data-testid^="node-"]')
    const wireTo = onNode?.getAttribute('data-testid')?.replace('node-', '')

    const text = event.dataTransfer.getData('text/plain')
    const files = Array.from(event.dataTransfer.files)

    try {
      for (const file of files) {
        const { id } = await uploadFile(file)
        addSourceNode(id, point, wireTo)
      }
      if (files.length === 0 && text.trim()) {
        const { id } = await createTextSource(text)
        addSourceNode(id, point, wireTo)
      }
    } catch (error) {
      setNotice(error instanceof Error ? error.message : 'Upload failed')
    }
  }

  function onConnect(connection: Connection) {
    const { source, target } = connection
    if (!source || !target) return
    setNotice(null)
    // Deferred out of the handler: committing synchronously re-renders React
    // Flow while it is still finishing the gesture, which fires onConnect twice
    // for one drag.
    setTimeout(() => {
      void commit((current) => applyWire(current, source, target, { role }))
    }, 0)
  }

  async function exportAll() {
    setNotice(null)
    try {
      const outcome = await startExport()
      setExported({
        written: outcome.written.length,
        // Every refusal, named. A count alone tells you something was refused
        // and nothing about what to drag two pixels to fix.
        refusals: outcome.rejected.flatMap((r) => r.reasons),
      })
    } catch (error) {
      setNotice(error instanceof Error ? error.message : 'Export failed')
    }
  }

  async function openBrief() {
    setNotice(null)
    const { brandProfile } = await fetchBrief()
    setBrief({ text: '', profile: brandProfile })
  }

  async function runBrief() {
    if (!brief) return
    setBriefing(true)
    try {
      // The profile is saved first and separately: it is a thing a person
      // confirmed about their brand, and it should survive a brief that fails.
      await saveBrandProfile(brief.profile)
      await submitBrief(brief.text)
      setBrief(null)
      await load()
    } catch (error) {
      setNotice(error instanceof Error ? error.message : 'Brief failed')
    } finally {
      setBriefing(false)
    }
  }

  const totals = state?.totals

  return (
    <div
      className="shell"
      data-inspector={selected ? 'open' : 'closed'}
      onDragOver={(e) => {
        e.preventDefault()
        setDropping(true)
      }}
      onDragLeave={(e) => {
        if (e.currentTarget === e.target) setDropping(false)
      }}
      onDrop={handleDrop}
    >
      <header className="topbar">
        <h1 className="topbar__title">OpenFlow</h1>

        <div className="toggle" role="group" aria-label="Render quality">
          {(['draft', 'hero'] as const).map((option) => (
            <button
              key={option}
              aria-pressed={role === option}
              onClick={() => setRole(option)}
              data-testid={`role-${option}`}
            >
              {option}
            </button>
          ))}
        </div>

        {(['image', 'video', 'export'] as const).map((type) => (
          <button key={type} className="chip" onClick={() => addNode(type)} data-testid={`add-${type}`}>
            + {type}
          </button>
        ))}

        <button
          className="chip"
          aria-pressed={!showRefs}
          onClick={() => setShowRefs((on) => !on)}
          data-testid="toggle-refs"
          title="⌥R"
        >
          {hiddenRefs > 0 ? `${hiddenRefs} refs hidden` : 'refs'}
        </button>

        <span className="topbar__spacer" />

        {totals && (
          <span
            className={
              totals.staleCount > 0 || totals.runningCount > 0
                ? 'ledger ledger--due'
                : 'ledger ledger--clear'
            }
            data-testid="ledger"
          >
            {totals.staleCount > 0
              ? `${totals.staleCount} stale · ${money(totals.estimatedCents)} to render`
              : totals.runningCount > 0
                ? `rendering ${totals.runningCount}…`
                : `all rendered · ${money(totals.spentCents)} spent`}
          </span>
        )}

        <button className="chip" onClick={() => void openBrief()} data-testid="brief">
          Brief
        </button>

        <button className="chip" onClick={() => void exportAll()} data-testid="export">
          Export
        </button>

        <button className="run" onClick={() => void run()} data-testid="run">
          Run all
        </button>
      </header>

      <main className="canvas" data-dropping={dropping}>
        <ReactFlow
          nodes={decorated}
          edges={visibleEdges}
          nodeTypes={nodeTypes}
          onNodesChange={(changes) => {
            onNodesChange(changes)

            if (changes.some((c) => c.type === 'position' && c.dragging === true)) {
              interactingRef.current = true
              draggingRef.current = true
            }

            const ended = changes.flatMap((c) =>
              c.type === 'position' && c.dragging === false && c.position
                ? [{ id: c.id, position: c.position }]
                : [],
            )
            // Only a drag the user actually started may be persisted: React Flow
            // emits the same change shape when nodes are re-seeded.
            if (ended.length === 0 || !draggingRef.current) return
            draggingRef.current = false
            interactingRef.current = false

            const moved = new Map(ended.map((c) => [c.id, c.position]))
            void commit((current) => ({
              ...current,
              nodes: current.nodes.map((node) =>
                moved.has(node.id) ? { ...node, position: moved.get(node.id)! } : node,
              ),
            }))
          }}
          onEdgesChange={onEdgesChange}
          onConnect={onConnect}
          onConnectStart={() => {
            interactingRef.current = true
          }}
          onConnectEnd={() => {
            interactingRef.current = false
          }}
          onNodeClick={(event, node) => (event.altKey ? fanOut(node.id) : setSelectedId(node.id))}
          onNodeMouseEnter={(_, node) => setHovered(node.id)}
          onNodeMouseLeave={() => setHovered(null)}
          onPaneClick={() => setSelectedId(null)}
          proOptions={{ hideAttribution: true }}
          minZoom={0.2}
        >
          <Background color="#232833" gap={22} />
          <Controls showInteractive={false} />
        </ReactFlow>

        {nodeCount === 0 && (
          <div className="empty-canvas">
            <span className="slate">Empty call sheet</span>
            <p className="hint">
              Drop a product photo, a clip or a note anywhere here. Add a shot, wire the asset in, and
              it stays identical across every frame.
            </p>
          </div>
        )}

        {dropping && <div className="drop-veil">Drop to add an asset</div>}

        {notice && (
          <div className="floating">
            <p className="banner" role="status" data-testid="notice">
              {notice}
            </p>
          </div>
        )}

        {brief && (
          <div className="floating">
            <div className="banner" role="dialog" aria-label="Brief">
              <label className="field">
                <span className="slate">Brand profile</span>
                <textarea
                  rows={3}
                  value={brief.profile}
                  placeholder="Warm, editorial, never clinical. Product always in frame."
                  data-testid="brand-profile"
                  onChange={(e) => setBrief({ ...brief, profile: e.target.value })}
                />
              </label>
              <label className="field">
                <span className="slate">Brief</span>
                <textarea
                  rows={3}
                  value={brief.text}
                  placeholder="Launch the serum. Three scenes for a feed test."
                  data-testid="brief-text"
                  onChange={(e) => setBrief({ ...brief, text: e.target.value })}
                />
              </label>
              {/* It writes a graph and stops. Nothing is dispatched — what comes
                  back is a starting point, and Run stays a deliberate act. */}
              <span className="hint">Fills a template. Nothing renders until you press Run.</span>
              <div className="banner__actions">
                <button
                  className="chip"
                  disabled={briefing || !brief.text.trim()}
                  onClick={() => void runBrief()}
                  data-testid="brief-submit"
                >
                  {briefing ? 'Writing…' : 'Build the graph'}
                </button>
                <button className="chip" onClick={() => setBrief(null)}>
                  Cancel
                </button>
              </div>
            </div>
          </div>
        )}

        {exported && (
          <div className="floating">
            <div className="banner" role="status" aria-label="Export result">
              <p data-testid="export-result">
                {exported.written} {exported.written === 1 ? 'file' : 'files'} written to ./exports
                {exported.refusals.length > 0
                  ? ` · ${exported.refusals.length} refused`
                  : ''}
              </p>
              {exported.refusals.map((reason) => (
                <p key={reason} className="hint" data-testid="export-refusal">
                  {reason}
                </p>
              ))}
              <div className="banner__actions">
                <button className="chip" onClick={() => setExported(null)}>
                  Dismiss
                </button>
              </div>
            </div>
          </div>
        )}

        {confirming && (
          <div className="floating">
            <div className="banner" role="alertdialog" aria-label="Confirm spend">
              <p data-testid="spend-warning">{confirming.message}</p>
              <div className="banner__actions">
                <button
                  className="chip"
                  onClick={() => void run({ nodeId: confirming.nodeId, confirmOverspend: true })}
                  data-testid="confirm-spend"
                >
                  Render anyway
                </button>
                <button className="chip" onClick={() => setConfirming(null)}>
                  Cancel
                </button>
              </div>
            </div>
          </div>
        )}

        {replacing && (
          <div className="floating">
            <div className="banner" role="alertdialog" aria-label="Confirm replacement">
              {/* Never silently re-run. One replacement can invalidate two campaigns. */}
              <p data-testid="replace-warning">
                {replacing.radius.nodeCount} {replacing.radius.nodeCount === 1 ? 'shot' : 'shots'} across{' '}
                {replacing.radius.flowCount} {replacing.radius.flowCount === 1 ? 'flow' : 'flows'} go stale ·{' '}
                {money(replacing.radius.estimatedCents)} to refresh.
              </p>
              <div className="banner__actions">
                <button
                  className="chip"
                  onClick={() => replaceInputRef.current?.click()}
                  data-testid="confirm-replace"
                >
                  Choose a file
                </button>
                <button className="chip" onClick={() => setReplacing(null)}>
                  Cancel
                </button>
              </div>
              <input
                ref={replaceInputRef}
                type="file"
                hidden
                data-testid="replace-input"
                onChange={async (e) => {
                  const file = e.target.files?.[0]
                  if (!file || !replacing) return
                  try {
                    await replaceSource(replacing.id, file)
                  } catch (error) {
                    setNotice(error instanceof Error ? error.message : 'Could not replace')
                  }
                  setReplacing(null)
                  await load()
                }}
              />
            </div>
          </div>
        )}
      </main>

      {selected && (
        <Inspector
          node={selected}
          state={state?.nodes[selected.id]}
          onChange={(next) =>
            void commit((current) => ({
              ...current,
              nodes: current.nodes.map((n) => (n.id === next.id ? next : n)),
            }))
          }
          onDelete={() => {
            void commit((current) => removeNode(current, selected.id))
            setSelectedId(null)
          }}
          onReroll={() =>
            void commit((current) => ({
              ...current,
              nodes: current.nodes.map((n) =>
                n.id === selected.id
                  ? ({ ...n, seed: Math.floor(Math.random() * 1_000_000) } as FlowNode)
                  : n,
              ),
            }))
          }
        />
      )}
    </div>
  )
}
