/*
 * DELETE /api/v1/admin/directory-region-rules/{id} — remove a directory placement
 * rule (mig 0089 + the mig 0112 unit target). HARD delete: rules are curated
 * CONFIG, not history.
 *
 * Creating a rule is platform-admin only (directory-region-rules.post.ts).
 * Deleting stays region-scoped for unit rules, so a region admin can remove a
 * unit rule that feeds their own region but cannot recreate it:
 *
 *   REGION rule  cross-region placement config → GLOBAL roles only.
 *   UNIT rule    `admin` with requireRegionScope over the unit's region, or a
 *                global role.
 *
 * The row is READ AND LOCKED before the authorisation decision, because the
 * decision is about that row's target. Deleting first and asking afterwards would
 * be a check on something already gone.
 */
import { defineEventHandler, createError, getRouterParam, getRequestIP, getHeader } from 'h3'
import { sql } from 'drizzle-orm'
import { z } from 'zod'
import { requireRole, requireRegionScope } from '../../../../auth/rbac'
import { assertSameOrigin } from '../../../../auth/csrf'
import { withRequestRls } from '../../../../db/request-rls'
import { recordAuditEvent } from '../../../../db/audit'
import { isPlatformAdmin } from '../../../../../shared/auth/roles'

export default defineEventHandler(async (event) => {
  const caller = await requireRole(event, 'admin')
  assertSameOrigin(event)
  const id = z.string().uuid().safeParse(getRouterParam(event, 'id'))
  if (!id.success) throw createError({ statusCode: 400, statusMessage: 'Invalid rule id' })
  const orgWide = isPlatformAdmin(caller.role)
  const ip = getRequestIP(event, { xForwardedFor: true }) ?? null
  const ua = getHeader(event, 'user-agent') ?? null

  return await withRequestRls(event, async (tx) => {
    const found = await tx.execute<{
      id: string
      attribute: string
      match_value: string
      region_id: string
      org_unit_id: string | null
    }>(sql`
      SELECT id::text AS id, attribute, match_value, region_id::text AS region_id,
             org_unit_id::text AS org_unit_id
      FROM directory_region_rule WHERE id = ${id.data}::uuid LIMIT 1 FOR UPDATE
    `)
    const rule = [...found][0]
    if (!rule) throw createError({ statusCode: 404, statusMessage: 'No such rule' })

    if (!orgWide) {
      if (!rule.org_unit_id) {
        const detail =
          'That is an org-wide region rule — removing it changes which region everyone matching it lands in, so it takes global finance access.'
        throw createError({
          statusCode: 403,
          statusMessage: detail,
          data: {
            type: 'https://tokenscope.example.com/errors/forbidden',
            title: 'Forbidden',
            status: 403,
            detail,
          },
        })
      }
      await requireRegionScope(event, rule.region_id)
    }

    await tx.execute(sql`DELETE FROM directory_region_rule WHERE id = ${rule.id}::uuid`)

    await recordAuditEvent(tx, {
      eventType: 'region-rule-removed',
      actorTeammateId: caller.teammateId,
      subjectKind: 'directory_region_rule',
      subjectId: rule.id,
      payload: {
        attribute: rule.attribute,
        match_value: rule.match_value,
        region_id: rule.region_id,
        org_unit_id: rule.org_unit_id,
      },
      ipAddress: ip,
      userAgent: ua,
    })

    return { removed: true, id: rule.id }
  })
})
