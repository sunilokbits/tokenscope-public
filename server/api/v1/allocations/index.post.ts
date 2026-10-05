/*
 * POST /api/v1/allocations — create the baseline budget pool for a
 * project (Journey 3a: "sets total budget + effective range"; first
 * allocation flips the project to is_onboarded). manager / admin /
 * platform-admin, scoped to the project.
 *
 * This is the shared-pool baseline (teammate_id NULL). Per-developer
 * caps are layered on via POST /allocations/{id}/split.
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
import { requireAuth, requireRole } from '../../../auth/rbac'
import { assertProjectScope } from '../../../auth/project-scope'
import { assertSameOrigin } from '../../../auth/csrf'
import { withRequestRls } from '../../../db/request-rls'
import { BudgetUsdSchema, EffectiveRangeSchema } from '../../../utils/allocation-validation'
import { translatePgConstraintError } from '../../../utils/pg-constraint-error'
import { allocation } from '../../../../drizzle/schema'
import { recordAuditEvent } from '../../../db/audit'

const Body = z.object({
  project_id: z.string().uuid(),
  budget_usd: BudgetUsdSchema,
  effective: EffectiveRangeSchema,
})

export default defineEventHandler(async (event) => {
  await requireRole(event, 'manager', 'admin')
  assertSameOrigin(event)
  const session = await requireAuth(event)
  const body = await readValidatedBody(event, (d) => Body.parse(d))
  const ip = getRequestIP(event, { xForwardedFor: true }) ?? null
  const ua = getHeader(event, 'user-agent') ?? null

  return await withRequestRls(event, async (tx) => {
    const projRows = await tx.execute<{ region_id: string; cou_path: string }>(sql`
      SELECT p.region_id::text AS region_id, cou.path::text AS cou_path
      FROM project p
      JOIN org_unit cou ON cou.id = p.cost_owning_unit_id
      WHERE p.id = ${body.project_id}::uuid
      LIMIT 1
    `)
    const proj = [...projRows][0]
    if (!proj) {
      throw createError({ statusCode: 404, statusMessage: 'Project not found' })
    }
    await assertProjectScope(event, { regionId: proj.region_id, couPath: proj.cou_path }, tx)

    // Reject an overlapping baseline pool up front for a clean 409 (the
    // gist EXCLUDE would otherwise raise a raw constraint error).
    const overlap = await tx.execute<{ id: string }>(sql`
      SELECT id::text AS id FROM allocation
      WHERE scope_type = 'project' AND scope_id = ${body.project_id}::uuid
        AND teammate_id IS NULL AND allocation_kind = 'baseline'
        AND effective && ${body.effective}::tstzrange
      LIMIT 1
    `)
    if ([...overlap][0]) {
      throw createError({
        statusCode: 409,
        statusMessage: 'A baseline budget already covers this period for the project',
      })
    }

    const evt = await recordAuditEvent(tx, {
      eventType: 'allocation-created',
      actorTeammateId: session.teammateId,
      subjectKind: 'project',
      subjectId: body.project_id,
      payload: { budget_usd: body.budget_usd, effective: body.effective, scope: 'project-pool' },
      ipAddress: ip,
      userAgent: ua,
    })

    // The SELECT pre-check above is racy by nature — a concurrent POST can
    // commit between it and this INSERT. The gist EXCLUDE
    // (allocation_scope_dev_kind_eff_excl) is the real guard; translate its
    // 23P01 into the same clean 409 instead of a raw 500.
    let created: { id: string } | undefined
    try {
      ;[created] = await tx
        .insert(allocation)
        .values({
          scopeType: 'project',
          scopeId: body.project_id,
          teammateId: null,
          budgetUsd: body.budget_usd,
          effective: body.effective,
          allocationKind: 'baseline',
          createdBy: session.teammateId,
          auditEventId: evt.id,
          source: 'manual',
        })
        .returning({ id: allocation.id })
    } catch (err: unknown) {
      translatePgConstraintError(err, {
        '23P01': {
          title: 'A baseline budget already covers this period for the project',
          detail:
            'An overlapping baseline allocation was created concurrently. Reload and adjust the effective range.',
        },
      })
    }

    // First allocation onboards the project.
    await tx.execute(sql`
      UPDATE project SET is_onboarded = TRUE WHERE id = ${body.project_id}::uuid
    `)

    return { id: created!.id, project_id: body.project_id, budget_usd: body.budget_usd, is_onboarded: true }
  })
})
