// @vitest-environment node
/*
 * Reconciliation-provider admin surface — the onboarding CRUD that replaces the
 * brittle seed.ts templates. Exercises the real h3 handlers against a real
 * testcontainers DB (migrations incl. 0062 lowercase CHECK + 0063 api_kind CHECK).
 *
 * Covers:
 *   - provider_org create/list/patch/delete for BOTH providers (anthropic + github)
 *   - the api_kind CHECK both ways (anthropic without api_kind → 400; github WITH
 *     api_kind → 400)
 *   - github org ↔ enterprise linkage (FK + same-provider rule)
 *   - provider_enterprise create/list/patch/delete; lowercase enforcement on the
 *     github external_id; anthropic external_id auto-lowercased
 *   - UNIQUE → 409 (both org and enterprise)
 *   - discover: stubbed organization_id + detected variant, and NEVER leaks the key
 *   - RBAC: a non-admin (developer) → 403
 *   - audit rows written for every mutation
 */
import { createServer, type Server } from 'node:http'
import { describe, it, expect, beforeAll, afterAll, afterEach, vi } from 'vitest'
import { startTestDb, stopTestDb, type TestDb } from '../helpers/db'
import * as schema from '../../../drizzle/schema'
import { injectTestSession } from '../../helpers/auth'
import type { Session } from '../../../server/utils/auth'

import orgsGet from '../../../server/api/v1/admin/reconciliation/orgs.get'
import orgsPost from '../../../server/api/v1/admin/reconciliation/orgs.post'
import orgPatch from '../../../server/api/v1/admin/reconciliation/orgs/[id].patch'
import orgDelete from '../../../server/api/v1/admin/reconciliation/orgs/[id].delete'
import entGet from '../../../server/api/v1/admin/reconciliation/enterprises.get'
import entPost from '../../../server/api/v1/admin/reconciliation/enterprises.post'
import entPatch from '../../../server/api/v1/admin/reconciliation/enterprises/[id].patch'
import entDelete from '../../../server/api/v1/admin/reconciliation/enterprises/[id].delete'
import discoverPost from '../../../server/api/v1/admin/reconciliation/anthropic/discover.post'
import { computeOrgHealth } from '../../../server/anthropic/org-health'

// computeOrgHealth is the outbound HTTPS probe. It lives ONLY behind
// anthropic/health now (docs/design/admin-nav-responsiveness.md D5) — the list
// must never call it. Wrapped, not stubbed, so any other caller keeps the real
// behaviour and the assertion is about CALLS, not about a fake.
vi.mock('../../../server/anthropic/org-health', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../../server/anthropic/org-health')>()
  return { ...actual, computeOrgHealth: vi.fn(actual.computeOrgHealth) }
})

let t: TestDb
let regionId: string
let ouId: string
let finopsId: string
let devId: string
// Cross-region clamp fixtures (server-api-app:idor:0004 / T3-xregion-05).
let regionBId: string
let ouBId: string
let couAId: string // cost-owning unit in region A
let couBId: string // cost-owning unit in region B
let adminAId: string
let adminBId: string

beforeAll(async () => {
  t = await startTestDb()
  process.env.DATABASE_URL = t.url
  const [r] = await t.db.insert(schema.region).values({ code: 'rp-r', displayName: 'RP R' }).returning()
  regionId = r!.id
  const [o] = await t.db
    .insert(schema.orgUnit)
    .values({ regionId, path: 'rp.svc', code: 'rp-svc', displayName: 'Svc', unitType: 'bu' })
    .returning()
  ouId = o!.id
  const [f] = await t.db
    .insert(schema.teammate)
    .values({ entraOid: 'oid-rp-fin', email: 'rp-fin@x.test', role: 'platform-admin', regionId, orgUnitId: ouId })
    .returning()
  finopsId = f!.id
  const [d] = await t.db
    .insert(schema.teammate)
    .values({ entraOid: 'oid-rp-dev', email: 'rp-dev@x.test', role: 'developer', regionId, orgUnitId: ouId })
    .returning()
  devId = d!.id

  const [rb] = await t.db.insert(schema.region).values({ code: 'rp-rb', displayName: 'RP RB' }).returning()
  regionBId = rb!.id
  const [ob] = await t.db
    .insert(schema.orgUnit)
    .values({ regionId: regionBId, path: 'rpb.svc', code: 'rpb-svc', displayName: 'Svc B', unitType: 'bu' })
    .returning()
  ouBId = ob!.id
  const [couA] = await t.db
    .insert(schema.orgUnit)
    .values({ regionId, path: 'rp.cou', code: 'rp-cou', displayName: 'CoU A', unitType: 'bu', isCostOwningUnit: true })
    .returning()
  couAId = couA!.id
  const [couB] = await t.db
    .insert(schema.orgUnit)
    .values({ regionId: regionBId, path: 'rpb.cou', code: 'rpb-cou', displayName: 'CoU B', unitType: 'bu', isCostOwningUnit: true })
    .returning()
  couBId = couB!.id
  const [aa] = await t.db
    .insert(schema.teammate)
    .values({ entraOid: 'oid-rp-admin-a', email: 'rp-admin-a@x.test', role: 'admin', regionId, orgUnitId: ouId })
    .returning()
  adminAId = aa!.id
  const [ab] = await t.db
    .insert(schema.teammate)
    .values({ entraOid: 'oid-rp-admin-b', email: 'rp-admin-b@x.test', role: 'admin', regionId: regionBId, orgUnitId: ouBId })
    .returning()
  adminBId = ab!.id
}, 180_000)

afterAll(async () => {
  await stopTestDb(t)
}, 30_000)

// Clean the provider tables between describe blocks that assert counts.
async function clearProviders() {
  await t.client`DELETE FROM provider_org`
  await t.client`DELETE FROM provider_enterprise`
}

function ev(opts: {
  method: string
  body?: unknown
  session: Session
  params?: Record<string, string>
  /** Override the Origin header to simulate a cross-origin (CSRF) request. */
  origin?: string
}) {
  const headers: Record<string, string> = {
    host: 'localhost:3450',
    origin: opts.origin ?? 'http://localhost:3450',
  }
  const e = {
    method: opts.method,
    path: '/x',
    context: { params: opts.params ?? {} },
    node: {
      req: {
        method: opts.method,
        url: '/x',
        body: opts.body,
        socket: { remoteAddress: '127.0.0.1' },
        get headers() {
          return { ...headers, 'content-type': 'application/json' }
        },
      },
      res: {
        _headers: {} as Record<string, string | string[]>,
        statusCode: 200,
        getHeader(n: string) { return this._headers[n.toLowerCase()] },
        setHeader(n: string, v: string | string[]) { this._headers[n.toLowerCase()] = v },
        removeHeader(n: string) { this._headers[n.toLowerCase()] = '' },
        appendHeader(n: string, v: string | string[]) { this._headers[n.toLowerCase()] = v },
        get headersSent() { return false },
      },
    },
  }
  injectTestSession(e as unknown as Parameters<typeof injectTestSession>[0], opts.session)
  return e as unknown as Parameters<typeof orgsPost>[0]
}

const finops = (): Session => ({ teammateId: finopsId, email: 'rp-fin@x.test', displayName: 'Fin', role: 'platform-admin', regionId, orgPath: 'rp.svc' })
const dev = (): Session => ({ teammateId: devId, email: 'rp-dev@x.test', displayName: 'Dev', role: 'developer', regionId, orgPath: 'rp.svc' })
const adminA = (): Session => ({ teammateId: adminAId, email: 'rp-admin-a@x.test', displayName: 'Admin A', role: 'admin', regionId, orgPath: 'rp.svc' })
const adminB = (): Session => ({ teammateId: adminBId, email: 'rp-admin-b@x.test', displayName: 'Admin B', role: 'admin', regionId: regionBId, orgPath: 'rpb.svc' })

