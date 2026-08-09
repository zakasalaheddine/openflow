"use client"

import * as React from "react"
import { Tooltip as TooltipPrimitive } from "radix-ui"

import { cn } from "@/ui/cn"

/**
 * 220ms, not shadcn's 0.
 *
 * Instant tooltips fire on every pointer that crosses a toolbar, which on a
 * canvas you are dragging across constantly is a strip of boxes opening and
 * closing behind the cursor. `skipDelayDuration` keeps the second one in a row
 * instant, so reading along a row of controls stays fast.
 */
function TooltipProvider({
  delayDuration = 220,
  skipDelayDuration = 400,
  ...props
}: React.ComponentProps<typeof TooltipPrimitive.Provider>) {
  return (
    <TooltipPrimitive.Provider
      data-slot="tooltip-provider"
      delayDuration={delayDuration}
      skipDelayDuration={skipDelayDuration}
      {...props}
    />
  )
}

function Tooltip({
  ...props
}: React.ComponentProps<typeof TooltipPrimitive.Root>) {
  return <TooltipPrimitive.Root data-slot="tooltip" {...props} />
}

function TooltipTrigger({
  ...props
}: React.ComponentProps<typeof TooltipPrimitive.Trigger>) {
  return <TooltipPrimitive.Trigger data-slot="tooltip-trigger" {...props} />
}

/**
 * `--overlay`, not shadcn's inverted `bg-foreground`.
 *
 * A white box is the conventional tooltip on a light page and the wrong object
 * on this one: the whole interface is a darkroom, and the brightest thing on
 * screen should be a rendered frame, not a hint about a button. Same surface as
 * a menu or a toast, because a tooltip is the same floating layer.
 */
function TooltipContent({
  className,
  sideOffset = 6,
  children,
  ...props
}: React.ComponentProps<typeof TooltipPrimitive.Content>) {
  return (
    <TooltipPrimitive.Portal>
      <TooltipPrimitive.Content
        data-slot="tooltip-content"
        sideOffset={sideOffset}
        className={cn(
          "z-50 w-fit max-w-[min(28rem,90vw)] origin-(--radix-tooltip-content-transform-origin) animate-in rounded-md border border-line-bright bg-overlay px-2.5 py-1.5 text-xs text-balance text-ink shadow-e2 fade-in-0 zoom-in-95 data-[side=bottom]:slide-in-from-top-1 data-[side=left]:slide-in-from-right-1 data-[side=right]:slide-in-from-left-1 data-[side=top]:slide-in-from-bottom-1 data-[state=closed]:animate-out data-[state=closed]:fade-out-0 data-[state=closed]:zoom-out-95",
          className
        )}
        {...props}
      >
        {children}
      </TooltipPrimitive.Content>
    </TooltipPrimitive.Portal>
  )
}

export { Tooltip, TooltipTrigger, TooltipContent, TooltipProvider }
