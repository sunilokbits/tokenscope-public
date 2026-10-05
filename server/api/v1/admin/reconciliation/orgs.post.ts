/*
 * POST /api/v1/admin/reconciliation/orgs — create / link a provider_org for
 * either provider. Replaces the brittle seed.ts template rows with an audited,
 * validated onboarding path.
 *
 * Body (zod): { provider, externalOrgId, displayName, reconciliationMode,
 *   billing?, apiKind?, credentialSecretName?, providerEnterpriseId?, notes? }.
 *
 * Invariants enforced (so the DB CHECKs surface as clean 400s, never raw 500s):
 *   - api_kind CHECK (mig 0063): anthropic ⇒ apiKind ∈ enum; github ⇒ apiKind NULL.
 *   - credential_secret_name charset ^[a-z0-9-]{3,64}$ (when present).
 *   - a RECONCILED anthropic org requires a credentialSecretName.
 *   - a providerEnterpriseId, when given, must reference an EXISTING enterprise of
 *     the SAME provider (else a github org could link an anthropic enterprise or a
 *     dangling id → raw FK 500).
 *   - external_org_id is CANONICALISED to lowercase (mig 0064, mirrors the
 *     enterprise key in 0062): a github slug must be lowercase (else 400, since the
 *     slug is part of the credential lane key); an anthropic org id is auto-
 *     lowercased. Without this two case-variant rows could coexist and the GitHub
 *     attribution resolver (lower()=lower()) would pick a non-deterministic row.
 *   - when an Anthropic key is already wired for the credential, its SHAPE must
 *     match the org's api_kind (validateKeyFormat) — e.g. an sk-ant-admin01- key on
 *     an enterprise-analytics org is rejected as a 400. The key is NEVER echoed.
 * UNIQUE (provider, lower(external_org_id)) → 409.
 *
 * RBAC: requireRole(admin) + assertSameOrigin. Audited. An unmapped org
 * (no regionId) or any credentialSecretName is platform-admin only.
 */
import { defineEventHandler, createError, getRequestIP, getHeader } from 'h3'
import { readValidated } from '../../../../utils/validated-body'
import { sql } from 'drizzle-orm'
import { z } from 'zod'
import { requireRole, requireRegionScope } from '../../../../auth/rbac'
import { isPlatformAdmin } from '../../../../../shared/auth/roles'
import { assertSameOrigin } from '../../../../auth/csrf'
import { withRequestRls } from '../../../../db/request-rls'
import { recordAuditEvent } from '../../../../db/audit'
import { translatePgConstraintError } from '../../../../utils/pg-constraint-error'
import { providerOrg } from '../../../../../drizzle/schema'
import { readSecret } from '../../../../reconciliation/credentials'
import { validateKeyFormat } from '../../../../anthropic/health'
import { assertOrgUnitInRegion } from '../../../../db/org-units'
import { resweepProviderOrgReferences } from '../../../../workers/governance-key-backfill'
import {
  providerSchema,
  reconciliationModeSchema,
  billingSchema,
  apiKindSchema,
  credentialSecretNameSchema,
  validateApiKindForProvider,
  validateReconciledCredential,
  canonicaliseExternalId,
} from '../../../../reconciliation/provider-validation'

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

const Body = z.object({
  provider: providerSchema,
  externalOrgId: z.string().min(1).max(200),
  displayName: z.string().min(1).max(200),
  reconciliationMode: reconciliationModeSchema,
  billing: billingSchema.optional().default('tracked'),
  apiKind: apiKindSchema.nullish(),
  credentialSecretName: credentialSecretNameSchema.nullish(),
  providerEnterpriseId: z.string().regex(UUID_RE).nullish(),
  // ADR-0010 D4: the region this license-org bills to (Copilot region home).
  regionId: z.string().regex(UUID_RE).nullish(),
  // Reporting-consolidation Wave 0 (mig 0079): the GitHub-org → cost-owning-unit map (Copilot
  // pooled chargeback homing). Must reference a cost-owning org_unit.
  costOwningUnitId: z.string().regex(UUID_RE).nullish(),
  notes: z.string().max(2000).nullish(),
})

function platformAdminOnly(detail: string): never {
  throw createError({
    statusCode: 403,
    statusMessage: 'Forbidden',
    data: {
      type: 'https://tokenscope.example.com/errors/forbidden',
      title: 'Forbidden',
      status: 403,
      detail,
    },
  })
}

