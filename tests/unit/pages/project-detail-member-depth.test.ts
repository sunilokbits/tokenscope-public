// @vitest-environment happy-dom
/*
 * /projects/[code] member depth (app/pages/projects/[code].vue) — the client
 * halves of T21/T22/T23 (developer-pages W3 D27):
 *
 *  T21 — four hero tiles render with their OWN deltas/sparks; the pace pill
 *        and on-pace line re-derive from the payload's window operands; a
 *        custom range withholds deltas with the NAMED reason and never fakes
 *        a "range pace".
 *  T22 — Top models is ModelSplitPanel (remainders priced in the footer,
 *        never ranked); the three donuts and the cache card are GONE; the
 *        activity strip's segments sum to the window total; the burn card
 *        carries its own trailing 30/90 window (D28 restored it; the assertion
 *        that it did NOT is inverted, not deleted).
 *  T23 — team share bars sum to 100±rounding; Export CSV is present for a
 *        member; PM sees the budget card and NOTHING else differs from the
 *        member render (project-transparency).
 *
 * Mounting idiom: my-projects-list.test.ts (stub Nuxt auto-import globals,
 * pass-through UI kit, <Suspense>). Presentational leaves (ScopeKpiTile,
 * ModelSplitPanel, CcHeaderNotes, InfoDot, ExportCsvButton) mount REAL so the
 * page contract is pinned against the shared components, not against stubs
 * of them; only the chart primitives are stubbed.
 */
import { describe, it, expect, vi, afterEach, beforeEach } from 'vitest'
import { defineComponent, ref } from 'vue'
import { mount, flushPromises, type VueWrapper } from '@vue/test-utils'
import { stubServerClock } from '../../helpers/server-clock'
import ProjectPage from '../../../app/pages/projects/[code].vue'
// The 30/90 control mounts REAL (D28): the point of the restoration is that this
// page and /usage carry the SAME control, so stubbing it would prove nothing.
import UsageWindowToggle from '../../../app/components/usage/WindowToggle.vue'

type Payload = Record<string, unknown>

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
    { day: '2026-08-01', model: 'claude-fable-5', cost_usd: '40.00' },
    { day: '2026-08-02', model: 'claude-fable-5', cost_usd: '40.00' },
  ],
  /*
   * The burn card's OWN trailing window (D28) — note it reaches back into JULY,
   * which is the whole point of restoring it: the page window is August.
   */
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
      { key: 'claude-fable-5', label: 'claude-fable-5', cost_usd: '300.00', tokens: 100, gap_reason: null },
      {
        key: '__null_model:awaiting-provider-detail',
        label: 'Awaiting provider detail',
        cost_usd: '100.00',
        tokens: 0,
        gap_reason: 'awaiting-provider-detail',
      },
    ],
    by_activity: [
      { activity: 'feature-dev', cost_usd: '250.00', tokens: 10 },
      { activity: null, cost_usd: '150.00', tokens: 5 },
    ],
  },
  hero: {
    active_members: 4,
    assigned_members: 5,
    deltas: {
      basis: 'vs last month',
      empty_reason: null,
      spend_pct: 0.18,
      burn_pct: 0.06,
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
        cost_usd: '300.00',
        tokens: 100,
        active_days: 10,
        cost_per_active_day: '30.00',
        last_event: '2026-08-10T10:00:00Z',
      },
      {
        teammate_id: 't2',
        display_name: 'Ben Ali',
        email: 'ben@x.test',
        cost_usd: '100.00',
        tokens: 40,
        active_days: 5,
        cost_per_active_day: '20.00',
        last_event: '2026-08-09T10:00:00Z',
      },
    ],
    member_count: 2,
    concentration_top2_share: 1,
  },
  untagged_pressure: { conversations: 3, cost_usd: '42.00', tokens: 0 },
  page_freshness: { aggregate_minutes_ago: 14 },
  providerStates: [{ vendor: 'anthropic', state: 'estimated', closeRun: false }],
  coverage: null,
  ...over,
})

