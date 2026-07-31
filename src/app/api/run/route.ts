import { NextResponse } from 'next/server'
import { getDb } from '@/db'
import { ensureWorkspace } from '@/core/workspace'
import { enqueueRun, SpendCapExceededError } from '@/core/executor'
import { UnsupportedCapabilityError } from '@/models/registry'
import type { ModelRole } from '@/core/types'

export const dynamic = 'force-dynamic'

export async function POST(request: Request) {
  const db = getDb()
  const { flowId } = ensureWorkspace(db)
  const body = (await request.json().catch(() => ({}))) as {
    role?: ModelRole
    confirmOverspend?: boolean
  }

  try {
    const result = enqueueRun(db, flowId, {
      role: body.role,
      confirmOverspend: body.confirmOverspend === true,
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
