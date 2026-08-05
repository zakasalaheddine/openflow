'use client'

import { useEffect, useRef } from 'react'

export type Preview = { url: string; mime: string; label: string }

/**
 * A frame at its real size.
 *
 * The card is 5:4 and cropped, because twelve shots have to be reviewable on
 * one screen. That is the wrong shape for judging one of them — a bottle can
 * sit dead centre in the thumbnail and be cut off in the file.
 *
 * `<dialog>` rather than a div with a z-index: Escape, the backdrop, the top
 * layer and the focus trap are all the platform's, and none of them are worth
 * reimplementing badly. `showModal` is called from an effect, not on render,
 * because it is a DOM method and there is no React prop for "open modally".
 */
export function Lightbox({ item, onClose }: { item: Preview | null; onClose: () => void }) {
  const ref = useRef<HTMLDialogElement>(null)

  useEffect(() => {
    const dialog = ref.current
    if (!dialog) return
    if (item && !dialog.open) dialog.showModal()
    if (!item && dialog.open) dialog.close()
  }, [item])

  return (
    <dialog
      ref={ref}
      className="lightbox"
      data-testid="lightbox"
      aria-label={item ? `Preview of ${item.label}` : 'Preview'}
      // Escape fires `cancel` then `close`; the backdrop fires neither, so both
      // routes have to end in the same state the parent holds.
      onClose={onClose}
      onClick={(event) => {
        // The backdrop is the dialog itself — anything inside it stops here.
        if (event.target === ref.current) onClose()
      }}
    >
      {item &&
        (item.mime.startsWith('video/') ? (
          // Controls, because judging a clip means scrubbing it. Muted so a
          // canvas of twelve does not start shouting when one is opened.
          <video src={item.url} controls autoPlay loop muted playsInline data-testid="lightbox-video" />
        ) : (
          // eslint-disable-next-line @next/next/no-img-element
          <img src={item.url} alt={item.label} data-testid="lightbox-image" />
        ))}
      <button className="lightbox__close" onClick={onClose} data-testid="lightbox-close" aria-label="Close preview">
        ×
      </button>
    </dialog>
  )
}
