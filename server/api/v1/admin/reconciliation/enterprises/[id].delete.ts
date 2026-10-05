/*
 * DELETE /api/v1/admin/reconciliation/enterprises/{id} — hard-delete a
 * provider_enterprise.
 *
 * provider_org.provider_enterprise_id FKs to this table, so deleting an enterprise
 * that STILL has linked orgs would either raise a raw 23503 or silently strip those
 * orgs of their credential lane. We BLOCK that with a clean 409 (the operator must
 * first re-link or delete the child orgs). With no linked orgs the delete is safe —
 * it only de-registers the credential-custody unit; historical records are untouched.
 *
 * RBAC: requireRole(platform-admin) + assertSameOrigin. Audited. Unknown id
 * → 404; malformed id → 400 (requireUuidParam).
 */
import { defineEventHandler, createError, getRequestIP, getHeader } from 'h3'
import { sql } from 'drizzle-orm'
import { requireRole } from '../../../../../auth/rbac'
import { assertSameOrigin } from '../../../../../auth/csrf'
import { withRequestRls } from '../../../../../db/request-rls'
import { recordAuditEvent } from '../../../../../db/audit'
import { requireUuidParam } from '../../../../../utils/require-uuid-param'
import { translatePgConstraintError } from '../../../../../utils/pg-constraint-error'

interface CurrentRow extends Record<string, unknown> {
  provider: string
  external_id: string
  display_name: string
  org_count: string
}

export default defineEventHandler(async (event) => {
  // provider_enterprise has no region column, so platform-admin is the only clamp.
  const caller = await requireRole(event, 'platform-admin')
  assertSameOrigin(event)
  const id = requireUuidParam(event, 'id', 'provider-enterprise id')
  const ip = getRequestIP(event, { xForwardedFor: true }) ?? null
  const ua = getHeader(event, 'user-agent') ?? null

  return await withRequestRls(event, async (tx) => {
    const rows = await tx.execute<CurrentRow>(sql`
      SELECT pe.provider, pe.external_id, pe.display_name,
             (SELECT COUNT(*) FROM provider_org po WHERE po.provider_enterprise_id = pe.id)::text
               AS org_count
      FROM provider_enterprise pe WHERE pe.id = ${id}::uuid LIMIT 1
    `)
    const cur = [...rows][0]
    if (!cur) {
      throw createError({
        statusCode: 404,
        statusMessage: 'Provider enterprise not found',
        data: {
          type: 'https://tokenscope.example.com/errors/not-found',
          title: 'Provider enterprise not found',
          status: 404,
          detail: 'No provider_enterprise matches the supplied id.',
        },
      })
    }
    const orgCount = Number(cur.org_count)
    if (orgCount > 0) {
      throw createError({
        statusCode: 409,
        statusMessage: 'Enterprise has linked orgs',
        data: {
          type: 'https://tokenscope.example.com/errors/conflict',
          title: 'Enterprise has linked orgs',
          status: 409,
          detail: `This enterprise still has ${orgCount} linked org(s). Re-link or delete them before deleting the enterprise.`,
        },
      })
    }

    // No linked orgs → safe to delete. The org_count was read in the same tx, so a
    // concurrently-linked org is caught by the FK 23503 — wrapped to a clean 409 (the
    // 409 above is the expected path; this is the rare-race backstop, not a 500).
    let deleted: Awaited<ReturnType<typeof tx.execute<{ id: string }>>>
    try {
      deleted = await tx.execute<{ id: string }>(sql`
        DELETE FROM provider_enterprise WHERE id = ${id}::uuid RETURNING id::text AS id
      `)
    } catch (err: unknown) {
      translatePgConstraintError(err, {
        '23503': {
          title: 'Enterprise has linked orgs',
          detail:
            'An org was linked to this enterprise concurrently. Re-link or delete it before deleting the enterprise.',
        },
      })
    }
    if (![...deleted][0]) {
      // Deleted out from under us between the read and here.
      throw createError({
        statusCode: 404,
        statusMessage: 'Provider enterprise not found',
        data: {
          type: 'https://tokenscope.example.com/errors/not-found',
          title: 'Provider enterprise not found',
          status: 404,
          detail: 'No provider_enterprise matches the supplied id.',
        },
      })
    }

    await recordAuditEvent(tx, {
      eventType: 'provider-enterprise-deleted',
      actorTeammateId: caller.teammateId,
      subjectKind: 'provider-enterprise',
      subjectId: id,
      payload: {
        provider: cur.provider,
        external_id: cur.external_id,
        display_name: cur.display_name,
      },
      ipAddress: ip,
      userAgent: ua,
    })

    return { id, deleted: true }
  })
})
