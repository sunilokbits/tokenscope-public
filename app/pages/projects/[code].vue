<script setup lang="ts">
/*
 * Project dashboard, member depth (brief §5; developer-pages W3 D27) — window
 * presets, hero tiles in the ScopeHero idiom, the daily burn stack on its own
 * trailing window, Top models through ModelSplitPanel, team contribution with
 * share bars + CSV export, untagged pressure. Same view for PM and member
 * (project transparency); the budget affordance is the PM's only extra.
 *
 * ONE window (fix 1 / r1-H9): `?month=` XOR `?from&to`, owned by
 * useReportState, resolved server-side — the hero, Top models, the activity mix
 * and the team table all re-derive from it.
 *
 * ONE EXCEPTION, DRAWN AND DISCLOSED (fix sprint D28, owner R5): Daily burn
 * carries its own trailing 30/90 window again, with the same control and the
 * same (i) sentence `/usage`'s Daily spend uses. #237 retired it as "two windows
 * on one page"; two windows are only a defect when one of them is silent, and a
 * month-to-date burn chart is one column on the 1st. D27 restores the advisory
 * (telemetry-only) disclosure alongside it, as that chart's FOOTER — over the
 * window it describes, never a hero-tile sub-line.
 *
 * Prose lives behind (i) (D12); the freshness paragraph retired for the
 * CcHeaderNotes chip row fed by the payload's real operands (D14).
 */
import { computed, ref, watch } from 'vue'
import { provideReportStateKeys, WINDOW_STATE_KEYS } from '../../composables/useReportState'
import { modelDisplay } from '../../composables/useModelDisplay'
import ReportSkeleton from '../../components/reporting/ReportSkeleton.vue'
import InfoDot from '../../components/ui/InfoDot.vue'
import ScopeKpiTile from '../../components/reporting/ScopeKpiTile.vue'
import DateRangeControl from '../../components/reporting/DateRangeControl.vue'
import CcHeaderNotes from '../../components/reporting/cost-centre/CcHeaderNotes.vue'
import ModelSplitPanel from '../../components/reporting/ModelSplitPanel.vue'
import ExportCsvButton from '../../components/reporting/ExportCsvButton.vue'
import LaneToggle from '../../components/reporting/LaneToggle.vue'
import ProjectChargebackView from '../../components/projects/ChargebackView.vue'
import DrillName from '../../components/reporting/DrillName.vue'
import {
  entryReportRoute,
  teammateDrillTarget,
} from '../../components/reporting/drill-contract'
import { useDrillGrants } from '../../composables/useDrillContract'
import {
  budgetPace,
  budgetPaceKind,
  budgetPaceLabel,
  projectedMonthEnd,
} from '../../composables/useRagState'
import { modelBucketKind } from '#shared/reports/model-attribution'
import { seriesColor } from '../../composables/useChartScale'
import type { DriverRow, ProviderState, ReportCoverageMeta } from '#shared/reports/types'
import type {
  MeProjectChargebackResponse,
  ReportsProjectChargebackResponse,
} from '#shared/reports/project-chargeback'
import { PROJECT_LENS_COPY, type SpendLens } from '#shared/usage/lens'
import type {
  ActivitySlice,
  MemberContribution,
  ModelDaySpend,
  ProjectModelRow,
  VelocityState,
} from '#shared/schemas/usage'

interface ProjectResp {
  project: {
    id: string
    code: string
    display_name: string
    type: string
    wbs_code: string | null
    end_date: string | null
    ended: boolean
  }
  viewer: {
    role: 'manager' | 'member'
    access: 'member' | 'cou-owner'
    budget_allocation_id: string | null
  }
  /** The resolved page window every figure shares (D16). */
  window: {
    from: string
    to: string
    is_month: boolean
    month: string | null
    days_elapsed: number
    days_in_window: number
  }
  budget: {
    window_cost_usd: string
    allocation_usd: string
  }
  velocity: VelocityState
  series_by_model: ModelDaySpend[]
  /** The burn card's OWN trailing window (D28) + its advisory disclosure (D27). */
  burn: {
    window_days: number
    from: string
    /** The SETTLED edge of the trailing window — server-resolved, not inferred. */
    settled_to: string
    /** The still-filling day beyond it (`clock.today` at the cut instant). */
    to: string
    series_by_model: ModelDaySpend[]
    /**
     * NULL, not "0.00", when the aggregate holds no row for this scope and
     * window. An un-materialised rollup is not a measured zero.
     */
    advisory_cost_usd: string | null
    /**
     * Days in this window that carry project spend in the LEDGER but no row in
     * the advisory rollup — days the rollup provably has not covered. `> 0` ⇒
     * the figure is NOT a window total and must not be presented as one.
     */
    advisory_uncovered_days: number
    /** What the advisory figure sums OVER — a DIFFERENT population to the chart. */
    advisory_basis: string
  }
  mix: {
    by_model: ProjectModelRow[]
    by_activity: ActivitySlice[]
  }
  hero: {
    active_members: number
    assigned_members: number
    deltas: {
      basis: string
      empty_reason: string | null
      spend_pct: number | null
      burn_pct: number | null
      active_members_abs: number | null
      untagged_pct: number | null
    }
  }
  lane_coverage: {
    otel_usd: string
    reconciled_usd: string
    provisional_withheld_usd: string
    // MEMBER-wide, NOT this project's share — see the bucket copy below.
    member_ingest_only_usd: string
    member_ingest_only_tools: string[]
  }
  team: { members: MemberContribution[]; member_count: number; concentration_top2_share: number | null }
  untagged_pressure: { conversations: number; cost_usd: string; tokens: number }
  page_freshness: { aggregate_minutes_ago: number | null }
  providerStates: ProviderState[]
  coverage: ReportCoverageMeta | null
  lane?: 'usage'
}

/** Chargeback lane: the identity blocks plus the bill split; no §A blocks. */
type ProjectChargebackResp = MeProjectChargebackResponse

const route = useRoute()
const code = computed(() => String(route.params.code ?? ''))

// `?lane=` is the request; every figure renders the lane the server echoed.
const lane = usePersonalLens()
const PROJECT_LENS_CAPTIONS: Record<SpendLens, string> = {
  usage: PROJECT_LENS_COPY.usage.caption,
  chargeback: PROJECT_LENS_COPY.chargeback.caption,
}

const { session, ensure } = useSession()
await ensure()

// The window rides the report vocabulary (D16): month XOR from/to, owned by
// useReportState — the SAME state DateRangeControl self-wires to.
//
// W4: the WINDOW keys only. A preset click must not stamp the reporting
// shell's `?scope=` onto a project URL (see WINDOW_STATE_KEYS).
provideReportStateKeys(WINDOW_STATE_KEYS)
const rs = useReportState()
/*
 * The Daily-burn card's OWN trailing window (D28) — component state, NOT a URL
 * key: it is a card-local lens, exactly as `/usage`'s Daily spend keeps its own
 * `windowDays`. Sharing `useReportState` would make it a page window, which is
 * the thing that must not happen.
 */
const burnWindowDays = ref<30 | 90>(30)
const windowQuery = computed(() => ({
  month: rs.month.value ?? undefined,
  from: rs.from.value ?? undefined,
  to: rs.to.value ?? undefined,
  // `?window=30|90` — the documented parameter (shared/schemas/usage.ts), and it
  // governs the burn block ALONE. Every other figure follows month XOR from/to.
  window: burnWindowDays.value,
  lane: lane.value,
}))

