'use client'

import { Handle, Position, type NodeProps } from '@xyflow/react'
import type { FlowNode } from '@/core/types'
import { money, type NodeState } from './state'

export type CardData = {
  node: FlowNode
  state: NodeState
  selected: boolean
}

const STATUS_LABEL: Record<NodeState['status'], string> = {
  stale: 'stale',
  queued: 'queued',
  claimed: 'queued',
  submitted: 'rendering',
  polling: 'rendering',
  succeeded: 'done',
  failed: 'failed',
}

/**
 * A node is a strip of production paperwork: slate on top, the frame itself,
 * the direction, and the lab bill in the margin.
 *
 * The price is always on screen. Hiding cost behind a hover is how a tool ends
 * up surprising someone with an invoice.
 */
export function NodeCard({ data }: NodeProps) {
  const { node, state, selected } = data as unknown as CardData
  const output = state.outputs[0]

  return (
    <div className="node" data-status={state.status} data-selected={selected} data-testid={`node-${node.id}`}>
      {node.type !== 'source' && <Handle type="target" position={Position.Left} />}
      {node.type !== 'export' && <Handle type="source" position={Position.Right} />}

      <header className="node__slate">
        <span className="node__clap" aria-hidden="true" />
        <span className="node__id">{node.label ?? node.id}</span>
        <span className="node__role">{node.type}</span>
      </header>

      <div className="node__frame">
        {output ? (
          output.mime.startsWith('video/') ? (
            <video src={output.url} muted loop playsInline onMouseEnter={(e) => e.currentTarget.play()} onMouseLeave={(e) => e.currentTarget.pause()} />
          ) : (
            // Plain <img>: these are locally generated files served off disk by
            // this same process. next/image would put an optimiser in front of
            // assets that are already exactly the bytes we produced.
            // eslint-disable-next-line @next/next/no-img-element
            <img src={output.url} alt={`Output of ${node.id}`} />
          )
        ) : (
          <span className="node__empty">{state.status === 'failed' ? 'no frame' : 'unexposed'}</span>
        )}
      </div>

      {'prompt' in node && <p className="node__prompt">{node.prompt || 'No direction yet'}</p>}

      <footer className="node__foot">
        <span className="node__status" data-status={state.status} data-testid={`status-${node.id}`}>
          {STATUS_LABEL[state.status]}
        </span>
        <span data-testid={`price-${node.id}`}>
          {state.status === 'succeeded' ? money(state.costCents) : money(state.estimatedCents)}
        </span>
      </footer>

      {state.subtree.nodeCount > 0 && (
        <footer className="node__foot node__foot--branch">
          <span className="slate">branch</span>
          <span className="node__subtree" data-testid={`subtree-${node.id}`}>
            {state.subtree.nodeCount} · {money(state.subtree.cents)}
          </span>
        </footer>
      )}
    </div>
  )
}
