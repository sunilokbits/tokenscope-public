/*
 * GET /api/v1/admin/projects/{id}/assignments — list a project's CURRENT
 * members (open assignments, `upper_inf(effective)`).
 *
 * Same scope as the POST/DELETE on this path: manager / admin / platform-admin,
 * bound to the project (admin → region, manager → org subtree). Powers the
 * "Manage members" panel on Admin → Region → Projects so assignment isn't
 * buried in the allocation editor.
 */
import { defineEventHandler, createError, getRouterParam } from 'h3'
import { sql } from 'drizzle-orm'
import { z } from 'zod'
import { requireRole } from '../../../../../auth/rbac'
import { assertProjectScope } from '../../../../../auth/project-scope'
import { withRequestRls } from '../../../../../db/request-rls'

interface MemberRow extends Record<string, unknown> {
  teammate_id: string
  email: string
  display_name: string | null
  role: string
  home_cou_id: string | null
  home_cou_name: string | null
  is_cross_cou: boolean
}

export default defineEventHandler(async (event) => {
  await requireRole(event, 'manager', 'admin')
  const id = getRouterParam(event, 'id')
  if (!id || !z.string().uuid().safeParse(id).success) {
    throw createError({ statusCode: 400, statusMessage: 'Invalid project id' })
  }

  return await withRequestRls(event, async (tx) => {
    const projRows = await tx.execute<{ region_id: string; cou_path: string }>(sql`
      SELECT p.region_id::text AS region_id, cou.path::text AS cou_path
      FROM project p
      JOIN org_unit cou ON cou.id = p.cost_owning_unit_id
      WHERE p.id = ${id}::uuid
      LIMIT 1
    `)
    const proj = [...projRows][0]
    if (!proj) {
      throw createError({ statusCode: 404, statusMessage: 'Project not found' })
    }
    await assertProjectScope(event, { regionId: proj.region_id, couPath: proj.cou_path }, tx)

    // J2: each member's HOME cost-owning unit — the nearest CoU ancestor of
    // their org unit (or the unit itself). Cross-CC membership is normal
    // (people from multiple P&L centres work one project); the lead CC is
    // the project's cost_owning_unit_id and members from elsewhere are
    // flagged is_cross_cou.
    const rows = await tx.execute<MemberRow>(sql`
      SELECT
        t.id::text AS teammate_id,
        t.email,
        t.display_name,
        pa.role,
        home.id::text AS home_cou_id,
        home.display_name AS home_cou_name,
        -- R1 F8: NULL home = unhomed (no cost-owning ancestor), not cross-CC.
        (home.id IS NOT NULL AND home.id IS DISTINCT FROM p.cost_owning_unit_id) AS is_cross_cou
      FROM project_assignment pa
      JOIN teammate t ON t.id = pa.teammate_id
      JOIN project p ON p.id = pa.project_id
      JOIN org_unit tou ON tou.id = t.org_unit_id
      LEFT JOIN LATERAL (
        SELECT cou.id, cou.display_name
        FROM org_unit cou
        WHERE cou.path @> tou.path
          AND cou.is_cost_owning_unit
          AND cou.region_id = tou.region_id
        ORDER BY nlevel(cou.path) DESC
        LIMIT 1
      ) home ON TRUE
      -- effective @> now(), not upper_inf (R1 F11): "current member" must
      -- agree with isProjectManager and viewer.role, or a future-dated PM
      -- shows controls here while the budget endpoints refuse them.
      WHERE pa.project_id = ${id}::uuid AND pa.effective @> now()
      ORDER BY (pa.role = 'manager') DESC, t.display_name NULLS LAST, t.email
    `)

    return {
      members: [...rows].map((r) => ({
        teammate_id: r.teammate_id,
        email: r.email,
        display_name: r.display_name,
        role: r.role,
        home_cou_id: r.home_cou_id,
        home_cou_name: r.home_cou_name,
        is_cross_cou: r.is_cross_cou,
      })),
    }
  })
})
