'use client'

import { useState } from 'react'
import type { FlowNode } from '@/core/types'
import { ASPECTS, DEFAULT_ASPECT, pixelsFor, type Aspect } from '@/core/aspect'
import { honoursAspect } from '@/models/input'
import { money, type ModelRow, type NodeState } from './state'

type Props = {
  node: FlowNode
  state: NodeState | undefined
  models: ModelRow[]
  /** For a sequence: the clips it cuts, in the order they play. Empty otherwise. */
  clips?: { id: string; label: string; seconds: number }[]
  onChange: (next: FlowNode) => void
  onReorder?: (order: string[]) => void
  onDelete: () => void
  onReroll: () => void
}

/**
 * Text you are still typing belongs to the field, not to the server.
 *
 * Every keystroke used to save the whole graph and read it back, and the 1.2s
 * poll answered with whatever the server last knew — so a reply that landed
 * between two keystrokes put the old value back under the cursor and ate what
 * you had just typed. Nine characters into a name is not nine decisions; it is
 * one, and it is made when you leave the field.
 *
 * Escape puts the stored value back. Enter commits by blurring, so there is one
 * commit path rather than two that can disagree.
 */
function Field({
  label,
  value,
  testId,
  onCommit,
  ...rest
}: {
  label: string
  value: string
  testId?: string
  onCommit: (next: string) => void
} & Omit<React.InputHTMLAttributes<HTMLInputElement>, 'value' | 'onChange' | 'onBlur'>) {
  const [draft, setDraft] = useState<string | null>(null)

  return (
    <label className="field">
      <span className="slate">{label}</span>
      <input
        {...rest}
        value={draft ?? value}
        data-testid={testId}
        onChange={(event) => setDraft(event.target.value)}
        onBlur={() => {
          if (draft !== null && draft !== value) onCommit(draft)
          setDraft(null)
        }}
        onKeyDown={(event) => {
          if (event.key === 'Escape') setDraft(null)
          if (event.key === 'Enter') {
            event.preventDefault()
            event.currentTarget.blur()
          }
        }}
      />
    </label>
  )
}

/**
 * The direction, at the size it deserves.
 *
 * The card's strip is a peek — four lines over the frame, capped so a long
 * prompt cannot bury the shot you are judging. This is where the rest of it
 * lives, and it is reached by selecting the card: a click, which works on touch,
 * from the keyboard and under a hit test. Growing the strip instead would have
 * put the whole direction behind a hover, and nothing on a card may be reachable
 * only that way.
 *
 * Same commit rules as `Field` and for the same reason — the graph is saved
 * whole and polled back, so a keystroke-by-keystroke save races the poll and
 * puts the old value under your cursor. Enter is a newline here, not a commit;
 * ⌘/Ctrl+Enter is the deliberate one, and blur is the ordinary one.
 */
function Direction({ value, onCommit }: { value: string; onCommit: (next: string) => void }) {
  const [draft, setDraft] = useState<string | null>(null)

  const commit = (next: string | null) => {
    if (next !== null && next !== value) onCommit(next)
    setDraft(null)
  }

  return (
    <label className="field">
      <span className="slate">Direction</span>
      <textarea
        className="inspector__direction"
        value={draft ?? value}
        rows={6}
        placeholder="Describe the shot"
        data-testid="node-direction"
        onChange={(event) => setDraft(event.target.value)}
        onBlur={() => commit(draft)}
        onKeyDown={(event) => {
          if (event.key === 'Escape') setDraft(null)
          if (event.key === 'Enter' && (event.metaKey || event.ctrlKey)) event.currentTarget.blur()
        }}
      />
      <span className="hint">
        The card shows the first few lines. ⌘↵ or click away to commit; Esc puts it back.
      </span>
    </label>
  )
}

/** The whole order, with two entries exchanged — `reorderSequence` wants every clip. */
const swap = (clips: { id: string }[], a: number, b: number) => {
  const order = clips.map((clip) => clip.id)
  ;[order[a], order[b]] = [order[b], order[a]]
  return order
}

const perUnit = (cost: ModelRow['cost']) =>
  // Never "$0.00". A row nobody has priced is not a free model, and reading it
  // as one is how a comparison picks the wrong winner.
  cost.amount === null ? 'unpriced' : `${money(cost.amount)}/${cost.unit}`

/** What this model can be asked for, in the terms the wiring rules refuse on. */
const capsLine = (row: ModelRow) =>
  [
    row.caps.refImages > 0 ? `${row.caps.refImages} reference image(s)` : 'no reference images',
    row.caps.startEndFrame ? 'accepts a start frame' : null,
    row.caps.textRendering ? 'renders legible text' : null,
    row.caps.nativeAudio ? 'native audio' : null,
    row.caps.maxDurationSec ? `up to ${row.caps.maxDurationSec}s` : null,
  ]
    .filter(Boolean)
    .join(' · ')

