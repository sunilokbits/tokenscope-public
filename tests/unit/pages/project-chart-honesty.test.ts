// @vitest-environment happy-dom
/*
 * /projects/[code] — the external-review fix pass on its two charts.
 *
 * T-A  THE BURN AXIS COMES FROM THE BURN PAYLOAD, not a second `/clock` read.
 *      The card's comment claimed "the server resolved those same bounds
 *      (`burn.from` … `burn.to`), so the footer's window and the chart's window
 *      cannot diverge" — while the code read NEITHER, taking the edge from
 *      `useServerClock`, a separate request with its own instant. Two round
 *      trips straddling a UTC midnight resolve two different days and the axis
 *      then labels a window one day off the series drawn on it.
 *
 * T-B  THE HERO SPARK STOPS AT THE SETTLED EDGE. `dailyTotals` zero-filled every
 *      day in `days_elapsed` — a count of days BEGUN, so it included today, a
 *      day the server has not finished measuring. Drawn, that is the morning dip
 *      F1 exists to remove: a line falling to the baseline every UTC morning on
 *      a project that is spending normally. NULL is not 0.
 *
 * Mounting idiom: project-restorations.test.ts.
 */
import { describe, it, expect, vi, afterEach } from 'vitest'
import { defineComponent, ref } from 'vue'
import { mount, flushPromises } from '@vue/test-utils'
import { stubServerClock } from '../../helpers/server-clock'
import ProjectPage from '../../../app/pages/projects/[code].vue'

type Payload = Record<string, unknown>

/** The page's own clock read. 10 August ⇒ its settled edge is the 9th. */
const CLIENT_TODAY = '2026-08-10T12:00:00Z'

const payload = (over: Payload = {}): Payload => ({
  project: {
    id: 'p1',
    code: 'ACME-1',
    display_name: 'Acme Platform',
    type: 'billable',
    wbs_code: null,
    end_date: null,
    ended: false,
  },
  viewer: { role: 'member', access: 'member', budget_allocation_id: null },
  window: {
    from: '2026-08-01',
    to: '2026-08-31',
    is_month: true,
    month: '2026-08',
    // Days BEGUN, so it counts the still-filling 10th.
    days_elapsed: 10,
    days_in_window: 31,
  },
  budget: { window_cost_usd: '400.00', allocation_usd: '1000.00' },
  velocity: { current_week_usd: '10.00', trailing_mean_usd: '10.00', delta_pct: 0, is_flagged: false },
  series_by_model: [
    { day: '2026-08-02', model: 'claude-fable-5', cost_usd: '40.00' },
    { day: '2026-08-09', model: 'claude-fable-5', cost_usd: '30.00' },
  ],
  burn: {
    window_days: 30,
    from: '2026-07-12',
    settled_to: '2026-08-09',
    to: '2026-08-10',
    series_by_model: [
      { day: '2026-07-28', model: 'claude-fable-5', cost_usd: '12.00' },
      { day: '2026-08-02', model: 'claude-fable-5', cost_usd: '40.00' },
    ],
    advisory_cost_usd: '0.00',
    advisory_basis: 'otel-aggregate-all-identities',
  },
  mix: {
    by_model: [
      { key: 'claude-fable-5', label: 'claude-fable-5', cost_usd: '400.00', tokens: 100, gap_reason: null },
    ],
    by_activity: [{ activity: 'feature-dev', cost_usd: '400.00', tokens: 10 }],
  },
  hero: {
    active_members: 2,
    assigned_members: 2,
    deltas: {
      basis: 'vs last month',
      empty_reason: null,
      spend_pct: 0.18,
      burn_pct: 0.06,
      active_members_abs: 1,
      untagged_pct: null,
    },
  },
  lane_coverage: {
    otel_usd: '400.00',
    reconciled_usd: '0.00',
    provisional_withheld_usd: '0.00',
    member_ingest_only_usd: '0.00',
    member_ingest_only_tools: [],
  },
  team: { members: [], member_count: 0, concentration_top2_share: null },
  untagged_pressure: { conversations: 0, cost_usd: '0.00', tokens: 0 },
  page_freshness: { aggregate_minutes_ago: 14 },
  providerStates: [{ vendor: 'anthropic', state: 'estimated', closeRun: false }],
  coverage: null,
  ...over,
})

