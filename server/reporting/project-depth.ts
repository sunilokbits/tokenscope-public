/*
 * reporting/project-depth — the PROJECT at reports depth, for a viewer who is
 * NOT a member (developer pages build D37; annex :563-574, C3 :399).
 *
 * ── WHY THIS IS A PARALLEL READ AND NOT A THIRD ADMISSION ARM ───────────────
 * The brief sketched `requireProjectMembership` gaining a reports-grant arm
 * (00-brief.md:79-81). That is NOT taken, and the decision is recorded here
 * because this file is where someone would otherwise re-open it:
 *
 *   - `me/*` is the ONE namespace the visibility policy keeps grants-free.
 *     Importing `reportGrants` into it creates a second, unproven RBAC path —
 *     the exact drift the annex warns about (:557-561) and the whole reason the
 *     teammate drill lives under `/reports` at all (00-brief.md:39-49).
 *   - `me/projects/{code}` keeps its deliberate 404 posture: a non-member is
 *     indistinguishable from a missing project. A third arm would have had to
 *     break that posture or hide inside it.
 *   - A read HERE lands inside the per-literal-endpoint 200/403 suite and the
 *     lane firewall for free.
 *
 * Precedent for the same move in the opposite direction: `/api/v1/me/cost-centres`
 * runs the personal query functions at owner scope (annex :497-499).
 *
 * ── C3: THE ROWS FOOT TO THE WHOLE PROJECT ─────────────────────────────────
 * Named rows are the contributors inside the viewer's PEOPLE scope; everyone
 * else folds into ONE aggregate remainder, so `Σ(named) + remainder` is the
 * project total over ALL members — never over visible ones. Suppressing a
 * single-person remainder is an OPEN owner decision (brief :94-97); the build
 * renders it unsuppressed and T34 pins that as the CURRENT behaviour.
 */
import { createError } from 'h3'
import { sql } from 'drizzle-orm'
import type { SQL } from 'drizzle-orm'
import type { PostgresJsDatabase } from 'drizzle-orm/postgres-js'
import type { Session } from '../utils/auth'
import type { ReportScopeGrants } from '../../shared/auth/report-visibility'
import { namedContributionRow, teammateDrillAdmission } from '../../shared/auth/report-visibility'
import { orgSubtreeScopePredicate } from '../auth/org-subtree-scope'
import { costCentreScopeOpts } from '../auth/report-scope'
import { scopeSql, type UsageScope } from './engine/scope'
import { TEAMMATE_DRILL_FACTS_AGG, teammateDrillFacts } from './teammate-drill-facts'
import type { UsageWindow } from './params'

type Tx = PostgresJsDatabase<Record<string, unknown>>

export interface ProjectRef {
  id: string
  code: string
  displayName: string
  regionId: string
}

export interface ProjectReportsAdmission {
  project: ProjectRef
  /**
   * The viewer's PEOPLE scope as a predicate over an `org_unit` alias — which
   * contributors may be NAMED. `null` means "everyone" (a region-wide grant).
   */
  peopleScope: SQL | null
  /** Cache-key material: the resolved admission, not the request. */
  key: string
}

/**
 * The ROOTS that define a scoped viewer's people scope, as a stable fingerprint.
 *
 * ── WHY THIS IS CACHE-KEY MATERIAL AND NOT A DETAIL (r3-H1) ─────────────────
 * The response contains NAMED contributors, and which contributors may be named
 * is decided by {@link viewerPeopleScope} — a predicate over the viewer's own
 * org subtree OR any cost-owning unit they ACTIVELY own. The key used to record
 * only `people:scoped`, i.e. THAT the viewer had a scope, never WHICH roots
 * defined it. So a viewer owning CC-A and CC-B who warmed a project naming
 * contributors from both, then lost CC-A while CC-B still admitted the project,
 * re-resolved admission LIVE (correctly) to an identical key — and was served
 * the revoked scope's names and dollars for the rest of the TTL.
 *
 * The cost-centre cache already sets this precedent by folding its visible-CC
 * ids into the key. The subtree half needs no separate term: its GUC inputs
 * (org path, region, role) are already in `identityKey(session)`.
 *
 * PATH and REGION ride alongside the id because ownership of a MOVED subtree is
 * a different people scope with the same row id, and `owned.path <@` is what the
 * predicate actually tests.
 */
async function ownershipRootFingerprint(tx: Tx): Promise<string> {
  const rows = await tx.execute<{ fp: string }>(sql`
    SELECT owned.id::text || ':' || owned.path::text || ':' || owned.region_id::text AS fp
      FROM cou_owner co
      JOIN org_unit owned ON owned.id = co.org_unit_id
     WHERE co.teammate_id = NULLIF(current_setting('app.user_teammate_id', true), '')::uuid
       AND co.revoked_at IS NULL
     ORDER BY 1`)
  return [...rows].map((r) => r.fp).join(',')
}

