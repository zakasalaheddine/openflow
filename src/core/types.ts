export type NodeId = string
export type AnchorId = string

/** Scarce by design. Four in v1; a fifth requires a written case. */
export type NodeType = 'source' | 'image' | 'video' | 'export'

export type ModelRole = 'draft' | 'hero' | 'specialist'

export type AssetRef = {
  id: string
  path: string
  mime: string
  width?: number
  height?: number
  durationMs?: number
  fps?: number
  codec?: string
}

export type AdFormat = {
  name: string
  w: number
  h: number
}

/**
 * Canvas coordinates. Stored in `graph_json` so a reload does not scramble the
 * layout, and deliberately excluded from the input hash — see core/hashable.ts.
 */
export type NodePosition = { x: number; y: number }

type NodeBase = {
  id: NodeId
  /**
   * Optional so a hand-written flow file (`flows/demo.json`, the headless
   * runner) never has to invent coordinates. The canvas assigns one on create
   * and falls back to an auto-layout when it is missing.
   */
  position?: NodePosition
  /** View-only. Never hashed. */
  label?: string
}

export type SourceNode = NodeBase & {
  type: 'source'
  assets: AssetRef[]
}

export type ImageNode = NodeBase & {
  type: 'image'
  prompt: string
  anchors: AnchorId[]
  modelRole: ModelRole
  seed?: number
}

export type VideoNode = NodeBase & {
  type: 'video'
  prompt: string
  anchors: AnchorId[]
  durationSec: number
  audio: boolean
  modelRole: ModelRole
  seed?: number
}

export type ExportNode = NodeBase & {
  type: 'export'
  formats: AdFormat[]
  fps?: number
  codec?: string
}

export type FlowNode = SourceNode | ImageNode | VideoNode | ExportNode

/**
 * Edges carry meaning. An image → video edge with `role: 'start_frame'`
 * literally means "this image is frame zero of that clip", and the registry's
 * `caps.startEndFrame` gates it at wiring time rather than silently ignoring
 * it at render time.
 */
export type Edge = {
  id: string
  from: NodeId
  to: NodeId
  role: 'start_frame' | 'end_frame' | 'input'
  /** Reserved for v2 sequence ordering. Always null in v1. */
  position: number | null
}

export type Flow = {
  nodes: FlowNode[]
  edges: Edge[]
}

/** The minimum a graph walk needs. Lets the walks stay independent of node shape. */
export type GraphShape = {
  nodeIds: NodeId[]
  edges: Edge[]
}