const STUBS = {
  UiPageHead: { template: '<div><slot name="actions" /></div>' },
  UiCard: { template: '<div><slot /></div>' },
  UiBadge: { template: '<span><slot /></span>' },
  UiEyebrow: { template: '<div><slot /></div>' },
  UiEmptyState: true,
  InfoDot: true,
  UsageWindowToggle: true,
  NuxtLink: { props: ['to'], template: '<a><slot /></a>' },
  DateRangeControl: { template: '<div />' },
  ChartSparkline: true,
  ChartRankedBar: true,
  ModelSplitPanel: true,
  CcHeaderNotes: true,
  ExportCsvButton: true,
  DrillName: true,
  // The two charts under test, reduced to the props that ARE the finding.
  ChartsStackedBars: {
    props: ['rows', 'keyOrder', 'windowDays', 'endDay', 'partialDay'],
    template:
      '<div data-testid="bars" :data-end-day="endDay" :data-partial-day="partialDay" :data-window-days="windowDays" :data-key-order="(keyOrder || []).join(\',\')" />',
  },
  ScopeKpiTile: {
    props: ['label', 'spark', 'sparkSpan', 'sparkPartial'],
    template:
      '<div :data-testid="`tile-${label}`" :data-spark="(spark || []).join(\',\')" :data-spark-partial="String(sparkPartial)" />',
  },
}

const fmtUsd = (v: string | number) => `$${Number(v).toFixed(2)}`
const fmtPct = (v: number) => `${Math.round(v * 100)}%`
const fmtTokens = (v: number) => String(v)
const fmtTimeAgo = () => 'just now'

async function mountPage(data: Payload, clockAt = CLIENT_TODAY) {
  stubServerClock(clockAt)
  vi.stubGlobal('fmtUsd', fmtUsd)
  vi.stubGlobal('fmtPct', fmtPct)
  vi.stubGlobal('fmtTokens', fmtTokens)
  vi.stubGlobal('fmtTimeAgo', fmtTimeAgo)
  vi.stubGlobal('useRoute', () => ({ params: { code: 'ACME-1' }, query: {} }))
  vi.stubGlobal('useSession', () => ({ session: ref({ teammateId: 't1' }), ensure: async () => {} }))
  vi.stubGlobal('useReportState', () => ({
    month: ref<string | null>(null),
    from: ref<string | null>(null),
    to: ref<string | null>(null),
    src: ref<string | null>(null),
    patch: vi.fn(),
  }))
  vi.stubGlobal('usePersonalLens', () => ref<'usage' | 'chargeback'>('usage'))
  vi.stubGlobal('useFetch', () => ({
    data: ref(data),
    pending: ref(false),
    error: ref(null),
    refresh: vi.fn(),
  }))
  const Parent = defineComponent({
    components: { ProjectPage },
    template: '<Suspense><ProjectPage /></Suspense>',
  })
  const w = mount(Parent, {
    global: { stubs: STUBS, mocks: { fmtUsd, fmtPct, fmtTokens, fmtTimeAgo } },
  })
  await flushPromises()
  return w
}

afterEach(() => vi.unstubAllGlobals())

describe('T-A — the burn axis is re-derived from the burn payload', () => {
  it('takes both marks from the burn block — settled_to and to, not /clock', async () => {
    const w = await mountPage(payload())
    const bars = w.find('[data-testid="bars"]')
    // `settled_to` is the server's own operand for the edge (r6), so the client
    // infers nothing: not from `/clock`, not by stepping back from `to`.
    expect(bars.attributes('data-end-day')).toBe('2026-08-09')
    expect(bars.attributes('data-partial-day')).toBe('2026-08-10')
  })

  it('follows settled_to when the server edge is NOT simply today minus one', async () => {
    // Provider lag can shorten the settled edge independently of the calendar.
    // A client deriving `to − 1` would draw a day the server refuses to claim.
    const w = await mountPage(
      payload({
        burn: {
          window_days: 30,
          from: '2026-07-10',
          settled_to: '2026-08-07',
          to: '2026-08-10',
          series_by_model: [{ day: '2026-08-02', model: 'claude-fable-5', cost_usd: '40.00' }],
          advisory_cost_usd: '0.00',
          advisory_basis: 'otel-aggregate-all-identities',
        },
      }),
    )
    expect(w.find('[data-testid="bars"]').attributes('data-end-day')).toBe('2026-08-07')
  })

  /*
   * RED ON REVERT: restore `serverClock.value?.settledThrough` / `todayIso` as
   * the two marks and this goes red — the axis follows the browser's own clock
   * fetch instead of the series it is drawing.
   *
   * The scenario is a real one: the `/clock` response landed before a UTC
   * midnight and the project payload after it.
   */
  it('a clock read one day BEHIND the payload does not move the axis', async () => {
    const w = await mountPage(payload(), '2026-08-09T23:59:50Z')
    const bars = w.find('[data-testid="bars"]')
    expect(bars.attributes('data-end-day')).toBe('2026-08-09')
    expect(bars.attributes('data-partial-day')).toBe('2026-08-10')
  })

  it('the window length is the SERVER-echoed one, so axis and series span alike', async () => {
    const w = await mountPage(payload())
    expect(w.find('[data-testid="bars"]').attributes('data-window-days')).toBe('30')
  })
})

