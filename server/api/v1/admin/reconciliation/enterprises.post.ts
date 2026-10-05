/*
 * POST /api/v1/admin/reconciliation/enterprises — create a provider_enterprise.
 *
 * Body (zod): { provider, externalId, displayName, reconciliationMode?, billing?,
 *   credentialSecretName?, notes? }.
 *
 * external_id is stored LOWERCASE per mig 0062's CHECK (and the lower(external_id)
 * UNIQUE). canonicaliseExternalId AUTO-LOWERCASES an anthropic org id (case-
 * insensitive) but REJECTS a mixed-case github slug loudly — the slug is part of
 * the credential lane key, so silently rewriting it could mis-route attribution.
 * credential_secret_name charset ^[a-z0-9-]{3,64}$. UNIQUE (provider,
 * lower(external_id)) → 409.
 *
 * RBAC: requireRole(platform-admin) + assertSameOrigin. Audited.
 */
import { defineEventHandler, createError, getRequestIP, getHeader } from 'h3'
import { readValidated } from '../../../../utils/validated-body'
import { sql } from 'drizzle-orm'
import { z } from 'zod'
import { requireRole } from '../../../../auth/rbac'
import { assertSameOrigin } from '../../../../auth/csrf'
import { withRequestRls } from '../../../../db/request-rls'
import { recordAuditEvent } from '../../../../db/audit'
import { translatePgConstraintError } from '../../../../utils/pg-constraint-error'
import { providerEnterprise } from '../../../../../drizzle/schema'
import { resweepProviderEnterpriseReferences } from '../../../../workers/governance-key-backfill'
import {
  providerSchema,
  reconciliationModeSchema,
  billingSchema,
  overageAllocationPolicySchema,
  credentialSecretNameSchema,
  githubAppIdSchema,
  canonicaliseExternalId,
} from '../../../../reconciliation/provider-validation'
import { seedInitialCopilotRatePlan } from '../../../../governance/copilot-rate-plan'

const Body = z.object({
  provider: providerSchema,
  externalId: z.string().min(1).max(200),
  displayName: z.string().min(1).max(200),
  reconciliationMode: reconciliationModeSchema.optional().default('indicative'),
  billing: billingSchema.optional().default('tracked'),
  credentialSecretName: credentialSecretNameSchema.nullish(),
  // ADR-0010 D1/D2 (Copilot/GitHub): whole-month flat seat price + per-user allowance, USD.
  // FORECAST/SHOWBACK reference only — see server/governance/copilot-rate-plan.ts.
  flatSeatPriceUsd: z.number().min(0).max(1_000_000).nullish(),
  includedAllowanceUsd: z.number().min(0).max(1_000_000).nullish(),
  // ADR-0011 D10 — configurable per-enterprise pooled-overage allocation policy.
  overageAllocationPolicy: overageAllocationPolicySchema.optional().default('consumption-share'),
  // Optional GitHub App id (mig 0078) — opts a github enterprise into the App
  // credential path. Validated ^\d+$. anthropic must not carry one (rejected below).
  githubAppId: githubAppIdSchema.nullish(),
  notes: z.string().max(2000).nullish(),
})

function badRequest(detail: string): never {
  throw createError({
    statusCode: 400,
    statusMessage: 'Invalid provider enterprise',
    data: {
      type: 'https://tokenscope.example.com/errors/validation',
      title: 'Invalid provider enterprise',
      status: 400,
      detail,
    },
  })
}