async function auditCount(eventType: string, subjectId: string): Promise<number> {
  const rows = await t.client<{ n: string }[]>`
    SELECT COUNT(*)::text AS n FROM audit_event WHERE event_type = ${eventType} AND subject_id = ${subjectId}::uuid`
  return Number(rows[0]!.n)
}

// ---- a tiny in-process stub of the Anthropic API, for discover ----
let server: Server | null = null
async function serve(handler: Parameters<typeof createServer>[1]): Promise<string> {
  server = createServer(handler)
  await new Promise<void>((r) => server!.listen(0, '127.0.0.1', () => r()))
  const addr = server!.address()
  return `http://127.0.0.1:${typeof addr === 'object' && addr ? addr.port : 0}`
}
afterEach(async () => {
  if (server) {
    await new Promise<void>((r) => server!.close(() => r()))
    server = null
  }
})

describe('RBAC', () => {
  it('a non-admin (developer) is 403 on every provider route', async () => {
    await expect(orgsGet(ev({ method: 'GET', session: dev() }))).rejects.toMatchObject({ statusCode: 403 })
    await expect(
      orgsPost(ev({ method: 'POST', session: dev(), body: { provider: 'github', externalOrgId: 'o', displayName: 'O', reconciliationMode: 'indicative' } })),
    ).rejects.toMatchObject({ statusCode: 403 })
    await expect(entGet(ev({ method: 'GET', session: dev() }))).rejects.toMatchObject({ statusCode: 403 })
    await expect(
      discoverPost(ev({ method: 'POST', session: dev(), body: { credentialSecretName: 'k-dev' } })),
    ).rejects.toMatchObject({ statusCode: 403 })
  })
})

describe('provider_enterprise CRUD + lowercase + UNIQUE', () => {
  beforeAll(clearProviders)
  let ghEntId = ''

  it('creates a github enterprise (lowercase slug) and audits it', async () => {
    const res = (await entPost(ev({
      method: 'POST',
      session: finops(),
      body: { provider: 'github', externalId: 'acme-partner-demo', displayName: 'Acme Partner Demo', reconciliationMode: 'reconciled', billing: 'billed', credentialSecretName: 'gh-partner-pat' },
    }))) as { id: string; externalId: string }
    expect(res.externalId).toBe('acme-partner-demo')
    ghEntId = res.id
    expect(await auditCount('provider-enterprise-created', ghEntId)).toBe(1)
  })

  it('auto-lowercases a mixed-case github slug (GitHub canonicalises slugs to lowercase)', async () => {
    const res = (await entPost(ev({
      method: 'POST',
      session: finops(),
      body: { provider: 'github', externalId: 'Insight-Mixed-Case', displayName: 'X' },
    }))) as { externalId: string }
    expect(res.externalId).toBe('insight-mixed-case')
  })

  it('auto-lowercases an anthropic enterprise external_id', async () => {
    const res = (await entPost(ev({
      method: 'POST',
      session: finops(),
      body: { provider: 'anthropic', externalId: 'Org-ABC-123', displayName: 'Anthropic Ent' },
    }))) as { externalId: string }
    expect(res.externalId).toBe('org-abc-123')
  })

  it('UNIQUE (provider, lower(external_id)) → 409 (case-insensitive)', async () => {
    await expect(
      entPost(ev({
        method: 'POST',
        session: finops(),
        body: { provider: 'github', externalId: 'acme-partner-demo', displayName: 'Dup' },
      })),
    ).rejects.toMatchObject({ statusCode: 409 })
  })

  it('patches displayName + reconciliationMode, audited', async () => {
    const res = (await entPatch(ev({
      method: 'PATCH', session: finops(), params: { id: ghEntId },
      body: { displayName: 'Renamed Ent', reconciliationMode: 'indicative' },
    }))) as { updated: boolean }
    expect(res.updated).toBe(true)
    const rows = await t.client<{ display_name: string; reconciliation_mode: string }[]>`
      SELECT display_name, reconciliation_mode FROM provider_enterprise WHERE id = ${ghEntId}::uuid`
    expect(rows[0]!.display_name).toBe('Renamed Ent')
    expect(rows[0]!.reconciliation_mode).toBe('indicative')
    expect(await auditCount('provider-enterprise-updated', ghEntId)).toBe(1)
  })

  it('persists Copilot flat seat + allowance (ADR-0010 D1/D2) through PATCH → GET', async () => {
    const res = (await entPatch(ev({
      method: 'PATCH', session: finops(), params: { id: ghEntId },
      body: { flatSeatPriceUsd: 39, includedAllowanceUsd: 70 },
    }))) as { updated: boolean }
    expect(res.updated).toBe(true)
    const rows = await t.client<{ flat: string | null; allowance: string | null }[]>`
      SELECT flat_seat_price_usd::text AS flat, included_allowance_usd::text AS allowance
      FROM provider_enterprise WHERE id = ${ghEntId}::uuid`
    expect(Number(rows[0]!.flat)).toBe(39)
    expect(Number(rows[0]!.allowance)).toBe(70)
    // GET surfaces them as numbers for the admin UI.
    const got = (await entGet(ev({ method: 'GET', session: finops() }))) as {
      enterprises: { id: string; flatSeatPriceUsd: number | null; includedAllowanceUsd: number | null }[]
    }
    const gh = got.enterprises.find((e) => e.id === ghEntId)!
    expect(gh.flatSeatPriceUsd).toBe(39)
    expect(gh.includedAllowanceUsd).toBe(70)
    // Clearing with null disables that component again.
    await entPatch(ev({ method: 'PATCH', session: finops(), params: { id: ghEntId }, body: { flatSeatPriceUsd: null } }))
    const after = await t.client<{ flat: string | null }[]>`
      SELECT flat_seat_price_usd::text AS flat FROM provider_enterprise WHERE id = ${ghEntId}::uuid`
    expect(after[0]!.flat).toBeNull()
  })

  it('list returns the enterprises with keyPresent + orgCount', async () => {
    const got = (await entGet(ev({ method: 'GET', session: finops() }))) as {
      enterprises: { id: string; provider: string; externalId: string; keyPresent: boolean; orgCount: number }[]
      total: number
    }
    expect(got.total).toBeGreaterThanOrEqual(2)
    const gh = got.enterprises.find((e) => e.id === ghEntId)!
    expect(gh.provider).toBe('github')
    // no NUXT_GITHUB_PAT_GH_PARTNER_PAT env set → keyPresent false (presence only).
    expect(gh.keyPresent).toBe(false)
    expect(gh.orgCount).toBe(0)
  })
})

