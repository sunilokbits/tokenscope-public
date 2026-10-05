// @vitest-environment happy-dom
/*
 * /projects/[code] — the chargeback lens (docs/design/project-chargeback-lens.md),
 * at member depth and reports depth. The payloads are stubs of the
 * `shared/reports/project-chargeback.ts` contract; the page must render the
 * lane the SERVER echoed, not the one the URL asked for.
 */
import { describe, it, expect, vi, afterEach } from 'vitest'
import { defineComponent, ref, type Ref } from 'vue'
import { mount, flushPromises } from '@vue/test-utils'
import { stubServerClock } from '../../helpers/server-clock'
import ProjectPage from '../../../app/pages/projects/[code].vue'
import type {
  MeProjectChargebackResponse,
  ProjectChargeback,
  ProjectChargebackMemberContributors,
  ProjectChargebackScopedContributors,
  ReportsProjectChargebackResponse,
} from '../../../shared/reports/project-chargeback'
import { PROJECT_LENS_COPY } from '../../../shared/usage/lens'

type Payload = Record<string, unknown>

const T1 = '9a1e0000-0000-4000-8000-000000000001'
const T2 = '9a1e0000-0000-4000-8000-000000000002'

const project = {
  id: '9a1e0000-0000-4000-8000-0000000000a1',
  code: 'ACME-1',
  display_name: 'Acme Platform',
  type: 'billable',
  wbs_code: null,
  end_date: null,
  ended: false,
}
const viewer = { role: 'member', access: 'member', budget_allocation_id: null }
const window = {
  from: '2026-08-01',
  to: '2026-08-31',
  is_month: true,
  month: '2026-08',
  days_elapsed: 10,
  days_in_window: 31,
}

const T3 = '9a1e0000-0000-4000-8000-000000000003'
const series = [
  { date: '2026-08-02', cost_usd: '60.00' },
  { date: '2026-08-05', cost_usd: '63.45' },
]
const settling = { vendor: 'anthropic', state: 'estimated', closeRun: false } as const

const memberBlock = (
  contributors: ProjectChargebackMemberContributors = {
    members: [
      { teammate_id: T1, display_name: 'Priya Iyer', email: 'priya@example.com', cost_usd: '80.00' },
      { teammate_id: T2, display_name: 'Ben Ali', email: 'ben@example.com', cost_usd: '30.00' },
      { teammate_id: T3, display_name: null, email: 'kim@example.com', cost_usd: '13.45' },
    ],
    member_count: 3,
  },
): ProjectChargeback<ProjectChargebackMemberContributors> => ({
  total_usd: '123.45',
  series,
  contributors,
  settling,
})

const memberChargeback = (): MeProjectChargebackResponse => ({
  project,
  viewer: { ...viewer, access: 'member' },
  window,
  lane: 'chargeback',
  chargeback: memberBlock(),
})

const memberUsage = (over: Payload = {}): Payload => ({
  project,
  viewer,
  window,
  budget: { window_cost_usd: '400.00', allocation_usd: '1000.00' },
  velocity: { current_week_usd: '10.00', trailing_mean_usd: '1.00', delta_pct: 2, is_flagged: true },
  series_by_model: [],
  burn: {
    window_days: 30,
    from: '2026-07-11',
    settled_to: '2026-08-09',
    to: '2026-08-10',
    series_by_model: [],
    advisory_cost_usd: '0.00',
    advisory_uncovered_days: 0,
    advisory_basis: 'otel-aggregate-all-identities',
  },
  mix: {
    by_model: [{ key: 'claude-fable-5', label: 'claude-fable-5', cost_usd: '400.00', tokens: 1, gap_reason: null }],
    by_activity: [{ activity: 'feature-dev', cost_usd: '400.00', tokens: 1 }],
  },
  hero: {
    active_members: 2,
    assigned_members: 2,
    deltas: { basis: 'vs last month', empty_reason: null, spend_pct: null, burn_pct: null, active_members_abs: null, untagged_pct: null },
  },
  lane_coverage: {
    otel_usd: '400.00',
    reconciled_usd: '0.00',
    provisional_withheld_usd: '0.00',
    member_ingest_only_usd: '0.00',
    member_ingest_only_tools: [],
  },
  team: { members: [], member_count: 2, concentration_top2_share: null },
  untagged_pressure: { conversations: 2, cost_usd: '20.00', tokens: 0 },
  page_freshness: { aggregate_minutes_ago: 5 },
  providerStates: [{ vendor: 'anthropic', state: 'estimated', closeRun: false }],
  coverage: null,
  lane: 'usage',
  ...over,
})