describe('T-B — the hero spark stops at the settled edge', () => {
  /*
   * RED ON REVERT: rebuild `dailyTotals` over `w.days_elapsed` and the series
   * grows a 10th element — a fabricated `0` on the still-filling day, drawn as
   * a collapse to the baseline.
   */
  it('zero-fills the settled days only — today is not padded in', async () => {
    const w = await mountPage(payload())
    const spark = w.find('[data-testid^="tile-"]').attributes('data-spark')!.split(',')
    // 1 Aug … 9 Aug: nine settled days, NOT ten.
    expect(spark).toHaveLength(9)
    expect(spark[1]).toBe('40') // the 2nd, a measured day
    expect(spark[8]).toBe('30') // the 9th, the settled edge
    expect(w.find('[data-testid^="tile-"]').attributes('data-spark-partial')).toBe('false')
  })

  it('admits today when it CARRIES data, and says it is partial', async () => {
    const w = await mountPage(
      payload({
        series_by_model: [
          { day: '2026-08-09', model: 'claude-fable-5', cost_usd: '30.00' },
          { day: '2026-08-10', model: 'claude-fable-5', cost_usd: '7.00' },
        ],
      }),
    )
    const tile = w.find('[data-testid^="tile-"]')
    const spark = tile.attributes('data-spark')!.split(',')
    expect(spark).toHaveLength(10)
    expect(spark[9]).toBe('7')
    expect(tile.attributes('data-spark-partial')).toBe('true')
  })

  /*
   * THE SPARK'S EDGE IS THE PAYLOAD'S, NOT `/clock`'s (external review r2). The
   * burn chart above was moved onto `burn.settled_to`/`burn.to` in the first fix
   * pass and this computed was left reading `useServerClock` — a second request
   * with its own instant.
   *
   * RED ON REVERT: put `clock.settledThrough` / `clock.today` back into
   * `dailyTotals` and this goes red at 8 points — the 9th, a day the payload
   * measured and drew in the chart below, silently dropped from the line above
   * it because the clock request landed on the other side of a UTC midnight.
   */
  it('a clock read one day BEHIND the payload does not shorten the spark', async () => {
    const w = await mountPage(payload(), '2026-08-09T23:59:50Z')
    const tile = w.find('[data-testid^="tile-"]')
    expect(tile.attributes('data-spark')!.split(',')).toHaveLength(9)
    expect(tile.attributes('data-spark-partial')).toBe('false')
  })

  it('a clock read one day AHEAD of the payload does not invent a day either', async () => {
    // The mirror case: `/clock` has ticked over, the payload has not. A client
    // reading the clock would admit 2026-08-10 as settled and pad it with a
    // fabricated zero — the morning dip, from the other direction.
    const w = await mountPage(payload(), '2026-08-11T00:00:10Z')
    const tile = w.find('[data-testid^="tile-"]')
    expect(tile.attributes('data-spark')!.split(',')).toHaveLength(9)
    expect(tile.attributes('data-spark-partial')).toBe('false')
  })

  it('a PAST month runs to its own end and is not partial', async () => {
    const w = await mountPage(
      payload({
        window: {
          from: '2026-06-01',
          to: '2026-06-30',
          is_month: true,
          month: '2026-06',
          days_elapsed: 30,
          days_in_window: 30,
        },
        series_by_model: [{ day: '2026-06-30', model: 'claude-fable-5', cost_usd: '5.00' }],
      }),
    )
    const tile = w.find('[data-testid^="tile-"]')
    expect(tile.attributes('data-spark')!.split(',')).toHaveLength(30)
    expect(tile.attributes('data-spark-partial')).toBe('false')
  })
})