const { data: payload, error, pending } = await useFetch<ProjectResp | ProjectChargebackResp>(
  () => `/api/v1/me/projects/${encodeURIComponent(code.value)}`,
  { query: windowQuery, lazy: true },
)
/** The usage-lane payload; null under chargeback, where the §A blocks are absent. */
const data = computed<ProjectResp | null>(() =>
  payload.value && payload.value.lane !== 'chargeback' ? payload.value : null,
)
const cbData = computed<ProjectChargebackResp | null>(() =>
  payload.value?.lane === 'chargeback' ? payload.value : null,
)

const notFound = computed(() => (error.value as { statusCode?: number } | null)?.statusCode === 404)

/*
 * ── THE SECOND DEPTH (developer pages build D37) ────────────────────────────
 *
 * Member depth is the fetch above and is UNCHANGED, 404 posture included: a
 * non-member is indistinguishable from a missing project, and `me/*` stays the
 * one namespace with no grants model in it.
 *
 * When that 404s, a caller who holds a REPORTS grant gets the reports-depth
 * payload from a parallel endpoint inside the policy boundary. No probing
 * oracle is added: the second fetch only happens for a caller whose
 * `/reports/meta` already says they hold the grant, and its own 403 is
 * scope-shaped, not membership-shaped. A caller with neither sees today's 404
 * empty state, byte-identical to a nonexistent code.
 */
const drillGrants = useDrillGrants()
const reportsDepthEligible = computed(
  () =>
    notFound.value &&
    (drillGrants.value.project === 'member-in-scope' || drillGrants.value.project === 'region-wide'),
)

interface ProjectReportsResp {
  project: { id: string; code: string; display_name: string }
  admitted_by: string
  scope: { src: string | null }
  window: {
    from: string
    to: string
    is_month: boolean
    month: string
    days_elapsed: number
    days_in_window: number
  }
  budget: { window_cost_usd: string; allocation_usd: string; burn_per_day_usd: string }
  mix: { by_model: ProjectModelRow[] }
  contribution: {
    named: {
      teammate_id: string
      display_name: string
      cost_usd: string
      is_active: boolean
      /** SERVER-resolved for the carried `?src=` frame (r3-M4). Absent ⇒ plain text. */
      can_drill?: boolean
    }[]
    remainder: { members: number; label: string; cost_usd: string }
    rows_total_usd: string
  }
  meta: { providerStates: ProviderState[]; coverage: ReportCoverageMeta | null }
  lane?: 'usage'
}

type ProjectReportsChargebackResp = ReportsProjectChargebackResponse

const {
  data: reportsPayload,
  pending: reportsPending,
  refresh: refreshReports,
} = await useFetch<ProjectReportsResp | ProjectReportsChargebackResp>(
  () => `/api/v1/reports/project/${encodeURIComponent(code.value)}`,
  {
    query: computed(() => ({ ...windowQuery.value, src: rs.src.value ?? undefined })),
    lazy: true,
    immediate: false,
  },
)
const reportsData = computed<ProjectReportsResp | null>(() =>
  reportsPayload.value && reportsPayload.value.lane !== 'chargeback' ? reportsPayload.value : null,
)
const reportsCb = computed<ProjectReportsChargebackResp | null>(() =>
  reportsPayload.value?.lane === 'chargeback' ? reportsPayload.value : null,
)

const echoedLane = computed<SpendLens>(
  () => (payload.value ?? reportsPayload.value)?.lane ?? 'usage',
)
const shownLane = computed<SpendLens>({
  get: () => echoedLane.value,
  set: (v: SpendLens) => {
    lane.value = v
  },
})

watch(
  reportsDepthEligible,
  (eligible) => {
    if (eligible) refreshReports()
  },
  { immediate: true },
)

const reportsFrame = computed(() => ({
  src: rs.src.value,
  month: rs.month.value,
  from: rs.from.value,
  to: rs.to.value,
}))
const reportsBackRoute = computed(() => entryReportRoute(reportsFrame.value))

/**
 * A named contributor row is a link BY GRANT — the same rule, the same module.
 *
 * `hasInScopeWindowRow` is the SERVER's answer, never this page's assumption
 * (r3-M4). Naming here is decided by the viewer's whole PEOPLE scope; the link
 * carries ONE `?src=` frame. A contributor named through a different owned cost
 * centre than the carried frame has no row in that frame, so the destination
 * 403s — the dead button the drill contract forbids. `can_drill` absent (an
 * older payload) is treated as FALSE: plain text is always safe, a dead link
 * never is.
 */
function contributorTarget(row: { teammate_id: string; is_active: boolean; can_drill?: boolean }) {
  return teammateDrillTarget(
    drillGrants.value,
    {
      id: row.teammate_id,
      isActive: row.is_active,
      hasInScopeWindowRow: row.can_drill === true,
      /*
       * A LITERAL, and the one place that is a fact rather than an assumption:
       * `fetchProjectContribution` REFUSES TO NAME an unconfirmed identity at
       * all (project-depth.ts — it folds into the aggregate remainder), so no
       * row can reach `contribution.named` provisional. The `can_drill` above
       * already carries the SERVER's whole admission decision for this frame,
       * provisional conjunct included; this restates the same fact so the call
       * cannot be read as relying on a default.
       */
      isProvisional: false,
    },
    reportsFrame.value,
  )
}

const reportsMixTotalUsd = computed(() =>
  (reportsData.value?.mix.by_model ?? []).reduce((a, m) => a + Number(m.cost_usd), 0),
)
/** The SAME reason-typed panel rows the member depth builds — one shape, one panel. */
const reportsPanelRows = computed<DriverRow[] | null>(() => {
  if (!reportsData.value) return null
  return reportsData.value.mix.by_model.map((m) => ({
    key: m.key,
    label: modelBucketKind(m.key) === 'model' ? modelDisplay(m.key).label : m.label,
    usd: Number(m.cost_usd),
    sharePct: reportsMixTotalUsd.value > 0 ? Number(m.cost_usd) / reportsMixTotalUsd.value : 0,
    spendClass: 'indicative' as const,
    ...(m.gap_reason ? { gap_reason: m.gap_reason as DriverRow['gap_reason'] } : {}),
  }))
})
/** Bar scale for the contribution rows: the largest row, remainder included. */
const reportsBarMax = computed(() => {
  const c = reportsData.value?.contribution
  if (!c) return 0
  return Math.max(0, ...c.named.map((r) => Number(r.cost_usd)), Number(c.remainder.cost_usd))
})
function reportsBarWidth(usd: number): string {
  return reportsBarMax.value > 0 ? `${Math.min(100, (usd / reportsBarMax.value) * 100).toFixed(1)}%` : '0%'
}
const reportsWindowWord = computed(() => {
  const w = reportsPayload.value?.window
  if (!w) return ''
  return w.is_month && w.month ? monthWordOf(w.month) : `${w.from} → ${w.to}`
})

const reportsPace = computed(() => {
  const d = reportsData.value
  if (!d?.window.is_month) return null
  return budgetPace(
    Number(d.budget.window_cost_usd),
    Number(d.budget.allocation_usd),
    d.window.days_elapsed,
    d.window.days_in_window,
  )
})

// ── The window, in words ────────────────────────────────────────────────────
/*
 * `todayIso` was `new Date().toISOString().slice(0,10)` — a BROWSER clock
 * deciding whether this page says "this month" or "in this window", and marking
 * the partial bar on the burn chart. For ~10 hours a day in APAC the browser's
 * day and the server's UTC day are different days, so the page could print "in
 * this window" over the current month (clock-rot-audit.md §B, HIGH). It now
 * reads the server's clock (F1/D3). Null until it lands — see useServerClock.
 */
