/*
 * DELETE /api/v1/admin/reconciliation/orgs/{id} — hard-delete a provider_org.
 *
 * provider_org is a LEAF in the FK graph (the reconciliation/attribution paths
 * resolve an org by its (provider, external_org_id) text key at read time — they
 * do NOT hold an FK to provider_org.id), so a hard delete orphans no rows. It
 * only de-registers the org: future events carrying that organization.id fall
 * back to the 'unknown' lane (telemetry-only) until it is re-onboarded. Historical
 * reconciliation/attribution records are untouched (they pin their own ids/text).
 *
 * RBAC: requireRole(admin) + assertSameOrigin. Audited. Unknown
 * id → 404; malformed id → 400 (requireUuidParam).
 *
 * Region-scope: DELETE … RETURNING stays the atomic exists-check (no TOCTOU
 * between a SELECT and the delete) — region_id rides along in the RETURNING
 * list and requireRegionScope runs AFTER the row is known (mirrors
 * admin/grants/index.get.ts's resolve → 404-on-unknown → requireRegionScope
 * shape), so an unknown id still 404s and this never becomes an existence
 * oracle for other regions' org ids. Because the delete has already executed
 * by the time the scope check runs, a denial's throw is left UNCAUGHT: it
 * propagates out of withRequestRls's callback, and withRequestRls runs inside
 * db.transaction, so the uncaught throw rolls the delete back — the row
 * survives a denied delete. An unmapped org (region_id IS NULL) is
 * estate-level: platform-admin only (403 otherwise).
 */
import { defineEventHandler, createError, getRequestIP, getHeader } from 'h3'
import { sql } from 'drizzle-orm'
import { requireRole, requireRegionScopeOrNotFound } from '../../../../../auth/rbac'
import { isPlatformAdmin } from '../../../../../../shared/auth/roles'
import { assertSameOrigin } from '../../../../../auth/csrf'
import { withRequestRls } from '../../../../../db/request-rls'
import { recordAuditEvent } from '../../../../../db/audit'
import { requireUuidParam } from '../../../../../utils/require-uuid-param'

interface DeletedRow extends Record<string, unknown> {
  provider: string
  external_org_id: string
  display_name: string
  region_id: string | null
}

export default defineEventHandler(async (event) => {
  const caller = await requireRole(event, 'admin')
  assertSameOrigin(event)
  const id = requireUuidParam(event, 'id', 'provider-org id')
  const ip = getRequestIP(event, { xForwardedFor: true }) ?? null
  const ua = getHeader(event, 'user-agent') ?? null

  return await withRequestRls(event, async (tx) => {
    // DELETE … RETURNING is the atomic exists-check (no TOCTOU between a SELECT
    // and the delete); zero rows → 404.
    const deleted = await tx.execute<DeletedRow>(sql`
      DELETE FROM provider_org WHERE id = ${id}::uuid
      RETURNING provider, external_org_id, display_name, region_id::text AS region_id
    `)
    const row = [...deleted][0]
    // ONE factory, thrown by both the unknown-id path and the region-denied path
    // below, so the two are byte-identical rather than merely both-404. Two
    // similar-looking literals would drift and re-open the oracle.
    const notFound = () =>
      createError({
        statusCode: 404,
        statusMessage: 'Provider org not found',
        data: {
          type: 'https://tokenscope.example.com/errors/not-found',
          title: 'Provider org not found',
          status: 404,
          detail: 'No provider_org matches the supplied id.',
        },
      })
    if (!row) throw notFound()

    // Region-scope AFTER the row is known: an unmapped org (region_id NULL) is
    // estate-level, so platform-admin only. A DENY here throws uncaught — the
    // transaction this callback runs in rolls back the DELETE above.
    //
    // The denial is the SAME 404 an unknown id gets (PR #204 review): a
    // 403-for-foreign-region beside a 404-for-unknown is an existence oracle,
    // and this handler's own header promises it is not one. Resolving first and
    // scoping second removes the oracle only if BOTH outcomes look identical.
    if (row.region_id) await requireRegionScopeOrNotFound(event, row.region_id, notFound())
    else if (!isPlatformAdmin(caller.role)) {
      throw createError({
        statusCode: 403,
        statusMessage: 'Forbidden',
        data: {
          type: 'https://tokenscope.example.com/errors/forbidden',
          title: 'Forbidden',
          status: 403,
          detail: 'An unmapped provider org (no region) is estate-wide; only platform-admin may write it.',
        },
      })
    }

    await recordAuditEvent(tx, {
      eventType: 'provider-org-deleted',
      actorTeammateId: caller.teammateId,
      subjectKind: 'provider-org',
      subjectId: id,
      payload: {
        provider: row.provider,
        external_org_id: row.external_org_id,
        display_name: row.display_name,
      },
      ipAddress: ip,
      userAgent: ua,
    })

    return { id, deleted: true }
  })
})
