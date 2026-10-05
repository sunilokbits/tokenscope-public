// @vitest-environment happy-dom
/*
 * T10 (developer pages build D13, fix 12): the developer pages replace their
 * plain-text "Loading…" with ReportSkeleton — the SAME pending signal the
 * reporting scopes use, and the one parity-shots' settle() keys on:
 * skeleton gone + rendered money ⇒ the body is real.
 *
 * Each page is pinned both ways:
 *   - PENDING  → `report-skeleton` present, no "Loading…" prose;
 *   - DATA     → `report-skeleton` absent AND the settle() predicate holds
 *                (/\$\d/ somewhere in the body).
 *
 * The fourth developer page (`/reporting/teammate/[id]`) does not exist until
 * W4 (D31); it mounts ReportSkeleton on creation.
 *
 * Mounting idiom: my-projects-list.test.ts / project-lane-disclosure.test.ts /
 * consumption-one-scalar.test.ts (stub Nuxt auto-import globals, pass-through
 * UI-kit stubs, wrap in <Suspense>).
 *
 * MUTATIONS these pin: revert any page's skeleton swap back to the Loading…
 * div → that page's pending test goes red; render the skeleton outside the
 * pending branch → the data test goes red (settle() would never fire).
 */
import { describe, it, expect, vi, afterEach } from 'vitest'
import { defineComponent, ref, computed, type Ref } from 'vue'
import { mount, flushPromises, type VueWrapper } from '@vue/test-utils'
import { stubServerClock } from '../../helpers/server-clock'
import ConsumptionPage from '../../../app/pages/usage/index.vue'
import ProjectsPage from '../../../app/pages/projects/index.vue'
import ProjectPage from '../../../app/pages/projects/[code].vue'

const SKELETON = '[data-testid="report-skeleton"]'
/** parity-shots settle(): no skeleton AND some rendered money on the page. */
const MONEY_RE = /\$\d/

const passThrough = (tag: string) => ({
  template: `<div data-stub="${tag}"><slot /><slot name="actions" /></div>`,
})

const STUBS = {
  UiPageHead: passThrough('page-head'),
  UiCard: passThrough('card'),
  UiEyebrow: passThrough('eyebrow'),
  UiBadge: passThrough('badge'),
  UiButton: passThrough('button'),
  UiEmptyState: true,
  UiPbar: true,
  NuxtLink: passThrough('link'),
  UsageWindowToggle: true,
  // W3 (projects pages): window presets + chart primitives, stub-level only —
  // the shared panels mount real.
  DateRangeControl: { template: '<div data-testid="date-range-control" />' },
  ChartRankedBar: true,
  // Renders its label (e.g. "$60.00 of $200.00 MTD") — the money the settle()
  // predicate looks for on the card list rides this component's label prop.
  ChartsUtilBar: { props: ['used', 'total', 'label'], template: '<div>{{ label }}</div>' },
  ChartsStackedBars: true,
  ChartsTrendArea: true,
  ChartsDonutChart: true,
  MeLensDisclosure: true,
  ReportingLaneToggle: true,
  SessionDetailDrawer: true,
  ActivityDetailDrawer: true,
}

const FORMAT_MOCKS = {
  fmtUsd: (n: number | string | null | undefined) =>
    n == null || n === '' || !Number.isFinite(Number(n))
      ? '—'
      : `$${Number(n).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`,
  fmtTokens: (n: number) => String(n),
  fmtTimeAgo: () => 'just now',
}

