/*
 * POST /api/v1/admin/reconciliation/enterprises/{id}/copilot-rate-plans —
 * create a new effective-dated Copilot rate plan (ADR-0011 D9, design §5.3).
 *
 * Body (zod): { validFrom: ISO date/timestamp, validTo?: ISO date/timestamp | null,
 *   flatSeatPriceUsd?: number | null, includedAllowanceUsd?: number | null, notes?: string }.
 *
 * FORECAST/SHOWBACK input ONLY — never reconstructs copilot_pool_bill's bill-anchored
 * license/overage figures (those stay read straight off the enterprise billing usage
 * report). Non-overlapping per enterprise: a live open-ended plan starting before
 * `validFrom` is auto-truncated to end at `validFrom` in the SAME audited write (the
 * ordinary "this plan supersedes the current one" workflow); any OTHER overlap 409s.
 *
 * RBAC: requireRole(platform-admin) + assertSameOrigin. Audited.
 */
import { defineEventHandler, createError, getRequestIP, getHeader } from 'h3'
import { sql } from 'drizzle-orm'
import { z } from 'zod'
import { requireRole } from '../../../../../../auth/rbac'
import { assertSameOrigin } from '../../../../../../auth/csrf'
import { withRequestRls } from '../../../../../../db/request-rls'
import { requireUuidParam } from '../../../../../../utils/require-uuid-param'
import { readValidated } from '../../../../../../utils/validated-body'
import {
  createCopilotRatePlan,
  CopilotRatePlanError,
} from '../../../../../../governance/copilot-rate-plan'

const Body = z.object({
  validFrom: z.string().datetime({ offset: true }).or(z.string().regex(/^\d{4}-\d{2}-\d{2}$/)),
  validTo: z
    .string()
    .datetime({ offset: true })
    .or(z.string().regex(/^\d{4}-\d{2}-\d{2}$/))
    .nullish(),
  flatSeatPriceUsd: z.number().min(0).max(1_000_000).nullish(),
  includedAllowanceUsd: z.number().min(0).max(1_000_000).nullish(),
  notes: z.string().max(2000).nullish(),
})

export default defineEventHandler(async (event) => {
  // provider_enterprise has no region column, so platform-admin is the only clamp.
  const caller = await requireRole(event, 'platform-admin')
  assertSameOrigin(event)
  const providerEnterpriseId = requireUuidParam(event, 'id', 'provider-enterprise id')
  const body = await readValidated(event, Body)
  const ip = getRequestIP(event, { xForwardedFor: true }) ?? null
  const ua = getHeader(event, 'user-agent') ?? null

  return withRequestRls(event, async (tx) => {
    const ent = await tx.execute<{ id: string }>(
      sql`SELECT id::text AS id FROM provider_enterprise WHERE id = ${providerEnterpriseId}::uuid`,
    )
    if (!ent[0]) {
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

    try {
      const result = await createCopilotRatePlan(tx, {
        providerEnterpriseId,
        validFrom: body.validFrom,
        validTo: body.validTo ?? null,
        flatSeatPriceUsd: body.flatSeatPriceUsd ?? null,
        includedAllowanceUsd: body.includedAllowanceUsd ?? null,
        notes: body.notes ?? null,
        actorTeammateId: caller.teammateId,
        ipAddress: ip,
        userAgent: ua,
      })
      return result
    } catch (err) {
      if (err instanceof CopilotRatePlanError) {
        throw createError({
          statusCode: 400,
          statusMessage: 'Invalid Copilot rate plan',
          data: {
            type: 'https://tokenscope.example.com/errors/validation',
            title: 'Invalid Copilot rate plan',
            status: 400,
            detail: err.message,
          },
        })
      }
      throw err
    }
  })
})
