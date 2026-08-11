'use client'

import { useEffect, useState } from 'react'
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/ui/dialog'
import { previewDownload, runDownload, type DownloadPreview } from './state'
import { DEFAULT_TEXT_BOX } from '@/core/spec'
import type { TextOverlay } from '@/core/types'

type Props = {
  flow: string
  /** One node, or null for the whole flow. */
  nodeId: string | null
  open: boolean
  onClose: () => void
  onError: (message: string) => void
}

/**
 * Where formats and the overlay live now.
 *
 * They used to be fields on an export node, which meant deciding at wiring time
 * what a deliverable would look like and leaving a node on the canvas to
 * remember it. They are the shape of one action instead: what you want, in what
 * placements, right now.
 *
 * The verdict is the server's. `checkSpec` measures the file, and a client that
 * guessed from the row would be checking our own optimism.
 */
export function DownloadDialog({ flow, nodeId, open, onClose, onError }: Props) {
  const [preview, setPreview] = useState<DownloadPreview | null>(null)
  const [chosen, setChosen] = useState<Set<string>>(new Set())
  const [nodes, setNodes] = useState<Set<string>>(new Set())
  const [overlay, setOverlay] = useState<TextOverlay>({})
  const [busy, setBusy] = useState(false)

  const body = {
    ...(nodeId ? { nodeIds: [nodeId] } : {}),
    ...(overlay.headline || overlay.cta ? { overlay } : {}),
  }

  // Re-asked when the overlay goes from empty to non-empty, or when the box
  // moves: those are the only things `boxOf` reads to build the text box this
  // gets checked against, so they are the only things the verdict can turn on.
  // A keystroke in the headline or CTA text itself changes nothing the spec
  // check measures — position and size, never the words — so it is not a dep.
  const hasText = Boolean(overlay.headline?.trim() || overlay.cta?.trim())
  const boxY = overlay.box?.y

  /**
   * What actually ships, not what was last ticked.
   *
   * `chosen` only reconciles against a fresh verdict on a refetch — moving
   * the box, adding text — and toggling a node checkbox is neither: it never
   * refetches (see the effect below) and never touches `chosen` either. Tick
   * a placement, untick the node that was the only thing failing it, and
   * `chosen` still says yes even though the checkbox itself would now render
   * unchecked-and-enabled. Re-tick that node and `chosen` still says yes,
   * but the checkbox is disabled — checked and disabled at once, which is
   * exactly the "refusal, but overridable" shape this dialog exists to
   * refuse. Deriving the effective pick fresh on every render, from `chosen`
   * intersected with whatever currently passes for the ticked nodes, closes
   * that: a format cannot be selected while it is refused, on any path that
   * gets here, without giving up "re-ticking a node returns your pick."
   */
  const passingNow = preview ? passingFormats(preview, nodes) : new Set<string>()
  const willShip = intersect(chosen, passingNow)

  useEffect(() => {
    if (!open) return
    let cancelled = false
    // Captured before the request goes out: whether this is the dialog's
    // first answer for this open, or a refetch of one already showing.
    const first = preview === null
    previewDownload(flow, body)
      .then((next) => {
        if (cancelled) return
        const allNow = new Set(next.verdicts.map((v) => v.nodeId))
        // What ships next tick, so "passing" below can be scoped to it rather
        // than to every node in the flow — the same scope the checkboxes
        // themselves use to decide `disabled`.
        const nextNodes = first ? allNow : intersect(nodes, allNow)
        const passingNext = passingFormats(next, nextNodes)

        setPreview(next)
        setNodes(nextNodes)
        // First answer: tick everything that fills — the useful default
        // nobody wants to click through by hand. A refetch (moving the box,
        // adding text) instead keeps what the person picked, only dropping a
        // tick that just became refused: typing a headline must not silently
        // re-tick a format someone unticked on purpose.
        setChosen((prev) => (first ? passingNext : intersect(prev, passingNext)))
      })
      .catch(() => onError('Could not check what can ship'))
    return () => {
      cancelled = true
    }
  }, [open, flow, nodeId, hasText, boxY])

  // A close carries nothing forward: without this, a headline typed for one
  // node's dialog would still be sitting in the field the next time any
  // dialog opens, and the "preserve picks across a refetch" logic above would
  // filter a brand new node's answer through a previous node's ticks. An
  // event handler, not an effect keyed on `open` going false — resetting
  // state from an effect body fires a second, avoidable render.
  const closeAndReset = () => {
    setPreview(null)
    setChosen(new Set())
    setNodes(new Set())
    setOverlay({})
    onClose()
  }

  const download = async () => {
    setBusy(true)
    try {
      await runDownload(flow, {
        ...body,
        ...(nodeId ? {} : { nodeIds: [...nodes] }),
        formats: preview?.formats.filter((f) => willShip.has(f.name)),
      })
      closeAndReset()
    } catch (error) {
      onError(error instanceof Error ? error.message : 'Download failed')
    } finally {
      setBusy(false)
    }
  }

  return (
    <Dialog open={open} onOpenChange={(next) => !next && closeAndReset()}>
      <DialogContent data-testid="download-dialog">
        <DialogHeader>
          <DialogTitle>{nodeId ? `Download ${nodeId}` : 'Download this flow'}</DialogTitle>
          <DialogDescription>
            Cropped to each placement and checked against it. A placement the render cannot fill is
            refused here rather than by whoever you send it to.
          </DialogDescription>
        </DialogHeader>

        {nodeId === null && preview && (
          <fieldset className="download__group">
            <legend className="slate">What ships</legend>
            {[...new Set(preview.verdicts.map((v) => v.nodeId))].map((id) => (
              <label className="download__row" key={id}>
                <input
                  type="checkbox"
                  data-testid={`download-node-${id}`}
                  checked={nodes.has(id)}
                  onChange={(event) => setNodes(toggle(nodes, id, event.target.checked))}
                />
                <span>{id}</span>
              </label>
            ))}
            {preview.stale.length > 0 && (
              <p className="download__reason">
                Not yet rendered, so not listed: {preview.stale.join(', ')}
              </p>
            )}
          </fieldset>
        )}

        {nodeId !== null && preview && preview.stale.includes(nodeId) && (
          <p className="download__reason" data-testid="download-not-rendered">
            Not yet rendered, so nothing to ship.
          </p>
        )}

        <fieldset className="download__group">
          <legend className="slate">Placements</legend>
          {preview?.formats.map((format) => {
            // Scoped to the nodes actually ticked: a node you have already
            // dropped from "What ships" cannot be the reason a placement stays
            // refused. Without this, one failing node — anywhere in the flow,
            // ticked or not — disabled that placement for everyone, and
            // unticking the offender could never clear it.
            const failing = preview.verdicts.filter(
              (v) => v.format === format.name && !v.pass && nodes.has(v.nodeId),
            )
            return (
              <div className="download__row" key={format.name}>
                <label>
                  <input
                    type="checkbox"
                    data-testid={`download-format-${format.name}`}
                    disabled={failing.length > 0}
                    // The effective pick, not the raw one: a format cannot
                    // render checked while it is also disabled, on any path
                    // that reaches this row. `onChange` still writes `chosen`
                    // itself — the person's actual pick — so re-ticking the
                    // node that was the only thing refusing it hands the
                    // selection back rather than losing it.
                    checked={willShip.has(format.name)}
                    onChange={(event) => setChosen(toggle(chosen, format.name, event.target.checked))}
                  />
                  <span>
                    {format.name} · {format.w}×{format.h}
                  </span>
                </label>
                {/* The reason, next to the thing it refuses. A refusal you have
                    to go looking for is a bug report from the client later.
                    Named by node in the whole-flow dialog: "top safe zone" is
                    not actionable when it could be any of a dozen cards. */}
                {failing.map((verdict, i) => (
                  <p className="download__reason" key={`${verdict.nodeId}-${i}`}>
                    {nodeId === null ? `${verdict.nodeId}: ` : ''}
                    {verdict.reasons.join(' ')}
                  </p>
                ))}
              </div>
            )
          })}
        </fieldset>

        <label className="field">
          <span className="slate">Headline</span>
          <input
            data-testid="download-headline"
            value={overlay.headline ?? ''}
            onChange={(event) => setOverlay({ ...overlay, headline: event.target.value })}
          />
        </label>
        <label className="field">
          <span className="slate">Call to action</span>
          <input
            data-testid="download-cta"
            value={overlay.cta ?? ''}
            onChange={(event) => setOverlay({ ...overlay, cta: event.target.value })}
          />
        </label>
        {/*
          Not in the original brief's control list: without it, this dialog has
          no state in which any placement can ever fail — `DEFAULT_TEXT_BOX`
          passes every default format's safe zone (see the unit test of the
          same name), so a headline alone never disables anything. The
          disable-plus-reason path is the whole product rule this dialog
          carries, and it would ship unreachable without a way to move the box.
          Same idiom as the export node's old "Text position" field in the
          inspector: a top-edge percentage, `x`/`w`/`h` left at the default.
        */}
        <label className="field">
          <span className="slate">Text position (top edge, % of frame)</span>
          <input
            type="number"
            min={0}
            max={100}
            data-testid="download-box-y"
            value={Math.round((overlay.box ?? DEFAULT_TEXT_BOX).y * 100)}
            onChange={(event) =>
              setOverlay({
                ...overlay,
                box: {
                  ...(overlay.box ?? DEFAULT_TEXT_BOX),
                  y: Math.min(100, Math.max(0, Number(event.target.value) || 0)) / 100,
                },
              })
            }
          />
        </label>

        <DialogFooter>
          <button className="chip" onClick={closeAndReset}>
            Cancel
          </button>
          <button
            className="run"
            data-testid="download-confirm"
            // `willShip` empty is "nothing to ship" — the effective pick, not
            // the raw one, or a placement re-disabled by a re-ticked node
            // could still submit on a stale `chosen`. In the whole-flow
            // dialog, `nodes` empty is the same fact one level up: every node
            // unticked, so a chosen format has nothing left to check it
            // against. Without that second guard, unticking every node left
            // the button live and produced a bare 422 on click.
            disabled={busy || willShip.size === 0 || (nodeId === null && nodes.size === 0)}
            onClick={() => void download()}
          >
            Download
          </button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}

/**
 * Every format that fills for every node in `nodeIds` — the ticked scope, not the whole flow.
 *
 * A format with no verdict in scope does not pass: `[].every()` is `true`, so
 * without the length check a ticked scope with nothing rendered yet — the
 * per-card dialog before its node has a frame — would count every format as
 * passing and enable Download on nothing to ship.
 */
export const passingFormats = (preview: DownloadPreview, nodeIds: Set<string>) =>
  new Set(
    preview.formats
      .filter((f) => {
        const scoped = preview.verdicts.filter((v) => v.format === f.name && nodeIds.has(v.nodeId))
        return scoped.length > 0 && scoped.every((v) => v.pass)
      })
      .map((f) => f.name),
  )

const toggle = (set: Set<string>, key: string, on: boolean) => {
  const next = new Set(set)
  if (on) next.add(key)
  else next.delete(key)
  return next
}

/** What of `a` is still in `b` — how a refetch keeps a pick without reviving one that has expired. */
const intersect = (a: Set<string>, b: Set<string>) => new Set([...a].filter((x) => b.has(x)))
