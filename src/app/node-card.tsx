'use client'

import { useEffect, useRef, useState } from 'react'
import { Handle, NodeResizer, Position, type NodeProps } from '@xyflow/react'
import type { FlowNode } from '@/core/types'
import { MIN_CARD } from './slots'
import { money, type NodeState, type SourceRow } from './state'
import type { Preview } from './lightbox'

/**
 * The corner grip, drawn only on the card you are looking at.
 *
 * Width and height mean different things and that is the point. Height past what
 * the frame wants goes to the direction, so a taller card is more of the prompt
 * to read. Width is the frame's, which holds 5:4 — but only while the card is
 * tall enough to allow it, so widening alone crops harder rather than enlarging.
 * Both have to move to see a shot bigger. A card is a thing you size to the
 * question you are asking of it.
 *
 * Hidden until selected. Twelve cards each wearing eight handles is a canvas of
 * handles, and the frames are what you came to look at.
 */
function Grip({ visible }: { visible: boolean }) {
  return (
    <NodeResizer
      isVisible={visible}
      minWidth={MIN_CARD.w}
      minHeight={MIN_CARD.h}
      lineClassName="node__resize-line"
      handleClassName="node__resize-handle"
    />
  )
}

export type CardData = {
  node: FlowNode
  state: NodeState
  selected: boolean
  source?: SourceRow
  onPrompt: (nodeId: string, prompt: string) => void
  onReplace: (sourceId: string) => void
  onRun: (nodeId: string) => void
  onPreview: (item: Preview) => void
  onEditText: (sourceId: string, text: string) => void
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
  const { node, state, selected, source, onPrompt, onReplace, onRun, onPreview, onEditText } =
    data as unknown as CardData

  if (node.type === 'source') {
    return (
      <SourceCard
        node={node}
        source={source}
        selected={selected}
        onReplace={onReplace}
        onPreview={onPreview}
        onEditText={onEditText}
      />
    )
  }

  const output = state.outputs[0]

  return (
    <div className="node" data-status={state.status} data-selected={selected} data-testid={`node-${node.id}`}>
      <Grip visible={selected} />
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
        {/* On the card, not only in the inspector: three shots off one source
            differ by their model and nothing else, and a comparison you have to
            click through one card at a time is not a comparison. */}
        {'modelId' in node && (
          <span className="node__model" data-testid={`model-${node.id}`}>
            {node.modelId}
          </span>
        )}
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

        {/* Total spend is too coarse when one branch is three video renders, but
            it is also noise on every card at once — so it rides above the bill
            on hover. Lifted out of the layout on purpose: as its own row it
            changed the card's height under the pointer, and twelve cards that
            twitch as you read across them is worse than the number is useful.
            Never over the price: cost stays on screen at all times. */}
        {state.subtree.nodeCount > 0 && (
          <span className="node__foot--branch">
            <span className="slate">branch</span>
            <span className="node__subtree" data-testid={`subtree-${node.id}`}>
              {state.subtree.nodeCount} · {money(state.subtree.cents)}
            </span>
          </span>
        )}
      </footer>
    </div>
  )
}

/**
 * Read-only until double-clicked.
 *
 * An always-live textarea on every card makes twelve shots unscannable, and
 * §6.1 says reviewing twelve at once is the point of the canvas.
 *
 * Shared by a shot's direction and by a text asset's contents. They are the same
 * gesture on the same kind of thing — prose the model reads — and differ only in
 * what committing one costs, which is the caller's problem, not this one's.
 */
function EditablePrompt({
  value,
  onCommit,
  className = 'node__prompt',
  testId = 'node-prompt',
  placeholder = 'Double-click to describe the shot',
}: {
  value: string
  onCommit: (next: string) => void
  className?: string
  testId?: string
  placeholder?: string
}) {
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
        className={className}
        onDoubleClick={() => setDraft(value)}
        title="Double-click to edit"
        data-testid={`${testId}-text`}
      >
        {value || placeholder}
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
      className={`${className} node__prompt--editing nodrag`}
      value={draft}
      data-testid={`${testId}-input`}
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
  onEditText,
}: {
  node: FlowNode
  source?: SourceRow
  selected: boolean
  onReplace: (sourceId: string) => void
  onPreview: (item: Preview) => void
  onEditText: (sourceId: string, text: string) => void
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
      <Grip visible={selected} />
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
          // Nothing to enlarge: the card already shows the whole fragment. It is
          // edited in place instead, because brand voice is the one asset you
          // rewrite rather than re-upload.
          <EditablePrompt
            value={source.text ?? ''}
            className="node__text"
            testId={`node-text-${node.id}`}
            placeholder="Double-click to write the note"
            onCommit={(next) => onEditText(sourceId, next)}
          />
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
