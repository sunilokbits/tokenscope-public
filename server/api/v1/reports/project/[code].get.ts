/*
 * GET /api/v1/reports/project/{code}?month|from&to — the PROJECT at reports
 * depth, for a viewer admitted by a reports grant rather than by membership
 * (developer pages build D37; prototype `:726-767`).
 *
 * TWO FIGURES + NAMED ROWS + ONE REMAINDER (fix 9 / C3):
 *   - total vs allocation, and burn/day. The budget belongs to the PROJECT, so
 *     the total is over ALL members — a scoped headline would misstate every
 *     budget position (annex :532-543).
 *   - Top models, the same ranked-bar shape as everywhere else.
 *   - "your members' contribution": contributors inside the viewer's people
 *     scope NAMED, everyone else folded into ONE aggregate remainder so the
 *     rows foot to the project total.
 *
 * ABSENT at this depth (prototype `:766`): the team table, cache economics, the
 * activity mix and untagged pressure. Those are the team's working surfaces, not
 * an observer's.
 *
 * The member depth is UNCHANGED and lives where it always did
 * (`/api/v1/me/projects/{code}`, membership-gated, 404 for a non-member). See
 * `server/reporting/project-depth.ts` for why this is a parallel read rather
 * than a third admission arm there.
 */
import { createError, defineEventHandler, getRouterParam, getValidatedQuery } from 'h3'
import { z } from 'zod'
import { requireAuth } from '../../../../auth/rbac'
import { resolveReportGrants } from '../../../../auth/report-scope'
import { withRequestRls } from '../../../../db/request-rls'
import {
  withReportCache,
  identityKey,
  normalizedQuery,
} from '../../../../reporting/report-cache'
import { resolveReportWindow, DATE_REGEX } from '../../../../reporting/params'
import {
  resolveProjectReportsAdmission,
  fetchProjectContribution,
  projectPeopleScopeExpr,
  projectRemainderLabel,
  splitProjectContribution,
} from '../../../../reporting/project-depth'
import { resolveDrillScope } from '../../../../reporting/teammate'
import {
  completeOneProjectSpend,
  completeProjectModelMix,
} from '../../../../usage/complete-spend'
import { fetchProjectAllocation } from '../../../../usage/consumption'
import { providerStatesForWindow } from '../../../../reports/settling'
import { reportCoverageMeta } from '../../../../reports/coverage-meta'
import { MONTH_REGEX, monthKeyUtc } from '../../../../utils/period'
import { requestClock } from '../../../../utils/request-clock'
import { parseSpendLens } from '../../../../../shared/usage/lens'
import type { ReportsProjectChargebackResponse } from '../../../../../shared/reports/project-chargeback'
import {
  fetchProjectChargebackContributors,
  fetchProjectChargebackSeries,
} from '../../../../reporting/project-chargeback'

const Query = z.object({
  month: z.string().regex(MONTH_REGEX).optional(),
  from: z.string().regex(DATE_REGEX).optional(),
  to: z.string().regex(DATE_REGEX).optional(),
  /*
   * The entry FRAME, carried for the provenance echo and the breadcrumb (D30).
   * Optional here and REQUIRED on the teammate drill, and the asymmetry is the
   * point: a project figure is a fact about the project (whole-project total vs
   * its own allocation), so no scope predicate computes it. Nothing on this
   * response is scope-filtered except which contributors are NAMED, and that is
   * resolved from the caller's own grants, never from this token.
   */
  src: z.string().max(120).optional(),
  lane: z.unknown().optional(),
})

/** Manager-facing project figures drop unconfirmed identity bindings — the same
 *  option the member depth uses, so the two depths cannot report two totals. */
const PROJECT_SPEND_OPTS = { excludeProvisional: true } as const

const DAY_MS = 86_400_000

