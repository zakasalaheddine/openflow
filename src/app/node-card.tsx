'use client'

import { useEffect, useRef, useState } from 'react'
import { Handle, NodeResizer, NodeToolbar, Position, type NodeProps } from '@xyflow/react'
import { DicesIcon, GitBranchIcon, Trash2Icon } from 'lucide-react'
import { Hint } from '@/ui/hint'
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
  /**
   * For a sequence: how long the film would be, and out of how many shots.
   * Derived on the client from the clips' own durations — it is arithmetic on
   * the graph, not a price, so there is nothing here a server has to vouch for.
   */
  runtime?: { clipCount: number; seconds: number }
  onPrompt: (nodeId: string, prompt: string) => void
  onReplace: (sourceId: string) => void
  onRun: (nodeId: string) => void
  onPreview: (item: Preview) => void
  onEditText: (sourceId: string, text: string) => void
  onReroll: (nodeId: string) => void
  onFanOut: (nodeId: string) => void
  onDelete: (nodeId: string) => void
}

/**
 * The actions a card has that its own strip has no room for.
 *
 * Two of these had no home at all: Delete lived only in the inspector, so
 * removing a card meant selecting it, reading a panel, and finding the one red
 * chip in it; and fanning out a sibling clip was alt-click on the card body,
 * which nothing on screen has ever mentioned.
 *
 * `NodeToolbar` is React Flow's own — it tracks the node through pans and zooms
 * and stays a constant size as the canvas scales, which a hand-positioned strip
 * does not. Visible on selection only: twelve cards each wearing a toolbar is a
 * canvas of toolbars.
 */
function CardActions({
  node,
  visible,
  onReroll,
  onFanOut,
  onDelete,
}: {
  node: FlowNode
  visible: boolean
  onReroll: (nodeId: string) => void
  onFanOut: (nodeId: string) => void
  onDelete: (nodeId: string) => void
}) {
  return (
    <NodeToolbar isVisible={visible} position={Position.Top} offset={10}>
      <div className="node__tools nodrag nopan">
        {node.type === 'image' && (
          <Hint label="Another clip off this frame, same direction, fresh seed" keys="⌥click" side="top">
            <button data-testid={`fanout-${node.id}`} onClick={() => onFanOut(node.id)}>
              <GitBranchIcon aria-hidden="true" />
              Fan out
            </button>
          </Hint>
        )}
        {'seed' in node && (
          <Hint label="Keep the direction, change the dice" side="top">
            <button data-testid={`toolbar-reroll-${node.id}`} onClick={() => onReroll(node.id)}>
              <DicesIcon aria-hidden="true" />
              Re-roll
            </button>
          </Hint>
        )}
        <Hint label="Remove this card and every wire into it" side="top">
          <button
            className="node__tools-danger"
            data-testid={`toolbar-delete-${node.id}`}
            onClick={() => onDelete(node.id)}
          >
            <Trash2Icon aria-hidden="true" />
            Delete
          </button>
        </Hint>
      </div>
    </NodeToolbar>
  )
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
    <Hint label="See it full size, uncropped" side="left">
      <button
        className="node__peek nodrag"
        data-testid={`preview-${item.label}`}
        aria-label={`Preview ${item.label}`}
        onClick={(event) => {
          event.stopPropagation()
          onPreview(item)
        }}
      >
        ⤢
      </button>
    </Hint>
  )
}

