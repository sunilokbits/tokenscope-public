// @vitest-environment happy-dom
/*
 * T27 + T28 — the two capability losses from #237, restored on /projects/[code].
 *
 * T27 (D27) — the advisory-spend disclosure returns, and returns in the RIGHT
 *             REGISTER. The dev-pages prototype settles the placement in one
 *             sentence: "as a chart footer, not a tile sub." So these assert the
 *             element's POSITION as well as its text — a correct sentence in the
 *             wrong place is the defect the note exists to prevent, and a test
 *             that only greps the string would pass on it.
 *
 * T28 (D28) — the 30/90 trailing window returns, on the parameter `/usage`
 *             already documents (`?window=`, shared/schemas/usage.ts::WindowQuery),
 *             disclosed the way /usage discloses its: same control, same (i)
 *             sentence, and it moves NOTHING else on the page.
 *
 * Both are owner-ruled restorations; D28 is one of the three recorded departures
 * from the original drawings (with D6 and D7), so the amended prototypes already
 * show it and it must not be "corrected" back.
 *
 * Mounting idiom: project-detail-member-depth.test.ts, with the real
 * UsageWindowToggle and the real InfoDot.
 */
import { describe, it, expect, vi, afterEach } from 'vitest'
import { defineComponent, ref } from 'vue'
import { mount, flushPromises } from '@vue/test-utils'
import { stubServerClock } from '../../helpers/server-clock'
import ProjectPage from '../../../app/pages/projects/[code].vue'
import UsageWindowToggle from '../../../app/components/usage/WindowToggle.vue'

type Payload = Record<string, unknown>

/** The pinned server instant: 10 August, so the settled edge is the 9th. */
const TODAY = '2026-08-10T12:00:00Z'

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
  series_by_model: [{ day: '2026-08-02', model: 'claude-fable-5', cost_usd: '40.00' }],
  burn: {
    window_days: 30,
    from: '2026-07-12',
    settled_to: '2026-08-09',
    to: '2026-08-10',
    series_by_model: [
      // Reaches back into JULY — a trailing window does not reset on the 1st.
      { day: '2026-07-28', model: 'claude-fable-5', cost_usd: '12.00' },
      { day: '2026-08-02', model: 'claude-fable-5', cost_usd: '40.00' },
    ],
    advisory_cost_usd: '318.90',
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
  NuxtLink: { props: ['to'], template: '<a><slot /></a>' },
  DateRangeControl: { template: '<div data-testid="date-range-control" />' },
  ChartSparkline: true,
  ChartRankedBar: true,
  ChartsStackedBars: {
    props: ['rows', 'keyOrder', 'labelFor', 'windowDays', 'endDay', 'partialDay'],
    template:
      '<div data-testid="stacked-bars-stub" :data-window-days="windowDays" :data-end-day="endDay" :data-days="rows.map((r) => r.day).join(\',\')" />',
  },
}

const fmtUsd = (v: string | number) => `$${Number(v).toFixed(2)}`
const fmtPct = (v: number) => `${Math.round(v * 100)}%`
const fmtTokens = (v: number) => String(v)
const fmtTimeAgo = () => 'just now'

/**
 * The reactive `query` the page hands `useFetch` for the member-depth payload —
 * T28's wire half. Held as the REF, not a snapshot: the assertion is about what
 * a 30↔90 click re-asks for, which is only visible if it is re-read.
 */
let memberQuery: { value?: Record<string, unknown> } | null = null
const q = () => memberQuery?.value ?? {}

async function mountPage(data: Payload) {
  memberQuery = null
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
    src: ref<string | null>(null),
    patch: vi.fn(),
  }))
  vi.stubGlobal('usePersonalLens', () => ref<'usage' | 'chargeback'>('usage'))
  vi.stubGlobal('useFetch', (_url: unknown, opts?: { query?: { value?: Record<string, unknown> } }) => {
    // The MEMBER-depth fetch is the one under test. The reports-depth fetch
    // carries `src` in its query — that is how the two are told apart here
    // without reaching for the (lazily-evaluated) URL function.
    const snapshot = opts?.query && 'value' in opts.query ? (opts.query.value ?? null) : null
    if (snapshot && !('src' in snapshot)) memberQuery = opts!.query!
    return { data: ref(data), pending: ref(false), error: ref(null), refresh: vi.fn() }
  })
  const Parent = defineComponent({
    components: { ProjectPage },
    template: '<Suspense><ProjectPage /></Suspense>',
  })
  const w = mount(Parent, {
    global: {
      stubs: STUBS,
      components: { UsageWindowToggle },
      mocks: { fmtUsd, fmtPct, fmtTokens, fmtTimeAgo },
    },
  })
  await flushPromises()
  return w
}

