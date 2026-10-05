/*
 * requireRole + requireAuth — fake H3 events to exercise the allow/deny
 * paths without spinning up Nitro.
 *
 * Auth resolution post-refactor: requireAuth/requireRole call tryAuth()
 * which reads from event.context['__tokenscope_session'] (per-event
 * cache). Tests bypass OIDC + DB by injecting directly into that cache
 * via injectTestSession.
 */
import { describe, it, expect } from 'vitest'
import { requireAuth, requireRole, requireRegionScope } from '../../../server/auth/rbac'
import { assertProjectScope } from '../../../server/auth/project-scope'
import type { Session } from '../../../server/utils/auth'
import { injectTestSession } from '../../helpers/auth'

function makeEvent(session?: Session) {
  const ev = {
    context: {} as Record<string, unknown>,
    node: {
      req: { headers: {} as Record<string, string> },
      res: { _headers: {} as Record<string, string | string[]>, getHeader() {}, setHeader() {}, removeHeader() {}, appendHeader() {}, get headersSent() { return false } },
    },
  }
  if (session) injectTestSession(ev as unknown as Parameters<typeof injectTestSession>[0], session)
  return ev
}

const DEV: Session = {
  teammateId: '00000000-0000-0000-0000-000000000001',
  email: 'dev@example.com',
  displayName: 'Dev',
  role: 'developer',
  regionId: '11111111-1111-1111-1111-111111111111',
  orgPath: 'apac.services.delta',
  issuedAt: '2026-01-01T00:00:00.000Z',
}

const ADMIN: Session = { ...DEV, email: 'admin@example.com', role: 'admin' }

describe('requireAuth', () => {
  it('throws 401 when no session', async () => {
    const ev = makeEvent()
    await expect(
      requireAuth(ev as unknown as Parameters<typeof requireAuth>[0]),
    ).rejects.toThrow(/Unauthenticated/)
  })

  it('returns the session when present', async () => {
    const ev = makeEvent(DEV)
    const got = await requireAuth(ev as unknown as Parameters<typeof requireAuth>[0])
    expect(got.role).toBe('developer')
  })
})

describe('requireRole', () => {
  it('allows when the session role is in the allowed list', async () => {
    const ev = makeEvent(DEV)
    const got = await requireRole(
      ev as unknown as Parameters<typeof requireRole>[0],
      'developer',
      'manager',
    )
    expect(got.role).toBe('developer')
  })

  it('throws 403 when the session role is not allowed', async () => {
    const ev = makeEvent(DEV)
    await expect(
      requireRole(ev as unknown as Parameters<typeof requireRole>[0], 'admin'),
    ).rejects.toThrow(/Forbidden/)
  })

  it('admin passes an admin-only check', async () => {
    const ev = makeEvent(ADMIN)
    const got = await requireRole(
      ev as unknown as Parameters<typeof requireRole>[0],
      'admin',
    )
    expect(got.role).toBe('admin')
  })

  it('throws 401 (not 403) when no session', async () => {
    const ev = makeEvent()
    await expect(
      requireRole(ev as unknown as Parameters<typeof requireRole>[0], 'developer'),
    ).rejects.toThrow(/Unauthenticated/)
  })
})

// ── CORE-3 (robustness-review-2026-06-09): the scope helpers fail CLOSED ──────
// Every helper carries its own explicit role allowlist with a 403 default —
// a handler that forgets requireRole, or a future role added to the enum, must
// get DENIED scope, never silently-unbounded scope.

describe('requireRegionScope — explicit allowlist, 403 default (CORE-3)', () => {
  const TARGET_REGION = '22222222-2222-2222-2222-222222222222'

  async function regionScope(session: Session, regionId: string) {
    const ev = makeEvent(session)
    return requireRegionScope(ev as unknown as Parameters<typeof requireRegionScope>[0], regionId)
  }

  it('admin passes for their OWN region', async () => {
    const got = await regionScope({ ...ADMIN, regionId: TARGET_REGION }, TARGET_REGION)
    expect(got.role).toBe('admin')
  })

  it('admin is DENIED cross-region (403)', async () => {
    await expect(regionScope(ADMIN, TARGET_REGION)).rejects.toMatchObject({ statusCode: 403 })
  })

  it('platform-admin is region-unbounded — and the RETIRED role is not', async () => {
    await expect(regionScope({ ...DEV, role: 'platform-admin' }, TARGET_REGION)).resolves.toBeTruthy()
    // The second assertion here used to be a duplicate of the first: the rename
    // turned `global-finops` into `platform-admin` and the case silently stopped
    // testing the retirement boundary it was written for. A stale session still
    // carrying the retired role must NOT be region-unbounded.
    await expect(
      regionScope({ ...DEV, role: 'global-finops' } as Session, TARGET_REGION),
    ).rejects.toMatchObject({ statusCode: 403 })
  })

  it('UNLISTED roles are denied — developer, manager, finance (403 default branch)', async () => {
    for (const role of ['developer', 'manager', 'finance']) {
      await expect(regionScope({ ...DEV, role } as Session, TARGET_REGION)).rejects.toMatchObject({
        statusCode: 403,
      })
    }
  })

  it('an UNKNOWN / future role is denied, even for its own region (fail closed)', async () => {
    await expect(
      regionScope({ ...DEV, role: 'auditor' as Session['role'], regionId: TARGET_REGION }, TARGET_REGION),
    ).rejects.toMatchObject({ statusCode: 403 })
  })
})

