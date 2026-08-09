import type { Metadata, Viewport } from 'next'
import { Inter, JetBrains_Mono } from 'next/font/google'
import './globals.css'

/**
 * Two families, both variable, both self-hosted by `next/font` at build time —
 * no runtime request to Google and nothing to leak from a local-first tool.
 *
 * `system-ui` was the old base, which meant the interface was SF Pro on one
 * machine and Segoe on another and neither had been tuned for. Inter is the
 * cross-platform version of the same idea. The mono is not decoration: every
 * measurable thing here — prices, ids, seeds, model slugs — is set in it, and
 * `tabular-nums` on a proportional fallback made the ledger jitter as it
 * counted.
 */
const sans = Inter({
  subsets: ['latin'],
  variable: '--font-inter',
  display: 'swap',
})

const mono = JetBrains_Mono({
  subsets: ['latin'],
  variable: '--font-jetbrains',
  display: 'swap',
})

export const metadata: Metadata = {
  title: 'OpenFlow',
  description: 'Local-first node editor for directing on-brand ad creative',
}

export const viewport: Viewport = { width: 'device-width', initialScale: 1 }

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    // `dark` is permanent, not a preference: there is no light theme to switch
    // to, and shadcn primitives key half their styling off this class.
    <html lang="en" className={`dark ${sans.variable} ${mono.variable}`}>
      <body>{children}</body>
    </html>
  )
}
