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

  useEffect(() => {
    if (!open) return
    let cancelled = false
    previewDownload(flow, body)
      .then((next) => {
        if (cancelled) return
        setPreview(next)
        setChosen(new Set(next.formats.filter((f) => passes(next, f.name)).map((f) => f.name)))
        setNodes(new Set(next.verdicts.map((v) => v.nodeId)))
      })
      .catch(() => onError('Could not check what can ship'))
    return () => {
      cancelled = true
    }
  }, [open, flow, nodeId, hasText, boxY])

  const download = async () => {
    setBusy(true)
    try {
      await runDownload(flow, {
        ...body,
        ...(nodeId ? {} : { nodeIds: [...nodes] }),
        formats: preview?.formats.filter((f) => chosen.has(f.name)),
      })
      onClose()
    } catch (error) {
      onError(error instanceof Error ? error.message : 'Download failed')
    } finally {
      setBusy(false)
    }
  }

  return (
    <Dialog open={open} onOpenChange={(next) => !next && onClose()}>
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

        <fieldset className="download__group">
          <legend className="slate">Placements</legend>
          {preview?.formats.map((format) => {
            const failing = preview.verdicts.filter((v) => v.format === format.name && !v.pass)
            return (
              <div className="download__row" key={format.name}>
                <label>
                  <input
                    type="checkbox"
                    data-testid={`download-format-${format.name}`}
                    disabled={failing.length > 0}
                    checked={chosen.has(format.name)}
                    onChange={(event) => setChosen(toggle(chosen, format.name, event.target.checked))}
                  />
                  <span>
                    {format.name} · {format.w}×{format.h}
                  </span>
                </label>
                {/* The reason, next to the thing it refuses. A refusal you have
                    to go looking for is a bug report from the client later. */}
                {failing.map((verdict) => (
                  <p className="download__reason" key={verdict.nodeId}>
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
          <button className="chip" onClick={onClose}>
            Cancel
          </button>
          <button
            className="run"
            data-testid="download-confirm"
            disabled={busy || chosen.size === 0}
            onClick={() => void download()}
          >
            Download
          </button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}

const passes = (preview: DownloadPreview, format: string) =>
  preview.verdicts.filter((v) => v.format === format).every((v) => v.pass)

const toggle = (set: Set<string>, key: string, on: boolean) => {
  const next = new Set(set)
  if (on) next.add(key)
  else next.delete(key)
  return next
}