describe('provider_enterprise github_app_id (App-credential opt-in, mig 0078)', () => {
  beforeAll(clearProviders)
  const APP_SECRET = 'app-onboard'
  let appEntId = ''

  afterEach(() => {
    delete process.env.NUXT_GITHUB_APP_KEY_APP_ONBOARD
  })

  it('creates a github enterprise WITH github_app_id (App mode) and audits it', async () => {
    const res = (await entPost(ev({
      method: 'POST', session: finops(),
      body: { provider: 'github', externalId: 'app-mode-ent', displayName: 'App Mode Ent', reconciliationMode: 'reconciled', credentialSecretName: APP_SECRET, githubAppId: '1234567' },
    }))) as { id: string; githubAppId: string | null }
    expect(res.githubAppId).toBe('1234567')
    appEntId = res.id
    expect(await auditCount('provider-enterprise-created', appEntId)).toBe(1)
  })

  it('REJECTS a non-numeric github_app_id → 400 (provider-validation ^\\d+$)', async () => {
    await expect(
      entPost(ev({
        method: 'POST', session: finops(),
        body: { provider: 'github', externalId: 'app-bad-id', displayName: 'X', githubAppId: 'not-a-number' },
      })),
    ).rejects.toMatchObject({ statusCode: 400 })
  })

  it('REJECTS github_app_id on an ANTHROPIC enterprise → 400 (App is github-only)', async () => {
    await expect(
      entPost(ev({
        method: 'POST', session: finops(),
        body: { provider: 'anthropic', externalId: 'anth-app', displayName: 'X', githubAppId: '999' },
      })),
    ).rejects.toMatchObject({ statusCode: 400 })
  })

  it('list derives credentialKind=github-app and checks the App key for keyPresent', async () => {
    // No App key wired yet → App mode but keyPresent false (presence only, App key env).
    let got = (await entGet(ev({ method: 'GET', session: finops() }))) as {
      enterprises: { id: string; credentialKind: string; githubAppId: string | null; keyPresent: boolean }[]
    }
    let row = got.enterprises.find((e) => e.id === appEntId)!
    expect(row.credentialKind).toBe('github-app')
    expect(row.githubAppId).toBe('1234567')
    expect(row.keyPresent).toBe(false)

    // Wire the App private key env → keyPresent flips true (and NOT via a PAT env).
    process.env.NUXT_GITHUB_APP_KEY_APP_ONBOARD = 'base64-pem-placeholder'
    got = (await entGet(ev({ method: 'GET', session: finops() }))) as typeof got
    row = got.enterprises.find((e) => e.id === appEntId)!
    expect(row.keyPresent).toBe(true)
  })

  it('PATCH clears github_app_id (reverts to PAT) and re-PATCH sets it again', async () => {
    await entPatch(ev({ method: 'PATCH', session: finops(), params: { id: appEntId }, body: { githubAppId: null } }))
    let rows = await t.client<{ github_app_id: string | null }[]>`
      SELECT github_app_id FROM provider_enterprise WHERE id = ${appEntId}::uuid`
    expect(rows[0]!.github_app_id).toBeNull()

    await entPatch(ev({ method: 'PATCH', session: finops(), params: { id: appEntId }, body: { githubAppId: '7654321' } }))
    rows = await t.client<{ github_app_id: string | null }[]>`
      SELECT github_app_id FROM provider_enterprise WHERE id = ${appEntId}::uuid`
    expect(rows[0]!.github_app_id).toBe('7654321')
  })
})