function stubGlobals(fetchState: { data: Ref<unknown>; pending: Ref<boolean> }) {
  vi.stubGlobal('fmtUsd', FORMAT_MOCKS.fmtUsd)
  vi.stubGlobal('fmtPct', (v: number) => `${Math.round(v * 100)}%`)
  vi.stubGlobal('fmtTokens', FORMAT_MOCKS.fmtTokens)
  vi.stubGlobal('fmtTimeAgo', FORMAT_MOCKS.fmtTimeAgo)
  vi.stubGlobal('useReportState', () => ({
    month: ref<string | null>(null),
    from: ref<string | null>(null),
    to: ref<string | null>(null),
    // The drill FRAME key (W4 D16/D30) — the project page reads it to echo the
    // entry scope on its reports-depth arm.
    src: ref<string | null>(null),
    patch: vi.fn(),
  }))
  vi.stubGlobal('useSession', () => ({
    session: ref({ teammateId: 't1', displayName: 'Priya' }),
    ensure: async () => {},
  }))
  vi.stubGlobal('useRoute', () => ({ params: { code: 'ACME-1' }, query: {} }))
  vi.stubGlobal('usePersonalLens', () => ref<'usage' | 'chargeback'>('usage'))
  vi.stubGlobal('useRefreshOnVisible', () => {})
  stubServerClock()
  vi.stubGlobal('usePersonalLens', () => ref<'usage' | 'chargeback'>('usage'))
  vi.stubGlobal('useFetch', (_url: string, _opts?: { query?: { value?: Record<string, unknown> } }) => {
    // Touch the reactive query the /usage page passes, like the real useFetch.
    void computed(() => _opts?.query?.value ?? {}).value
    return { data: fetchState.data, pending: fetchState.pending, error: ref(null), refresh: vi.fn() }
  })
}

async function mountPage(Page: unknown, fetchState: { data: Ref<unknown>; pending: Ref<boolean> }) {
  stubGlobals(fetchState)
  const Parent = defineComponent({
    components: { Page: Page as ReturnType<typeof defineComponent> },
    template: '<Suspense><Page /></Suspense>',
  })
  const w = mount(Parent, { global: { stubs: STUBS, mocks: FORMAT_MOCKS } })
  await flushPromises()
  return w
}

function expectSettled(w: VueWrapper) {
  expect(w.find(SKELETON).exists()).toBe(false)
  expect(MONEY_RE.test(w.text())).toBe(true)
}

afterEach(() => vi.unstubAllGlobals())

// ── /projects (list) ─────────────────────────────────────────────────────────

const projectCard = {
  id: 'p1',
  code: 'ACME-1',
  display_name: 'Acme Platform',
  type: 'billable',
  wbs_code: null,
  end_date: null,
  ended: false,
  member_count: 3,
  mtd_cost_usd: '60.00',
  allocation_usd: '200.00',
  utilisation: 0.3,
  projected_exhaustion_date: null,
  velocity: { current_week_usd: '20.00', trailing_mean_usd: '15.00', delta_pct: 0.33, is_flagged: false },
  // W3 D25/D26 legs.
  mine_mtd_usd: '20.00',
  spark: [],
}

describe('/projects — ReportSkeleton replaces Loading… (D13)', () => {
  it('renders the skeleton while pending, with no Loading prose', async () => {
    const w = await mountPage(ProjectsPage, { data: ref(null), pending: ref(true) })
    expect(w.find(SKELETON).exists()).toBe(true)
    expect(w.text()).not.toContain('Loading…')
  })

  it('renders NO skeleton once data is in — settle() holds', async () => {
    const w = await mountPage(ProjectsPage, {
      data: ref({ projects: [projectCard], total: 1, untagged_usd: '0.00' }),
      pending: ref(false),
    })
    expectSettled(w)
  })
})

// ── /projects/[code] (member depth) ──────────────────────────────────────────

const projectPayload = {
  project: { id: 'p1', code: 'ACME-1', display_name: 'Acme Platform', type: 'billable', wbs_code: null, end_date: null, ended: false },
  viewer: { role: 'member', access: 'member', budget_allocation_id: null },
  window: {
    from: '2026-08-01',
    to: '2026-08-31',
    is_month: true,
    month: '2026-08',
    days_elapsed: 10,
    days_in_window: 31,
  },
  budget: { window_cost_usd: '165.00', allocation_usd: '500.00' },
  velocity: { current_week_usd: '10.00', trailing_mean_usd: '10.00', delta_pct: 0, is_flagged: false },
  series_by_model: [],
  mix: { by_model: [], by_activity: [] },
  hero: {
    active_members: 1,
    assigned_members: 2,
    deltas: {
      basis: 'vs last month',
      empty_reason: 'too early to compare',
      spend_pct: null,
      burn_pct: null,
      active_members_abs: null,
      untagged_pct: null,
    },
  },
  lane_coverage: {
    otel_usd: '120.00',
    reconciled_usd: '45.00',
    provisional_withheld_usd: '0.00',
    member_ingest_only_usd: '0.00',
    member_ingest_only_tools: [],
  },
  team: { members: [], member_count: 2, concentration_top2_share: null },
  untagged_pressure: { conversations: 0, cost_usd: '0.00', tokens: 0 },
  page_freshness: { aggregate_minutes_ago: 14 },
  providerStates: [{ vendor: 'anthropic', state: 'estimated', closeRun: false }],
  coverage: null,
}