/**
 * The ONE 403 this depth speaks. A project that does not exist, a project
 * outside the viewer's scope, and a viewer with no project grant all collapse
 * to it — otherwise the endpoint answers "does a project with this code exist
 * somewhere I cannot see", which is an existence oracle over project codes
 * (T35 pins the collapse).
 */
function forbid(): never {
  throw createError({
    statusCode: 403,
    statusMessage: 'Forbidden',
    data: {
      type: 'https://tokenscope.example.com/errors/forbidden',
      title: 'Forbidden',
      status: 403,
      detail: 'This project is not in a scope your role grants.',
    },
  })
}

/**
 * The viewer's PEOPLE scope over an `org_unit` alias: their own least-privilege
 * subtree (the GUC-driven clamp every other surface uses) OR any cost-owning
 * unit they actively own.
 *
 * `null` for a caller whose grants are region-wide — there is no clamp, and
 * expressing "everyone" as a `TRUE` predicate would make the two cases
 * indistinguishable in the cache key.
 *
 * `ownerOnly` (costCentreScopeOpts) drops the subtree arm: for an org-wide
 * role the GUC predicate's `'global-finops'` disjunct is unconditionally TRUE
 * (org-subtree-scope.ts:49, request-rls.ts:33 maps platform-admin onto it), so
 * an UNGRANTED org-wide caller holding project depth solely via cou_owner
 * would otherwise collapse this clause to TRUE and read any project in the
 * company. Same seal the Business-Unit resolvers apply.
 */
export function viewerPeopleScope(
  grants: ReportScopeGrants,
  alias: string,
  opts?: { ownerOnly?: boolean },
): SQL | null {
  if (grants.project === 'region-wide' || grants.costCentre === 'all') return null
  const ownerArm = sql`EXISTS (
      SELECT 1 FROM cou_owner co
      JOIN org_unit owned ON owned.id = co.org_unit_id
      WHERE co.teammate_id = NULLIF(current_setting('app.user_teammate_id', true), '')::uuid
        AND co.revoked_at IS NULL
        AND ${sql.raw(`${alias}.path`)} <@ owned.path
        AND ${sql.raw(`${alias}.region_id`)} = owned.region_id
    )`
  if (opts?.ownerOnly) return sql`(${ownerArm})`
  return sql`(
    ${orgSubtreeScopePredicate(alias)}
    OR ${ownerArm}
  )`
}

/**
 * Admit (or refuse) one reports-depth project read.
 *
 * `'region-wide'`     → any existing project (their regional width is the whole
 *                       company today; when E1 narrows it, narrow it HERE).
 * `'member-in-scope'` → a project with ≥1 CURRENT member inside the viewer's
 *                       people scope (annex :563-574). Membership, not
 *                       contribution: a project whose people are the viewer's
 *                       is theirs to see even in a window nobody spent in.
 * anything else       → 403.
 */
export async function resolveProjectReportsAdmission(
  tx: Tx,
  session: Session,
  grants: ReportScopeGrants,
  code: string,
): Promise<ProjectReportsAdmission> {
  if (grants.project !== 'region-wide' && grants.project !== 'member-in-scope') forbid()
  const { ownerOnly } = costCentreScopeOpts(session, grants)
  const peopleScope = viewerPeopleScope(grants, 'ou', { ownerOnly })

  const memberClause =
    peopleScope == null
      ? sql`TRUE`
      : sql`EXISTS (
          SELECT 1 FROM project_assignment pa
          JOIN teammate t ON t.id = pa.teammate_id
          JOIN org_unit ou ON ou.id = t.org_unit_id
          WHERE pa.project_id = p.id AND pa.effective @> now()
            AND ${peopleScope}
        )`

  const rows = await tx.execute<{
    id: string
    code: string
    display_name: string
    region_id: string
  }>(sql`
    SELECT p.id::text AS id, p.code, p.display_name, p.region_id::text AS region_id
      FROM project p
     WHERE p.code = ${code} AND ${memberClause}
     LIMIT 1`)
  const p = [...rows][0]
  if (!p) forbid()
  // WHICH roots define the scope, not merely THAT there is one (r3-H1). Resolved
  // in the same live authz transaction as the admission above, so a revocation
  // re-keys on the very next request rather than at TTL expiry.
  // Owner-only scope keys distinctly from subtree scope: the same teammate can
  // move between the two classes (role change) inside one cache TTL.
  const roots =
    peopleScope == null
      ? 'all'
      : `${ownerOnly ? 'owner' : 'scoped'}:${await ownershipRootFingerprint(tx)}`
  return {
    project: { id: p!.id, code: p!.code, displayName: p!.display_name, regionId: p!.region_id },
    peopleScope,
    key: `project:${p!.id}|people:${roots}`,
  }
}

