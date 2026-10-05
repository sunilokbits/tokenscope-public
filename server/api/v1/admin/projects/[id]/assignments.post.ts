/*
 * POST /api/v1/admin/projects/{id}/assignments — assign a person to a project
 * (Journey 3a: confirm assigned devs during onboarding).
 *
 * manager / admin / platform-admin, scoped to the project (admin → region,
 * manager → org subtree).
 *
 * Two ways to identify the member — a PM/admin must be able to add ANY person
 * in the Entra directory, including brand-new people who never logged in / have
 * no teammate row yet (docs/design/provider-billing-attribution-model.md
 * §"Directory is the org-placement source of truth"):
 *   - { oid }         — an Entra DIRECTORY pick (GET /admin/directory/search).
 *                       FIND-OR-PROVISION the teammate from the directory
 *                       identity (homed in the PROJECT's region default unit),
 *                       then assign. This is the primary path.
 *   - { teammate_id } — an EXISTING teammate (back-compat). Resolves/adopts the
 *                       real Entra identity (a bill: placeholder → adopt) before
 *                       assigning, via ensureRealIdentity.
 */
import { defineEventHandler, createError, getRequestIP, getHeader } from 'h3'
import { readValidated } from '../../../../../utils/validated-body'
import { sql } from 'drizzle-orm'
import { z } from 'zod'
import { requireRole } from '../../../../../auth/rbac'
import { assertProjectScope } from '../../../../../auth/project-scope'
import { assertSameOrigin } from '../../../../../auth/csrf'
import { withRequestRls } from '../../../../../db/request-rls'
import { recordAuditEvent } from '../../../../../db/audit'
import { requireUuidParam } from '../../../../../utils/require-uuid-param'
import { ensureRealIdentity } from '../../../../../auth/ensure-real-identity'
import { assertDirectoryIdentityPickable, provisionDirectoryTeammate } from '../../../../../auth/provision-directory-teammate'
import { loadDirectoryExclusionPatterns } from '../../../../../utils/directory-exclusions'
import { getDirectoryUserByOid } from '../../../../../azure/directory'
import { projectAssignment } from '../../../../../../drizzle/schema'

// Exactly one of teammate_id / oid — the dialog sends oid (directory pick),
// legacy callers may still send teammate_id.
const Body = z
  .object({
    teammate_id: z.string().uuid().optional(),
    oid: z.string().trim().min(1).max(200).optional(),
    // J2 (mig 0048): 'manager' = PM, may manage this project's budget
    // top-ups. Default member keeps every existing caller's behaviour.
    role: z.enum(['manager', 'member']).default('member'),
  })
  .refine((b) => (b.teammate_id ? 1 : 0) + (b.oid ? 1 : 0) === 1, {
    message: 'Provide exactly one of teammate_id or oid',
  })

export default defineEventHandler(async (event) => {
  const caller = await requireRole(event, 'manager', 'admin')
  assertSameOrigin(event)
  const id = requireUuidParam(event, 'id', 'project id')
  const body = await readValidated(event, Body)
  const ip = getRequestIP(event, { xForwardedFor: true }) ?? null
  const ua = getHeader(event, 'user-agent') ?? null

  // Directory pick: re-resolve identity SERVER-SIDE (never trust a client email /
  // display name) BEFORE the tx — getDirectoryUserByOid is a Graph call.
  const dir = body.oid ? await getDirectoryUserByOid(body.oid) : null
  if (body.oid && !dir) {
    throw createError({
      statusCode: 404,
      statusMessage: 'Directory user not found',
      data: {
        type: 'https://tokenscope.example.com/errors/directory-user',
        title: 'Directory user not found',
        status: 404,
        detail: 'No Entra directory user matches that object id.',
      },
    })
  }
  // Excluded (privileged/service) identity picks are refused BEFORE the tx
  // (issue #121). Patterns are admin-config; a fresh install excludes nobody.
  return await withRequestRls(event, async (tx) => {
    // Excluded (privileged/service) identity picks are refused inside the tx —
    // the pattern read used to be the one residual platform-pool read in this
    // fully-converted handler (docs/design/rls-enforcement.md, the pattern-load
    // class). Still BEFORE any write, so the refusal costs nothing.
    if (dir) assertDirectoryIdentityPickable(dir, await loadDirectoryExclusionPatterns(tx))
    const projRows = await tx.execute<{ region_id: string; cou_path: string; cou_id: string }>(sql`
      SELECT p.region_id::text AS region_id, cou.path::text AS cou_path, cou.id::text AS cou_id
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

    // Resolve the member teammate to assign.
    //  - oid path: find-or-provision from the directory pick. The resulting
    //    teammate carries a REAL entra_oid from Graph (source='directory'), so
    //    it is NOT a bill:/provisional: placeholder — ensureRealIdentity would
    //    be a no-op, so we skip it (don't double-resolve). Homed in the
    //    PROJECT's region so cross-region placement stays coherent.
    //  - teammate_id path: an EXISTING teammate. It MAY be a bill: placeholder
    //    (surfaced from usage before the person signed in); adopt/merge the real
    //    Entra identity here — the admin assignment is the confirmation.
    let member: { teammateId: string; email: string; displayName: string | null; adopted: boolean; provisioned: boolean }
    if (dir) {
      const p = await provisionDirectoryTeammate(tx, dir, caller.teammateId, {
        regionId: proj.region_id,
        // Placement resolves the region `default` BU; the project's cost-owning
        // unit is the in-region fallback only if that BU is somehow absent.
        fallbackOrgUnitId: proj.cou_id,
        via: 'project-assign',
      })
      member = { teammateId: p.teammateId, email: p.email, displayName: p.displayName, adopted: p.adopted, provisioned: p.provisioned }
    } else {
      const resolved = await ensureRealIdentity(tx, body.teammate_id!, caller.teammateId, 'project-assign')
      member = { teammateId: resolved.teammateId, email: resolved.email, displayName: resolved.displayName, adopted: resolved.adopted, provisioned: false }
    }

    // Already assigned (open-ended row)?
    const open = await tx.execute<{ id: string }>(sql`
      SELECT id::text AS id FROM project_assignment
      WHERE project_id = ${id}::uuid AND teammate_id = ${member.teammateId}::uuid AND upper_inf(effective)
      LIMIT 1
    `)
    if ([...open][0]) {
      throw createError({ statusCode: 409, statusMessage: 'Teammate already assigned to this project' })
    }

    const nowIso = new Date().toISOString()
    const [row] = await tx
      .insert(projectAssignment)
      .values({
        projectId: id,
        teammateId: member.teammateId,
        effective: `[${nowIso},)`,
        role: body.role,
        source: 'manual',
      })
      .returning({ id: projectAssignment.id })

    // API-3: membership changes gate budgets and tagging — record WHO did it.
    await recordAuditEvent(tx, {
      eventType: 'project-member-added',
      actorTeammateId: caller.teammateId,
      subjectKind: 'project',
      subjectId: id,
      payload: {
        teammate_id: member.teammateId,
        email: member.email,
        role: body.role,
        identity_adopted: member.adopted,
        provisioned_from_directory: member.provisioned,
      },
      ipAddress: ip,
      userAgent: ua,
    })

    return {
      id: row!.id,
      teammate_id: member.teammateId,
      email: member.email,
      display_name: member.displayName,
      role: body.role,
      identity_adopted: member.adopted,
      provisioned: member.provisioned,
    }
  })
})
