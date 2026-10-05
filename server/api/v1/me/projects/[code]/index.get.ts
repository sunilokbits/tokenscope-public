/*
 * GET /api/v1/me/projects/{code} — the project dashboard payload (brief §5,
 * rebuilt by developer-pages W3 D27) in ONE fetch, for PM and project team
 * alike (PO decision: full project transparency for current members; no role
 * asymmetry).
 *
 * Gate: current project_assignment membership — a non-member is
 * indistinguishable from a missing project (404, the [sid] posture).
 *
 * ── ONE WINDOW FOR EVERY FIGURE (W3 D16/D27, r1-H9) ──────────────────────────
 * The endpoint windows on the REPORT vocabulary — `?month=YYYY-MM` XOR
 * `?from&to`, resolved by `resolveReportWindow` — and EVERY figure follows it:
 * headline, hero deltas, model mix, team table, activity mix, untagged
 * pressure, lane-excluded bucket.
 *
 * ── …AND EXACTLY ONE FIGURE THAT DOES NOT (fix sprint D28) ───────────────────
 * `burn` is a TRAILING 30/90-day block, on the `?window=30|90` parameter
 * `shared/schemas/usage.ts::WindowQuery` already documents and `/usage` already
 * serves. #237 retired it on the argument that "a trailing breakdown beside a
 * month hero was two windows on one page"; the owner restored it (R5), and the
 * restoration is safe for the reason the retirement missed: **two windows on one
 * page is only a defect when one of them is silent.** The card carries the same
 * 30/90 control and the same "rolls with the days — independent of the month
 * presets above" sentence as `/usage`'s Daily spend, so no figure is left
 * without its period. Nothing else moves: the hero, the model mix and the team
 * table all decompose `budget.window_cost_usd` and stay on the page window.
 *
 * A trailing window does not reset on the 1st, which is the whole point of
 * having one beside a month hero — on day 1 a month-to-date burn chart is one
 * column, and this one still reads.
 *
 * THE TRAILING WINDOW IS RESOLVED FROM THE REQUEST CLOCK, never from SQL's
 * `now()`. `requestClock(event)` is the one instant this request may read
 * (F1/D1), so the series, the advisory footer and the axis the browser draws are
 * provably the same days.
 *
 * ── ONE LANE FOR THE WINDOW FIGURES ──────────────────────────────────────────
 * The headline, the team-contribution table, the model mix/series and the
 * activity mix all come from `server/usage/complete-spend.ts` over
 * `v_complete_usage`, with the same window and the same `excludeProvisional`
 * option — so the headline can no longer disagree with the table 400px below
 * it, and neither can disagree with the budget editor "Manage budget →" links
 * to, or with the alert that paged the PM.
 *
 * The only aggregate read left is the velocity flag (the series perf
 * contract); its rollup age rides `page_freshness` so the page's (i) can say
 * that ONE figure ticks on a cron while everything else is live.
 *
 * ── HERO DELTAS (fix 2) ──────────────────────────────────────────────────────
 * Same-elapsed-window MoM, paced on the DATA FRONTIER via `momPaceWindow`
 * (never `now` — the settling-window lesson). Custom ranges and windows under
 * three elapsed days ship a named `empty_reason` instead of a delta — the two
 * reasons the reporting hero already names (`ScopeHero.vue`).
 *
 * ── WHAT THE PROJECT TOTAL CANNOT CARRY ──────────────────────────────────────
 * `lane_coverage.member_ingest_only_usd` is arm-3 spend by this project's
 * MEMBERS (mig 0101: untaggable BY CONSTRUCTION). It is never added to any
 * figure here and is rendered as its own labelled bucket. It is also NOT
 * ADDITIVE across projects — the `member_` prefix is the warning.
 */
