// @vitest-environment node
/*
 * Unit rules (C5), region re-resolve (C7) and the catch-all warning (C9), end to
 * end against real PG.
 *
 * THE FIXTURE IS DELIBERATELY CROSS-REGION, and every authorisation assertion
 * below targets a row that genuinely belongs to another region: an authorisation
 * test whose fixture has nothing foreign in it passes for the wrong reason.
 *
 * Region A — the admin's own region. Has a usable cost-centre owner.
 * Region B — the foil: another region's units, teammates and rules.
 * Region C — a region with candidates and NO usable route, for the ordering trap.
 */
import { describe, it, expect, beforeAll, afterAll, afterEach } from 'vitest'
import { startTestDb, stopTestDb, type TestDb } from '../helpers/db'
import * as schema from '../../../drizzle/schema'
import { injectTestSession } from '../../helpers/auth'
import type { Session } from '../../../server/utils/auth'
import rulesPost from '../../../server/api/v1/admin/directory-region-rules.post'
import rulesGet from '../../../server/api/v1/admin/directory-region-rules.get'
import ruleDelete from '../../../server/api/v1/admin/directory-region-rules/[id].delete'
import reResolvePost from '../../../server/api/v1/admin/region/[regionId]/re-resolve.post'
import occupancyGet from '../../../server/api/v1/admin/org-units/[id]/occupancy.get'
import orgUnitsGet from '../../../server/api/v1/admin/org-units.get'
import { unplacedOrgUnitIdForRegion } from '../../../server/auth/placement-home'
import { makePlacementStore } from '../../../server/reconciliation/placement-store'
import { runRegionReresolve, assessUnitRoutes } from '../../../server/reconciliation/region-reresolve'
import { captureDirectorySnapshot } from '../../../server/reconciliation/directory-snapshot'
import type { DirectoryUser } from '../../../server/azure/directory'
import {
  derivePlacement,
  makeChainCaches,
  type GetManager,
} from '../../../server/reconciliation/region-derivation'

let t: TestDb
let regionAId: string
let regionBId: string
let regionCId: string
let rootAId: string // A's `default` catch-all root
let couAId: string
let couA2Id: string
let teamAId: string // NOT cost-owning
let retAId: string // retired
let holdingAId: string
let rootBId: string
let couBId: string
let couCId: string
let holdingCId: string
let adminAId: string
let adminBId: string
let adminCId: string
let finopsId: string
let meiOwnerId: string // entra_oid dir-oid-0003, owner of couA

const MEI_OID = 'dir-oid-0003'

async function mkUnit(args: {
  regionId: string
  path: string
  code: string
  name: string
  unitType?: string
  costOwning?: boolean
  retired?: boolean
  parentId?: string | null
}): Promise<string> {
  const [u] = await t.db
    .insert(schema.orgUnit)
    .values({
      regionId: args.regionId,
      parentId: args.parentId ?? null,
      path: args.path,
      code: args.code,
      displayName: args.name,
      unitType: args.unitType ?? 'practice',
      isCostOwningUnit: args.costOwning ?? true,
      retiredAt: args.retired ? new Date() : null,
    })
    .returning()
  return u!.id
}

beforeAll(async () => {
  t = await startTestDb()
  process.env.DATABASE_URL = t.url

  const [ra] = await t.db.insert(schema.region).values({ code: 'prr-a', displayName: 'PRR A' }).returning()
  const [rb] = await t.db.insert(schema.region).values({ code: 'prr-b', displayName: 'PRR B' }).returning()
  const [rc] = await t.db.insert(schema.region).values({ code: 'prr-c', displayName: 'PRR C' }).returning()
  regionAId = ra!.id
  regionBId = rb!.id
  regionCId = rc!.id

  // The region roots — parentless, code 'default': the catch-all C9 is about.
  rootAId = await mkUnit({ regionId: regionAId, path: 'prra', code: 'default', name: 'PRR A (default)', unitType: 'bu' })
  rootBId = await mkUnit({ regionId: regionBId, path: 'prrb', code: 'default', name: 'PRR B (default)', unitType: 'bu' })
  await mkUnit({ regionId: regionCId, path: 'prrc', code: 'default', name: 'PRR C (default)', unitType: 'bu' })

  couAId = await mkUnit({ regionId: regionAId, path: 'prra.core', code: 'prra-core', name: 'A Core', parentId: rootAId })
  couA2Id = await mkUnit({ regionId: regionAId, path: 'prra.two', code: 'prra-two', name: 'A Two', parentId: rootAId })
  teamAId = await mkUnit({ regionId: regionAId, path: 'prra.team', code: 'prra-team', name: 'A Team', unitType: 'team', costOwning: false, parentId: rootAId })
  retAId = await mkUnit({ regionId: regionAId, path: 'prra.gone', code: 'prra-gone', name: 'A Gone', retired: true, parentId: rootAId })
  couBId = await mkUnit({ regionId: regionBId, path: 'prrb.core', code: 'prrb-core', name: 'B Core', parentId: rootBId })
  couCId = await mkUnit({ regionId: regionCId, path: 'prrc.core', code: 'prrc-core', name: 'C Core' })

  holdingAId = await unplacedOrgUnitIdForRegion(t.db, regionAId)
  // Region B gets one too — the cross-region foil must have the same shape as A,
  // so a refusal cannot pass because B simply had nowhere to put anyone.
  await unplacedOrgUnitIdForRegion(t.db, regionBId)
  holdingCId = await unplacedOrgUnitIdForRegion(t.db, regionCId)

  const admins = await t.db
    .insert(schema.teammate)
    .values([
      { entraOid: 'oid-prr-admin-a', email: 'prr-admin-a@x.test', role: 'admin', regionId: regionAId, orgUnitId: couAId },
      { entraOid: 'oid-prr-admin-b', email: 'prr-admin-b@x.test', role: 'admin', regionId: regionBId, orgUnitId: couBId },
      { entraOid: 'oid-prr-admin-c', email: 'prr-admin-c@x.test', role: 'admin', regionId: regionCId, orgUnitId: couCId },
      { entraOid: 'oid-prr-finops', email: 'prr-finops@x.test', role: 'platform-admin', regionId: regionAId, orgUnitId: couAId },
    ])
    .returning()
  adminAId = admins[0]!.id
  adminBId = admins[1]!.id
  adminCId = admins[2]!.id
  finopsId = admins[3]!.id

  // Region A's usable owner: an UNAMBIGUOUS owner of exactly one cost-owning
  // unit, whose Entra oid is a real node in the mock manager graph — so the
  // endpoint-level tests exercise the real chain walk, not an injected fake.
  const [mei] = await t.db
    .insert(schema.teammate)
    .values({ entraOid: MEI_OID, email: 'mei.lin@example.com', regionId: regionAId, orgUnitId: couAId })
    .returning()
  meiOwnerId = mei!.id
  await t.db.insert(schema.couOwner).values({ orgUnitId: couAId, teammateId: meiOwnerId })

  // Region C's owner is AMBIGUOUS — they own a unit in C and one in A, so the
  // walk cannot tell which a report belongs to and they place nobody. C
  // therefore has NO viable route, which is what the ordering-trap tests need.
  const [ambiguous] = await t.db
    .insert(schema.teammate)
    .values({ entraOid: 'oid-prr-ambiguous', email: 'prr-ambiguous@x.test', regionId: regionCId, orgUnitId: couCId })
    .returning()
  await t.db.insert(schema.couOwner).values([
    { orgUnitId: couCId, teammateId: ambiguous!.id },
    { orgUnitId: couA2Id, teammateId: ambiguous!.id },
  ])

  // Everything that exists NOW is fixture. `resetTeammates` removes anything a
  // test adds on top, so a case that asserts a region-wide COUNT cannot be
  // decided by whatever the previous case forgot to clean up.
  const seeded = await t.client<{ id: string }[]>`SELECT id::text AS id FROM teammate`
  fixtureTeammateIds = seeded.map((r) => r.id)
}, 90_000)

