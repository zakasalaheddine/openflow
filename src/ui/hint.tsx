'use client'

import type { ReactNode } from 'react'
import { Tooltip, TooltipContent, TooltipTrigger } from '@/ui/tooltip'

/**
 * A tooltip in one line, because there are twenty of them.
 *
 * Replaces `title=""`, which was what every hint in this interface used to be:
 * a one-second OS delay, unstyled, invisible to the keyboard, and gone on
 * touch. The shortcut is part of the tooltip rather than the whole of it — the
 * refs toggle used to carry `title="⌥R"` and nothing that said what ⌥R did.
 *
 * `asChild`, so the trigger is the caller's own button and no wrapper span
 * lands between a React Flow node and its click handler.
 */
export function Hint({
  label,
  keys,
  side = 'bottom',
  children,
}: {
  label: ReactNode
  keys?: string
  side?: 'top' | 'right' | 'bottom' | 'left'
  children: ReactNode
}) {
  return (
    <Tooltip>
      <TooltipTrigger asChild>{children}</TooltipTrigger>
      <TooltipContent side={side}>
        <span className="flex items-center gap-2">
          <span>{label}</span>
          {keys && (
            <kbd className="rounded-[4px] border border-line-bright bg-raised px-1.5 py-px font-mono text-[10px] text-slate">
              {keys}
            </kbd>
          )}
        </span>
      </TooltipContent>
    </Tooltip>
  )
}
