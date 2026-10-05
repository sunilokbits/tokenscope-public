<script setup lang="ts">
/*
 * My projects (brief §5.6; developer-pages W3 D25/D26) — one card per project
 * the caller is currently a member of, ordered by PACE SEVERITY (the project
 * needing attention first), under a headline band that answers "what did I
 * contribute, across how many projects, how far through the month are we".
 * Project transparency: every current member sees the same card a PM sees.
 *
 * ONE pace vocabulary (D15/fix 4): the pill and the "on pace for ~$X" line are
 * `budgetPace`/`projectedMonthEnd` — the same word set the reports pages use,
 * fact ("Over") vs forecast ("On pace to exceed") split intact. The page-local
 * utilisation/exhaustion copy retired with it (D41).
 *
 * The list stays MTD — custom windows here are a recorded open owner decision
 * (brief :102-104), so there is deliberately NO window control on this page.
 */
import { computed } from 'vue'
import ReportSkeleton from '../../components/reporting/ReportSkeleton.vue'
import InfoDot from '../../components/ui/InfoDot.vue'
import MonthSpark from '../../components/charts/MonthSpark.vue'
import {
  budgetPace,
  budgetPaceKind,
  budgetPaceLabel,
  projectedMonthEnd,
  PACE_MIN_DAYS,
  type BudgetPace,
} from '../../composables/useRagState'
// `#shared`, never a relative path: an app->shared RUNTIME import written
// relatively resolves fine in dev and in vitest, then fails the prod nitro build
// with UNRESOLVED_IMPORT. CI does not run `npm run build`, so this only ever
// surfaces at deploy. `useChartScale.ts` imports this module's sibling the same way.
import { utcDayOfMonth, utcDaysInMonth, utcMonthEnd } from '#shared/reports/clock'
import { denseDays } from '#shared/reports/day-axis'
import type { ProjectCard } from '#shared/schemas/usage'

const { session, ensure } = useSession()
await ensure()

interface ProjectsSummary {
  projects: ProjectCard[]
  total: number
  /** The caller's own taggable-but-untagged MTD spend (D25 pull-through). */
  untagged_usd: string
  page_freshness: {
    /** The STALEST project's rollup age, not the freshest. */
    aggregate_minutes_ago: number | null
    /** Projects with no rollup row at all — age unknown, never "fresh". */
    projects_never_rolled_up: number
    worst_minutes_ago: number | null
  }
}

const { data, pending, error } = await useFetch<ProjectsSummary>(
  '/api/v1/me/projects/summary',
  { lazy: true },
)

/*
 * ── The month clock: the SERVER's, not the browser's (F1/D3) ────────────────
 *
 * This block was `const now = new Date()`, and it is the ONE browser clock in
 * the codebase that reached a money-shaped output: `dayOfMonth` is `paceOf`'s
 * DIVISOR, so every card's "on pace for ~$X" was computed against whichever
 * month the viewer's browser happened to be in. On 1 September at 09:00 Sydney
 * the browser says day 1 while the server's UTC month still has ten hours to
 * run (clock-rot-audit.md §B, HIGH).
 *
 * The derivations below are PURE functions of the server's `today` — no clock is
 * consulted here, only a string the server resolved. `dayOfMonth` is 0 until it
 * lands, which `paceMissing` turns into "too early to project" rather than a
 * fabricated pace: a divisor is not something to guess at.
 */
const { clock: serverClock } = useServerClock()
const todayUtc = computed<string | null>(() => serverClock.value?.today ?? null)
/** The last COMPLETE UTC day — the right edge of anything zero-filled (F1/D2). */
const settledUtc = computed<string | null>(() => serverClock.value?.settledThrough ?? null)
const dayOfMonth = computed(() => (todayUtc.value ? utcDayOfMonth(todayUtc.value) : 0))
const daysInMonth = computed(() => (todayUtc.value ? utcDaysInMonth(todayUtc.value) : 0))
const monthWord = computed(() =>
  todayUtc.value
    ? new Intl.DateTimeFormat('en-US', { month: 'long', year: 'numeric', timeZone: 'UTC' }).format(
        new Date(Date.parse(`${todayUtc.value}T00:00:00Z`)),
      )
    : '',
)
const monthEndLabel = computed(() =>
  todayUtc.value
    ? new Intl.DateTimeFormat('en-US', { month: 'short', day: 'numeric', timeZone: 'UTC' }).format(
        new Date(Date.parse(`${utcMonthEnd(todayUtc.value)}T00:00:00Z`)),
      )
    : '',
)

