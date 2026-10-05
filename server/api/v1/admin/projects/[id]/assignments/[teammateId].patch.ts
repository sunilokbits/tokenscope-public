/*
 * PATCH /api/v1/admin/projects/{id}/assignments/{teammateId} — change a
 * member's assignment role (member ↔ manager) on their OPEN assignment.
 *
 * J2 (mig 0048): 'manager' = PM, may manage this project's budget
 * top-ups. Same scope as the sibling POST/DELETE: manager / admin /
 * platform-admin, bound to the project (admin → region, manager → org
 * subtree). PMs cannot promote/demote — role designation stays an
 * org-role action so a PM can't mint other PMs.
 */
import { defineEventHandler, createError, getRequestIP, getHeader } from 'h3'
import { readValidated } from '../../../../../../utils/validated-body'
import { sql } from 'drizzle-orm'
import { z } from 'zod'
import { requireRole } from '../../../../../../auth/rbac'
import { assertProjectScope } from '../../../../../../auth/project-scope'
import { assertSameOrigin } from '../../../../../../auth/csrf'
import { withRequestRls } from '../../../../../../db/request-rls'
import { recordAuditEvent } from '../../../../../../db/audit'
import { requireUuidParam } from '../../../../../../utils/require-uuid-param'

const Body = z.object({
  role: z.enum(['manager', 'member']),
})

export default defineEventHandler(async (event) => {
  const caller = await requireRole(event, 'manager', 'admin')
  assertSameOrigin(event)
  const id = requireUuidParam(event, 'id', 'project id')
  const teammateId = requireUuidParam(event, 'teammateId', 'teammate id')
  const body = await readValidated(event, Body)
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

    const updated = await tx.execute<{ id: string; prior_role: string }>(sql`
      UPDATE project_assignment pa
      SET role = ${body.role}
      FROM (
        SELECT id, role AS prior_role FROM project_assignment
        WHERE project_id = ${id}::uuid
          AND teammate_id = ${teammateId}::uuid
          AND effective @> now()
        LIMIT 1
      ) cur
      WHERE pa.id = cur.id
      RETURNING pa.id::text AS id, cur.prior_role
    `)
    const row = [...updated][0]
    if (!row) {
      throw createError({ statusCode: 404, statusMessage: 'No open assignment for this teammate' })
    }

    if (row.prior_role !== body.role) {
      await recordAuditEvent(tx, {
        eventType: 'project-member-role-changed',
        actorTeammateId: caller.teammateId,
        subjectKind: 'project',
        subjectId: id,
        payload: { teammate_id: teammateId, before: row.prior_role, after: body.role },
        ipAddress: ip,
        userAgent: ua,
      })
    }

    return { id: row.id, teammate_id: teammateId, role: body.role }
  })
})
