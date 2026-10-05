/*
 * PATCH /api/v1/admin/reconciliation/enterprises/{id} — update a
 * provider_enterprise's mutable fields: externalId, displayName,
 * reconciliationMode, billing, credentialSecretName, notes.
 *
 * provider is IMMUTABLE (it flips the credential env-prefix + the api_kind
 * relationship of any linked orgs). externalId, when supplied, is re-canonicalised
 * the same way as create (anthropic auto-lowercase; github mixed-case rejected) so
 * the mig-0062 lowercase CHECK never trips, and the case-insensitive UNIQUE is
 * pre-checked for a clean 409.
 *
 * RBAC: requireRole(platform-admin) + assertSameOrigin. Audited.
 */
import { defineEventHandler, createError, getRequestIP, getHeader } from 'h3'
import { readValidated } from '../../../../../utils/validated-body'
import { sql } from 'drizzle-orm'
import { z } from 'zod'
import { requireRole } from '../../../../../auth/rbac'
import { assertSameOrigin } from '../../../../../auth/csrf'
import { withRequestRls } from '../../../../../db/request-rls'
import { recordAuditEvent } from '../../../../../db/audit'
import { recomputeGovernanceVerdicts } from '../../../../../governance/recompute'
import { persistCopilotOverageAllocation } from '../../../../../governance/copilot-overage-allocation'
import { lockGovernanceCutoverForBillingEdit } from '../../../../../governance/cutover'
import { requireUuidParam } from '../../../../../utils/require-uuid-param'
import { translatePgConstraintError } from '../../../../../utils/pg-constraint-error'
import {
  reconciliationModeSchema,
  billingSchema,
  overageAllocationPolicySchema,
  credentialSecretNameSchema,
  githubAppIdSchema,
  canonicaliseExternalId,
  type Provider,
} from '../../../../../reconciliation/provider-validation'

const Body = z
  .object({
    externalId: z.string().min(1).max(200).optional(),
    displayName: z.string().min(1).max(200).optional(),
    reconciliationMode: reconciliationModeSchema.optional(),
    billing: billingSchema.optional(),
    credentialSecretName: credentialSecretNameSchema.nullish(),
    // ADR-0010 D1/D2 (Copilot only): whole-month flat seat price + per-user included
    // allowance, both USD. null clears (disables that bill component). FORECAST/SHOWBACK
    // reference only — see server/governance/copilot-rate-plan.ts for the period-aware,
    // effective-dated source computations actually use.
    flatSeatPriceUsd: z.number().min(0).max(1_000_000).nullish(),
    includedAllowanceUsd: z.number().min(0).max(1_000_000).nullish(),
    // ADR-0011 D10 — configurable per-enterprise pooled-overage allocation policy.
    overageAllocationPolicy: overageAllocationPolicySchema.optional(),
    // Optional GitHub App id (mig 0078). Supply to opt into App mode; supply null to
    // clear it (revert to PAT). Absent key = unchanged. github-only (enforced below).
    githubAppId: githubAppIdSchema.nullish(),
    notes: z.string().max(2000).nullish(),
  })
  .refine((d) => Object.keys(d).length > 0, 'at least one field must be supplied')

function badRequest(detail: string): never {
  throw createError({
    statusCode: 400,
    statusMessage: 'Invalid provider enterprise update',
    data: {
      type: 'https://tokenscope.example.com/errors/validation',
      title: 'Invalid provider enterprise update',
      status: 400,
      detail,
    },
  })
}

interface CurrentRow extends Record<string, unknown> {
  provider: string
  external_id: string
}

