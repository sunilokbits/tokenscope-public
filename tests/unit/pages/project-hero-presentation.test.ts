// @vitest-environment happy-dom
/*
 * F2 on /projects/{code} — the page's own decisions (T10, T11, T12, T13).
 *
 * The affordances are pinned in hero-tiles-f2.test.ts; this file pins that the
 * page USES them, which is where S3 actually lived — every figure on that page
 * was already correct.
 *
 *  T10 the pace pill sits in the sentence it qualifies, not beside the label.
 *  T11 the duplicate delta leaves Burn/day, and the tile says why — so the
 *      month-on-month figure appears exactly ONCE in the row.
 *  T12 Daily burn asks for the prototype's fixed 150px.
 *  T13 the reason-typed remainder is handed over as a remainder, not a model.
 *
 * Mounting idiom copied from project-detail-member-depth.test.ts, with the
 * stacked-bars primitive kept REAL for T12/T13 — the point of both is what the
 * chart draws, so a stub would certify nothing.
 */
import { describe, it, expect, vi, afterEach, beforeEach } from 'vitest'
import { defineComponent, ref } from 'vue'
import { mount, flushPromises } from '@vue/test-utils'
import { stubServerClock } from '../../helpers/server-clock'
import ProjectPage from '../../../app/pages/projects/[code].vue'
import StackedBars from '../../../app/components/charts/StackedBars.vue'

type Payload = Record<string, unknown>

/** Window day 10 of a 31-day August; spend 400 of a 1,000 allocation. */
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
    days_elapsed: 10,
    days_in_window: 31,
  },
  budget: { window_cost_usd: '400.00', allocation_usd: '1000.00' },
  velocity: { current_week_usd: '10.00', trailing_mean_usd: '10.00', delta_pct: 0, is_flagged: false },
  series_by_model: [
    { day: '2026-08-01', model: 'claude-fable-5', cost_usd: '150.00' },
    { day: '2026-08-02', model: 'claude-fable-5', cost_usd: '150.00' },
    { day: '2026-08-02', model: 'Copilot day-grain money', cost_usd: '100.00' },
  ],
  /*
   * INTEGRATION (F2 × F6). Daily burn draws from `burn.series_by_model` — its own
   * trailing 30/90 window (D28) — not the page-window series above. These T12/T13
   * assertions were written against the pre-D28 shape, where the chart read the
   * top-level series; with only that, `stackEndDay` is undefined, the chart never
   * mounts, and the failure reads as "the remainder note is missing" rather than
   * "the chart isn't there". Same rows, so what T12 and T13 assert is unchanged.
   */
  burn: {
    window_days: 30,
    from: '2026-07-12',
    settled_to: '2026-08-09',
    to: '2026-08-10',
    series_by_model: [
      { day: '2026-08-01', model: 'claude-fable-5', cost_usd: '150.00' },
      { day: '2026-08-02', model: 'claude-fable-5', cost_usd: '150.00' },
      { day: '2026-08-02', model: 'Copilot day-grain money', cost_usd: '100.00' },
    ],
    advisory_cost_usd: '0.00',
    advisory_basis: 'otel-aggregate-all-identities',
  },
  mix: {
    by_model: [
      { key: 'claude-fable-5', label: 'claude-fable-5', cost_usd: '300.00', tokens: 100, gap_reason: null },
      {
        key: '__null_model:provider-day-grain',
        label: 'Copilot day-grain money',
        cost_usd: '100.00',
        tokens: 0,
        gap_reason: 'provider-day-grain',
      },
    ],
    by_activity: [{ activity: 'feature-dev', cost_usd: '400.00', tokens: 10 }],
  },
  hero: {
    active_members: 4,
    assigned_members: 5,
    deltas: {
      basis: 'vs last month',
      empty_reason: null,
      // The operand S3 caught: burn_pct IS spend_pct, because the day counts
      // cancel. The payload still carries it; the tile refuses to print it.
      spend_pct: 5.63,
      burn_pct: 5.63,
      active_members_abs: 1,
      untagged_pct: -0.12,
    },
  },
  lane_coverage: {
    otel_usd: '300.00',
    reconciled_usd: '100.00',
    provisional_withheld_usd: '0.00',
    member_ingest_only_usd: '0.00',
    member_ingest_only_tools: [],
  },
  team: {
    members: [
      {
        teammate_id: 't1',
        display_name: 'Priya Iyer',
        email: 'priya@x.test',
        cost_usd: '400.00',
        tokens: 100,
        active_days: 10,
        cost_per_active_day: '40.00',
        last_event: '2026-08-10T10:00:00Z',
      },
    ],
    member_count: 1,
    concentration_top2_share: 1,
  },
  untagged_pressure: { conversations: 3, cost_usd: '42.00', tokens: 0 },
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
  NuxtLink: { props: ['to'], template: '<a><slot /></a>' },
  DateRangeControl: { template: '<div data-testid="date-range-control" />' },
  ChartRankedBar: { props: ['rows'], template: '<div />' },
}

const TODAY = '2026-08-10T12:00:00Z'
const fmtUsd = (v: string | number) => `$${Number(v).toFixed(2)}`
const fmtPct = (v: number) => `${Math.round(v * 100)}%`
const fmtTokens = (v: number) => String(v)
const fmtTimeAgo = () => 'just now'