// ── ONE pace vocabulary per card (D15/D26) ──────────────────────────────────
function paceOf(p: ProjectCard): BudgetPace {
  return budgetPace(
    Number(p.mtd_cost_usd),
    Number(p.allocation_usd),
    dayOfMonth.value,
    daysInMonth.value,
  )
}
/** "$60.00 of $200 · 30% used · on pace for ~$130 by Aug 31" — the card's money line. */
function spendLine(p: ProjectCard): string {
  const spend = Number(p.mtd_cost_usd)
  const alloc = Number(p.allocation_usd)
  if (!(alloc > 0)) return `${fmtUsd(p.mtd_cost_usd)} · no budget set`
  const used = Math.round((spend / alloc) * 100)
  const day = dayOfMonth.value
  const projected = projectedMonthEnd(spend, day, daysInMonth.value)
  const paceLeg =
    day < PACE_MIN_DAYS
      ? ' · too early to project'
      : projected != null && day < daysInMonth.value
        ? ` · on pace for ~${fmtUsd(projected)} by ${monthEndLabel.value}`
        : ''
  return `${fmtUsd(p.mtd_cost_usd)} of ${fmtUsd(alloc)} · ${used}% used${paceLeg}`
}

/*
 * PACE-SEVERITY ordering: the card that needs attention sorts first — the
 * over-budget FACT ahead of the forecast, forecasts ahead of health, the
 * unknowable states last. Ties keep the stable code order.
 */
const PACE_RANK: Record<BudgetPace, number> = {
  'over': 0,
  'pace-over': 1,
  'warning': 2,
  'healthy': 3,
  'too-early': 4,
  'not-started': 5,
  'no-budget': 6,
}
const orderedProjects = computed(() =>
  [...(data.value?.projects ?? [])].sort(
    (a, b) => PACE_RANK[paceOf(a)] - PACE_RANK[paceOf(b)] || a.code.localeCompare(b.code),
  ),
)

// ── The headline band (D25) ─────────────────────────────────────────────────
// Σ of the caller's own contribution — summed FROM the cards' `mine` values,
// so the band and the cards cannot disagree (the identity holds by
// construction, and T20 pins it).
const mineTotal = computed(() =>
  (data.value?.projects ?? []).reduce((a, p) => a + Number(p.mine_mtd_usd), 0),
)
const untaggedUsd = computed(() => Number(data.value?.untagged_usd ?? 0))

// ── Per-card derivations ────────────────────────────────────────────────────
/*
 * The card sparkline's series and its partial flag.
 *
 * ZERO-FILLED THROUGH THE SETTLED EDGE — AND NOT ONE DAY FURTHER (F1, external
 * review). This walked `denseDays(today, dayOfMonth(today))`, so it zero-filled
 * every elapsed day INCLUDING today, a day the server has not finished
 * measuring. At 09:00 UTC that fabricated a `0` endpoint on a day with real
 * spend still landing, and MonthSpark then drew the line down to the baseline:
 * the morning dip F1 exists to remove, rebuilt one layer up. NULL is not 0.
 *
 * A settled day with no rows IS a measured zero and is still filled. Today is
 * admitted only when it CARRIES data — otherwise the line stops at the settled
 * edge and today joins the "still to come" dots, which is what silence looks
 * like. `partial` states which of the two happened, so the hollow endpoint is
 * never drawn on a settled day.
 */
function sparkOf(p: ProjectCard): { data: number[]; partial: boolean } {
  const t = todayUtc.value
  const settled = settledUtc.value
  if (!t || !settled) return { data: [], partial: false }
  const byDay = new Map(p.spark.map((d) => [d.day, Number(d.cost_usd)]))
  // Settled elapsed days of the SERVER's month. `settledThrough` is `today − 1`
  // by construction, so on the 1st there are none and the month opens empty
  // rather than with a fabricated zero.
  const settledCount = utcDayOfMonth(t) - 1
  const data = (settledCount > 0 ? denseDays(settled, settledCount) : []).map(
    (day) => byDay.get(day) ?? 0,
  )
  const todayUsd = byDay.get(t)
  if (todayUsd === undefined) return { data, partial: false }
  return { data: [...data, todayUsd], partial: true }
}
/*
 * NO FLOOR (F2/D7). This card used to carry `SPARK_MIN_DAYS = 7` too — the same
 * gate as ScopeKpiTile, and the same bug: for the first six days of every month
 * every card on this page replaced its shape with "not enough days yet". The
 * spark now spans the whole month, so a short month-start draws a short line and
 * dots for the days still to come. `daysInMonth` is server-resolved (see the
 * clock note above), which is what makes the frame safe to draw.
 */