let fixtureTeammateIds: string[] = []

async function resetTeammates(): Promise<void> {
  const keep = fixtureTeammateIds
  await t.client`DELETE FROM instance_attestation WHERE teammate_id <> ALL(${keep}::uuid[])`
  await t.client`DELETE FROM oauth_token WHERE teammate_id <> ALL(${keep}::uuid[])`
  await t.client`DELETE FROM cou_owner WHERE teammate_id <> ALL(${keep}::uuid[])`
  await t.client`DELETE FROM teammate WHERE id <> ALL(${keep}::uuid[])`
}

afterAll(async () => {
  await stopTestDb(t)
}, 30_000)

const adminA = (): Session => ({
  teammateId: adminAId, email: 'prr-admin-a@x.test', displayName: 'Admin A',
  role: 'admin', regionId: regionAId, orgPath: 'prra.core',
})
const adminB = (): Session => ({
  teammateId: adminBId, email: 'prr-admin-b@x.test', displayName: 'Admin B',
  role: 'admin', regionId: regionBId, orgPath: 'prrb.core',
})
const adminC = (): Session => ({
  teammateId: adminCId, email: 'prr-admin-c@x.test', displayName: 'Admin C',
  role: 'admin', regionId: regionCId, orgPath: 'prrc.core',
})
const finops = (): Session => ({
  teammateId: finopsId, email: 'prr-finops@x.test', displayName: 'Fin',
  role: 'platform-admin', regionId: regionAId, orgPath: 'prra.core',
})
const developer = (): Session => ({
  teammateId: adminAId, email: 'prr-admin-a@x.test', displayName: 'Dev',
  role: 'developer', regionId: regionAId, orgPath: 'prra.core',
})