describe('T-C — advisory spend: NULL is not a measured zero', () => {
  /*
   * `advisory_cost_usd` ships `null` when the aggregate holds no row for this
   * scope and window — an un-materialised or lagging rollup. The client read was
   * `Number(… ?? 0)`, which flattened null and 0.00 into one silent "draw
   * nothing", so an outage looked exactly like a project with no telemetry-only
   * spend. The distinction the server pass created died at the last step.
   *
   * RED ON REVERT: restore `Number(data.value?.burn?.advisory_cost_usd ?? 0)`
   * and the unavailable case renders nothing at all again.
   */
  const withAdvisory = (advisory_cost_usd: string | null, advisory_uncovered_days = 0) =>
    payload({
      burn: {
        window_days: 30,
        from: '2026-07-12',
        settled_to: '2026-08-09',
        to: '2026-08-10',
        series_by_model: [{ day: '2026-08-02', model: 'claude-fable-5', cost_usd: '40.00' }],
        advisory_cost_usd,
        advisory_uncovered_days,
        advisory_basis: 'otel-aggregate-all-identities',
      },
    })

  it('says the figure is UNAVAILABLE when the server sends null', async () => {
    const w = await mountPage(withAdvisory(null))
    const el = w.find('[data-testid="burn-advisory-unavailable"]')
    expect(el.exists()).toBe(true)
    expect(el.text()).toContain('Not zero: unmeasured')
    expect(w.find('[data-testid="burn-advisory"]').exists()).toBe(false)
  })

  it('a MEASURED zero still renders nothing — the mirror defect stays closed', async () => {
    const w = await mountPage(withAdvisory('0.00'))
    expect(w.find('[data-testid="burn-advisory"]').exists()).toBe(false)
    expect(w.find('[data-testid="burn-advisory-unavailable"]').exists()).toBe(false)
  })

  it('a real figure states its money AND the population it sums over', async () => {
    const w = await mountPage(withAdvisory('318.90'))
    const el = w.find('[data-testid="burn-advisory"]')
    expect(el.text()).toContain('$318.90')
    // The basis is a SERVER field, not adjacency: the aggregate has no identity
    // axis, so this is not a subset of the bars it sits under.
    expect(el.attributes('title')).toContain('no identity axis')
  })
})

describe('T-C2 — a PARTIALLY materialised rollup is not a window total', () => {
  /*
   * The null-vs-zero fix only caught TOTAL absence, so a window missing some of
   * its rollup days still printed "$X of the last 30d is advisory" — a
   * complete-looking sentence over an incomplete sum. The server now counts the
   * window's spending days the rollup provably has not covered.
   *
   * RED ON REVERT: drop the `advisory_uncovered_days` branch from the footer and
   * the partial case claims "the last 30d" again.
   */
  const withAdvisory = (usd: string | null, uncovered: number) =>
    payload({
      burn: {
        window_days: 30,
        from: '2026-07-12',
        settled_to: '2026-08-09',
        to: '2026-08-10',
        series_by_model: [{ day: '2026-08-02', model: 'claude-fable-5', cost_usd: '40.00' }],
        advisory_cost_usd: usd,
        advisory_uncovered_days: uncovered,
        advisory_basis: 'otel-aggregate-all-identities',
      },
    })

  it('a COVERED window still says what period the figure is of', async () => {
    const el = (await mountPage(withAdvisory('318.90', 0))).find('[data-testid="burn-advisory"]')
    expect(el.text()).toContain('of the last 30d')
  })

  it('an INCOMPLETE window drops the period claim and names the gap', async () => {
    const el = (await mountPage(withAdvisory('318.90', 4))).find('[data-testid="burn-advisory"]')
    expect(el.text()).toContain('$318.90')
    // The figure is still shown — it is a real sum — but it no longer claims to
    // be the window's, and the reason is named rather than estimated.
    expect(el.text()).not.toContain('of the last 30d is advisory')
    expect(el.text()).toContain('4 spending days')
  })

  it('says "day", singular, when exactly one is missing', async () => {
    const el = (await mountPage(withAdvisory('318.90', 1))).find('[data-testid="burn-advisory"]')
    expect(el.text()).toContain('1 spending day')
    expect(el.text()).not.toContain('spending days')
  })
})
