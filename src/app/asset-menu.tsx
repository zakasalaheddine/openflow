'use client'

import { useEffect, useRef, useState } from 'react'
import { FileUpIcon, PaperclipIcon, PencilLineIcon } from 'lucide-react'
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from '@/ui/dropdown-menu'
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/ui/dialog'
import { Hint } from '@/ui/hint'
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
 * Radix now owns the menu. The hand-rolled version worked, including the one
 * genuinely hard part (a capture-phase outside-click listener, because React
 * Flow stops propagation on the pane and a bubbling listener never hears a
 * click on the canvas) — but not the roving tabindex, the typeahead, or the
 * focus return. Radix's dismissable layer listens in the capture phase too, so
 * the canvas-click case it was written for still closes it.
 *
 * Writing a note is a dialog rather than a panel that replaces the menu's
 * contents. A textarea inside a menu fights everything a menu does: arrow keys
 * move between items, letters trigger typeahead, and focus is managed away from
 * whatever you are typing in.
 */
export function AssetMenu({ sources, onUpload, onNote, onPick }: Props) {
  // Controlled, because the file input lives outside the menu and closing on a
  // chosen file is not something the menu can see: picking a file dismisses the
  // OS dialog, not the menu, and it stayed open behind it.
  const [open, setOpen] = useState(false)
  const [note, setNote] = useState<string | null>(null)
  const fileRef = useRef<HTMLInputElement>(null)
  const noteRef = useRef<HTMLTextAreaElement>(null)

  useEffect(() => {
    if (note !== null) noteRef.current?.focus()
  }, [note])

  const commitNote = () => {
    const text = (note ?? '').trim()
    setNote(null)
    // An empty note is refused by the API, so it is not sent. Nothing is
    // created, and nothing on the canvas has to be cleaned up afterwards.
    if (text) onNote(text)
  }

  return (
    <div className="assets">
      {/*
        `modal={false}`: a modal menu puts `pointer-events: none` on the body
        for as long as it is open, which would freeze the canvas behind it — and
        this menu opens over a canvas whose whole job is being dragged on. The
        old hand-rolled menu never blocked the page either.
      */}
      <DropdownMenu open={open} onOpenChange={setOpen} modal={false}>
        <Hint label="Put a product photo, a clip or a note on the canvas">
          <DropdownMenuTrigger asChild>
            <button className="chip" data-testid="add-asset">
              <PaperclipIcon aria-hidden="true" />
              {/* Same `.chip__label` as the rest of the add group, so it drops
                  to an icon at the same width they do. */}
              <span className="chip__label">asset</span>
            </button>
          </DropdownMenuTrigger>
        </Hint>

        {/*
          Tailwind, not a `.assets__menu` rule. The hand-written layer in
          globals.css is unlayered and outranks every utility, so a class here
          carrying `position: absolute; top: calc(100% + 8px)` — which is what
          this menu used to need — would fight Radix's own positioning and win.
          Sizing only; the surface, radius and elevation come from the primitive.
        */}
        <DropdownMenuContent
          align="start"
          className="max-h-[60vh] w-64 overflow-y-auto shadow-e2"
          data-testid="asset-menu"
        >
          <DropdownMenuItem
            data-testid="asset-upload"
            onSelect={() => {
              // Deferred past the menu's own close, which returns focus to the
              // trigger. A file dialog opened inside that same tick loses the
              // click that opened it on Safari.
              setTimeout(() => fileRef.current?.click(), 0)
            }}
          >
            <FileUpIcon aria-hidden="true" />
            Upload a file…
          </DropdownMenuItem>
          <DropdownMenuItem data-testid="asset-note" onSelect={() => setNote('')}>
            <PencilLineIcon aria-hidden="true" />
            Write a note…
          </DropdownMenuItem>

          {/* Already uploaded, and otherwise unreachable: deleting a source node
              leaves the row behind, and a second flow has no way to reference
              the product the first one uploaded. */}
          {sources.length > 0 && (
            <>
              <DropdownMenuSeparator />
              <DropdownMenuLabel>On this project</DropdownMenuLabel>
              {sources.map((source) => (
                <DropdownMenuItem
                  key={source.id}
                  className="font-mono text-[11px]"
                  data-testid={`asset-pick-${source.id}`}
                  onSelect={() => onPick(source.id)}
                >
                  <span className="assets__glyph" aria-hidden="true">
                    {GLYPH[source.kind]}
                  </span>
                  <span className="assets__label">{labelFor(source)}</span>
                  <span className="assets__version">v{source.version}</span>
                </DropdownMenuItem>
              ))}
            </>
          )}
        </DropdownMenuContent>
      </DropdownMenu>

      <Dialog open={note !== null} onOpenChange={(open) => !open && setNote(null)}>
        <DialogContent aria-label="Write a note">
          <DialogHeader>
            <DialogTitle>Write a note</DialogTitle>
            <DialogDescription>
              A fragment of brand voice or direction. Wire it into a shot and it composes ahead of
              that shot&rsquo;s prompt.
            </DialogDescription>
          </DialogHeader>
          <label className="field">
            <span className="slate">Note</span>
            <textarea
              ref={noteRef}
              value={note ?? ''}
              rows={4}
              placeholder="warm, unfussy, no hard sell"
              data-testid="asset-note-input"
              onChange={(event) => setNote(event.target.value)}
              onKeyDown={(event) => {
                if (event.key === 'Enter' && (event.metaKey || event.ctrlKey)) commitNote()
              }}
            />
          </label>
          <DialogFooter>
            <button className="chip" onClick={() => setNote(null)}>
              Cancel
            </button>
            <button className="run" data-testid="asset-note-save" onClick={commitNote}>
              Add note
            </button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* Outside the menu on purpose: the menu unmounts when an item is chosen,
          and an input that unmounts with it has no change event left to fire. */}
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
          setOpen(false)
          if (files.length > 0) onUpload(files)
        }}
      />
    </div>
  )
}