export interface ProjectContributionRow {
  teammateId: string
  displayName: string
  usd: number
  /** `teammate.is_active` — the drill-admission conjunct the client needs (D34). */
  isActive: boolean
  /**
   * SERVER-RESOLVED drill admission FOR THE CARRIED FRAME (r3-M4).
   *
   * Naming and linking are decided by DIFFERENT predicates on this surface, and
   * that asymmetry is the whole reason this field exists. A row is NAMED when
   * the subject is anywhere in the viewer's PEOPLE scope — every cost centre
   * they own, plus their own subtree. A LINK, though, carries exactly one
   * `?src=` frame, and the target recomputes D34's emit-time conjunct against
   * THAT frame alone. A viewer owning CC-A and CC-B who enters with `src=cc:A`
   * therefore sees contributors named through CC-B whose drill correctly 403s —
   * the live-looking dead button `drill-contract.ts` exists to forbid, produced
   * by the client assuming `hasInScopeWindowRow: true`.
   *
   * So the SERVER answers it: `false` ⇒ the client renders plain text. It is the
   * same rule (`teammateDrillAdmission`), evaluated where the frame's scope
   * predicate can actually be run.
   */
  canDrill: boolean
}

export interface ProjectContribution {
  /** Named rows: contributors inside the viewer's people scope. */
  named: ProjectContributionRow[]
  /** The ONE aggregate remainder so the rows foot to the project total (C3). */
  remainder: { members: number; usd: number }
  /** Σ over ALL members — the figure `named` + `remainder` reconcile to. */
  totalUsd: number
}

/**
 * Per-contributor spend on ONE project for the window, split by the row-naming
 * rule.
 *
 * The SQL returns every contributor with a flag saying whether they fall inside
 * the viewer's people scope; the SPLIT itself is then made by the exported rule
 * {@link namedContributionRow}, not by the query. That is deliberate: the rule
 * is the thing the admin preview renders and the tests pin, so a second,
 * SQL-shaped statement of it is the divergence D38 exists to prevent.
 *
 * PROVISIONAL SPEND IS EXCLUDED, exactly as the headline excludes it (r3-H2).
 * The headline runs `completeOneProjectSpend(..., { excludeProvisional: true })`
 * while these rows counted every identity state, so a project with $100 of
 * confirmed and $20 of provisional spend published a $100 headline over $120 of
 * rows — C3, the footing rule this whole depth is built on, broken by a
 * predicate that was on one side of the identity and not the other.
 */
export async function fetchProjectContribution(
  tx: Tx,
  admission: ProjectReportsAdmission,
  win: UsageWindow,
  viewer: {
    grants: ReportScopeGrants
    teammateId: string
    /**
     * The RESOLVED `?src=` frame, or `null` when the request carried no frame
     * the viewer actually holds. Drives {@link ProjectContributionRow.canDrill}
     * ONLY — nothing else on this response is scope-filtered by it (D37).
     */
    drill: { scope: UsageScope; token: string } | null
  },
): Promise<ProjectContribution> {
  const inScopeExpr = projectPeopleScopeExpr(admission)

  const rows = await tx.execute<ProjectContributorRow>(sql`
    SELECT u.teammate_id::text AS teammate_id,
           COALESCE(NULLIF(t.display_name, ''), t.email) AS label,
           COALESCE(SUM(u.cost_usd), 0)::text AS usd,
           -- The drill facts, from the ONE shared producer (teammate-drill-facts.ts):
           -- never a hand-rolled bool_or pair, which is how three review rounds each
           -- found another producer that had simply forgotten one of them.
           ${TEAMMATE_DRILL_FACTS_AGG},
           bool_or(${inScopeExpr}) AS in_scope
      FROM v_complete_usage u
      JOIN teammate t ON t.id = u.teammate_id
     WHERE u.project_id = ${admission.project.id}::uuid
       -- The SAME identity predicate the headline applies (r3-H2) — C3 foots
       -- only if both sides of the reconciliation count the same money.
       AND u.identity_state IS DISTINCT FROM 'provisional'
       AND u.ts_event >= ${win.startIso}::timestamptz
       AND u.ts_event <  ${win.endIso}::timestamptz
     GROUP BY u.teammate_id, t.display_name, t.email
     ORDER BY SUM(u.cost_usd) DESC, COALESCE(NULLIF(t.display_name, ''), t.email) ASC`)

  return splitProjectContribution(tx, [...rows], win, viewer)
}