function badRequest(detail: string): never {
  throw createError({
    statusCode: 400,
    statusMessage: 'Invalid provider org',
    data: {
      type: 'https://tokenscope.example.com/errors/validation',
      title: 'Invalid provider org',
      status: 400,
      detail,
    },
  })
}

export default defineEventHandler(async (event) => {
  const caller = await requireRole(event, 'admin')
  assertSameOrigin(event)
  const body = await readValidated(event, Body)
  const ip = getRequestIP(event, { xForwardedFor: true }) ?? null
  const ua = getHeader(event, 'user-agent') ?? null

  // A region admin may only create an org mapped into their OWN region, with no credential.
  if (!isPlatformAdmin(caller.role)) {
    if (!body.regionId) platformAdminOnly('An unmapped provider org (no region) is estate-wide; only platform-admin may write it.')
    if (body.credentialSecretName) platformAdminOnly('The credential namespace is deployment-wide; only platform-admin may assign credentialSecretName.')
  }
  if (body.regionId) await requireRegionScope(event, body.regionId)

  const apiKind = body.apiKind ?? null
  const credentialSecretName = body.credentialSecretName ?? null
  const providerEnterpriseId = body.providerEnterpriseId ?? null
  const regionId = body.regionId ?? null
  const costOwningUnitId = body.costOwningUnitId ?? null

  // CHECK invariants — surfaced as a clean 400 before we touch the DB.
  const apiKindErr = validateApiKindForProvider(body.provider, apiKind)
  if (apiKindErr) badRequest(apiKindErr)
  const credErr = validateReconciledCredential(
    body.provider,
    body.reconciliationMode,
    credentialSecretName,
  )
  if (credErr) badRequest(credErr)

  // Canonicalise external_org_id (mig 0064): github mixed-case → 400; anthropic
  // org id auto-lowercased. Mirrors the enterprise key (mig 0062).
  const canon = canonicaliseExternalId(body.provider, body.externalOrgId)
  if ('error' in canon) badRequest(canon.error)
  const externalOrgId = canon.value

  // Key-shape write-guard (anthropic only): if a key is ALREADY wired for the
  // named credential, its prefix must match the chosen api_kind (e.g. reject an
  // sk-ant-admin01- key on an enterprise-analytics org). Skip silently when no key
  // is wired yet — key-presence is surfaced separately, and onboarding the name
  // before the env var is a legitimate two-step. The key is NEVER echoed.
  if (body.provider === 'anthropic' && apiKind && credentialSecretName) {
    const key = readSecret('anthropic', credentialSecretName)
    if (key) {
      const fmt = validateKeyFormat(apiKind, key)
      if (!fmt.ok) {
        badRequest(
          `the wired key for '${credentialSecretName}' looks like a ${fmt.looksLike} key, which does not match api_kind '${apiKind}'`,
        )
      }
    }
  }

  return await withRequestRls(event, async (tx) => {
    // Linked enterprise must exist AND share the provider (an FK alone would let
    // a github org point at an anthropic enterprise, or a dangling id → 500).
    if (providerEnterpriseId) {
      const entRows = await tx.execute<{ provider: string }>(sql`
        SELECT provider FROM provider_enterprise WHERE id = ${providerEnterpriseId}::uuid LIMIT 1
      `)
      const ent = [...entRows][0]
      if (!ent) {
        throw createError({
          statusCode: 404,
          statusMessage: 'Enterprise not found',
          data: {
            type: 'https://tokenscope.example.com/errors/not-found',
            title: 'Enterprise not found',
            status: 404,
            detail: 'No provider_enterprise matches providerEnterpriseId.',
          },
        })
      }
      if (ent.provider !== body.provider) {
        badRequest(
          `providerEnterpriseId references a ${ent.provider} enterprise, but the org is ${body.provider}`,
        )
      }
    }

    // Mapped cost-owning unit (when set) must exist AND be a cost-owning unit.
    // When the org itself is region-mapped, the CoU must also live in THAT
    // region (the defect this closes: costOwningUnitId was never checked
    // against the org's region) — routed through the shared
    // assertOrgUnitInRegion helper, not a hand-rolled variant. Unmapped
    // (regionId null) orgs skip the region leg; nothing to check it against.
    if (costOwningUnitId) {
      if (regionId) {
        await assertOrgUnitInRegion(tx, {
          orgUnitId: costOwningUnitId,
          regionId,
          mustBeActive: true,
          statusMessage: 'costOwningUnitId is not an active org unit in the org\'s mapped region',
          data: {
            type: 'https://tokenscope.example.com/errors/unprocessable',
            title: 'Unprocessable',
            status: 422,
            detail: 'costOwningUnitId must reference an active org unit in the org\'s mapped region.',
          },
        })
      }
      const ouRows = await tx.execute<{ is_cost_owning_unit: boolean }>(sql`
        SELECT is_cost_owning_unit FROM org_unit
        WHERE id = ${costOwningUnitId}::uuid AND retired_at IS NULL LIMIT 1
      `)
      const ou = [...ouRows][0]
      if (!ou) {
        throw createError({
          statusCode: 404,
          statusMessage: 'Org unit not found',
          data: {
            type: 'https://tokenscope.example.com/errors/not-found',
            title: 'Org unit not found',
            status: 404,
            detail: 'No active org_unit matches costOwningUnitId.',
          },
        })
      }
      if (!ou.is_cost_owning_unit) {
        badRequest('costOwningUnitId must reference a cost-owning org_unit (is_cost_owning_unit = true)')
      }
    }

    // Pre-check the case-insensitive UNIQUE (provider, lower(external_org_id)) for a
    // clean 409 (the insert still has the constraint as the race backstop, below).
    const dupe = await tx.execute<{ id: string }>(sql`
      SELECT id::text AS id FROM provider_org
      WHERE provider = ${body.provider} AND lower(external_org_id) = lower(${externalOrgId})
      LIMIT 1
    `)
    if ([...dupe][0]) {
      throw createError({
        statusCode: 409,
        statusMessage: 'Provider org already exists',
        data: {
          type: 'https://tokenscope.example.com/errors/conflict',
          title: 'Provider org already exists',
          status: 409,
          detail: `A ${body.provider} org with external_org_id '${externalOrgId}' already exists.`,
        },
      })
    }

    let created: { id: string } | undefined
    try {
      ;[created] = await tx
        .insert(providerOrg)
        .values({
          provider: body.provider,
          externalOrgId,
          displayName: body.displayName,
          reconciliationMode: body.reconciliationMode,
          billing: body.billing,
          apiKind,
          credentialSecretName,
          providerEnterpriseId,
          regionId,
          costOwningUnitId,
          notes: body.notes ?? null,
        })
        .returning({ id: providerOrg.id })
    } catch (err: unknown) {
      translatePgConstraintError(err, {
        '23505': {
          title: 'Provider org already exists',
          detail: `A ${body.provider} org with external_org_id '${externalOrgId}' already exists.`,
        },
        // api_kind CHECK / enterprise FK race backstop.
        '23503': {
          status: 404,
          title: 'Enterprise not found',
          detail: 'The linked enterprise was deleted while creating the org.',
        },
      })
    }

    await recordAuditEvent(tx, {
      eventType: 'provider-org-created',
      actorTeammateId: caller.teammateId,
      subjectKind: 'provider-org',
      subjectId: created!.id,
      payload: {
        provider: body.provider,
        external_org_id: externalOrgId,
        display_name: body.displayName,
        reconciliation_mode: body.reconciliationMode,
        billing: body.billing,
        api_kind: apiKind,
        credential_secret_name: credentialSecretName,
        provider_enterprise_id: providerEnterpriseId,
        region_id: regionId,
        cost_owning_unit_id: costOwningUnitId,
        notes: body.notes ?? null,
      },
      ipAddress: ip,
      userAgent: ua,
    })

    // Targeted governance-key resweep (design §8.4: "creating or linking an org
    // triggers a targeted re-sweep") — un-parks any actual_spend /
    // reconciliation_record rows that were sitting governance-unresolved ONLY
    // because this org did not exist yet. Bounded to this one org's backlog;
    // safe to run inline.
    //
    // ON THE REQUEST LANE DELIBERATELY (docs/design/rls-enforcement.md §2, "the
    // six handlers"). Its scope is already an explicit PARAMETER, not an ambient
    // consequence: every predicate is keyed on the org id / provider / external
    // id passed here, so a region-scoped `admin` caller cannot narrow it. Its
    // two tables carry no RLS. And it must stay inside this transaction — it
    // resolves rows against the provider_org row INSERTed above, invisible to
    // any other connection until commit.
    const resweep = await resweepProviderOrgReferences(tx, {
      providerOrgId: created!.id,
      provider: body.provider,
      externalOrgId,
      providerEnterpriseId,
    })

    return {
      id: created!.id,
      provider: body.provider,
      externalOrgId,
      displayName: body.displayName,
      reconciliationMode: body.reconciliationMode,
      billing: body.billing,
      apiKind,
      providerEnterpriseId,
      governanceResweep: resweep,
    }
  })
})
