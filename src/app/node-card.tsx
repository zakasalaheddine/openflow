'use client'

import { useEffect, useRef, useState } from 'react'
import { Handle, Position, type NodeProps } from '@xyflow/react'
import type { FlowNode } from '@/core/types'
import { money, type NodeState, type SourceRow } from './state'
import type { Preview } from './lightbox'

export type CardData = {
  node: FlowNode
  state: NodeState
  selected: boolean
  source?: SourceRow
  onPrompt: (nodeId: string, prompt: string) => void
  onReplace: (sourceId: string) => void
  onRun: (nodeId: string) => void
  onPreview: (item: Preview) => void
}

/**
 * Opens the frame at full size.
 *
 * A corner control, not the whole frame. Making the frame itself the button was
 * tried and reverted: it sits in the middle of the card, so it swallowed the
 * click that selects a node and the alt-click that fans out a sibling — the
 * inspector stopped opening and branching stopped working. A preview is worth
 * far less than either.
 *
 * A real button so it is keyboard-reachable like every other control on the
 * card. `nodrag` and the stopped propagation keep it off React Flow's drag
 * handler and off the alt-click.
 */
function Peek({ item, onPreview }: { item: Preview; onPreview: (item: Preview) => void }) {
  return (
    <button
      className="node__peek nodrag"
      data-testid={`preview-${item.label}`}
      title="See it full size"
      aria-label={`Preview ${item.label}`}
      onClick={(event) => {
        event.stopPropagation()
        onPreview(item)
      }}
    >
      ⤢
    </button>
  )
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
  const { node, state, selected, source, onPrompt, onReplace, onRun, onPreview } =
    data as unknown as CardData

  if (node.type === 'source') {
    return (
      <SourceCard
        node={node}
        source={source}
        selected={selected}
        onReplace={onReplace}
        onPreview={onPreview}
      />
    )
  }

  const output = state.outputs[0]

  return (
    <div className="node" data-status={state.status} data-selected={selected} data-testid={`node-${node.id}`}>
      <Handle type="target" position={Position.Left} />
      {node.type !== 'export' && <Handle type="source" position={Position.Right} />}

      <header className="node__slate">
        <span className="node__clap" aria-hidden="true" />
        <span className="node__id">{node.label ?? node.id}</span>
        <span className="node__role">{node.type}</span>
      </header>

      <div className="node__frame">
        {output ? (
          <>
            {output.mime.startsWith('video/') ? (
              <video
                src={output.url}
                muted
                loop
                playsInline
                onMouseEnter={(e) => void e.currentTarget.play().catch(() => undefined)}
                onMouseLeave={(e) => e.currentTarget.pause()}
              />
            ) : (
              // Plain <img>: these are locally generated files served off disk by
              // this same process. next/image would put an optimiser in front of
              // assets that are already exactly the bytes we produced.
              // eslint-disable-next-line @next/next/no-img-element
              <img src={output.url} alt={`Output of ${node.id}`} />
            )}
            <Peek item={{ url: output.url, mime: output.mime, label: node.id }} onPreview={onPreview} />
          </>
        ) : (
          <span className="node__empty">{state.status === 'failed' ? 'no frame' : 'unexposed'}</span>
        )}
      </div>

      {'prompt' in node && (
        <EditablePrompt value={node.prompt} onCommit={(next) => onPrompt(node.id, next)} />
      )}

      <footer className="node__foot">
        <span className="node__status" data-status={state.status} data-testid={`status-${node.id}`}>
          {STATUS_LABEL[state.status]}
        </span>
        <span data-testid={`price-${node.id}`}>
          {state.status === 'succeeded' ? money(state.costCents) : money(state.estimatedCents)}
        </span>
        {/* Reviewing one shot is not the same as committing to twelve. The card
            renders itself and whatever upstream it still needs — nothing else.
            `nodrag` and the stopped propagation keep the click off React Flow's
            drag handler and off the canvas's alt-click fan-out. */}
        {node.type !== 'export' && (
          <button
            className="node__run nodrag"
            data-testid={`run-${node.id}`}
            disabled={state.status !== 'stale' && state.status !== 'failed'}
            title={state.status === 'succeeded' ? 'Already rendered — re-roll to render again' : 'Render this shot'}
            onClick={(event) => {
              event.stopPropagation()
              onRun(node.id)
            }}
          >
            {state.status === 'failed' ? 'Retry' : 'Run'}
          </button>
        )}
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

/**
 * Read-only until double-clicked.
 *
 * An always-live textarea on every card makes twelve shots unscannable, and
 * §6.1 says reviewing twelve at once is the point of the canvas.
 */
function EditablePrompt({ value, onCommit }: { value: string; onCommit: (next: string) => void }) {
  // `draft` is null when not editing, so there is no copy of the prompt to keep
  // in sync with the server — the value on screen is always the real one.
  const [draft, setDraft] = useState<string | null>(null)
  const ref = useRef<HTMLTextAreaElement>(null)
  const editing = draft !== null

  useEffect(() => {
    if (editing) ref.current?.focus()
  }, [editing])

  if (draft === null) {
    return (
      <p
        className="node__prompt"
        onDoubleClick={() => setDraft(value)}
        title="Double-click to edit"
        data-testid="node-prompt-text"
      >
        {value || 'Double-click to describe the shot'}
      </p>
    )
  }

  const commit = () => {
    const next = draft
    setDraft(null)
    if (next !== value) onCommit(next)
  }

  return (
    <textarea
      ref={ref}
      className="node__prompt node__prompt--editing nodrag"
      value={draft}
      data-testid="node-prompt-input"
      onChange={(e) => setDraft(e.target.value)}
      onBlur={commit}
      onKeyDown={(e) => {
        if (e.key === 'Escape') setDraft(null)
        if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) commit()
      }}
    />
  )
}

/** An uploaded asset: the product, a reference clip, or a fragment of brand tone. */
function SourceCard({
  node,
  source,
  selected,
  onReplace,
  onPreview,
}: {
  node: FlowNode
  source?: SourceRow
  selected: boolean
  onReplace: (sourceId: string) => void
  onPreview: (item: Preview) => void
}) {
  const sourceId = node.type === 'source' ? node.sourceId : ''
  const kind = source?.kind ?? 'image'
  // A hosted store records the CDN URL itself; a local one records a store key
  // this app serves. Prefixing a URL with `/` is how you get `/https://…`.
  const raw = source?.files?.[0]
  const file = !raw ? '' : /^https?:\/\//.test(raw) ? raw : `/${raw}`

  return (
    <div
      className="node node--source"
      data-kind={kind}
      data-selected={selected}
      data-testid={`node-${node.id}`}
    >
      <Handle type="source" position={Position.Right} />

      <header className="node__slate">
        <span className="node__id">{node.label ?? kind}</span>
        <span className="node__role" data-testid={`version-${node.id}`}>
          v{source?.version ?? '—'}
        </span>
      </header>

      <div className="node__frame node__frame--source">
        {!source ? (
          <span className="node__empty">missing</span>
        ) : kind === 'text' ? (
          // Nothing to enlarge: the card already shows the whole fragment.
          <p className="node__text">{source.text}</p>
        ) : (
          <>
            {kind === 'video' ? (
              <video src={file} muted loop playsInline />
            ) : (
              // eslint-disable-next-line @next/next/no-img-element
              <img src={file} alt={node.label ?? 'Reference'} />
            )}
            <Peek
              item={{ url: file, mime: kind === 'video' ? 'video/mp4' : 'image/*', label: node.id }}
              onPreview={onPreview}
            />
          </>
        )}
      </div>

      <footer className="node__foot">
        <span className="slate">asset</span>
        <button className="node__replace nodrag" onClick={() => onReplace(sourceId)} data-testid={`replace-${node.id}`}>
          Replace
        </button>
      </footer>
    </div>
  )
}
