/*
 * PATCH /api/v1/admin/reconciliation/orgs/{id} — update a provider_org's
 * mutable fields: displayName, reconciliationMode, billing, apiKind,
 * credentialSecretName, providerEnterpriseId, notes.
 *
 * provider + external_org_id are IMMUTABLE here: provider flips the api_kind
 * invariant + the credential env-prefix, and external_org_id is half the UNIQUE
 * identity — re-keying an onboarded org is a delete+create, not a patch.
 *
 * Every supplied field is merged onto the current row and the FULL CHECK
 * invariant set is re-validated (mig 0063 api_kind + reconciled-credential +
 * charset), so a partial PATCH can't leave the row in a state the DB CHECK would
 * reject. Nullable fields use an explicit-null convention: omit a key to leave it
 * unchanged, pass null to clear it.
 *
 * RBAC: requireRole(admin) + assertSameOrigin. Audited. An unmapped org
 * (region_id IS NULL) or a changed credentialSecretName is platform-admin only.
 */
import { defineEventHandler, createError, getRequestIP, getHeader } from 'h3'
import { readValidated } from '../../../../../utils/validated-body'
import { sql } from 'drizzle-orm'
import { z } from 'zod'
import { requireRole, requireRegionScope, requireRegionScopeOrNotFound } from '../../../../../auth/rbac'
import { isPlatformAdmin } from '../../../../../../shared/auth/roles'
import { assertSameOrigin } from '../../../../../auth/csrf'
import { withRequestRls } from '../../../../../db/request-rls'
import { recordAuditEvent } from '../../../../../db/audit'
import { requireUuidParam } from '../../../../../utils/require-uuid-param'
import { translatePgConstraintError } from '../../../../../utils/pg-constraint-error'
import { readSecret } from '../../../../../reconciliation/credentials'
import { validateKeyFormat } from '../../../../../anthropic/health'
import { assertOrgUnitInRegion } from '../../../../../db/org-units'
import { lockGovernanceCutoverForBillingEdit } from '../../../../../governance/cutover'
import { recomputeGovernanceVerdicts } from '../../../../../governance/recompute'
import { resweepProviderOrgReferences } from '../../../../../workers/governance-key-backfill'
import {
  reconciliationModeSchema,
  billingSchema,
  apiKindSchema,
  credentialSecretNameSchema,
  validateApiKindForProvider,
  validateReconciledCredential,
  type Provider,
  type ReconciliationMode,
} from '../../../../../reconciliation/provider-validation'
import type { AnthropicApiKind } from '../../../../../reconciliation/adapters/registry'

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

// Each key OPTIONAL: omit to leave unchanged. Nullable keys accept null to clear.
const Body = z
  .object({
    displayName: z.string().min(1).max(200).optional(),
    reconciliationMode: reconciliationModeSchema.optional(),
    billing: billingSchema.optional(),
    apiKind: apiKindSchema.nullish(),
    credentialSecretName: credentialSecretNameSchema.nullish(),
    providerEnterpriseId: z.string().regex(UUID_RE).nullish(),
    // ADR-0010 D4: the region this license-org bills to (regionForLicenseOrg / the bill-
    // driven provisioner's floor). null clears it.
    regionId: z.string().regex(UUID_RE).nullish(),
    // Reporting-consolidation Wave 0 (mig 0079): the GitHub-org → cost-owning-unit map. The
    // org's POOLED Copilot bill (copilot_pool_bill) homes to this CoU. null clears it (→ the
    // visible unallocated bucket). Must reference a cost-owning org_unit.
    costOwningUnitId: z.string().regex(UUID_RE).nullish(),
    notes: z.string().max(2000).nullish(),
  })
  .refine((d) => Object.keys(d).length > 0, 'at least one field must be supplied')

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
    statusMessage: 'Invalid provider org update',
    data: {
      type: 'https://tokenscope.example.com/errors/validation',
      title: 'Invalid provider org update',
      status: 400,
      detail,
    },
  })
}

interface CurrentRow extends Record<string, unknown> {
  provider: string
  external_org_id: string
  reconciliation_mode: string
  api_kind: string | null
  credential_secret_name: string | null
  region_id: string | null
  cost_owning_unit_id: string | null
}

