// @vitest-environment node
/*
 * Intent: admin-route surface for Workstream C (design §5.3/§5.4/§8.4, §9 test
 * strategy). Exercises the real h3 handlers against a real testcontainers DB.
 * Covers:
 *   - RBAC: a non-admin (developer) -> 403 on every new route.
 *   - CSRF: a cross-origin POST -> 403.
 *   - Zod validation: malformed rate-plan bodies, malformed re-pull bodies.
 *   - Bounded month: a future month and a too-far-past month -> 400 on re-pull.
 *   - Legacy scalar / API compatibility: flatSeatPriceUsd/includedAllowanceUsd
 *     still round-trip through the enterprise CRUD exactly as before;
 *     overageAllocationPolicy is additive (default consumption-share).
 *   - ADR-0011 D7: an overageAllocationPolicy PATCH recomputes the persisted
 *     allocation for every OPEN month immediately (not just the next tick).
 *   - Historical re-pull: enterprise-not-found -> 404; non-github -> 400;
 *     a CLOSED finance period -> 409 (never a silent rewrite); an OPEN month
 *     with no credential configured completes as a no-op (proves the route
 *     reaches runCopilotPoolBill scoped to the right enterprise + month).
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import { randomUUID } from 'node:crypto'
import { startTestDb, stopTestDb, type TestDb } from '../helpers/db'
import * as schema from '../../../drizzle/schema'
import { injectTestSession } from '../../helpers/auth'
import type { Session } from '../../../server/utils/auth'

import entPost from '../../../server/api/v1/admin/reconciliation/enterprises.post'
import entPatch from '../../../server/api/v1/admin/reconciliation/enterprises/[id].patch'
import entGet from '../../../server/api/v1/admin/reconciliation/enterprises.get'
import ratePlansGet from '../../../server/api/v1/admin/reconciliation/enterprises/[id]/copilot-rate-plans.get'
import ratePlansPost from '../../../server/api/v1/admin/reconciliation/enterprises/[id]/copilot-rate-plans.post'
import billRepullPost from '../../../server/api/v1/admin/reconciliation/enterprises/[id]/copilot-bill-repull.post'
import { closeReportingSnapshot } from '../../../server/governance/reporting-snapshot'
import { persistCopilotOverageAllocation } from '../../../server/governance/copilot-overage-allocation'

let t: TestDb
let regionId: string
let ouId: string
let finopsId: string
let devId: string
let couA: string

beforeAll(async () => {
  t = await startTestDb()
  process.env.DATABASE_URL = t.url
  const [r] = await t.db.insert(schema.region).values({ code: 'cm-r', displayName: 'CM R' }).returning()
  regionId = r!.id
  const [o] = await t.db.insert(schema.orgUnit).values({ regionId, path: 'cm.svc', code: 'cm-svc', displayName: 'Svc', unitType: 'bu' }).returning()
  ouId = o!.id
  const [couRow] = await t.db
    .insert(schema.orgUnit)
    .values({ regionId, path: 'cm.cou', code: 'cm-cou', displayName: 'CoU', unitType: 'bu', isCostOwningUnit: true })
    .returning()
  couA = couRow!.id
  const [f] = await t.db.insert(schema.teammate).values({ entraOid: 'oid-cm-fin', email: 'cm-fin@x.test', role: 'platform-admin', regionId, orgUnitId: ouId }).returning()
  finopsId = f!.id
  const [d] = await t.db.insert(schema.teammate).values({ entraOid: 'oid-cm-dev', email: 'cm-dev@x.test', role: 'developer', regionId, orgUnitId: ouId }).returning()
  devId = d!.id
}, 180_000)

afterAll(async () => {
  await stopTestDb(t)
}, 30_000)

function ev(opts: {
  method: string
  body?: unknown
  session: Session
  params?: Record<string, string>
  origin?: string
}) {
  const headers: Record<string, string> = { host: 'localhost:3450', origin: opts.origin ?? 'http://localhost:3450' }
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
        getHeader(n: string) {
          return this._headers[n.toLowerCase()]
        },
        setHeader(n: string, v: string | string[]) {
          this._headers[n.toLowerCase()] = v
        },
        removeHeader(n: string) {
          this._headers[n.toLowerCase()] = ''
        },
        appendHeader(n: string, v: string | string[]) {
          this._headers[n.toLowerCase()] = v
        },
        get headersSent() {
          return false
        },
      },
    },
  }
  injectTestSession(e as unknown as Parameters<typeof injectTestSession>[0], opts.session)
  return e as unknown as Parameters<typeof entPost>[0]
}

const finops = (): Session => ({ teammateId: finopsId, email: 'cm-fin@x.test', displayName: 'Fin', role: 'platform-admin', regionId, orgPath: 'cm.svc' })
const dev = (): Session => ({ teammateId: devId, email: 'cm-dev@x.test', displayName: 'Dev', role: 'developer', regionId, orgPath: 'cm.svc' })

async function mkGithubEnterprise(externalId: string): Promise<string> {
  const [ent] = await t.db
    .insert(schema.providerEnterprise)
    .values({ provider: 'github', externalId, displayName: externalId, reconciliationMode: 'reconciled' })
    .returning({ id: schema.providerEnterprise.id })
  return ent!.id
}

describe('RBAC + CSRF', () => {
  it('a non-admin (developer) is 403 on every Workstream C route', async () => {
    const entId = await mkGithubEnterprise(`rbac-ent-${randomUUID().slice(0, 8)}`)
    await expect(ratePlansGet(ev({ method: 'GET', session: dev(), params: { id: entId } }))).rejects.toMatchObject({ statusCode: 403 })
    await expect(
      ratePlansPost(ev({ method: 'POST', session: dev(), params: { id: entId }, body: { validFrom: '2026-01-01' } })),
    ).rejects.toMatchObject({ statusCode: 403 })
    await expect(
      billRepullPost(ev({ method: 'POST', session: dev(), params: { id: entId }, body: { month: '2026-06', reason: 'test' } })),
    ).rejects.toMatchObject({ statusCode: 403 })
  })

  it('a cross-origin POST is rejected (CSRF)', async () => {
    const entId = await mkGithubEnterprise(`csrf-ent-${randomUUID().slice(0, 8)}`)
    await expect(
      ratePlansPost(
        ev({
          method: 'POST',
          session: finops(),
          params: { id: entId },
          origin: 'http://evil.example',
          body: { validFrom: '2026-01-01', flatSeatPriceUsd: 39 },
        }),
      ),
    ).rejects.toMatchObject({ statusCode: 403 })
  })
})

describe('copilot-rate-plans route', () => {
  it('403s a REGION admin on POST (S13: money-of-record for the whole estate); nothing is written', async () => {
    const entId = await mkGithubEnterprise(`rp-s13-${randomUUID().slice(0, 8)}`)
    const regionAdmin: Session = {
      teammateId: finopsId,
      email: 'cm-admin@x.test',
      displayName: 'Region Admin',
      role: 'admin',
      regionId,
      orgPath: 'cm.svc',
    }
    await expect(
      ratePlansPost(ev({ method: 'POST', session: regionAdmin, params: { id: entId }, body: { validFrom: '2026-01-01', flatSeatPriceUsd: 1 } })),
    ).rejects.toMatchObject({ statusCode: 403 })
    const rows = await t.client<{ n: string }[]>`
      SELECT COUNT(*)::text AS n FROM copilot_rate_plan WHERE provider_enterprise_id = ${entId}::uuid`
    expect(Number(rows[0]!.n)).toBe(0)
  })

  it('creates a rate plan and lists it back', async () => {
    const entId = await mkGithubEnterprise(`rp-ent-${randomUUID().slice(0, 8)}`)
    const created = (await ratePlansPost(
      ev({ method: 'POST', session: finops(), params: { id: entId }, body: { validFrom: '2026-01-01', flatSeatPriceUsd: 39, includedAllowanceUsd: 70 } }),
    )) as { plan: { id: string } }
    expect(created.plan.id).toBeTruthy()

    const list = (await ratePlansGet(ev({ method: 'GET', session: finops(), params: { id: entId } }))) as {
      plans: { id: string; flatSeatPriceUsd: number | null }[]
      total: number
    }
    expect(list.total).toBe(1)
    expect(list.plans[0]!.flatSeatPriceUsd).toBe(39)
  })

  it('rejects a malformed body (Zod) with 400', async () => {
    const entId = await mkGithubEnterprise(`rp-bad-${randomUUID().slice(0, 8)}`)
    await expect(
      ratePlansPost(ev({ method: 'POST', session: finops(), params: { id: entId }, body: { validFrom: 'not-a-date' } })),
    ).rejects.toMatchObject({ statusCode: 400 })
  })

  it('rejects an overlapping (non-superseding) effective range with 409 (conflict)', async () => {
    const entId = await mkGithubEnterprise(`rp-overlap-${randomUUID().slice(0, 8)}`)
    await ratePlansPost(
      ev({
        method: 'POST',
        session: finops(),
        params: { id: entId },
        body: { validFrom: '2026-01-01', validTo: '2026-06-01', flatSeatPriceUsd: 39 },
      }),
    )
    await expect(
      ratePlansPost(
        ev({
          method: 'POST',
          session: finops(),
          params: { id: entId },
          body: { validFrom: '2026-03-01', validTo: '2026-04-01', flatSeatPriceUsd: 50 },
        }),
      ),
    ).rejects.toMatchObject({ statusCode: 409 })
  })
})

describe('legacy scalar / API compatibility + overageAllocationPolicy', () => {
  it('flatSeatPriceUsd/includedAllowanceUsd still round-trip through create+patch+get exactly as before', async () => {
    const created = (await entPost(
      ev({
        method: 'POST',
        session: finops(),
        body: { provider: 'github', externalId: `legacy-${randomUUID().slice(0, 8)}`, displayName: 'Legacy', flatSeatPriceUsd: 39, includedAllowanceUsd: 70 },
      }),
    )) as { id: string; flatSeatPriceUsd: number | null; includedAllowanceUsd: number | null; overageAllocationPolicy: string }
    expect(created.flatSeatPriceUsd).toBe(39)
    expect(created.includedAllowanceUsd).toBe(70)
    // Additive default — an old client that never heard of this field still gets a sane one.
    expect(created.overageAllocationPolicy).toBe('consumption-share')

    await entPatch(ev({ method: 'PATCH', session: finops(), params: { id: created.id }, body: { flatSeatPriceUsd: 45 } }))
    const list = (await entGet(ev({ method: 'GET', session: finops() }))) as {
      enterprises: { id: string; flatSeatPriceUsd: number | null; overageAllocationPolicy: string }[]
    }
    const row = list.enterprises.find((e) => e.id === created.id)!
    expect(row.flatSeatPriceUsd).toBe(45)
    expect(row.overageAllocationPolicy).toBe('consumption-share')
  })

  it("ADR-0011 D7: an overageAllocationPolicy PATCH recomputes the persisted allocation for OPEN months immediately", async () => {
    const entId = await mkGithubEnterprise(`policy-ent-${randomUUID().slice(0, 8)}`)
    const MONTH = '2026-06-01'
    await t.db.insert(schema.copilotPoolBill).values({
      month: MONTH,
      providerEnterpriseId: entId,
      providerOrgId: null,
      costOwningUnitId: null,
      seats: 2,
      licenseNetUsd: null,
      includedAllowanceUsd: '100',
      usageGrossUsd: null,
      overageNetUsd: '100',
      unclassifiedNetUsd: '0',
    })
    const [tmA] = await t.db.insert(schema.teammate).values({ entraOid: `oid-pol-a-${randomUUID().slice(0, 6)}`, email: `pol.a.${randomUUID().slice(0, 6)}@x.test`, regionId, orgUnitId: couA }).returning()
    await t.db.insert(schema.reconciliationRecord).values({
      teammateId: tmA!.id, provider: 'github', enterpriseRef: (await t.client<{ external_id: string }[]>`SELECT external_id FROM provider_enterprise WHERE id = ${entId}::uuid`)[0]!.external_id,
      licenseOrg: 'acme', periodDate: '2026-06-10', category: 'copilot_interactive', scope: 'teammate',
      costOwningUnitId: couA, providerEnterpriseId: entId,
      actualUsd: '10', otelAttributedUsd: '0', deltaUsd: '10', spendClass: 'indicative', disposition: 'under', status: 'applied',
    })

    // Default policy (consumption-share) with only ONE consumer -> all 100 lands on couA.
    await t.db.transaction((tx) => persistCopilotOverageAllocation(tx, { providerEnterpriseId: entId, enterpriseExternalId: 'x', month: MONTH, actorSystem: 'test-seed' }))
    const before = await t.client<{ cou: string | null; usd: string }[]>`SELECT cost_owning_unit_id::text AS cou, allocated_usd::text AS usd FROM copilot_overage_allocation WHERE provider_enterprise_id = ${entId}::uuid`
    expect(before).toHaveLength(1)
    expect(before[0]!.cou).toBe(couA)

    // Switching to seat-share with NO seat-license actual_spend rows seeded -> zero weight -> unallocated.
    await entPatch(ev({ method: 'PATCH', session: finops(), params: { id: entId }, body: { overageAllocationPolicy: 'seat-share' } }))
    const after = await t.client<{ cou: string | null; usd: string }[]>`SELECT cost_owning_unit_id::text AS cou, allocated_usd::text AS usd FROM copilot_overage_allocation WHERE provider_enterprise_id = ${entId}::uuid`
    expect(after).toHaveLength(1)
    expect(after[0]!.cou).toBeNull() // seat-share found no seat-license rows -> unallocated
    expect(Number(after[0]!.usd)).toBe(100)
  })
})

describe('copilot-bill-repull route', () => {
  it('403s a REGION admin — provider_enterprise has no region to clamp them to', async () => {
    // External review, sprint 3: `admin` is region-scoped, but provider_enterprise
    // carries no region column, so admitting it here let any region admin delete and
    // rewrite ANY enterprise's bill month. Money-of-record; gated to platform-admin.
    const entId = await mkGithubEnterprise(`rbac-ent-${randomUUID().slice(0, 8)}`)
    const regionAdmin: Session = {
      teammateId: finopsId,
      email: 'cm-admin@x.test',
      displayName: 'Region Admin',
      role: 'admin',
      regionId,
      orgPath: 'cm.svc',
    }
    await expect(
      billRepullPost(ev({ method: 'POST', session: regionAdmin, params: { id: entId }, body: { month: '2026-06', reason: 'test' } })),
    ).rejects.toMatchObject({ statusCode: 403 })
  })

  it('404s for an unknown enterprise', async () => {
    await expect(
      billRepullPost(ev({ method: 'POST', session: finops(), params: { id: randomUUID() }, body: { month: '2026-06', reason: 'test' } })),
    ).rejects.toMatchObject({ statusCode: 404 })
  })

  it('400s for a non-github enterprise', async () => {
    const [ent] = await t.db
      .insert(schema.providerEnterprise)
      .values({ provider: 'anthropic', externalId: `anth-${randomUUID().slice(0, 8)}`, displayName: 'Anthropic', reconciliationMode: 'reconciled' })
      .returning({ id: schema.providerEnterprise.id })
    await expect(
      billRepullPost(ev({ method: 'POST', session: finops(), params: { id: ent!.id }, body: { month: '2026-06', reason: 'test' } })),
    ).rejects.toMatchObject({ statusCode: 400 })
  })

  it('400s on a future month (bounded input)', async () => {
    const entId = await mkGithubEnterprise(`bound-ent-${randomUUID().slice(0, 8)}`)
    const future = new Date()
    future.setUTCFullYear(future.getUTCFullYear() + 5)
    const futureMonth = `${future.getUTCFullYear()}-${String(future.getUTCMonth() + 1).padStart(2, '0')}`
    await expect(
      billRepullPost(ev({ method: 'POST', session: finops(), params: { id: entId }, body: { month: futureMonth, reason: 'test' } })),
    ).rejects.toMatchObject({ statusCode: 400 })
  })

  it('400s on a month too far in the past (bounded input)', async () => {
    const entId = await mkGithubEnterprise(`bound2-ent-${randomUUID().slice(0, 8)}`)
    await expect(
      billRepullPost(ev({ method: 'POST', session: finops(), params: { id: entId }, body: { month: '2000-01', reason: 'test' } })),
    ).rejects.toMatchObject({ statusCode: 400 })
  })

  it('400s on a malformed month or missing reason (Zod)', async () => {
    const entId = await mkGithubEnterprise(`zod-ent-${randomUUID().slice(0, 8)}`)
    await expect(
      billRepullPost(ev({ method: 'POST', session: finops(), params: { id: entId }, body: { month: '2026-13', reason: 'test' } })),
    ).rejects.toMatchObject({ statusCode: 400 })
    await expect(
      billRepullPost(ev({ method: 'POST', session: finops(), params: { id: entId }, body: { month: '2026-06', reason: '' } })),
    ).rejects.toMatchObject({ statusCode: 400 })
  })

  it('a RECORDED month is re-pulled like any other — the bill always lands', async () => {
    /*
     * THE INVERSION. This asserted a 409: a closed month refused the re-pull and
     * the operator had to reopen or restate first.
     *
     * The timeline that killed it — close at +2, the provider corrects its rows
     * at +6, the bill lands at +10 — meant the product rejected the
     * authoritative source because of a state we set ourselves. TokenScope is
     * not the billing system of record.
     */
    const entId = await mkGithubEnterprise(`closed-ent-${randomUUID().slice(0, 8)}`)
    await t.db.transaction((tx) => closeReportingSnapshot(tx, { periodMonth: '2026-05', actorTeammateId: finopsId }))

    const res = (await billRepullPost(
      ev({ method: 'POST', session: finops(), params: { id: entId }, body: { month: '2026-05', reason: 'test' } }),
    )) as { month: string }
    expect(res.month).toBe('2026-05')

    await t.client`DELETE FROM reporting_snapshot WHERE period_month = '2026-05-01'::date`
  })

  it('completes as a no-op with no credential configured, for an OPEN month (proves it reaches the scoped worker call)', async () => {
    const entId = await mkGithubEnterprise(`nocred-ent-${randomUUID().slice(0, 8)}`)
    const res = (await billRepullPost(
      ev({ method: 'POST', session: finops(), params: { id: entId }, body: { month: '2026-06', reason: 'test re-pull, no credential in this suite' } }),
    )) as { month: string; result: { enterprisesConsidered: number; enterprisesSkippedNoCredential: number } }
    expect(res.month).toBe('2026-06')
    expect(res.result.enterprisesConsidered).toBe(1)
    expect(res.result.enterprisesSkippedNoCredential).toBe(1)

    const [{ n }] = await t.client<{ n: string }[]>`
      SELECT count(*)::text AS n FROM audit_event WHERE event_type = 'copilot-bill-repull-completed' AND subject_id = ${entId}::uuid`
    expect(Number(n)).toBe(1)
  })
})