const { clock: serverClock } = useServerClock()
const todayIso = computed<string | null>(() => serverClock.value?.today ?? null)
function monthWordOf(month: string): string {
  return new Intl.DateTimeFormat('en-US', { month: 'long', year: 'numeric', timeZone: 'UTC' }).format(
    new Date(Date.parse(`${month}-01T00:00:00Z`)),
  )
}
const windowWord = computed(() => {
  const w = payload.value?.window
  if (!w) return ''
  return w.is_month ? monthWordOf(w.month!) : `${w.from} → ${w.to}`
})
const windowNoun = computed(() => {
  const w = data.value?.window
  const t = todayIso.value
  if (!w || !t) return 'this window'
  if (w.is_month && w.month === t.slice(0, 7)) return 'this month'
  return 'in this window'
})
const monthEndLabel = computed(() => {
  const w = data.value?.window
  if (!w) return 'month end'
  return new Intl.DateTimeFormat('en-US', { month: 'short', day: 'numeric', timeZone: 'UTC' }).format(
    new Date(Date.parse(`${w.to}T00:00:00Z`)),
  )
})

// ── ONE pace vocabulary (D15/fix 4), re-derived from the page window ────────
const spendUsd = computed(() => Number(data.value?.budget.window_cost_usd ?? 0))
const allocationUsd = computed(() => Number(data.value?.budget.allocation_usd ?? 0))
const pace = computed(() => {
  const w = data.value?.window
  if (!w?.is_month) return null // budgets are monthly — no pace over a range
  return budgetPace(spendUsd.value, allocationUsd.value, w.days_elapsed, w.days_in_window)
})
// The on-pace line is a FORECAST: nothing below the day floor, nothing once
// the window is complete (a "projection" equal to the actual projects nothing).
const projectedUsd = computed(() => {
  const w = data.value?.window
  if (!w?.is_month || !(allocationUsd.value > 0)) return null
  if (w.days_elapsed >= w.days_in_window) return null
  return projectedMonthEnd(spendUsd.value, w.days_elapsed, w.days_in_window)
})
const usedPct = computed(() =>
  allocationUsd.value > 0 ? Math.round((spendUsd.value / allocationUsd.value) * 100) : null,
)
const leadSub = computed(() => {
  const w = data.value?.window
  if (!w) return undefined
  if (!(allocationUsd.value > 0)) return 'no budget set'
  if (!w.is_month) return `of ${fmtUsd(allocationUsd.value)}/month — no pace for a custom range`
  return `${usedPct.value}% of ${fmtUsd(allocationUsd.value)}`
})

// ── Hero tile operands ──────────────────────────────────────────────────────
const elapsedDays = computed(() => Math.max(1, data.value?.window.days_elapsed ?? 1))
const burnPerDay = computed(() => spendUsd.value / elapsedDays.value)

/*
 * Per-day totals (Σ over models) behind the hero sparkline, from the SAME rows
 * the burn stack draws.
 *
 * ZERO-FILLED TO THE SETTLED EDGE, NOT TO `days_elapsed` (F1, external review).
 * `days_elapsed` counts days BEGUN, so it included today — a day the server has
 * not finished measuring — and `?? 0` then fabricated a measured zero for it.
 * Drawn, that is the morning dip: a line falling to the baseline every UTC
 * morning on a project that is spending normally. NULL is not 0.
 *
 * A settled day with no rows is a real zero and is still filled. Today is
 * admitted only when it CARRIES a row, and the flag says so, so the hollow
 * "still accruing" endpoint is never put on a finished day. A PAST month clamps
 * to its own `to` and is therefore complete, with a solid endpoint.
 *
 * THE EDGE COMES FROM THIS PAYLOAD, NOT FROM `/clock` (external review r2). The
 * burn chart below was moved onto `burn.settled_to`/`burn.to` for exactly this
 * reason and this computed was left reading `useServerClock` — a SECOND request
 * with its own instant. Two round trips straddling a UTC midnight resolve two
 * different days, and the spark would then admit (or drop) a day relative to a
 * `series_by_model` cut under the other one. `burn.settled_to` IS
 * `clock.settledThrough` and `burn.to` IS `clock.today`, both taken at the
 * instant this payload's series were cut — the same operands, from the response
 * they describe.
 */
const dailyTotals = computed<{ data: number[]; partial: boolean }>(() => {
  const w = data.value?.window
  const burn = data.value?.burn
  if (!w || !burn) return { data: [], partial: false }
  const byDay = new Map<string, number>()
  for (const r of data.value?.series_by_model ?? []) {
    byDay.set(r.day, (byDay.get(r.day) ?? 0) + Number(r.cost_usd))
  }
  const start = Date.parse(`${w.from}T00:00:00Z`)
  // The window's own right edge, or the settled edge — whichever comes first.
  const edge = burn.settled_to < w.to ? burn.settled_to : w.to
  const settledCount = Math.min(
    w.days_elapsed,
    Math.floor((Date.parse(`${edge}T00:00:00Z`) - start) / 86_400_000) + 1,
  )
  const series = Array.from({ length: Math.max(0, settledCount) }, (_, i) => {
    const day = new Date(start + i * 86_400_000).toISOString().slice(0, 10)
    return byDay.get(day) ?? 0
  })
  const todayUsd = burn.to > edge && burn.to <= w.to ? byDay.get(burn.to) : undefined
  if (todayUsd === undefined) return { data: series, partial: false }
  return { data: [...series, todayUsd], partial: true }
})

/*
 * The spark's frame is the WHOLE month (F2/D7): `dailyTotals` is the elapsed
 * days as a line, and the rest of the month draws as baseline dots. The span is
 * the SERVER's window echo — a custom range has no month ahead, so no dots.
 */
const sparkSpan = computed(() =>
  data.value?.window.is_month ? data.value.window.days_in_window : undefined,
)

/** A tile's delta legs from a % operand (money keeps percentage). */
function moneyDelta(pct: number | null | undefined) {
  const reason = data.value?.hero.deltas.empty_reason
  if (pct == null) {
    return { label: undefined, trend: undefined, empty: reason ?? 'too early to compare' }
  }
  return {
    label: fmtPct(Math.abs(pct)),
    trend: pct === 0 ? ('flat' as const) : pct > 0 ? ('up' as const) : ('down' as const),
    empty: undefined,
  }
}
const spendDelta = computed(() => moneyDelta(data.value?.hero.deltas.spend_pct))
/*
 * BURN/DAY CARRIES NO DELTA, AND SAYS WHY (F2/D11).
 *
 * Burn/day is spend ÷ elapsed days, and the month-on-month divides by the same
 * day count on both sides, so `burn_pct` is `spend_pct` to four decimal places —
 * the tile above already carries it. Two tiles showing "↑ 563%" is how a reader
 * learns to stop reading the second one.
 *
 * The prototype drew a DIFFERENT 6% here, which implies the other base the snag
 * offered: this month's burn/day against last month's WHOLE-month burn/day. The
 * payload carries no such operand — `hero.deltas.burn_pct` is same-elapsed on
 * both sides — so the honest tile withholds and names the reason, which fix 2
 * explicitly permits ("a named reason when the delta is withheld"). Taking the
 * other base is a server change, not a presentation one, and this slice is a fix.
 */
