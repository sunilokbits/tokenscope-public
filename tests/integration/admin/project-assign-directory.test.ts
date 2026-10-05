// @vitest-environment node
/*
 * POST /api/v1/admin/projects/:id/assignments — directory-driven membership.
 *
 * A PM/admin must be able to add ANY person in the Entra directory to a
 * project, including brand-new people who have never logged in / don't exist
 * as a teammate yet (docs/design/provider-billing-attribution-model.md
 * §"Directory is the org-placement source of truth").
 *
 * Covers:
 *   (a) oid with NO existing teammate → provisions source='directory' + assigns
 *   (b) oid that IS already a teammate → assigns, no duplicate teammate row
 *   (c) back-compat: teammate_id still works
 *   (d) a manager-role caller scoped to the project can do (a)
 *   (e) a manager whose org subtree does NOT contain the project's cost-owning
 *       unit is rejected 403 (assertProjectScope auth-scope gate)
 *   (f) a #EXT# B2B guest oid is rejected 404 (guest guard — never
 *       provisionable as a teammate)
 *
 * Runs in MOCK directory mode (NUXT_GRAPH_DIRECTORY_MODE unset → MOCK_DIRECTORY:
 * dir-oid-0001 = sasha.kumar, dir-oid-0002 = tom.becker, …).
 */
import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest'
import { startTestDb, stopTestDb, type TestDb } from '../helpers/db'
import { injectTestSession } from '../../helpers/auth'
import type { Session } from '../../../server/utils/auth'
import handler from '../../../server/api/v1/admin/projects/[id]/assignments.post'

let t: TestDb
let regionId = ''
let projectId = ''
const ids: Record<string, string> = {}
const ADMIN_ID = '00000000-0000-0000-0000-0000000000a1'
const MANAGER_ID = '00000000-0000-0000-0000-0000000000a2'
// Must be a Zod-valid (versioned) UUID — it's sent as body.teammate_id and
// validated by z.string().uuid() (unlike the Session-only admin/manager ids).
const EXISTING_ID = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaa3'

async function unplacedIdFor(rid: string): Promise<string> {
  const [row] = await t.client<{ id: string }[]>`
    SELECT id::text AS id FROM org_unit WHERE region_id = ${rid}::uuid AND code = '__UNPLACED__'`
  return row!.id
}

