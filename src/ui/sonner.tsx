'use client'

import { CircleCheckIcon, InfoIcon, Loader2Icon, OctagonXIcon, TriangleAlertIcon } from 'lucide-react'
import { Toaster as Sonner, type ToasterProps } from 'sonner'

/**
 * `theme="dark"`, not `useTheme()`.
 *
 * shadcn ships this wired to `next-themes`, which this app does not have and
 * does not want: there is one theme and `.dark` is permanent on <html> (see
 * DESIGN.md). Left on the default `"system"`, sonner reads
 * `prefers-color-scheme` and hands anyone with a light OS a white toast on the
 * darkroom canvas.
 *
 * The colours come from the same variables as everything else, so a toast is
 * the `--overlay` surface at `--e-2` — the floating layer, same as a menu.
 */
const Toaster = (props: ToasterProps) => (
  <Sonner
    theme="dark"
    className="toaster group"
    icons={{
      success: <CircleCheckIcon className="size-4" />,
      info: <InfoIcon className="size-4" />,
      warning: <TriangleAlertIcon className="size-4" />,
      error: <OctagonXIcon className="size-4" />,
      loading: <Loader2Icon className="size-4 animate-spin" />,
    }}
    style={
      {
        '--normal-bg': 'var(--overlay)',
        '--normal-text': 'var(--ink)',
        '--normal-border': 'var(--line-bright)',
        '--error-bg': 'var(--overlay)',
        '--error-text': 'var(--fault)',
        '--error-border': 'var(--fault)',
        '--success-bg': 'var(--overlay)',
        '--success-text': 'var(--ink)',
        '--success-border': 'var(--line-bright)',
        '--border-radius': 'var(--r-md)',
      } as React.CSSProperties
    }
    {...props}
  />
)

export { Toaster }