export default defineEventHandler(async (event) => {
  const caller = await requireRole(event, 'admin')
  assertSameOrigin(event)
  const id = requireUuidParam(event, 'id', 'provider-org id')
  const body = await readValidated(event, Body)
  const ip = getRequestIP(event, { xForwardedFor: true }) ?? null
  const ua = getHeader(event, 'user-agent') ?? null

  // Region-scope, DESTINATION half: a region admin may only route a
  // provider_org INTO their own region. The SOURCE half — may they touch this
  // org at all — is clamped below against the row's own region_id, because a
  // guard that keys on what the caller SENT is skipped by simply omitting the
  // field. (The admin UI always round-trips regionId, so this was invisible
  // through the UI and reachable by any raw API caller.)
  if (body.regionId) await requireRegionScope(event, body.regionId)

  const has = (k: keyof typeof body) => Object.prototype.hasOwnProperty.call(body, k)

  return await withRequestRls(event, async (tx) => {
    const cutoverStatus = has('billing')
      ? await lockGovernanceCutoverForBillingEdit(tx)
      : null
    const rows = await tx.execute<CurrentRow>(sql`
      SELECT provider, external_org_id, reconciliation_mode, api_kind, credential_secret_name,
             region_id::text AS region_id, cost_owning_unit_id::text AS cost_owning_unit_id
      FROM provider_org WHERE id = ${id}::uuid LIMIT 1
    `)
    const cur = [...rows][0]
    // ONE factory, thrown by both the unknown-id path and the region-denied path
    // below — see [id].delete.ts. Two similar literals would drift and re-open
    // the existence oracle.
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
    if (!cur) throw notFound()
    const provider = cur.provider as Provider

    // ADR-0011 D11 (Required outcome 4): once governance is activated,
    // provider_org.billing is meaningless for GitHub (the enterprise is
    // authoritative) — reject the write with a clear, actionable 409 instead
    // of letting it silently no-op or falling through to the DB trigger's raw
    // constraint error (mig 0104's provider_org_billing_lock_trg is the
    // defence-in-depth backstop for a caller that bypasses this app-level
    // gate entirely, not the primary UX).
    if (has('billing') && provider === 'github' && cutoverStatus === 'activated') {
      throw createError({
        statusCode: 409,
        statusMessage: 'Billing is not settable on a GitHub org once governance is activated',
        data: {
          type: 'https://tokenscope.example.com/errors/governance-activated',
          title: 'Billing is not settable on a GitHub org once governance is activated',
          status: 409,
          detail:
            'GitHub bills the enterprise, not the org (ADR-0011 D11). Set billing on the linked provider_enterprise instead.',
        },
      })
    }

    // Region-scope, SOURCE half. Clamp on the row's CURRENT region so a region-A
    // admin cannot patch any field of a region-B-mapped org by omitting regionId
    // from the body. Runs AFTER the 404 above so the endpoint never becomes an
    // existence oracle for another region's org ids, and inside the transaction
    // so a denial rolls back — same shape as orgs/[id].delete.ts.
    if (cur.region_id) await requireRegionScopeOrNotFound(event, cur.region_id, notFound())
    else if (!isPlatformAdmin(caller.role)) platformAdminOnly('An unmapped provider org (no region) is estate-wide; only platform-admin may write it.')

    // Merge supplied fields onto current to validate the resulting row.
    const nextMode: ReconciliationMode = has('reconciliationMode')
      ? body.reconciliationMode!
      : (cur.reconciliation_mode as ReconciliationMode)
    const nextApiKind: AnthropicApiKind | null = has('apiKind')
      ? (body.apiKind ?? null)
      : (cur.api_kind as AnthropicApiKind | null)
    const nextCred: string | null = has('credentialSecretName')
      ? (body.credentialSecretName ?? null)
      : cur.credential_secret_name
    const nextRegionId: string | null = has('regionId') ? (body.regionId ?? null) : cur.region_id
    if (nextRegionId === null && !isPlatformAdmin(caller.role)) {
      platformAdminOnly('An unmapped provider org (no region) is estate-wide; only platform-admin may write it.')
    }
    if (nextCred !== cur.credential_secret_name && !isPlatformAdmin(caller.role)) {
      platformAdminOnly('The credential namespace is deployment-wide; only platform-admin may assign credentialSecretName.')
    }

    const apiKindErr = validateApiKindForProvider(provider, nextApiKind)
    if (apiKindErr) badRequest(apiKindErr)
    const credErr = validateReconciledCredential(provider, nextMode, nextCred)
    if (credErr) badRequest(credErr)

    // Key-shape write-guard (anthropic only): when the patch touches api_kind OR the
    // credential and a key is ALREADY wired for the (merged) credential name, the
    // key's prefix must match the (merged) api_kind. Rejects e.g. flipping an
    // sk-ant-admin01-keyed org to enterprise-analytics. Skipped when no key is wired
    // (key-presence is surfaced separately). The key is NEVER echoed.
    if (
      provider === 'anthropic' &&
      nextApiKind &&
      nextCred &&
      (has('apiKind') || has('credentialSecretName'))
    ) {
      const key = readSecret('anthropic', nextCred)
      if (key) {
        const fmt = validateKeyFormat(nextApiKind, key)
        if (!fmt.ok) {
          badRequest(
            `the wired key for '${nextCred}' looks like a ${fmt.looksLike} key, which does not match api_kind '${nextApiKind}'`,
          )
        }
      }
    }

    // Mapped region (when set) must exist (ADR-0010 D4).
    if (has('regionId') && body.regionId != null) {
      const regRows = await tx.execute<{ id: string }>(sql`
        SELECT id::text AS id FROM region WHERE id = ${body.regionId}::uuid LIMIT 1
      `)
      if (![...regRows][0]) {
        throw createError({
          statusCode: 404,
          statusMessage: 'Region not found',
          data: {
            type: 'https://tokenscope.example.com/errors/not-found',
            title: 'Region not found',
            status: 404,
            detail: 'No region matches regionId.',
          },
        })
      }
    }

    // Mapped cost-owning unit (when set) must exist AND be a cost-owning unit (Copilot pooled
    // chargeback homes here — a non-CoU target would silently never surface as a charge). When
    // the (merged) region is set, the CoU must also live in THAT region — routed through the
    // shared assertOrgUnitInRegion helper, not a hand-rolled variant.
    if (has('costOwningUnitId') && body.costOwningUnitId != null) {
      if (nextRegionId) {
        await assertOrgUnitInRegion(tx, {
          orgUnitId: body.costOwningUnitId,
          regionId: nextRegionId,
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
        WHERE id = ${body.costOwningUnitId}::uuid AND retired_at IS NULL LIMIT 1
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

    // R2: the SAME consistency rule, reached by the other field combination. Moving an
    // org between regions with a body that carries ONLY regionId leaves the existing
    // cost_owning_unit_id untouched and, before this check, unrevalidated — so the org
    // ends up in region B while its pooled Copilot chargeback still homes to a CoU in
    // region A. Nothing at the DB level prevents it: provider_org has no FK or CHECK
    // tying cost_owning_unit_id to region_id. The block above only fires when the body
    // supplies costOwningUnitId, which a pure region move does not.
    if (has('regionId') && !has('costOwningUnitId') && cur.cost_owning_unit_id && nextRegionId) {
      await assertOrgUnitInRegion(tx, {
        orgUnitId: cur.cost_owning_unit_id,
        regionId: nextRegionId,
        mustBeActive: true,
        statusMessage: 'the existing costOwningUnit does not live in the target region',
        data: {
          type: 'https://tokenscope.example.com/errors/unprocessable',
          title: 'Unprocessable',
          status: 422,
          detail:
            'Moving this org to another region would leave its cost-owning unit in the previous region. Re-point costOwningUnitId in the same request.',
        },
      })
    }

    // Linked enterprise (when set) must exist + share provider.
    if (has('providerEnterpriseId') && body.providerEnterpriseId != null) {
      const entRows = await tx.execute<{ provider: string }>(sql`
        SELECT provider FROM provider_enterprise WHERE id = ${body.providerEnterpriseId}::uuid LIMIT 1
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
      if (ent.provider !== provider) {
        badRequest(
          `providerEnterpriseId references a ${ent.provider} enterprise, but the org is ${provider}`,
        )
      }
    }

    // Build the SET list from only the supplied fields.
    const sets = []
    if (has('displayName')) sets.push(sql`display_name = ${body.displayName}`)
    if (has('reconciliationMode')) sets.push(sql`reconciliation_mode = ${nextMode}`)
    if (has('billing')) sets.push(sql`billing = ${body.billing}`)
    if (has('apiKind')) sets.push(sql`api_kind = ${nextApiKind}`)
    if (has('credentialSecretName')) sets.push(sql`credential_secret_name = ${nextCred}`)
    if (has('providerEnterpriseId'))
      sets.push(sql`provider_enterprise_id = ${body.providerEnterpriseId ?? null}::uuid`)
    if (has('regionId')) sets.push(sql`region_id = ${body.regionId ?? null}::uuid`)
    if (has('costOwningUnitId'))
      sets.push(sql`cost_owning_unit_id = ${body.costOwningUnitId ?? null}::uuid`)
    if (has('notes')) sets.push(sql`notes = ${body.notes ?? null}`)

    try {
      await tx.execute(sql`
        UPDATE provider_org SET ${sql.join(sets, sql`, `)} WHERE id = ${id}::uuid
      `)
    } catch (err: unknown) {
      translatePgConstraintError(err, {
        '23503': {
          status: 404,
          title: 'Enterprise not found',
          detail: 'The linked enterprise was deleted while updating the org.',
        },
      })
    }

    await recordAuditEvent(tx, {
      eventType: 'provider-org-updated',
      actorTeammateId: caller.teammateId,
      subjectKind: 'provider-org',
      subjectId: id,
      payload: {
        provider,
        external_org_id: cur.external_org_id,
        changed: {
          ...(has('displayName') ? { display_name: body.displayName } : {}),
          ...(has('reconciliationMode') ? { reconciliation_mode: nextMode } : {}),
          ...(has('billing') ? { billing: body.billing } : {}),
          ...(has('apiKind') ? { api_kind: nextApiKind } : {}),
          ...(has('credentialSecretName') ? { credential_secret_name: nextCred } : {}),
          ...(has('providerEnterpriseId')
            ? { provider_enterprise_id: body.providerEnterpriseId ?? null }
            : {}),
          ...(has('regionId') ? { region_id: body.regionId ?? null } : {}),
          ...(has('costOwningUnitId') ? { cost_owning_unit_id: body.costOwningUnitId ?? null } : {}),
          ...(has('notes') ? { notes: body.notes ?? null } : {}),
        },
      },
      ipAddress: ip,
      userAgent: ua,
    })

    // Immediate effect for open-period rows (design §4.1) — a no-op
    // pre-activation (see the identical note in enterprises/[id].patch.ts).
    // Reachable only for anthropic here: a github billing edit was already
    // rejected above once activated, and pre-activation the legacy heuristic
    // ignores `billing` entirely for both providers.
    if (has('billing')) {
      await recomputeGovernanceVerdicts(tx, { providerOrgId: id })
    }

    // Targeted governance-key resweep (design §8.4) — linking this org to an
    // enterprise may resolve previously-unresolved rows keyed by it.
    //
    // ON THE REQUEST LANE DELIBERATELY (docs/design/rls-enforcement.md §2, "the
    // six handlers"): its scope is an explicit parameter (org id + provider +
    // external id), not the caller's region; its tables carry no RLS; and it
    // must observe the UPDATE above, which no other connection can see until
    // this transaction commits. Same for recomputeGovernanceVerdicts, scoped by
    // { providerOrgId }.
    if (has('providerEnterpriseId')) {
      await resweepProviderOrgReferences(tx, {
        providerOrgId: id,
        provider,
        externalOrgId: cur.external_org_id,
        providerEnterpriseId: body.providerEnterpriseId ?? null,
      })
    }

    return { id, updated: true }
  })
})