describe('assertProjectScope — explicit allowlist, 403 default (CORE-3)', () => {
  const project = { regionId: DEV.regionId, couPath: 'apac.services.delta' }

  /** Stands in for the request transaction: answers the region-root probe. */
  const homeTx = (placedBelowRoot: boolean) =>
    ({ execute: async () => [{ ok: placedBelowRoot }] }) as unknown as Parameters<typeof assertProjectScope>[2]

  async function projectScope(session: Session, tx = homeTx(true)) {
    const ev = makeEvent(session)
    return assertProjectScope(ev as unknown as Parameters<typeof assertProjectScope>[0], project, tx)
  }

  it('manager within the subtree passes; platform-admin pass', async () => {
    await expect(projectScope({ ...DEV, role: 'manager' })).resolves.toBeUndefined()
    await expect(projectScope({ ...DEV, role: 'platform-admin' })).resolves.toBeUndefined()
    await expect(projectScope({ ...DEV, role: 'platform-admin' })).resolves.toBeUndefined()
  })

  it('manager whose OWN home is the region root → 403, even inside the subtree', async () => {
    await expect(projectScope({ ...DEV, role: 'manager' }, homeTx(false))).rejects.toMatchObject({ statusCode: 403 })
  })

  it('manager OUTSIDE the subtree → 403', async () => {
    await expect(
      projectScope({ ...DEV, role: 'manager', orgPath: 'emea.other' }),
    ).rejects.toMatchObject({ statusCode: 403 })
  })

  it('UNLISTED roles → 403 default branch (developer, finance, unknown)', async () => {
    for (const role of ['developer', 'finance', 'auditor']) {
      await expect(projectScope({ ...DEV, role } as Session)).rejects.toMatchObject({
        statusCode: 403,
      })
    }
  })

  // ── S13a: the region clamp the SQL twins carry ────────────────────────────
  // allocation-scope.ts:57 / org-subtree-scope.ts:51 both wrap the `<@` in
  // `region_id = app.user_region_id`, because org_unit paths are unique only
  // per region. The manager arm here had the `<@` and not the clamp. Proven at
  // the ROUTE boundary in tests/integration/allocations/project-scope-region-clamp.test.ts
  // (a module test cannot see the handlers this gate is the sole gate for);
  // these cases pin the helper's own truth table.
  it('manager in ANOTHER region → 403 on the very same cou path', async () => {
    await expect(
      projectScope({ ...DEV, role: 'manager', regionId: '9a1e0000-0000-4000-8000-333333333333' }),
    ).rejects.toMatchObject({ statusCode: 403 })
  })

  it('a missing/empty region on EITHER side fails CLOSED — including both at once', async () => {
    const blanks = [undefined, null, ''] as unknown as string[]
    for (const bad of blanks) {
      // session side blank
      await expect(projectScope({ ...DEV, role: 'manager', regionId: bad })).rejects.toMatchObject({
        statusCode: 403,
      })
      // project side blank
      await expect(
        assertProjectScope(
          makeEvent({ ...DEV, role: 'manager' }) as unknown as Parameters<
            typeof assertProjectScope
          >[0],
          { regionId: bad, couPath: project.couPath },
          homeTx(true),
        ),
      ).rejects.toMatchObject({ statusCode: 403 })
      // BOTH blank — the `undefined === undefined` grant this must never be
      await expect(
        assertProjectScope(
          makeEvent({ ...DEV, role: 'manager', regionId: bad }) as unknown as Parameters<
            typeof assertProjectScope
          >[0],
          { regionId: bad, couPath: project.couPath },
          homeTx(true),
        ),
      ).rejects.toMatchObject({ statusCode: 403 })
    }
  })
})