const reportsUsage = (): Payload => ({
  project: { id: project.id, code: project.code, display_name: project.display_name },
  admitted_by: 'region-wide',
  scope: { src: null },
  window,
  budget: { window_cost_usd: '400.00', allocation_usd: '0.00', burn_per_day_usd: '40.00' },
  mix: { by_model: [] },
  contribution: {
    named: [],
    remainder: { members: 0, label: 'Everyone else', cost_usd: '0.00' },
    rows_total_usd: '400.00',
  },
  meta: { providerStates: [], coverage: null },
  lane: 'usage',
})
const reportsChargeback = (canDrill = false): ReportsProjectChargebackResponse => ({
  project: { id: project.id, code: project.code, display_name: project.display_name },
  admitted_by: 'region-wide',
  scope: { src: null },
  window,
  lane: 'chargeback',
  chargeback: {
    total_usd: '123.45',
    series,
    contributors: {
      named: [{ teammate_id: T1, display_name: 'Priya Iyer', cost_usd: '100.00', is_active: true, can_drill: canDrill }],
      remainder: { members: 4, label: '4 members outside your scope', cost_usd: '23.45' },
      rows_total_usd: '123.45',
    } satisfies ProjectChargebackScopedContributors,
    settling,
  },
})

const STUBS = {
  UiPageHead: { template: '<div><slot name="actions" /></div>' },
  UiCard: { template: '<div><slot /></div>' },
  UiBadge: { template: '<span><slot /></span>' },
  UiEyebrow: { template: '<div><slot /></div>' },
  UiEmptyState: true,
  NuxtLink: { template: '<a><slot /></a>' },
  DateRangeControl: { template: '<div data-testid="date-range-control" />' },
  UsageWindowToggle: true,
  ChartsStackedBars: {
    props: ['rows', 'windowDays', 'endDay', 'partialDay'],
    template:
      '<div data-testid="cb-bars" :data-rows="rows.length" :data-end="endDay" :data-days="windowDays" :data-partial="partialDay" />',
  },
  ExportCsvButton: {
    props: ['endpoint', 'params', 'filename'],
    template: '<a data-testid="csv-export" :data-lane="params.lane" :data-filename="filename" />',
  },
}

const fmtUsd = (v: string | number) => `$${Number(v).toFixed(2)}`
const fmtPct = (v: number) => `${Math.round(v * 100)}%`
const fmtTokens = (v: number) => String(v)
const fmtTimeAgo = () => 'just now'

interface MountOpts {
  member: Payload | MeProjectChargebackResponse | null
  reports?: Payload | ReportsProjectChargebackResponse | null
  teammateGrant?: 'none' | 'people-scope'
  src?: string
  urlLane?: 'usage' | 'chargeback'
}

async function mountPage(opts: MountOpts) {
  const laneRef: Ref<'usage' | 'chargeback'> = ref(opts.urlLane ?? 'usage')
  const queries: Record<string, Record<string, unknown>> = {}
  vi.stubGlobal('fmtUsd', fmtUsd)
  vi.stubGlobal('fmtPct', fmtPct)
  vi.stubGlobal('fmtTokens', fmtTokens)
  vi.stubGlobal('fmtTimeAgo', fmtTimeAgo)
  vi.stubGlobal('useRoute', () => ({ params: { code: 'ACME-1' }, query: {} }))
  vi.stubGlobal('useSession', () => ({ session: ref({ teammateId: T1 }), ensure: async () => {} }))
  vi.stubGlobal('useReportState', () => ({
    month: ref<string | null>(null),
    from: ref<string | null>(null),
    to: ref<string | null>(null),
    src: ref<string | null>(opts.src ?? null),
    lane: ref('usage'),
    patch: vi.fn(),
  }))
  vi.stubGlobal('usePersonalLens', () => laneRef)
  stubServerClock()
  vi.stubGlobal(
    'useFetch',
    (url: string | (() => string), o?: { query?: { value?: Record<string, unknown> } }) => {
      const u = typeof url === 'function' ? url() : url
      if (u === '/api/v1/reports/meta') {
        return { data: ref({ drill: { teammate: opts.teammateGrant ?? 'none', project: 'region-wide' } }) }
      }
      const isReports = u.startsWith('/api/v1/reports/project/')
      if (o?.query) queries[isReports ? 'reports' : 'member'] = o.query as Record<string, unknown>
      if (isReports) {
        return { data: ref(opts.reports ?? null), pending: ref(false), error: ref(null), refresh: vi.fn() }
      }
      return {
        data: ref(opts.member),
        pending: ref(false),
        error: ref(opts.member ? null : { statusCode: 404 }),
        refresh: vi.fn(),
      }
    },
  )
  const Parent = defineComponent({
    components: { ProjectPage },
    template: '<Suspense><ProjectPage /></Suspense>',
  })
  const w = mount(Parent, { global: { stubs: STUBS, mocks: { fmtUsd, fmtPct, fmtTokens, fmtTimeAgo } } })
  await flushPromises()
  const queryOf = (k: 'member' | 'reports') => (queries[k] as unknown as { value: Record<string, unknown> }).value
  return { w, laneRef, queryOf }
}

