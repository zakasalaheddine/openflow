'use client'

import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import {
  ReactFlow,
  ReactFlowProvider,
  Background,
  BackgroundVariant,
  Controls,
  MarkerType,
  MiniMap,
  useNodesState,
  useEdgesState,
  useReactFlow,
  useStore,
  type Connection,
  type Node as RfNode,
  type Edge as RfEdge,
} from '@xyflow/react'
import { toast } from 'sonner'
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from '@/ui/alert-dialog'
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/ui/dialog'
import { Hint } from '@/ui/hint'
import { Toaster } from '@/ui/sonner'
import { TooltipProvider } from '@/ui/tooltip'
import { applyWire, assertModelFits, removeNode, WiringError } from '@/core/wiring'
import { newNode } from '@/core/node-defaults'
import { UnsupportedCapabilityError } from '@/models/registry'
import type { Flow, FlowNode, NodeId } from '@/core/types'
import { NodeCard } from './node-card'
import { Inspector } from './inspector'
import { CARD_SOURCE, COLUMN, MIN_CARD, ROW, fitToFrame, freeSlot, sizeOf, slotFor } from './slots'
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

/** Dispatched, not yet answered — the states a spinner would be for. */
const RUNNING: ReadonlySet<NodeState['status']> = new Set([
  'queued',
  'claimed',
  'submitted',
  'polling',
])

/**
 * Two grids, and the fine one leaves at low zoom.
 *
 * A single 22px dot grid is a texture at 1.0 and a grey wash at 0.3 — zoomed out
 * to see a twelve-shot graph, the thing you came to look at sits on static. The
 * coarse lines survive because they are what tells you the canvas is still
 * moving under a pan.
 *
 * Its own component so the zoom subscription re-renders four SVG rects rather
 * than the whole canvas: `CanvasInner` holds every node's state, and
 * re-rendering it on every wheel tick is how a graph starts to feel heavy. The
 * selector returns a boolean, so it only fires when the threshold is crossed
 * rather than on every intermediate zoom value.
 */
function Grid() {
  const close = useStore((s) => s.transform[2] > 0.5)

  return (
    <>
      <Background
        id="coarse"
        variant={BackgroundVariant.Lines}
        gap={110}
        lineWidth={1}
        color="var(--grid-coarse)"
      />
      {close && (
        <Background
          id="fine"
          variant={BackgroundVariant.Dots}
          gap={22}
          size={1.4}
          color="var(--grid-fine)"
        />
      )}
    </>
  )
}

/** What each add button makes, said once rather than inferred from its label. */
const ADD_NODE = [
  { type: 'image', hint: 'A still frame, rendered from a prompt' },
  { type: 'video', hint: 'A clip that starts from the frame you wire into it' },
  { type: 'export', hint: 'Crops and text overlays, written to ./exports' },
] as const

let counter = 0
const newId = (type: string) => `${type}-${++counter}-${Math.random().toString(36).slice(2, 6)}`

const nodeShapeOf = (graph: Flow) => graph.nodes.map((n) => n.id).join('|')
const edgeShapeOf = (graph: Flow) => graph.edges.map((e) => `${e.from}>${e.to}:${e.role}`).join('|')