const BURN_DELTA_WITHHELD = 'same change as spend — the day counts cancel'
const untaggedDelta = computed(() => moneyDelta(data.value?.hero.deltas.untagged_pct))
// A COUNT delta is absolute ("↑2", not "↑13% of a headcount").
const membersDelta = computed(() => {
  const d = data.value?.hero.deltas.active_members_abs
  const reason = data.value?.hero.deltas.empty_reason
  if (d == null) return { label: undefined, trend: undefined, empty: reason ?? 'too early to compare' }
  if (d === 0) return { label: 'no change', trend: 'flat' as const, empty: undefined }
  return { label: String(Math.abs(d)), trend: d > 0 ? ('up' as const) : ('down' as const), empty: undefined }
})

/*
 * ── Daily burn: the card's OWN trailing window (D28, restored) ───────────────
 *
 * #237 folded this chart onto the page window. The owner restored the 30/90
 * toggle (R5) because a month-to-date burn chart is ONE COLUMN on the 1st, and
 * because a trailing window reaching back into the previous month is the only
 * thing on this page that still reads then.
 *
 * The second window is legitimate because it is DISCLOSED: the same segmented
 * control and the same (i) sentence as `/usage`'s Daily spend, verbatim. Nothing
 * else on this page moves — the hero, Top models and the team table all
 * decompose the page window.
 *
 * The AXIS is the same idiom the prototype and `/usage` both draw: N settled
 * days ending at the settled edge, with the still-filling day beyond it, faded.
 * Both marks are re-derived from THIS payload's own `burn.to` (see below), so
 * the footer's window and the chart's window cannot diverge.
 */
/*
 * A PREFERRED ORDER, NOT THE KEY SET (external review). This is the PAGE-window
 * model mix; the series below is the burn card's own TRAILING window. A model
 * that ran inside the trailing window but not inside the page window is absent
 * here — which used to mean `StackedBars` dropped its spend without a mark.
 * `StackedBars` now appends any unnamed key it is given, so this list ranks the
 * bands and can no longer decide which money exists.
 */
const modelKeyOrder = computed(() => data.value?.mix.by_model.map((m) => m.label) ?? [])
/*
 * The stack's reason-typed keys (F2/D13). `completeProjectModelSeries` folds on
 * `modelDriverLabel`, so a NULL-model row lands under its REASON's label —
 * "Copilot day-grain money" — beside real model names. It is money the provider
 * reports with no model, not a model, so it keeps its band in the bars and
 * leaves the model legend for the coverage footer. `modelBucketKind` is the same
 * classifier ModelSplitPanel splits on, so the two cards cannot disagree about
 * what is a model.
 */
const burnRemainderKeys = computed(() =>
  (data.value?.mix.by_model ?? [])
    .filter((m) => modelBucketKind(m.key) !== 'model')
    .map((m) => m.label),
)
const stackedRows = computed(() =>
  (data.value?.burn?.series_by_model ?? []).map((r) => ({
    day: r.day,
    key: r.model,
    value: Number(r.cost_usd),
  })),
)
/*
 * THE AXIS COMES FROM THE SERIES' OWN PAYLOAD, NOT FROM `/clock` (external
 * review). The comment above claimed "the server resolved those same bounds
 * (`burn.from` … `burn.to`), so the footer's window and the chart's window
 * cannot diverge" — while the code read neither, taking the edge from
 * `useServerClock`, a SECOND request with its own instant. Two round trips
 * straddling a UTC midnight resolve two different days, and the axis then labels
 * a window one day off the series drawn on it, silently.
 *
 * `burn.to` IS `clock.today` at the instant the series was cut, and
 * `settledThrough` is `today − 1` BY CONSTRUCTION (`resolveServerClock`), so
 * both marks below are exact re-derivations of the server's own bounds:
 * `[burn.to − window_days, burn.to − 1]` settled, `burn.to` partial. The
 * server's `burn.from` is that same left edge, which is the invariant
 * `project-restorations.test.ts` pins.
 */
const burnBlock = computed(() => data.value?.burn ?? null)
/**
 * The axis edge: the last SETTLED day (F1/D2). Never `today` — today is filling.
 * `settled_to` is the SERVER's own operand for it, so the client no longer
 * derives the edge at all: not from `/clock`, not by stepping back from `to`.
 */
const stackEndDay = computed<string | null>(() => burnBlock.value?.settled_to ?? null)
const stackWindowDays = computed(() => burnBlock.value?.window_days ?? burnWindowDays.value)
// Today is drawn faded while it is still accruing (prototype :691) — beyond the
// settled edge, and only when the series actually carries it (StackedBars owns
// that admission, so an empty partial day is silence rather than a zero bar).
const partialDay = computed<string | null>(() => burnBlock.value?.to ?? null)
/*
 * D27 — advisory (telemetry-only) spend, over THIS CARD'S window.
 *
 * It returns as a chart footer, the register `/usage` already uses for it, not
 * as a hero-tile sub-line: on a tile it would be a sentence about a trailing
 * period sitting under a month-windowed figure, with nothing saying which of the
 * two it means. A measured zero renders NOTHING — "$0.00 is advisory" is a
 * sentence nobody needs.
 */
/*
 * NULL AND ZERO ARE DIFFERENT ANSWERS, and the footer now says which (r6).
 *
 * `advisory_cost_usd` is `null` when the aggregate holds no row for this scope
 * and window — an un-materialised or lagging rollup, not a measurement of zero.
 * This read was `Number(… ?? 0)`, which flattened the two into one silent "draw
 * nothing", so an outage looked exactly like a project with no telemetry-only
 * spend. A real 0.00 still renders nothing (asserting "$0.00 advisory" would be
 * the mirror defect); an ABSENT figure says it is absent.
 */
const burnAdvisoryUsd = computed<number | null>(() => {
  const raw = burnBlock.value?.advisory_cost_usd
  return raw == null ? null : Number(raw)
})
const burnAdvisoryUnavailable = computed(
  () => burnBlock.value != null && burnBlock.value.advisory_cost_usd == null,
)
/*
 * A PARTIALLY MATERIALISED ROLLUP IS NOT A WINDOW TOTAL (external review r2).
 *
 * The absent/zero fix above only caught TOTAL absence: a window the rollup had
 * covered for 12 of its 30 days still printed "$X of the last 30d is advisory",
 * a complete-looking sentence about an incomplete sum. The server counts the
 * days that provably were not covered (ledger spend, no aggregate row — see
 * `advisory_uncovered_days`); when there are any, the line drops the window
 * claim and says what is missing instead of restating a period it does not
 * cover. No estimate is offered for the gap, because none exists.
 */
const burnAdvisoryUncoveredDays = computed(
  () => burnBlock.value?.advisory_uncovered_days ?? 0,
)
/*
 * The advisory figure sums over a DIFFERENT population than the chart above it
 * — `attribution_aggregate` has no identity dimension, so it spans provisional
 * identities and applies none of arm 1's exclusions. The server names the basis
 * rather than letting adjacency imply the two agree; the footer states it.
 */
const ADVISORY_BASIS_NOTE: Record<string, string> = {
  'otel-aggregate-all-identities':
    'Counted from the telemetry rollup, which has no identity axis — so it spans every identity on this project, including provisional ones, and is not a subset of the bars above.',
}
const burnAdvisoryNote = computed(() =>
  burnBlock.value ? (ADVISORY_BASIS_NOTE[burnBlock.value.advisory_basis] ?? null) : null,
)

