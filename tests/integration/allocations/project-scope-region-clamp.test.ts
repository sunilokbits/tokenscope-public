// @vitest-environment node
/*
 * assertProjectScope's REGION CLAMP — proven at the ROUTE boundary.
 *
 * server/auth/project-scope.ts is the sole scope gate on six handlers that all
 * admit `manager` upstream. Its manager arm used to be a bare ltree prefix test
 * (`cou.path <@ session.orgPath`) with NO region term — while both of its SQL
 * twins wrap that same test in a region clamp (server/auth/allocation-scope.ts:57,
 * server/auth/org-subtree-scope.ts:51), precisely because org_unit paths are
 * unique only PER REGION (UNIQUE is `(region_id, code)`; nothing pins `path`).
 *
 * So: two regions whose org trees COLLIDE on the same paths ('shared',
 * 'shared.eng'). A manager homed at region A's 'shared.eng' satisfied the prefix
 * test against region B's project verbatim, and the gate let them through — to
 * read region B's project roster, and to WRITE region B's money.
 *
 * A module test cannot see this: the boundary only exists once a handler has
 * resolved a project and handed it to the gate. These call the real handlers.
 *
 * Also the twins' third conjunct, placedBelowRegionRootPredicate() (sea:auth:0004):
 * a manager whose OWN home is the region root has the whole region as a subtree
 * and is refused on every project in it.
 */
import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest'
import { startTestDb, stopTestDb, type TestDb } from '../helpers/db'
import { injectTestSession } from '../../helpers/auth'
import type { Session } from '../../../server/utils/auth'
import assignmentsGet from '../../../server/api/v1/admin/projects/[id]/assignments.get'
import allocationsPost from '../../../server/api/v1/allocations/index.post'
import splitPost from '../../../server/api/v1/allocations/[id]/split.post'

let t: TestDb
// Region A — the caller's own region.
let regionAId = ''
let projAId = ''
let poolAId = ''
let mgrAId = ''
let memberAId = ''
// Region B — the foreign region, with a COLLIDING org path.
let regionBId = ''
let projBId = ''
let poolBId = ''
let memberBId = ''

/** The colliding path: it exists in BOTH regions, on a genuinely parented unit. */
const ENG_PATH = 'shared.eng'
/** A range distinct from the fixtures' pools, so POST /allocations can't 409. */
const FRESH_RANGE = '[2026-07-01T00:00:00+00,2026-08-01T00:00:00+00)'
const POOL_RANGE = '[2026-05-01T00:00:00+00,2026-06-01T00:00:00+00)'

function ev(opts: { session: Session; method: 'GET' | 'POST'; params: Record<string, string>; body?: unknown }) {
  const headers: Record<string, string> = {
    host: 'localhost:3450',
    origin: 'http://localhost:3450',
    'content-type': 'application/json',
  }
  const e = {
    method: opts.method,
    path: '/x',
    context: { params: opts.params },
    node: {
      req: {
        method: opts.method,
        url: '/x',
        ...(opts.body === undefined ? {} : { body: opts.body }),
        socket: { remoteAddress: '127.0.0.1' },
        get headers() {
          return { ...headers }
        },
      },
      res: {
        _headers: {} as Record<string, unknown>,
        statusCode: 200,
        getHeader() {},
        setHeader() {},
        removeHeader() {},
        appendHeader() {},
        get headersSent() {
          return false
        },
      },
    },
  }
  injectTestSession(e as unknown as Parameters<typeof injectTestSession>[0], opts.session)
  return e as unknown as Parameters<typeof assignmentsGet>[0]
}

/** Manager homed at region A's 'shared.eng' — the exact path region B also has. */
const mgrA = (): Session =>
  ({
    teammateId: mgrAId,
    email: 'mgr.a@x.test',
    displayName: 'Manager A',
    role: 'manager',
    regionId: regionAId,
    orgPath: ENG_PATH,
  }) as Session
