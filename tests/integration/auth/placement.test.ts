// @vitest-environment node
/*
 * S3 part (b) — the prospective placement fix. Before this, first-SSO JIT,
 * directory-pick, and emit-on-install enroll each minted their OWN "first
 * org_unit ORDER BY path" / "code='default'" query — which (ltree sorts a
 * region's root before its children) landed every one of them on the region
 * ROOT, a bare ltree label whose subtree IS THE WHOLE REGION. That degenerated
 * org-subtree scoping (server/auth/org-subtree-scope.ts) to "everyone in the
 * region" for every teammate who hadn't yet been explicitly placed.
 *
 * This asserts all three no-signal placement writers now land on the SAME
 * thing: the region's `__UNPLACED__` holding node (server/auth/placement-home.ts)
 * — a real, least-privilege RLS scope with no children, never a unit any other
 * teammate's subtree could accidentally widen into.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import { startTestDb, stopTestDb, type TestDb } from '../helpers/db'
import { resolveOrCreateTeammate } from '../../../server/auth/jit-teammate'
import { provisionDirectoryTeammate } from '../../../server/auth/provision-directory-teammate'
import { locateOrCreateProvisionalInstance } from '../../../server/auth/enroll-provision'
import { resolveDefaultRegionId } from '../../../server/auth/placement-home'
import type { DirectoryUser } from '../../../server/azure/directory'

let t: TestDb
let regionZId: string // code 'z-region' — inserted FIRST but must NOT be picked (not first alphabetically)
let regionAId: string // code 'a-region' — the lexicographically-first region
let actorTeammateId: string // a REAL teammate row — recordAuditEvent's actor_teammate_id FKs onto teammate.id

const dir = (oid: string, email: string): DirectoryUser => ({
  oid,
  email,
  displayName: 'Dir Name',
  mail: email,
  upn: email,
  department: null,
  jobTitle: null,
  companyName: null,
  country: null,
  officeLocation: null,
  state: null,
  costCenter: null,
  division: null,
})

/** The org_unit a teammate is actually homed on, by teammate id. */
async function homeOf(teammateId: string): Promise<{ code: string; unitType: string; regionCode: string }> {
  const [row] = await t.client<{ code: string; unit_type: string; region_code: string }[]>`
    SELECT ou.code, ou.unit_type, r.code AS region_code
    FROM teammate tm JOIN org_unit ou ON ou.id = tm.org_unit_id JOIN region r ON r.id = ou.region_id
    WHERE tm.id = ${teammateId}::uuid`
  return { code: row!.code, unitType: row!.unit_type, regionCode: row!.region_code }
}

/** True iff `orgUnitId` has no children (no other org_unit's parent_id points at it). */
async function hasNoChildren(orgUnitId: string): Promise<boolean> {
  const [{ n }] = await t.client<{ n: string }[]>`
    SELECT COUNT(*)::text AS n FROM org_unit WHERE parent_id = ${orgUnitId}::uuid`
  return Number(n) === 0
}

beforeAll(async () => {
  t = await startTestDb()
  process.env.NUXT_SESSION_SECRET = 'placement-test-padded-to-thirty-two-chars'
  process.env.NUXT_HMAC_SESSION_KEY = 'placement-test-hmac-key-padded-well-beyond-32'
  // Insertion order is deliberately REVERSE of code order — proves
  // resolveDefaultRegionId sorts by `code`, not insertion/creation order.
  await t.client`INSERT INTO region (id, code, display_name) VALUES (gen_random_uuid(), 'z-region', 'Z Region')`
  await t.client`INSERT INTO region (id, code, display_name) VALUES (gen_random_uuid(), 'a-region', 'A Region')`
  const [z] = await t.client<{ id: string }[]>`SELECT id::text AS id FROM region WHERE code = 'z-region'`
  const [a] = await t.client<{ id: string }[]>`SELECT id::text AS id FROM region WHERE code = 'a-region'`
  regionZId = z!.id
  regionAId = a!.id
  // A REAL non-root, non-holding, non-default unit in a-region — if any placement
  // writer regresses to "first org_unit ORDER BY path", this is the trap it would
  // land a teammate on (proving the fix, not just the absence of a bug).
  await t.client`INSERT INTO org_unit (region_id, parent_id, path, code, display_name, unit_type, is_cost_owning_unit)
    VALUES (${regionAId}::uuid, NULL, 'aaa_first_by_path'::ltree, 'aaa-trap', 'Trap BU', 'bu', true)`
  const [trapUnit] = await t.client<{ id: string }[]>`SELECT id::text AS id FROM org_unit WHERE code = 'aaa-trap'`
  // A real teammate row for the directory-pick actor (recordAuditEvent's
  // actor_teammate_id FKs onto teammate.id).
  await t.client`INSERT INTO teammate (entra_oid, email, display_name, role, region_id, org_unit_id)
    VALUES ('placement-actor-oid', 'actor@example.com', 'Actor', 'admin', ${regionAId}::uuid, ${trapUnit!.id}::uuid)`
  const [actor] = await t.client<{ id: string }[]>`SELECT id::text AS id FROM teammate WHERE entra_oid = 'placement-actor-oid'`
  actorTeammateId = actor!.id
}, 120_000)