export default defineEventHandler(async (event) => {
  // provider_enterprise has no region column, so platform-admin is the only clamp.
  const caller = await requireRole(event, 'platform-admin')
  assertSameOrigin(event)
  const id = requireUuidParam(event, 'id', 'provider-enterprise id')
  const body = await readValidated(event, Body)
  const ip = getRequestIP(event, { xForwardedFor: true }) ?? null
  const ua = getHeader(event, 'user-agent') ?? null

  const has = (k: keyof typeof body) => Object.prototype.hasOwnProperty.call(body, k)

  return await withRequestRls(event, async (tx) => {
    if (has('billing')) {
      await lockGovernanceCutoverForBillingEdit(tx)
    }
    const rows = await tx.execute<CurrentRow>(sql`
      SELECT provider, external_id FROM provider_enterprise WHERE id = ${id}::uuid LIMIT 1
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
    const provider = cur.provider as Provider

    // App mode is github-only (the App-id pairs with an installed GitHub App). Reject a
    // non-null github_app_id on an anthropic enterprise loudly. (A null is always fine —
    // it clears App mode.)
    if (has('githubAppId') && body.githubAppId != null && provider !== 'github') {
      badRequest('github_app_id is only valid for a github enterprise')
    }

    let nextExternalId = cur.external_id
    if (has('externalId')) {
      const canon = canonicaliseExternalId(provider, body.externalId!)
      if ('error' in canon) badRequest(canon.error)
      nextExternalId = canon.value
      // Pre-check the case-insensitive UNIQUE against OTHER rows (exclude self).
      const dupe = await tx.execute<{ id: string }>(sql`
        SELECT id::text AS id FROM provider_enterprise
        WHERE provider = ${provider}
          AND lower(external_id) = lower(${nextExternalId})
          AND id <> ${id}::uuid
        LIMIT 1
      `)
      if ([...dupe][0]) {
        throw createError({
          statusCode: 409,
          statusMessage: 'Provider enterprise already exists',
          data: {
            type: 'https://tokenscope.example.com/errors/conflict',
            title: 'Provider enterprise already exists',
            status: 409,
            detail: `A ${provider} enterprise with external_id '${nextExternalId}' already exists.`,
          },
        })
      }
    }

    const sets = []
    if (has('externalId')) sets.push(sql`external_id = ${nextExternalId}`)
    if (has('displayName')) sets.push(sql`display_name = ${body.displayName}`)
    if (has('reconciliationMode')) sets.push(sql`reconciliation_mode = ${body.reconciliationMode}`)
    if (has('billing')) sets.push(sql`billing = ${body.billing}`)
    if (has('credentialSecretName'))
      sets.push(sql`credential_secret_name = ${body.credentialSecretName ?? null}`)
    // Bind money as a fixed-scale STRING, not a JS float, into numeric(14,6) — float
    // artifacts (e.g. 39.1) have no place in a finance column.
    if (has('flatSeatPriceUsd'))
      sets.push(sql`flat_seat_price_usd = ${body.flatSeatPriceUsd != null ? body.flatSeatPriceUsd.toFixed(6) : null}::numeric`)
    if (has('includedAllowanceUsd'))
      sets.push(sql`included_allowance_usd = ${body.includedAllowanceUsd != null ? body.includedAllowanceUsd.toFixed(6) : null}::numeric`)
    if (has('overageAllocationPolicy'))
      sets.push(sql`overage_allocation_policy = ${body.overageAllocationPolicy}`)
    if (has('githubAppId')) sets.push(sql`github_app_id = ${body.githubAppId ?? null}`)
    if (has('notes')) sets.push(sql`notes = ${body.notes ?? null}`)

    try {
      await tx.execute(sql`
        UPDATE provider_enterprise SET ${sql.join(sets, sql`, `)} WHERE id = ${id}::uuid
      `)
    } catch (err: unknown) {
      translatePgConstraintError(err, {
        '23505': {
          title: 'Provider enterprise already exists',
          detail: `A ${provider} enterprise with external_id '${nextExternalId}' already exists.`,
        },
      })
    }

    await recordAuditEvent(tx, {
      eventType: 'provider-enterprise-updated',
      actorTeammateId: caller.teammateId,
      subjectKind: 'provider-enterprise',
      subjectId: id,
      payload: {
        provider,
        changed: {
          ...(has('externalId') ? { external_id: nextExternalId } : {}),
          ...(has('displayName') ? { display_name: body.displayName } : {}),
          ...(has('reconciliationMode') ? { reconciliation_mode: body.reconciliationMode } : {}),
          ...(has('billing') ? { billing: body.billing } : {}),
          ...(has('credentialSecretName')
            ? { credential_secret_name: body.credentialSecretName ?? null }
            : {}),
          ...(has('flatSeatPriceUsd') ? { flat_seat_price_usd: body.flatSeatPriceUsd ?? null } : {}),
          ...(has('includedAllowanceUsd')
            ? { included_allowance_usd: body.includedAllowanceUsd ?? null }
            : {}),
          ...(has('overageAllocationPolicy')
            ? { overage_allocation_policy: body.overageAllocationPolicy }
            : {}),
          ...(has('githubAppId') ? { github_app_id: body.githubAppId ?? null } : {}),
          ...(has('notes') ? { notes: body.notes ?? null } : {}),
        },
      },
      ipAddress: ip,
      userAgent: ua,
    })

    // A `billing` edit must change chargeability for every OPEN-period row
    // this enterprise governs, IMMEDIATELY (design §4.1 "governance edits take
    // effect immediately") — never wait for the next worker tick. Closed
    // periods are structurally excluded by recomputeGovernanceVerdicts itself.
    // Pre-activation this is a no-op (the legacy heuristic ignores `billing`
    // entirely), matching today's behaviour exactly.
    if (has('billing')) {
      await recomputeGovernanceVerdicts(tx, { providerEnterpriseId: id })
    }

    // ADR-0011 D7 ("dead governance is a defect... ships with the reader that
    // consumes it"): an `overageAllocationPolicy` edit must change the persisted
    // distribution for every month this enterprise already has a bill for,
    // immediately — never wait for the next bill-refresh tick.
    //
    // EVERY month, including recorded ones. This used to skip closed months on
    // the grounds that persistCopilotOverageAllocation would refuse them anyway;
    // it no longer refuses, because a policy edit that cannot reach the months
    // it applies to is a policy edit that silently did not happen. A recorded
    // month that moves reports its delta.
    if (has('overageAllocationPolicy')) {
      const months = await tx.execute<{ month: string }>(sql`
        SELECT DISTINCT b.month::text AS month
        FROM copilot_pool_bill b
        WHERE b.provider_enterprise_id = ${id}::uuid
        ORDER BY month
      `)
      for (const m of months) {
        await persistCopilotOverageAllocation(tx, {
          providerEnterpriseId: id,
          enterpriseExternalId: nextExternalId,
          month: m.month,
          actorTeammateId: caller.teammateId,
          ipAddress: ip,
          userAgent: ua,
        })
      }
    }

    return { id, updated: true }
  })
})