const adminA = (): Session => ({ ...mgrA(), email: 'admin.a@x.test', role: 'admin' }) as Session
/** Manager homed at region A's ROOT ('shared'): the prefix test covers every unit in A. */
const rootMgrA = (): Session => ({ ...mgrA(), email: 'root.mgr.a@x.test', orgPath: 'shared' }) as Session
const orgWide = (): Session =>
  ({ ...mgrA(), email: 'gfin@x.test', role: 'platform-admin' }) as Session

async function makeRegion(code: string): Promise<{ regionId: string; engId: string }> {
  const [r] = await t.client<{ id: string }[]>`
    INSERT INTO region (code, display_name) VALUES (${code}, ${code.toUpperCase()})
    RETURNING id::text AS id`
  const regionId = r!.id
  const [root] = await t.client<{ id: string }[]>`
    INSERT INTO org_unit (region_id, parent_id, path, code, display_name, unit_type, is_cost_owning_unit)
    VALUES (${regionId}::uuid, NULL, 'shared'::ltree, 'default', 'Shared', 'bu', true)
    RETURNING id::text AS id`
  // Genuinely PARENTED, so the caller homed here is a real least-privilege
  // placement rather than a region root — the region clamp, not the (absent)
  // root guard, is what this suite is measuring.
  const [eng] = await t.client<{ id: string }[]>`
    INSERT INTO org_unit (region_id, parent_id, path, code, display_name, unit_type, is_cost_owning_unit)
    VALUES (${regionId}::uuid, ${root!.id}::uuid, ${ENG_PATH}::ltree, 'eng', 'Engineering', 'practice', true)
    RETURNING id::text AS id`
  return { regionId, engId: eng!.id }
}

async function makeProject(regionId: string, engId: string, code: string): Promise<string> {
  const [p] = await t.client<{ id: string }[]>`
    INSERT INTO project (code, code_hash, display_name, type, region_id, cost_owning_unit_id)
    VALUES (${code}, ${'h-' + code}, ${code}, 'billable', ${regionId}::uuid, ${engId}::uuid)
    RETURNING id::text AS id`
  return p!.id
}

async function makeTeammate(
  regionId: string,
  engId: string,
  oid: string,
  email: string,
  role: string,
): Promise<string> {
  const [tm] = await t.client<{ id: string }[]>`
    INSERT INTO teammate (entra_oid, email, display_name, region_id, org_unit_id, role)
    VALUES (${oid}, ${email}, ${email}, ${regionId}::uuid, ${engId}::uuid, ${role})
    RETURNING id::text AS id`
  return tm!.id
}

async function makePool(projectId: string): Promise<string> {
  const [evt] = await t.client<{ id: string }[]>`
    INSERT INTO audit_event (event_type, subject_kind, subject_id, payload)
    VALUES ('allocation-created', 'project', ${projectId}::uuid, '{"initial":true}'::jsonb)
    RETURNING id::text AS id`
  const [alloc] = await t.client<{ id: string }[]>`
    INSERT INTO allocation (scope_type, scope_id, budget_usd, effective, allocation_kind, audit_event_id)
    VALUES ('project', ${projectId}::uuid, '10000.00'::numeric, ${POOL_RANGE}::tstzrange, 'baseline', ${evt!.id}::uuid)
    RETURNING id::text AS id`
  return alloc!.id
}