export default defineEventHandler(async (event) => {
  // provider_enterprise has no region column, so platform-admin is the only clamp.
  const caller = await requireRole(event, 'platform-admin')
  assertSameOrigin(event)
  const body = await readValidated(event, Body)
  const ip = getRequestIP(event, { xForwardedFor: true }) ?? null
  const ua = getHeader(event, 'user-agent') ?? null

  const canon = canonicaliseExternalId(body.provider, body.externalId)
  if ('error' in canon) badRequest(canon.error)
  const externalId = canon.value
  const credentialSecretName = body.credentialSecretName ?? null
  // App mode is a GitHub-only concept (the App-id pairs with an installed GitHub App).
  // Reject it on an anthropic enterprise loudly rather than store a dead pointer.
  const githubAppId = body.githubAppId ?? null
  if (githubAppId && body.provider !== 'github') {
    badRequest('github_app_id is only valid for a github enterprise')
  }

  return await withRequestRls(event, async (tx) => {
    // Pre-check the case-insensitive UNIQUE for a clean 409 (insert keeps the
    // constraint as the race backstop, translated below).
    const dupe = await tx.execute<{ id: string }>(sql`
      SELECT id::text AS id FROM provider_enterprise
      WHERE provider = ${body.provider} AND lower(external_id) = lower(${externalId})
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
          detail: `A ${body.provider} enterprise with external_id '${externalId}' already exists.`,
        },
      })
    }

    let created: { id: string } | undefined
    try {
      ;[created] = await tx
        .insert(providerEnterprise)
        .values({
          provider: body.provider,
          externalId,
          displayName: body.displayName,
          reconciliationMode: body.reconciliationMode,
          billing: body.billing,
          credentialSecretName,
          flatSeatPriceUsd: body.flatSeatPriceUsd != null ? body.flatSeatPriceUsd.toFixed(6) : null,
          includedAllowanceUsd: body.includedAllowanceUsd != null ? body.includedAllowanceUsd.toFixed(6) : null,
          overageAllocationPolicy: body.overageAllocationPolicy,
          githubAppId,
          notes: body.notes ?? null,
        })
        .returning({ id: providerEnterprise.id })
    } catch (err: unknown) {
      translatePgConstraintError(err, {
        '23505': {
          title: 'Provider enterprise already exists',
          detail: `A ${body.provider} enterprise with external_id '${externalId}' already exists.`,
        },
      })
    }

    // Workstream C: seed the enterprise's FIRST effective-dated rate plan (open-ended, from
    // the values supplied at creation) in the SAME audited write — keeps every enterprise
    // covered from day one, matching migration 0106's backfill for pre-existing rows. A no-op
    // (returns null) when neither scalar value was supplied.
    const seededRatePlan = await seedInitialCopilotRatePlan(tx, {
      providerEnterpriseId: created!.id,
      flatSeatPriceUsd: body.flatSeatPriceUsd ?? null,
      includedAllowanceUsd: body.includedAllowanceUsd ?? null,
      actorTeammateId: caller.teammateId,
      ipAddress: ip,
      userAgent: ua,
    })

    await recordAuditEvent(tx, {
      eventType: 'provider-enterprise-created',
      actorTeammateId: caller.teammateId,
      subjectKind: 'provider-enterprise',
      subjectId: created!.id,
      payload: {
        provider: body.provider,
        external_id: externalId,
        display_name: body.displayName,
        reconciliation_mode: body.reconciliationMode,
        billing: body.billing,
        credential_secret_name: credentialSecretName,
        flat_seat_price_usd: body.flatSeatPriceUsd ?? null,
        included_allowance_usd: body.includedAllowanceUsd ?? null,
        overage_allocation_policy: body.overageAllocationPolicy,
        github_app_id: githubAppId,
        notes: body.notes ?? null,
        seeded_rate_plan_id: seededRatePlan?.id ?? null,
      },
      ipAddress: ip,
      userAgent: ua,
    })

    return {
      id: created!.id,
      provider: body.provider,
      externalId,
      displayName: body.displayName,
      reconciliationMode: body.reconciliationMode,
      billing: body.billing,
      flatSeatPriceUsd: body.flatSeatPriceUsd ?? null,
      includedAllowanceUsd: body.includedAllowanceUsd ?? null,
      overageAllocationPolicy: body.overageAllocationPolicy,
      githubAppId,
      // Targeted governance-key resweep (design §8.4) — github only (anthropic
      // enterprises are grouping parents; the org itself is the governance
      // unit there, so reconciliation_record's enterprise_ref match is
      // github-specific — see resweepProviderEnterpriseReferences).
      /*
       * SCOPE IS ALREADY EXPLICIT, AND THIS MUST STAY IN THE TRANSACTION
       * (docs/design/rls-enforcement.md §2, "the six handlers"). Unlike the
       * Copilot bill re-pull, this is not an estate-wide worker inheriting a
       * caller's region: resweepProviderEnterpriseReferences takes the
       * enterprise id and slug as ARGUMENTS and every predicate it builds is
       * keyed on them — there is no ambient region for a region-scoped `admin`
       * to narrow. Its two tables (reconciliation_record, actual_spend) have no
       * RLS enabled either, so no FORCE phase in §6 reaches them.
       *
       * It also cannot move to the worker lane: it resolves rows against the
       * provider_enterprise row INSERTed above, which is not visible on any
       * other connection until this transaction commits.
       */
      governanceResweep:
        body.provider === 'github'
          ? await resweepProviderEnterpriseReferences(tx, { providerEnterpriseId: created!.id, externalId })
          : null,
    }
  })
})
