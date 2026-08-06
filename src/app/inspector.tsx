'use client'

import { useState } from 'react'
import type { FlowNode } from '@/core/types'
import { DEFAULT_TEXT_BOX } from '@/core/spec'
import { money, type ModelRow, type NodeState } from './state'

type Props = {
  node: FlowNode
  state: NodeState | undefined
  models: ModelRow[]
  onChange: (next: FlowNode) => void
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

const perUnit = (cost: ModelRow['cost']) => `${money(cost.amount)}/${cost.unit}`

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
        {current ? capsLine(current) : 'Add it to models.json, or pick one that is there.'}
      </span>
    </label>
  )
}

/**
 * Re-roll and prompt editing sit side by side but read differently on purpose:
 * re-roll keeps the direction and changes the dice, editing changes the
 * direction. Confusing the two means re-rolling a bad idea forever.
 */
export function Inspector({ node, state, models, onChange, onDelete, onReroll }: Props) {

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

      <Field
        label="Name"
        value={node.label ?? ''}
        placeholder={node.id}
        testId="node-label"
        onCommit={(label) => onChange({ ...node, label })}
      />

      <p className="hint">Double-click the prompt on the card to edit the direction.</p>


      {node.type === 'video' && (
        <>
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
        </>
      )}

      {node.type === 'export' && (
        <>
          {/* Placed here, not asked of the model: a declared box is what makes
              the safe-zone check arithmetic instead of OCR. */}
          <Field
            label="Headline"
            value={node.overlay?.headline ?? ''}
            testId="overlay-headline"
            onCommit={(headline) => onChange({ ...node, overlay: { ...node.overlay, headline } })}
          />
          <Field
            label="Call to action"
            value={node.overlay?.cta ?? ''}
            testId="overlay-cta"
            onCommit={(cta) => onChange({ ...node, overlay: { ...node.overlay, cta } })}
          />
          <Field
            label="Text position (top edge, % of frame)"
            type="number"
            min={0}
            max={100}
            value={String(Math.round((node.overlay?.box ?? DEFAULT_TEXT_BOX).y * 100))}
            testId="overlay-y"
            onCommit={(next) =>
              onChange({
                ...node,
                overlay: {
                  ...node.overlay,
                  box: {
                    ...(node.overlay?.box ?? DEFAULT_TEXT_BOX),
                    // A fraction of the frame, so it cannot leave the frame.
                    y: Math.min(100, Math.max(0, Number(next) || 0)) / 100,
                  },
                },
              })
            }
          />
          <span className="hint">
            Formats come from project settings unless this node names its own.
          </span>
        </>
      )}

      {'modelId' in node && <ModelField node={node} models={models} onChange={onChange} />}

      {'seed' in node && (
        <div className="field">
          <span className="slate">Seed</span>
          <div className="inspector__chips">
            <span className="figure" style={{ fontSize: 12, alignSelf: 'center' }}>
              {node.seed ?? '—'}
            </span>
            <button className="chip" onClick={onReroll} data-testid="reroll">
              ↻ Re-roll
            </button>
          </div>
          <span className="hint">
            Re-roll keeps the direction and changes the dice. Edit the direction above to change intent.
          </span>
        </div>
      )}

      {state && (
        <p className="hint">
          {state.status === 'succeeded'
            ? `Rendered for ${money(state.costCents)}${state.modelId ? ` on ${state.modelId}` : ''}.`
            : `${money(state.estimatedCents)} to render${state.modelId ? ` on ${state.modelId}` : ''}.`}
        </p>
      )}
    </aside>
  )
}