/** Every §A-only card and tile the chargeback lens hides, at member depth. */
const MEMBER_USAGE_ONLY = [
  'project-hero-band',
  'velocity-flag',
  'burn-card',
  'proj-top-models',
  'proj-activity-strip',
  'untagged-pressure',
  'team-card',
]

afterEach(() => {
  vi.unstubAllGlobals()
})

describe('/projects/[code] — the lens toggle', () => {
  it('renders the toggle at member depth, attributed by default, with the project caption', async () => {
    const { w } = await mountPage({ member: memberUsage() })
    expect(w.find('[data-testid="lane-toggle"]').exists()).toBe(true)
    expect(w.find('[data-testid="lane-usage"]').attributes('aria-pressed')).toBe('true')
    expect(w.find('[data-testid="lane-caption"]').text()).toBe(PROJECT_LENS_COPY.usage.caption)
  })

  it('a click requests the chargeback lane, and the fetch query carries it', async () => {
    const { w, laneRef, queryOf } = await mountPage({ member: memberUsage() })
    expect(queryOf('member').lane).toBe('usage')
    await w.find('[data-testid="lane-chargeback"]').trigger('click')
    expect(laneRef.value).toBe('chargeback')
    expect(queryOf('member').lane).toBe('chargeback')
  })

  it('renders the lane the SERVER echoed, not the one the URL asked for', async () => {
    const legacy = memberUsage()
    delete legacy.lane
    const { w } = await mountPage({ member: legacy, urlLane: 'chargeback' })
    expect(w.find('[data-testid="lane-usage"]').attributes('aria-pressed')).toBe('true')
    expect(w.find('[data-testid="proj-chargeback"]').exists()).toBe(false)
    expect(w.find('[data-testid="project-hero-band"]').exists()).toBe(true)
  })
})

describe('/projects/[code] member depth — usage lane', () => {
  it('shows the §A cards and no chargeback body; the pill no longer says chargeback is impossible', async () => {
    const { w } = await mountPage({ member: memberUsage() })
    for (const id of MEMBER_USAGE_ONLY) expect(w.find(`[data-testid="${id}"]`).exists(), id).toBe(true)
    expect(w.find('[data-testid="proj-chargeback"]').exists()).toBe(false)
    expect(w.find('[data-testid="proj-lane-pill"]').text()).toBe('§A · attributed usage')
    expect(w.text()).not.toContain('never shows chargeback')
    expect(w.text()).toContain('Switch to Chargeback')
  })
})

describe('/projects/[code] member depth — chargeback lane', () => {
  it('shows the total with its settling label, the daily bars and the contributors', async () => {
    const { w } = await mountPage({ member: memberChargeback(), urlLane: 'chargeback' })
    expect(w.find('[data-testid="lane-chargeback"]').attributes('aria-pressed')).toBe('true')
    expect(w.find('[data-testid="lane-caption"]').text()).toBe(
      'Bill dollars split by what was tagged; untagged spend is on no project.',
    )
    expect(w.find('[data-testid="proj-cb-total"]').text()).toBe('$123.45')
    const chip = w.find('[data-testid="proj-cb-settling-anthropic"]')
    expect(chip.exists()).toBe(true)
    expect(chip.attributes('data-state')).toBe('estimated')
    expect(chip.text()).toContain('Estimated')

    const bars = w.find('[data-testid="cb-bars"]')
    expect(bars.attributes('data-rows')).toBe('2')
    // Day 10 of the month is still filling: the settled edge is the 9th.
    expect(bars.attributes('data-end')).toBe('2026-08-09')
    expect(bars.attributes('data-days')).toBe('9')
    expect(bars.attributes('data-partial')).toBe('2026-08-10')

    const named = w.findAll('[data-testid="proj-cb-contributor"]')
    expect(named.map((r) => r.text())).toEqual(['Priya Iyer$80.00', 'Ben Ali$30.00', 'kim@example.com$13.45'])
    expect(w.find('[data-testid="proj-cb-remainder"]').exists()).toBe(false)
    expect(w.find('[data-testid="proj-lane-pill"]').text()).toBe('§B · bill chargeback')
  })

  it('hides every §A-only card, with one line saying why', async () => {
    const { w } = await mountPage({ member: memberChargeback(), urlLane: 'chargeback' })
    for (const id of MEMBER_USAGE_ONLY) expect(w.find(`[data-testid="${id}"]`).exists(), id).toBe(false)
    expect(w.findAll('[data-testid^="tile-"]')).toHaveLength(0)
    expect(w.find('[data-testid="proj-cb-hidden-cards"]').text()).toContain('hidden under chargeback')
  })

  it('carries the Copilot and untagged notes', async () => {
    const { w } = await mountPage({ member: memberChargeback(), urlLane: 'chargeback' })
    expect(w.find('[data-testid="proj-cb-copilot-note"]').text()).toBe(
      'Copilot is billed per Business Unit, not per project.',
    )
    expect(w.find('[data-testid="proj-cb-untagged-note"]').text()).toBe(
      'Untagged spend is not on any project until it is tagged in the worklist.',
    )
  })

  it('the CSV export passes the lane through', async () => {
    const { w } = await mountPage({ member: memberChargeback(), urlLane: 'chargeback' })
    const csv = w.find('[data-testid="proj-cb-contributors"] [data-testid="csv-export"]')
    expect(csv.attributes('data-lane')).toBe('chargeback')
    expect(csv.attributes('data-filename')).toBe('tokenscope-project-ACME-1-team-chargeback-2026-08.csv')
  })

  it('a cou-owner gets the total over member_count, no named rows and no CSV export', async () => {
    const p = memberChargeback()
    p.viewer = { ...viewer, access: 'cou-owner' }
    p.chargeback = memberBlock({ members: [], member_count: 3 })
    const { w } = await mountPage({ member: p, urlLane: 'chargeback' })
    expect(w.find('[data-testid="proj-cb-contributors"]').exists()).toBe(true)
    expect(w.findAll('[data-testid="proj-cb-contributor"]')).toHaveLength(0)
    expect(w.find('[data-testid="proj-cb-remainder"]').text()).toBe('3 teammates$123.45')
    expect(w.find('[data-testid="csv-export"]').exists()).toBe(false)
  })
})