beforeAll(async () => {
  t = await startTestDb()
  process.env.DATABASE_URL = t.url

  const a = await makeRegion('rc-a')
  regionAId = a.regionId
  const b = await makeRegion('rc-b')
  regionBId = b.regionId

  projAId = await makeProject(regionAId, a.engId, 'PRJ-A')
  projBId = await makeProject(regionBId, b.engId, 'PRJ-B')

  mgrAId = await makeTeammate(regionAId, a.engId, 'oid-rc-mgr-a', 'mgr.a@x.test', 'manager')
  memberAId = await makeTeammate(regionAId, a.engId, 'oid-rc-mem-a', 'member.a@x.test', 'developer')
  memberBId = await makeTeammate(regionBId, b.engId, 'oid-rc-mem-b', 'member.b@x.test', 'developer')

  await t.client`INSERT INTO project_assignment (project_id, teammate_id, effective)
    VALUES (${projAId}::uuid, ${memberAId}::uuid, '[2026-01-01T00:00:00+00,)'::tstzrange),
           (${projBId}::uuid, ${memberBId}::uuid, '[2026-01-01T00:00:00+00,)'::tstzrange)`

  poolAId = await makePool(projAId)
  poolBId = await makePool(projBId)

  // The premise this whole suite rests on: the two regions really do collide on
  // the cost-owning unit path, so the ltree prefix test alone cannot separate them.
  const paths = await t.client<{ path: string; region_id: string }[]>`
    SELECT cou.path::text AS path, p.region_id::text AS region_id
    FROM project p JOIN org_unit cou ON cou.id = p.cost_owning_unit_id
    WHERE p.id IN (${projAId}::uuid, ${projBId}::uuid)`
  expect(paths.map((r) => r.path)).toEqual([ENG_PATH, ENG_PATH])
  expect(new Set(paths.map((r) => r.region_id)).size).toBe(2)
}, 180_000)

afterAll(async () => {
  if (t) await stopTestDb(t)
}, 30_000)

beforeEach(async () => {
  // Undo anything a money test wrote, so each case starts from the fixture.
  await t.client`DELETE FROM allocation
    WHERE scope_type = 'project' AND scope_id IN (${projAId}::uuid, ${projBId}::uuid)
      AND (teammate_id IS NOT NULL OR effective = ${FRESH_RANGE}::tstzrange)`
  await t.client`UPDATE project SET allocation_mode = 'shared_pool', is_onboarded = FALSE
    WHERE id IN (${projAId}::uuid, ${projBId}::uuid)`
})

describe('READ route — GET /admin/projects/:id/assignments', () => {
  it('refuses a region-A manager the region-B project roster (403) despite the colliding cou path', async () => {
    await expect(
      assignmentsGet(ev({ session: mgrA(), method: 'GET', params: { id: projBId } })),
    ).rejects.toMatchObject({ statusCode: 403 })
  })

  it('still serves that manager their OWN region project (the clamp does not narrow same-region)', async () => {
    const res = (await assignmentsGet(
      ev({ session: mgrA(), method: 'GET', params: { id: projAId } }),
    )) as { members: { teammate_id: string }[] }
    expect(res.members.map((m) => m.teammate_id)).toContain(memberAId)
  })
})

describe('MONEY route — POST /allocations', () => {
  it('refuses a region-A manager a budget on the region-B project (403), and writes nothing', async () => {
    await expect(
      allocationsPost(
        ev({
          session: mgrA(),
          method: 'POST',
          params: {},
          body: { project_id: projBId, budget_usd: '4200.00', effective: FRESH_RANGE },
        }),
      ),
    ).rejects.toMatchObject({ statusCode: 403 })
    const [row] = await t.client<{ n: string }[]>`
      SELECT count(*)::text AS n FROM allocation
      WHERE scope_type = 'project' AND scope_id = ${projBId}::uuid
        AND effective = ${FRESH_RANGE}::tstzrange`
    expect(row!.n).toBe('0')
    const [proj] = await t.client<{ is_onboarded: boolean }[]>`
      SELECT is_onboarded FROM project WHERE id = ${projBId}::uuid`
    expect(proj!.is_onboarded).toBe(false)
  })

  it('still lets that manager budget their OWN region project', async () => {
    const res = (await allocationsPost(
      ev({
        session: mgrA(),
        method: 'POST',
        params: {},
        body: { project_id: projAId, budget_usd: '4200.00', effective: FRESH_RANGE },
      }),
    )) as { id: string; is_onboarded: boolean }
    expect(res.is_onboarded).toBe(true)
    const [row] = await t.client<{ n: string }[]>`
      SELECT count(*)::text AS n FROM allocation WHERE id = ${res.id}::uuid`
    expect(row!.n).toBe('1')
  })
})

