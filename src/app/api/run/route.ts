import { NextResponse } from 'next/server'
import { scope } from '../scope'
import { enqueueRun, SpendCapExceededError } from '@/core/executor'
import { UnsupportedCapabilityError } from '@/models/registry'
import { isDemo } from '@/env'
import type { NodeId } from '@/core/types'

export const dynamic = 'force-dynamic'

export async function POST(request: Request) {
  // The demo page is public and the graph on it is editable. Without this, one
  // visitor editing a prompt and pressing Run dispatches a render — and a
  // hosted demo that bills per visitor is a demo you take down.
  if (isDemo()) {
    return NextResponse.json(
      { error: 'This is a read-only demo. Everything you see is already rendered.' },
      { status: 403 },
    )
  }

  const scoped = scope(request)
  if (scoped instanceof NextResponse) return scoped
  const { db, flowId } = scoped
  const body = (await request.json().catch(() => ({}))) as {
    confirmOverspend?: boolean
    /** Render one node and whatever upstream it still needs. */
    nodeId?: NodeId
  }

  try {
    const result = enqueueRun(db, flowId, {
      confirmOverspend: body.confirmOverspend === true,
      only: body.nodeId,
    })
    return NextResponse.json({
      enqueued: result.enqueued.length,
      cached: result.cached.length,
      estimatedCents: result.estimatedCents,
    })
  } catch (error) {
    // The cap is a confirmation prompt, not an error — 409 so the client knows
    // to ask rather than to give up, and the amount comes back so the dialog
    // can name the price instead of saying "too expensive".
    if (error instanceof SpendCapExceededError) {
      return NextResponse.json(
        {
          error: error.message,
          needsConfirmation: true,
          estimatedCents: error.estimatedCents,
          capCents: error.capCents,
        },
        { status: 409 },
      )
    }
    if (error instanceof UnsupportedCapabilityError) {
      return NextResponse.json({ error: error.message }, { status: 400 })
    }
    return NextResponse.json(
      { error: error instanceof Error ? error.message : 'Run failed' },
      { status: 500 },
    )
  }
}