// ── Top models (fix 3): ModelSplitPanel over the reason-typed mix ───────────
const mixTotalUsd = computed(() =>
  (data.value?.mix.by_model ?? []).reduce((a, m) => a + Number(m.cost_usd), 0),
)
const panelRows = computed<DriverRow[] | null>(() => {
  if (!data.value) return null
  return data.value.mix.by_model.map((m) => ({
    key: m.key,
    label: modelBucketKind(m.key) === 'model' ? modelDisplay(m.key).label : m.label,
    usd: Number(m.cost_usd),
    sharePct: mixTotalUsd.value > 0 ? Number(m.cost_usd) / mixTotalUsd.value : 0,
    spendClass: 'indicative' as const,
    ...(m.gap_reason ? { gap_reason: m.gap_reason as DriverRow['gap_reason'] } : {}),
  }))
})

// ── Activity mix strip (D27.4: information kept, donut idiom gone) ──────────
const activityTotalUsd = computed(() =>
  (data.value?.mix.by_activity ?? []).reduce((a, s) => a + Number(s.cost_usd), 0),
)
const activitySegments = computed(() =>
  (data.value?.mix.by_activity ?? []).map((s, i) => ({
    label: s.activity ?? 'untagged',
    usd: Number(s.cost_usd),
    pct: activityTotalUsd.value > 0 ? Number(s.cost_usd) / activityTotalUsd.value : 0,
    color: seriesColor(i),
  })),
)

// ── Team table ──────────────────────────────────────────────────────────────
const teamTotalUsd = computed(() =>
  (data.value?.team.members ?? []).reduce((a, m) => a + Number(m.cost_usd), 0),
)
function memberSharePct(m: MemberContribution): number {
  return teamTotalUsd.value > 0 ? Math.round((Number(m.cost_usd) / teamTotalUsd.value) * 100) : 0
}
const concentrationPct = computed(() => {
  const c = data.value?.team.concentration_top2_share
  return c == null ? null : Math.round(c * 100)
})
const exportFilename = computed(() => {
  const w = payload.value?.window
  const stamp = w?.is_month ? w.month : w ? `${w.from}_${w.to}` : (todayIso.value?.slice(0, 7) ?? 'window')
  const lens = echoedLane.value === 'chargeback' ? '-chargeback' : ''
  return `tokenscope-project-${code.value}-team${lens}-${stamp}.csv`
})

// Rollup honesty for the (i): the velocity flag is the ONE cron-fed figure
// left on this page.
const aggregateAge = computed(() => {
  const m = data.value?.page_freshness.aggregate_minutes_ago
  if (m == null) return null
  if (m < 60) return `${Math.round(m)} min`
  if (m < 60 * 48) return `${Math.round(m / 60)} h`
  return `${Math.round(m / 1440)} d`
})

const reconciledUsd = computed(() => Number(data.value?.lane_coverage.reconciled_usd ?? 0))
const provisionalWithheldUsd = computed(() =>
  Number(data.value?.lane_coverage.provisional_withheld_usd ?? 0),
)
const memberIngestOnlyUsd = computed(() =>
  Number(data.value?.lane_coverage.member_ingest_only_usd ?? 0),
)
const memberIngestOnlyTools = computed(
  () => data.value?.lane_coverage.member_ingest_only_tools ?? [],
)
</script>