describe('MONEY route — POST /allocations/:id/split', () => {
  it('refuses a region-A manager per-dev caps on the region-B pool (403), and writes nothing', async () => {
    // memberB IS a current assignee of projB, so without the region clamp this
    // request completes and writes a cap row — the 422 assignee guard does not
    // stand in for authorization.
    await expect(
      splitPost(
        ev({
          session: mgrA(),
          method: 'POST',
          params: { id: poolBId },
          body: { mode: 'per_dev_fixed', caps: [{ teammate_id: memberBId, budget_usd: '900.00' }] },
        }),
      ),
    ).rejects.toMatchObject({ statusCode: 403 })
    const [row] = await t.client<{ n: string }[]>`
      SELECT count(*)::text AS n FROM allocation
      WHERE scope_type = 'project' AND scope_id = ${projBId}::uuid AND teammate_id IS NOT NULL`
    expect(row!.n).toBe('0')
    const [proj] = await t.client<{ allocation_mode: string }[]>`
      SELECT allocation_mode FROM project WHERE id = ${projBId}::uuid`
    expect(proj!.allocation_mode).toBe('shared_pool')
  })

  it('still lets that manager split their OWN region pool', async () => {
    const res = (await splitPost(
      ev({
        session: mgrA(),
        method: 'POST',
        params: { id: poolAId },
        body: { mode: 'per_dev_fixed', caps: [{ teammate_id: memberAId, budget_usd: '900.00' }] },
      }),
    )) as { mode: string }
    expect(res.mode).toBe('per_dev_fixed')
    const [row] = await t.client<{ n: string }[]>`
      SELECT count(*)::text AS n FROM allocation
      WHERE scope_type = 'project' AND scope_id = ${projAId}::uuid AND teammate_id = ${memberAId}::uuid`
    expect(row!.n).toBe('1')
  })
})

describe('region-root guard (sea:auth:0004)', () => {
  it('a manager homed at their region ROOT is refused their own region project: roster 403, budget 403, nothing written', async () => {
    await expect(
      assignmentsGet(ev({ session: rootMgrA(), method: 'GET', params: { id: projAId } })),
    ).rejects.toMatchObject({ statusCode: 403 })
    await expect(
      allocationsPost(
        ev({
          session: rootMgrA(),
          method: 'POST',
          params: {},
          body: { project_id: projAId, budget_usd: '4200.00', effective: FRESH_RANGE },
        }),
      ),
    ).rejects.toMatchObject({ statusCode: 403 })
    const [row] = await t.client<{ n: string }[]>`
      SELECT count(*)::text AS n FROM allocation
      WHERE scope_type = 'project' AND scope_id = ${projAId}::uuid
        AND effective = ${FRESH_RANGE}::tstzrange`
    expect(row!.n).toBe('0')
  })
})

describe('the other role arms are unchanged', () => {
  it('a region-A admin is still refused region B and still served region A', async () => {
    await expect(
      assignmentsGet(ev({ session: adminA(), method: 'GET', params: { id: projBId } })),
    ).rejects.toMatchObject({ statusCode: 403 })
    const res = (await assignmentsGet(
      ev({ session: adminA(), method: 'GET', params: { id: projAId } }),
    )) as { members: { teammate_id: string }[] }
    expect(res.members.map((m) => m.teammate_id)).toContain(memberAId)
  })

  it('platform-admin stays org-wide — region B is still readable', async () => {
    const res = (await assignmentsGet(
      ev({ session: orgWide(), method: 'GET', params: { id: projBId } }),
    )) as { members: { teammate_id: string }[] }
    expect(res.members.map((m) => m.teammate_id)).toContain(memberBId)
  })
})