/**
 * THE COMPLETE SET of `resolveDrillScope` outcomes that mean "this frame yields
 * no drill" rather than "this request failed". Enumerated from the resolver
 * itself (`server/reporting/teammate.ts` + everything it calls), not guessed:
 *
 *   400 — a MALFORMED token. Bad shape (`isScopeSrcToken`), or a `cc:` / `region:`
 *         id that is not a UUID.
 *   403 — a token naming a frame the CALLER DOES NOT HOLD. `forbidSrc` for each
 *         of the four grants; `resolveCostCentreDrill`'s anti-IDOR collapse
 *         (absent / retired / non-cost-owning / foreign / unowned all raise the
 *         same 403 rather than an existence oracle); `resolveRegionalScope`'s
 *         role refusal; the region-clamp mismatch.
 *   404 — a WELL-FORMED, UNKNOWN region: `resolveRegionalScope` raises
 *         `region not found` when a cross-region caller names a region uuid that
 *         is not in `regionOptions`. THIS WAS THE GAP (r5-M1). `src=region:{uuid}`
 *         off a stale link, a deleted region, or a bookmark from another estate
 *         is precisely a decoration that resolves to nothing — and it 500'd the
 *         whole project page, which is the one thing `src` being optional here is
 *         supposed to guarantee cannot happen.
 *
 * All three are statements ABOUT THE `?src=` DECORATION, and this endpoint
 * computes no figure from it: `src` is optional precisely because no project
 * figure depends on it, so an unusable token can only mean "no drill", never "no
 * page". Refusing would turn a decoration into a gate.
 *
 * NOT WIDENED TO A CATCH-ALL, deliberately (r4-M3). A dropped connection, a
 * statement timeout, or a TypeError in the resolver is a genuine failure: it must
 * fail the request rather than degrade the page to "no row is drillable", because
 * `withReportCache` below would then KEEP that degraded body for the whole TTL —
 * one transient database blip silently disabling every drill link on the page,
 * with nothing in the logs. Letting it propagate also means it never reaches the
 * cache at all (the compute closure is not entered).
 *
 * 401 is absent on purpose: `requireAuth` has already run, and an auth failure
 * inside the resolver would be a genuine fault, not a statement about the token.
 *
 * Narrowed by STATUS rather than by instanceof: the refusals are `h3`
 * `createError` objects and `H3Error` is not reliably identifiable across the
 * layers this call crosses, while an accidental 400/403/404 from a database
 * driver is not a thing that happens.
 */
const NO_DRILL_FRAME_STATUSES: ReadonlySet<number> = new Set([400, 403, 404])

function isUnusableFrame(err: unknown): boolean {
  const status = (err as { statusCode?: unknown } | null)?.statusCode
  return typeof status === 'number' && NO_DRILL_FRAME_STATUSES.has(status)
}

