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
import { applyWire, assertModelFits, removeNode, WiringError } from '@/core/wiring'
import { newNode } from '@/core/node-defaults'
import { UnsupportedCapabilityError } from '@/models/registry'
import type { Flow, FlowNode, NodeId } from '@/core/types'
import { NodeCard } from './node-card'
import { Inspector } from './inspector'
import { CARD_SOURCE, COLUMN, MIN_CARD, ROW, freeSlot, sizeOf, slotFor } from './slots'
import { Lightbox, type Preview } from './lightbox'
import { AssetMenu } from './asset-menu'
import { ChatPanel } from './chat-panel'
import {
  fetchFlow,
  saveGraph,
  StaleGraphError,
  startRun,
  startExport,
  fetchBrief,
  saveBrandProfile,
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
  const { fitView, screenToFlowPosition, setCenter, getZoom, getNode } = useReactFlow()

  const [state, setState] = useState<FlowState | null>(null)
  const [selectedId, setSelectedId] = useState<NodeId | null>(null)
  // Open on load — chat is the primary way in, not a drawer someone has to
  // find first. Closing it reclaims the canvas the panel overlays.
  const [chatOpen, setChatOpen] = useState(true)
  const [notice, setNotice] = useState<string | null>(null)
  // Carries the node so "Render anyway" repeats the click that was refused,
  // rather than silently widening one shot into the whole flow.
  const [confirming, setConfirming] = useState<{ message: string; nodeId?: NodeId } | null>(null)
  const [showRefs, setShowRefs] = useState(true)
  const [hovered, setHovered] = useState<NodeId | null>(null)
  // `text` set means the replacement is already in hand — a rewritten note —
  // and the panel confirms it rather than asking for a file.
  const [replacing, setReplacing] = useState<{
    id: string
    radius: BlastRadius
    text?: string
  } | null>(null)
  const [dropping, setDropping] = useState(false)
  const [exported, setExported] = useState<{ written: number; refusals: string[] } | null>(null)
  const [brief, setBrief] = useState<{ profile: string } | null>(null)
  const [preview, setPreview] = useState<Preview | null>(null)

  const [rfNodes, setRfNodes, onNodesChange] = useNodesState<RfNode>([])
  const [rfEdges, setRfEdges, onEdgesChange] = useEdgesState<RfEdge>([])

  const graphRef = useRef<Flow>({ nodes: [], edges: [] })
  const stampRef = useRef<string>('')
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
      stampRef.current = next.updatedAt

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
          next.graph.nodes.map((node, index) => {
            const size = sizeOf(node)
            return {
              id: node.id,
              type: 'card',
              position: node.position ?? slotFor(index),
              // Width and height, not `style`: React Flow reads these when it
              // measures, so the resizer drags from the size actually stored
              // rather than from whatever the first paint happened to be.
              width: size.w,
              height: size.h,
              data: { node, state: next.nodes[node.id] ?? BLANK },
            }
          }),
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

  /**
   * Reads the flow, and applies it only if it is still the newest read issued.
   *
   * The poll and every mutation fetch the whole state, so the last request wins
   * — but only by request order, never by arrival order. A poll fired just before
   * a delete resolves just after it, and without this it replays the pre-delete
   * graph into `graphRef`. The card comes back on screen, and the next edit is
   * built on that stale graph and *saves* the node you deleted. "It keeps coming
   * back" is one HTTP response arriving out of order.
   *
   * `interactingRef` is re-checked here, not only before issuing: a drag that
   * starts mid-flight would otherwise be overwritten by the response.
   */
  const readRef = useRef(0)
  const load = useCallback(async () => {
    const read = ++readRef.current
    try {
      const next = await fetchFlow()
      if (read !== readRef.current || interactingRef.current) return
      absorb(next)
    } catch (error) {
      if (read === readRef.current) {
        setNotice(error instanceof Error ? error.message : 'Could not load the flow')
      }
    }
  }, [absorb])

  useEffect(() => {
    let alive = true
    const pull = () => {
      if (interactingRef.current || !alive) return
      void load()
    }
    pull()
    const id = setInterval(pull, 1200)
    return () => {
      alive = false
      clearInterval(id)
    }
  }, [load])

  const commit = useCallback(
    (update: (current: Flow) => Flow) => {
      queueRef.current = queueRef.current
        .then(async () => {
          const apply = () => {
            const next = update(graphRef.current)
            graphRef.current = next
            return next
          }

          let next: Flow
          try {
            next = apply()
          } catch (error) {
            setNotice(
              error instanceof WiringError || error instanceof UnsupportedCapabilityError
                ? error.message
                : `Could not apply that change: ${error instanceof Error ? error.message : String(error)}`,
            )
            return
          }

          try {
            await saveGraph(next, stampRef.current)
          } catch (error) {
            // Someone else — the agent — wrote while this edit was in hand. Take
            // their graph and re-apply this one change on top of it, once. A
            // second failure is a real problem, not a race.
            if (error instanceof StaleGraphError) {
              await load()
              try {
                await saveGraph(apply(), stampRef.current)
              } catch (retry) {
                setNotice(retry instanceof Error ? retry.message : 'Could not save')
              }
            } else {
              setNotice(error instanceof Error ? error.message : 'Could not save')
            }
          }
          await load()
        })
        .catch(() => undefined)
      return queueRef.current
    },
    [load],
  )

  /**
   * Framed once, when the flow first arrives.
   *
   * This used to run on every change to the node count, which meant adding a
   * card teleported the whole canvas: you pressed "+ image" and everything you
   * had arranged jumped to a new zoom and offset. Deleting one did it too. The
   * view is yours once you have touched it — a new card comes to you instead,
   * via `reveal` below.
   */
  const nodeCount = state?.graph.nodes.length ?? 0
  const framedRef = useRef(false)
  useEffect(() => {
    if (nodeCount === 0 || framedRef.current) return
    framedRef.current = true
    const id = setTimeout(() => void fitViewRef.current({ padding: 0.15, duration: 0 }), 80)
    return () => clearTimeout(id)
  }, [nodeCount])

  /**
   * Brings a just-created card into view without moving anything else.
   *
   * `freeSlot` counts from the top-left of the graph, so on a canvas you have
   * panned away from, a new node lands off screen and the button reads as dead.
   * Panned to, not fitted: the zoom you chose survives.
   */
  const reveal = useCallback(
    (position: { x: number; y: number }, size: { w: number; h: number }) => {
      setTimeout(() => {
        void setCenter(position.x + size.w / 2, position.y + size.h / 2, {
          zoom: getZoom(),
          duration: 220,
        })
      }, 60)
    },
    [setCenter, getZoom],
  )

  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      // Never while someone is typing. Escape used to close the inspector out
      // from under a half-written name, and ⌥R fired inside a prompt.
      const target = event.target as HTMLElement | null
      if (target?.closest('input, textarea, [contenteditable="true"]')) return
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
   * Rewrites a text asset in place.
   *
   * Brand voice is the one asset you rewrite rather than re-upload, and it
   * composes ahead of every prompt it feeds — so a rewrite is a replacement, and
   * goes through the same gate: `bumpSource` versions it and every shot
   * downstream goes stale. §5.3 says never silently re-run, and one note can
   * invalidate two campaigns.
   *
   * Priced first, and confirmed only when there is something to price. A note
   * feeding nothing stales nothing and costs nothing, and a dialog saying so is
   * a dialog in the way of editing a sentence.
   */
  const onEditText = useCallback(
    async (sourceId: string, text: string) => {
      try {
        const radius = await previewReplace(sourceId)
        if (radius.nodeCount > 0) {
          setReplacing({ id: sourceId, radius, text })
          return
        }
        await replaceSource(sourceId, text)
        await load()
      } catch (error) {
        setNotice(error instanceof Error ? error.message : 'Could not save that note')
      }
    },
    [load],
  )

  /**
   * One Run, two scopes. Without `nodeId` it is the toolbar's whole-flow run;
   * with one it is a single card's, and the executor pulls in whatever upstream
   * that card still needs rather than dispatching it unanchored.
   */
  const run = useCallback(
    async (options: { nodeId?: NodeId; confirmOverspend?: boolean } = {}) => {
      const outcome = await startRun(options.confirmOverspend === true, options.nodeId)
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
    [load],
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
            onPreview: setPreview,
            onEditText,
          },
        }
      }),
    [rfNodes, selectedId, sourcesById, hovered, litUp, onPrompt, onReplace, onRun, onEditText],
  )

  const visibleEdges = useMemo(
    () => (showRefs ? rfEdges : rfEdges.filter((e) => e.data?.role !== 'reference')),
    [rfEdges, showRefs],
  )
  const hiddenRefs = rfEdges.length - visibleEdges.length

  /**
   * The catalog's default for that format, from the rows the flow route sent.
   * Nothing here hardcodes a model id — adding a row to models.json and marking
   * it default has to be enough to change what a fresh node gets.
   */
  /**
   * The capability gate runs here as well as on the server, so a refused wire
   * is refused under the cursor rather than after a round trip. It reads the
   * same rows the picker does — the catalog is the server's, always.
   */
  function resolveModel(id: string) {
    const row = (state?.models ?? []).find((m) => m.id === id)
    if (!row) throw new WiringError(`No model '${id}' in the catalog.`)
    return row
  }

  function defaultModelId(format: 'image' | 'video') {
    const rows = (state?.models ?? []).filter((m) => m.format === format)
    return (rows.find((m) => m.default) ?? rows[0])?.id
  }

  function addNode(type: 'image' | 'video' | 'export') {
    const id = newId(type)
    const position = freeSlot(graphRef.current.nodes)
    const node = newNode(type, {
      id,
      position,
      ...(type === 'export' ? {} : { modelId: defaultModelId(type) }),
    })

    void commit((current) => ({ ...current, nodes: [...current.nodes, node] }))
    setSelectedId(id)
    reveal(position, sizeOf(node))
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
    const node = newNode('video', {
      id,
      modelId: defaultModelId('video'),
      position: { x: anchor.x + COLUMN, y: anchor.y + siblings.length * ROW },
      prompt: previous && 'prompt' in previous ? previous.prompt : '',
      // A fresh seed, not the default: an identical sibling would be a re-roll,
      // not a fan-out.
      seed: Math.floor(Math.random() * 1_000_000),
    })

    void commit((graph) => applyWire({ ...graph, nodes: [...graph.nodes, node] }, fromId, id, { resolve: resolveModel }))
    setSelectedId(id)
    reveal(node.position!, sizeOf(node))
  }

  /**
   * Adds a source node for an already-uploaded asset, optionally wiring it in.
   *
   * Does not `reveal`. A dropped file lands where the pointer let go, which is
   * on screen by definition, and panning to it would move every other card for
   * no reason — the same thing the fitView on every add used to do. Only the
   * callers that place a card at a `freeSlot` it cannot see need that.
   */
  function addSourceNode(sourceId: string, position: { x: number; y: number }, wireTo?: string) {
    const id = newId('asset')
    void commit((current) => {
      const withNode: Flow = {
        ...current,
        nodes: [...current.nodes, { id, type: 'source', sourceId, position }],
      }
      return wireTo ? applyWire(withNode, id, wireTo, { resolve: resolveModel }) : withNode
    })
  }

  /**
   * The toolbar's way in, for everyone who does not think to drag a file onto a
   * canvas — and the only way at all to write a note, which until now meant
   * dragging selected text out of another application.
   *
   * `freeSlot` rather than a drop point, and each upload placed against the
   * graph as it stands: two files chosen at once must not land on each other.
   */
  async function addAssets(files: File[]) {
    try {
      for (const file of files) {
        const { id } = await uploadFile(file)
        const slot = freeSlot(graphRef.current.nodes, CARD_SOURCE)
        addSourceNode(id, slot)
        reveal(slot, CARD_SOURCE)
        // `commit` is queued, so the next slot is only free once this one has
        // actually landed in the graph.
        await queueRef.current
      }
    } catch (error) {
      setNotice(error instanceof Error ? error.message : 'Upload failed')
    }
  }

  async function addNote(text: string) {
    try {
      const { id } = await createTextSource(text)
      const slot = freeSlot(graphRef.current.nodes, CARD_SOURCE)
      addSourceNode(id, slot)
      reveal(slot, CARD_SOURCE)
    } catch (error) {
      setNotice(error instanceof Error ? error.message : 'Could not save that note')
    }
  }

  /**
   * Places an asset that already exists. No upload, no new row, no version bump.
   *
   * A second node for a source already on the canvas is allowed: hashing is
   * keyed on sourceId and version, so both are references to the same bytes and
   * go stale together. A product feeding shots in two far corners of a large
   * graph should not force a wire across the whole thing.
   */
  function addExistingSource(sourceId: string) {
    const slot = freeSlot(graphRef.current.nodes, CARD_SOURCE)
    addSourceNode(sourceId, slot)
    reveal(slot, CARD_SOURCE)
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
      void commit((current) => applyWire(current, source, target, { resolve: resolveModel }))
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

  async function openBrand() {
    const { brandProfile } = await fetchBrief()
    setBrief({ profile: brandProfile })
  }

  async function saveBrand() {
    if (!brief) return
    try {
      await saveBrandProfile(brief.profile)
      setBrief(null)
    } catch (error) {
      setNotice(error instanceof Error ? error.message : 'Could not save the brand profile')
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

        {(['image', 'video', 'export'] as const).map((type) => (
          <button key={type} className="chip" onClick={() => addNode(type)} data-testid={`add-${type}`}>
            + {type}
          </button>
        ))}

        <AssetMenu
          sources={state?.sources ?? []}
          onUpload={(files) => void addAssets(files)}
          onNote={(text) => void addNote(text)}
          onPick={addExistingSource}
        />

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

        <button className="chip" onClick={() => void openBrand()} data-testid="brand">
          Brand
        </button>

        <button className="chip" onClick={() => void exportAll()} data-testid="export">
          Export
        </button>

        <button
          className="chip"
          aria-pressed={chatOpen}
          onClick={() => setChatOpen((open) => !open)}
          data-testid="chat-toggle"
        >
          Chat
        </button>

        <button className="run" onClick={() => void run()} data-testid="run">
          Run all
        </button>
      </header>

      <div className="canvas-row">
      <main className="canvas" data-dropping={dropping}>
        <ReactFlow
          nodes={decorated}
          edges={visibleEdges}
          nodeTypes={nodeTypes}
          onNodesChange={(changes) => {
            onNodesChange(changes)

            if (
              changes.some(
                (c) =>
                  (c.type === 'position' && c.dragging === true) ||
                  (c.type === 'dimensions' && c.resizing === true),
              )
            ) {
              interactingRef.current = true
              draggingRef.current = true
            }

            // A resize can move the node too — the top and left handles grow the
            // card backwards — so both are read off the node React Flow has
            // already updated rather than reassembled from the change list.
            const ended = changes.flatMap((c) =>
              (c.type === 'position' && c.dragging === false && c.position) ||
              (c.type === 'dimensions' && c.resizing === false)
                ? [c.id]
                : [],
            )
            // Only a gesture the user actually started may be persisted: React
            // Flow emits the same change shape when nodes are re-seeded.
            if (ended.length === 0 || !draggingRef.current) return
            draggingRef.current = false
            interactingRef.current = false

            const laid = new Map(
              ended.flatMap((id) => {
                const rf = getNode(id)
                if (!rf) return []
                const measured = rf.measured
                return [
                  [
                    id,
                    {
                      position: rf.position,
                      size: {
                        w: Math.round(rf.width ?? measured?.width ?? MIN_CARD.w),
                        h: Math.round(rf.height ?? measured?.height ?? MIN_CARD.h),
                      },
                    },
                  ] as const,
                ]
              }),
            )
            if (laid.size === 0) return

            void commit((current) => ({
              ...current,
              nodes: current.nodes.map((node) =>
                laid.has(node.id) ? { ...node, ...laid.get(node.id)! } : node,
              ),
            }))
          }}
          /**
           * A node deleted with the keyboard has to leave the graph, not just the
           * screen. React Flow's Backspace handler only removes it from its own
           * store, so the card vanished while the node stayed in `graph_json` —
           * it came back on the next reload, and in the meantime Run still
           * dispatched and billed a shot nobody could see.
           */
          deleteKeyCode={['Backspace', 'Delete']}
          onNodesDelete={(deleted) => {
            setSelectedId(null)
            void commit((current) =>
              deleted.reduce((graph, node) => removeNode(graph, node.id), current),
            )
          }}
          /**
           * Double-click belongs to the text on a card. It is how you edit a shot's
           * direction and how you rewrite a note, and d3's dblclick zoom sits on
           * the pane underneath every node — so every edit began by zooming the
           * canvas in on itself. The Controls and the scroll wheel still zoom.
           */
          zoomOnDoubleClick={false}
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
            <div className="banner" role="dialog" aria-label="Brand">
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
              <div className="banner__actions">
                <button className="run" onClick={() => void saveBrand()} data-testid="brand-save">
                  Save
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
                  data-testid="confirm-replace"
                  onClick={async () => {
                    if (replacing.text === undefined) return replaceInputRef.current?.click()
                    try {
                      await replaceSource(replacing.id, replacing.text)
                    } catch (error) {
                      setNotice(error instanceof Error ? error.message : 'Could not save that note')
                    }
                    setReplacing(null)
                    await load()
                  }}
                >
                  {replacing.text === undefined ? 'Choose a file' : 'Save the note'}
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

      {chatOpen && <ChatPanel />}
      </div>

      <Lightbox item={preview} onClose={() => setPreview(null)} />

      {selected && (
        <Inspector
          // Remounted per node, so a half-typed name never follows you to the
          // next card you select.
          key={selected.id}
          node={selected}
          state={state?.nodes[selected.id]}
          models={state?.models ?? []}
          onChange={(next) =>
            void commit((current) => {
              const graph = {
                ...current,
                nodes: current.nodes.map((n) => (n.id === next.id ? next : n)),
              }
              // Refused under the cursor rather than after a round trip. The
              // server refuses it too — this is the fast copy of that rule, not
              // the only one.
              if ('modelId' in next) assertModelFits(graph, next.id, resolveModel(next.modelId))
              return graph
            })
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