import { createError, defineEventHandler, getRouterParam, getValidatedQuery } from 'h3'
import { sql as sqlRaw } from 'drizzle-orm'
import { z } from 'zod'
import { requireAuth } from '../../../../../auth/rbac'
import { withRequestRls } from '../../../../../db/request-rls'
import {
  fetchAdvisorySpend,
  fetchProjectAllocation,
  fetchProjectVelocity,
  requireProjectMembership,
} from '../../../../../usage/consumption'
import { fetchUntaggedPressure } from '../../../../../usage/project-detail'
import {
  completeOneProjectSpend,
  completeProjectMemberLaneExclusions,
  completeProjectModelMix,
  completeProjectModelSeries,
  completeProjectSpendByActivity,
  completeProjectSpendByMember,
  type SpendWindow,
} from '../../../../../usage/complete-spend'
import { aggregateFreshnessMinutes } from '../../../../../usage/freshness'
import {
  GOV_VELOCITY_SPIKE_THRESHOLD,
  resolveGovernanceSetting,
} from '../../../../../utils/governance-settings'
import { momPaceWindow, resolveReportWindow } from '../../../../../reporting/params'
import { providerStatesForWindow } from '../../../../../reports/settling'
import { reportCoverageMeta } from '../../../../../reports/coverage-meta'
import { MONTH_REGEX } from '../../../../../utils/period'
import { requestClock } from '../../../../../utils/request-clock'
import { shiftUtcDay } from '../../../../../../shared/reports/clock'
import { WindowQuery } from '../../../../../../shared/schemas/usage'
import { parseSpendLens } from '../../../../../../shared/usage/lens'
import type { MeProjectChargebackResponse } from '../../../../../../shared/reports/project-chargeback'
import {
  fetchProjectChargebackContributors,
  fetchProjectChargebackSeries,
} from '../../../../../reporting/project-chargeback'

/** Manager-facing project figures drop unconfirmed identity bindings. */
const PROJECT_SPEND_OPTS = { excludeProvisional: true } as const

/**
 * The report window vocabulary (D16) — month XOR from/to — PLUS the trailing
 * `?window=30|90` the burn card owns (D28). Merged rather than re-declared:
 * `WindowQuery` is the documented parameter `/usage` already serves, and a
 * second spelling of "30 or 90" is a second contract.
 */
const ProjectWindowQuery = z
  .object({
    month: z.string().regex(MONTH_REGEX).optional(),
    from: z
      .string()
      .regex(/^\d{4}-\d{2}-\d{2}$/)
      .optional(),
    to: z
      .string()
      .regex(/^\d{4}-\d{2}-\d{2}$/)
      .optional(),
    lane: z.unknown().optional(),
  })
  .merge(WindowQuery)

const DAY_MS = 86_400_000

/**
 * What `burn.advisory_cost_usd` is a sum OVER — shipped, not left to be inferred
 * from the fact that it sits under the burn chart.
 *
 * The chart is the §A lane with `excludeProvisional`; the advisory figure is
 * `attribution_aggregate`, which carries no identity dimension at all (so it
 * spans provisional identities), is OTel-only (no arm 2, no arm 3) and applies
 * none of `v_complete_usage` arm 1's exclusions. The two populations CANNOT be
 * made to agree — the dimension the filter would need is not in the table — so
 * the payload names the basis and the footer states it. A figure that quietly
 * counts a wider population than the chart it annotates is the "footer describes
 * a different thing than the picture" defect; naming it is the fix available.
 */
const ADVISORY_BASIS = 'otel-aggregate-all-identities' as const

/** % change (fraction) vs a prior operand, or null when the prior is 0/absent. */
function pctDelta(cur: number, prev: number): number | null {
  if (!(prev > 0)) return null
  return Number(((cur - prev) / prev).toFixed(4))
}