function minePct(p: ProjectCard): number | null {
  const total = Number(p.mtd_cost_usd)
  if (!(total > 0)) return null
  return Math.round((Number(p.mine_mtd_usd) / total) * 100)
}

function endState(p: ProjectCard): string | null {
  if (p.ended) return 'ended'
  if (p.end_date) return `ends ${p.end_date.slice(0, 10)}`
  return null
}
// Velocity stays real and as-built (D26): the 4-week-mean note whenever a
// baseline exists — and day-1 HONESTY when it does not: unknown, not quiet.
function velocityNote(p: ProjectCard): string | null {
  const d = p.velocity.delta_pct
  if (d == null) return null
  const pct = Math.round(d * 100)
  return `this week ${pct > 0 ? '+' : ''}${pct}% vs 4-week avg`
}

// Rollup honesty for the (i): the velocity flag is the one cron-fed figure on
// this page — quoted at its STALEST so one fresh project can't speak for all.
const aggregateAge = computed(() => {
  const m = data.value?.page_freshness?.aggregate_minutes_ago
  if (m == null) return null
  if (m < 60) return `${Math.round(m)} min`
  if (m < 60 * 48) return `${Math.round(m / 60)} h`
  return `${Math.round(m / 1440)} d`
})
const neverRolledUp = computed(() => data.value?.page_freshness?.projects_never_rolled_up ?? 0)
</script>