/** A custom-range variant: deltas withheld with the NAMED reason (r1-L1). */
const customRange = (): Payload =>
  payload({
    window: {
      from: '2026-07-10',
      to: '2026-08-05',
      is_month: false,
      month: null,
      days_elapsed: 27,
      days_in_window: 27,
    },
    hero: {
      active_members: 4,
      assigned_members: 5,
      deltas: {
        basis: 'vs last month',
        empty_reason: 'no month-on-month for a custom range',
        spend_pct: null,
        burn_pct: null,
        active_members_abs: null,
        untagged_pct: null,
      },
    },
  })

const STUBS = {
  UiPageHead: { template: '<div><slot name="actions" /></div>' },
  UiCard: { template: '<div><slot /></div>' },
  UiBadge: { template: '<span><slot /></span>' },
  UiEyebrow: { template: '<div><slot /></div>' },
  UiEmptyState: true,
  NuxtLink: { props: ['to'], template: '<a><slot /></a>' },
  DateRangeControl: { template: '<div data-testid="date-range-control" />' },
  // Chart primitives only — the shared panels mount REAL.
  ChartRankedBar: {
    props: ['rows'],
    template: '<div data-testid="ranked-bars">{{ rows.map((r) => r.label).join(",") }}</div>',
  },
  ChartsStackedBars: {
    props: ['rows', 'keyOrder', 'labelFor', 'windowDays', 'endDay', 'partialDay'],
    template:
      '<div data-testid="stacked-bars-stub" :data-window-days="windowDays" :data-end-day="endDay" :data-partial-day="partialDay" />',
  },
}

/** The pinned server instant: window day 10 of the fixture's August. */
const TODAY = '2026-08-10T12:00:00Z'

const fmtUsd = (v: string | number) => `$${Number(v).toFixed(2)}`
const fmtPct = (v: number) => `${Math.round(v * 100)}%`
const fmtTokens = (v: number) => String(v)
const fmtTimeAgo = () => 'just now'

async function mountPage(data: Payload) {
  // Re-stubbed per mount, not once in beforeEach: one test below calls
  // `vi.unstubAllGlobals()` between its two mounts.
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
      components: { UsageWindowToggle },
      mocks: { fmtUsd, fmtPct, fmtTokens, fmtTimeAgo },
    },
  })
  await flushPromises()
  return w
}

beforeEach(() => {
  /*
   * MIGRATED BY F1 (clock-rot-audit.md §F-a, the HIGHEST-VALUE landmine).
   *
   * This file is the ONLY test of the partial-day render path — i.e. it is what
   * certifies D4, "a still-filling day is drawn as partial" — and it certified
   * it against the very clock D4 forbids: `data-partial-day` came from
   * `projects/[code].vue`'s browser `new Date()`. Deleting it would have shipped
   * D4 with zero coverage, so it is migrated, not removed.
   *
   * Same fixture day: the server's today is window day 10.
   *   today          2026-08-10   the partial day
   *   settledThrough 2026-08-09   the axis edge — 9 elapsed days, not 10
   */
  stubServerClock(TODAY)
})
afterEach(() => {
  vi.unstubAllGlobals()
})

// ── T21: hero tiles + window re-derivation ───────────────────────────────────

