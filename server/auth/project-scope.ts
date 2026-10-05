/*
 * project-scope — app-level authorization for project-targeted writes
 * (member assignment, allocation create, per-dev split).
 *
 * Mirrors the allocation read predicate (server/auth/allocation-scope.ts)
 * but for handlers that resolve a project up front and then mutate it:
 *   - admin          → bound to the project's region (requireRegionScope)
 *   - manager        → the project must be in the caller's OWN region AND its
 *                      cost-owning unit within the caller's org subtree
 *                      (region_id = session.regionId AND cou.path <@ orgPath)
 *                      AND the caller's own home is not the region root
 *                      (placedBelowRegionRootPredicate, read on `tx`)
 *   - platform-admin  → unbounded
 *
 * This is the live gate; RLS is inert at runtime (owner DB connection)
 * until Epic 10's non-owner role lands. See allocation-scope.ts.
 *
 * `tx` must be a withRequestRls transaction for this same event: the root guard
 * reads the caller's region and org path from its GUCs.
 */
import { createError, type H3Event } from 'h3'
import { sql } from 'drizzle-orm'
import type { PostgresJsDatabase } from 'drizzle-orm/postgres-js'
import type * as schema from '../../drizzle/schema'
import { requireAuth, requireRegionScope } from './rbac'
import { placedBelowRegionRootPredicate } from './org-subtree-scope'
import { isPlatformAdmin } from '../../shared/auth/roles'

export interface ProjectScope {
  regionId: string
  /** ltree path of the project's cost-owning unit. */
  couPath: string
}

/**
 * True if `path` is a descendant of (or equal to) `ancestor` in ltree terms.
 *
 * NOT a scope boundary on its own: org_unit paths are unique only PER REGION
 * (drizzle/schema/identity.ts — UNIQUE is `(region_id, code)`, nothing pins
 * `path`), so a prefix match matches a COLLIDING path in another region just as
 * happily. `sameRegion` must gate it — see assertProjectScope.
 */
function isWithin(path: string, ancestor: string): boolean {
  return path === ancestor || path.startsWith(ancestor + '.')
}

/**
 * Region equality, fail-CLOSED: a missing or empty region on EITHER side refuses.
 *
 * Both operands are typed `string`, so this is belt-and-braces — but the failure
 * it forecloses is total: a hand-built event, a partially-populated session or a
 * future nullable column would make `undefined === undefined` a silent grant on
 * EVERY region at once, on a gate whose callers write money.
 */
function sameRegion(a: string | null | undefined, b: string | null | undefined): boolean {
  return typeof a === 'string' && a !== '' && a === b
}

export async function assertProjectScope(
  event: H3Event,
  project: ProjectScope,
  tx: PostgresJsDatabase<typeof schema>,
): Promise<void> {
  const session = await requireAuth(event)
  if (session.role === 'admin') {
    // Region admin: bound to the project's region.
    await requireRegionScope(event, project.regionId)
    return
  }
  if (session.role === 'manager') {
    // The region clamp WRAPS the subtree test, exactly as this gate's SQL twins
    // do — allocation-scope.ts:57 and org-subtree-scope.ts:51 both put
    // `region_id = app.user_region_id` OUTSIDE the `<@`. Reason (spelled out at
    // org-subtree-scope.ts:39-41): org_unit paths are unique only per region, so
    // the ltree test alone passes on a colliding path from ANOTHER region. This
    // helper is the sole scope gate on the six handlers that call it — two of
    // which write money (allocations/index.post.ts, allocations/[id]/split.post.ts).
    //
    // The refusal does not say WHICH conjunct failed, matching the twins: both
    // failures are one "no row" there, and neither should be an oracle here.
    //
    // Third conjunct, as in the twins: a caller whose own home IS the region root
    // has the whole region as a "subtree", so they are refused.
    const scopeDenied = () =>
      createError({
        statusCode: 403,
        statusMessage: 'Forbidden',
        data: {
          type: 'https://tokenscope.example.com/errors/project-scope',
          title: 'Project outside org scope',
          status: 403,
          detail: 'This project is not within your region and org subtree.',
        },
      })
    if (
      !sameRegion(session.regionId, project.regionId) ||
      !isWithin(project.couPath, session.orgPath)
    ) {
      throw scopeDenied()
    }
    const [home] = await tx.execute<{ ok: boolean }>(sql`SELECT ${placedBelowRegionRootPredicate()} AS ok`)
    if (home?.ok !== true) throw scopeDenied()
    return
  }
  // platform-admin are org-wide by design.
  if (isPlatformAdmin(session.role)) {
    return
  }
  // Default DENY (CORE-3): any role not explicitly listed above gets no
  // project-write scope — never rely on upstream requireRole alone.
  throw createError({
    statusCode: 403,
    statusMessage: 'Forbidden',
    data: {
      type: 'https://tokenscope.example.com/errors/project-scope',
      title: 'Forbidden',
      status: 403,
      detail: `Role '${session.role}' is not permitted to act on this project.`,
    },
  })
}