function ev(opts: { session: Session; projectId: string; body: unknown }) {
  const headers: Record<string, string> = { host: 'localhost:3450', origin: 'http://localhost:3450' }
  const e = {
    method: 'POST',
    path: '/x',
    context: { params: { id: opts.projectId } },
    node: {
      req: {
        method: 'POST',
        url: '/x',
        body: opts.body,
        socket: { remoteAddress: '127.0.0.1' },
        get headers() {
          return { ...headers, 'content-type': 'application/json' }
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
  return e as unknown as Parameters<typeof handler>[0]
}

// Admin scoped to the region. orgPath is irrelevant for admins (region-scope path).
const admin = (): Session =>
  ({ teammateId: ADMIN_ID, email: 'pa-admin@x.test', displayName: 'Admin', role: 'admin', regionId, orgPath: 'pa' } as Session)
// Manager (PM) homed at the project's cost-owning unit ('pa.prac'), a genuine
// non-root placement (assertProjectScope refuses a region-root home).
const manager = (): Session =>
  ({ teammateId: MANAGER_ID, email: 'pa-mgr@x.test', displayName: 'Manager', role: 'manager', regionId, orgPath: 'pa.prac' } as Session)
// Manager whose org subtree ('pa.other') does NOT contain the project's
// cost-owning unit ('pa.prac') → assertProjectScope must reject 403.
const managerOutOfScope = (): Session =>
  ({ teammateId: MANAGER_ID, email: 'pa-mgr@x.test', displayName: 'Manager', role: 'manager', regionId, orgPath: 'pa.other' } as Session)

beforeAll(async () => {
  delete process.env.NUXT_GRAPH_DIRECTORY_MODE // mock directory
  t = await startTestDb()
  process.env.DATABASE_URL = t.url
  const [r] = await t.client<{ id: string }[]>`INSERT INTO region (code, display_name) VALUES ('pa', 'PA') RETURNING id::text AS id`
  regionId = r!.id
  // Region default BU (where a provisioned directory teammate lands) + a
  // cost-owning practice that owns the project.
  const [def] = await t.client<{ id: string }[]>`INSERT INTO org_unit (region_id, parent_id, path, code, display_name, unit_type, is_cost_owning_unit)
    VALUES (${regionId}::uuid, NULL, 'pa'::ltree, 'default', 'PA (default)', 'bu', true) RETURNING id::text AS id`
  ids['default'] = def!.id
  const [prac] = await t.client<{ id: string }[]>`INSERT INTO org_unit (region_id, parent_id, path, code, display_name, unit_type, is_cost_owning_unit)
    VALUES (${regionId}::uuid, ${def!.id}::uuid, 'pa.prac'::ltree, 'prac', 'Practice', 'practice', true) RETURNING id::text AS id`
  ids['prac'] = prac!.id
  const [proj] = await t.client<{ id: string }[]>`INSERT INTO project (code, code_hash, display_name, type, region_id, cost_owning_unit_id)
    VALUES ('PA-1', 'h-pa-1', 'Project PA-1', 'billable', ${regionId}::uuid, ${prac!.id}::uuid) RETURNING id::text AS id`
  projectId = proj!.id
  await t.client`INSERT INTO teammate (id, entra_oid, email, display_name, region_id, org_unit_id, role)
    VALUES (${ADMIN_ID}::uuid, 'oid-pa-admin', 'pa-admin@x.test', 'Admin', ${regionId}::uuid, ${def!.id}::uuid, 'admin')`
  await t.client`INSERT INTO teammate (id, entra_oid, email, display_name, region_id, org_unit_id, role)
    VALUES (${MANAGER_ID}::uuid, 'oid-pa-mgr', 'pa-mgr@x.test', 'Manager', ${regionId}::uuid, ${prac!.id}::uuid, 'manager')`
  // An existing REAL teammate (for the back-compat teammate_id path).
  await t.client`INSERT INTO teammate (id, entra_oid, email, display_name, region_id, org_unit_id, role)
    VALUES (${EXISTING_ID}::uuid, 'oid-pa-existing', 'pa-existing@x.test', 'Existing Dev', ${regionId}::uuid, ${prac!.id}::uuid, 'developer')`
}, 180_000)

afterAll(async () => {
  if (t) await stopTestDb(t)
}, 30_000)

beforeEach(async () => {
  await t.client`DELETE FROM project_assignment WHERE project_id = ${projectId}::uuid`
  await t.client`DELETE FROM directory_exclusion_pattern`
  await t.client`DELETE FROM teammate WHERE source = 'directory'`
})

describe('project member assignment (directory-driven)', () => {
  it('(a) provisions a source=directory teammate from an oid with no existing teammate, then assigns', async () => {
    const res = (await handler(
      ev({ session: admin(), projectId, body: { oid: 'dir-oid-0001' } }),
    )) as { teammate_id: string; email: string; provisioned: boolean }
    expect(res.provisioned).toBe(true)
    expect(res.email).toBe('sasha.kumar@example.com')
    // Teammate created in THIS region, homed on the region's __UNPLACED__
    // holding node (S3, server/auth/placement-home.ts) — NOT the region-root
    // 'default' BU, whose subtree is the whole region.
    const [tm] = await t.client<{ region_id: string; org_unit_id: string; source: string }[]>`
      SELECT region_id::text AS region_id, org_unit_id::text AS org_unit_id, source
      FROM teammate WHERE entra_oid = 'dir-oid-0001'`
    expect(tm!.region_id).toBe(regionId)
    expect(tm!.org_unit_id).toBe(await unplacedIdFor(regionId))
    expect(tm!.org_unit_id).not.toBe(ids['default'])
    expect(tm!.source).toBe('directory')
    // An open assignment row now exists for this project.
    const [asg] = await t.client<{ n: string }[]>`
      SELECT count(*)::text AS n FROM project_assignment
      WHERE project_id = ${projectId}::uuid AND teammate_id = ${res.teammate_id}::uuid AND upper_inf(effective)`
    expect(asg!.n).toBe('1')
  })

  it('(b) does NOT re-provision when the directory person is already a teammate — assigns, no duplicate', async () => {
    // First add provisions tom (dir-oid-0002); remove the assignment (not the
    // teammate) so we can re-add the SAME directory person.
    const first = (await handler(
      ev({ session: admin(), projectId, body: { oid: 'dir-oid-0002' } }),
    )) as { teammate_id: string; provisioned: boolean }
    expect(first.provisioned).toBe(true)
    await t.client`DELETE FROM project_assignment WHERE project_id = ${projectId}::uuid AND teammate_id = ${first.teammate_id}::uuid`

    const second = (await handler(
      ev({ session: admin(), projectId, body: { oid: 'dir-oid-0002' } }),
    )) as { teammate_id: string; provisioned: boolean }
    expect(second.provisioned).toBe(false) // already a teammate → just assigned
    expect(second.teammate_id).toBe(first.teammate_id)
    const [tm] = await t.client<{ n: string }[]>`SELECT count(*)::text AS n FROM teammate WHERE entra_oid = 'dir-oid-0002'`
    expect(tm!.n).toBe('1') // exactly one teammate, not duplicated
  })

  it('(c) back-compat: assigning an existing teammate_id still works', async () => {
    const res = (await handler(
      ev({ session: admin(), projectId, body: { teammate_id: EXISTING_ID } }),
    )) as { teammate_id: string; email: string; provisioned: boolean }
    expect(res.teammate_id).toBe(EXISTING_ID)
    expect(res.email).toBe('pa-existing@x.test')
    expect(res.provisioned).toBe(false)
    const [asg] = await t.client<{ n: string }[]>`
      SELECT count(*)::text AS n FROM project_assignment
      WHERE project_id = ${projectId}::uuid AND teammate_id = ${EXISTING_ID}::uuid AND upper_inf(effective)`
    expect(asg!.n).toBe('1')
  })

  it('(d) a manager scoped to the project can provision + assign from an oid', async () => {
    const res = (await handler(
      ev({ session: manager(), projectId, body: { oid: 'dir-oid-0003' } }),
    )) as { teammate_id: string; email: string; provisioned: boolean }
    expect(res.provisioned).toBe(true)
    expect(res.email).toBe('mei.lin@example.com')
    const [asg] = await t.client<{ n: string }[]>`
      SELECT count(*)::text AS n FROM project_assignment
      WHERE project_id = ${projectId}::uuid AND teammate_id = ${res.teammate_id}::uuid AND upper_inf(effective)`
    expect(asg!.n).toBe('1')
  })

  it('(e) rejects a manager whose org subtree does NOT contain the project cost-owning unit (403)', async () => {
    // Valid directory oid (so we get past the server-side resolve), but the
    // caller's subtree ('pa.other') is not an ancestor of the project's
    // cost-owning unit ('pa.prac') → assertProjectScope denies.
    await expect(
      handler(ev({ session: managerOutOfScope(), projectId, body: { oid: 'dir-oid-0001' } })),
    ).rejects.toMatchObject({ statusCode: 403 })
    // Nothing was provisioned or assigned.
    const [tm] = await t.client<{ n: string }[]>`SELECT count(*)::text AS n FROM teammate WHERE entra_oid = 'dir-oid-0001'`
    expect(tm!.n).toBe('0')
  })

  it('(f) rejects a #EXT# B2B guest oid (404 — never provisionable as a teammate)', async () => {
    // dir-oid-9001 is a mock guest with an #EXT# UPN; getDirectoryUserByOid
    // returns null for it, so the handler 404s (as for an unknown oid) and no
    // teammate is minted.
    await expect(
      handler(ev({ session: admin(), projectId, body: { oid: 'dir-oid-9001' } })),
    ).rejects.toMatchObject({ statusCode: 404 })
    const [tm] = await t.client<{ n: string }[]>`SELECT count(*)::text AS n FROM teammate WHERE entra_oid = 'dir-oid-9001'`
    expect(tm!.n).toBe('0')
  })

  it('(g) adds a directory person whose existing teammate row has revoked_at set but is_active=TRUE (session anchor, not offboarding)', async () => {
    // Reproduces the reported bug: a benign role/region change bumped revoked_at
    // on Phil's active teammate; the add must still succeed (assign the existing
    // row), not 422. entra_oid matches mock dir-oid-0005 (Nadia, EMEA).
    await t.client`INSERT INTO teammate (entra_oid, email, display_name, region_id, org_unit_id, role, source, is_active, revoked_at)
      VALUES ('dir-oid-0005', 'nadia.haddad@example.com', 'Nadia Haddad', ${regionId}::uuid, ${ids['default']}::uuid, 'developer', 'directory', TRUE, NOW())`
    const res = (await handler(
      ev({ session: admin(), projectId, body: { oid: 'dir-oid-0005' } }),
    )) as { teammate_id: string; email: string; provisioned: boolean }
    expect(res.provisioned).toBe(false) // existing row reused, not re-provisioned
    expect(res.email).toBe('nadia.haddad@example.com')
    // Exactly one teammate row (no duplicate), and an open assignment now exists.
    const [tm] = await t.client<{ n: string }[]>`SELECT count(*)::text AS n FROM teammate WHERE entra_oid = 'dir-oid-0005'`
    expect(tm!.n).toBe('1')
    const [asg] = await t.client<{ n: string }[]>`
      SELECT count(*)::text AS n FROM project_assignment
      WHERE project_id = ${projectId}::uuid AND teammate_id = ${res.teammate_id}::uuid AND upper_inf(effective)`
    expect(asg!.n).toBe('1')
  })

  it('(h) still rejects a genuinely DEACTIVATED (is_active=FALSE) existing teammate — no silent resurrection (422)', async () => {
    // The guard we keep: is_active=FALSE is the real deactivation flag. A directory
    // pick must not resurrect it (getDirectoryUserByOid does not verify accountEnabled).
    await t.client`INSERT INTO teammate (entra_oid, email, display_name, region_id, org_unit_id, role, source, is_active)
      VALUES ('dir-oid-0006', 'james.oconnor@example.com', 'James OConnor', ${regionId}::uuid, ${ids['default']}::uuid, 'developer', 'directory', FALSE)`
    await expect(
      handler(ev({ session: admin(), projectId, body: { oid: 'dir-oid-0006' } })),
    ).rejects.toMatchObject({ statusCode: 422 })
    // Not reactivated, not assigned.
    const [row] = await t.client<{ is_active: boolean }[]>`SELECT is_active FROM teammate WHERE entra_oid = 'dir-oid-0006'`
    expect(row!.is_active).toBe(false)
    const [asg] = await t.client<{ n: string }[]>`
      SELECT count(*)::text AS n FROM project_assignment
      WHERE project_id = ${projectId}::uuid AND teammate_id = (SELECT id FROM teammate WHERE entra_oid = 'dir-oid-0006') AND upper_inf(effective)`
    expect(asg!.n).toBe('0')
  })

  it('(i) #121: the exclusion policy refuses a privileged (onmicrosoft) pick on the shared provisioning path too', async () => {
    // provisionDirectoryTeammate is shared with the owners flow; the guard runs
    // on this path as well. With a matching pattern configured, the CLD account
    // is refused 422 and nothing is provisioned.
    await t.client`INSERT INTO directory_exclusion_pattern (pattern) VALUES ('*@contoso.onmicrosoft.com')`
    await expect(
      handler(ev({ session: admin(), projectId, body: { oid: 'dir-oid-0007-cld' } })),
    ).rejects.toMatchObject({ statusCode: 422, statusMessage: 'Excluded directory identity' })
    const [tm] = await t.client<{ n: string }[]>`SELECT count(*)::text AS n FROM teammate WHERE entra_oid = 'dir-oid-0007-cld'`
    expect(tm!.n).toBe('0')
    // The STANDARD account is still assignable under the same pattern.
    const res = (await handler(ev({ session: admin(), projectId, body: { oid: 'dir-oid-0007' } }))) as { provisioned: boolean }
    expect(res.provisioned).toBe(true)
  })

  it('rejects a body with neither oid nor teammate_id (400)', async () => {
    await expect(handler(ev({ session: admin(), projectId, body: {} }))).rejects.toMatchObject({ statusCode: 400 })
  })

  it('rejects a body with BOTH oid and teammate_id (400)', async () => {
    await expect(
      handler(ev({ session: admin(), projectId, body: { oid: 'dir-oid-0001', teammate_id: EXISTING_ID } })),
    ).rejects.toMatchObject({ statusCode: 400 })
  })

  it('404s an unknown directory oid', async () => {
    await expect(
      handler(ev({ session: admin(), projectId, body: { oid: 'dir-oid-nope' } })),
    ).rejects.toMatchObject({ statusCode: 404 })
  })

  it('409s when the directory person is already an open member of this project', async () => {
    await handler(ev({ session: admin(), projectId, body: { oid: 'dir-oid-0004' } }))
    await expect(
      handler(ev({ session: admin(), projectId, body: { oid: 'dir-oid-0004' } })),
    ).rejects.toMatchObject({ statusCode: 409 })
  })
})
