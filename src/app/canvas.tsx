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
import { AnchorRail } from './anchor-rail'
import { fetchFlow, saveGraph, startRun, money, type FlowState, type NodeState } from './state'

const nodeTypes = { card: NodeCard }

/**
 * Grid placement, not a cascade. Offsetting each new node by a few pixels piles
 * twelve shots into a diagonal stack where every card covers the handles of the
 * one before it — you cannot wire what you cannot point at.
 */
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

/**
 * Nodes and edges are reseeded independently.
 *
 * Keying one "shape" on both meant that adding an edge rebuilt every node
 * object, React Flow re-registered every Handle, and no further connection
 * could be started for the rest of the session — wiring worked exactly once.
 */
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
  const { fitView } = useReactFlow()

  const [role, setRole] = useState<ModelRole>('draft')
  const [state, setState] = useState<FlowState | null>(null)
  const [selectedId, setSelectedId] = useState<NodeId | null>(null)
  const [notice, setNotice] = useState<string | null>(null)
  const [confirming, setConfirming] = useState<string | null>(null)

  /**
   * React Flow owns interaction state.
   *
   * Rebuilding its nodes from the server on every poll re-registered every
   * Handle, and any pointer gesture that started inside that window was
   * silently dropped — wiring worked once per session and then stopped. The
   * server owns *derived* state only: status, price, thumbnails.
   */
  const [rfNodes, setRfNodes, onNodesChange] = useNodesState<RfNode>([])
  const [rfEdges, setRfEdges, onEdgesChange] = useEdgesState<RfEdge>([])

  /** Authoritative graph for edits, so a quick second edit never reads a stale render. */
  const graphRef = useRef<Flow>({ nodes: [], edges: [] })
  const nodeShapeRef = useRef<string>('')
  const edgeShapeRef = useRef<string>('')
  const queueRef = useRef<Promise<void>>(Promise.resolve())
  const interactingRef = useRef(false)
  /**
   * True only between a real pointer-down drag and its release.
   *
   * React Flow also emits `position` changes with `dragging: false` when nodes
   * are re-seeded, so treating every one of those as a drag-end made each
   * commit trigger another commit — a self-sustaining loop that re-rendered the
   * canvas continuously and swallowed every subsequent wiring gesture.
   */
  const draggingRef = useRef(false)
  const fitViewRef = useRef(fitView)

  useEffect(() => {
    fitViewRef.current = fitView
  }, [fitView])

  /** Applies a server snapshot: reseed structure only when it actually changed. */
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
            'data-role': e.role,
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
            data: { node, state: next.nodes[node.id] ?? BLANK, selected: false },
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
          return { ...rf, data: { node, state: nodeState, selected: false } }
        }),
      )
    },
    [setRfEdges, setRfNodes],
  )

  useEffect(() => {
    let alive = true
    const pull = async () => {
      // A poll landing mid-gesture would replace nodes under the pointer.
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

  /**
   * Takes an updater and runs commits one at a time. Passing a graph captured
   * from the current render meant wiring nine edges in quick succession sent
   * nine graphs that each held only their own edge, and eight were lost.
   */
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
        // A rejected link poisons a promise chain permanently, silencing every
        // later edit without a sound.
        .catch(() => undefined)
      return queueRef.current
    },
    [load],
  )

  const nodeCount = state?.graph.nodes.length ?? 0
  useEffect(() => {
    if (nodeCount === 0) return
    // Depends on the count alone: `fitView` is a new function every render, so
    // including it re-fitted continuously and shifted the canvas out from under
    // the pointer mid-gesture.
    const id = setTimeout(() => void fitViewRef.current({ padding: 0.15, duration: 0 }), 80)
    return () => clearTimeout(id)
  }, [nodeCount])

  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (event.key === 'Escape') setSelectedId(null)
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [])

  const graph = state?.graph
  const selected = graph?.nodes.find((n) => n.id === selectedId) ?? null

  const decorated = useMemo(
    () => rfNodes.map((n) => ({ ...n, data: { ...n.data, selected: n.id === selectedId } })),
    [rfNodes, selectedId],
  )

  function addNode(type: 'image' | 'video' | 'source' | 'export') {
    const id = newId(type)
    const position = slotFor(graphRef.current.nodes.length)
    const node =
      type === 'image'
        ? { id, type, position, prompt: '', anchors: [], modelRole: 'draft' as const, seed: 1 }
        : type === 'video'
          ? { id, type, position, prompt: '', anchors: [], durationSec: 5, audio: false, modelRole: 'draft' as const, seed: 1 }
          : type === 'source'
            ? { id, type, position, assets: [] }
            : { id, type, position, formats: [] }

    void commit((current) => ({ ...current, nodes: [...current.nodes, node as FlowNode] }))
    setSelectedId(id)
  }

  function onConnect(connection: Connection) {
    const { source, target } = connection
    if (!source || !target) return
    setNotice(null)

    // Deferred out of the handler on purpose. Committing synchronously
    // re-rendered React Flow while it was still finishing the gesture, which
    // fired onConnect a second time for the same drag and left its internal
    // connection state stuck — after which no further wire could be started.
    //
    // Refused at wiring time regardless: accepting a wire the model cannot
    // honour and dropping it at render time bills for a clip that ignored its
    // own first frame.
    setTimeout(() => {
      void commit((current) => applyWire(current, source, target, { role }))
    }, 0)
  }

  function updateNode(next: FlowNode) {
    void commit((current) => ({
      ...current,
      nodes: current.nodes.map((n) => (n.id === next.id ? next : n)),
    }))
  }

  function toggleAnchorOnSelected(anchorId: string) {
    if (!selected || !('anchors' in selected)) {
      setNotice('Select an image or video shot first.')
      return
    }
    updateNode({
      ...selected,
      anchors: selected.anchors.includes(anchorId)
        ? selected.anchors.filter((id) => id !== anchorId)
        : [...selected.anchors, anchorId],
    })
  }

  async function run(confirmOverspend = false) {
    const outcome = await startRun(role, confirmOverspend)
    if (outcome.kind === 'needs-confirmation') {
      setConfirming(outcome.message)
      return
    }
    setConfirming(null)
    setNotice(outcome.kind === 'refused' ? outcome.message : null)
    await load()
  }

  const totals = state?.totals
  const attached = selected && 'anchors' in selected ? selected.anchors : []

  return (
    <div className="shell" data-inspector={selected ? 'open' : 'closed'}>
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

        {(['image', 'video', 'source', 'export'] as const).map((type) => (
          <button key={type} className="chip" onClick={() => addNode(type)} data-testid={`add-${type}`}>
            + {type}
          </button>
        ))}

        <span className="topbar__spacer" />

        {totals && (
          <span
            className={totals.staleCount > 0 ? 'ledger ledger--due' : 'ledger ledger--clear'}
            data-testid="ledger"
          >
            {totals.staleCount > 0
              ? `${totals.staleCount} stale · ${money(totals.estimatedCents)} to render`
              : `all rendered · ${money(totals.spentCents)} spent`}
          </span>
        )}

        <button className="run" onClick={() => void run()} data-testid="run">
          Run
        </button>
      </header>

      <AnchorRail
        anchors={state?.anchors ?? []}
        attachedIds={attached}
        onToggle={toggleAnchorOnSelected}
        onRefresh={load}
      />

      <main className="canvas">
        <ReactFlow
          nodes={decorated}
          edges={rfEdges}
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
            // Only a drag the user actually started may be persisted.
            if (ended.length === 0 || !draggingRef.current) return
            draggingRef.current = false
            interactingRef.current = false

            // Position is not in the input hash, so persisting a drag costs
            // nothing and re-renders nothing. See core/hashable.ts.
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
          onNodeClick={(_, node) => setSelectedId(node.id)}
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
            <p className="hint">Add a shot to begin. Anchors keep the product identical across all of them.</p>
          </div>
        )}

        {notice && (
          <div style={{ position: 'absolute', left: 16, bottom: 16, maxWidth: 420 }}>
            <p className="banner" role="status" data-testid="notice">
              {notice}
            </p>
          </div>
        )}

        {confirming && (
          <div style={{ position: 'absolute', left: 16, bottom: 16, maxWidth: 420 }}>
            <div className="banner" role="alertdialog" aria-label="Confirm spend">
              <p data-testid="spend-warning">{confirming}</p>
              <div className="anchor__actions">
                <button className="chip" onClick={() => void run(true)} data-testid="confirm-spend">
                  Render anyway
                </button>
                <button className="chip" onClick={() => setConfirming(null)}>
                  Cancel
                </button>
              </div>
            </div>
          </div>
        )}
      </main>

      {selected && (
        <Inspector
          node={selected}
          state={state?.nodes[selected.id]}
          anchors={state?.anchors ?? []}
          onChange={updateNode}
          onDelete={() => {
            void commit((current) => removeNode(current, selected.id))
            setSelectedId(null)
          }}
          onReroll={() =>
            updateNode({ ...selected, seed: Math.floor(Math.random() * 1_000_000) } as FlowNode)
          }
        />
      )}
    </div>
  )
}