/**
 * The model is the node's, and the price of the choice is on the choice.
 *
 * Listed from the catalog the server sent rather than anything hardcoded here:
 * adding a row to models.json has to be enough to make it selectable, or the
 * file would only be half the source of truth.
 */
function ModelField({
  node,
  models,
  onChange,
}: {
  node: Extract<FlowNode, { modelId: string }>
  models: ModelRow[]
  onChange: (next: FlowNode) => void
}) {
  const format = node.type === 'image' ? 'image' : 'video'
  const rows = models.filter((m) => m.format === format)
  const current = rows.find((m) => m.id === node.modelId)

  return (
    <label className="field">
      <span className="slate">Model</span>
      <select
        value={node.modelId}
        data-testid="node-model"
        onChange={(e) => onChange({ ...node, modelId: e.target.value })}
      >
        {/* A model the catalog no longer has still has to be visible, or the
            select would silently show some other model as this node's. */}
        {!current && <option value={node.modelId}>{node.modelId} — not in the catalog</option>}
        {rows.map((row) => (
          <option key={row.id} value={row.id}>
            {row.id} — {perUnit(row.cost)}
          </option>
        ))}
      </select>
      <span className="hint" data-testid="node-model-caps">
        {!current
          ? 'Add it to models.json, or pick one that is there.'
          : current.cost.amount === null
            ? `No price — fal published none. Set cost.amount in models.json before running it. · ${capsLine(current)}`
            : capsLine(current)}
      </span>
    </label>
  )
}

/**
 * The shape the still is rendered at.
 *
 * Offered only on a row that can be told — `honoursAspect` — because an unknown
 * key is dropped by fal without complaint, so a select that quietly did nothing
 * would look like it had worked and bill for a square frame anyway. The same
 * reason references are gated on `caps.refImages` rather than sent hopefully.
 *
 * Changing it re-prices the card before anything runs: a per-megapixel row
 * bills what it renders, and 9:16 is nearly twice the pixels of 1:1.
 */
function AspectField({
  node,
  onChange,
}: {
  node: Extract<FlowNode, { type: 'image' }>
  onChange: (next: FlowNode) => void
}) {
  return (
    <label className="field">
      <span className="slate">Shape</span>
      <select
        value={node.aspect ?? DEFAULT_ASPECT}
        data-testid="node-aspect"
        onChange={(e) => onChange({ ...node, aspect: e.target.value as Aspect })}
      >
        {ASPECTS.map((aspect) => {
          const { width, height } = pixelsFor(aspect)
          return (
            <option key={aspect} value={aspect}>
              {aspect} — {width}×{height}
            </option>
          )
        })}
      </select>
      <span className="hint">
        A clip is expected to take the shape of the frame it starts from, so this is what decides
        the shape of the film. Unverified on every video row — check the first clip you render.
      </span>
    </label>
  )
}

/**
 * A titled group of fields.
 *
 * The panel was a flat stack: a name, a hint, a duration, a select, a model, a
 * seed and a price, all at the same weight and in one column, so finding the
 * one control you came for meant reading all of them. Four or five short
 * sections with a caption each is the whole fix — a `<section>` with a heading,
 * which is also what makes it navigable to a screen reader.
 */
function Section({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <section className="inspector__section" aria-label={title}>
      <h2 className="slate inspector__section-title">{title}</h2>
      {children}
    </section>
  )
}

/**
 * Re-roll and prompt editing sit side by side but read differently on purpose:
 * re-roll keeps the direction and changes the dice, editing changes the
 * direction. Confusing the two means re-rolling a bad idea forever.
 */
