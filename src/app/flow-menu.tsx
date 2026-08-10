'use client'

import { useEffect, useRef, useState } from 'react'
import { useRouter } from 'next/navigation'
import { ChevronDownIcon, ClapperboardIcon, PencilLineIcon, PlusIcon, Trash2Icon } from 'lucide-react'
import { Popover, PopoverContent, PopoverTrigger } from '@/ui/popover'
import { Hint } from '@/ui/hint'
import {
  fetchWorkspaces,
  createWorkspace,
  renameWorkspace,
  deleteWorkspace,
  type WorkspaceRow,
} from './state'

type Props = {
  /** The slug in the URL, so the open workspace can be marked and never deleted from under itself. */
  current: string
  onError: (message: string) => void
}

/**
 * The workspace switcher.
 *
 * Every entry is a link, not a click handler that swaps state: a workspace is a
 * URL, which is the whole point — two builds open in two tabs of one session.
 *
 * Rename and delete are inline rather than `prompt()`/`confirm()`. A native
 * dialog blocks the event loop, which stalls the canvas's 1200ms poll and the
 * save queue behind it, and the browser suites cannot click through one.
 *
 * A Radix popover rather than a dropdown menu, and a portalled one rather than
 * the `position: absolute` panel this used to be. Two separate reasons, both
 * load-bearing:
 *
 * - **Portalled**, because `.topbar` carries `overflow-x: auto` for the
 *   sideways scroll at narrow widths, and an `overflow-x` that is not `visible`
 *   computes `overflow-y` to `auto` as well. The bar is a fixed 52px row, so an
 *   absolutely positioned panel opening below the chip was clipped to a 6px
 *   sliver of its own top border. The menu opened; nothing appeared. The e2e
 *   spec passed throughout, because Playwright scrolls a clipped element into
 *   view before clicking it and a human cannot.
 * - **Popover, not menu**, because this holds a rename input and a
 *   delete-confirm row. A menu's roving tabindex and typeahead would eat the
 *   keystrokes meant for the field — the same reason `asset-menu.tsx` puts its
 *   note behind a dialog instead of inside the menu.
 */
