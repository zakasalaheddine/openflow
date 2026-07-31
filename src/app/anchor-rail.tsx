'use client'

import { useState } from 'react'
import { money, type AnchorRow } from './state'

type Props = {
  anchors: AnchorRow[]
  attachedIds: string[]
  onToggle: (anchorId: string) => void
  onRefresh: () => void
}

/**
 * The left rail is the *client*: what stays true across every campaign. It
 * persists while flows come and go, which is why anchors live here rather than
 * on the canvas.
 */
export function AnchorRail({ anchors, attachedIds, onToggle, onRefresh }: Props) {
  const [busy, setBusy] = useState(false)
  const [pending, setPending] = useState<{ id: string; nodeCount: number; flowCount: number; estimatedCents: number } | null>(null)

  async function addAnchor() {
    setBusy(true)
    await fetch('/api/anchors', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        kind: `Product ${anchors.length + 1}`,
        refImages: ['reference.jpg'],
      }),
    })
    setBusy(false)
    onRefresh()
  }

  /** Price the blast radius before committing. Bumping can invalidate two campaigns. */
  async function previewBump(id: string) {
    const response = await fetch('/api/anchors', {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ id, preview: true }),
    })
    const body = await response.json()
    setPending({ id, ...body.preview })
  }

  async function confirmBump(id: string) {
    setPending(null)
    await fetch('/api/anchors', {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ id }),
    })
    onRefresh()
  }

  return (
    <nav className="rail" aria-label="Anchors">
      <div className="rail__head">
        <span className="slate">Anchors</span>
        <button className="chip" onClick={addAnchor} disabled={busy} data-testid="add-anchor">
          + Add
        </button>
      </div>

      {anchors.length === 0 && (
        <p className="hint">
          An anchor is the product itself. Add one, attach it to a shot, and it stays identical across
          every frame.
        </p>
      )}

      {anchors.map((anchor) => (
        <article
          key={anchor.id}
          className="anchor"
          data-attached={attachedIds.includes(anchor.id)}
          data-testid={`anchor-${anchor.id}`}
        >
          <div className="anchor__row">
            <span className="anchor__name">{anchor.kind}</span>
            <span className="slate" data-testid={`anchor-version-${anchor.id}`}>
              v{anchor.version}
            </span>
          </div>

          <div className="anchor__refs">
            {anchor.refImages.slice(0, 4).map((ref, index) => (
              <span className="anchor__ref" key={`${ref}-${index}`} title={ref}>
                {index + 1}
              </span>
            ))}
          </div>

          <div className="anchor__actions">
            <button
              className="chip"
              aria-pressed={attachedIds.includes(anchor.id)}
              onClick={() => onToggle(anchor.id)}
              data-testid={`rail-chip-${anchor.id}`}
            >
              Attach
            </button>
            <button
              className="chip chip--danger"
              onClick={() => previewBump(anchor.id)}
              data-testid={`bump-${anchor.id}`}
            >
              New photos
            </button>
          </div>

          {pending?.id === anchor.id && (
            <div className="banner" role="alertdialog" aria-label="Confirm new photos">
              {/* Never silently re-run. At hero video prices this is real money. */}
              <p>
                {pending.nodeCount} {pending.nodeCount === 1 ? 'shot' : 'shots'} across {pending.flowCount}{' '}
                {pending.flowCount === 1 ? 'flow' : 'flows'} go stale · {money(pending.estimatedCents)} to refresh.
              </p>
              <div className="anchor__actions">
                <button className="chip" onClick={() => confirmBump(anchor.id)} data-testid={`confirm-bump-${anchor.id}`}>
                  Bump to v{anchor.version + 1}
                </button>
                <button className="chip" onClick={() => setPending(null)}>
                  Cancel
                </button>
              </div>
            </div>
          )}
        </article>
      ))}
    </nav>
  )
}
