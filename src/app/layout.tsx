import type { Metadata, Viewport } from 'next'

export const metadata: Metadata = {
  title: 'OpenFlow',
  description: 'Local-first node editor for directing on-brand ad creative',
}

export const viewport: Viewport = { width: 'device-width', initialScale: 1 }

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en">
      <body>{children}</body>
    </html>
  )
}