describe('provider_org CRUD (both providers) + api_kind CHECK + linkage', () => {
  beforeAll(clearProviders)
  let ghEntId = ''
  let anthOrgId = ''
  let ghOrgId = ''

  beforeAll(async () => {
    const ent = (await entPost(ev({
      method: 'POST', session: finops(),
      body: { provider: 'github', externalId: 'gh-ent', displayName: 'GH Ent', reconciliationMode: 'reconciled', credentialSecretName: 'gh-ent-pat' },
    }))) as { id: string }
    ghEntId = ent.id
  })

  it('creates an anthropic org WITH api_kind + credential (reconciled), audited', async () => {
    const res = (await orgsPost(ev({
      method: 'POST', session: finops(),
      body: { provider: 'anthropic', externalOrgId: 'anthropic-org-1', displayName: 'Anthropic Org 1', reconciliationMode: 'reconciled', billing: 'billed', apiKind: 'enterprise-analytics', credentialSecretName: 'anthropic-org-1' },
    }))) as { id: string; apiKind: string }
    expect(res.apiKind).toBe('enterprise-analytics')
    anthOrgId = res.id
    expect(await auditCount('provider-org-created', anthOrgId)).toBe(1)
  })

  it('REJECTS an anthropic org WITHOUT api_kind (mig 0063 CHECK) → 400', async () => {
    await expect(
      orgsPost(ev({
        method: 'POST', session: finops(),
        body: { provider: 'anthropic', externalOrgId: 'anthropic-no-kind', displayName: 'X', reconciliationMode: 'indicative' },
      })),
    ).rejects.toMatchObject({ statusCode: 400 })
  })

  it('REJECTS a reconciled anthropic org without a credentialSecretName → 400', async () => {
    await expect(
      orgsPost(ev({
        method: 'POST', session: finops(),
        body: { provider: 'anthropic', externalOrgId: 'anthropic-no-cred', displayName: 'X', reconciliationMode: 'reconciled', apiKind: 'claude-code-admin' },
      })),
    ).rejects.toMatchObject({ statusCode: 400 })
  })

  it('creates a github org linked to its enterprise (api_kind NULL), audited', async () => {
    const res = (await orgsPost(ev({
      method: 'POST', session: finops(),
      body: { provider: 'github', externalOrgId: 'gh-org-1', displayName: 'GH Org 1', reconciliationMode: 'reconciled', billing: 'billed', providerEnterpriseId: ghEntId },
    }))) as { id: string; apiKind: string | null; providerEnterpriseId: string | null }
    expect(res.apiKind).toBeNull()
    expect(res.providerEnterpriseId).toBe(ghEntId)
    ghOrgId = res.id
    expect(await auditCount('provider-org-created', ghOrgId)).toBe(1)
  })

  it('REJECTS a github org WITH api_kind (mig 0063 CHECK) → 400', async () => {
    await expect(
      orgsPost(ev({
        method: 'POST', session: finops(),
        body: { provider: 'github', externalOrgId: 'gh-org-bad', displayName: 'X', reconciliationMode: 'indicative', apiKind: 'claude-code-admin' },
      })),
    ).rejects.toMatchObject({ statusCode: 400 })
  })

  it('REJECTS linking a github org to an ANTHROPIC enterprise (same-provider rule) → 400', async () => {
    const anthEnt = (await entPost(ev({
      method: 'POST', session: finops(),
      body: { provider: 'anthropic', externalId: 'anth-ent-x', displayName: 'Anth Ent X' },
    }))) as { id: string }
    await expect(
      orgsPost(ev({
        method: 'POST', session: finops(),
        body: { provider: 'github', externalOrgId: 'gh-org-mis', displayName: 'X', reconciliationMode: 'indicative', providerEnterpriseId: anthEnt.id },
      })),
    ).rejects.toMatchObject({ statusCode: 400 })
  })

  it('REJECTS linking to a non-existent enterprise → 404', async () => {
    await expect(
      orgsPost(ev({
        method: 'POST', session: finops(),
        body: { provider: 'github', externalOrgId: 'gh-org-orphan', displayName: 'X', reconciliationMode: 'indicative', providerEnterpriseId: '00000000-0000-0000-0000-000000000001' },
      })),
    ).rejects.toMatchObject({ statusCode: 404 })
  })

  it('UNIQUE (provider, external_org_id) → 409', async () => {
    await expect(
      orgsPost(ev({
        method: 'POST', session: finops(),
        body: { provider: 'anthropic', externalOrgId: 'anthropic-org-1', displayName: 'Dup', reconciliationMode: 'indicative', apiKind: 'claude-code-admin' },
      })),
    ).rejects.toMatchObject({ statusCode: 409 })
  })

  it('auto-lowercases a mixed-case github org slug (mig 0064 canonical lowercase)', async () => {
    const res = (await orgsPost(ev({
      method: 'POST', session: finops(),
      body: { provider: 'github', externalOrgId: 'Mixed-Case-Org', displayName: 'X', reconciliationMode: 'indicative' },
    }))) as { externalOrgId: string }
    expect(res.externalOrgId).toBe('mixed-case-org')
  })

  it('a case-variant github org collides case-INSENSITIVELY → 409 (mig 0064)', async () => {
    // create lowercase, then a differently-cased variant auto-lowercases to the SAME slug → 409.
    await orgsPost(ev({
      method: 'POST', session: finops(),
      body: { provider: 'github', externalOrgId: 'casevariant-org', displayName: 'Case Variant', reconciliationMode: 'indicative' },
    }))
    await expect(
      orgsPost(ev({
        method: 'POST', session: finops(),
        // 'CaseVariant-Org' auto-lowercases to 'casevariant-org' → the case-insensitive 409.
        body: { provider: 'github', externalOrgId: 'CaseVariant-Org', displayName: 'Dup', reconciliationMode: 'indicative' },
      })),
    ).rejects.toMatchObject({ statusCode: 409 })
    // exactly one row exists for that slug, case-insensitively.
    const rows = await t.client<{ n: string }[]>`
      SELECT COUNT(*)::text AS n FROM provider_org WHERE provider = 'github' AND lower(external_org_id) = 'casevariant-org'`
    expect(Number(rows[0]!.n)).toBe(1)
  })

  it('patch re-validates the CHECK: clearing api_kind on an anthropic org → 400', async () => {
    await expect(
      orgPatch(ev({ method: 'PATCH', session: finops(), params: { id: anthOrgId }, body: { apiKind: null } })),
    ).rejects.toMatchObject({ statusCode: 400 })
  })

  it('patch updates billing + notes + apiKind, audited', async () => {
    const res = (await orgPatch(ev({
      method: 'PATCH', session: finops(), params: { id: anthOrgId },
      body: { billing: 'tracked', notes: 'switched lane', apiKind: 'claude-code-admin' },
    }))) as { updated: boolean }
    expect(res.updated).toBe(true)
    const rows = await t.client<{ billing: string; api_kind: string; notes: string }[]>`
      SELECT billing, api_kind, notes FROM provider_org WHERE id = ${anthOrgId}::uuid`
    expect(rows[0]!.billing).toBe('tracked')
    expect(rows[0]!.api_kind).toBe('claude-code-admin')
    expect(rows[0]!.notes).toBe('switched lane')
    expect(await auditCount('provider-org-updated', anthOrgId)).toBe(1)
  })

  it('PATCH omitting providerEnterpriseId leaves an existing link UNCHANGED (MEDIUM-3)', async () => {
    // Link a fresh anthropic org to an anthropic enterprise, then PATCH only
    // displayName (no providerEnterpriseId key) — the link must survive (the dialog
    // now OMITS the key for anthropic so the server's "absent = unchanged" holds).
    const anthEnt = (await entPost(ev({
      method: 'POST', session: finops(),
      body: { provider: 'anthropic', externalId: 'm3-anth-ent', displayName: 'M3 Ent' },
    }))) as { id: string }
    const linkedOrg = (await orgsPost(ev({
      method: 'POST', session: finops(),
      body: { provider: 'anthropic', externalOrgId: 'm3-anth-org', displayName: 'M3 Org', reconciliationMode: 'indicative', apiKind: 'claude-code-admin', providerEnterpriseId: anthEnt.id },
    }))) as { id: string }
    await orgPatch(ev({
      method: 'PATCH', session: finops(), params: { id: linkedOrg.id },
      body: { displayName: 'M3 Renamed' },
    }))
    const rows = await t.client<{ provider_enterprise_id: string | null }[]>`
      SELECT provider_enterprise_id::text AS provider_enterprise_id FROM provider_org WHERE id = ${linkedOrg.id}::uuid`
    expect(rows[0]!.provider_enterprise_id).toBe(anthEnt.id)
  })

  it('list returns BOTH providers joined to the enterprise, with keyPresent and NO health, and makes no outbound call', async () => {
    vi.mocked(computeOrgHealth).mockClear()
    const got = (await orgsGet(ev({ method: 'GET', session: finops() }))) as {
      orgs: {
        id: string; provider: string; externalOrgId: string; apiKind: string | null
        enterprise: { id: string } | null; keyPresent: boolean
      }[]
      total: number
    }
    const anth = got.orgs.find((o) => o.id === anthOrgId)!
    const gh = got.orgs.find((o) => o.id === ghOrgId)!
    expect(anth.provider).toBe('anthropic')
    expect(anth.keyPresent).toBe(false) // no NUXT_ANTHROPIC_KEY_* env wired
    expect(gh.provider).toBe('github')
    expect(gh.apiKind).toBeNull()
    expect(gh.enterprise!.id).toBe(ghEntId)
    // D5: the verdict is served by anthropic/health alone (per org, keyed by
    // externalOrgId — lane-conversion-routes.test.ts covers it). The list
    // carries no `health` key at all and pays no probe.
    for (const o of got.orgs) expect(o).not.toHaveProperty('health')
    expect(computeOrgHealth).not.toHaveBeenCalled()
  })

  it('deletes the github org (leaf), audited; second delete → 404', async () => {
    const res = (await orgDelete(ev({ method: 'DELETE', session: finops(), params: { id: ghOrgId } }))) as { deleted: boolean }
    expect(res.deleted).toBe(true)
    expect(await auditCount('provider-org-deleted', ghOrgId)).toBe(1)
    await expect(
      orgDelete(ev({ method: 'DELETE', session: finops(), params: { id: ghOrgId } })),
    ).rejects.toMatchObject({ statusCode: 404 })
  })

  it('deleting an enterprise with a linked org → 409; after the org is gone it deletes', async () => {
    // anthOrgId is standalone (not linked). Link a fresh org to ghEntId, then try delete.
    const linked = (await orgsPost(ev({
      method: 'POST', session: finops(),
      body: { provider: 'github', externalOrgId: 'gh-org-link2', displayName: 'L2', reconciliationMode: 'indicative', providerEnterpriseId: ghEntId },
    }))) as { id: string }
    await expect(
      entDelete(ev({ method: 'DELETE', session: finops(), params: { id: ghEntId } })),
    ).rejects.toMatchObject({ statusCode: 409 })
    await orgDelete(ev({ method: 'DELETE', session: finops(), params: { id: linked.id } }))
    const res = (await entDelete(ev({ method: 'DELETE', session: finops(), params: { id: ghEntId } }))) as { deleted: boolean }
    expect(res.deleted).toBe(true)
    expect(await auditCount('provider-enterprise-deleted', ghEntId)).toBe(1)
  })
})