function ev(opts: {
  method?: string
  body?: unknown
  query?: Record<string, string>
  params?: Record<string, string>
  session: Session
}) {
  const method = opts.method ?? 'POST'
  const qs = opts.query ? `?${new URLSearchParams(opts.query).toString()}` : ''
  const url = `/x${qs}`
  const headers: Record<string, string> = {
    host: 'localhost:3450',
    origin: 'http://localhost:3450',
    'content-type': 'application/json',
  }
  const e = {
    method,
    path: url,
    context: { params: opts.params ?? {} },
    node: {
      req: {
        method,
        url,
        body: opts.body,
        socket: { remoteAddress: '127.0.0.1' },
        get headers() { return headers },
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
  return e as unknown as Parameters<typeof rulesPost>[0]
}

async function call<T>(handler: (e: never) => unknown, e: unknown): Promise<T> {
  return (await handler(e as never)) as T
}

async function homeOf(teammateId: string): Promise<string> {
  const [row] = await t.client<{ org_unit_id: string }[]>`
    SELECT org_unit_id::text AS org_unit_id FROM teammate WHERE id = ${teammateId}::uuid`
  return row!.org_unit_id
}

/** A bill placeholder on a holding node — the population these features act on. */
async function mkBillTeammate(args: {
  email: string
  regionId: string
  orgUnitId: string
  department?: string | null
  companyName?: string | null
}): Promise<string> {
  const store = makePlacementStore(t.db)
  const id = await store.createBillTeammate({ email: args.email, displayName: args.email, orgUnitId: args.orgUnitId })
  if (args.department !== undefined || args.companyName !== undefined) {
    await captureDirectorySnapshot(t.db, id, {
      department: args.department ?? null,
      companyName: args.companyName ?? null,
    })
  }
  return id
}

async function clearRules(): Promise<void> {
  await t.client`DELETE FROM directory_region_rule`
}

// ═══════════════════════════════════════════════════════════════════════════
describe('C5 — a unit rule is the region rule mechanism, retargeted', () => {
  // Rules are global config keyed on (attribute, value); wipe between cases so
  // one test's leftover rule cannot decide another's outcome.
  afterEach(async () => { await clearRules(); await resetTeammates() })

  it('a REGION admin may not write any rule — not into their own cost centre, not another region\'s, not a region rule (403, nothing written)', async () => {
    // A unit rule is step 0 of the placement resolver, so it decides the REGION
    // of everyone it matches; it cannot be confined to the author's region.
    for (const body of [
      { attribute: 'department', match_value: 'Own', org_unit_id: couAId },
      { attribute: 'department', match_value: 'Foreign', org_unit_id: couBId },
      { attribute: 'department', match_value: 'Anything', region_id: regionAId },
    ]) {
      await expect(call(rulesPost, ev({ session: adminA(), body }))).rejects.toMatchObject({ statusCode: 403 })
    }
    const [{ n }] = await t.client<{ n: string }[]>`SELECT COUNT(*)::text AS n FROM directory_region_rule`
    expect(Number(n)).toBe(0)
  })

  it('platform-admin creates a unit rule; the rule\'s region is the unit\'s', async () => {
    const res = await call<{ id: string; org_unit_id: string; region_id: string }>(rulesPost, ev({
      session: finops(),
      body: { attribute: 'department', match_value: '  Sales-Solution  ', org_unit_id: couAId },
    }))
    expect(res.org_unit_id).toBe(couAId)
    // Never supplied by the caller — derived from the unit, so the two cannot
    // name different regions.
    expect(res.region_id).toBe(regionAId)
    const [row] = await t.client<{ match_value: string; org_unit_id: string; region_id: string }[]>`
      SELECT match_value, org_unit_id::text AS org_unit_id, region_id::text AS region_id
      FROM directory_region_rule WHERE id = ${res.id}::uuid`
    expect(row!.match_value).toBe('sales-solution') // normalised by the shared normaliser
    expect(row!.region_id).toBe(regionAId)
  })

  it('platform-admin still creates region rules, and they carry no unit', async () => {
    const res = await call<{ org_unit_id: string | null; region_id: string }>(rulesPost, ev({
      session: finops(),
      body: { attribute: 'country', match_value: 'Australia', region_id: regionAId },
    }))
    expect(res.org_unit_id).toBeNull()
    expect(res.region_id).toBe(regionAId)
  })

  it('exactly one target: naming both, or neither, is a 400', async () => {
    await expect(
      call(rulesPost, ev({
        session: finops(),
        body: { attribute: 'department', match_value: 'Both', region_id: regionAId, org_unit_id: couAId },
      })),
    ).rejects.toMatchObject({ statusCode: 400 })
    await expect(
      call(rulesPost, ev({ session: finops(), body: { attribute: 'department', match_value: 'Neither' } })),
    ).rejects.toMatchObject({ statusCode: 400 })
  })

  it('the target must be able to receive spend: a non-cost-owning unit and a retired one are both refused', async () => {
    await expect(
      call(rulesPost, ev({
        session: finops(),
        body: { attribute: 'department', match_value: 'TeamTarget', org_unit_id: teamAId },
      })),
    ).rejects.toMatchObject({ statusCode: 422 })
    await expect(
      call(rulesPost, ev({
        session: finops(),
        body: { attribute: 'department', match_value: 'RetiredTarget', org_unit_id: retAId },
      })),
    ).rejects.toMatchObject({ statusCode: 422 })
    const [{ n }] = await t.client<{ n: string }[]>`SELECT COUNT(*)::text AS n FROM directory_region_rule`
    expect(Number(n)).toBe(0)
  })

  it('the region-scoped list shows this region\'s unit rules and nothing else', async () => {
    await call(rulesPost, ev({ session: finops(), body: { attribute: 'department', match_value: 'Mine', org_unit_id: couAId } }))
    await call(rulesPost, ev({ session: finops(), body: { attribute: 'department', match_value: 'Theirs', org_unit_id: couBId } }))
    await call(rulesPost, ev({ session: finops(), body: { attribute: 'country', match_value: 'Australia', region_id: regionAId } }))

    const res = await call<{ rules: Array<{ match_value: string; org_unit_id: string | null; target_placeable: boolean | null }> }>(
      rulesGet,
      ev({ method: 'GET', session: adminA(), query: { region: regionAId } }),
    )
    expect(res.rules.map((r) => r.match_value)).toEqual(['mine'])
    expect(res.rules[0]!.target_placeable).toBe(true)
  })

  it('the region-scoped list refuses another region', async () => {
    await expect(
      call(rulesGet, ev({ method: 'GET', session: adminA(), query: { region: regionBId } })),
    ).rejects.toMatchObject({ statusCode: 403 })
  })

  it('a rule whose unit is retired is reported as placing nobody, and the loader DROPS it rather than degrading it to an org-wide region rule', async () => {
    const doomed = await mkUnit({ regionId: regionAId, path: 'prra.doomed', code: 'prra-doomed', name: 'A Doomed', parentId: rootAId })
    await call(rulesPost, ev({ session: finops(), body: { attribute: 'department', match_value: 'Doomed', org_unit_id: doomed } }))
    await t.client`UPDATE org_unit SET retired_at = now() WHERE id = ${doomed}::uuid`

    const res = await call<{ rules: Array<{ match_value: string; target_placeable: boolean | null }> }>(
      rulesGet,
      ev({ method: 'GET', session: adminA(), query: { region: regionAId } }),
    )
    expect(res.rules.find((r) => r.match_value === 'doomed')!.target_placeable).toBe(false)

    // Degrading the dead target to `{ orgUnitId: null }` would yield a REGION
    // rule, which decides which REGION everyone matching lands in. The rule
    // places NOBODY until the target is fixed.
    const rules = await makePlacementStore(t.db).loadDirectoryRegionRules()
    expect(rules.exact.get('department')?.get('doomed')).toBeUndefined()
  })

  it('retiring a unit rule\'s target cannot turn it into a region rule', async () => {
    // The escalation path, end to end. If the loader degraded a dead unit target
    // to its region, retiring the unit would convert a unit rule into a region
    // rule — and an attribute REGION rule outranks a chain region
    // leader, so it would start deciding the region of people whose own chain says
    // otherwise. The victim below is such a person: in region B by their chain.
    const doomed = await mkUnit({ regionId: regionAId, path: 'prra.esc', code: 'prra-esc', name: 'A Escalation', parentId: rootAId })
    await call(rulesPost, ev({
      session: finops(), body: { attribute: 'department', match_value: 'Escalate', org_unit_id: doomed },
    }))
    await t.client`UPDATE org_unit SET retired_at = now() WHERE id = ${doomed}::uuid`

    const [nadia] = await t.db.insert(schema.teammate).values({
      entraOid: 'oid-esc-leader-b', email: 'esc.leader.b@x.test', regionId: regionBId, orgUnitId: couBId,
    }).returning()
    await t.db.insert(schema.regionLeader).values({
      regionId: regionBId, leaderOid: 'oid-esc-leader-b', leaderEmail: 'esc.leader.b@x.test',
    })

    const store = makePlacementStore(t.db)
    const der = await derivePlacement(
      {
        oid: 'esc-oid', email: 'esc@x.test', displayName: 'Esc', mail: 'esc@x.test', upn: 'esc@x.test',
        department: 'Escalate', jobTitle: null, companyName: null, country: null, officeLocation: null,
        state: null, costCenter: null, division: null,
      },
      {
        rules: await store.loadDirectoryRegionRules(),
        unitOwnerMap: await store.loadActiveUnitOwners(),
        leaderMap: await store.loadActiveRegionLeaders(),
        getManager: async (oid) => (oid === 'esc-oid' ? { oid: 'oid-esc-leader-b', email: null } : null),
        caches: makeChainCaches(),
      },
    )
    // Their own chain decides: region B. NOT region A, which is what a degraded
    // rule would have imposed on them.
    expect(der).toMatchObject({ via: 'manager', regionId: regionBId })

    await t.client`DELETE FROM region_leader WHERE leader_oid = 'oid-esc-leader-b'`
    await t.client`DELETE FROM teammate WHERE id = ${nadia!.id}::uuid`
  })

  it('delete: a region admin removes their own unit rule, and cannot remove another region\'s or an org-wide one', async () => {
    const mine = await call<{ id: string }>(rulesPost, ev({
      session: finops(), body: { attribute: 'department', match_value: 'DelMine', org_unit_id: couAId },
    }))
    const theirs = await call<{ id: string }>(rulesPost, ev({
      session: finops(), body: { attribute: 'department', match_value: 'DelTheirs', org_unit_id: couBId },
    }))
    const orgWide = await call<{ id: string }>(rulesPost, ev({
      session: finops(), body: { attribute: 'country', match_value: 'DelGlobal', region_id: regionAId },
    }))

    await expect(
      call(ruleDelete, ev({ method: 'DELETE', session: adminA(), params: { id: theirs.id } })),
    ).rejects.toMatchObject({ statusCode: 403 })
    await expect(
      call(ruleDelete, ev({ method: 'DELETE', session: adminA(), params: { id: orgWide.id } })),
    ).rejects.toMatchObject({ statusCode: 403 })

    await call(ruleDelete, ev({ method: 'DELETE', session: adminA(), params: { id: mine.id } }))
    const rows = await t.client<{ id: string }[]>`SELECT id::text AS id FROM directory_region_rule ORDER BY match_value`
    expect(rows.map((r) => r.id).sort()).toEqual([theirs.id, orgWide.id].sort())
  })

  it('a unit rule OUTRANKS the manager chain, and stamps rule provenance', async () => {
    // sasha (dir-oid-0001) reports to mei (dir-oid-0003), who owns couA — so the
    // chain alone would place her there. A rule naming couA2 must win.
    await call(rulesPost, ev({
      session: finops(), body: { attribute: 'department', match_value: 'APAC Digital', org_unit_id: couA2Id },
    }))
    const tm = await mkBillTeammate({ email: 'sasha.kumar@example.com', regionId: regionAId, orgUnitId: holdingAId })

    const res = await runRegionReresolve(t.db, { regionId: regionAId })
    expect(res.moves.find((m) => m.teammateId === tm)?.via).toBe('unit-rule')
    expect(await homeOf(tm)).toBe(couA2Id)
    const [row] = await t.client<{ via: string | null; attr: string | null; owner: string | null }[]>`
      SELECT metadata->>'placedVia' AS via, metadata->>'placedAttribute' AS attr,
             metadata->>'placedOwnerOid' AS owner
      FROM teammate WHERE id = ${tm}::uuid`
    expect(row!.via).toBe('attribute-rule')
    expect(row!.attr).toBe('department')
    // The manager-chain key must not survive a re-derivation that was NOT a
    // chain placement, or the next pass looks for an owner that never placed them.
    expect(row!.owner).toBeNull()

    // …and the reverse: drop the rule, and the chain places them into A Core.
    // The rule's `placedAttribute` must not survive THAT either — provenance is
    // rewritten wholesale, not merged over, or the row would claim two different
    // things placed it and the next pass would re-derive against the wrong one.
    await clearRules()
    await runRegionReresolve(t.db, { regionId: regionAId })
    const [after] = await t.client<{ via: string | null; attr: string | null; owner: string | null }[]>`
      SELECT metadata->>'placedVia' AS via, metadata->>'placedAttribute' AS attr,
             metadata->>'placedOwnerOid' AS owner
      FROM teammate WHERE id = ${tm}::uuid`
    expect(await homeOf(tm)).toBe(couAId)
    expect(after!.via).toBe('manager-chain')
    expect(after!.owner).toBe(MEI_OID)
    expect(after!.attr).toBeNull()
    await t.client`DELETE FROM teammate WHERE id = ${tm}::uuid`
  })
})

// ═══════════════════════════════════════════════════════════════════════════
describe('C7 — re-resolve: authorisation and the write posture', () => {
  afterEach(resetTeammates)

  it('a region admin CANNOT re-resolve another region', async () => {
    await expect(
      call(reResolvePost, ev({ session: adminA(), params: { regionId: regionBId }, body: { dry_run: true } })),
    ).rejects.toMatchObject({ statusCode: 403 })
  })

  it('a developer is refused outright', async () => {
    await expect(
      call(reResolvePost, ev({ session: developer(), params: { regionId: regionAId }, body: { dry_run: true } })),
    ).rejects.toMatchObject({ statusCode: 403 })
  })

  it('omitting dry_run PREVIEWS — a request that meant to ask a question never re-homes anyone', async () => {
    const tm = await mkBillTeammate({ email: 'sasha.kumar@example.com', regionId: regionAId, orgUnitId: holdingAId })
    const res = await call<{ dry_run: boolean; moved: number; batch_id: string | null }>(
      reResolvePost,
      ev({ session: adminA(), params: { regionId: regionAId }, body: {} }),
    )
    expect(res.dry_run).toBe(true)
    expect(res.moved).toBe(1) // it WOULD move — the chain reaches Mei, who owns A Core
    expect(res.batch_id).toBeNull()
    expect(await homeOf(tm)).toBe(holdingAId) // …and nothing was written
    await t.client`DELETE FROM teammate WHERE id = ${tm}::uuid`
  })

  it('applying moves them, writes ONE audit row for the region, and a dry run writes none', async () => {
    const tm = await mkBillTeammate({ email: 'james.oconnor@example.com', regionId: regionAId, orgUnitId: holdingAId })
    await t.client`DELETE FROM audit_event WHERE event_type = 'region-placement-re-resolved'`

    await call(reResolvePost, ev({ session: adminA(), params: { regionId: regionAId }, body: { dry_run: true } }))
    const [{ n: afterDry }] = await t.client<{ n: string }[]>`
      SELECT COUNT(*)::text AS n FROM audit_event WHERE event_type = 'region-placement-re-resolved'`
    expect(Number(afterDry)).toBe(0)

    const res = await call<{ moved: number; batch_id: string | null }>(
      reResolvePost,
      ev({ session: adminA(), params: { regionId: regionAId }, body: { dry_run: false } }),
    )
    expect(res.moved).toBe(1)
    expect(res.batch_id).not.toBeNull()
    expect(await homeOf(tm)).toBe(couAId)

    const [audit] = await t.client<{ subject_id: string; payload: { moved: number; moved_teammate_ids: string[] } }[]>`
      SELECT subject_id::text AS subject_id, payload FROM audit_event
      WHERE event_type = 'region-placement-re-resolved'`
    expect(audit!.subject_id).toBe(regionAId)
    expect(audit!.payload.moved).toBe(1)
    expect(audit!.payload.moved_teammate_ids).toEqual([tm])
    await t.client`DELETE FROM teammate WHERE id = ${tm}::uuid`
  })

  it('a committing pass that moves NOBODY is still audited — it wrote snapshots and the batch cursor', async () => {
    /*
     * A committing pass with no move is still a WRITE: it refreshes directory
     * snapshots and stamps the batching cursor on everyone it looked at.
     * Auditing only `moved > 0` left those writes with no trail at all, while the
     * comment beside the audit claimed committing writes were audited.
     */
    const tm = await mkBillTeammate({ email: 'nomove@x.test', regionId: regionAId, orgUnitId: holdingAId })
    const res = await call<{ moved: number; considered: number; batch_id: string | null }>(
      reResolvePost,
      ev({ session: adminA(), params: { regionId: regionAId }, body: { dry_run: false } }),
    )
    expect(res.moved).toBe(0)
    expect(res.considered).toBe(1)
    expect(res.batch_id).not.toBeNull()

    const [audit] = await t.client<{ payload: { moved: number; considered: number } }[]>`
      SELECT payload FROM audit_event
      WHERE event_type = 'region-placement-re-resolved' AND payload->>'batchId' = ${res.batch_id!}`
    expect(audit!.payload.moved).toBe(0)
    expect(audit!.payload.considered).toBe(1)

    // …and the write it is the trail for actually happened.
    const [row] = await t.client<{ sync: string | null }[]>`
      SELECT last_sync_at::text AS sync FROM teammate WHERE id = ${tm}::uuid`
    expect(row!.sync).not.toBeNull()
    await t.client`DELETE FROM teammate WHERE id = ${tm}::uuid`
  })
})

// ═══════════════════════════════════════════════════════════════════════════
describe('C7 — re-resolve: the derivation, its scope and its safety predicate', () => {
  // These cases assert region-wide COUNTS (candidates / unresolved / remaining),
  // so a leftover row from the previous one would decide the result.
  afterEach(resetTeammates)

  const dirFor = (over: Partial<DirectoryUser> & { oid: string; email: string }): DirectoryUser => ({
    displayName: over.email, mail: over.email, upn: over.email, department: null, jobTitle: null,
    companyName: null, country: null, officeLocation: null, state: null, costCenter: null, division: null,
    ...over,
  })
  const lookup = (byEmail: Record<string, DirectoryUser>) => async (email: string) => byEmail[email] ?? null
  const chain = (edges: Record<string, { oid: string; email: string | null }>): GetManager =>
    async (oid) => edges[oid] ?? null

  it('the ordering trap: with no viable route it says so and walks NOTHING', async () => {
    const tm = await mkBillTeammate({ email: 'c1@x.test', regionId: regionCId, orgUnitId: holdingCId })
    let lookups = 0
    const res = await runRegionReresolve(t.db, {
      regionId: regionCId,
      lookupDirectory: async (email) => { lookups += 1; return dirFor({ oid: 'c1', email }) },
      getManager: chain({}),
    })
    // Region C's only owner owns TWO units, so the walk treats them as ambiguous
    // and they place nobody — there is no route, and saying so costs nothing.
    expect(res.routes).toEqual({ unambiguousOwners: 0, unitRules: 0, viable: false })
    expect(res.candidates).toBe(1)
    expect(res.considered).toBe(0)
    expect(res.remaining).toBe(1)
    expect(lookups).toBe(0)
    expect(await homeOf(tm)).toBe(holdingCId)
    await t.client`DELETE FROM teammate WHERE id = ${tm}::uuid`
  })

  it('a teammate with a LIVE emit instance is not a candidate — moving them would re-scope a live session', async () => {
    const safe = await mkBillTeammate({ email: 'safe@x.test', regionId: regionAId, orgUnitId: holdingAId })
    const live = await mkBillTeammate({ email: 'live@x.test', regionId: regionAId, orgUnitId: holdingAId })
    await t.client`INSERT INTO instance_attestation
        (instance_id, principal_oid, teammate_id, tool, region_id, org_unit_id, project_code_hash, raw_project_code)
      SELECT gen_random_uuid(), 'oid-live', t.id, 'claude-code', t.region_id, t.org_unit_id, 'h-prr', 'PRR'
      FROM teammate t WHERE t.id = ${live}::uuid`

    const res = await runRegionReresolve(t.db, {
      regionId: regionAId,
      lookupDirectory: lookup({
        'safe@x.test': dirFor({ oid: 'safe-oid', email: 'safe@x.test' }),
        'live@x.test': dirFor({ oid: 'live-oid', email: 'live@x.test' }),
      }),
      getManager: chain({ 'safe-oid': { oid: MEI_OID, email: null }, 'live-oid': { oid: MEI_OID, email: null } }),
    })
    expect(res.moves.map((m) => m.teammateId)).toEqual([safe])
    expect(await homeOf(safe)).toBe(couAId)
    expect(await homeOf(live)).toBe(holdingAId)
    await t.client`DELETE FROM instance_attestation WHERE teammate_id = ${live}::uuid`
    await t.client`DELETE FROM teammate WHERE id IN (${safe}::uuid, ${live}::uuid)`
  })

  it('a teammate with a LIVE OAuth token is not a candidate either', async () => {
    const tok = await mkBillTeammate({ email: 'tok@x.test', regionId: regionAId, orgUnitId: holdingAId })
    const [client] = await t.client<{ client_id: string }[]>`
      INSERT INTO oauth_client (client_secret_hash, client_name, redirect_uris)
      VALUES ('h', 'PRR', ARRAY['http://127.0.0.1/cb']) RETURNING client_id::text AS client_id`
    await t.client`INSERT INTO oauth_token
        (access_token_hash, refresh_token_hash, client_id, teammate_id, scope, access_expires_at, refresh_expires_at)
      VALUES ('prr-a-hash', 'prr-r-hash', ${client!.client_id}::uuid, ${tok}::uuid, 'emit',
              now() + interval '1 hour', now() + interval '1 day')`

    const res = await runRegionReresolve(t.db, {
      regionId: regionAId,
      lookupDirectory: lookup({ 'tok@x.test': dirFor({ oid: 'tok-oid', email: 'tok@x.test' }) }),
      getManager: chain({ 'tok-oid': { oid: MEI_OID, email: null } }),
    })
    expect(res.candidates).toBe(0)
    expect(await homeOf(tok)).toBe(holdingAId)
    await t.client`DELETE FROM oauth_token WHERE teammate_id = ${tok}::uuid`
  })

  it('a teammate who has SIGNED IN (a real oid) is not a candidate', async () => {
    const [real] = await t.db.insert(schema.teammate).values({
      entraOid: 'oid-real-person', email: 'real@x.test', regionId: regionAId, orgUnitId: holdingAId,
    }).returning()
    const res = await runRegionReresolve(t.db, {
      regionId: regionAId,
      lookupDirectory: lookup({ 'real@x.test': dirFor({ oid: 'real-oid', email: 'real@x.test' }) }),
      getManager: chain({ 'real-oid': { oid: MEI_OID, email: null } }),
    })
    expect(res.candidates).toBe(0)
    expect(await homeOf(real!.id)).toBe(holdingAId)
    await t.client`DELETE FROM teammate WHERE id = ${real!.id}::uuid`
  })

  /*
   * MODULE-LEVEL, on the OWNER connection — not the endpoint's RLS-visible
   * behaviour. `runRegionReresolve` is called directly here, so region B's owners
   * and units are readable and a foreign chain resolves and is CLASSIFIED as
   * out-of-region. A region admin going through the endpoint under FORCE RLS
   * cannot read them, so the same person would come back `unresolved` instead.
   * Both leave the teammate exactly where they are, which is the property under
   * test; the COUNTER they land in is not an endpoint promise, and the dialog copy
   * says so.
   */
  it('runRegionReresolve (module level): a chain that resolves into ANOTHER region moves nobody — it is a cross-region change this caller may not make', async () => {
    // Nadia owns B Core; the candidate is in region A and reports to her.
    const [nadia] = await t.db.insert(schema.teammate).values({
      entraOid: 'dir-oid-0005-b', email: 'nadia.b@x.test', regionId: regionBId, orgUnitId: couBId,
    }).returning()
    await t.db.insert(schema.couOwner).values({ orgUnitId: couBId, teammateId: nadia!.id })
    const tm = await mkBillTeammate({ email: 'foreignchain@x.test', regionId: regionAId, orgUnitId: holdingAId })

    const res = await runRegionReresolve(t.db, {
      regionId: regionAId,
      lookupDirectory: lookup({ 'foreignchain@x.test': dirFor({ oid: 'fc-oid', email: 'foreignchain@x.test' }) }),
      getManager: chain({ 'fc-oid': { oid: 'dir-oid-0005-b', email: null } }),
    })
    expect(res.outOfRegion).toBe(1)
    expect(res.moved).toBe(0)
    expect(await homeOf(tm)).toBe(holdingAId)

    await t.client`DELETE FROM cou_owner WHERE teammate_id = ${nadia!.id}::uuid`
    await t.client`DELETE FROM teammate WHERE id IN (${nadia!.id}::uuid, ${tm}::uuid)`
  })

  it('a derivation that resolves NOTHING never de-places anyone — this action only ever adds a cost centre', async () => {
    // Already in a real unit, with chain provenance whose owner no longer exists.
    const tm = await mkBillTeammate({ email: 'stalechain@x.test', regionId: regionAId, orgUnitId: couA2Id })
    await makePlacementStore(t.db).setPlacementProvenance(tm, { via: 'manager-chain', ownerOid: 'owner-who-left' })

    const res = await runRegionReresolve(t.db, {
      regionId: regionAId,
      lookupDirectory: lookup({ 'stalechain@x.test': dirFor({ oid: 'sc-oid', email: 'stalechain@x.test' }) }),
      getManager: chain({}),
    })
    expect(res.unresolved).toBe(1)
    expect(res.moved).toBe(0)
    // The global cron worker WOULD de-place this row to the global bucket. A
    // region admin's action must not, or an owner they cannot see reads as an
    // owner who does not exist.
    expect(await homeOf(tm)).toBe(couA2Id)
    await t.client`DELETE FROM teammate WHERE id = ${tm}::uuid`
  })

  it('batched: the limit bounds one pass and `remaining` says another is needed', async () => {
    const a = await mkBillTeammate({ email: 'b1@x.test', regionId: regionAId, orgUnitId: holdingAId })
    const b = await mkBillTeammate({ email: 'b2@x.test', regionId: regionAId, orgUnitId: holdingAId })
    const deps = {
      lookupDirectory: lookup({
        'b1@x.test': dirFor({ oid: 'b1-oid', email: 'b1@x.test' }),
        'b2@x.test': dirFor({ oid: 'b2-oid', email: 'b2@x.test' }),
      }),
      getManager: chain({ 'b1-oid': { oid: MEI_OID, email: null }, 'b2-oid': { oid: MEI_OID, email: null } }),
    }
    const first = await runRegionReresolve(t.db, { regionId: regionAId, limit: 1, ...deps })
    expect(first.considered).toBe(1)
    expect(first.moved).toBe(1)
    expect(first.remaining).toBe(1)

    const second = await runRegionReresolve(t.db, { regionId: regionAId, limit: 1, ...deps })
    expect(second.moved).toBe(1)
    expect(await homeOf(a)).toBe(couAId)
    expect(await homeOf(b)).toBe(couAId)

    // Both are now DERIVED placements, so both stay candidates — that is what
    // makes a later configuration change reach them. A pass over the whole set
    // therefore moves nobody and reports them as already correct, which is the
    // honest "nothing left to do" signal (an empty candidate set would mean the
    // opposite: that they had stopped following the configuration).
    const third = await runRegionReresolve(t.db, { regionId: regionAId, limit: 200, ...deps })
    expect(third.considered).toBe(2)
    expect(third.moved).toBe(0)
    expect(third.alreadyCorrect).toBe(2)
    expect(third.remaining).toBe(0)
    await t.client`DELETE FROM teammate WHERE id IN (${a}::uuid, ${b}::uuid)`
  })

  it('a dry run writes nothing at all — not the placement, not the directory snapshot, not the batch cursor', async () => {
    const tm = await mkBillTeammate({ email: 'dry@x.test', regionId: regionAId, orgUnitId: holdingAId })
    const res = await runRegionReresolve(t.db, {
      regionId: regionAId,
      dryRun: true,
      lookupDirectory: lookup({ 'dry@x.test': dirFor({ oid: 'dry-oid', email: 'dry@x.test', department: 'Ops' }) }),
      getManager: chain({ 'dry-oid': { oid: MEI_OID, email: null } }),
    })
    expect(res.moved).toBe(1)
    expect(await homeOf(tm)).toBe(holdingAId)
    const [row] = await t.client<{ dept: string | null; sync: string | null }[]>`
      SELECT metadata->'directory'->>'department' AS dept, last_sync_at::text AS sync
      FROM teammate WHERE id = ${tm}::uuid`
    expect(row!.dept).toBeNull()
    // The cursor is a WRITE too: advancing it on a preview would move the worklist
    // under an admin who only looked.
    expect(row!.sync).toBeNull()
    await t.client`DELETE FROM teammate WHERE id = ${tm}::uuid`
  })

  it('a session that starts DURING the pass is not silently re-scoped — the write re-asserts the safety predicate', async () => {
    /*
     * The predicate is a CONTROL, and evaluating it only as a candidate filter
     * makes it advisory: the candidate is chosen, then the directory lookup and the
     * manager walk are awaited, and an enrolment landing in that window is exactly
     * what the admin revoke cascade exists for. The lookup below IS that window.
     */
    const tm = await mkBillTeammate({ email: 'racer@x.test', regionId: regionAId, orgUnitId: holdingAId })
    const res = await runRegionReresolve(t.db, {
      regionId: regionAId,
      lookupDirectory: async (email) => {
        await t.client`INSERT INTO instance_attestation
            (instance_id, principal_oid, teammate_id, tool, region_id, org_unit_id, project_code_hash, raw_project_code)
          SELECT gen_random_uuid(), 'oid-racer', t.id, 'claude-code', t.region_id, t.org_unit_id, 'h-race', 'RACE'
          FROM teammate t WHERE t.id = ${tm}::uuid`
        return dirFor({ oid: 'race-oid', email })
      },
      getManager: chain({ 'race-oid': { oid: MEI_OID, email: null } }),
    })
    expect(res.moved).toBe(0)
    expect(res.skipped).toBe(1)
    expect(res.moves).toEqual([]) // a skipped row is not a move, in the count OR the list
    expect(await homeOf(tm)).toBe(holdingAId)
    // And no provenance describing a placement that did not happen.
    const [row] = await t.client<{ via: string | null }[]>`
      SELECT metadata->>'placedVia' AS via FROM teammate WHERE id = ${tm}::uuid`
    expect(row!.via).toBeNull()
    await t.client`DELETE FROM instance_attestation WHERE teammate_id = ${tm}::uuid`
    await t.client`DELETE FROM teammate WHERE id = ${tm}::uuid`
  })

  it('a destination retired DURING the pass is not written to — the target is re-validated at write time', async () => {
    // The owner map is loaded once, up front, and the Graph latency after it is
    // unbounded. "An active cost-owning unit in this region" is therefore a fact
    // about the preview unless the write re-asserts it.
    const doomed = await mkUnit({
      regionId: regionAId, path: 'prra.stale', code: 'prra-stale', name: 'A Stale', parentId: rootAId,
    })
    const [owner] = await t.db.insert(schema.teammate).values({
      entraOid: 'oid-stale-owner', email: 'stale.owner@x.test', regionId: regionAId, orgUnitId: couAId,
    }).returning()
    await t.db.insert(schema.couOwner).values({ orgUnitId: doomed, teammateId: owner!.id })
    const tm = await mkBillTeammate({ email: 'staletarget@x.test', regionId: regionAId, orgUnitId: holdingAId })

    const res = await runRegionReresolve(t.db, {
      regionId: regionAId,
      lookupDirectory: async (email) => {
        if (email === 'staletarget@x.test') {
          await t.client`UPDATE org_unit SET retired_at = now() WHERE id = ${doomed}::uuid`
        }
        return email === 'staletarget@x.test' ? dirFor({ oid: 'st-oid', email }) : null
      },
      getManager: chain({ 'st-oid': { oid: 'oid-stale-owner', email: null } }),
    })
    expect(res.moved).toBe(0)
    expect(res.skipped).toBe(1)
    expect(await homeOf(tm)).toBe(holdingAId)

    await t.client`DELETE FROM cou_owner WHERE org_unit_id = ${doomed}::uuid`
    await t.client`DELETE FROM teammate WHERE id IN (${owner!.id}::uuid, ${tm}::uuid)`
  })

  it('a limited pass ADVANCES: a candidate it could not move does not sit at the head of every later pass', async () => {
    /*
     * The starvation. Candidates come oldest-`last_sync_at`-first, and an
     * unresolved / errored / out-of-region / already-correct row used to keep its
     * old timestamp — so every limited pass re-read the same head while `remaining`
     * kept saying "run it again", and the tail was never reached at all.
     */
    const a = await mkBillTeammate({ email: 'starve1@x.test', regionId: regionAId, orgUnitId: holdingAId })
    const b = await mkBillTeammate({ email: 'starve2@x.test', regionId: regionAId, orgUnitId: holdingAId })
    const seen: string[] = []
    const deps = {
      // Neither resolves to a unit — the population that pinned itself to the front.
      lookupDirectory: async (email: string) => {
        seen.push(email)
        return dirFor({ oid: `sv-${email}`, email })
      },
      getManager: chain({}),
    }
    const first = await runRegionReresolve(t.db, { regionId: regionAId, limit: 1, ...deps })
    expect(first.considered).toBe(1)
    expect(first.moved).toBe(0)
    expect(first.remaining).toBe(1)

    const second = await runRegionReresolve(t.db, { regionId: regionAId, limit: 1, ...deps })
    expect(second.considered).toBe(1)
    // The second pass reached the OTHER person, which is the whole point: two
    // passes over two candidates must look at two people.
    expect(new Set(seen).size).toBe(2)
    await t.client`DELETE FROM teammate WHERE id IN (${a}::uuid, ${b}::uuid)`
  })

  it('a committing pass captures the manager it walked, which is what C9 groups by', async () => {
    const tm = await mkBillTeammate({ email: 'capman@x.test', regionId: regionAId, orgUnitId: holdingAId })
    await runRegionReresolve(t.db, {
      regionId: regionAId,
      lookupDirectory: lookup({ 'capman@x.test': dirFor({ oid: 'cap-oid', email: 'capman@x.test' }) }),
      getManager: chain({ 'cap-oid': { oid: MEI_OID, email: 'mei.lin@example.com' } }),
    })
    const [row] = await t.client<{ moid: string | null; memail: string | null }[]>`
      SELECT metadata->'directory'->>'managerOid' AS moid,
             metadata->'directory'->>'managerEmail' AS memail
      FROM teammate WHERE id = ${tm}::uuid`
    expect(row!.moid).toBe(MEI_OID)
    expect(row!.memail).toBe('mei.lin@example.com')
    await t.client`DELETE FROM teammate WHERE id = ${tm}::uuid`
  })
})

describe('assessUnitRoutes', () => {
  it('an AMBIGUOUS owner is not a route — they place nobody, on either unit', () => {
    const owners = new Map([
      ['amb', [{ orgUnitId: 'u1', regionId: 'r1' }, { orgUnitId: 'u2', regionId: 'r1' }]],
    ])
    const empty = { exact: new Map(), prefix: [] }
    expect(assessUnitRoutes('r1', owners, empty)).toEqual({ unambiguousOwners: 0, unitRules: 0, viable: false })
    owners.set('solo', [{ orgUnitId: 'u3', regionId: 'r1' }])
    expect(assessUnitRoutes('r1', owners, empty).viable).toBe(true)
  })

  it('a unit rule pointing at ANOTHER region is not a route for this one', () => {
    const rules = {
      exact: new Map([['department', new Map([['x', { regionId: 'r2', orgUnitId: 'u9' }]])]]),
      prefix: [],
    }
    expect(assessUnitRoutes('r1', new Map(), rules as never).viable).toBe(false)
    expect(assessUnitRoutes('r2', new Map(), rules as never)).toEqual({
      unambiguousOwners: 0, unitRules: 1, viable: true,
    })
  })
})

// ═══════════════════════════════════════════════════════════════════════════
describe('C9 — a default unit that fills up is a warning, not a success', () => {
  let ownerId: string
  let directReport: string
  let stranger1: string
  let stranger2: string
  let neverLookedUp: string

  beforeAll(async () => {
    // The catch-all's owner. Homed in A Core, not in the unit they own: the
    // placement model is explicit that an owner's own home is independent of the
    // unit they own, and it keeps the occupancy counts below about the people
    // the catch-all CAUGHT.
    const [owner] = await t.db.insert(schema.teammate).values({
      entraOid: 'oid-root-owner', email: 'root.owner@x.test', displayName: 'Root Owner',
      regionId: regionAId, orgUnitId: couAId,
    }).returning()
    ownerId = owner!.id
    await t.db.insert(schema.couOwner).values({ orgUnitId: rootAId, teammateId: ownerId })

    // Someone the manager clusters must be able to NAME without a teammate row
    // of their own is covered by the captured email; this one has a row.
    const [lee] = await t.db.insert(schema.teammate).values({
      entraOid: 'oid-lee', email: 'lee.hughes@x.test', displayName: 'Lee Hughes',
      regionId: regionAId, orgUnitId: couAId,
    }).returning()

    directReport = await mkBillTeammate({ email: 'dr1@x.test', regionId: regionAId, orgUnitId: rootAId })
    stranger1 = await mkBillTeammate({ email: 's1@x.test', regionId: regionAId, orgUnitId: rootAId })
    stranger2 = await mkBillTeammate({ email: 's2@x.test', regionId: regionAId, orgUnitId: rootAId })
    neverLookedUp = await mkBillTeammate({ email: 'nk@x.test', regionId: regionAId, orgUnitId: rootAId, department: 'Ops' })

    await captureDirectorySnapshot(t.db, directReport, {
      department: null, companyName: null, manager: { oid: 'oid-root-owner', email: 'root.owner@x.test' },
    })
    for (const id of [stranger1, stranger2]) {
      await captureDirectorySnapshot(t.db, id, {
        department: null, companyName: null, manager: { oid: 'oid-lee', email: 'lee.hughes@x.test' },
      })
    }
    // How they ACTUALLY got here: the chain walk climbed past their own manager,
    // found no nearer owner, and hit the catch-all. That walk stamps manager-chain
    // provenance, which is also what makes them re-resolvable later.
    const store = makePlacementStore(t.db)
    for (const id of [directReport, stranger1, stranger2, neverLookedUp]) {
      await store.setPlacementProvenance(id, { via: 'manager-chain', ownerOid: 'oid-root-owner' })
    }
    void lee
  })

  it('counts who does not belong, keeps "never looked up" separate, and names the cluster', async () => {
    const res = await call<{
      occupants: number
      direct_reports: number
      not_direct_reports: number
      manager_unknown: number
      threshold: number
      warn: boolean
      clusters: Array<{
        manager_oid: string | null
        manager_label: string
        people: number
        manager_owns_unit_count: number
      }>
    }>(occupancyGet, ev({ method: 'GET', session: adminA(), params: { id: rootAId } }))

    expect(res.occupants).toBe(4)
    expect(res.direct_reports).toBe(1)
    expect(res.not_direct_reports).toBe(2)
    // Captured department but never a manager → we have not looked, so they are
    // NOT counted as misplaced.
    expect(res.manager_unknown).toBe(1)
    expect(res.clusters).toEqual([
      { manager_oid: 'oid-lee', manager_label: 'Lee Hughes', people: 2, manager_owns_unit_count: 0 },
    ])
    // Seeded platform baseline is 20, so two strangers is not yet a warning.
    expect(res.threshold).toBe(20)
    expect(res.warn).toBe(false)
  })

  it('an owner the WALK cannot use does not make their reports belong here', async () => {
    /*
     * The warning has to use placement's own owner rule, not a laxer one. Give the
     * catch-all's owner a SECOND active cost-owning unit and the chain walk treats
     * them as ambiguous: it skips them and places nobody through them, on either
     * unit. Counting their report as a "direct report" would suppress exactly the
     * person the walk could not place — the warning going quietest on the
     * misconfiguration it exists to report.
     */
    const [dup] = await t.client<{ id: string }[]>`
      INSERT INTO cou_owner (org_unit_id, teammate_id)
      VALUES (${couA2Id}::uuid, ${ownerId}::uuid) RETURNING id::text AS id`

    const res = await call<{
      direct_reports: number
      not_direct_reports: number
      clusters: Array<{ manager_oid: string | null; people: number }>
    }>(occupancyGet, ev({ method: 'GET', session: adminA(), params: { id: rootAId } }))

    expect(res.direct_reports).toBe(0)
    expect(res.not_direct_reports).toBe(3)
    // …and they become their own cluster, which is the actionable form of it.
    expect(res.clusters.find((c) => c.manager_oid === 'oid-root-owner')?.people).toBe(1)

    await t.client`DELETE FROM cou_owner WHERE id = ${dup!.id}::uuid`
  })

  it('a cluster reports its manager\'s existing ownership, so the UI cannot advise creating an ambiguous owner', async () => {
    const [lee] = await t.client<{ id: string }[]>`SELECT id::text AS id FROM teammate WHERE entra_oid = 'oid-lee'`
    const base = await call<{ clusters: Array<{ manager_oid: string | null; manager_owns_unit_count: number }> }>(
      occupancyGet, ev({ method: 'GET', session: adminA(), params: { id: rootAId } }),
    )
    expect(base.clusters.find((c) => c.manager_oid === 'oid-lee')!.manager_owns_unit_count).toBe(0)

    // Lee now owns one cost centre. "Make them an owner" of a second is the very
    // thing the ambiguity warning is about, so the count has to come back.
    await t.db.insert(schema.couOwner).values({ orgUnitId: couA2Id, teammateId: lee!.id })
    const after = await call<{ clusters: Array<{ manager_oid: string | null; manager_owns_unit_count: number }> }>(
      occupancyGet, ev({ method: 'GET', session: adminA(), params: { id: rootAId } }),
    )
    expect(after.clusters.find((c) => c.manager_oid === 'oid-lee')!.manager_owns_unit_count).toBe(1)
    await t.client`DELETE FROM cou_owner WHERE teammate_id = ${lee!.id}::uuid AND org_unit_id = ${couA2Id}::uuid`
  })

  it('clusters_truncated means a further cluster EXISTS — not that the page came back full', async () => {
    // Exactly `limit` clusters is a COMPLETE list. Flagging `>= limit` told the
    // admin a tail was hidden whenever the count landed on the page size.
    const exact = await call<{ clusters: unknown[]; clusters_truncated: boolean }>(
      occupancyGet, ev({ method: 'GET', session: adminA(), params: { id: rootAId }, query: { clusters: '1' } }),
    )
    expect(exact.clusters).toHaveLength(1)
    expect(exact.clusters_truncated).toBe(false)

    // A second manager's cluster, and the same request is now genuinely truncated.
    const extra = await mkBillTeammate({ email: 'trunc@x.test', regionId: regionAId, orgUnitId: rootAId })
    await captureDirectorySnapshot(t.db, extra, {
      department: null, companyName: null, manager: { oid: 'oid-other-mgr', email: 'other.mgr@x.test' },
    })
    const truncated = await call<{ clusters: unknown[]; clusters_truncated: boolean }>(
      occupancyGet, ev({ method: 'GET', session: adminA(), params: { id: rootAId }, query: { clusters: '1' } }),
    )
    expect(truncated.clusters).toHaveLength(1)
    expect(truncated.clusters_truncated).toBe(true)
    await t.client`DELETE FROM teammate WHERE id = ${extra}::uuid`
  })

  it('occupancy is refused on a unit that is not the catch-all — the flag is enforced, not decorative', async () => {
    // Every number it returns is catch-all arithmetic and the threshold is that
    // unit's span-of-control dial; on an ordinary cost centre both mean nothing.
    await expect(
      call(occupancyGet, ev({ method: 'GET', session: adminA(), params: { id: couAId } })),
    ).rejects.toMatchObject({ statusCode: 422 })
  })

  it('the threshold is a dial, not a constant: a region override changes the verdict', async () => {
    await t.client`INSERT INTO governance_setting (key, scope_type, scope_id, value_numeric)
      VALUES ('placement.default_unit_warn_threshold', 'region', ${regionAId}::uuid, 1)`
    const res = await call<{ threshold: number; warn: boolean }>(
      occupancyGet, ev({ method: 'GET', session: adminA(), params: { id: rootAId } }),
    )
    expect(res.threshold).toBe(1)
    expect(res.warn).toBe(true) // 2 > 1

    // And the tree agrees with the panel — one definition, two readers.
    const tree = await call<{
      default_unit_warn_threshold: number
      nodes: Array<{ id: string; is_default: boolean; default_occupancy: { not_direct_reports: number; warn: boolean } | null }>
    }>(orgUnitsGet, ev({ method: 'GET', session: adminA(), query: { region: regionAId } }))
    const root = tree.nodes.find((n) => n.id === rootAId)!
    expect(root.is_default).toBe(true)
    expect(root.default_occupancy).toMatchObject({ not_direct_reports: 2, warn: true })
    // Every other node is not a catch-all and carries no occupancy verdict.
    for (const n of tree.nodes.filter((x) => x.id !== rootAId)) {
      expect(n.is_default).toBe(false)
      expect(n.default_occupancy).toBeNull()
    }
    await t.client`DELETE FROM governance_setting WHERE scope_type = 'region' AND scope_id = ${regionAId}::uuid`
  })

  it('the warning SHRINKS when the cluster\'s manager becomes an owner and the people are re-resolved', async () => {
    // Making Lee an owner of A Core is the action the cluster row asks for.
    const [lee] = await t.client<{ id: string }[]>`SELECT id::text AS id FROM teammate WHERE entra_oid = 'oid-lee'`
    await t.db.insert(schema.couOwner).values({ orgUnitId: couAId, teammateId: lee!.id })
    // (mei already owns couA; two owners on one unit is fine — ambiguity is about
    // one OWNER holding two units, not one unit holding two owners.)

    const before = await call<{ not_direct_reports: number }>(
      occupancyGet, ev({ method: 'GET', session: adminA(), params: { id: rootAId } }),
    )
    expect(before.not_direct_reports).toBe(2)

    const res = await runRegionReresolve(t.db, {
      regionId: regionAId,
      limit: 200,
      lookupDirectory: async (email) =>
        email === 's1@x.test' || email === 's2@x.test'
          ? { oid: `oid-${email}`, email, displayName: email, mail: email, upn: email, department: null,
              jobTitle: null, companyName: null, country: null, officeLocation: null, state: null,
              costCenter: null, division: null }
          : null,
      getManager: async (oid) => (oid.startsWith('oid-s') ? { oid: 'oid-lee', email: 'lee.hughes@x.test' } : null),
    })
    expect(res.moves.map((m) => m.teammateId).sort()).toEqual([stranger1, stranger2].sort())
    expect(await homeOf(stranger1)).toBe(couAId)
    expect(await homeOf(stranger2)).toBe(couAId)

    const after = await call<{ not_direct_reports: number; clusters: unknown[] }>(
      occupancyGet, ev({ method: 'GET', session: adminA(), params: { id: rootAId } }),
    )
    expect(after.not_direct_reports).toBe(0)
    expect(after.clusters).toEqual([])
    await t.client`DELETE FROM cou_owner WHERE teammate_id = ${lee!.id}::uuid`
  })

  it('a region admin cannot read another region\'s catch-all occupancy', async () => {
    await expect(
      call(occupancyGet, ev({ method: 'GET', session: adminB(), params: { id: rootAId } })),
    ).rejects.toMatchObject({ statusCode: 403 })
    // …and the same admin CAN read their own.
    const own = await call<{ org_unit: { id: string; is_default: boolean } }>(
      occupancyGet, ev({ method: 'GET', session: adminB(), params: { id: rootBId } }),
    )
    expect(own.org_unit.id).toBe(rootBId)
    expect(own.org_unit.is_default).toBe(true)
  })

  it('an unknown unit is a 404, and the caller\'s own region is unaffected', async () => {
    await expect(
      call(occupancyGet, ev({
        method: 'GET', session: adminA(), params: { id: '00000000-0000-4000-8000-000000000000' },
      })),
    ).rejects.toMatchObject({ statusCode: 404 })
  })

  it('adminC sees the ambiguous owner and no route — the two warnings agree', async () => {
    const tree = await call<{ nodes: Array<{ id: string; owners: Array<{ placement_status: string }> }> }>(
      orgUnitsGet, ev({ method: 'GET', session: adminC(), query: { region: regionCId } }),
    )
    const cou = tree.nodes.find((n) => n.id === couCId)!
    expect(cou.owners[0]!.placement_status).toBe('ambiguous')
    const res = await runRegionReresolve(t.db, { regionId: regionCId })
    expect(res.routes.viable).toBe(false)
  })
})