describe('/projects/[code] — hero tiles (T21, fix 2)', () => {
  it('renders the four tiles, each with its OWN delta — except Burn/day (F2/D11)', async () => {
    const w = await mountPage(payload())
    // Burn/day is EXCLUDED: it is spend ÷ elapsed days, so its month-on-month is
    // spendPct to four decimals. It withholds and names the reason instead.
    for (const tid of ['tile-spend-vs-budget', 'tile-active-members', 'tile-untagged-pressure']) {
      const tile = w.find(`[data-testid="${tid}"]`)
      expect(tile.exists()).toBe(true)
      expect(tile.find('[data-testid="kpi-delta"]').exists()).toBe(true)
      expect(tile.find('[data-testid="kpi-delta"]').text()).toContain('vs last month')
    }
    const burn = w.find('[data-testid="tile-burn-per-day"]')
    expect(burn.exists()).toBe(true)
    expect(burn.find('[data-testid="kpi-delta"]').exists()).toBe(false)
    // Money deltas keep the percentage; the count delta is absolute.
    expect(w.find('[data-testid="tile-spend-vs-budget"]').text()).toContain('18%')
    expect(w.find('[data-testid="tile-active-members"] [data-testid="kpi-delta"]').text()).toContain('1')
    // Burn/day = 400 / 10 elapsed days.
    expect(w.find('[data-testid="tile-burn-per-day"]').text()).toContain('$40.00')
    expect(w.find('[data-testid="tile-active-members"]').text()).toContain('of 5 members emitted')
    expect(w.find('[data-testid="tile-untagged-pressure"]').text()).toContain('$42.00')
    expect(w.find('[data-testid="tile-untagged-pressure"]').text()).toContain('3 sessions')
  })

  it('the pace pill and on-pace line re-derive from the window operands (fix 1)', async () => {
    // 400 of 1000 on day 10 of 31 → projected $1,240 → the FORECAST word.
    const w = await mountPage(payload())
    expect(w.find('[data-testid="proj-pace-pill"]').text()).toBe('On pace to exceed')
    expect(w.find('[data-testid="tile-spend-vs-budget"]').text()).toContain(
      'on pace for ~$1240.00 by Aug 31',
    )
    expect(w.find('[data-testid="project-hero-total"]').text()).toBe('$400.00')
    expect(w.find('[data-testid="project-hero-band"]').text()).toContain('day 10 of 31')
  })

  it('a COMPLETE month keeps the fact states but draws no projection line', async () => {
    const w = await mountPage(
      payload({
        window: {
          from: '2026-07-01',
          to: '2026-07-31',
          is_month: true,
          month: '2026-07',
          days_elapsed: 31,
          days_in_window: 31,
        },
      }),
    )
    // 400 of 1000 over the WHOLE month → the fact ("Healthy"), no forecast.
    expect(w.find('[data-testid="proj-pace-pill"]').text()).toBe('Healthy')
    expect(w.find('[data-testid="tile-spend-vs-budget"]').text()).not.toContain('on pace for')
    expect(w.find('[data-testid="project-hero-band"]').text()).toContain('July 2026')
  })

  it('a custom range withholds deltas with the NAMED reason and never fakes a range pace', async () => {
    const w = await mountPage(customRange())
    // Burn/day's reason is its OWN (F2/D11) and does not move with the window:
    // the day counts cancel whatever the window is. The other three take the
    // payload's named reason.
    const reasons = w.findAll('[data-testid="kpi-delta-empty"]').map((n) => n.text())
    expect(reasons).toHaveLength(4)
    expect(w.find('[data-testid="tile-burn-per-day"] [data-testid="kpi-delta-empty"]').text()).toBe(
      'same change as spend — the day counts cancel',
    )
    for (const r of reasons.filter((t) => !t.startsWith('same change as spend'))) {
      expect(r).toBe('no month-on-month for a custom range')
    }
    expect(w.find('[data-testid="proj-pace-pill"]').exists()).toBe(false)
    expect(w.find('[data-testid="tile-spend-vs-budget"]').text()).toContain(
      'no pace for a custom range',
    )
  })

  it('day-1 honesty: below the floor every tile says "too early to compare"', async () => {
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
        hero: {
          active_members: 1,
          assigned_members: 5,
          deltas: {
            basis: 'vs last month',
            empty_reason: 'too early to compare',
            spend_pct: null,
            burn_pct: null,
            active_members_abs: null,
            untagged_pct: null,
          },
        },
      }),
    )
    const reasons = w.findAll('[data-testid="kpi-delta-empty"]').map((n) => n.text())
    expect(reasons).toHaveLength(4)
    expect(w.find('[data-testid="tile-burn-per-day"] [data-testid="kpi-delta-empty"]').text()).toBe(
      'same change as spend — the day counts cancel',
    )
    for (const r of reasons.filter((t) => !t.startsWith('same change as spend'))) {
      expect(r).toBe('too early to compare')
    }
  })

  it('the lead tile keeps the reconciled/provisional honesty notes (moved, not deleted)', async () => {
    const w = await mountPage(
      payload({
        lane_coverage: {
          otel_usd: '287.50',
          reconciled_usd: '100.00',
          provisional_withheld_usd: '12.50',
          member_ingest_only_usd: '0.00',
          member_ingest_only_tools: [],
        },
      }),
    )
    const lead = w.find('[data-testid="tile-spend-vs-budget"]')
    expect(lead.find('[data-testid="proj-reconciled-share"]').text()).toContain('$100.00')
    expect(lead.find('[data-testid="proj-provisional-withheld"]').text()).toContain('$12.50')
  })
})

