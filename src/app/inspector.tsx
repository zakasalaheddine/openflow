'use client'

import { useState } from 'react'
import type { FlowNode, ModelRole } from '@/core/types'
import { DEFAULT_TEXT_BOX } from '@/core/spec'
import { money, type NodeState } from './state'

type Props = {
  node: FlowNode
  state: NodeState | undefined
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

/**
 * Re-roll and prompt editing sit side by side but read differently on purpose:
 * re-roll keeps the direction and changes the dice, editing changes the
 * direction. Confusing the two means re-rolling a bad idea forever.
 */
export function Inspector({ node, state, onChange, onDelete, onReroll }: Props) {

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

      {'modelRole' in node && (
        <label className="field">
          <span className="slate">Model role</span>
          <select
            value={node.modelRole}
            data-testid="node-role"
            onChange={(e) => onChange({ ...node, modelRole: e.target.value as ModelRole })}
          >
            <option value="draft">Draft</option>
            <option value="hero">Hero</option>
            <option value="specialist">Specialist</option>
          </select>
        </label>
      )}

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