export function FlowMenu({ current, onError }: Props) {
  const router = useRouter()
  const [open, setOpen] = useState(false)
  const [rows, setRows] = useState<WorkspaceRow[]>([])
  // `naming` is the draft for a new workspace; `renaming` is the slug being
  // retitled. Only one input is ever on screen.
  const [naming, setNaming] = useState<string | null>(null)
  const [renaming, setRenaming] = useState<{ slug: string; name: string } | null>(null)
  const [confirming, setConfirming] = useState<string | null>(null)
  const [failed, setFailed] = useState(false)
  const inputRef = useRef<HTMLInputElement>(null)

  /**
   * Said in the panel, not swallowed and not toasted.
   *
   * A failed list used to render as a panel holding nothing but "New
   * workspace…", which reads as "you have none" — the one thing that cannot be
   * true, since you are looking at one. A toast would be the wrong place to say
   * so: this also runs on mount with the panel shut, and the answer belongs
   * where the question is asked.
   */
  const reload = () =>
    fetchWorkspaces()
      .then((next) => {
        setRows(next)
        setFailed(false)
      })
      .catch(() => setFailed(true))

  useEffect(() => {
    void reload()
  }, [current])

  // Radix owns escape and outside-click, including the capture-phase listening
  // the hand-rolled version needed so a click on the React Flow pane — which
  // stops propagation — still closes this.
  const toggle = (next: boolean) => {
    setOpen(next)
    if (!next) {
      setNaming(null)
      setRenaming(null)
      setConfirming(null)
    } else {
      void reload()
    }
  }

  useEffect(() => {
    if (naming !== null || renaming) inputRef.current?.focus()
  }, [naming, renaming])

  const guard = async (work: () => Promise<void>) => {
    try {
      await work()
    } catch (error) {
      onError(error instanceof Error ? error.message : 'Could not do that')
    }
  }

  const create = () =>
    guard(async () => {
      const name = (naming ?? '').trim()
      toggle(false)
      router.push(`/f/${await createWorkspace(name)}`)
    })

  const rename = () =>
    guard(async () => {
      const target = renaming!
      setRenaming(null)
      await renameWorkspace(target.slug, target.name)
      await reload()
    })

  const remove = (slug: string) =>
    guard(async () => {
      setConfirming(null)
      await deleteWorkspace(slug)
      const left = await fetchWorkspaces()
      setRows(left)
      // Deleting the open workspace leaves nowhere to be. `/` re-resolves the
      // landing one rather than this component guessing which is next.
      if (slug === current) router.push('/')
    })

  // The slug, not the word "Workspace", until the names arrive: the slug is in
  // the URL bar already, so the first paint says something true about where you
  // are rather than naming the control.
  const label = rows.find((row) => row.slug === current)?.name ?? current

  return (
    <Popover open={open} onOpenChange={toggle} modal={false}>
      {/*
        The chip used to be `▤ {name}` — no caret, no tooltip, a text glyph
        where every other control in this bar has a lucide icon. Beside the
        product title, in the same mono uppercase, it read as a breadcrumb
        saying which flow you were in, and nobody clicked it.
      */}
      <Hint label="Switch workspace, or start another one">
        <PopoverTrigger asChild>
          <button className="chip workspaces__chip" data-testid="workspace-menu-toggle">
            <ClapperboardIcon aria-hidden="true" />
            <span className="workspaces__name">{label}</span>
            <ChevronDownIcon className="workspaces__caret" aria-hidden="true" />
          </button>
        </PopoverTrigger>
      </Hint>

      {/*
        Tailwind for the box, `globals.css` for the rows inside it. Sizing only:
        the surface, radius and elevation come from the primitive, so this and
        the asset menu are the same floating layer by construction rather than
        by two rules agreeing.
      */}
      <PopoverContent
        className="max-h-[60vh] w-72 overflow-y-auto shadow-e2"
        data-testid="workspace-menu"
        onEscapeKeyDown={(event) => {
          // Escape backs out of the thing you are in, not the whole panel: after
          // cancelling a rename the next thing you want is usually a different
          // row, and having to reopen the switcher to reach it is the annoyance.
          // A second Escape, with nothing open, closes it.
          //
          // Has to be here rather than on the field: Radix listens for escape on
          // the document, so `stopPropagation` in a React handler runs too late
          // and the panel is already closing.
          if (naming !== null || renaming || confirming) {
            event.preventDefault()
            setNaming(null)
            setRenaming(null)
            setConfirming(null)
          }
        }}
      >
        {failed && rows.length === 0 && (
          <p className="workspaces__item workspaces__failed" data-testid="workspace-list-failed">
            Could not list your workspaces. You are still in this one.
          </p>
        )}

        {rows.map((row) =>
          renaming?.slug === row.slug ? (
            <form
              key={row.slug}
              className="workspaces__note"
              onSubmit={(event) => {
                event.preventDefault()
                void rename()
              }}
            >
              <input
                ref={inputRef}
                className="workspaces__input"
                value={renaming.name}
                aria-label={`Rename ${row.name}`}
                data-testid="workspace-rename-input"
                onChange={(event) => setRenaming({ ...renaming, name: event.target.value })}
              />
            </form>
          ) : confirming === row.slug ? (
            <div key={row.slug} className="workspaces__item workspaces__confirm">
              <span className="workspaces__label">Delete “{row.name}”?</span>
              <button
                className="chip chip--danger"
                data-testid={`workspace-delete-confirm-${row.slug}`}
                onClick={() => void remove(row.slug)}
              >
                Delete
              </button>
              <button className="chip" onClick={() => setConfirming(null)}>
                Keep
              </button>
            </div>
          ) : (
            <div key={row.slug} className="workspaces__item workspaces__row">
              <a
                className="workspaces__label workspaces__link"
                href={`/f/${row.slug}`}
                aria-current={row.slug === current ? 'page' : undefined}
                data-testid={`workspace-open-${row.slug}`}
                onClick={() => toggle(false)}
              >
                {row.slug === current ? '● ' : '○ '}
                {row.name}
              </a>
              <button
                className="workspaces__action"
                aria-label={`Rename ${row.name}`}
                title="Rename"
                data-testid={`workspace-rename-${row.slug}`}
                onClick={() => setRenaming({ slug: row.slug, name: row.name })}
              >
                <PencilLineIcon aria-hidden="true" />
              </button>
              {/* The last one cannot go: the canvas has to open onto something,
                  and the API 409s. Refusing here rather than only in a toast
                  means the button says so before it is pressed.

                  `<= 1`, not `=== 1`: a list that failed to load leaves this at
                  zero, and offering to delete out of a state where nothing is
                  known about what exists is the wrong way round. The 409 is
                  still the enforcement; this is only the readable half of it. */}
              <button
                className="workspaces__action"
                aria-label={`Delete ${row.name}`}
                title={rows.length <= 1 ? 'The only workspace cannot be deleted' : 'Delete'}
                disabled={rows.length <= 1}
                data-testid={`workspace-delete-${row.slug}`}
                onClick={() => setConfirming(row.slug)}
              >
                <Trash2Icon aria-hidden="true" />
              </button>
            </div>
          ),
        )}

        <hr className="workspaces__rule" />

        {naming === null ? (
          <button
            className="workspaces__item workspaces__new"
            data-testid="workspace-new"
            onClick={() => setNaming('')}
          >
            <PlusIcon aria-hidden="true" />
            New workspace…
          </button>
        ) : (
          <form
            className="workspaces__note"
            onSubmit={(event) => {
              event.preventDefault()
              void create()
            }}
          >
            <input
              ref={inputRef}
              className="workspaces__input"
              value={naming}
              placeholder="spring campaign"
              aria-label="Name the new workspace"
              data-testid="workspace-new-input"
              onChange={(event) => setNaming(event.target.value)}
            />
            <button className="chip" type="submit" data-testid="workspace-new-save">
              Create
            </button>
          </form>
        )}
      </PopoverContent>
    </Popover>
  )
}