describe('anthropic key-shape write-guard (validateKeyFormat)', () => {
  beforeAll(clearProviders)
  // credentialSecretName 'guard-key' → env NUXT_ANTHROPIC_KEY_GUARD_KEY.
  const ADMIN_KEY = 'sk-ant-admin01-guard-DO-NOT-LEAK'
  afterEach(() => {
    delete process.env.NUXT_ANTHROPIC_KEY_GUARD_KEY
  })

  it('REJECTS an sk-ant-admin01- key wired on an enterprise-analytics org → 400 (key not echoed)', async () => {
    process.env.NUXT_ANTHROPIC_KEY_GUARD_KEY = ADMIN_KEY
    let thrown: { statusCode?: number; data?: { detail?: string } } | undefined
    try {
      await orgsPost(ev({
        method: 'POST', session: finops(),
        body: { provider: 'anthropic', externalOrgId: 'guard-org-1', displayName: 'Guard', reconciliationMode: 'reconciled', apiKind: 'enterprise-analytics', credentialSecretName: 'guard-key' },
      }))
    } catch (e) {
      thrown = e as typeof thrown
    }
    expect(thrown?.statusCode).toBe(400)
    // the safe 400 reason must NEVER carry the key value.
    expect(JSON.stringify(thrown?.data ?? {})).not.toContain(ADMIN_KEY)
  })

  it('ACCEPTS a matching key (admin key on a claude-code-admin org)', async () => {
    process.env.NUXT_ANTHROPIC_KEY_GUARD_KEY = ADMIN_KEY
    const res = (await orgsPost(ev({
      method: 'POST', session: finops(),
      body: { provider: 'anthropic', externalOrgId: 'guard-org-2', displayName: 'Guard OK', reconciliationMode: 'reconciled', apiKind: 'claude-code-admin', credentialSecretName: 'guard-key' },
    }))) as { id: string }
    expect(res.id).toBeTruthy()
  })

  it('SKIPS the guard when no key is wired yet (name set, env absent)', async () => {
    // no NUXT_ANTHROPIC_KEY_GUARD_KEY set → guard is skipped, create succeeds.
    const res = (await orgsPost(ev({
      method: 'POST', session: finops(),
      body: { provider: 'anthropic', externalOrgId: 'guard-org-3', displayName: 'Guard NoKey', reconciliationMode: 'reconciled', apiKind: 'enterprise-analytics', credentialSecretName: 'guard-key' },
    }))) as { id: string }
    expect(res.id).toBeTruthy()
  })

  it('PATCH re-guards: flipping a wired admin-keyed org to enterprise-analytics → 400', async () => {
    // create a claude-code-admin org with the admin key wired.
    process.env.NUXT_ANTHROPIC_KEY_GUARD_KEY = ADMIN_KEY
    const created = (await orgsPost(ev({
      method: 'POST', session: finops(),
      body: { provider: 'anthropic', externalOrgId: 'guard-org-4', displayName: 'Guard Patch', reconciliationMode: 'reconciled', apiKind: 'claude-code-admin', credentialSecretName: 'guard-key' },
    }))) as { id: string }
    // flipping to enterprise-analytics with the admin key still wired → mismatch 400.
    await expect(
      orgPatch(ev({ method: 'PATCH', session: finops(), params: { id: created.id }, body: { apiKind: 'enterprise-analytics' } })),
    ).rejects.toMatchObject({ statusCode: 400 })
  })
})

describe('provider_org cross-region clamp — create/patch (idor:0004 / T3-xregion-05)', () => {
  beforeAll(clearProviders)

  it('region-A admin creating a provider_org mapped to region B → 403', async () => {
    await expect(
      orgsPost(ev({
        method: 'POST', session: adminA(),
        body: { provider: 'github', externalOrgId: 'xr-create-b', displayName: 'X', reconciliationMode: 'indicative', regionId: regionBId },
      })),
    ).rejects.toMatchObject({ statusCode: 403 })
    const rows = await t.client<{ n: string }[]>`SELECT COUNT(*)::text AS n FROM provider_org WHERE external_org_id = 'xr-create-b'`
    expect(Number(rows[0]!.n)).toBe(0)
  })

  it('region-A admin creating a region-A org WITH a region-B costOwningUnitId → rejected', async () => {
    await expect(
      orgsPost(ev({
        method: 'POST', session: adminA(),
        body: { provider: 'github', externalOrgId: 'xr-cou-b', displayName: 'X', reconciliationMode: 'indicative', regionId, costOwningUnitId: couBId },
      })),
    ).rejects.toMatchObject({ statusCode: 422 })
  })

  it('region-A admin creates a region-A org with a region-A costOwningUnitId → 200', async () => {
    const res = (await orgsPost(ev({
      method: 'POST', session: adminA(),
      body: { provider: 'github', externalOrgId: 'xr-own-a', displayName: 'Own A', reconciliationMode: 'indicative', regionId, costOwningUnitId: couAId },
    }))) as { id: string }
    expect(res.id).toBeTruthy()
  })

  it('region-A admin patching a provider_org to regionId=B → 403', async () => {
    const created = (await orgsPost(ev({
      method: 'POST', session: adminA(),
      body: { provider: 'github', externalOrgId: 'xr-patch-target', displayName: 'X', reconciliationMode: 'indicative', regionId },
    }))) as { id: string }
    await expect(
      orgPatch(ev({ method: 'PATCH', session: adminA(), params: { id: created.id }, body: { regionId: regionBId } })),
    ).rejects.toMatchObject({ statusCode: 403 })
    const rows = await t.client<{ region_id: string | null }[]>`SELECT region_id::text AS region_id FROM provider_org WHERE id = ${created.id}::uuid`
    expect(rows[0]!.region_id).toBe(regionId) // patch rolled back — still in region A
  })

  it('region-A admin patching a region-B org WITHOUT regionId in the body → 403 (the source-side clamp)', async () => {
    // The destination clamp keys on what the caller SENT, so omitting regionId
    // skipped it entirely and let a region-A admin rewrite any other field of a
    // region-B-mapped org. The clamp must key on the ROW's region, not the body's.
    const b = (await orgsPost(ev({
      method: 'POST', session: finops(),
      body: { provider: 'github', externalOrgId: 'xr-src-clamp-b', displayName: 'Src B', reconciliationMode: 'indicative', regionId: regionBId },
    }))) as { id: string }
    await expect(
      orgPatch(ev({ method: 'PATCH', session: adminA(), params: { id: b.id }, body: { displayName: 'renamed by region A' } })),
      // 404, not 403 (PR #204 review): a 403 here beside a 404 for an unknown id
      // lets a region admin enumerate which ids exist in other regions.
    ).rejects.toMatchObject({ statusCode: 404 })
    const rows = await t.client<{ display_name: string }[]>`SELECT display_name FROM provider_org WHERE id = ${b.id}::uuid`
    expect(rows[0]!.display_name).toBe('Src B') // denial rolled back, nothing written
    // The owning region's admin is unaffected.
    await orgPatch(ev({ method: 'PATCH', session: adminB(), params: { id: b.id }, body: { displayName: 'renamed by region B' } }))
    const after = await t.client<{ display_name: string }[]>`SELECT display_name FROM provider_org WHERE id = ${b.id}::uuid`
    expect(after[0]!.display_name).toBe('renamed by region B')
  })

  it('moving an org to another region with ONLY regionId in the body is refused while its CoU stays behind', async () => {
    // The CoU-consistency check only fired when the body supplied costOwningUnitId,
    // so a pure region move slipped past it and left pooled Copilot chargeback homing
    // to a CoU in the region the org just left. Nothing at the DB level prevents that.
    const created = (await orgsPost(ev({
      method: 'POST', session: finops(),
      body: {
        provider: 'github', externalOrgId: 'xr-region-move', displayName: 'Move', reconciliationMode: 'indicative',
        regionId, costOwningUnitId: couAId,
      },
    }))) as { id: string }
    await expect(
      orgPatch(ev({ method: 'PATCH', session: finops(), params: { id: created.id }, body: { regionId: regionBId } })),
    ).rejects.toMatchObject({ statusCode: 422 })
    const rows = await t.client<{ region_id: string }[]>`SELECT region_id::text AS region_id FROM provider_org WHERE id = ${created.id}::uuid`
    expect(rows[0]!.region_id).toBe(regionId) // refused and rolled back, still in region A

    // Re-pointing the CoU in the SAME request is the supported path and still works.
    await orgPatch(ev({
      method: 'PATCH', session: finops(), params: { id: created.id },
      body: { regionId: regionBId, costOwningUnitId: couBId },
    }))
    const after = await t.client<{ region_id: string; cost_owning_unit_id: string }[]>`
      SELECT region_id::text AS region_id, cost_owning_unit_id::text AS cost_owning_unit_id
      FROM provider_org WHERE id = ${created.id}::uuid`
    expect(after[0]!.region_id).toBe(regionBId)
    expect(after[0]!.cost_owning_unit_id).toBe(couBId)
  })

  it('an UNMAPPED org is estate-wide: a region admin PATCH is 403 (S13), platform-admin 200', async () => {
    const unmapped = (await orgsPost(ev({
      method: 'POST', session: finops(),
      body: { provider: 'github', externalOrgId: 'xr-src-clamp-unmapped', displayName: 'Unmapped', reconciliationMode: 'indicative' },
    }))) as { id: string }
    await expect(
      orgPatch(ev({ method: 'PATCH', session: adminB(), params: { id: unmapped.id }, body: { displayName: 'claimed by B' } })),
    ).rejects.toMatchObject({ statusCode: 403 })
    // Claiming it into the caller's own region is the same write.
    await expect(
      orgPatch(ev({ method: 'PATCH', session: adminB(), params: { id: unmapped.id }, body: { regionId: regionBId } })),
    ).rejects.toMatchObject({ statusCode: 403 })
    const rows = await t.client<{ display_name: string; region_id: string | null }[]>`
      SELECT display_name, region_id::text AS region_id FROM provider_org WHERE id = ${unmapped.id}::uuid`
    expect(rows[0]).toEqual({ display_name: 'Unmapped', region_id: null })
    const res = (await orgPatch(ev({
      method: 'PATCH', session: finops(), params: { id: unmapped.id }, body: { displayName: 'renamed by platform' },
    }))) as { updated: boolean }
    expect(res.updated).toBe(true)
  })

  it('region-A admin patching costOwningUnitId to a region-B unit (regionId=A) → rejected', async () => {
    const created = (await orgsPost(ev({
      method: 'POST', session: adminA(),
      body: { provider: 'github', externalOrgId: 'xr-patch-cou', displayName: 'X', reconciliationMode: 'indicative', regionId },
    }))) as { id: string }
    await expect(
      orgPatch(ev({ method: 'PATCH', session: adminA(), params: { id: created.id }, body: { costOwningUnitId: couBId } })),
    ).rejects.toMatchObject({ statusCode: 422 })
  })

  it('platform-admin creates/patches across regions without restriction', async () => {
    const res = (await orgsPost(ev({
      method: 'POST', session: finops(),
      body: { provider: 'github', externalOrgId: 'xr-finops-b', displayName: 'Finops B', reconciliationMode: 'indicative', regionId: regionBId },
    }))) as { id: string }
    const patched = (await orgPatch(ev({
      method: 'PATCH', session: finops(), params: { id: res.id }, body: { regionId, costOwningUnitId: couAId },
    }))) as { updated: boolean }
    expect(patched.updated).toBe(true)
  })
})