export function Canvas() {
  return (
    <ReactFlowProvider>
      <TooltipProvider>
        <CanvasInner />
      </TooltipProvider>
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
  /**
   * One line of feedback, and whether it is a refusal or a fact.
   *
   * It used to be a bare string rendered into `.floating` alongside four other
   * things at the same coordinates, so a refused wire and an export result
   * landed exactly on top of each other. It is a toast now, and the tone is
   * carried rather than guessed: "already rendered at these settings" is not an
   * error and must not arrive in the fault colour.
   */
  const [notice, setNotice] = useState<{ text: string; tone: 'error' | 'info' } | null>(null)
  const say = useCallback(
    (text: string, tone: 'error' | 'info' = 'error') => setNotice({ text, tone }),
    [],
  )
  // Carries the node so "Render anyway" repeats the click that was refused,
  // rather than silently widening one shot into the whole flow.
  const [confirming, setConfirming] = useState<{ message: string; nodeId?: NodeId } | null>(null)
  const [showRefs, setShowRefs] = useState(true)
  // Open by default. A map you have to find first is a map nobody uses, and the
  // shape of the work is twelve cards spread wider than one screen.
  const [mapOpen, setMapOpen] = useState(true)
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
            const size = fitToFrame(node, next.nodes[node.id]?.outputs[0])
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
          // A render finishing does not change the node shape, so this branch is
          // where a first output arrives — and the card takes the frame's shape
          // here or never. `fitToFrame` returns the stored size untouched once
          // there is one, so a card you have sized is not resnapped under you.
          const size = fitToFrame(node, nodeState.outputs[0])
          return { ...rf, width: size.w, height: size.h, data: { node, state: nodeState } }
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
        say(error instanceof Error ? error.message : 'Could not load the flow')
      }
    }
  }, [absorb, say])

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
            say(
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
                say(retry instanceof Error ? retry.message : 'Could not save')
              }
            } else {
              say(error instanceof Error ? error.message : 'Could not save')
            }
          }
          await load()
        })
        .catch(() => undefined)
      return queueRef.current
    },
    [load, say],
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

  /**
   * The bridge from state to the toast stack.
   *
   * Kept as state rather than fired imperatively at each call site, because
   * several paths clear the notice as well as set it — `setNotice(null)` is how
   * a successful wire takes the last refusal off screen, and an imperative
   * `toast()` has nothing to take back. The fixed `id` also means a message
   * re-set to the same value replaces its toast rather than stacking a second
   * copy of itself.
   *
   * `duration: Infinity`: a refusal that fades before you look up is a refusal
   * nobody read, and every one of these names something you now have to do.
   */
  useEffect(() => {
    if (!notice) {
      toast.dismiss('notice')
      return
    }
    const show = notice.tone === 'error' ? toast.error : toast.info
    show(<span data-testid="notice">{notice.text}</span>, {
      id: 'notice',
      duration: Infinity,
      onDismiss: () => setNotice(null),
    })
  }, [notice])

  useEffect(() => {
    if (!exported) {
      toast.dismiss('export')
      return
    }
    toast[exported.refusals.length > 0 ? 'warning' : 'success'](
      <span data-testid="export-result">
        {exported.written} {exported.written === 1 ? 'file' : 'files'} written to ./exports
        {exported.refusals.length > 0 ? ` · ${exported.refusals.length} refused` : ''}
      </span>,
      {
        id: 'export',
        duration: Infinity,
        onDismiss: () => setExported(null),
        // Every refusal, named. A count alone tells you something was refused
        // and nothing about what to drag two pixels to fix.
        description:
          exported.refusals.length > 0 ? (
            <span className="flex flex-col gap-1">
              {exported.refusals.map((reason) => (
                <span key={reason} data-testid="export-refusal">
                  {reason}
                </span>
              ))}
            </span>
          ) : undefined,
      },
    )
  }, [exported])

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
   * Re-roll and delete, from the card's own toolbar.
   *
   * Both existed only in the inspector, which meant deleting a card was select,
   * read a panel, find the one red chip in it. `reroll` keeps the direction and
   * changes the dice; confusing that with editing the prompt means re-rolling a
   * bad idea forever, which is why they are worded the way they are.
   */
  const reroll = useCallback(
    (nodeId: NodeId) =>
      void commit((current) => ({
        ...current,
        nodes: current.nodes.map((n) =>
          n.id === nodeId ? ({ ...n, seed: Math.floor(Math.random() * 1_000_000) } as FlowNode) : n,
        ),
      })),
    [commit],
  )

  const deleteNode = useCallback(
    (nodeId: NodeId) => {
      void commit((current) => removeNode(current, nodeId))
      setSelectedId((current) => (current === nodeId ? null : current))
    },
    [commit],
  )

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
        say(error instanceof Error ? error.message : 'Could not save that note')
      }
    },
    [load, say],
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
      if (outcome.kind === 'refused') {
        say(outcome.message)
      } else if (outcome.enqueued === 0) {
        // Nothing enqueued reads as a dead button. It means the hash is already
        // satisfied — say so, and name the way to render it again. A fact, not
        // a refusal: the fault colour here would report a working cache as a
        // failure.
        say('Already rendered at these settings. Re-roll the seed to render it again.', 'info')
      } else {
        setNotice(null)
      }
      await load()
    },
    [load, say],
  )

  const onRun = useCallback((nodeId: NodeId) => void run({ nodeId }), [run])

  /**
   * `fanOut` is declared below as a plain function — it reads the catalog off
   * `state` and would have to be rebuilt on every poll. Called through a ref so
   * the identity handed to every card is stable: put a fresh function in
   * `decorated`'s deps and each card's `data` object is new on every render,
   * which re-renders twelve cards for nothing.
   */
  const fanOutRef = useRef<(nodeId: NodeId) => void>(() => undefined)
  const onFanOut = useCallback((nodeId: NodeId) => fanOutRef.current(nodeId), [])

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
            onReroll: reroll,
            onFanOut,
            onDelete: deleteNode,
          },
        }
      }),
    [
      rfNodes,
      selectedId,
      sourcesById,
      hovered,
      litUp,
      onPrompt,
      onReplace,
      onRun,
      onEditText,
      reroll,
      onFanOut,
      deleteNode,
    ],
  )

  /**
   * The edge layer, dressed after the fact.
   *
   * Arrowheads and the rendering animation are decided here rather than in
   * `absorb`, because both depend on node *state* and `absorb` reseeds the edge
   * array only when the graph's edge shape changes. Folded in there, an edge
   * would keep the arrowhead it was born with and never notice its target
   * started rendering.
   *
   * Only generation edges get a head. A reference is a fact about a shot, not a
   * direction anything travels in, and pointing an arrow at it says the wrong
   * thing about what the graph does.
   */
  const visibleEdges = useMemo(() => {
    const shown = showRefs ? rfEdges : rfEdges.filter((e) => e.data?.role !== 'reference')
    return shown.map((edge) => {
      if (edge.data?.role === 'reference') return edge
      const live = RUNNING.has(state?.nodes[edge.target]?.status ?? 'stale')
      return {
        ...edge,
        className: live ? `${edge.className ?? ''} edge--live` : edge.className,
        markerEnd: {
          type: MarkerType.ArrowClosed,
          width: 14,
          height: 14,
          color: 'var(--fixed)',
        },
      }
    })
  }, [rfEdges, showRefs, state])
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

  // Re-pointed after every render, called through `onFanOut` above: the cards
  // hold a stable callback and this holds the current closure. In an effect
  // rather than inline, because a ref written during render is a value React is
  // free to throw away when it discards that render.
  useEffect(() => {
    fanOutRef.current = fanOut
  })

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
      say(error instanceof Error ? error.message : 'Upload failed')
    }
  }

  async function addNote(text: string) {
    try {
      const { id } = await createTextSource(text)
      const slot = freeSlot(graphRef.current.nodes, CARD_SOURCE)
      addSourceNode(id, slot)
      reveal(slot, CARD_SOURCE)
    } catch (error) {
      say(error instanceof Error ? error.message : 'Could not save that note')
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
      say(error instanceof Error ? error.message : 'Upload failed')
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
      say(error instanceof Error ? error.message : 'Export failed')
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
      say(error instanceof Error ? error.message : 'Could not save the brand profile')
    }
  }

  const totals = state?.totals

  return (
    <>
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

        {ADD_NODE.map(({ type, hint }) => (
          <Hint key={type} label={hint}>
            <button className="chip" onClick={() => addNode(type)} data-testid={`add-${type}`}>
              + {type}
            </button>
          </Hint>
        ))}

        <AssetMenu
          sources={state?.sources ?? []}
          onUpload={(files) => void addAssets(files)}
          onNote={(text) => void addNote(text)}
          onPick={addExistingSource}
        />

        {/* The shortcut used to be the whole tooltip: `title="⌥R"`, with nothing
            anywhere saying what ⌥R did. */}
        <Hint label={showRefs ? 'Hide reference wires' : 'Show reference wires'} keys="⌥R">
          <button
            className="chip"
            aria-pressed={!showRefs}
            onClick={() => setShowRefs((on) => !on)}
            data-testid="toggle-refs"
          >
            {hiddenRefs > 0 ? `${hiddenRefs} refs hidden` : 'refs'}
          </button>
        </Hint>

        <span className="topbar__spacer" />

        {totals && (
          <Hint
            label={
              totals.staleCount > 0
                ? 'What it would cost to render everything that is out of date'
                : totals.runningCount > 0
                  ? 'Shots dispatched to fal and not yet answered'
                  : 'What this flow has cost so far'
            }
          >
            <span
              className={
                totals.staleCount > 0 || totals.runningCount > 0
                  ? 'ledger ledger--due'
                  : 'ledger ledger--clear'
              }
              data-testid="ledger"
              tabIndex={0}
            >
              {totals.staleCount > 0
                ? `${totals.staleCount} stale · ${money(totals.estimatedCents)} to render`
                : totals.runningCount > 0
                  ? `rendering ${totals.runningCount}…`
                  : `all rendered · ${money(totals.spentCents)} spent`}
            </span>
          </Hint>
        )}

        <Hint label="The voice every prompt is composed against">
          <button className="chip" onClick={() => void openBrand()} data-testid="brand">
            Brand
          </button>
        </Hint>

        <Hint label="Write every rendered frame to ./exports">
          <button className="chip" onClick={() => void exportAll()} data-testid="export">
            Export
          </button>
        </Hint>

        <Hint label={chatOpen ? 'Close the direction panel' : 'Write the graph by asking for it'}>
          <button
            className="chip"
            aria-pressed={chatOpen}
            onClick={() => setChatOpen((open) => !open)}
            data-testid="chat-toggle"
          >
            Chat
          </button>
        </Hint>

        <Hint label="Render everything that is out of date, at the price on the ledger">
          <button className="run" onClick={() => void run()} data-testid="run">
            Run all
          </button>
        </Hint>
      </header>

      <div className="canvas-row">
      {/* `data-map` is read by the stylesheet: the controls sit above the
          overview when there is one and drop back to the corner when there is
          not, so an empty canvas has no gap where a map used to be. */}
      <main className="canvas" data-dropping={dropping} data-map={mapOpen && nodeCount > 0}>
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
          <Grid />

          {/*
            A shot's status is the only thing worth reading at map scale — the
            frame is four pixels wide there. Amber still means billed, so a
            glance at the corner answers "how much of this graph is unpaid for"
            without reading a single card.
          */}
          {mapOpen && nodeCount > 0 && (
            <MiniMap
              position="bottom-left"
              pannable
              zoomable
              ariaLabel="Graph overview"
              maskColor="var(--minimap-mask)"
              bgColor="var(--ground)"
              nodeStrokeWidth={0}
              nodeColor={(node) => {
                const status = state?.nodes[node.id]?.status ?? 'stale'
                if (status === 'succeeded') return 'var(--fixed)'
                if (status === 'failed') return 'var(--fault)'
                if (RUNNING.has(status)) return 'var(--beam)'
                // The dim amber, not the safelight itself. A fresh graph is
                // entirely stale, and at map scale that is a solid block of the
                // loudest colour in the interface saying nothing you did not
                // already know. Still amber, still means billed.
                return 'var(--safelight-dim)'
              }}
            />
          )}

          <Controls showInteractive={false}>
            {/* Inside the control cluster rather than beside it: zoom, fit and
                overview are one thought, and a second floating island in the
                corner is one more thing covering the canvas. */}
            <button
              type="button"
              className="react-flow__controls-button"
              aria-pressed={mapOpen}
              title={mapOpen ? 'Hide the overview' : 'Show the overview'}
              aria-label={mapOpen ? 'Hide the overview' : 'Show the overview'}
              data-testid="toggle-minimap"
              onClick={() => setMapOpen((open) => !open)}
            >
              <svg viewBox="0 0 16 16" width="12" height="12" aria-hidden="true">
                <rect x="1.5" y="2.5" width="13" height="11" rx="1.5" fill="none" stroke="currentColor" />
                <rect x="4" y="5" width="5" height="4" rx="0.5" fill="currentColor" />
              </svg>
            </button>
          </Controls>
        </ReactFlow>

        {/*
          Teaches the interface rather than announcing that it is empty. There
          are three ways in and the canvas used to name one of them, so the
          toolbar and the chat panel read as decoration until you guessed.

          Still `pointer-events: none` — every route here is a thing you do
          somewhere else on screen, and a click that lands on this panel instead
          of the canvas under it is a click that does nothing.
        */}
        {nodeCount === 0 && (
          <div className="empty-canvas">
            <span className="slate">Empty call sheet</span>
            <p className="hint">
              Nothing renders until you press Run, and the price is on the card before you do.
            </p>
            <ul className="empty-canvas__ways">
              <li>
                <span className="slate">Drop</span>a product photo, a clip or a note anywhere on the
                canvas
              </li>
              <li>
                <span className="slate">Add</span>a shot from the toolbar, then wire an asset into it
              </li>
              <li>
                <span className="slate">Ask</span>the panel on the right to write the graph for you
              </li>
            </ul>
          </div>
        )}

        {dropping && <div className="drop-veil">Drop to add an asset</div>}

        {/*
          `notice`, `exported`, `confirming`, `replacing` and `brief` all used to
          render into `.floating` at the same `left: 16px; bottom: 16px`. Any two
          at once landed exactly on top of each other — a refused wire could hide
          the spend confirmation that was waiting for an answer.

          They are three different things and now live in three places: passing
          facts go to the toast stack, the two irreversible-money gates are real
          alert dialogs, and the brand profile is a form, so it is a dialog too.
        */}
      </main>

      {chatOpen && <ChatPanel />}
      </div>

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

      {/*
        Outside `.shell`, all of it.

        `.shell` is a two-column grid whose columns are the canvas and the
        inspector, and every direct child is a grid item. `<Toaster>` renders a
        real <section>, so sitting in here it took the inspector's column: the
        inspector wrapped to a third row, the canvas lost half its height, and a
        node card ended up underneath the panel — you could double-click a
        prompt and hit an inspector field instead. Overlays belong in the top
        layer or a portal, never in the layout.
      */}
      <Lightbox item={preview} onClose={() => setPreview(null)} />

      {/*
        Both of these are the same shape and neither is a modal for the sake of
        it: they are the two places money is committed, and they were the least
        prominent things on screen — a banner in the bottom-left corner, in the
        same slot as four other panels. An alert dialog takes focus, traps it,
        and cannot be missed, which is the correct amount of friction for an
        invoice.
      */}
      <AlertDialog open={confirming !== null} onOpenChange={(open) => !open && setConfirming(null)}>
        <AlertDialogContent aria-label="Confirm spend">
          <AlertDialogHeader>
            <AlertDialogTitle>Confirm spend</AlertDialogTitle>
            <AlertDialogDescription data-testid="spend-warning">
              {confirming?.message}
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Cancel</AlertDialogCancel>
            <AlertDialogAction
              data-testid="confirm-spend"
              onClick={() => void run({ nodeId: confirming?.nodeId, confirmOverspend: true })}
            >
              Render anyway
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>

      <AlertDialog open={replacing !== null} onOpenChange={(open) => !open && setReplacing(null)}>
        <AlertDialogContent aria-label="Confirm replacement">
          <AlertDialogHeader>
            <AlertDialogTitle>Confirm replacement</AlertDialogTitle>
            {/* Never silently re-run. One replacement can invalidate two campaigns. */}
            <AlertDialogDescription data-testid="replace-warning">
              {replacing
                ? `${replacing.radius.nodeCount} ${replacing.radius.nodeCount === 1 ? 'shot' : 'shots'} across ${replacing.radius.flowCount} ${replacing.radius.flowCount === 1 ? 'flow' : 'flows'} go stale · ${money(replacing.radius.estimatedCents)} to refresh.`
                : null}
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Cancel</AlertDialogCancel>
            <AlertDialogAction
              data-testid="confirm-replace"
              onClick={(event) => {
                if (!replacing) return
                // The file picker has to open from inside the click that was
                // just made, so this branch keeps the dialog open rather than
                // letting AlertDialogAction close it: the input is a child of
                // the dialog, and a closed dialog has no input to click.
                if (replacing.text === undefined) {
                  event.preventDefault()
                  replaceInputRef.current?.click()
                  return
                }
                void (async () => {
                  try {
                    await replaceSource(replacing.id, replacing.text!)
                  } catch (error) {
                    say(error instanceof Error ? error.message : 'Could not save that note')
                  }
                  setReplacing(null)
                  await load()
                })()
              }}
            >
              {replacing?.text === undefined ? 'Choose a file' : 'Save the note'}
            </AlertDialogAction>
          </AlertDialogFooter>
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
                say(error instanceof Error ? error.message : 'Could not replace')
              }
              setReplacing(null)
              await load()
            }}
          />
        </AlertDialogContent>
      </AlertDialog>

      {/* A form, not an alert: nothing is spent by opening it, and the profile is
          long enough to want a box rather than a corner banner. */}
      <Dialog open={brief !== null} onOpenChange={(open) => !open && setBrief(null)}>
        <DialogContent aria-label="Brand">
          <DialogHeader>
            <DialogTitle>Brand</DialogTitle>
            <DialogDescription>
              Composed ahead of every prompt on the canvas. Changing it does not re-render anything
              on its own.
            </DialogDescription>
          </DialogHeader>
          <label className="field">
            <span className="slate">Brand profile</span>
            <textarea
              rows={5}
              value={brief?.profile ?? ''}
              placeholder="Warm, editorial, never clinical. Product always in frame."
              data-testid="brand-profile"
              onChange={(e) => setBrief({ profile: e.target.value })}
            />
          </label>
          <DialogFooter>
            <button className="chip" onClick={() => setBrief(null)}>
              Cancel
            </button>
            <button className="run" onClick={() => void saveBrand()} data-testid="brand-save">
              Save
            </button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/*
        Bottom-right, stacked, and errors do not auto-dismiss: a refusal that
        fades before you look up is a refusal nobody read. `expand` because two
        at once is the case this whole change exists for.
      */}
      <Toaster
        position="bottom-right"
        expand
        richColors
        closeButton
        // The chat panel overlays the right edge of the canvas, so an unshifted
        // bottom-right toast lands on top of its composer — you get told
        // something went wrong by a box sitting over the box you were typing in.
        offset={{ right: chatOpen ? '23.5rem' : '1rem', bottom: '1rem' }}
      />
    </>
  )
}
