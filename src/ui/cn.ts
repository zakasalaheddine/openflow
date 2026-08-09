import { clsx, type ClassValue } from 'clsx'
import { twMerge } from 'tailwind-merge'

/**
 * The class joiner every shadcn component expects.
 *
 * `twMerge` is the part that matters: without it, passing `className="p-0"` to a
 * component whose base already says `p-2` leaves both in the string and the
 * cascade picks by source order in the generated stylesheet rather than by
 * intent. Two utilities for the same property, and the caller's loses.
 */
export function cn(...inputs: ClassValue[]) {
  return twMerge(clsx(inputs))
}