describe('S13 — estate-wide provider config is platform-admin only', () => {
  beforeAll(clearProviders)

  it('provider_enterprise POST / PATCH / DELETE: region admin 403 and nothing written; platform-admin 200', async () => {
    await expect(
      entPost(ev({ method: 'POST', session: adminA(), body: { provider: 'github', externalId: 's13-ent-a', displayName: 'A', reconciliationMode: 'indicative' } })),
    ).rejects.toMatchObject({ statusCode: 403 })
    const none = await t.client<{ n: string }[]>`SELECT COUNT(*)::text AS n FROM provider_enterprise WHERE external_id = 's13-ent-a'`
    expect(Number(none[0]!.n)).toBe(0)

    const ent = (await entPost(ev({
      method: 'POST', session: finops(), body: { provider: 'github', externalId: 's13-ent', displayName: 'S13', reconciliationMode: 'indicative' },
    }))) as { id: string }
    await expect(
      entPatch(ev({ method: 'PATCH', session: adminA(), params: { id: ent.id }, body: { displayName: 'by region A' } })),
    ).rejects.toMatchObject({ statusCode: 403 })
    await expect(
      entPatch(ev({ method: 'PATCH', session: adminA(), params: { id: ent.id }, body: { credentialSecretName: 'other-key' } })),
    ).rejects.toMatchObject({ statusCode: 403 })
    await expect(
      entDelete(ev({ method: 'DELETE', session: adminA(), params: { id: ent.id } })),
    ).rejects.toMatchObject({ statusCode: 403 })
    const after = await t.client<{ display_name: string; credential_secret_name: string | null }[]>`
      SELECT display_name, credential_secret_name FROM provider_enterprise WHERE id = ${ent.id}::uuid`
    expect(after[0]).toEqual({ display_name: 'S13', credential_secret_name: null })

    await entPatch(ev({ method: 'PATCH', session: finops(), params: { id: ent.id }, body: { displayName: 'S13 renamed' } }))
    const renamed = await t.client<{ display_name: string }[]>`SELECT display_name FROM provider_enterprise WHERE id = ${ent.id}::uuid`
    expect(renamed[0]!.display_name).toBe('S13 renamed')
    await entDelete(ev({ method: 'DELETE', session: finops(), params: { id: ent.id } }))
    const gone = await t.client<{ n: string }[]>`SELECT COUNT(*)::text AS n FROM provider_enterprise WHERE id = ${ent.id}::uuid`
    expect(Number(gone[0]!.n)).toBe(0)
  })

  it('provider_org POST: a region admin may not create an UNMAPPED org or assign a credential (403); platform-admin may', async () => {
    await expect(
      orgsPost(ev({
        method: 'POST', session: adminA(),
        body: { provider: 'github', externalOrgId: 's13-unmapped', displayName: 'U', reconciliationMode: 'indicative' },
      })),
    ).rejects.toMatchObject({ statusCode: 403 })
    await expect(
      orgsPost(ev({
        method: 'POST', session: adminA(),
        body: {
          provider: 'anthropic', externalOrgId: 's13-cred', displayName: 'C', reconciliationMode: 'reconciled',
          apiKind: 'claude-code-admin', credentialSecretName: 'insight', regionId,
        },
      })),
    ).rejects.toMatchObject({ statusCode: 403 })
    const none = await t.client<{ n: string }[]>`
      SELECT COUNT(*)::text AS n FROM provider_org WHERE external_org_id IN ('s13-unmapped', 's13-cred')`
    expect(Number(none[0]!.n)).toBe(0)

    const u = (await orgsPost(ev({
      method: 'POST', session: finops(),
      body: { provider: 'github', externalOrgId: 's13-unmapped', displayName: 'U', reconciliationMode: 'indicative' },
    }))) as { id: string }
    expect(u.id).toBeTruthy()
    const c = (await orgsPost(ev({
      method: 'POST', session: finops(),
      body: {
        provider: 'anthropic', externalOrgId: 's13-cred', displayName: 'C', reconciliationMode: 'reconciled',
        apiKind: 'claude-code-admin', credentialSecretName: 'insight',
      },
    }))) as { id: string }
    expect(c.id).toBeTruthy()
  })

  it('provider_org PATCH on an own-region org: changing the credential or unmapping it is 403 for a region admin; an unchanged round-trip is 200', async () => {
    const org = (await orgsPost(ev({
      method: 'POST', session: finops(),
      body: {
        provider: 'anthropic', externalOrgId: 's13-own', displayName: 'Own', reconciliationMode: 'reconciled',
        apiKind: 'claude-code-admin', credentialSecretName: 'own-key', regionId,
      },
    }))) as { id: string }
    await expect(
      orgPatch(ev({ method: 'PATCH', session: adminA(), params: { id: org.id }, body: { credentialSecretName: 'insight' } })),
    ).rejects.toMatchObject({ statusCode: 403 })
    await expect(
      orgPatch(ev({ method: 'PATCH', session: adminA(), params: { id: org.id }, body: { regionId: null } })),
    ).rejects.toMatchObject({ statusCode: 403 })
    const rows = await t.client<{ credential_secret_name: string; region_id: string | null }[]>`
      SELECT credential_secret_name, region_id::text AS region_id FROM provider_org WHERE id = ${org.id}::uuid`
    expect(rows[0]).toEqual({ credential_secret_name: 'own-key', region_id: regionId })

    // The admin dialog always round-trips the current credential; that is not an assignment.
    const ok = (await orgPatch(ev({
      method: 'PATCH', session: adminA(), params: { id: org.id }, body: { displayName: 'Own renamed', credentialSecretName: 'own-key' },
    }))) as { updated: boolean }
    expect(ok.updated).toBe(true)
    const viaPlatform = (await orgPatch(ev({
      method: 'PATCH', session: finops(), params: { id: org.id }, body: { credentialSecretName: 'insight' },
    }))) as { updated: boolean }
    expect(viaPlatform.updated).toBe(true)
  })
})

