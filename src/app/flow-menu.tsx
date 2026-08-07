'use client'

import { useEffect, useRef, useState } from 'react'
import { useRouter } from 'next/navigation'
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
  const wrapRef = useRef<HTMLDivElement>(null)
  const inputRef = useRef<HTMLInputElement>(null)

  const close = () => {
    setOpen(false)
    setNaming(null)
    setRenaming(null)
    setConfirming(null)
  }

  const reload = () => fetchWorkspaces().then(setRows).catch(() => undefined)

  useEffect(() => {
    void reload()
  }, [current])

  useEffect(() => {
    if (!open) return
    void reload()

    const onKey = (event: KeyboardEvent) => {
      if (event.key === 'Escape') close()
    }
    // Capture, because React Flow stops propagation on the pane — a bubbling
    // listener never hears a click on the canvas and the menu stays open
    // behind it. Same reason as the asset menu.
    const onDown = (event: MouseEvent) => {
      if (!wrapRef.current?.contains(event.target as Node)) close()
    }
    window.addEventListener('keydown', onKey)
    window.addEventListener('mousedown', onDown, true)
    return () => {
      window.removeEventListener('keydown', onKey)
      window.removeEventListener('mousedown', onDown, true)
    }
  }, [open])

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
      close()
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

  const label = rows.find((row) => row.slug === current)?.name ?? 'Workspace'

  return (
    <div className="assets" ref={wrapRef}>
      <button
        className="chip"
        aria-expanded={open}
        aria-haspopup="menu"
        data-testid="workspace-menu-toggle"
        onClick={() => (open ? close() : setOpen(true))}
      >
        ▤ {label}
      </button>

      {open && (
        <div className="assets__menu" role="menu" data-testid="workspace-menu">
          {rows.map((row) =>
            renaming?.slug === row.slug ? (
              <form
                key={row.slug}
                className="assets__note"
                onSubmit={(event) => {
                  event.preventDefault()
                  void rename()
                }}
              >
                <input
                  ref={inputRef}
                  className="workspaces__input"
                  value={renaming.name}
                  data-testid="workspace-rename-input"
                  onChange={(event) => setRenaming({ ...renaming, name: event.target.value })}
                  onKeyDown={(event) => {
                    if (event.key === 'Escape') setRenaming(null)
                  }}
                />
              </form>
            ) : confirming === row.slug ? (
              <div key={row.slug} className="assets__item workspaces__confirm">
                <span className="assets__label">Delete “{row.name}”?</span>
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
              <div key={row.slug} className="assets__item workspaces__row">
                <a
                  className="assets__label workspaces__link"
                  href={`/f/${row.slug}`}
                  aria-current={row.slug === current ? 'page' : undefined}
                  data-testid={`workspace-open-${row.slug}`}
                  onClick={close}
                >
                  {row.slug === current ? '● ' : '○ '}
                  {row.name}
                </a>
                <button
                  className="workspaces__action"
                  title="Rename"
                  data-testid={`workspace-rename-${row.slug}`}
                  onClick={() => setRenaming({ slug: row.slug, name: row.name })}
                >
                  ✎
                </button>
                <button
                  className="workspaces__action"
                  title="Delete"
                  data-testid={`workspace-delete-${row.slug}`}
                  onClick={() => setConfirming(row.slug)}
                >
                  ✕
                </button>
              </div>
            ),
          )}

          <hr className="assets__rule" />

          {naming === null ? (
            <button
              className="assets__item"
              role="menuitem"
              data-testid="workspace-new"
              onClick={() => setNaming('')}
            >
              + New workspace…
            </button>
          ) : (
            <form
              className="assets__note"
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
                data-testid="workspace-new-input"
                onChange={(event) => setNaming(event.target.value)}
                onKeyDown={(event) => {
                  if (event.key === 'Escape') setNaming(null)
                }}
              />
              <button className="chip" type="submit" data-testid="workspace-new-save">
                Create
              </button>
            </form>
          )}
        </div>
      )}
    </div>
  )
}