describe('/projects/[code] — ReportSkeleton replaces Loading… (D13)', () => {
  it('renders the skeleton while pending, with no Loading prose', async () => {
    const w = await mountPage(ProjectPage, { data: ref(null), pending: ref(true) })
    expect(w.find(SKELETON).exists()).toBe(true)
    expect(w.text()).not.toContain('Loading…')
  })

  it('renders NO skeleton once data is in — settle() holds', async () => {
    const w = await mountPage(ProjectPage, { data: ref(projectPayload), pending: ref(false) })
    expectSettled(w)
  })
})

// ── /usage (self depth) ──────────────────────────────────────────────────────

const runRate = (mtd: string) => ({
  projected_month_end_usd: (Number(mtd) * 2).toFixed(2),
  days_elapsed: 15,
  days_in_month: 31,
  method: 'linear-mtd',
  is_projection: true,
})

const usagePayload = {
  headline: {
    lane: 'usage',
    month: '2026-07',
    mtd_usd: '6846.35',
    run_rate: runRate('6846.35'),
    quota: {
      total_usd: '3100.00',
      base_allowance_usd: '100.00',
      allocation_usd: '3000.00',
      projection: { state: 'not-at-this-pace' },
    },
  },
  disclosure: {
    attributed_usage_usd: '6846.35',
    provider_reported_usd: '1449.70',
    chargeable_usd: '6.12',
    declared_personal: [],
    declared_personal_usage_usd: '0.00',
    tool_gaps: [],
  },
  month: {
    spend_usd: '6846.35',
    tokens: 8_800_000_000,
    quota_usd: '3100.00',
    base_allowance_usd: '100.00',
    allocation_usd: '3000.00',
    run_rate: runRate('6846.35'),
  },
  window_days: 30,
  series: [{ day: '2026-07-01', cost_usd: '10.00', tokens: 100 }],
  series_by_model: [],
  mix: {
    by_model: [{ model: 'claude-fable-5', tokens: 100, cost_usd: '2219.31' }],
    by_token_type: [],
    buckets: [],
    tagged_spend: [],
    unallocated: { total_cost_usd: '0.00', untagged_cost_usd: '0.00', needs_tagging_count: 0 },
  },
  cache: { read_tokens: 0, write_tokens: 0, input_tokens: 0, hit_ratio: null, savings_usd: null },
  aux: { main_tokens: 0, aux_tokens: 0, unknown_tokens: 0, aux_cost_usd: '0.00', aux_share: null },
  fidelity: { window_cost_usd: '2219.31', advisory_cost_usd: '0.00' },
  insights: [],
  freshness_minutes_ago: 630,
  aggregate_refreshed_minutes_ago: 0,
  provider_truth: { month: '2026-07', mtd_usd: '1449.70', run_rate: runRate('1449.70') },
  page_freshness: {
    telemetry_minutes_ago: 630,
    aggregate_minutes_ago: 0,
    provider_feed_minutes_ago: 95,
    worst_minutes_ago: 630,
  },
}

describe('/usage — ReportSkeleton replaces Loading… (D13)', () => {
  it('renders the skeleton while pending, with no Loading prose', async () => {
    const w = await mountPage(ConsumptionPage, { data: ref(null), pending: ref(true) })
    expect(w.find(SKELETON).exists()).toBe(true)
    expect(w.text()).not.toContain('Loading…')
  })

  it('renders NO skeleton once data is in — settle() holds', async () => {
    const w = await mountPage(ConsumptionPage, { data: ref(usagePayload), pending: ref(false) })
    expectSettled(w)
  })
})