describe('provider_org DELETE cross-region clamp + rollback', () => {
  beforeAll(clearProviders)
  let orgAId = ''
  let orgBId = ''
  let orgUnmappedId = ''

  beforeAll(async () => {
    const a = (await orgsPost(ev({ method: 'POST', session: finops(), body: { provider: 'github', externalOrgId: 'del-a', displayName: 'Del A', reconciliationMode: 'indicative', regionId } }))) as { id: string }
    orgAId = a.id
    const b = (await orgsPost(ev({ method: 'POST', session: finops(), body: { provider: 'github', externalOrgId: 'del-b', displayName: 'Del B', reconciliationMode: 'indicative', regionId: regionBId } }))) as { id: string }
    orgBId = b.id
    const u = (await orgsPost(ev({ method: 'POST', session: finops(), body: { provider: 'github', externalOrgId: 'del-u', displayName: 'Del U', reconciliationMode: 'indicative' } }))) as { id: string }
    orgUnmappedId = u.id
  })

  it('region-A admin DELETEs a region-B org → the SAME 404 an unknown id gets, and the row survives (rollback)', async () => {
    // PARITY IS THE CONTROL (PR #204 review): a 403 here beside a 404 for an
    // unknown id lets a region admin enumerate which provider_org ids exist in
    // other regions purely from the status code. Assert the two responses are
    // indistinguishable, not merely that both are 4xx.
    const foreign = await orgDelete(ev({ method: 'DELETE', session: adminA(), params: { id: orgBId } })).catch((e) => e)
    const unknown = await orgDelete(ev({ method: 'DELETE', session: adminA(), params: { id: '00000000-0000-0000-0000-000000000000' } })).catch((e) => e)
    expect(foreign.statusCode).toBe(404)
    expect(foreign.statusCode).toBe(unknown.statusCode)
    expect(foreign.statusMessage).toBe(unknown.statusMessage)
    expect(JSON.stringify(foreign.data)).toBe(JSON.stringify(unknown.data))
    // ...and the DELETE rolled back: the row is still there.
    const rows = await t.client<{ n: string }[]>`SELECT COUNT(*)::text AS n FROM provider_org WHERE id = ${orgBId}::uuid`
    expect(Number(rows[0]!.n)).toBe(1)
  })

  it('region-A admin deletes a region-A org → 200', async () => {
    const res = (await orgDelete(ev({ method: 'DELETE', session: adminA(), params: { id: orgAId } }))) as { deleted: boolean }
    expect(res.deleted).toBe(true)
  })

  it('an unmapped (region_id IS NULL) org: region admin DELETE is 403 and rolls back (S13); platform-admin 200', async () => {
    await expect(
      orgDelete(ev({ method: 'DELETE', session: adminA(), params: { id: orgUnmappedId } })),
    ).rejects.toMatchObject({ statusCode: 403 })
    const rows = await t.client<{ n: string }[]>`SELECT COUNT(*)::text AS n FROM provider_org WHERE id = ${orgUnmappedId}::uuid`
    expect(Number(rows[0]!.n)).toBe(1)
    const res = (await orgDelete(ev({ method: 'DELETE', session: finops(), params: { id: orgUnmappedId } }))) as { deleted: boolean }
    expect(res.deleted).toBe(true)
  })

  it('an unknown UUID → 404 for both region admins, identical body (no existence oracle)', async () => {
    const unknown = '00000000-0000-0000-0000-00000000dead'
    let errA: { statusCode?: number; data?: unknown } | undefined
    let errB: { statusCode?: number; data?: unknown } | undefined
    try {
      await orgDelete(ev({ method: 'DELETE', session: adminA(), params: { id: unknown } }))
    } catch (e) {
      errA = e as typeof errA
    }
    try {
      await orgDelete(ev({ method: 'DELETE', session: adminB(), params: { id: unknown } }))
    } catch (e) {
      errB = e as typeof errB
    }
    expect(errA?.statusCode).toBe(404)
    expect(errB?.statusCode).toBe(404)
    expect(JSON.stringify(errA?.data)).toBe(JSON.stringify(errB?.data))
  })

  it('platform-admin deletes a region-B org → 200', async () => {
    const b2 = (await orgsPost(ev({ method: 'POST', session: finops(), body: { provider: 'github', externalOrgId: 'del-b2', displayName: 'Del B2', reconciliationMode: 'indicative', regionId: regionBId } }))) as { id: string }
    const res = (await orgDelete(ev({ method: 'DELETE', session: finops(), params: { id: b2.id } }))) as { deleted: boolean }
    expect(res.deleted).toBe(true)
  })
})

describe('provider_org LIST region clamp (orgs.get / report:theme-5-map-post)', () => {
  beforeAll(clearProviders)
  let orgAId = ''
  let orgBId = ''
  let orgUnmappedId = ''

  beforeAll(async () => {
    const a = (await orgsPost(ev({ method: 'POST', session: finops(), body: { provider: 'github', externalOrgId: 'list-a', displayName: 'List A', reconciliationMode: 'indicative', regionId } }))) as { id: string }
    orgAId = a.id
    const b = (await orgsPost(ev({ method: 'POST', session: finops(), body: { provider: 'github', externalOrgId: 'list-b', displayName: 'List B', reconciliationMode: 'indicative', regionId: regionBId } }))) as { id: string }
    orgBId = b.id
    const u = (await orgsPost(ev({ method: 'POST', session: finops(), body: { provider: 'github', externalOrgId: 'list-u', displayName: 'List U', reconciliationMode: 'indicative' } }))) as { id: string }
    orgUnmappedId = u.id
  })

  it('region-A admin sees region-A + unmapped orgs, NOT region-B', async () => {
    const got = (await orgsGet(ev({ method: 'GET', session: adminA() }))) as { orgs: { id: string }[] }
    const ids = got.orgs.map((o) => o.id)
    expect(ids).toContain(orgAId)
    expect(ids).toContain(orgUnmappedId)
    expect(ids).not.toContain(orgBId)
  })

  it('platform-admin sees every region', async () => {
    const got = (await orgsGet(ev({ method: 'GET', session: finops() }))) as { orgs: { id: string }[] }
    const ids = got.orgs.map((o) => o.id)
    expect(ids).toContain(orgAId)
    expect(ids).toContain(orgBId)
    expect(ids).toContain(orgUnmappedId)
  })
})