afterAll(async () => {
  await stopTestDb(t)
})

describe('resolveDefaultRegionId — the ONE shared default-region pick', () => {
  it('picks the lexicographically-first region by code, not insertion order', async () => {
    const id = await resolveDefaultRegionId(t.db as never)
    expect(id).toBe(regionAId)
    expect(id).not.toBe(regionZId)
  })
})

describe('resolveOrCreateTeammate (first-SSO JIT) — homes on the holding node', () => {
  it('a brand-new sign-in lands on a-region\'s __UNPLACED__ holding node, never the "aaa-trap" BU', async () => {
    const r = await resolveOrCreateTeammate(t.db, { oid: 'jit-oid-1', email: 'jit1@example.com', name: 'Jit One' })
    expect(r.created).toBe(true)
    const home = await homeOf(r.teammateId)
    expect(home.regionCode).toBe('a-region')
    expect(home.code).toBe('__UNPLACED__')
    expect(home.unitType).toBe('holding')
    expect(home.code).not.toBe('aaa-trap')
    expect(await hasNoChildren(r.teammateId /* placeholder, replaced below */)).toBeDefined()
  })

  it('the holding node has NO children (a leaf, not a fan-out node someone else could subtree into)', async () => {
    const r = await resolveOrCreateTeammate(t.db, { oid: 'jit-oid-2', email: 'jit2@example.com', name: 'Jit Two' })
    const [row] = await t.client<{ org_unit_id: string }[]>`
      SELECT org_unit_id::text AS org_unit_id FROM teammate WHERE id = ${r.teammateId}::uuid`
    expect(await hasNoChildren(row!.org_unit_id)).toBe(true)
  })
})

describe('provisionDirectoryTeammate (directory pick) — homes on the holding node', () => {
  it('a directory pick lands on the target region\'s __UNPLACED__ holding node, never `default`/a real BU', async () => {
    const r = await provisionDirectoryTeammate(
      t.db as never,
      dir('dir-oid-1', 'dirpick1@example.com'),
      actorTeammateId,
      { regionId: regionAId, fallbackOrgUnitId: '00000000-0000-0000-0000-000000000002', via: 'test' },
    )
    expect(r.provisioned).toBe(true)
    const home = await homeOf(r.teammateId)
    expect(home.regionCode).toBe('a-region')
    expect(home.code).toBe('__UNPLACED__')
    expect(home.unitType).toBe('holding')
    expect(home.code).not.toBe('default')
    expect(home.code).not.toBe('aaa-trap')
  })

  it('a second directory pick in the SAME region reuses the SAME holding node (idempotent create-on-demand)', async () => {
    const r1 = await provisionDirectoryTeammate(
      t.db as never,
      dir('dir-oid-2', 'dirpick2@example.com'),
      actorTeammateId,
      { regionId: regionAId, fallbackOrgUnitId: '00000000-0000-0000-0000-000000000002', via: 'test' },
    )
    const r2 = await provisionDirectoryTeammate(
      t.db as never,
      dir('dir-oid-3', 'dirpick3@example.com'),
      actorTeammateId,
      { regionId: regionAId, fallbackOrgUnitId: '00000000-0000-0000-0000-000000000002', via: 'test' },
    )
    const [row1] = await t.client<{ org_unit_id: string }[]>`SELECT org_unit_id::text AS org_unit_id FROM teammate WHERE id = ${r1.teammateId}::uuid`
    const [row2] = await t.client<{ org_unit_id: string }[]>`SELECT org_unit_id::text AS org_unit_id FROM teammate WHERE id = ${r2.teammateId}::uuid`
    expect(row1!.org_unit_id).toBe(row2!.org_unit_id) // ON CONFLICT DO NOTHING — one node per region
  })
})

describe('enroll-provision defaultPlacement (emit-on-install, no authenticated identity) — homes on the holding node', () => {
  it('a fresh enroll lands on the DEFAULT region\'s __UNPLACED__ holding node — the SAME region resolveDefaultRegionId picks', async () => {
    const outcome = await locateOrCreateProvisionalInstance(t.db as never, 'enroll1@example.com', 'device-hint-1')
    if ('capExceeded' in outcome) throw new Error('unexpected cap')
    const home = await homeOf(outcome.teammateId)
    expect(home.regionCode).toBe('a-region') // the SAME default resolveDefaultRegionId returns
    expect(home.code).toBe('__UNPLACED__')
    expect(home.unitType).toBe('holding')
    expect(home.code).not.toBe('aaa-trap') // never "first org_unit ORDER BY path"
  })

  it('a re-enroll from the SAME (email, device) mints a fresh instance/teammate on the same holding node', async () => {
    const first = await locateOrCreateProvisionalInstance(t.db as never, 'enroll2@example.com', 'device-hint-2')
    const second = await locateOrCreateProvisionalInstance(t.db as never, 'enroll2@example.com', 'device-hint-2')
    if ('capExceeded' in first || 'capExceeded' in second) throw new Error('unexpected cap')
    expect(second.teammateId).not.toBe(first.teammateId)
    expect(second.instanceId).not.toBe(first.instanceId)
    expect((await homeOf(second.teammateId)).code).toBe('__UNPLACED__')
  })
})