export default defineEventHandler(async (event) => {
  const session = await requireAuth(event)
  const codeParsed = z
    .string()
    .min(1)
    .max(120)
    .safeParse(getRouterParam(event, 'code'))
  if (!codeParsed.success) {
    throw createError({ statusCode: 400, statusMessage: 'Invalid project code' })
  }
  const query = await getValidatedQuery(event, (d) => ProjectWindowQuery.parse(d))
  const lane = parseSpendLens(query.lane)
  // The ONE instant this request may read (F1/D1). Pre-seeded by a test — or by
  // the dev-only clock pin the parity capture uses to shoot a real day 1.
  const clock = requestClock(event)
  const now = new Date(clock.now)
  const win = resolveReportWindow(query, { now })
  const window: SpendWindow = { startIso: win.startIso, endIso: win.endIso }

  /*
   * The burn card's own TRAILING window (D28): `window` settled days ending at
   * `settledThrough`, plus the still-filling `today` — exactly the axis
   * `ChartsStackedBars` draws from (`dayAxis`: N settled days back from
   * `endDay`, then the partial day beyond it). Half-open on the day after
   * today, so today's rows are included and tomorrow's cannot be.
   */
  const burnDays = query.window
  const burnFrom = shiftUtcDay(clock.settledThrough, -(burnDays - 1))
  const burnWindow: SpendWindow = {
    startIso: `${burnFrom}T00:00:00.000Z`,
    endIso: `${shiftUtcDay(clock.today, 1)}T00:00:00.000Z`,
  }

  // How far through the window the clock has got: whole-or-partial days begun,
  // clamped into the window's own span. Current month → day of month; a past
  // month → its full length (the projection degenerates to the actual); a
  // custom range → its elapsed share.
  const spanDays = Math.round((Date.parse(win.endIso) - Date.parse(win.startIso)) / DAY_MS)
  const elapsedDays = Math.max(
    0,
    Math.min(Math.ceil((now.getTime() - Date.parse(win.startIso)) / DAY_MS), spanDays),
  )

  return await withRequestRls(event, async (tx) => {
    const project = await requireProjectMembership(tx, session.teammateId, codeParsed.data)
    if (!project) {
      throw createError({
        statusCode: 404,
        statusMessage: 'Project not found',
        data: {
          type: 'https://tokenscope.example.com/errors/not-found',
          title: 'Project not found',
          status: 404,
          detail: 'No project with this code among your current memberships.',
        },
      })
    }

    // J5: the PM's budget entry point — role from the caller's own assignment;
    // budget_allocation_id is the currently-effective baseline.
    const viewerRows = await tx.execute<{ role: string }>(sqlRaw`
      SELECT role FROM project_assignment
      WHERE project_id = ${project.id}::uuid
        AND teammate_id = ${session.teammateId}::uuid
        AND effective @> now()
      LIMIT 1
    `)
    const viewerRole = [...viewerRows][0]?.role ?? 'member'
    const baselineRows = await tx.execute<{ id: string }>(sqlRaw`
      SELECT id::text AS id FROM allocation
      WHERE scope_type = 'project' AND scope_id = ${project.id}::uuid
        AND teammate_id IS NULL AND allocation_kind = 'baseline'
        AND effective @> now()
      LIMIT 1
    `)
    const viewer = {
      role: viewerRole,
      access: project.access,
      budget_allocation_id: [...baselineRows][0]?.id ?? null,
    }
    const projectBlock = {
      id: project.id,
      code: project.code,
      display_name: project.display_name,
      type: project.type,
      wbs_code: project.wbs_code,
      end_date: project.end_date,
      ended: project.ended,
    }
    const windowBlock = {
      from: win.from,
      to: win.to,
      is_month: win.isMonth,
      month: win.monthStr,
      days_elapsed: elapsedDays,
      days_in_window: spanDays,
    }
    // R2 F1: a cou-owner viewer is NOT a member — aggregates only, never the
    // NAMED per-developer contribution rows.
    const namedMembersVisible = project.access === 'member'

    // Chargeback lens: bill dollars only, so none of the §A reads below run.
    if (lane === 'chargeback') {
      const [cb, contributors] = await Promise.all([
        fetchProjectChargebackSeries(tx, project.id, window),
        fetchProjectChargebackContributors(tx, project.id, window),
      ])
      const anthropic = providerStatesForWindow(
        { monthStr: win.monthStr, endIso: win.endIso },
        now,
      ).find((s) => s.vendor === 'anthropic')!
      const body: MeProjectChargebackResponse = {
        viewer,
        project: projectBlock,
        window: windowBlock,
        lane,
        chargeback: {
          total_usd: cb.totalUsd.toFixed(2),
          series: cb.series.map((d) => ({ date: d.date, cost_usd: d.usd.toFixed(2) })),
          contributors: {
            members: namedMembersVisible
              ? contributors.map((c) => ({
                  teammate_id: c.teammate_id,
                  display_name: c.display_name,
                  email: c.email,
                  cost_usd: Number(c.usd).toFixed(2),
                }))
              : [],
            member_count: contributors.length,
          },
          settling: anthropic,
        },
      }
      return body
    }

    // Spike-threshold dial (mig 0049): resolved for the PROJECT's region
    // (R1 F2 — subject's region, never the viewer's).
    const velocityThreshold = await resolveGovernanceSetting(
      tx,
      GOV_VELOCITY_SPIKE_THRESHOLD,
      project.region_id,
    )

    const [
      spend,
      allocation,
      velocity,
      seriesByModel,
      modelMix,
      members,
      activityMix,
      untagged,
      laneExclusions,
      aggregateMinutes,
      coverage,
      assignedRows,
      burnSeriesByModel,
      burnAdvisory,
    ] = await Promise.all([
      completeOneProjectSpend(tx, project.id, window, PROJECT_SPEND_OPTS),
      fetchProjectAllocation(tx, project.id),
      fetchProjectVelocity(tx, project.id, velocityThreshold),
      // Model axis on the §A lane (arms 1+2), windowed to the PAGE window
      // (r1-H9) — a tagged fill day's models must appear in the mix its
      // money is in, and the mix must never sit beside a differently-
      // windowed headline.
      //
      // …and on the SAME identity option as the headline (r4-H2). Both of these
      // DECOMPOSE `budget.window_cost_usd`: the mix is what the panel divides by
      // its own Σ, and the series is the same money per day. Counting
      // provisional spend on one side of that identity is the exact
      // headline-vs-rows mismatch the reports depth just closed, one depth down.
      completeProjectModelSeries(tx, project.id, window, PROJECT_SPEND_OPTS),
      completeProjectModelMix(tx, project.id, window, PROJECT_SPEND_OPTS),
      completeProjectSpendByMember(tx, project.id, window, PROJECT_SPEND_OPTS),
      completeProjectSpendByActivity(tx, project.id, window, PROJECT_SPEND_OPTS),
      fetchUntaggedPressure(tx, project.id, window),
      completeProjectMemberLaneExclusions(tx, project.id, window),
      // The velocity flag's rollup clock — the ONE cron-fed figure left on
      // this page; disclosed via the §A pill's (i), not a prose paragraph.
      aggregateFreshnessMinutes(tx, 'project', project.id),
      // W0c D11: the reporting COVERAGE operand for the W1 chip row.
      reportCoverageMeta(tx),
      // "N of M members emitted" needs M = CURRENT assignments (the team
      // table's member_count is contributors-in-window, a different set).
      tx.execute<{ n: string }>(sqlRaw`
        SELECT COUNT(DISTINCT pa.teammate_id)::text AS n
        FROM project_assignment pa
        WHERE pa.project_id = ${project.id}::uuid AND pa.effective @> now()
      `),
      /*
       * The burn card's trailing series (D28) — the SAME §A lane and the SAME
       * identity option as the page-windowed one, so switching 30↔90 changes the
       * period and nothing else. Read separately from `series_by_model` rather
       * than sliced from it: a trailing 30 days reaches BACK into the previous
       * month, which is the whole point, and the page window cannot supply it.
       */
      completeProjectModelSeries(tx, project.id, burnWindow, PROJECT_SPEND_OPTS),
      /*
       * D27: advisory (telemetry-only) spend over THAT window — the chart's own,
       * not the page's. `attribution_aggregate` is where the tier-1/tier-2
       * fidelity split lives; `v_complete_usage` carries no fidelity dimension,
       * so this is the same source `/usage` discloses from, on explicit bounds.
       *
       * SAME WINDOW, DIFFERENT POPULATION — and the payload says so rather than
       * letting adjacency imply otherwise. The aggregate has no identity axis,
       * so `PROJECT_SPEND_OPTS` cannot be applied to it; see `ADVISORY_BASIS`.
       */
      fetchAdvisorySpend(tx, 'project', project.id, burnWindow),
    ])
    const windowUsd = spend.costUsd
    const assignedMembers = Number([...assignedRows][0]?.n ?? 0)

    /*
     * DOES THE ADVISORY FIGURE ACTUALLY COVER THE BURN WINDOW? (external review r2.)
     *
     * `advisory_cost_usd` is `null` when the rollup holds NOTHING for this scope
     * and window — but a window missing only SOME days came back as a confident
     * 30-day total, so a partially materialised rollup read exactly like a
     * complete one. That is the same unknown, one step in.
     *
     * The detector is a set difference, not an estimate. `burnSeriesByModel` is
     * the LEDGER's own days over this same window, and the aggregate's
     * population is a SUPERSET of it (the ledger read applies
     * `PROJECT_SPEND_OPTS`; `attribution_aggregate` has no identity axis to
     * filter on at all). So a day the ledger says carried project spend and the
     * aggregate holds NO row for cannot be a quiet day — the rollup has not
     * covered it. Days with no ledger spend are not counted as gaps: absence
     * there is genuinely ambiguous, and guessing would be the estimate this must
     * not invent.
     *
     * A non-zero count means the client must NOT present the figure as the
     * window's total.
     */
    const advisoryUncoveredDays =
      burnAdvisory === null
        ? 0
        : [...new Set(burnSeriesByModel.map((r) => r.day))].filter(
            (d) => !burnAdvisory.materialisedDays.has(d),
          ).length

    // ── Hero deltas (fix 2): same-elapsed-window MoM on the data frontier ────
    let emptyReason: string | null = null
    let spendPct: number | null = null
    let burnPct: number | null = null
    let activeMembersAbs: number | null = null
    let untaggedPct: number | null = null
    const frontierMs = members.reduce((a, m) => {
      const t = m.lastEvent ? Date.parse(m.lastEvent) : NaN
      return Number.isFinite(t) && t > a ? t : a
    }, 0)
    if (!win.isMonth || !win.monthRange) {
      emptyReason = 'no month-on-month for a custom range'
    } else if (elapsedDays < 3 || frontierMs === 0) {
      emptyReason = 'too early to compare'
    } else {
      const asOf = new Date(frontierMs)
      const prevWindow = momPaceWindow(win.monthRange, asOf)
      const prevDays = Math.round(
        (Date.parse(prevWindow.endIso) - Date.parse(prevWindow.startIso)) / DAY_MS,
      )
      const [prevSpend, prevMembers, prevUntagged] = await Promise.all([
        completeOneProjectSpend(tx, project.id, prevWindow, PROJECT_SPEND_OPTS),
        completeProjectSpendByMember(tx, project.id, prevWindow, PROJECT_SPEND_OPTS),
        fetchUntaggedPressure(tx, project.id, prevWindow),
      ])
      spendPct = pctDelta(windowUsd, prevSpend.costUsd)
      const frontierDay = Math.max(1, asOf.getUTCDate())
      burnPct = pctDelta(windowUsd / frontierDay, prevDays > 0 ? prevSpend.costUsd / prevDays : 0)
      // A COUNT delta is absolute ("↑2", not "↑13% of a headcount").
      activeMembersAbs = members.length - prevMembers.length
      untaggedPct = pctDelta(Number(untagged.cost_usd), Number(prevUntagged.cost_usd))
    }

    const memberTotal = members.reduce((a, m) => a + m.costUsd, 0)
    const top2 = members.slice(0, 2).reduce((a, m) => a + m.costUsd, 0)

    return {
      viewer,
      project: projectBlock,
      /*
       * The window every figure below shares (D16). `days_elapsed` /
       * `days_in_window` are the pace operands the client's budgetPace /
       * projectedMonthEnd vocabulary consumes (D15) — computed HERE so the
       * pill and the figures cannot window two different ways.
       */
      window: windowBlock,
      lane,
      budget: {
        window_cost_usd: windowUsd.toFixed(2),
        allocation_usd: allocation.toFixed(2),
      },
      /*
       * Where the headline came from and what it deliberately leaves out. All
       * four are about the SAME number in `budget.window_cost_usd` — never a
       * second total to add up.
       */
      lane_coverage: {
        otel_usd: spend.otelUsd.toFixed(2),
        reconciled_usd: spend.reconciledUsd.toFixed(2),
        provisional_withheld_usd: spend.provisionalUsd.toFixed(2),
        member_ingest_only_usd: laneExclusions.memberIngestOnlyUsd.toFixed(2),
        member_ingest_only_tools: laneExclusions.memberIngestOnlyTools,
      },
      velocity,
      /*
       * Hero-tile operands (fix 2): contributors in window, the assignment
       * denominator, and per-tile deltas with the named reason when withheld.
       */
      hero: {
        active_members: members.length,
        assigned_members: assignedMembers,
        deltas: {
          basis: 'vs last month',
          empty_reason: emptyReason,
          spend_pct: spendPct,
          burn_pct: burnPct,
          active_members_abs: activeMembersAbs,
          untagged_pct: untaggedPct,
        },
      },
      series_by_model: seriesByModel,
      /*
       * D28/D27 — the ONE block on this payload that does not follow the page
       * window, and it says so in its own operands rather than leaving the
       * client to infer them. `advisory_cost_usd` is a STRING like every other
       * money field here; "renders nothing at zero" is the client's call and it
       * has the number to make it.
       *
       * THE SPAN, SPELLED OUT. `from`…`to` is `window_days` SETTLED days plus
       * the still-filling `today` beyond them — 31 calendar dates for a "30d"
       * card, deliberately, because those are exactly the dates the axis draws
       * (`dayAxis`: N settled days back from `settledThrough`, then the partial
       * day beyond the edge). Trimming the window to 30 calendar dates would
       * leave the chart's leftmost bar outside the data window and pad it with a
       * fabricated zero — the defect `shared/reports/day-axis.ts` exists to
       * prevent. So the payload ships `settled_to` as well: the client can name
       * the settled span honestly instead of inferring "30" from a range that
       * spans 31 dates, and the "today partial" key has a server-side operand.
       *
       * `advisory_cost_usd` is `null`, NOT "0.00", when the aggregate holds no
       * row for this scope and window — an un-materialised rollup is not a
       * measured zero (NULL IS NOT 0). `advisory_basis` names the population it
       * sums over, which is NOT the chart's (see ADVISORY_BASIS).
       */
      burn: {
        window_days: burnDays,
        from: burnFrom,
        settled_to: clock.settledThrough,
        to: clock.today,
        series_by_model: burnSeriesByModel,
        advisory_cost_usd: burnAdvisory === null ? null : burnAdvisory.usd.toFixed(2),
        advisory_uncovered_days: advisoryUncoveredDays,
        advisory_basis: ADVISORY_BASIS,
      },
      mix: {
        // Reason-typed rows for ModelSplitPanel (fix 3): named models rank,
        // `__`-sentinel remainders land in the coverage footer, priced.
        by_model: modelMix,
        by_activity: activityMix.map((a) => ({
          activity: a.activity,
          cost_usd: a.costUsd.toFixed(2),
          tokens: a.tokens,
        })),
      },
      team: {
        members: namedMembersVisible
          ? members.map((m) => ({
              teammate_id: m.teammateId,
              display_name: m.displayName,
              email: m.email,
              cost_usd: m.costUsd.toFixed(2),
              tokens: m.tokens,
              active_days: m.activeDays,
              cost_per_active_day: m.activeDays > 0 ? (m.costUsd / m.activeDays).toFixed(2) : '0.00',
              last_event: m.lastEvent,
            }))
          : [],
        member_count: members.length,
        concentration_top2_share:
          memberTotal > 0 ? Number((top2 / memberTotal).toFixed(4)) : null,
      },
      untagged_pressure: untagged,
      /*
       * The velocity flag is the ONE cron-fed figure left on this page (its
       * series perf contract); its rollup age rides here so the §A pill's (i)
       * can disclose the two clocks. The worst-of-sources prose paragraph this
       * used to feed retired with the chip row (D14/D41).
       */
      page_freshness: {
        aggregate_minutes_ago: aggregateMinutes,
      },
      /*
       * D11: the chip-row operands (D14) — the settling clock for the WINDOW
       * this payload describes (least-settled month it spans) + the persisted
       * GitHub org-coverage marker.
       */
      providerStates: providerStatesForWindow(
        { monthStr: win.monthStr, endIso: win.endIso },
        now,
      ),
      coverage,
    }
  })
})