describe('/projects/[code] reports depth', () => {
  it('usage lane: the toggle renders and the pill no longer sends chargeback to the Finance tab', async () => {
    const { w } = await mountPage({ member: null, reports: reportsUsage() })
    expect(w.find('[data-testid="project-reports-band"]').exists()).toBe(true)
    expect(w.find('[data-testid="lane-toggle"]').exists()).toBe(true)
    expect(w.find('[data-testid="proj-reports-lane-pill"]').text()).toBe('§A · attributed usage')
    expect(w.text()).not.toContain('Finance tab')
    expect(w.find('[data-testid="proj-chargeback"]').exists()).toBe(false)
  })

  it('chargeback lane: total, notes and the server-labelled remainder; §A cards hidden', async () => {
    const { w, queryOf } = await mountPage({ member: null, reports: reportsChargeback(), urlLane: 'chargeback' })
    expect(queryOf('reports').lane).toBe('chargeback')
    expect(w.find('[data-testid="lane-chargeback"]').attributes('aria-pressed')).toBe('true')
    expect(w.find('[data-testid="proj-reports-lane-pill"]').text()).toBe('§B · bill chargeback')
    expect(w.find('[data-testid="proj-cb-total"]').text()).toBe('$123.45')
    const named = w.findAll('[data-testid="proj-cb-contributor"]')
    expect(named.map((r) => r.text())).toEqual(['Priya Iyer$100.00'])
    expect(named[0]!.find('[data-testid="drill-plain"]').exists()).toBe(true)
    expect(w.find('[data-testid="proj-cb-remainder"]').text()).toBe('4 members outside your scope$23.45')
    expect(w.find('[data-testid="proj-cb-copilot-note"]').exists()).toBe(true)
    expect(w.find('[data-testid="proj-cb-untagged-note"]').exists()).toBe(true)
    for (const id of [
      'project-reports-band',
      'project-reports-allocation',
      'project-reports-burn',
      'project-reports-models',
      'project-reports-contribution',
    ]) {
      expect(w.find(`[data-testid="${id}"]`).exists(), id).toBe(false)
    }
    expect(w.find('[data-testid="proj-cb-hidden-cards"]').exists()).toBe(true)
  })

  it('chargeback lane: a named row links only where the server says can_drill', async () => {
    const { w } = await mountPage({
      member: null,
      reports: reportsChargeback(true),
      urlLane: 'chargeback',
      teammateGrant: 'people-scope',
      src: 'cc:9a1e0000-0000-4000-8000-0000000000c1',
    })
    const row = w.find('[data-testid="proj-cb-contributor"]')
    expect(row.find('[data-testid="drill-link"]').exists()).toBe(true)
    expect(w.find('[data-testid="proj-cb-remainder"] [data-testid="drill-link"]').exists()).toBe(false)

    const denied = await mountPage({
      member: null,
      reports: reportsChargeback(false),
      urlLane: 'chargeback',
      teammateGrant: 'people-scope',
      src: 'cc:9a1e0000-0000-4000-8000-0000000000c1',
    })
    expect(denied.w.find('[data-testid="proj-cb-contributor"] [data-testid="drill-link"]').exists()).toBe(false)
  })
})