export default defineEventHandler(async (event) => {
  const session = await requireAuth(event)
  const codeParsed = z.string().min(1).max(120).safeParse(getRouterParam(event, 'code'))
  if (!codeParsed.success) {
    throw createError({ statusCode: 400, statusMessage: 'Invalid project code' })
  }
  const query = await getValidatedQuery(event, (d) => Query.parse(d))
  const lane = parseSpendLens(query.lane)
  const now = new Date(requestClock(event).now)
  const win = resolveReportWindow(query, { now })
  const window = { startIso: win.startIso, endIso: win.endIso }
  const month = win.monthStr ?? monthKeyUtc(new Date(win.startIso))

  // Authz tx first (plan D5/r1-M2): admission resolves LIVE, then the connection
  // is released; the compute tx below runs only for a cache-miss leader.
  const { grants, admission, drill } = await withRequestRls(event, async (tx) => {
    const grants = await resolveReportGrants(event, tx, session)
    const admission = await resolveProjectReportsAdmission(tx, session, grants, codeParsed.data)
    /*
     * The CARRIED frame, resolved against the caller's OWN grants — the operand
     * behind each named row's `can_drill` (r3-M4), and nothing else on this
     * response. It is resolved here, live, beside the admission it belongs with.
     *
     * A frame the caller does not hold, a malformed one, or a well-formed one
     * naming a region that does not exist, is NOT a refusal here, unlike on the
     * teammate drill: `src` is OPTIONAL on this endpoint because no project
     * figure is computed from it, so an unusable token can only mean "no drill",
     * never "no page". Refusing would turn a decoration into a gate.
     *
     * WHICH statuses that is — and why it is a closed list rather than a
     * catch-all — is enumerated on {@link isUnusableFrame} above.
     */
    const drill = query.src
      ? await resolveDrillScope(tx, session, grants, query.src).catch((err: unknown) => {
          if (isUnusableFrame(err)) return null
          throw err
        })
      : null
    return { grants, admission, drill }
  })

  return await withReportCache(
    event,
    // The ROUTE PARAM is named explicitly (r1-H1).
    [
      'reports/project',
      admission.key,
      normalizedQuery(query),
      identityKey(session),
      `grant:${grants.project}`,
      // The RESOLVED frame, not the raw `?src=` token (which is already in the
      // normalized query): an identical token resolves to a different scope key
      // — or to nothing at all — when the caller's grants change, and the body
      // now carries per-row drill admission computed from it.
      `drill:${drill?.key ?? 'none'}`,
      `lane:${lane}`,
    ],
    () =>
      withRequestRls(event, async (tx) => {
        const spanDays = Math.round((Date.parse(win.endIso) - Date.parse(win.startIso)) / DAY_MS)
        const elapsedDays = Math.max(
          1,
          Math.min(Math.ceil((now.getTime() - Date.parse(win.startIso)) / DAY_MS), spanDays),
        )
        const projectBlock = {
          id: admission.project.id,
          code: admission.project.code,
          display_name: admission.project.displayName,
        }
        const windowBlock = {
          from: win.from,
          to: win.to,
          is_month: win.isMonth,
          month: win.monthStr ?? month,
          days_elapsed: elapsedDays,
          days_in_window: spanDays,
        }

        // Chargeback lens: bill dollars only, so none of the §A reads below run.
        // Contributors are named by the same rule as the attributed lens.
        if (lane === 'chargeback') {
          const [cb, rows] = await Promise.all([
            fetchProjectChargebackSeries(tx, admission.project.id, window),
            fetchProjectChargebackContributors(
              tx,
              admission.project.id,
              window,
              projectPeopleScopeExpr(admission),
            ),
          ])
          const contribution = await splitProjectContribution(tx, rows, win, {
            grants,
            teammateId: session.teammateId,
            drill: drill ? { scope: drill.usage, token: drill.token } : null,
          })
          const body: ReportsProjectChargebackResponse = {
            project: projectBlock,
            admitted_by: grants.project,
            scope: { src: query.src ?? null },
            window: windowBlock,
            lane,
            chargeback: {
              total_usd: cb.totalUsd.toFixed(2),
              series: cb.series.map((d) => ({ date: d.date, cost_usd: d.usd.toFixed(2) })),
              contributors: {
                named: contribution.named.map((r) => ({
                  teammate_id: r.teammateId,
                  display_name: r.displayName,
                  cost_usd: r.usd.toFixed(2),
                  is_active: r.isActive,
                  can_drill: r.canDrill,
                })),
                remainder: {
                  members: contribution.remainder.members,
                  label: projectRemainderLabel(contribution.remainder.members),
                  cost_usd: contribution.remainder.usd.toFixed(2),
                },
                rows_total_usd: contribution.totalUsd.toFixed(2),
              },
              settling: providerStatesForWindow(win, now).find((s) => s.vendor === 'anthropic')!,
            },
          }
          return body
        }

        const [spend, allocation, modelMix, contribution, coverage] = await Promise.all([
          completeOneProjectSpend(tx, admission.project.id, window, PROJECT_SPEND_OPTS),
          fetchProjectAllocation(tx, admission.project.id),
          // The SAME identity option as the headline beside it (r3-H2): a mix
          // that counts unconfirmed spend sums to a different total than the
          // figure it is drawn under.
          completeProjectModelMix(tx, admission.project.id, window, PROJECT_SPEND_OPTS),
          fetchProjectContribution(tx, admission, win, {
            grants,
            teammateId: session.teammateId,
            drill: drill ? { scope: drill.usage, token: drill.token } : null,
          }),
          reportCoverageMeta(tx),
        ])

        return {
          project: projectBlock,
          /** How this viewer got in — the page says so on its face (prototype `:736`). */
          admitted_by: grants.project,
          scope: { src: query.src ?? null },
          window: windowBlock,
          lane,
          budget: {
            /*
             * OVER ALL MEMBERS. `contribution.totalUsd` is the same figure from
             * the per-contributor grouping; they are reported separately and
             * asserted equal by test rather than one being derived from the
             * other, because the C3 claim is precisely that the rows reconcile
             * to a headline computed independently of them.
             */
            window_cost_usd: spend.costUsd.toFixed(2),
            allocation_usd: allocation.toFixed(2),
            burn_per_day_usd: (spend.costUsd / elapsedDays).toFixed(2),
          },
          mix: { by_model: modelMix },
          contribution: {
            named: contribution.named.map((r) => ({
              teammate_id: r.teammateId,
              display_name: r.displayName,
              cost_usd: r.usd.toFixed(2),
              // The drill-admission conjunct the client cannot otherwise know
              // (D34): a deactivated subject 403s, so its name must render as
              // plain text, never as a live-looking link.
              is_active: r.isActive,
              /*
               * The WHOLE admission decision for the CARRIED frame (r3-M4) —
               * resolved here because the client cannot: a row is named through
               * the viewer's entire people scope, while the link carries ONE
               * `?src=` frame, and only the server can ask whether this subject
               * has an in-window row inside THAT frame. `false` ⇒ plain text.
               */
              can_drill: r.canDrill,
            })),
            // ONE remainder, always rendered with its member count, and PLAIN
            // TEXT by construction — it names no target id (D29).
            remainder: {
              members: contribution.remainder.members,
              label: projectRemainderLabel(contribution.remainder.members),
              cost_usd: contribution.remainder.usd.toFixed(2),
            },
            rows_total_usd: contribution.totalUsd.toFixed(2),
          },
          meta: {
            providerStates: providerStatesForWindow(win, now),
            coverage,
          },
        }
      }),
  )
})
