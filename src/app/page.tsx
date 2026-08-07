import { redirect } from 'next/navigation'
import { getDb } from '@/db'
import { landingFlow, flowSlug } from '@/core/workspace'

// The landing workspace depends on what is in the database *now* — which one is
// newest, whether the default still exists — so this cannot be prerendered.
export const dynamic = 'force-dynamic'

/** `/` is a doorway, not a page: every canvas lives at its own `/f/<slug>`. */
export default function Home() {
  redirect(`/f/${flowSlug(landingFlow(getDb()))}`)
}