afterEach(() => {
  vi.unstubAllGlobals()
})

describe('T27 — the advisory-spend disclosure returns (D27)', () => {
  it('states the figure and the window it belongs to', async () => {
    const w = await mountPage(payload())
    const el = w.find('[data-testid="burn-advisory"]')
    expect(el.exists()).toBe(true)
    expect(el.text()).toContain('$318.90')
    expect(el.text()).toContain('advisory (telemetry-only) spend')
    // The window is NAMED, and it is the CHART's window (30d), not the page's.
    expect(el.text()).toContain('of the last 30d')
  })

  it('is a CHART FOOTER, not a hero-tile sub-line', async () => {
    /*
     * The prototype's `advisory` note is explicit about the register: on a hero
     * tile it would be "a month-windowed sentence sitting under a trailing
     * figure with nothing saying which of the two it means". So the placement is
     * the assertion — inside the burn card, and inside no tile.
     */
    const w = await mountPage(payload())
    expect(w.find('[data-testid="burn-card"] [data-testid="burn-advisory"]').exists()).toBe(true)
    for (const tile of w.findAll('[data-testid^="tile-"]')) {
      expect(tile.find('[data-testid="burn-advisory"]').exists()).toBe(false)
    }
  })

  it('renders NOTHING at zero advisory — never "$0.00"', async () => {
    // A zero here would assert a measurement we have not made. The recurring
    // NULL-is-not-0 defect, in its display costume.
    const w = await mountPage(
      payload({
        burn: {
          window_days: 30,
          from: '2026-07-12',
          settled_to: '2026-08-09',
          to: '2026-08-10',
          series_by_model: [{ day: '2026-08-02', model: 'claude-fable-5', cost_usd: '40.00' }],
          advisory_cost_usd: '0.00',
          advisory_basis: 'otel-aggregate-all-identities',
        },
      }),
    )
    expect(w.find('[data-testid="burn-advisory"]').exists()).toBe(false)
    expect(w.find('[data-testid="burn-card"]').text()).not.toContain('$0.00')
  })
})

describe('T28 — the 30/90 rolling view returns (D28)', () => {
  it('asks for it on the parameter /usage documents (`?window=`), defaulting to 30', async () => {
    await mountPage(payload())
    expect(q().window).toBe(30)
  })

  it('switching to 90d re-asks on the same parameter, and moves nothing else', async () => {
    const w = await mountPage(payload())
    const before = { month: q().month, from: q().from, to: q().to }
    await w.find('[data-testid="window-90"]').trigger('click')
    await flushPromises()
    expect(q().window).toBe(90)
    // The PAGE window is untouched — that is the invariant #237's retirement was
    // really protecting, and the restoration keeps it.
    expect({ month: q().month, from: q().from, to: q().to }).toEqual(before)
  })

  it('draws the trailing series, which reaches back into the previous month', async () => {
    const w = await mountPage(payload())
    const stack = w.find('[data-testid="stacked-bars-stub"]')
    expect(stack.attributes('data-window-days')).toBe('30')
    // The page window is August. A July day on this chart can only have come
    // from the burn block — folding the chart back onto the page window loses it.
    expect(stack.attributes('data-days')).toContain('2026-07-28')
  })

  it('discloses the second window the way /usage does — the same sentence', async () => {
    /*
     * "Two windows on one page is only a defect when one of them is SILENT."
     * The card names its own period and carries the (i) sentence verbatim, so
     * the reader is never left to infer which period a figure covers.
     */
    const card = (await mountPage(payload())).find('[data-testid="burn-card"]')
    expect(card.text()).toContain('trailing 30d')
    expect(card.text()).toContain('Rolls with the days — independent of the month presets above.')
  })
})
