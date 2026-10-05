/*
 * DELETE /api/v1/admin/projects/{id}/assignments/{teammateId} — end a
 * teammate's assignment (close the effective range rather than hard-
 * delete, preserving attribution history). manager / admin / global-
 * finops, scoped to the project.
 */
import { defineEventHandler, createError, setResponseStatus, getRequestIP, getHeader } from 'h3'
import { sql } from 'drizzle-orm'
import { requireRole } from '../../../../../../auth/rbac'
import { assertProjectScope } from '../../../../../../auth/project-scope'
import { assertSameOrigin } from '../../../../../../auth/csrf'
import { withRequestRls } from '../../../../../../db/request-rls'
import { recordAuditEvent } from '../../../../../../db/audit'
import { requireUuidParam } from '../../../../../../utils/require-uuid-param'

export default defineEventHandler(async (event) => {
  const caller = await requireRole(event, 'manager', 'admin')
  assertSameOrigin(event)
  const id = requireUuidParam(event, 'id', 'project id')
  const teammateId = requireUuidParam(event, 'teammateId', 'teammate id')
  const ip = getRequestIP(event, { xForwardedFor: true }) ?? null
  const ua = getHeader(event, 'user-agent') ?? null

  return await withRequestRls(event, async (tx) => {
    const projRows = await tx.execute<{ region_id: string; cou_path: string }>(sql`
      SELECT p.region_id::text AS region_id, cou.path::text AS cou_path
      FROM project p
      JOIN org_unit cou ON cou.id = p.cost_owning_unit_id
      WHERE p.id = ${id}::uuid
      LIMIT 1
    `)
    const proj = [...projRows][0]
    if (!proj) {
      throw createError({ statusCode: 404, statusMessage: 'Project not found' })
    }
    await assertProjectScope(event, { regionId: proj.region_id, couPath: proj.cou_path }, tx)

    // End the open assignment range at now().
    const ended = await tx.execute<{ id: string }>(sql`
      UPDATE project_assignment
      SET effective = tstzrange(lower(effective), NOW())
      WHERE project_id = ${id}::uuid AND teammate_id = ${teammateId}::uuid AND upper_inf(effective)
      RETURNING id::text AS id
    `)
    if (![...ended][0]) {
      throw createError({ statusCode: 404, statusMessage: 'Active assignment not found' })
    }

    // Drop any per-dev cap for this teammate on this project — a cap is
    // meaningless once they're unassigned, and leaving it would skew the
    // sum(caps) <= pool check on the next split.
    await tx.execute(sql`
      DELETE FROM allocation
      WHERE scope_type = 'project' AND scope_id = ${id}::uuid AND teammate_id = ${teammateId}::uuid
    `)

    // API-3: membership changes gate budgets and tagging — record WHO did it.
    await recordAuditEvent(tx, {
      eventType: 'project-member-removed',
      actorTeammateId: caller.teammateId,
      subjectKind: 'project',
      subjectId: id,
      payload: { teammate_id: teammateId },
      ipAddress: ip,
      userAgent: ua,
    })

    setResponseStatus(event, 204)
    return null
  })
})
