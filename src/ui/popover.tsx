"use client"

import * as React from "react"
import { Popover as PopoverPrimitive } from "radix-ui"

import { cn } from "@/ui/cn"

/**
 * A floating panel, not a menu.
 *
 * The distinction is the whole reason this file exists next to
 * `dropdown-menu.tsx`. A menu owns the keyboard: arrow keys move between items,
 * letters trigger typeahead, focus is managed away from whatever you are in.
 * That is right for a list of commands and wrong for a panel holding a text
 * input — which is why `asset-menu.tsx` puts "write a note" in a dialog rather
 * than in its own menu.
 *
 * A popover is the same top-layer, dismissable, focus-returning primitive with
 * none of that key handling, so a form can live inside one.
 */
function Popover({ ...props }: React.ComponentProps<typeof PopoverPrimitive.Root>) {
  return <PopoverPrimitive.Root data-slot="popover" {...props} />
}

function PopoverTrigger({
  ...props
}: React.ComponentProps<typeof PopoverPrimitive.Trigger>) {
  return <PopoverPrimitive.Trigger data-slot="popover-trigger" {...props} />
}

function PopoverAnchor({
  ...props
}: React.ComponentProps<typeof PopoverPrimitive.Anchor>) {
  return <PopoverPrimitive.Anchor data-slot="popover-anchor" {...props} />
}

/**
 * Enters animated, leaves instantly — the same deliberate omission as
 * `DropdownMenuContent`, for the same reason.
 *
 * Radix keeps closing content mounted until its exit animation ends, and its
 * dismissable layer is still listening while it is. A pointerdown on the
 * trigger inside that window reads as a click *outside* and is consumed, so
 * closing and immediately reopening does nothing.
 */
function PopoverContent({
  className,
  align = "start",
  sideOffset = 4,
  ...props
}: React.ComponentProps<typeof PopoverPrimitive.Content>) {
  return (
    <PopoverPrimitive.Portal>
      <PopoverPrimitive.Content
        data-slot="popover-content"
        align={align}
        sideOffset={sideOffset}
        className={cn(
          "z-50 w-72 origin-(--radix-popover-content-transform-origin) rounded-md border bg-popover p-1 text-popover-foreground shadow-md outline-hidden data-[side=bottom]:slide-in-from-top-2 data-[side=left]:slide-in-from-right-2 data-[side=right]:slide-in-from-left-2 data-[side=top]:slide-in-from-bottom-2 data-[state=open]:animate-in data-[state=open]:fade-in-0 data-[state=open]:zoom-in-95",
          className
        )}
        {...props}
      />
    </PopoverPrimitive.Portal>
  )
}

export { Popover, PopoverTrigger, PopoverAnchor, PopoverContent }