/** Dispatched and not yet answered — the states a skeleton is for. */
const RENDERING: ReadonlySet<NodeState['status']> = new Set([
  'queued',
  'claimed',
  'submitted',
  'polling',
])

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
  const {
    node,
    state,
    selected,
    source,
    runtime,
    onPrompt,
    onReplace,
    onRun,
    onPreview,
    onEditText,
    onReroll,
    onFanOut,
    onDelete,
  } = data as unknown as CardData

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

  const rendering = RENDERING.has(state.status)

  return (
    <div
      className="node node--shot"
      data-status={state.status}
      data-selected={selected}
      data-has-frame={output ? 'true' : 'false'}
      data-testid={`node-${node.id}`}
    >
      <Grip visible={selected} />
      <CardActions
        node={node}
        visible={selected}
        onReroll={onReroll}
        onFanOut={onFanOut}
        onDelete={onDelete}
      />
      <Handle type="target" position={Position.Left} />
      {node.type !== 'export' && <Handle type="source" position={Position.Right} />}

      {/*
        The frame, at the size of the card.

        It used to be 5:4 of the card's width with the slate, the direction and
        the bill taking rows underneath, which meant every output was cropped to
        a shape it was not rendered in — a bottle dead centre in the thumbnail
        and cut off in the file. The card takes the frame's own ratio now (see
        `fitToFrame`), the frame fills it, and the paperwork rides on top.

        `overflow: hidden` lives here rather than on `.node`: the handles are
        siblings of this element and sit half outside the card, and clipping
        them makes them visible but not hit-testable — wiring silently stops
        working.
      */}
      <div className="node__stage">
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
        ) : node.type === 'sequence' ? (
          // Before it is cut, the card shows the thing you need in order to
          // decide whether to cut it: how long the film will be, out of how
          // many shots. Every video row caps at eight or ten seconds, so
          // reaching sixty is arithmetic, not a feeling.
          <span className="node__empty" data-testid={`runtime-${node.id}`}>
            {runtime && runtime.clipCount > 0
              ? `${runtime.clipCount} shot${runtime.clipCount === 1 ? '' : 's'} · ${runtime.seconds}s`
              : 'no clips'}
          </span>
        ) : rendering ? (
          // A shimmer, not a spinner in the middle of the card: forty seconds of
          // a static grey box is indistinguishable from a shot nobody pressed.
          <span className="node__loading" aria-label="Rendering" />
        ) : (
          <span className="node__empty">{state.status === 'failed' ? 'no frame' : 'unexposed'}</span>
        )}
      </div>

      <header className="node__slate">
        <span className="node__clap" aria-hidden="true" />
        <span className="node__id">{node.label ?? node.id}</span>
        <span className="node__role">{node.type}</span>
      </header>

      {'prompt' in node && (
        <EditablePrompt value={node.prompt} onCommit={(next) => onPrompt(node.id, next)} />
      )}

      <footer className="node__foot">
        <span className="node__status" data-status={state.status} data-testid={`status-${node.id}`}>
          <span className="node__dot" aria-hidden="true" />
          {STATUS_LABEL[state.status]}
        </span>
        {/* On the card, not only in the inspector: three shots off one source
            differ by their model and nothing else, and a comparison you have to
            click through one card at a time is not a comparison. */}
        {/* The slug is ellipsised so a long fal id cannot push the bill off the
            card, which until now meant there was no way to read the rest of it
            at all. */}
        {'modelId' in node && (
          <Hint label={node.modelId} side="top">
            <span className="node__model" data-testid={`model-${node.id}`} tabIndex={0}>
              {node.modelId}
            </span>
          </Hint>
        )}
        {/* The one figure on the card that is never abbreviated, never hidden
            behind a hover and now weighted to match: this is a tool whose
            headline feature is that you see the bill before you commit. */}
        <span className="node__price" data-testid={`price-${node.id}`}>
          {state.status === 'succeeded' ? money(state.costCents) : money(state.estimatedCents)}
        </span>
        {/* Reviewing one shot is not the same as committing to twelve. The card
            renders itself and whatever upstream it still needs — nothing else.
            `nodrag` and the stopped propagation keep the click off React Flow's
            drag handler and off the canvas's alt-click fan-out. */}
        {/* A cut runs like anything else, and its button says $0.00 because it
            is: the clips were paid for and ffmpeg is local. An export node had
            no button because it had no run; a sequence has one. */}
        {node.type !== 'export' && (
          <Hint
            label={
              state.status === 'succeeded'
                ? node.type === 'sequence'
                  ? 'Already cut. Reorder the clips to cut it again.'
                  : 'Already rendered. Re-roll the seed to render it again.'
                : node.type === 'sequence'
                  ? `Cut the film, and whatever clips it still needs rendered · ${money(state.estimatedCents)}`
                  : `Render this shot alone, and whatever upstream it still needs · ${money(state.estimatedCents)}`
            }
            side="top"
          >
            {/* Wrapped, not the button itself: a disabled button fires no
                pointer events, so a tooltip on it would be silent in exactly
                the state where "why can I not press this" is the question. */}
            <span className="node__run-wrap">
              <button
                className="node__run nodrag"
                data-testid={`run-${node.id}`}
                disabled={state.status !== 'stale' && state.status !== 'failed'}
                onClick={(event) => {
                  event.stopPropagation()
                  onRun(node.id)
                }}
              >
                {state.status === 'failed' ? 'Retry' : 'Run'}
              </button>
            </span>
          </Hint>
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

      <div className="node__frame">
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
        <Hint label="Swap the file. Every shot built on it goes stale, priced first." side="top">
          <button
            className="node__replace nodrag"
            onClick={() => onReplace(sourceId)}
            data-testid={`replace-${node.id}`}
          >
            Replace
          </button>
        </Hint>
      </footer>
    </div>
  )
}