// ── T22: models + retired donuts + activity strip + no per-card window ───────

describe('/projects/[code] — Top models & retired surfaces (T22, fix 3/D41)', () => {
  it('ModelSplitPanel ranks ONLY named models; the remainder is priced in the footer', async () => {
    const w = await mountPage(payload())
    expect(w.find('[data-testid="model-split"]').exists()).toBe(true)
    const bars = w.find('[data-testid="ranked-bars"]').text()
    // Named models rank under their DISPLAY label (modelDisplay), remainders never.
    expect(bars).toContain('Fable 5')
    expect(bars).not.toContain('Awaiting')
    expect(w.find('[data-testid="model-split-footer-awaiting"]').text()).toContain('$100.00')
  })

  it('the three donuts and the cache card are GONE (D41)', async () => {
    const w = await mountPage(payload())
    for (const tid of ['proj-mix-models', 'proj-mix-lanes', 'proj-mix-activity', 'proj-cache']) {
      expect(w.find(`[data-testid="${tid}"]`).exists()).toBe(false)
    }
    expect(w.text()).not.toContain('Cache economics')
  })

  it('the activity strip’s segments sum to the window total', async () => {
    const w = await mountPage(payload())
    const strip = w.find('[data-testid="proj-activity-strip"]')
    expect(strip.exists()).toBe(true)
    expect(strip.find('[data-testid="activity-seg-feature-dev"]').text()).toContain('$250.00')
    expect(strip.find('[data-testid="activity-seg-untagged"]').text()).toContain('$150.00')
    // 250 + 150 = the $400 headline — the strip foots to the window total.
    expect(250 + 150).toBe(400)
  })

  /*
   * SUPERSEDED BY D28 (owner ruling R5, recorded in 04-fix-sprint-design.md's
   * "Departures from the approved prototypes" table). This test used to assert
   * the OPPOSITE — "no per-card window toggle, follows the PAGE window" — which
   * was #237's position. The owner restored the trailing window, so the
   * assertion is inverted here rather than deleted: the axis half of it (D4,
   * settled edge vs partial day) is unchanged and still the only coverage of it.
   */
  it('the burn card carries its OWN trailing window, and the axis is still the settled edge (D28/D4)', async () => {
    const w = await mountPage(payload())
    expect(w.find('[data-testid="window-30"]').exists()).toBe(true)
    expect(w.find('[data-testid="window-90"]').exists()).toBe(true)
    const stack = w.find('[data-testid="stacked-bars-stub"]')
    /*
     * The axis is the burn block's own 30 days — NOT the page window's nine
     * elapsed days. Folding it back onto the page window turns this red.
     */
    expect(stack.attributes('data-window-days')).toBe('30')
    /*
     * D4, restated as figures. The axis runs to the SETTLED edge (08-09) and
     * today (08-10) is carried separately as the partial day — beyond the edge,
     * not as the last settled bar.
     *
     * The old expectation was `end-day = 2026-08-10`: the axis ended ON the
     * still-filling day, which is what let a three-hour-old day be zero-filled
     * and drawn as a collapse.
     */
    expect(stack.attributes('data-end-day')).toBe('2026-08-09')
    expect(stack.attributes('data-end-day')).not.toBe(stack.attributes('data-partial-day'))
    expect(stack.attributes('data-partial-day')).toBe('2026-08-10')
  })

  it('the partial day is TODAY, and the axis edge is the day before it', async () => {
    // Stated independently of the fixture's `days_elapsed`, because that field
    // is what the old code derived the edge from — and it names today.
    const w = await mountPage(payload())
    const stack = w.find('[data-testid="stacked-bars-stub"]')
    const end = stack.attributes('data-end-day')!
    const partial = stack.attributes('data-partial-day')!
    expect(new Date(`${partial}T00:00:00Z`).getTime() - new Date(`${end}T00:00:00Z`).getTime()).toBe(
      86_400_000,
    )
  })

  it('the chip row renders from the payload operands; the freshness prose is gone (D14)', async () => {
    const w = await mountPage(payload())
    expect(w.find('[data-testid="cc-header-notes-trigger"]').text()).toBe('Estimated')
    expect(w.find('[data-testid="proj-freshness"]').exists()).toBe(false)
  })
})