async function mountPage(data: Payload) {
  stubServerClock(TODAY)
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
    patch: vi.fn(),
  }))
  vi.stubGlobal('usePersonalLens', () => ref<'usage' | 'chargeback'>('usage'))
  vi.stubGlobal('useFetch', () => ({ data: ref(data), pending: ref(false), error: ref(null) }))
  const Parent = defineComponent({
    components: { ProjectPage },
    template: '<Suspense><ProjectPage /></Suspense>',
  })
  const w = mount(Parent, {
    global: {
      stubs: STUBS,
      // The chart primitive mounts REAL, under its Nuxt auto-import name: both
      // T12 and T13 are about what it draws, so a stub would certify nothing.
      components: { ChartsStackedBars: StackedBars },
      mocks: { fmtUsd, fmtPct, fmtTokens, fmtTimeAgo },
    },
  })
  await flushPromises()
  return w
}

beforeEach(() => stubServerClock(TODAY))
afterEach(() => vi.unstubAllGlobals())

/*
 * REVERT: reinstate `SPARK_MIN_DAYS` in ScopeKpiTile and day 1 renders italic
 * prose where the picture should be — on this page as on every other hero.
 */
describe('/projects/{code} — the spark spans the month on DAY 1 (T7)', () => {
  it('draws one point and the rest of the month as dots', async () => {
    const w = await mountPage(
      payload({
        window: {
          from: '2026-08-01',
          to: '2026-08-31',
          is_month: true,
          month: '2026-08',
          days_elapsed: 1,
          days_in_window: 31,
        },
      }),
    )
    const tile = w.find('[data-testid="tile-spend-vs-budget"]')
    expect(tile.find('[data-testid="month-spark-endpoint"]').exists()).toBe(true)
    expect(tile.findAll('[data-testid="month-spark-dot"]')).toHaveLength(30)
    expect(w.find('[data-testid="project-hero-band"]').text()).not.toContain('not enough days yet')
  })

  it('a custom range draws no dots — a range has no month ahead', async () => {
    const w = await mountPage(
      payload({
        window: {
          from: '2026-07-10',
          to: '2026-08-05',
          is_month: false,
          month: null,
          days_elapsed: 27,
          days_in_window: 27,
        },
      }),
    )
    const tile = w.find('[data-testid="tile-spend-vs-budget"]')
    expect(tile.find('[data-testid="month-spark"]').exists()).toBe(true)
    expect(tile.findAll('[data-testid="month-spark-dot"]')).toHaveLength(0)
  })
})

/*
 * REVERT: move the pill back to the `#badge` slot and it renders in the label
 * row, four lines from the budget sentence — the sub-line assertion goes red.
 */
describe('/projects/{code} — the pace pill qualifies the budget sentence (T10)', () => {
  it('renders INSIDE the sub line, beside "40% of $1,000.00"', async () => {
    const w = await mountPage(payload())
    const pill = w.find('[data-testid="proj-pace-pill"]')
    expect(pill.exists()).toBe(true)
    const line = pill.element.parentElement!.textContent ?? ''
    expect(line).toContain('40% of $1000.00')
    expect(line).not.toContain('SPEND VS BUDGET')
  })
})

/*
 * REVERT: bind `burnDelta` back onto the Burn/day tile and "563%" appears twice
 * in the row — the count assertion goes red. Repeating a number is how a reader
 * learns to stop reading the second one.
 */
describe('/projects/{code} — the month-on-month appears ONCE (T11)', () => {
  it('Burn/day carries no delta and NAMES why', async () => {
    const w = await mountPage(payload())
    const burn = w.find('[data-testid="tile-burn-per-day"]')
    expect(burn.find('[data-testid="kpi-delta"]').exists()).toBe(false)
    expect(burn.find('[data-testid="kpi-delta-empty"]').text()).toBe(
      'same change as spend — the day counts cancel',
    )
  })

  it('the figure itself appears exactly once across the four tiles', async () => {
    const w = await mountPage(payload())
    const row = w.find('[data-testid="project-hero-band"]').text()
    expect(row.match(/563%/g) ?? []).toHaveLength(1)
    // …and it is on the tile that owns it.
    expect(w.find('[data-testid="tile-spend-vs-budget"]').text()).toContain('563%')
  })

  it('still shows the burn FIGURE — only the duplicate delta left', async () => {
    const w = await mountPage(payload())
    // 400 over 10 elapsed days.
    expect(w.find('[data-testid="tile-burn-per-day"]').text()).toContain('$40.00')
  })
})

/*
 * REVERT: drop the `height` binding and Daily burn goes back to 160 viewBox
 * units scaled by the container's width — the ~2× render S3 caught.
 */
describe('/projects/{code} — Daily burn is 150px, fixed (T12)', () => {
  it('asks the chart for the prototype height, in pixels', async () => {
    const w = await mountPage(payload())
    const svg = w.find('[data-testid="burn-card"] svg')
    expect(svg.attributes('style')).toContain('height: 150px')
    expect(svg.attributes('preserveAspectRatio')).toBe('none')
  })
})

/*
 * REVERT: stop passing `remainderKeys` and "Copilot day-grain money" is back in
 * the model legend with a dot, reading as a model name.
 */
describe('/projects/{code} — the remainder leaves the model legend (T13)', () => {
  it('names it in the coverage register, with its money', async () => {
    const w = await mountPage(payload())
    const note = w.find('[data-testid="stacked-bars-remainder-note"]')
    expect(note.exists()).toBe(true)
    expect(note.text()).toContain('Copilot day-grain money')
    expect(note.text()).toContain('$100.00')
  })

  it('the legend beside it names models only', async () => {
    const w = await mountPage(payload())
    const legend = w
      .find('[data-testid="stacked-bars"]')
      .findAll('span.inline-flex')
      .map((n) => n.text())
    // Two keys are stacked; exactly ONE of them is a model, so exactly one
    // legend entry — and it is not the remainder.
    expect(legend).toHaveLength(1)
    expect(legend[0]).not.toContain('day-grain')
  })
})
