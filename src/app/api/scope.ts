import { NextResponse } from 'next/server'
import { getDb, type Db } from '@/db'
import { NoSuchFlowError, resolveFlow } from '@/core/workspace'

/**
 * Which workspace a request is talking about.
 *
 * `?flow=<slug>` and nothing else. Deliberately optional: an omitted parameter
 * means the landing workspace, which is what keeps every existing caller — the
 * e2e helpers, a bookmarked `/api/flow`, `bin/` — working untouched.
 *
 * Returns the 404 rather than throwing it. An unknown slug is an ordinary
 * outcome (a link to a workspace someone deleted), and every route would
 * otherwise repeat the same try/catch to say so.
 */
export function scope(
  request: Request,
): { db: Db; projectId: string; flowId: string } | NextResponse {
  const db = getDb()
  try {
    return { db, ...resolveFlow(db, new URL(request.url).searchParams.get('flow')) }
  } catch (error) {
    if (error instanceof NoSuchFlowError) {
      return NextResponse.json({ error: error.message }, { status: 404 })
    }
    throw error
  }
}