<template>
  <div v-if="session" class="max-w-[1400px] mx-auto px-10 py-8 pb-20" data-testid="project-dashboard">
    <template v-if="payload">
      <UiPageHead
        eyebrow="My projects"
        :title="payload.project.display_name ?? payload.project.code"
        :sub="`${payload.project.code} · ${payload.project.type}${payload.project.wbs_code ? ` · WBS ${payload.project.wbs_code}` : ''}${payload.project.ended ? ' · ended' : payload.project.end_date ? ` · ends ${payload.project.end_date.slice(0, 10)}` : ''}`"
        :crumbs="['My projects', payload.project.code]"
      >
        <template #actions>
          <UiBadge v-if="data?.velocity.is_flagged" kind="rag-amber" data-testid="velocity-flag">
            velocity {{ Math.round((data.velocity.delta_pct ?? 0) * 100) }}% above 4-week mean
          </UiBadge>
        </template>
      </UiPageHead>

      <div class="space-y-5">
        <!-- Window presets (D16) — the page's ONE window control — and the lens. -->
        <div class="flex items-start gap-3 flex-wrap">
          <DateRangeControl />
          <LaneToggle v-model="shownLane" :captions="PROJECT_LENS_CAPTIONS" />
        </div>

        <!-- The lens once with (i) (fix 6) + the chip row (D14) instead of freshness prose. -->
        <div v-if="data" class="flex items-center gap-2 flex-wrap">
          <UiBadge kind="neutral" data-testid="proj-lane-pill">§A · attributed usage</UiBadge>
          <InfoDot label="About this page's lane">
            Attributed usage (§A). Every figure follows the selected window and is live off the
            §A lane; the velocity flag alone comes from the cron-refreshed
            rollup<template v-if="aggregateAge">, last refreshed {{ aggregateAge }} ago</template>.
            Switch to Chargeback for this project's share of the bill.
          </InfoDot>
          <CcHeaderNotes
            :provider-states="data.providerStates"
            :coverage="data.coverage"
            lane="usage"
          />
        </div>
        <div v-else class="flex items-center gap-2 flex-wrap">
          <UiBadge kind="neutral" data-testid="proj-lane-pill">§B · bill chargeback</UiBadge>
          <InfoDot label="About this page's lane">
            {{ PROJECT_LENS_COPY.chargeback.caption }} Budgets and allocations still read
            attributed usage.
          </InfoDot>
        </div>

        <ProjectChargebackView
          v-if="cbData"
          :block="cbData.chargeback"
          :window="cbData.window"
          :window-word="windowWord"
        >
          <template #actions>
            <ExportCsvButton
              v-if="cbData.viewer.access === 'member'"
              :endpoint="`/api/v1/me/projects/${encodeURIComponent(code)}/team/export`"
              :params="windowQuery"
              :filename="exportFilename"
            />
          </template>
        </ProjectChargebackView>

        <template v-if="data">
        <!-- Headline band + hero tiles (fix 2). -->
        <section data-testid="project-hero-band">
          <div class="flex items-baseline gap-3 flex-wrap border-b border-calm-2 pb-3 mb-4">
            <span class="text-[17px] font-extrabold text-carbon">{{ windowWord }}</span>
            <span
              class="text-[22px] font-extrabold text-carbon tracking-[-0.02em]"
              style="font-variant-numeric: tabular-nums"
              data-testid="project-hero-total"
            >{{ fmtUsd(data.budget.window_cost_usd) }}</span>
            <span class="text-[12.5px] text-carbon-2">
              {{ PROJECT_LENS_COPY.usage.basis }}<template v-if="data.window.is_month">
                · day {{ data.window.days_elapsed }} of {{ data.window.days_in_window }}</template>
            </span>
          </div>

          <div class="kpi-row">
            <ScopeKpiTile
              label="Spend vs budget"
              :value="fmtUsd(data.budget.window_cost_usd)"
              :sub="leadSub"
              :note="projectedUsd != null ? `on pace for ~${fmtUsd(projectedUsd)} by ${monthEndLabel}` : undefined"
              :delta-label="spendDelta.label"
              :delta-trend="spendDelta.trend"
              :delta-basis="spendDelta.label ? data.hero.deltas.basis : undefined"
              :delta-empty="spendDelta.empty"
              :spark="dailyTotals.data"
              :spark-span="sparkSpan"
              :spark-partial="dailyTotals.partial"
              emphasis
              data-testid="tile-spend-vs-budget"
            >
              <!-- The pace pill sits IN the sub line (D10), against the budget
                   sentence it qualifies — not up beside the tile's label, four
                   lines from the thing it is about. -->
              <template #sub-badge>
                <UiBadge v-if="pace" :kind="budgetPaceKind(pace)" data-testid="proj-pace-pill">
                  {{ budgetPaceLabel(pace) }}
                </UiBadge>
              </template>
              <template #footer>
                <!--
                  The lead-tile honesty notes (D27.2 — moved from the retired
                  budget band, not deleted). `reconciled` is the share that
                  reaches us through provider reconciliation rather than
                  emitted telemetry; its measured model split appears in the
                  Top-models rows below.
                -->
                <p
                  v-if="reconciledUsd > 0"
                  class="text-[11px] text-carbon-3"
                  data-testid="proj-reconciled-share"
                  title="Reconciled from provider usage rather than emitted telemetry. Counted in full; its measured model split is in the model rows."
                >
                  incl. {{ fmtUsd(data.lane_coverage.reconciled_usd) }} reconciled from provider usage
                </p>
                <p
                  v-if="provisionalWithheldUsd > 0"
                  class="text-[11px] text-carbon-3"
                  data-testid="proj-provisional-withheld"
                >
                  {{ fmtUsd(data.lane_coverage.provisional_withheld_usd) }} held back — device
                  bindings not yet confirmed, so it can't be pinned to a person here.
                </p>
              </template>
            </ScopeKpiTile>

            <ScopeKpiTile
              label="Burn / day"
              :value="fmtUsd(burnPerDay)"
              :sub="`mean over ${data.window.days_elapsed} elapsed day${data.window.days_elapsed === 1 ? '' : 's'}`"
              :delta-empty="BURN_DELTA_WITHHELD"
              :spark="dailyTotals.data"
              :spark-span="sparkSpan"
              :spark-partial="dailyTotals.partial"
              data-testid="tile-burn-per-day"
            />

            <ScopeKpiTile
              label="Active members"
              :value="String(data.hero.active_members)"
              :sub="`of ${data.hero.assigned_members} members emitted ${windowNoun}`"
              :delta-label="membersDelta.label"
              :delta-trend="membersDelta.trend"
              :delta-basis="membersDelta.label && membersDelta.label !== 'no change' ? data.hero.deltas.basis : undefined"
              :delta-empty="membersDelta.empty"
              data-testid="tile-active-members"
            />

            <ScopeKpiTile
              label="Untagged pressure"
              :value="fmtUsd(data.untagged_pressure.cost_usd)"
              :sub="`${data.untagged_pressure.conversations} session${data.untagged_pressure.conversations === 1 ? '' : 's'} by members may belong here`"
              :delta-label="untaggedDelta.label"
              :delta-trend="untaggedDelta.trend"
              :delta-basis="untaggedDelta.label ? data.hero.deltas.basis : undefined"
              :delta-empty="untaggedDelta.empty"
              data-testid="tile-untagged-pressure"
            />
          </div>
        </section>

        <!-- Daily burn — its OWN trailing 30/90 window (D28), disclosed exactly
             as /usage discloses its; advisory footer restored (D27). -->
        <UiCard data-testid="burn-card">
          <div class="flex items-center justify-between mb-2">
            <UiEyebrow>
              Daily burn · stacked by model · trailing {{ stackWindowDays }}d
              <InfoDot label="About the daily burn window">
                Rolls with the days — independent of the month presets above.
              </InfoDot>
            </UiEyebrow>
            <UsageWindowToggle v-model="burnWindowDays" />
          </div>
          <ChartsStackedBars
            v-if="stackEndDay"
            :rows="stackedRows"
            :key-order="modelKeyOrder"
            :label-for="(k) => modelDisplay(k).label"
            :window-days="stackWindowDays"
            :end-day="stackEndDay"
            :partial-day="partialDay"
            :remainder-keys="burnRemainderKeys"
            :height="150"
          />
          <p
            v-if="burnAdvisoryUsd != null && burnAdvisoryUsd > 0"
            class="text-[10px] text-carbon-3 mt-1 text-right"
            data-testid="burn-advisory"
            :title="burnAdvisoryNote ?? undefined"
          >
            <template v-if="burnAdvisoryUncoveredDays > 0">
              {{ fmtUsd(burnAdvisoryUsd) }} of advisory (telemetry-only) spend counted — NOT the
              last {{ stackWindowDays }}d: the rollup has no row for
              {{ burnAdvisoryUncoveredDays }} spending
              {{ burnAdvisoryUncoveredDays === 1 ? 'day' : 'days' }} in this window
            </template>
            <template v-else>
              {{ fmtUsd(burnAdvisoryUsd) }} of the last {{ stackWindowDays }}d is advisory
              (telemetry-only) spend
            </template>
          </p>
          <!-- NOT MEASURED ≠ MEASURED ZERO. A missing rollup used to render as
               silence, indistinguishable from "no advisory spend here". -->
          <p
            v-else-if="burnAdvisoryUnavailable"
            class="text-[10px] text-carbon-3 italic mt-1 text-right"
            data-testid="burn-advisory-unavailable"
          >
            Advisory (telemetry-only) spend isn't available for this window — the rollup has
            no row for it yet. Not zero: unmeasured.
          </p>
        </UiCard>

        <!-- Top models (fix 3): ranked bars + reason-typed coverage footer, no donut. -->
        <UiCard data-testid="proj-top-models">
          <div class="flex items-center justify-between mb-1">
            <UiEyebrow>Top models</UiEyebrow>
            <span class="text-[11px] text-carbon-3">ranked by attributed cost · this window</span>
          </div>
          <ModelSplitPanel :rows="panelRows" :denominator-usd="mixTotalUsd" :top-n="10" />
        </UiCard>

        <!-- Activity mix strip (D27.4): the donut's information, a strip's idiom. -->
        <UiCard v-if="activitySegments.length" data-testid="proj-activity-strip">
          <UiEyebrow>Activity mix</UiEyebrow>
          <div class="flex h-[14px] rounded overflow-hidden bg-calm-2 mt-3" aria-hidden="true">
            <span
              v-for="s in activitySegments"
              :key="s.label"
              class="block h-full"
              :style="{ width: `${(s.pct * 100).toFixed(1)}%`, background: s.color }"
              :title="`${s.label} — ${fmtUsd(s.usd)}`"
            />
          </div>
          <div class="flex flex-wrap gap-x-4 gap-y-1 mt-2">
            <span
              v-for="s in activitySegments"
              :key="s.label"
              class="inline-flex items-center gap-1.5 text-[11px] text-carbon-2"
              :data-testid="`activity-seg-${s.label}`"
            >
              <span class="inline-block w-2 h-2 rounded-sm" :style="{ background: s.color }" aria-hidden="true" />
              {{ s.label }} · {{ fmtUsd(s.usd) }} · {{ Math.round(s.pct * 100) }}%
            </span>
          </div>
        </UiCard>

        <!-- Team contribution + share bars + Export CSV (fix 10). -->
        <UiCard data-testid="team-card">
          <div class="flex items-center justify-between mb-1 gap-3">
            <UiEyebrow>Team contribution ({{ windowWord }})</UiEyebrow>
            <div class="flex items-center gap-3">
              <span v-if="concentrationPct != null && data.team.members.length > 2" class="text-[11px] text-carbon-3">
                top 2 contributors = {{ concentrationPct }}% of spend
              </span>
              <ExportCsvButton
                v-if="data.viewer.access === 'member'"
                :endpoint="`/api/v1/me/projects/${encodeURIComponent(code)}/team/export`"
                :params="windowQuery"
                :filename="exportFilename"
              />
            </div>
          </div>
          <p class="text-[11px] text-carbon-3 mb-3">
            Contribution only
            <InfoDot label="About the team table">
              Contribution only — usage-pattern insights stay on each member's own My usage page.
            </InfoDot>
          </p>
          <div class="overflow-x-auto">
            <table class="w-full text-sm">
              <thead class="text-[11px] text-carbon-3 uppercase tracking-[1.2px]">
                <tr>
                  <th class="text-left font-bold py-2 pr-4">Member</th>
                  <th class="text-right font-bold py-2 px-4">Cost</th>
                  <th class="text-right font-bold py-2 px-4">Tokens</th>
                  <th class="text-right font-bold py-2 px-4">Active days</th>
                  <th class="text-right font-bold py-2 px-4">$/active day</th>
                  <th class="text-right font-bold py-2 px-4">Share</th>
                  <th class="text-right font-bold py-2 pl-4">Last activity</th>
                </tr>
              </thead>
              <tbody class="divide-y divide-calm-2">
                <tr v-for="m in data.team.members" :key="m.teammate_id" :data-testid="`member-${m.email}`">
                  <td class="py-2 pr-4 text-carbon">{{ m.display_name ?? m.email }}</td>
                  <td class="py-2 px-4 text-right font-bold text-carbon" style="font-variant-numeric: tabular-nums">{{ fmtUsd(m.cost_usd) }}</td>
                  <td class="py-2 px-4 text-right text-carbon-2" style="font-variant-numeric: tabular-nums">{{ fmtTokens(m.tokens) }}</td>
                  <td class="py-2 px-4 text-right text-carbon-2">{{ m.active_days }}</td>
                  <td class="py-2 px-4 text-right text-carbon-2" style="font-variant-numeric: tabular-nums">{{ fmtUsd(m.cost_per_active_day) }}</td>
                  <td class="py-2 px-4 text-right text-carbon-2" style="font-variant-numeric: tabular-nums" :data-testid="`member-share-${m.email}`">
                    {{ memberSharePct(m) }}%
                    <span class="inline-block w-[58px] h-[9px] rounded bg-calm-2 overflow-hidden align-middle ml-2" aria-hidden="true">
                      <span
                        class="block h-full bg-brand-harmony"
                        :style="{ width: `${Math.min(memberSharePct(m), 100)}%` }"
                      />
                    </span>
                  </td>
                  <td class="py-2 pl-4 text-right text-carbon-3 text-[12px]">{{ fmtTimeAgo(m.last_event) }}</td>
                </tr>
              </tbody>
            </table>
          </div>
          <p
            v-if="!data.team.members.length && data.viewer.access === 'cou-owner'"
            class="text-sm text-carbon-3 italic py-4"
            data-testid="team-owner-aggregate-note"
          >
            {{ data.team.member_count }} member{{ data.team.member_count === 1 ? '' : 's' }} —
            the per-person breakdown is visible to the project team, not observers.
          </p>
          <p v-else-if="!data.team.members.length" class="text-sm text-carbon-3 italic py-4">No spend in this window yet.</p>
        </UiCard>

        <!--
          Not on any project budget — and never can be. Arm 3 of the usage lane
          (mig 0101) carries no project_id BY CONSTRUCTION. Kept as built
          (D27.6): an honesty device, no ruling touches it.
        -->
        <UiCard v-if="memberIngestOnlyUsd > 0" data-testid="lane-excluded-bucket">
          <UiEyebrow>Not attributable to any project</UiEyebrow>
          <p class="text-sm text-carbon mt-2">
            This project's members also consumed
            <strong>{{ fmtUsd(data.lane_coverage.member_ingest_only_usd) }}</strong>
            {{ windowNoun }} on surfaces that carry no project tag<template v-if="memberIngestOnlyTools.length">
              ({{ memberIngestOnlyTools.join(', ') }})</template>.
          </p>
          <p class="text-[11px] text-carbon-3 mt-1">
            Real spend, counted in company and cost-centre totals — but it is untaggable at
            source, so no project budget on any view includes it. It is not missing, and it is
            not zero.
          </p>
          <p class="text-[11px] text-carbon-3 mt-1" data-testid="lane-excluded-non-additive">
            This is each member's own total, not this project's share — the same spend appears
            in full on every project they're on, so don't add it up across projects.
          </p>
        </UiCard>

        <!-- Untagged pressure — kept as built (D27.6). -->
        <UiCard v-if="data.untagged_pressure.conversations > 0" accent="zeal" data-testid="untagged-pressure">
          <UiEyebrow>
            Untagged pressure
            <InfoDot label="About untagged pressure">
              Members' unallocated sessions that may belong here — everyone re-tags their own
              from their worklist. Nudge, don't chase.
            </InfoDot>
          </UiEyebrow>
          <p class="text-sm text-carbon mt-2">
            Team members have <strong>{{ data.untagged_pressure.conversations }}</strong> unallocated
            conversation{{ data.untagged_pressure.conversations === 1 ? '' : 's' }}
            ({{ fmtUsd(data.untagged_pressure.cost_usd) }}) {{ windowNoun }} that may belong here.
          </p>
          <p class="text-[11px] text-carbon-3 mt-1">
            A nudge in standup beats a chase: everyone can re-tag their own sessions from the dashboard.
          </p>
        </UiCard>

        <!-- PM depth does not fork (D27.7): the budget affordance is the ONLY extra. -->
        <UiCard v-if="data.viewer.role === 'manager'" data-testid="pm-budget-card">
          <UiEyebrow>Budget</UiEyebrow>
          <p class="text-[11px] text-carbon-3 mt-1 mb-2">
            PM affordance — rides the assignment role, not an org role.
          </p>
          <NuxtLink
            v-if="data.viewer.budget_allocation_id"
            :to="`/allocations/${data.viewer.budget_allocation_id}`"
            class="inline-block text-[12px] font-semibold text-brand-harmony hover:underline"
            data-testid="pm-manage-budget"
          >
            Manage budget →
          </NuxtLink>
          <p
            v-else
            class="text-[11px] text-carbon-3 italic"
            data-testid="pm-no-budget-hint"
            title="Project managers manage top-ups on an existing budget; creating the baseline is a manager/admin action."
          >
            No active budget period — ask your manager or admin to set one.
          </p>
        </UiCard>
        </template>
      </div>
    </template>

    <!-- ── REPORTS DEPTH (D37) ────────────────────────────────────────────
         The viewer is not a member; a reports grant admitted them. Two figures,
         Top models, and their people NAMED with ONE aggregate remainder so the
         rows foot to the project total over ALL members (C3).

         ABSENT here, deliberately (prototype `:766`): the team table, cache
         economics, the activity mix and untagged pressure. Those are the team's
         working surfaces, not an observer's. -->
    <template v-else-if="reportsPayload">
      <nav class="text-[12px] text-carbon-3 mb-2 flex items-center gap-1.5" data-testid="project-reports-crumb">
        <NuxtLink :to="reportsBackRoute" class="hover:text-brand-harmony hover:underline">Reports</NuxtLink>
        <span aria-hidden="true">›</span>
        <span class="text-carbon-1 font-semibold">{{ reportsPayload.project.display_name ?? reportsPayload.project.code }}</span>
      </nav>
      <p
        v-if="reportsPayload.scope?.src"
        class="text-[12px] text-carbon-3 mb-3"
        data-testid="project-reports-provenance"
      >
        from Reports · {{ reportsPayload.scope.src }} · {{ reportsWindowWord }}
        <InfoDot label="What the drill carried">
          The entry scope and window ride the link and this page echoes them, so going back restores
          the report you came from exactly — even after a refresh or on a shared link.
        </InfoDot>
      </p>

      <UiPageHead
        eyebrow="Reports"
        :title="reportsPayload.project.display_name ?? reportsPayload.project.code"
        :sub="`${reportsPayload.project.code} · reports depth — you are not a member; admitted by your reports grant`"
      />

      <div class="space-y-5">
        <div class="flex items-start gap-3 flex-wrap">
          <DateRangeControl />
          <LaneToggle v-model="shownLane" :captions="PROJECT_LENS_CAPTIONS" />
        </div>
        <div v-if="reportsCb" class="flex items-center gap-2 flex-wrap">
          <UiBadge kind="neutral" data-testid="proj-reports-lane-pill">§B · bill chargeback</UiBadge>
          <InfoDot label="About this page's lane">
            {{ PROJECT_LENS_COPY.chargeback.caption }} Budgets and allocations still read
            attributed usage.
          </InfoDot>
        </div>
        <ProjectChargebackView
          v-if="reportsCb"
          :block="reportsCb.chargeback"
          :window="reportsCb.window"
          :window-word="reportsWindowWord"
          :drill-target="contributorTarget"
        />

        <template v-if="reportsData">
        <div class="flex items-center gap-2 flex-wrap">
          <UiBadge kind="neutral" data-testid="proj-reports-lane-pill">§A · attributed usage</UiBadge>
          <InfoDot label="About this page's lane">
            Attributed usage (§A) for the whole project. Switch to Chargeback for its share of
            the bill.
          </InfoDot>
          <CcHeaderNotes
            :provider-states="reportsData.meta.providerStates"
            :coverage="reportsData.meta.coverage ?? undefined"
            :point-in-time-dims="true"
            lane="usage"
          />
        </div>

        <section class="flex items-baseline gap-4 flex-wrap" data-testid="project-reports-band">
          <span class="text-[13px] font-semibold text-carbon-2">{{ reportsWindowWord }}</span>
          <span class="text-[26px] font-bold text-carbon-1 tabular-nums">
            {{ fmtUsd(Number(reportsData.budget.window_cost_usd)) }}
          </span>
          <span class="text-[12px] text-carbon-3">attributed usage · whole project · all members</span>
        </section>

        <div class="grid gap-5 md:grid-cols-2">
          <UiCard data-testid="project-reports-allocation">
            <UiEyebrow>Total vs allocation</UiEyebrow>
            <p class="text-[11px] text-carbon-3 mt-1">
              The budget belongs to the project, so this figure is the one that governs
              review-and-extend.
            </p>
            <p class="text-[13px] text-carbon-2 mt-2 tabular-nums">
              {{ fmtUsd(Number(reportsData.budget.window_cost_usd)) }}
              <template v-if="Number(reportsData.budget.allocation_usd) > 0">
                of {{ fmtUsd(Number(reportsData.budget.allocation_usd)) }}
              </template>
              <template v-else> · no budget set</template>
              <UiBadge
                v-if="reportsPace"
                :kind="budgetPaceKind(reportsPace)"
                class="ml-2 align-middle"
              >{{ budgetPaceLabel(reportsPace) }}</UiBadge>
            </p>
          </UiCard>
          <UiCard data-testid="project-reports-burn">
            <UiEyebrow>Burn / day</UiEyebrow>
            <p class="text-[22px] font-bold text-carbon-1 tabular-nums mt-2">
              {{ fmtUsd(Number(reportsData.budget.burn_per_day_usd)) }}
            </p>
            <p class="text-[11px] text-carbon-3">
              mean over {{ reportsData.window.days_elapsed }} elapsed
              day{{ reportsData.window.days_elapsed === 1 ? '' : 's' }}
            </p>
          </UiCard>
        </div>

        <UiCard data-testid="project-reports-models">
          <UiEyebrow>Top models</UiEyebrow>
          <ModelSplitPanel :rows="reportsPanelRows" :denominator-usd="reportsMixTotalUsd" :top-n="10" />
        </UiCard>

        <UiCard data-testid="project-reports-contribution">
          <UiEyebrow>Your members' contribution</UiEyebrow>
          <p class="text-[11px] text-carbon-3 mt-1">
            Your people named · rest aggregated
            <InfoDot label="Why some rows are aggregated">
              Named where the subject is in your people-scope; everyone else folds into ONE
              remainder row so the table still foots to the project total over ALL members (C3).
            </InfoDot>
          </p>
          <ul class="mt-3 divide-y divide-calm-1">
            <li
              v-for="r in reportsData.contribution.named"
              :key="r.teammate_id"
              class="flex items-center gap-3 py-2"
              data-testid="project-reports-named-row"
            >
              <span class="w-[180px] shrink-0 truncate text-sm">
                <DrillName :target="contributorTarget(r)" :label="r.display_name" />
              </span>
              <span class="flex-1 h-2 rounded-full bg-calm-1 overflow-hidden">
                <span
                  class="block h-full rounded-full bg-brand-harmony"
                  :style="{ width: reportsBarWidth(Number(r.cost_usd)) }"
                />
              </span>
              <span class="w-[90px] text-right tabular-nums text-sm">{{ fmtUsd(Number(r.cost_usd)) }}</span>
            </li>
            <!-- ONE remainder, PLAIN TEXT by construction: it names no target id. -->
            <li
              v-if="reportsData.contribution.remainder.members > 0"
              class="flex items-center gap-3 py-2"
              data-testid="project-reports-remainder"
            >
              <span class="w-[180px] shrink-0 truncate text-sm text-carbon-3">
                {{ reportsData.contribution.remainder.label }}
              </span>
              <span class="flex-1 h-2 rounded-full bg-calm-1 overflow-hidden">
                <span
                  class="block h-full rounded-full bg-calm-2"
                  :style="{ width: reportsBarWidth(Number(reportsData.contribution.remainder.cost_usd)) }"
                />
              </span>
              <span class="w-[90px] text-right tabular-nums text-sm text-carbon-3">
                {{ fmtUsd(Number(reportsData.contribution.remainder.cost_usd)) }}
              </span>
            </li>
          </ul>
          <p class="text-[11px] text-carbon-3 mt-2" data-testid="project-reports-foot">
            Σ = {{ fmtUsd(Number(reportsData.contribution.rows_total_usd)) }}
            <InfoDot label="What this sum is">
              A project headline reconciles over ALL members, never over visible ones (C3).
            </InfoDot>
          </p>
        </UiCard>
        </template>
      </div>
    </template>

    <ReportSkeleton v-else-if="reportsDepthEligible && reportsPending" :kpis="2" :rows="6" />

    <UiEmptyState
      v-else-if="notFound"
      headline="Project not found"
      sub="No project with this code among your current memberships."
    />
    <UiEmptyState
      v-else-if="error"
      headline="Couldn't load this project"
      sub="Something went wrong fetching the dashboard. Refresh to try again."
      data-testid="project-dashboard-error"
    />
    <!-- D13 (fix 12): the pending state is the report skeleton, not prose — the
         same settle() signal parity-shots keys on (skeleton gone + rendered money). -->
    <ReportSkeleton v-else-if="pending" :kpis="4" :rows="6" />
  </div>
</template>