export function Inspector({ node, state, models, clips, onChange, onReorder, onDelete, onReroll }: Props) {
  const seed = 'seed' in node ? node.seed : undefined

  return (
    <aside className="inspector" aria-label={`Inspector for ${node.id}`}>
      <div className="rail__head">
        <span className="slate">{node.type} · {node.id}</span>
        <button className="chip chip--danger" onClick={onDelete} data-testid="delete-node">
          Delete
        </button>
      </div>

      {state?.error && (
        <p className="banner banner--fault" role="status">
          {state.error}
        </p>
      )}

      <Section title="Identity">
        <Field
          label="Name"
          value={node.label ?? ''}
          placeholder={node.id}
          testId="node-label"
          onCommit={(label) => onChange({ ...node, label })}
        />
      </Section>

      {'prompt' in node && (
        <Section title="Direction">
          <Direction
            value={node.prompt}
            onCommit={(prompt) => onChange({ ...node, prompt })}
          />
        </Section>
      )}

      {node.type === 'video' && (
        <Section title="Clip">
          <Field
            label="Duration (seconds)"
            type="number"
            min={1}
            max={60}
            value={String(node.durationSec)}
            testId="node-duration"
            // Clamped here rather than while typing: bounded on the way in used
            // to mean clearing the field snapped it to 1 under the cursor.
            onCommit={(next) =>
              onChange({ ...node, durationSec: Math.min(60, Math.max(1, Number(next) || 1)) })
            }
          />
          <label className="field">
            <span className="slate">Audio</span>
            <select
              value={node.audio ? 'on' : 'off'}
              onChange={(e) => onChange({ ...node, audio: e.target.value === 'on' })}
            >
              <option value="off">Off</option>
              <option value="on">On</option>
            </select>
          </label>
        </Section>
      )}

      {node.type === 'sequence' && (
        // The order is the whole content of this node, so it is the whole
        // inspector. Arrows rather than drag-to-reorder: a list of twelve shots
        // is read, not dragged, and a misdrop here re-cuts the film.
        <Section title="Cut order">
          {(clips ?? []).length === 0 ? (
            <span className="hint">
              Wire clips into this node. They cut together in the order you wire them.
            </span>
          ) : (
            <ol className="cut" data-testid="cut-order">
              {(clips ?? []).map((clip, index) => (
                <li key={clip.id} className="cut__item" data-testid={`cut-${clip.id}`}>
                  <span className="cut__index">{index + 1}</span>
                  <span className="cut__label">{clip.label}</span>
                  <span className="cut__seconds">{clip.seconds}s</span>
                  <button
                    className="workspaces__action"
                    title="Earlier"
                    disabled={index === 0}
                    data-testid={`cut-up-${clip.id}`}
                    onClick={() => onReorder?.(swap(clips ?? [], index, index - 1))}
                  >
                    ▲
                  </button>
                  <button
                    className="workspaces__action"
                    title="Later"
                    disabled={index === (clips ?? []).length - 1}
                    data-testid={`cut-down-${clip.id}`}
                    onClick={() => onReorder?.(swap(clips ?? [], index, index + 1))}
                  >
                    ▼
                  </button>
                </li>
              ))}
            </ol>
          )}
          {(clips ?? []).length > 0 && (
            // The number you are actually working towards. Every video row caps
            // out at eight or ten seconds, so a sixty-second piece is eleven or
            // twelve shots — worth knowing before rendering any of them.
            <span className="cut__total" data-testid="cut-total">
              {(clips ?? []).reduce((total, clip) => total + clip.seconds, 0)}s in{' '}
              {(clips ?? []).length} shot{(clips ?? []).length === 1 ? '' : 's'}
            </span>
          )}
          <span className="hint">
            The cut happens when you run this node, from clips you have already rendered. It costs
            nothing to run.
          </span>
        </Section>
      )}

      {('modelId' in node || 'seed' in node) && (
        <Section title="Model">
          {'modelId' in node && <ModelField node={node} models={models} onChange={onChange} />}

          {node.type === 'image' && honoursAspect(node.modelId) && (
            <AspectField node={node} onChange={onChange} />
          )}

          {'seed' in node && (
            <div className="field">
              <span className="slate">Seed</span>
              <div className="inspector__chips">
                {/* Read before the section's own guard, not inside it: the
                    enclosing `'modelId' in node || 'seed' in node` widens the
                    union again, so TypeScript loses the narrowing by the time
                    this line asks for the value. */}
                <span className="figure inspector__seed">{seed ?? '—'}</span>
                <button className="chip" onClick={onReroll} data-testid="reroll">
                  ↻ Re-roll
                </button>
              </div>
              <span className="hint">
                Re-roll keeps the direction and changes the dice. Edit the direction above to change
                intent.
              </span>
            </div>
          )}
        </Section>
      )}

      {/*
        The bill, as a figure rather than a sentence.

        It was one line of `.hint` at the bottom of a flat stack — the same
        weight as "Formats come from project settings", for the number this
        whole tool exists to show you before you commit to it.
      */}
      {state && (
        <div className="inspector__bill" data-status={state.status}>
          <span className="slate">{state.status === 'succeeded' ? 'Rendered for' : 'To render'}</span>
          <span className="inspector__figure">
            {money(state.status === 'succeeded' ? state.costCents : state.estimatedCents)}
          </span>
          {state.modelId && <span className="hint">on {state.modelId}</span>}
        </div>
      )}
    </aside>
  )
}
