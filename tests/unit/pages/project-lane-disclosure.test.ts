// @vitest-environment happy-dom
/*
 * /projects/[code] (app/pages/projects/[code].vue) — the ON-SCREEN half of the
 * one-lane slice. The server work is worthless if the page silently swallows
 * what it cannot count, so each of these pins a disclosure the payload
 * carries:
 *
 *   1. arm 3 gets its OWN labelled bucket and never enters the headline;
 *   2. the reconciled share of the headline is named (it has no model split
 *      inline and it is the part the old aggregate-backed figure never had);
 *   3. a NAMED filter that changes a manager's number says so.
 *
 * Since developer-pages W3 D27 the reconciled/provisional notes live in the
 * LEAD HERO TILE's footer (moved from the retired budget band — same testids,
 * same visibility) and the headline is `project-hero-total`. The old
 * worst-of-sources freshness PROSE is retired for the CcHeaderNotes chip row
 * (D14) — pinned in project-detail-member-depth.test.ts, not here.
 *
 * Same mounting idiom as project-detail-member-depth.test.ts.
 */
import { describe, it, expect, vi, afterEach, beforeEach } from 'vitest'
import { defineComponent, ref } from 'vue'
import { mount, flushPromises } from '@vue/test-utils'
import { stubServerClock } from '../../helpers/server-clock'
import ProjectPage from '../../../app/pages/projects/[code].vue'

const payload = (over: Record<string, unknown> = {}) => ({
  project: {
    id: 'p1',
    code: 'ACME-1',
    display_name: 'Acme Platform',
    type: 'billable',
    wbs_code: null,
    end_date: null,
    ended: false,
  },
  viewer: { role: 'manager', access: 'member', budget_allocation_id: 'a1' },
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
  ...over,
})

const STUBS = {
  UiPageHead: { template: '<div><slot name="actions" /></div>' },
  UiCard: { template: '<div><slot /></div>' },
  UiBadge: { template: '<span><slot /></span>' },
  UiEyebrow: { template: '<div><slot /></div>' },
  UiEmptyState: true,
  NuxtLink: { template: '<a><slot /></a>' },
  DateRangeControl: { template: '<div data-testid="date-range-control" />' },
  ChartRankedBar: true,
  ChartsStackedBars: true,
}

const fmtUsd = (v: string | number) => `$${Number(v).toFixed(2)}`
const fmtPct = (v: number) => `${Math.round(v * 100)}%`
const fmtTokens = (v: number) => String(v)
const fmtTimeAgo = () => 'just now'

async function mountPage(data: Record<string, unknown>) {
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
  stubServerClock()
  vi.stubGlobal('usePersonalLens', () => ref<'usage' | 'chargeback'>('usage'))
  vi.stubGlobal('useFetch', () => ({ data: ref(data), pending: ref(false), error: ref(null) }))
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

beforeEach(() => {
  vi.useFakeTimers({ toFake: ['Date'], now: new Date('2026-08-10T12:00:00Z') })
})
afterEach(() => {
  vi.useRealTimers()
  vi.unstubAllGlobals()
})

describe('/projects/[code] — lane disclosures', () => {
  it('names the reconciled share of the headline (in the lead tile)', async () => {
    const w = await mountPage(payload())
    const el = w.find('[data-testid="proj-reconciled-share"]')
    expect(el.exists()).toBe(true)
    expect(el.text()).toContain('$45.00')
    expect(el.text()).toContain('reconciled from provider usage')
    // It rides the LEAD tile, beside the number it explains.
    expect(w.find('[data-testid="tile-spend-vs-budget"] [data-testid="proj-reconciled-share"]').exists()).toBe(true)
  })

  it('omits the reconciled line when the whole headline is emitted telemetry', async () => {
    const w = await mountPage(
      payload({
        lane_coverage: {
          otel_usd: '165.00',
          reconciled_usd: '0.00',
          provisional_withheld_usd: '0.00',
          member_ingest_only_usd: '0.00',
          member_ingest_only_tools: [],
        },
      }),
    )
    expect(w.find('[data-testid="proj-reconciled-share"]').exists()).toBe(false)
  })

  it('gives arm-3 spend its OWN bucket, named, and keeps it out of the headline', async () => {
    const w = await mountPage(
      payload({
        lane_coverage: {
          otel_usd: '120.00',
          reconciled_usd: '45.00',
          provisional_withheld_usd: '0.00',
          member_ingest_only_usd: '33.00',
          member_ingest_only_tools: ['claude-cowork'],
        },
      }),
    )
    const bucket = w.find('[data-testid="lane-excluded-bucket"]')
    expect(bucket.exists()).toBe(true)
    expect(bucket.text()).toContain('Not attributable to any project')
    expect(bucket.text()).toContain('$33.00')
    expect(bucket.text()).toContain('claude-cowork')
    // It is NOT folded into the headline — the whole point of the bucket.
    expect(w.find('[data-testid="project-hero-total"]').text()).toBe('$165.00')
    expect(w.find('[data-testid="project-hero-band"]').text()).not.toContain('198.00')
  })

  it('says the arm-3 bucket is per-MEMBER and must not be summed across projects', async () => {
    /*
     * The figure is keyed on MEMBERSHIP and arm 3 has no project axis to divide
     * by, so a teammate on three projects contributes their whole spend to all
     * three. Without this line on screen, two project pages each showing $33
     * read as $66 of company spend.
     */
    const w = await mountPage(
      payload({
        lane_coverage: {
          otel_usd: '120.00',
          reconciled_usd: '45.00',
          provisional_withheld_usd: '0.00',
          member_ingest_only_usd: '33.00',
          member_ingest_only_tools: ['claude-cowork'],
        },
      }),
    )
    const el = w.find('[data-testid="lane-excluded-non-additive"]')
    expect(el.exists()).toBe(true)
    expect(el.text()).toContain("each member's own total")
    expect(el.text()).toContain("don't add it up across projects")
    // And the bucket names the members, not the project, as the subject.
    expect(w.find('[data-testid="lane-excluded-bucket"]').text()).toContain(
      "This project's members also consumed",
    )
  })

  it('says nothing about arm 3 when there is none (no empty scare-bucket)', async () => {
    const w = await mountPage(payload())
    expect(w.find('[data-testid="lane-excluded-bucket"]').exists()).toBe(false)
  })

  it('says WHY when the provisional filter changes a manager-facing number', async () => {
    const w = await mountPage(
      payload({
        lane_coverage: {
          otel_usd: '120.00',
          reconciled_usd: '45.00',
          provisional_withheld_usd: '12.50',
          member_ingest_only_usd: '0.00',
          member_ingest_only_tools: [],
        },
      }),
    )
    const el = w.find('[data-testid="proj-provisional-withheld"]')
    expect(el.exists()).toBe(true)
    expect(el.text()).toContain('$12.50')
    expect(el.text()).toContain('not yet confirmed')
  })
})