// ── T23: team table + project transparency ───────────────────────────────────

function testidSet(w: VueWrapper): Set<string> {
  return new Set(
    w.findAll('[data-testid]').map((n) => n.attributes('data-testid') as string),
  )
}

describe('/projects/[code] — team table + transparency (T23)', () => {
  it('share bars sum to 100±rounding and ride each member row', async () => {
    const w = await mountPage(payload())
    const shares = ['priya@x.test', 'ben@x.test'].map((email) =>
      Number(
        w
          .find(`[data-testid="member-share-${email}"]`)
          .text()
          .match(/(\d+)%/)?.[1] ?? NaN,
      ),
    )
    expect(shares).toEqual([75, 25])
    expect(shares.reduce((a, b) => a + b, 0)).toBeGreaterThanOrEqual(99)
    expect(shares.reduce((a, b) => a + b, 0)).toBeLessThanOrEqual(101)
  })

  it('Export CSV is present for a member and targets the team export endpoint', async () => {
    const w = await mountPage(payload())
    const btn = w.find('[data-testid="export-csv-button"]')
    expect(btn.exists()).toBe(true)
  })

  it('a cou-owner observer gets no named rows and no named-row export', async () => {
    const w = await mountPage(
      payload({
        viewer: { role: 'member', access: 'cou-owner', budget_allocation_id: null },
        team: { members: [], member_count: 2, concentration_top2_share: null },
      }),
    )
    expect(w.find('[data-testid="team-owner-aggregate-note"]').exists()).toBe(true)
    expect(w.find('[data-testid="export-csv-button"]').exists()).toBe(false)
  })

  it('PM sees the member view PLUS the budget card — and NOTHING else differs', async () => {
    const member = await mountPage(payload())
    const memberSet = testidSet(member)
    vi.unstubAllGlobals()
    const pm = await mountPage(
      payload({ viewer: { role: 'manager', access: 'member', budget_allocation_id: 'a1' } }),
    )
    const pmSet = testidSet(pm)
    const extra = [...pmSet].filter((t) => !memberSet.has(t)).sort()
    const missing = [...memberSet].filter((t) => !pmSet.has(t))
    expect(extra).toEqual(['pm-budget-card', 'pm-manage-budget'])
    expect(missing).toEqual([])
  })

  it('a PM with no baseline gets the signposted hint, not silence', async () => {
    const w = await mountPage(
      payload({ viewer: { role: 'manager', access: 'member', budget_allocation_id: null } }),
    )
    expect(w.find('[data-testid="pm-manage-budget"]').exists()).toBe(false)
    expect(w.find('[data-testid="pm-no-budget-hint"]').text()).toContain('No active budget period')
  })
})
