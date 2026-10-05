/*
 * POST /api/v1/allocations/{id}/split — set a project's allocation mode
 * and per-developer caps (Screen 4 mode toggle + per-dev budget inputs).
 *
 * {id} is the project's baseline POOL allocation (scope_type='project',
 * teammate_id NULL). Body:
 *   { mode: 'shared_pool' }                       → drop per-dev caps
 *   { mode: 'per_dev_fixed', caps: [{teammate_id, budget_usd}, …] }
 *                                                 → replace per-dev caps
 *
 * Per-dev caps are project-scoped allocation rows carrying teammate_id,
 * sharing the pool's effective range. Invariants:
 *   - every capped teammate must be a current assignee (else 422)
 *   - sum(caps) must not exceed the pool budget (else 422)
 * "Split evenly" is a client helper that submits equal caps; the server
 * only validates the explicit amounts.
 *
 * manager / admin / platform-admin, scoped to the project.
 */
import {
  defineEventHandler,
  createError,
  readValidatedBody,
  getRequestIP,
  getHeader,
} from 'h3'
import { sql } from 'drizzle-orm'
import { z } from 'zod'
import { requireAuth, requireRole } from '../../../../auth/rbac'
import { assertProjectScope } from '../../../../auth/project-scope'
import { assertSameOrigin } from '../../../../auth/csrf'
import { withRequestRls } from '../../../../db/request-rls'
import { recordAuditEvent } from '../../../../db/audit'
import { requireUuidParam } from '../../../../utils/require-uuid-param'

const Body = z.discriminatedUnion('mode', [
  z.object({ mode: z.literal('shared_pool') }),
  z.object({
    mode: z.literal('per_dev_fixed'),
    caps: z
      .array(
        z.object({
          teammate_id: z.string().uuid(),
          budget_usd: z.string().regex(/^\d+(\.\d{1,2})?$/),
        }),
      )
      .min(1),
  }),
])

const cents = (s: string) => Math.round(Number(s) * 100)

export default defineEventHandler(async (event) => {
  await requireRole(event, 'manager', 'admin')
  assertSameOrigin(event)
  const session = await requireAuth(event)
  const id = requireUuidParam(event, 'id', 'allocation id')
  const body = await readValidatedBody(event, (d) => Body.parse(d))
  const ip = getRequestIP(event, { xForwardedFor: true }) ?? null
  const ua = getHeader(event, 'user-agent') ?? null

  return await withRequestRls(event, async (tx) => {
    // Resolve the pool baseline + its project scope.
    const poolRows = await tx.execute<{
      project_id: string
      budget_usd: string
      effective: string
      region_id: string
      cou_path: string
    }>(sql`
      SELECT a.scope_id::text AS project_id,
             a.budget_usd::text AS budget_usd,
             a.effective::text AS effective,
             p.region_id::text AS region_id,
             cou.path::text AS cou_path
      FROM allocation a
      JOIN project p ON p.id = a.scope_id AND a.scope_type = 'project'
      JOIN org_unit cou ON cou.id = p.cost_owning_unit_id
      WHERE a.id = ${id}::uuid AND a.teammate_id IS NULL AND a.allocation_kind = 'baseline'
      LIMIT 1
    `)
    const pool = [...poolRows][0]
    if (!pool) {
      throw createError({ statusCode: 404, statusMessage: 'Pool allocation not found' })
    }
    await assertProjectScope(event, { regionId: pool.region_id, couPath: pool.cou_path }, tx)

    if (body.mode === 'shared_pool') {
      await tx.execute(sql`
        DELETE FROM allocation
        WHERE scope_type = 'project' AND scope_id = ${pool.project_id}::uuid
          AND teammate_id IS NOT NULL AND effective = ${pool.effective}::tstzrange
      `)
      await tx.execute(sql`
        UPDATE project SET allocation_mode = 'shared_pool' WHERE id = ${pool.project_id}::uuid
      `)
      return { project_id: pool.project_id, mode: 'shared_pool', caps: [] }
    }

    // per_dev_fixed — validate caps against current assignees + pool total.
    const assignRows = await tx.execute<{ teammate_id: string }>(sql`
      SELECT teammate_id::text AS teammate_id FROM project_assignment
      WHERE project_id = ${pool.project_id}::uuid AND upper_inf(effective)
    `)
    const assigned = new Set([...assignRows].map((r) => r.teammate_id))
    for (const cap of body.caps) {
      if (!assigned.has(cap.teammate_id)) {
        throw createError({
          statusCode: 422,
          statusMessage: 'Cap target is not assigned to this project',
          data: {
            type: 'https://tokenscope.example.com/errors/cap-unassigned',
            title: 'Assign the teammate first',
            status: 422,
            detail: `Teammate ${cap.teammate_id} must be assigned before receiving a per-dev cap.`,
          },
        })
      }
    }
    const sum = body.caps.reduce((acc, c) => acc + cents(c.budget_usd), 0)
    if (sum > cents(pool.budget_usd)) {
      throw createError({
        statusCode: 422,
        statusMessage: 'Per-developer caps exceed the project budget',
        data: {
          type: 'https://tokenscope.example.com/errors/caps-exceed-pool',
          title: 'Caps exceed pool',
          status: 422,
          detail: `Sum of caps (${(sum / 100).toFixed(2)}) exceeds the pool budget (${pool.budget_usd}).`,
        },
      })
    }

    // One audit event covers the whole split; all per-dev rows reference it.
    const evt = await recordAuditEvent(tx, {
      eventType: 'allocation-split-set',
      actorTeammateId: session.teammateId,
      subjectKind: 'project',
      subjectId: pool.project_id,
      payload: { mode: 'per_dev_fixed', caps: body.caps, pool_budget_usd: pool.budget_usd },
      ipAddress: ip,
      userAgent: ua,
    })

    // Replace existing per-dev caps for this period.
    await tx.execute(sql`
      DELETE FROM allocation
      WHERE scope_type = 'project' AND scope_id = ${pool.project_id}::uuid
        AND teammate_id IS NOT NULL AND effective = ${pool.effective}::tstzrange
    `)
    for (const cap of body.caps) {
      await tx.execute(sql`
        INSERT INTO allocation
          (scope_type, scope_id, teammate_id, budget_usd, effective, allocation_kind, created_by, audit_event_id, source)
        VALUES
          ('project', ${pool.project_id}::uuid, ${cap.teammate_id}::uuid, ${cap.budget_usd}::numeric,
           ${pool.effective}::tstzrange, 'baseline', ${session.teammateId}::uuid, ${evt.id}::uuid, 'manual')
      `)
    }
    await tx.execute(sql`
      UPDATE project SET allocation_mode = 'per_dev_fixed' WHERE id = ${pool.project_id}::uuid
    `)

    return {
      project_id: pool.project_id,
      mode: 'per_dev_fixed',
      caps: body.caps,
      pool_budget_usd: pool.budget_usd,
    }
  })
})