describe('CSRF / mismatched-origin (assertSameOrigin)', () => {
  beforeAll(clearProviders)
  const X = 'http://evil.example' // origin that mismatches the host (localhost:3450)
  let orgId = ''
  let entId = ''

  beforeAll(async () => {
    const ent = (await entPost(ev({
      method: 'POST', session: finops(),
      body: { provider: 'github', externalId: 'csrf-ent', displayName: 'CSRF Ent' },
    }))) as { id: string }
    entId = ent.id
    const org = (await orgsPost(ev({
      method: 'POST', session: finops(),
      body: { provider: 'anthropic', externalOrgId: 'csrf-org', displayName: 'CSRF Org', reconciliationMode: 'indicative', apiKind: 'claude-code-admin' },
    }))) as { id: string }
    orgId = org.id
  })

  it('orgs POST with a mismatched origin → 403', async () => {
    await expect(
      orgsPost(ev({ method: 'POST', origin: X, session: finops(), body: { provider: 'github', externalOrgId: 'csrf-x', displayName: 'X', reconciliationMode: 'indicative' } })),
    ).rejects.toMatchObject({ statusCode: 403 })
  })
  it('orgs PATCH with a mismatched origin → 403', async () => {
    await expect(
      orgPatch(ev({ method: 'PATCH', origin: X, session: finops(), params: { id: orgId }, body: { billing: 'billed' } })),
    ).rejects.toMatchObject({ statusCode: 403 })
  })
  it('orgs DELETE with a mismatched origin → 403', async () => {
    await expect(
      orgDelete(ev({ method: 'DELETE', origin: X, session: finops(), params: { id: orgId } })),
    ).rejects.toMatchObject({ statusCode: 403 })
  })
  it('enterprises POST with a mismatched origin → 403', async () => {
    await expect(
      entPost(ev({ method: 'POST', origin: X, session: finops(), body: { provider: 'github', externalId: 'csrf-ent-x', displayName: 'X' } })),
    ).rejects.toMatchObject({ statusCode: 403 })
  })
  it('enterprises PATCH with a mismatched origin → 403', async () => {
    await expect(
      entPatch(ev({ method: 'PATCH', origin: X, session: finops(), params: { id: entId }, body: { displayName: 'Y' } })),
    ).rejects.toMatchObject({ statusCode: 403 })
  })
  it('enterprises DELETE with a mismatched origin → 403', async () => {
    await expect(
      entDelete(ev({ method: 'DELETE', origin: X, session: finops(), params: { id: entId } })),
    ).rejects.toMatchObject({ statusCode: 403 })
  })
  it('anthropic discover with a mismatched origin → 403', async () => {
    await expect(
      discoverPost(ev({ method: 'POST', origin: X, session: finops(), body: { credentialSecretName: 'csrf-disc' } })),
    ).rejects.toMatchObject({ statusCode: 403 })
  })
})

describe('anthropic discover', () => {
  const KEY = 'analytics-secret-value-DO-NOT-LEAK'
  const ADMIN_KEY = 'sk-ant-admin01-secret-DO-NOT-LEAK'

  afterEach(() => {
    delete process.env.NUXT_ANTHROPIC_API_ENDPOINT
    delete process.env.NUXT_ANTHROPIC_KEY_DISC_ENT
    delete process.env.NUXT_ANTHROPIC_KEY_DISC_ADMIN
  })

  it('detects enterprise-analytics and returns the stubbed organization_id; never leaks the key', async () => {
    let seenKey: string | undefined
    const bodies: string[] = []
    const url = await serve((req, res) => {
      seenKey = req.headers['x-api-key'] as string | undefined
      res.writeHead(200, { 'content-type': 'application/json' })
      const payload = JSON.stringify({ organization_id: 'org-discovered-123', has_more: false, next_page: null, data: [] })
      bodies.push(payload)
      res.end(payload)
    })
    process.env.NUXT_ANTHROPIC_API_ENDPOINT = url
    process.env.NUXT_ANTHROPIC_KEY_DISC_ENT = KEY

    const result = (await discoverPost(ev({ method: 'POST', session: finops(), body: { credentialSecretName: 'disc-ent' } }))) as {
      organizationId: string; apiKindDetected: string; keyFormatLooksLike: string
    }
    expect(result.organizationId).toBe('org-discovered-123')
    expect(result.apiKindDetected).toBe('enterprise-analytics')
    expect(result.keyFormatLooksLike).toBe('analytics')
    // the wire carried the key (correctly), but the RESPONSE body must not.
    expect(seenKey).toBe(KEY)
    expect(JSON.stringify(result)).not.toContain(KEY)
  })

  it('detects claude-code-admin from the sk-ant-admin01- prefix and reads org id off a record', async () => {
    const url = await serve((req, res) => {
      const u = new URL(req.url ?? '/', 'http://localhost')
      // the admin client hits /claude_code; answer with a record carrying org id.
      expect(u.pathname).toContain('/usage_report/claude_code')
      res.writeHead(200, { 'content-type': 'application/json' })
      res.end(JSON.stringify({
        has_more: false, next_page: null,
        data: [{ date: '2026-06-20', actor: { type: 'user_actor', email_address: 'd@x' }, organization_id: 'org-admin-789', model_breakdown: [] }],
      }))
    })
    process.env.NUXT_ANTHROPIC_API_ENDPOINT = url
    process.env.NUXT_ANTHROPIC_KEY_DISC_ADMIN = ADMIN_KEY

    const result = (await discoverPost(ev({ method: 'POST', session: finops(), body: { credentialSecretName: 'disc-admin' } }))) as {
      organizationId: string; apiKindDetected: string; keyFormatLooksLike: string
    }
    expect(result.organizationId).toBe('org-admin-789')
    expect(result.apiKindDetected).toBe('claude-code-admin')
    expect(result.keyFormatLooksLike).toBe('admin')
    expect(JSON.stringify(result)).not.toContain(ADMIN_KEY)
  })

  it('endpoint unset → 422 endpoint-unset (not a throw, no key)', async () => {
    process.env.NUXT_ANTHROPIC_KEY_DISC_ENT = KEY
    const e = ev({ method: 'POST', session: finops(), body: { credentialSecretName: 'disc-ent' } })
    const result = (await discoverPost(e)) as { reason: string }
    expect(result.reason).toBe('endpoint-unset')
    expect((e as unknown as { node: { res: { statusCode: number } } }).node.res.statusCode).toBe(422)
    expect(JSON.stringify(result)).not.toContain(KEY)
  })

  it('no key wired → 422 no-key', async () => {
    process.env.NUXT_ANTHROPIC_API_ENDPOINT = 'http://127.0.0.1:1'
    const result = (await discoverPost(ev({ method: 'POST', session: finops(), body: { credentialSecretName: 'disc-ent' } }))) as { reason: string }
    expect(result.reason).toBe('no-key')
  })

  it('401 from the provider → 422 401-unauthorized (safe reason, no raw error/key)', async () => {
    const url = await serve((_req, res) => { res.writeHead(401); res.end('Bad key xyz') })
    process.env.NUXT_ANTHROPIC_API_ENDPOINT = url
    process.env.NUXT_ANTHROPIC_KEY_DISC_ENT = KEY
    const result = (await discoverPost(ev({ method: 'POST', session: finops(), body: { credentialSecretName: 'disc-ent' } }))) as { reason: string }
    expect(result.reason).toBe('401-unauthorized')
    expect(JSON.stringify(result)).not.toContain('xyz')
  })
})