/** One contributor's window total, with the facts the naming and drill rules read. */
export interface ProjectContributorRow extends Record<string, unknown> {
  teammate_id: string
  label: string
  usd: string
  drill_is_active: boolean | null
  drill_is_provisional: boolean | null
  in_scope: boolean
}

/**
 * The SQL fragment that flags a contributor (alias `t` = teammate) as inside the
 * viewer's people scope.
 */
export function projectPeopleScopeExpr(admission: ProjectReportsAdmission): SQL {
  return admission.peopleScope == null
    ? sql`TRUE`
    : sql`EXISTS (
        SELECT 1 FROM org_unit ou
        WHERE ou.id = t.org_unit_id AND ${admission.peopleScope}
      )`
}

/**
 * Split per-contributor totals into named rows and ONE remainder by the shared
 * naming rule. Every lens of the reports-depth project page names through here.
 */
export async function splitProjectContribution(
  tx: Tx,
  all: ProjectContributorRow[],
  win: UsageWindow,
  viewer: {
    grants: ReportScopeGrants
    teammateId: string
    drill: { scope: UsageScope; token: string } | null
  },
): Promise<ProjectContribution> {

  /*
   * D34's emit-time conjunct, evaluated against the CARRIED frame — the
   * subject's in-window rows anywhere inside that frame, NOT just this
   * project's, because that is exactly what the drill target itself recomputes
   * (`subjectHasInScopeRow`). ONE set query for every contributor, not one
   * EXISTS per row; a request with no held frame drills nowhere at all, so the
   * query is skipped entirely.
   */
  const drillable = new Set<string>()
  if (viewer.drill && all.length > 0) {
    const ids = sql.join(
      all.map((r) => sql`${r.teammate_id}::uuid`),
      sql`, `,
    )
    const hits = await tx.execute<{ teammate_id: string }>(sql`
      SELECT DISTINCT u.teammate_id::text AS teammate_id
        FROM v_complete_usage u
       WHERE u.teammate_id IN (${ids})
         AND ${scopeSql(viewer.drill.scope)}
         AND u.identity_state IS DISTINCT FROM 'provisional'
         AND u.ts_event >= ${win.startIso}::timestamptz
         AND u.ts_event <  ${win.endIso}::timestamptz`)
    for (const h of [...hits]) drillable.add(h.teammate_id)
  }

  const named: ProjectContributionRow[] = []
  let remainderUsd = 0
  let remainderMembers = 0
  let totalUsd = 0

  for (const r of all) {
    const usd = Number(r.usd)
    totalUsd += usd
    const facts = teammateDrillFacts(r)
    const name =
      // An UNCONFIRMED claimed identity is never a published name (r3-H2). It
      // folds into the aggregate remainder rather than dropping out, so the
      // rows still foot to the headline whichever identity states the project
      // happens to carry.
      !facts.isProvisional &&
      namedContributionRow(
        { grants: viewer.grants },
        { id: r.teammate_id, inPeopleScope: r.in_scope === true, isSelf: r.teammate_id === viewer.teammateId },
        // The VIEWER is not a member — that is what makes this reports depth. The
        // context is passed explicitly rather than assumed so the rule reads the
        // same here as it does on a member-depth surface.
        { viewerIsMember: false },
      )
    if (name) {
      const decision = teammateDrillAdmission(
        { grants: viewer.grants },
        {
          id: r.teammate_id,
          // The SERVER-resolved conjunct: rows inside the CARRIED frame, not
          // inside the people scope that named the row.
          hasInScopeWindowRow: drillable.has(r.teammate_id),
          isActive: facts.isActive,
          isProvisional: facts.isProvisional,
        },
        { src: viewer.drill?.token ?? null, held: viewer.drill != null },
        // The window the row was computed at, in the rule's `YYYY-MM-DD`
        // vocabulary. `endIso` is the EXCLUSIVE bound, so the inclusive last day
        // is the day before it.
        {
          from: win.startIso.slice(0, 10),
          to: new Date(Date.parse(win.endIso) - 86_400_000).toISOString().slice(0, 10),
        },
      )
      named.push({
        teammateId: r.teammate_id,
        displayName: r.label,
        usd,
        isActive: facts.isActive,
        canDrill: decision.admit,
      })
    } else {
      remainderUsd += usd
      remainderMembers += 1
    }
  }

  return { named, remainder: { members: remainderMembers, usd: remainderUsd }, totalUsd }
}

/**
 * The remainder row's words. ONE vocabulary, so the reports-depth table and any
 * later consumer say it identically — and so the count is always stated: a
 * remainder without its member count is an unattributable lump.
 */
export function projectRemainderLabel(members: number): string {
  return `${members} member${members === 1 ? '' : 's'} outside your scope`
}