<template>
  <div v-if="session" class="max-w-[1400px] mx-auto px-10 py-8 pb-20" data-testid="my-projects">
    <UiPageHead
      eyebrow="My projects"
      title="My projects"
      sub="Every project you're on — the same view your whole team sees."
      :crumbs="['My projects']"
    />

    <!-- §A once, with the prose behind (i) (fix 6 / D12) — no lane toggle. -->
    <div class="flex items-center gap-2 mb-3">
      <UiBadge kind="neutral" data-testid="projects-lane-pill">§A · month to date</UiBadge>
      <InfoDot label="About these figures">
        Indicative attributed usage (§A), the lens budgets read, so there is no lane toggle
        here; each project's own page has a Chargeback lens. Month-to-date burn and your contribution are
        live off the §A lane; the velocity flag comes from the
        rollup<template v-if="aggregateAge">, last refreshed {{ aggregateAge }} ago for the least
          recently updated project</template>.<template v-if="neverRolledUp > 0">
          {{ neverRolledUp }} project<template v-if="neverRolledUp > 1">s have</template><template v-else> has</template>
          no rollup yet, so the velocity flag there is unknown rather than quiet.</template>
        The list stays month-to-date; custom windows here are a recorded open owner decision.
      </InfoDot>
    </div>

    <!-- The headline band (D25): your Σ · N projects · day X of Y · untagged pull-through. -->
    <section
      v-if="data?.projects?.length"
      class="flex items-baseline gap-3 flex-wrap border-b border-calm-2 pb-3 mb-5"
      data-testid="projects-band"
    >
      <span class="text-[17px] font-extrabold text-carbon">{{ monthWord }}</span>
      <span
        class="text-[22px] font-extrabold text-carbon tracking-[-0.02em]"
        style="font-variant-numeric: tabular-nums"
        data-testid="projects-band-total"
      >{{ fmtUsd(mineTotal) }}</span>
      <span class="text-[12.5px] text-carbon-2">
        your contribution · {{ data.projects.length }}
        project{{ data.projects.length === 1 ? '' : 's' }} · day {{ dayOfMonth }} of {{ daysInMonth }}
      </span>
      <NuxtLink
        v-if="untaggedUsd > 0"
        to="/usage"
        class="ml-auto text-[11.5px] font-semibold text-brand-harmony hover:underline"
        data-testid="projects-untagged-pullthrough"
      >{{ fmtUsd(untaggedUsd) }} untagged → worklist</NuxtLink>
    </section>

    <div v-if="data?.projects?.length" class="grid grid-cols-1 md:grid-cols-2 xl:grid-cols-3 gap-5">
      <NuxtLink
        v-for="p in orderedProjects"
        :key="p.id"
        :to="`/projects/${encodeURIComponent(p.code)}`"
        class="block group"
        :data-testid="`project-card-${p.code}`"
      >
        <UiCard class="h-full transition-shadow group-hover:shadow-lg">
          <div class="flex items-start justify-between gap-2">
            <div class="min-w-0">
              <div class="text-base font-bold text-carbon truncate group-hover:text-brand-harmony transition-colors">
                {{ p.display_name }}
              </div>
              <div class="text-[11px] text-carbon-3 mt-0.5">
                {{ p.code }} · {{ p.type }}<template v-if="p.wbs_code"> · WBS {{ p.wbs_code }}</template> ·
                {{ p.member_count }} member{{ p.member_count === 1 ? '' : 's' }}
              </div>
            </div>
            <div class="flex flex-col items-end gap-1 shrink-0">
              <!-- ONE pace vocabulary (fix 4): budgetPace's word, fact vs forecast intact. -->
              <UiBadge :kind="budgetPaceKind(paceOf(p))" :data-testid="`pace-${p.code}`">
                {{ budgetPaceLabel(paceOf(p)) }}
              </UiBadge>
              <UiBadge v-if="p.velocity.is_flagged" kind="rag-amber" data-testid="velocity-flag">
                velocity ↑
              </UiBadge>
              <UiBadge v-if="endState(p)" :kind="p.ended ? 'neutral' : 'outline'">
                {{ endState(p) }}
              </UiBadge>
            </div>
          </div>

          <!-- Same-window sparkline (D26): the month's own shape, not a trailing
               one — and the WHOLE month, elapsed days as a line, the rest as
               baseline dots (F2/D7). -->
          <div class="mt-3">
            <MonthSpark v-bind="sparkOf(p)" :span="daysInMonth" :height="34" />
          </div>

          <div class="mt-3">
            <!-- No `label`: the bar's own label row and the spend line below it
                 render the SAME sentence, so the card said its budget twice. -->
            <ChartsUtilBar
              :used="Number(p.mtd_cost_usd)"
              :total="Number(p.allocation_usd) > 0 ? Number(p.allocation_usd) : null"
            />
            <p
              class="text-[11px] text-carbon-2 mt-1.5"
              style="font-variant-numeric: tabular-nums"
              :data-testid="`spend-line-${p.code}`"
            >
              {{ spendLine(p) }}
            </p>

            <!-- "yours $X · N%" with a mini share bar (D25/D26). -->
            <p
              class="text-[11px] text-carbon-3 mt-1 flex items-center gap-2"
              style="font-variant-numeric: tabular-nums"
              :data-testid="`mine-${p.code}`"
            >
              yours {{ fmtUsd(p.mine_mtd_usd) }}<template v-if="minePct(p) != null"> · {{ minePct(p) }}%</template>
              <span
                v-if="minePct(p) != null"
                class="inline-block w-[52px] h-[8px] rounded bg-calm-2 overflow-hidden"
                aria-hidden="true"
              >
                <span
                  class="block h-full bg-brand-vision"
                  :style="{ width: `${Math.min(minePct(p)!, 100)}%` }"
                  :data-testid="`mine-share-bar-${p.code}`"
                />
              </span>
            </p>

            <!-- Velocity, real and as-built — with day-1 honesty (D26). -->
            <p
              v-if="velocityNote(p)"
              class="text-[11px] text-carbon-3 mt-1"
              :class="p.velocity.is_flagged ? 'text-rag-amber font-semibold' : ''"
              :data-testid="`velocity-note-${p.code}`"
            >
              {{ velocityNote(p) }}
            </p>
            <p
              v-else
              class="text-[11px] text-carbon-3 mt-1 italic"
              :data-testid="`velocity-baseline-${p.code}`"
            >
              velocity needs a baseline — unknown, not quiet
            </p>
          </div>
        </UiCard>
      </NuxtLink>
    </div>
    <UiEmptyState
      v-else-if="error"
      headline="Couldn't load your projects"
      sub="Something went wrong fetching this page. Refresh to try again."
      data-testid="my-projects-error"
    />
    <UiEmptyState
      v-else-if="!pending"
      headline="No project memberships"
      sub="You'll see a card here for every project you're assigned to."
    />
    <!-- D13 (fix 12): the pending state is the report skeleton, not prose — the
         same settle() signal parity-shots keys on (skeleton gone + rendered money).
         No KPI band on the card list; the rows sketch the project cards. -->
    <ReportSkeleton v-else :kpis="0" :rows="8" />
  </div>
</template>
