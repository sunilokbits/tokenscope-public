/*
 * GET /api/v1/admin/worker-runs/[id] — one worker run with its FULL result object
 * (the per-run drill-down: scopes considered/run/errored/skipped, disposition counts,
 * etc.) + error + derived warnings. RBAC: platform-admin only — a stored result can
 * carry other regions' rows (e.g. attribution-gap instances).
 */
import { defineEventHandler, getRouterParam, createError } from 'h3'
import { sql } from 'drizzle-orm'
import { z } from 'zod'
import { requireRole } from '../../../../auth/rbac'
import { withRequestRls } from '../../../../db/request-rls'
import { deriveRunWarnings } from '../../../../reconciliation/run-warnings'

interface Row extends Record<string, unknown> {
  id: string
  worker_name: string
  status: string
  started_at: string
  finished_at: string | null
  duration_ms: number | null
  rows_affected: number | null
  error: string | null
  result: unknown
}

export default defineEventHandler(async (event) => {
  await requireRole(event, 'platform-admin')
  const parsed = z.string().uuid().safeParse(getRouterParam(event, 'id'))
  if (!parsed.success) {
    throw createError({ statusCode: 400, statusMessage: 'Invalid run id' })
  }

  const row = await withRequestRls(event, async (tx) => {
    const [r] = await tx.execute<Row>(sql`
      SELECT id::text AS id, worker_name, status, started_at, finished_at,
             duration_ms, rows_affected, error, result
      FROM worker_run WHERE id = ${parsed.data}::uuid
    `)
    return r ?? null
  })
  if (!row) {
    throw createError({ statusCode: 404, statusMessage: 'Run not found' })
  }

  return {
    id: row.id,
    worker: row.worker_name,
    status: row.status,
    startedAt: row.started_at,
    finishedAt: row.finished_at,
    durationMs: row.duration_ms,
    rowsAffected: row.rows_affected,
    error: row.error,
    result: row.result,
    warnings: deriveRunWarnings(row.result),
  }
})
