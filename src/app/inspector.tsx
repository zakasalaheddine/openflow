'use client'

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

      <label className="field">
        <span className="slate">Name</span>
        <input
          value={node.label ?? ''}
          placeholder={node.id}
          data-testid="node-label"
          onChange={(e) => onChange({ ...node, label: e.target.value })}
        />
      </label>

      <p className="hint">Double-click the prompt on the card to edit the direction.</p>


      {node.type === 'video' && (
        <>
          <label className="field">
            <span className="slate">Duration (seconds)</span>
            <input
              type="number"
              min={1}
              max={60}
              value={node.durationSec}
              data-testid="node-duration"
              onChange={(e) => onChange({ ...node, durationSec: Number(e.target.value) || 1 })}
            />
          </label>
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
          <label className="field">
            <span className="slate">Headline</span>
            <input
              value={node.overlay?.headline ?? ''}
              data-testid="overlay-headline"
              onChange={(e) =>
                onChange({ ...node, overlay: { ...node.overlay, headline: e.target.value } })
              }
            />
          </label>
          <label className="field">
            <span className="slate">Call to action</span>
            <input
              value={node.overlay?.cta ?? ''}
              data-testid="overlay-cta"
              onChange={(e) => onChange({ ...node, overlay: { ...node.overlay, cta: e.target.value } })}
            />
          </label>
          <label className="field">
            <span className="slate">Text position (top edge, % of frame)</span>
            <input
              type="number"
              min={0}
              max={100}
              value={Math.round((node.overlay?.box ?? DEFAULT_TEXT_BOX).y * 100)}
              data-testid="overlay-y"
              onChange={(e) =>
                onChange({
                  ...node,
                  overlay: {
                    ...node.overlay,
                    box: { ...(node.overlay?.box ?? DEFAULT_TEXT_BOX), y: Number(e.target.value) / 100 },
                  },
                })
              }
            />
          </label>
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
