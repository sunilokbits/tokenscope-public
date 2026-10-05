/*
 * GET /api/v1/admin/reconciliation/orgs — list EVERY provider_org (anthropic AND
 * github), joined to its provider_enterprise, with credential presence. This
 * generalises the anthropic-only anthropic/orgs.get.ts into the cross-provider
 * onboarding surface.
 *
 * Per row we surface:
 *   - provider, externalOrgId, displayName, reconciliationMode, billing, notes
 *   - apiKind (+ human label) for anthropic; null for github
 *   - the linked enterprise (id / display_name / external_id) when set
 *   - keyPresent: anthropic ⇒ resolveOrgApiKey(credential_secret_name) != null;
 *     github ⇒ the LINKED enterprise's credential is present (readSecret). The
 *     KEY ITSELF IS NEVER returned — only the boolean presence flag.
 *
 * NO live health here. The per-org Anthropic verdict (key format + live probe)
 * is served ONLY by anthropic/health.get.ts, keyed by externalOrgId; the client
 * joins it onto these rows (docs/design/admin-nav-responsiveness.md D5). A list
 * endpoint must not pay an outbound HTTPS probe per row.
 *
 * RBAC: requireRole(admin). `provider_org` is a config table with
 * no RLS policy, but the read runs in the request lane anyway
 * (docs/design/rls-enforcement.md §2) — and it JOINS `org_unit`, which IS
 * RLS-enabled and is in the design's phase-2 FORCE set, so a context-less read
 * here would have silently lost the cost_owning_unit_code column.
 *
 * Region-scope: a region `admin` sees mapped orgs in their OWN region PLUS
 * every unmapped (region_id IS NULL) org, read-only: writing an unmapped org is
 * platform-admin only (orgs.post / [id].patch / [id].delete). `platform-admin`
 * sees every row. Matches diagnostics/index.get.ts's
 * `session.role === 'admin'` shape; RLS is inert at runtime (owner
 * connection, no FORCE) so this in-query clamp is the live gate.
 */
import { defineEventHandler } from 'h3'
import { sql } from 'drizzle-orm'
import { requireRole } from '../../../../auth/rbac'
import { withRequestRls } from '../../../../db/request-rls'
import { resolveOrgApiKey } from '../../../../workers/analytics-poller'
import { readSecret } from '../../../../reconciliation/credentials'
import { apiKindLabel } from '../../../../anthropic/org-health'
import { isGovernanceActivated } from '../../../../governance/verdict'
import type { AnthropicApiKind } from '../../../../reconciliation/adapters/registry'

interface Row extends Record<string, unknown> {
  id: string
  provider: string
  external_org_id: string
  display_name: string
  api_kind: string | null
  credential_secret_name: string | null
  reconciliation_mode: string
  billing: string
  notes: string | null
  provider_enterprise_id: string | null
  enterprise_external_id: string | null
  enterprise_display_name: string | null
  enterprise_credential_secret_name: string | null
  region_id: string | null
  region_code: string | null
  cost_owning_unit_id: string | null
  cost_owning_unit_code: string | null
}

function narrowApiKind(value: string | null): AnthropicApiKind {
  // CHECK-constrained (mig 0063) to the two anthropic kinds for anthropic rows;
  // treat anything unexpected as the conservative Admin default for display.
  return value === 'enterprise-analytics' ? 'enterprise-analytics' : 'claude-code-admin'
}

export default defineEventHandler(async (event) => {
  const session = await requireRole(event, 'admin')
  // ADR-0011 D11 (Required outcome 4): once governance is activated,
  // provider_org.billing is meaningless for GitHub (the enterprise is
  // authoritative) — hidden from the API response rather than echoing a stale
  // value an operator could mistake for live. The key/shape is PRESERVED
  // (billing: null), not removed — backward-compatible response shape.

  // Region clamp (sole gate — provider_org has no RLS policy, and RLS is
  // inert at runtime regardless). admin -> own region OR unmapped;
  // platform-admin -> every row.
  const regionClause =
    session.role === 'admin'
      ? sql`WHERE po.region_id IS NULL OR po.region_id = ${session.regionId}::uuid`
      : sql``

  const { governanceActivated, rows } = await withRequestRls(event, async (tx) => {
    const governanceActivated = await isGovernanceActivated(tx)
    const rows = await tx.execute<Row>(sql`
    SELECT po.id::text AS id,
           po.provider,
           po.external_org_id,
           po.display_name,
           po.api_kind,
           po.credential_secret_name,
           po.reconciliation_mode,
           po.billing,
           po.notes,
           po.provider_enterprise_id::text AS provider_enterprise_id,
           pe.external_id AS enterprise_external_id,
           pe.display_name AS enterprise_display_name,
           pe.credential_secret_name AS enterprise_credential_secret_name,
           po.region_id::text AS region_id,
           rg.code AS region_code,
           po.cost_owning_unit_id::text AS cost_owning_unit_id,
           cou.code AS cost_owning_unit_code
    FROM provider_org po
    LEFT JOIN provider_enterprise pe ON pe.id = po.provider_enterprise_id
    LEFT JOIN region rg ON rg.id = po.region_id
    LEFT JOIN org_unit cou ON cou.id = po.cost_owning_unit_id
    ${regionClause}
    ORDER BY po.provider, po.display_name
  `)
    return { governanceActivated, rows }
  })

  const orgs = []
  for (const r of [...rows]) {
    const enterprise = r.provider_enterprise_id
      ? {
          id: r.provider_enterprise_id,
          externalId: r.enterprise_external_id,
          displayName: r.enterprise_display_name,
        }
      : null

    if (r.provider === 'anthropic') {
      const apiKind = narrowApiKind(r.api_kind)
      // Presence ONLY — the key value never crosses this boundary.
      const keyPresent = resolveOrgApiKey(r.credential_secret_name) != null
      orgs.push({
        id: r.id,
        provider: r.provider,
        externalOrgId: r.external_org_id,
        displayName: r.display_name,
        apiKind,
        apiKindLabel: apiKindLabel(apiKind),
        credentialSecretName: r.credential_secret_name,
        reconciliationMode: r.reconciliation_mode,
        billing: r.billing,
        notes: r.notes,
        providerEnterpriseId: r.provider_enterprise_id,
        enterprise,
        regionId: r.region_id,
        regionCode: r.region_code,
        costOwningUnitId: r.cost_owning_unit_id,
        costOwningUnitCode: r.cost_owning_unit_code,
        keyPresent,
      })
    } else {
      // github: credential lives on the linked enterprise (one manage_billing PAT).
      const keyPresent =
        readSecret('github', r.enterprise_credential_secret_name) != null
      orgs.push({
        id: r.id,
        provider: r.provider,
        externalOrgId: r.external_org_id,
        displayName: r.display_name,
        apiKind: null,
        apiKindLabel: null,
        // github key-presence is driven by the LINKED ENTERPRISE's credential (one
        // manage_billing PAT), NOT the org's own credential_secret_name — which is
        // unused for github. Surface null here so the UI can't misread the org-level
        // name as the thing that drives keyPresent.
        credentialSecretName: null,
        reconciliationMode: r.reconciliation_mode,
        billing: governanceActivated ? null : r.billing,
        notes: r.notes,
        providerEnterpriseId: r.provider_enterprise_id,
        enterprise,
        regionId: r.region_id,
        regionCode: r.region_code,
        costOwningUnitId: r.cost_owning_unit_id,
        costOwningUnitCode: r.cost_owning_unit_code,
        keyPresent,
      })
    }
  }

  return { orgs, total: orgs.length }
})
