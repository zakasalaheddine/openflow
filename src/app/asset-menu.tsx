'use client'

import { useEffect, useRef, useState } from 'react'
import type { SourceRow } from './state'

/**
 * Mirrors ALLOWED_MIME in `src/core/upload.ts`, which cannot be imported here —
 * it pulls in the store, and the store reads the filesystem.
 *
 * A hint, not a check. Every platform lets you defeat a file dialog's filter,
 * so the server refuses anything outside the allow-list at the boundary and
 * keeps doing so.
 */
const ACCEPT = '.png,.jpg,.jpeg,.webp,.mp4,.webm,.mov,.txt'

/**
 * Enough to tell two product shots apart, without building a thumbnail grid —
 * which is the rail the original design refused.
 *
 * `notes` holds the name of the file that was uploaded. The store key cannot:
 * it is a generated UUID, on purpose, because a path built from an
 * attacker-controlled name escapes the store root. Assets uploaded before that
 * column was written fall back to the key, and read as gibberish; they are
 * still pickable, and one Replace gives them a name.
 */
function labelFor(source: SourceRow) {
  if (source.kind === 'text') {
    const line = (source.text ?? '').split('\n')[0].trim()
    return line.length > 34 ? `${line.slice(0, 34)}…` : line || 'empty note'
  }
  const name = source.notes ?? (source.files[0] ?? '').split('/').pop() ?? source.id
  return name.length > 26 ? `…${name.slice(-25)}` : name
}

const GLYPH = { image: '▣', video: '▶', text: '¶' } as const

type Props = {
  sources: SourceRow[]
  onUpload: (files: File[]) => void
  onNote: (text: string) => void
  onPick: (sourceId: string) => void
}

/**
 * Everything that puts an asset on the canvas, in one place.
 *
 * Until this existed the only way in was dropping a file — a good gesture, and
 * the only one, which made a text source reachable solely by dragging selected
 * text out of another application. Nothing on screen said so.
 *
 * A plain dropdown rather than `popover`: light dismiss and the top layer come
 * free with it, but positioning does not — anchoring to a toolbar chip without
 * CSS anchor positioning means measuring the chip in JS, which is more code
 * than the two handlers below and lands on a feature Safari and Firefox do not
 * have yet.
 */
export function AssetMenu({ sources, onUpload, onNote, onPick }: Props) {
  const [open, setOpen] = useState(false)
  const [note, setNote] = useState<string | null>(null)
  const fileRef = useRef<HTMLInputElement>(null)
  const wrapRef = useRef<HTMLDivElement>(null)
  const noteRef = useRef<HTMLTextAreaElement>(null)

  const close = () => {
    setOpen(false)
    setNote(null)
  }

  useEffect(() => {
    if (!open) return
    const onKey = (event: KeyboardEvent) => {
      if (event.key === 'Escape') close()
    }
    const onDown = (event: MouseEvent) => {
      if (!wrapRef.current?.contains(event.target as Node)) close()
    }
    window.addEventListener('keydown', onKey)
    // Capture: React Flow stops propagation on the pane, so a bubbling listener
    // never hears a click on the canvas — the menu would stay open behind it.
    window.addEventListener('mousedown', onDown, true)
    return () => {
      window.removeEventListener('keydown', onKey)
      window.removeEventListener('mousedown', onDown, true)
    }
  }, [open])

  useEffect(() => {
    if (note !== null) noteRef.current?.focus()
  }, [note])

  const commitNote = () => {
    const text = (note ?? '').trim()
    close()
    // An empty note is refused by the API, so it is not sent. Nothing is
    // created, and nothing on the canvas has to be cleaned up afterwards.
    if (text) onNote(text)
  }

  return (
    <div className="assets" ref={wrapRef}>
      <button
        className="chip"
        aria-expanded={open}
        aria-haspopup="menu"
        data-testid="add-asset"
        onClick={() => (open ? close() : setOpen(true))}
      >
        + asset
      </button>

      {open && (
        <div className="assets__menu" role="menu" data-testid="asset-menu">
          {note === null ? (
            <>
              <button
                className="assets__item"
                role="menuitem"
                data-testid="asset-upload"
                onClick={() => fileRef.current?.click()}
              >
                Upload a file…
              </button>
              <button
                className="assets__item"
                role="menuitem"
                data-testid="asset-note"
                onClick={() => setNote('')}
              >
                Write a note…
              </button>

              {sources.length > 0 && <hr className="assets__rule" />}

              {/* Already uploaded, and otherwise unreachable: deleting a source
                  node leaves the row behind, and a second flow has no way to
                  reference the product the first one uploaded. */}
              {sources.map((source) => (
                <button
                  key={source.id}
                  className="assets__item assets__item--source"
                  role="menuitem"
                  data-testid={`asset-pick-${source.id}`}
                  onClick={() => {
                    close()
                    onPick(source.id)
                  }}
                >
                  <span className="assets__glyph" aria-hidden="true">
                    {GLYPH[source.kind]}
                  </span>
                  <span className="assets__label">{labelFor(source)}</span>
                  <span className="assets__version">v{source.version}</span>
                </button>
              ))}
            </>
          ) : (
            <div className="assets__note">
              <textarea
                ref={noteRef}
                value={note}
                rows={3}
                placeholder="warm, unfussy, no hard sell"
                data-testid="asset-note-input"
                onChange={(event) => setNote(event.target.value)}
                onKeyDown={(event) => {
                  if (event.key === 'Escape') close()
                  if (event.key === 'Enter' && (event.metaKey || event.ctrlKey)) commitNote()
                }}
              />
              <button className="chip" data-testid="asset-note-save" onClick={commitNote}>
                Add note
              </button>
            </div>
          )}
        </div>
      )}

      <input
        ref={fileRef}
        type="file"
        hidden
        multiple
        accept={ACCEPT}
        data-testid="asset-input"
        onChange={(event) => {
          const files = Array.from(event.target.files ?? [])
          // Cleared so choosing the same file twice in a row fires again.
          event.target.value = ''
          close()
          if (files.length > 0) onUpload(files)
        }}
      />
    </div>
  )
}
