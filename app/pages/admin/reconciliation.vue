<script setup lang="ts">
/*
 * Admin -> Reconciliation. Observability AND onboarding for the billing-
 * reconciliation engine. Three tabs:
 *   Runs      — worker-execution history + per-run drill-down (scopes, warnings, result).
 *   Records   — the deltas the engine produced (proposed), summary KPIs + filters.
 *   Providers — the MANAGED onboarding surface that replaces the brittle seed.ts
 *               templates: two CRUD tables (provider_enterprise + provider_org)
 *               across anthropic AND github, with the anthropic discover flow,
 *               key presence, and the LIVE per-org health badge.
 * See docs/design/reconciliation-admin.md.
 */

import { computed, ref, watch, onBeforeUnmount, type Ref } from 'vue'
import { consola } from 'consola'
import ProviderOrgDialog, {
  type OrgEditTarget,
  type EnterpriseOption,
} from '../../components/admin/ProviderOrgDialog.vue'
import ProviderEnterpriseDialog, {
  type EnterpriseEditTarget,
} from '../../components/admin/ProviderEnterpriseDialog.vue'
import BackfillDialog, {
  type BackfillTarget,
} from '../../components/admin/BackfillDialog.vue'
import { apiErrorDetail } from '../../composables/useApiError'
import { useModalA11y } from '../../composables/useModalA11y'
import { UI_TRIGGERABLE_WORKER_NAMES, UI_MONEY_WORKER_NAMES } from '#shared/workers/ui-triggerable'
definePageMeta({ layout: 'admin', middleware: 'admin' })

// No `await ensure()`: the `admin` middleware guarantees the session before
// the page instantiates (docs/design/admin-nav-responsiveness.md D1).
const { session } = useSession()
const isAdmin = computed(() => {
  const r = session.value?.role
  return r === 'admin' || r === 'platform-admin'
})
// The "Run now" worker trigger is platform-admin only (matches the
// endpoint) — every safelisted worker is global, so a region-scoped admin can't run
// them. Hide the control for them rather than show a button that 403s.
const canRunWorkers = computed(() => {
  const r = session.value?.role
  return r === 'platform-admin'
})
// Estate-wide provider config (enterprises, unmapped orgs) and run detail are
// platform-admin only server-side; hide those controls from region admins.
const isPlatformAdmin = computed(() => session.value?.role === 'platform-admin')

// URL-synced tab (?tab=runs|records|providers) so a tab is deep-linkable and
// reload-safe — and so the "Providers" sidebar entry can land directly on the
// provider-onboarding view. Writable computed: reads/writes stay `tab === t` /
// `tab = t` at every call site.
const tabRoute = useRoute()
const tabRouter = useRouter()
const TAB_KEYS = ['runs', 'records', 'providers'] as const
const tab = computed<(typeof TAB_KEYS)[number]>({
  get() {
    const t = String(tabRoute.query.tab ?? 'runs')
    return (TAB_KEYS as readonly string[]).includes(t) ? (t as (typeof TAB_KEYS)[number]) : 'runs'
  },
  set(v) {
    tabRouter.push({ query: { ...tabRoute.query, tab: v } })
  },
})
// Correct an unknown ?tab=xyz in the URL once (replace, no history entry) so a
// stale/shared/typo'd value can't linger in the address bar while the UI shows
// the 'runs' fallback — a reloadable desync.
watch(
  () => tabRoute.query.tab,
  (t) => {
    if (t != null && !(TAB_KEYS as readonly string[]).includes(String(t))) {
      tabRouter.replace({ query: { ...tabRoute.query, tab: 'runs' } })
    }
  },
  { immediate: true },
)

// ---- formatting helpers ----
function fmtTs(v: string | null): string {
  return v ? new Date(v).toLocaleString() : '—'
}
function fmtDur(ms: number | null): string {
  if (ms == null) return '—'
  return ms < 1000 ? `${ms}ms` : `${(ms / 1000).toFixed(1)}s`
}
// Signed money cells delegate to the shared guarded formatter (SYS-5) —
// fmtUsd renders negatives as -$x.xx with thousands separators.
function usd(v: string | number | null): string {
  return fmtUsd(v ?? 0)
}
type BadgeKind = 'rag-green' | 'rag-red' | 'rag-amber' | 'neutral'
function statusBadge(s: string): { kind: BadgeKind; label: string } {
  if (s === 'success' || s === 'applied') return { kind: 'rag-green', label: s }
  if (s === 'failure' || s === 'rejected') return { kind: 'rag-red', label: s }
  if (s === 'running' || s === 'proposed') return { kind: 'rag-amber', label: s }
  return { kind: 'neutral', label: s }
}
function dispoBadge(d: string): { kind: BadgeKind; label: string } {
  if (d === 'untagged') return { kind: 'rag-amber', label: 'untagged' }
  if (d === 'walk_back') return { kind: 'rag-green', label: 'walk-back' }
  if (d === 'no_install') return { kind: 'rag-red', label: 'no-install' }
  return { kind: 'neutral', label: d }
}
function classBadge(c: string): { kind: BadgeKind; label: string } {
  if (c === 'billed') return { kind: 'rag-green', label: 'billed' }
  if (c === 'estimated') return { kind: 'neutral', label: 'estimated' }
  return { kind: 'neutral', label: c }
}

// ================= RUNS =================
const runWorker = ref('')
const runStatus = ref('')
const runsUrl = computed(() => {
  const p = new URLSearchParams({ limit: '50' })
  if (runWorker.value) p.set('worker', runWorker.value)
  if (runStatus.value) p.set('status', runStatus.value)
  return `/api/v1/admin/worker-runs?${p.toString()}`
})
interface RunRow {
  id: string
  worker: string
  status: string
  startedAt: string
  finishedAt: string | null
  durationMs: number | null
  rowsAffected: number | null
  hasError: boolean
  warnings: string[]
}
// Every read on this page is DECLARED, never awaited (admin-nav-responsiveness
// D1): lazy, client-only, `null` until it lands. The page renders skeleton /
// error / empty / data keyed on the ABSENCE of data, never on `pending` (D2),
// so a filter refetch keeps loaded rows on screen. Getter URLs keep Nuxt's
// URL-derived key, which is what makes a filter change refetch.
const { data: runs, error: runsError, refresh: refreshRuns, pending: runsPending } = useLazyFetch<{ runs: RunRow[]; total: number } | null>(() => runsUrl.value, {
  server: false,
  default: () => null,
  immediate: isAdmin.value,
})

interface RunDetail extends RunRow {
  error: string | null
  result: Record<string, unknown> | null
}
const openRunId = ref<string | null>(null)
const selectedRun = ref<RunDetail | null>(null)
const runDetailPending = ref(false)
const runDetailError = ref<string | null>(null)
async function openRun(id: string) {
  if (openRunId.value === id) {
    openRunId.value = null
    selectedRun.value = null
    return
  }
  const reqId = id
  openRunId.value = id
  selectedRun.value = null
  runDetailError.value = null
  runDetailPending.value = true
  try {
    const detail = await $fetch<RunDetail>(`/api/v1/admin/worker-runs/${id}`)
    if (openRunId.value !== reqId) return // a newer selection superseded this fetch
    selectedRun.value = detail
  } catch {
    if (openRunId.value !== reqId) return // ignore a stale failure
    runDetailError.value = 'Failed to load run detail (it may have been cleaned up).'
  } finally {
    if (openRunId.value === reqId) runDetailPending.value = false
  }
}
const resultEntries = computed(() =>
  selectedRun.value?.result && typeof selectedRun.value.result === 'object'
    ? Object.entries(selectedRun.value.result)
    : [],
)

// ---- on-demand worker trigger ("Run now") ----
// The picker + the server safelist both derive from #shared/workers/ui-triggerable
// (single source of truth), so they can't drift. The endpoint is the real gate.
const TRIGGERABLE_WORKERS = UI_TRIGGERABLE_WORKER_NAMES
const triggerWorker = ref<string>('identity-sync')
const triggering = ref(false)
async function runWorkerNow() {
  if (triggering.value || !triggerWorker.value) return
  const name = triggerWorker.value
  // Money-settling workers write the reconciliation ledger — double-confirm so a
  // fat-finger isn't a single click. (Re-running is idempotent, but confirm intent.)
  if (UI_MONEY_WORKER_NAMES.has(name)
    && !window.confirm(`Run "${name}" now? It writes the reconciliation ledger. A run already in progress is a no-op.`)) {
    return
  }
  triggering.value = true
  try {
    const out = await $fetch<{ worker: string; duration_ms: number; result: unknown }>(
      `/api/v1/admin/workers/${name}/run`,
      { method: 'POST' },
    )
    flashToast('ok', `${out.worker} completed in ${fmtDur(out.duration_ms)} — see the run below`)
  } catch (e: unknown) {
    const err = e as { statusCode?: number; data?: { detail?: string }; message?: string }
    if (err?.statusCode === 409) {
      // Benign: a run (cron or a prior click) is already in flight — not a failure.
      flashToast('ok', `${name} is already running — see the runs list`)
    } else if (err?.statusCode === 504 || err?.statusCode == null) {
      // A long worker can exceed the ~120s gateway ceiling (504), or the fetch aborts
      // with NO status — either way the worker KEEPS running server-side. Don't cry
      // failure; point to the runs list, which shows its true (running →
      // success/failure) state (the finally always refreshes it).
      flashToast('ok', `${name} is taking a while — it keeps running server-side; watch the runs list`)
    } else if (err?.statusCode === 502) {
      // 502 can mean the instance died mid-dispatch (not just slow) — the run row may
      // be left 'running' until the next dispatch's stale-reap. Softer than "failed".
      flashToast('err', `${name} may still be running — check the runs list`)
    } else {
      flashToast('err', err?.data?.detail || err?.message || `Failed to run ${name}`)
    }
  } finally {
    // Refresh regardless: the run row exists (running/success/failure) even when the
    // request 409'd or timed out, so the list reflects the true state either way.
    await refreshRuns().catch(() => {})
    triggering.value = false
  }
}

// ================= RECORDS =================
const recStatus = ref('proposed')
const recDisposition = ref('')
const recProvider = ref('')
const recsUrl = computed(() => {
  const p = new URLSearchParams({ limit: '100', status: recStatus.value })
  if (recDisposition.value) p.set('disposition', recDisposition.value)
  if (recProvider.value) p.set('provider', recProvider.value)
  return `/api/v1/admin/reconciliation/records?${p.toString()}`
})
interface RecordRow {
  id: string
  provider: string
  enterpriseRef: string
  licenseOrg: string | null
  periodDate: string
  category: string
  scope: string
  teammateEmail: string | null
  regionCode: string | null
  costOwningUnit: string | null
  actualUsd: string
  otelAttributedUsd: string
  deltaUsd: string
  actualQty: string | null
  actualUnitType: string | null
  spendClass: string
  indicativeReason: string | null
  disposition: string
  status: string
  lagState: string | null
  runId: string | null
  computedAt: string
}
interface RecordsResp {
  summary: {
    statusScope: string
    total: number
    byDisposition: Record<string, number>
    bySpendClass: Record<string, number>
    untaggedUsd: string
    walkBackUsd: string
    noInstallUsd: string
    netDeltaUsd: string
  }
  records: RecordRow[]
  total: number
  regionScoped: boolean
  scopeNote: string | null
}
const { data: recs, error: recsError, refresh: refreshRecs, pending: recsPending } = useLazyFetch<RecordsResp | null>(
  () => recsUrl.value,
  { server: false, default: () => null, immediate: isAdmin.value },
)
const statusLabel = computed(() => {
  const s = recs.value?.summary.statusScope ?? 'proposed'
  return s === 'all' ? 'All statuses' : s.charAt(0).toUpperCase() + s.slice(1)
})
const openRecordId = ref<string | null>(null)
function toggleRecord(id: string) {
  openRecordId.value = openRecordId.value === id ? null : id
}

// ================= PROVIDERS (onboarding) =================
// The managed onboarding surface: two CRUD tables across anthropic + github.
//   Enterprises (provider_enterprise) — the credential-custody unit.
//   Orgs        (provider_org)        — joined to its enterprise. The live anthropic
//                                       health verdict is NOT on the list row: it is
//                                       read once from anthropic/health (per org,
//                                       keyed by externalOrgId) and joined onto the
//                                       row here, with its own loading/error state
//                                       (admin-nav-responsiveness D5). The key is
//                                       NEVER carried; only a presence flag + a safe
//                                       verdict.
interface OrgHealth {
  externalOrgId: string
  color: 'green' | 'amber' | 'red'
  reason: string | null
  apiKindLabel: string | null
  keyFormatOk: boolean | null
}
interface OrgRow {
  id: string
  provider: 'anthropic' | 'github'
  externalOrgId: string
  displayName: string
  reconciliationMode: string
  billing: string
  apiKind: 'enterprise-analytics' | 'claude-code-admin' | null
  apiKindLabel: string | null
  credentialSecretName: string | null
  providerEnterpriseId: string | null
  enterprise: { id: string; externalId: string | null; displayName: string | null } | null
  regionId: string | null
  regionCode: string | null
  keyPresent: boolean
}
interface EnterpriseRow {
  id: string
  provider: 'anthropic' | 'github'
  externalId: string
  displayName: string
  reconciliationMode: string
  billing: string
  credentialSecretName: string | null
  flatSeatPriceUsd: number | null
  includedAllowanceUsd: number | null
  // ADR-0011 D10 — configurable per-enterprise pooled-overage allocation policy.
  overageAllocationPolicy: string
  // GitHub App credential opt-in (mig 0078). Non-null = App mode intended; the API
  // derives credentialKind + checks the App private key for keyPresent.
  githubAppId: string | null
  credentialKind: 'github-pat' | 'github-app'
  keyPresent: boolean
  orgCount: number
}
const { data: orgsData, error: orgsError, refresh: refreshOrgs, pending: orgsPending } = useLazyFetch<{ orgs: OrgRow[]; total: number } | null>(() => '/api/v1/admin/reconciliation/orgs', {
  server: false,
  default: () => null,
  immediate: isAdmin.value,
})
const { data: entData, error: entError, refresh: refreshEnterprises, pending: entPending } = useLazyFetch<{ enterprises: EnterpriseRow[]; total: number } | null>(() => '/api/v1/admin/reconciliation/enterprises', {
  server: false,
  default: () => null,
  immediate: isAdmin.value,
})

// ---- GitHub org coverage (Workstream D) — persisted-only, no live network call ----
// One GET powers BOTH the cross-enterprise banner and the per-enterprise/per-org
// columns below. denominator null = no honest "N of M" claim; never render "0 of 0".
interface CoverageOrgObservation {
  org: string
  state: 'mislinked' | 'coverage-unknown' | 'stale' | 'not-installed' | 'suspended' | 'not-onboarded' | 'connected'
  providerOrgId: string | null
  observedAt: string
  stale: boolean
}
interface EnterpriseCoverage {
  enterpriseId: string
  census: {
    available: boolean
    capped: boolean
    reason: string | null
    orgCount: number | null
    observedAt: string | null
    stale: boolean
  }
  orgs: CoverageOrgObservation[]
}
const { data: coverageData, error: coverageError, refresh: refreshCoverage } = useLazyFetch<{ coverage: EnterpriseCoverage[] } | null>(
  () => '/api/v1/admin/reconciliation/github/coverage',
  { server: false, default: () => null, immediate: isAdmin.value },
)
const coverageByEnterprise = computed(() => new Map(coverageData.value?.coverage.map((c) => [c.enterpriseId, c]) ?? []))
/** This org's coverage observation, found by external_org_id across every enterprise's
 *  coverage set (an org's own row doesn't say which enterprise "found" it). */
function orgCoverage(o: OrgRow): CoverageOrgObservation | null {
  for (const c of coverageData.value?.coverage ?? []) {
    const hit = c.orgs.find((x) => x.org === o.externalOrgId.toLowerCase())
    if (hit) return hit
  }
  return null
}
const COVERAGE_STATE_LABEL: Record<CoverageOrgObservation['state'], string> = {
  mislinked: 'Mislinked',
  'coverage-unknown': 'Coverage unknown',
  stale: 'Stale',
  'not-installed': 'Not installed',
  suspended: 'Suspended',
  'not-onboarded': 'Not onboarded',
  connected: 'Connected',
}
const COVERAGE_STATE_BADGE: Record<CoverageOrgObservation['state'], BadgeKind> = {
  mislinked: 'rag-red',
  'coverage-unknown': 'neutral',
  stale: 'rag-red',
  'not-installed': 'rag-amber',
  suspended: 'rag-amber',
  'not-onboarded': 'rag-amber',
  connected: 'rag-green',
}
/** A one-line, key-safe remediation hint per non-connected state (requirement 4: every
 *  non-connected state has a clear remediation path via EXISTING flows — never a new
 *  mutation route). Points at the Edit / Discover / Verify actions already on this page. */
const COVERAGE_REMEDIATION_HINT: Record<CoverageOrgObservation['state'], string> = {
  mislinked: 'This org is linked to a DIFFERENT enterprise below — open Edit on its Orgs row and fix the Enterprise field.',
  'coverage-unknown': 'Cannot classify — grant the App "Enterprise organization installations: read", or Recheck once GitHub is reachable again.',
  stale: 'GitHub no longer lists this org as an enterprise member — remove it via Delete on its Orgs row.',
  'not-installed': 'Install the reconciliation App on this org in GitHub, or run "Discover Copilot orgs" if it already has seats.',
  suspended: 'Unsuspend the App installation on this org in GitHub enterprise settings, then Recheck.',
  'not-onboarded': 'Open Edit on its Orgs row (or "+ Add org" if it has none yet) and set its Cost-owning unit.',
  connected: '',
}
// Cross-enterprise banner summary — computed client-side from the SAME payload so it
// can never disagree with the per-enterprise rows. A denominator-less enterprise
// contributes ONLY to the unknown count, never a false "0 of 0".
const coverageBanner = computed(() => {
  const list = coverageData.value?.coverage ?? []
  let nonConnected = 0
  let unknownEnterprises = 0
  const stateCounts: Partial<Record<CoverageOrgObservation['state'], number>> = {}
  for (const c of list) {
    if (!c.census.available || c.census.stale) unknownEnterprises += 1
    for (const o of c.orgs) {
      if (o.state !== 'connected') {
        nonConnected += 1
        stateCounts[o.state] = (stateCounts[o.state] ?? 0) + 1
      }
    }
  }
  return { nonConnected, unknownEnterprises, stateCounts, hasAnyGithubEnterprise: list.length > 0 }
})
const recheckingCoverage = ref<Set<string>>(new Set())
async function recheckCoverage(e: EnterpriseRow) {
  const next = new Set(recheckingCoverage.value)
  next.add(e.id)
  recheckingCoverage.value = next
  try {
    await $fetch('/api/v1/admin/reconciliation/github/coverage-recheck', {
      method: 'POST',
      body: { enterpriseId: e.id },
    })
    await refreshCoverage()
    flashToast('ok', `Coverage rechecked for ${e.displayName}.`)
  } catch (err) {
    flashToast('err', apiErrorDetail(err, 'Recheck failed — could not recompute coverage.'))
    consola.warn('github coverage recheck failed', err)
  } finally {
    const done = new Set(recheckingCoverage.value)
    done.delete(e.id)
    recheckingCoverage.value = done
  }
}

// Regions for the GitHub org→region home picker (ADR-0010 D4).
interface RegionsRaw {
  regions: { id: string; code: string; display_name?: string; displayName?: string }[]
}
// It keeps its `error`: collapsed into `[]` the org dialog's region picker holds
// only "— unmapped —" and reads as "there is nowhere to map this org" — the
// false empty D2 forbids (docs/design/admin-nav-responsiveness.md).
const { data: regionsData, error: regionsError, refresh: refreshRegions } = useLazyFetch<RegionsRaw | null>(
  () => '/api/v1/admin/regions',
  { server: false, default: () => null, immediate: isAdmin.value },
)
const regionOptions = computed(() =>
  (regionsData.value?.regions ?? []).map((x) => ({ id: x.id, code: x.code, displayName: x.displayName ?? x.display_name ?? x.code })),
)

// The ONE source of the per-org anthropic health verdict (key format + live
// probe) and of the endpoint-configured flag (live probes are amber until
// NUXT_ANTHROPIC_API_ENDPOINT is set). It probes every org over HTTPS, so it
// is its own read with its own loading/error state, joined onto the Orgs rows
// by externalOrgId — the orgs list never waits on it (D5).
const {
  data: anthHealth,
  error: anthHealthError,
  refresh: refreshAnthHealth,
} = useLazyFetch<{ orgs: OrgHealth[]; total: number; endpointConfigured: boolean } | null>(
  () => '/api/v1/admin/reconciliation/anthropic/health',
  { server: false, default: () => null, immediate: isAdmin.value },
)
const anthHealthByOrg = computed(
  () => new Map((anthHealth.value?.orgs ?? []).map((h) => [h.externalOrgId, h])),
)
/** This anthropic org's verdict from the health read. null for github rows,
 *  and until the read lands — the template tells those apart via anthHealth. */
function orgHealth(o: OrgRow): OrgHealth | null {
  return o.provider === 'anthropic' ? (anthHealthByOrg.value.get(o.externalOrgId) ?? null) : null
}

// Workstream B: whether the governance cutover is activated (ADR-0011 D11) —
// platform-admin-only endpoint, so gated the same way as canRunWorkers below
// (a region admin simply sees the pre-activation org-level billing field,
// which is harmless — they are not the audience for the cutover anyway).
const { data: cutoverData } = useLazyFetch<{ status: string } | null>(() => '/api/v1/admin/governance-cutover', {
  server: false,
  default: () => null,
  immediate: session.value?.role === 'platform-admin',
})
const governanceActivated = computed(() => cutoverData.value?.status === 'activated')

const colorBadge: Record<'green' | 'amber' | 'red', BadgeKind> = {
  green: 'rag-green',
  amber: 'rag-amber',
  red: 'rag-red',
}
// Human label for the safe classified reason (never the raw provider text/key).
function reasonLabel(reason: string | null): string {
  if (!reason) return 'healthy'
  const map: Record<string, string> = {
    'no-key': 'no key wired',
    'key-format-mismatch': 'key format mismatch',
    '400-bad-request': 'bad request (400)',
    '401-unauthorized': 'unauthorized (401)',
    '403-forbidden-scope': 'forbidden — scope (403)',
    '404-wrong-endpoint': 'wrong endpoint (404)',
    'parse-mismatch': 'unexpected response shape',
    '429-rate-limited': 'rate-limited (429)',
    'endpoint-unset': 'endpoint not configured',
    'connect-failed': 'connect failed',
  }
  return map[reason] ?? reason
}

// Enterprise options the org dialog's github picker reads from.
const enterpriseOptions = computed<EnterpriseOption[]>(() =>
  (entData.value?.enterprises ?? []).map((e) => ({
    id: e.id,
    provider: e.provider,
    externalId: e.externalId,
    displayName: e.displayName,
  })),
)

function refreshProviders() {
  refreshOrgs()
  refreshEnterprises()
  refreshCoverage()
  refreshAnthHealth()
}

// First paint (D2): the active tab's primary read has neither landed nor
// failed → the page-level skeleton. Everything else on the page keys its own
// skeleton / error / empty / data on its own read the same way.
const showPageSkeleton = computed(() => {
  const t = tab.value
  const data = t === 'runs' ? runs.value : t === 'records' ? recs.value : orgsData.value
  const error = t === 'runs' ? runsError.value : t === 'records' ? recsError.value : orgsError.value
  return !error && data == null
})

// ---- toast (mirrors grants.vue / rate-cards.vue) ----
const toast = ref<{ kind: 'ok' | 'err'; message: string } | null>(null)
let toastTimer: ReturnType<typeof setTimeout> | null = null
function flashToast(kind: 'ok' | 'err', message: string) {
  toast.value = { kind, message }
  if (toastTimer) clearTimeout(toastTimer)
  toastTimer = setTimeout(() => { toast.value = null }, 3500)
}

// ---- enterprise dialog (create + edit) ----
const entDialogOpen = ref(false)
const entEditTarget = ref<EnterpriseEditTarget | null>(null)
function openCreateEnterprise() {
  entEditTarget.value = null
  entDialogOpen.value = true
}
function openEditEnterprise(e: EnterpriseRow) {
  entEditTarget.value = {
    id: e.id,
    provider: e.provider,
    externalId: e.externalId,
    displayName: e.displayName,
    reconciliationMode: e.reconciliationMode,
    billing: e.billing,
    credentialSecretName: e.credentialSecretName,
    flatSeatPriceUsd: e.flatSeatPriceUsd,
    includedAllowanceUsd: e.includedAllowanceUsd,
    overageAllocationPolicy: e.overageAllocationPolicy,
    githubAppId: e.githubAppId,
  }
  entDialogOpen.value = true
}
function onEnterpriseSaved() {
  entDialogOpen.value = false
  flashToast('ok', entEditTarget.value ? 'Enterprise updated.' : 'Enterprise created.')
  refreshProviders()
}

// ---- org dialog (create + edit) ----
const orgDialogOpen = ref(false)
const orgEditTarget = ref<OrgEditTarget | null>(null)
function openCreateOrg() {
  orgEditTarget.value = null
  orgDialogOpen.value = true
}
function openEditOrg(o: OrgRow) {
  orgEditTarget.value = {
    id: o.id,
    provider: o.provider,
    externalOrgId: o.externalOrgId,
    displayName: o.displayName,
    reconciliationMode: o.reconciliationMode,
    billing: o.billing,
    apiKind: o.apiKind,
    credentialSecretName: o.credentialSecretName,
    providerEnterpriseId: o.providerEnterpriseId,
    regionId: o.regionId,
  }
  orgDialogOpen.value = true
}
function onOrgSaved() {
  orgDialogOpen.value = false
  flashToast('ok', orgEditTarget.value ? 'Org updated.' : 'Org created.')
  refreshProviders()
}

// ---- deletes (confirm-on-destroy) ----
const deleting = ref<Set<string>>(new Set())
function markDeleting(id: string, busy: boolean) {
  const next = new Set(deleting.value)
  if (busy) next.add(id)
  else next.delete(id)
  deleting.value = next
}

// ---- GitHub org discovery (ADR-0010 onboarding) ----
const discoveringOrgs = ref<Set<string>>(new Set())
/*
 * Discovery copy is PER CREDENTIAL KIND (UF-19). The two modes read different surfaces —
 * a PAT reads the enterprise SEAT roster, a GitHub App reads the enterprise's OWNED-ORG
 * census — so the same reason bucket has a different remediation and the success line
 * describes a different set. The route returns `credentialKind` on BOTH the success and
 * the 422 body so this never has to guess (it used to name "the PAT" unconditionally,
 * which is the wrong instruction for every App-mode enterprise).
 */
type DiscoverCredentialKind = 'github-app' | 'github-pat'
const DISCOVER_REASON: Record<DiscoverCredentialKind, Record<string, string>> = {
  'github-pat': {
    'no-key': 'No PAT wired for this enterprise — set the credential first.',
    '401-unauthorized': 'The PAT was rejected (401).',
    '403-forbidden-scope': 'The PAT lacks the required scope (403) — it needs manage_billing.',
    '404-wrong-endpoint': 'GitHub returned 404 — check the enterprise slug.',
    '429-rate-limited': 'Rate-limited by GitHub (429) — try again shortly.',
    'connect-failed': 'Could not reach GitHub.',
  },
  'github-app': {
    'no-key': 'No GitHub App private key wired for this enterprise — set the credential first.',
    '401-unauthorized': 'GitHub rejected the App credential (401) — check the App id and private key.',
    '403-forbidden-scope': 'The App lacks the required permission (403) — it needs "Enterprise organization installations: read".',
    '404-wrong-endpoint': 'GitHub returned 404 — check the enterprise slug, and that the App is installed on the enterprise.',
    '429-rate-limited': 'Rate-limited by GitHub (429) — try again shortly.',
    'connect-failed': 'Could not reach GitHub.',
  },
}
/** What the Discover button will actually read, per credential kind — the tooltip used to
 *  promise a PAT seat pull on every enterprise, including App-mode ones it cannot do it for. */
function discoverTitle(kind: DiscoverCredentialKind): string {
  return kind === 'github-app'
    ? "Reads this enterprise's GitHub App credential and adds every org the enterprise OWNS — no need to type them. Includes orgs with no Copilot seats yet (the App can't see an org's seats until it is installed there)."
    : "Reads this enterprise's PAT and adds every org that HAS COPILOT SEATS — no need to type them. Orgs with no Copilot seats aren't pulled (they carry no Copilot cost)."
}
function discoverReason(kind: DiscoverCredentialKind | undefined, reason: string): string {
  // Default to the PAT wording only when the route told us nothing — every current
  // response carries the kind.
  return DISCOVER_REASON[kind ?? 'github-pat'][reason] ?? `Discovery failed: ${reason}.`
}
async function discoverOrgs(e: EnterpriseRow) {
  const next = new Set(discoveringOrgs.value)
  next.add(e.id)
  discoveringOrgs.value = next
  try {
    const res = await $fetch<{
      reason?: string
      discovered?: number
      created?: number
      linked?: number
      alreadyLinked?: number
      credentialKind?: DiscoverCredentialKind
      capped?: boolean
    }>('/api/v1/admin/reconciliation/github/discover-orgs', { method: 'POST', body: { enterpriseId: e.id } })
    // The endpoint returns 422 { reason } as a 2xx-shaped body only on success; a real
    // 422 throws below. Guard defensively in case the body carries a reason on 200.
    if (res.reason) {
      flashToast('err', discoverReason(res.credentialKind, res.reason))
    } else {
      const found = res.discovered ?? 0
      const added = (res.created ?? 0) + (res.linked ?? 0)
      const orgWord = found === 1 ? 'org' : 'orgs'
      // What was actually enumerated, per mode — never "orgs with Copilot seats" for an
      // App-mode enterprise, whose source is the owned-org census (seatless orgs included).
      const appMode = res.credentialKind === 'github-app'
      const subject = appMode ? `${orgWord} owned by this enterprise` : `${orgWord} with Copilot seats`
      // A capped source is a PREFIX — say so rather than let "found N" read as the total.
      const cappedNote = res.capped ? ' The list was truncated, so this is not the full estate.' : ''
      flashToast(
        'ok',
        found === 0
          ? appMode
            ? 'No orgs found for this enterprise — check that the App is installed on the enterprise and has "Enterprise organization installations: read".'
            : 'No orgs with Copilot seats found for this enterprise (check the PAT scope).'
          : added > 0
            ? `Found ${found} ${subject} — added ${added}. Set each org's region next.${cappedNote}`
            : `All ${found} ${subject} are already onboarded.${cappedNote}`,
      )
      refreshProviders()
    }
  } catch (err) {
    const data = (err as { data?: { reason?: string; credentialKind?: DiscoverCredentialKind } } | null)?.data
    flashToast(
      'err',
      data?.reason ? discoverReason(data.credentialKind, data.reason) : apiErrorDetail(err, 'Org discovery failed.'),
    )
    consola.warn('github discover-orgs failed', err)
  } finally {
    const done = new Set(discoveringOrgs.value)
    done.delete(e.id)
    discoveringOrgs.value = done
  }
}
async function deleteEnterprise(e: EnterpriseRow) {
  if (e.orgCount > 0) return // guarded in the template; the API would 409
  if (!confirm(`Delete enterprise "${e.displayName}" (${e.provider}/${e.externalId})? This cannot be undone.`)) return
  markDeleting(e.id, true)
  try {
    await $fetch(`/api/v1/admin/reconciliation/enterprises/${e.id}`, { method: 'DELETE' })
    flashToast('ok', `Deleted enterprise ${e.displayName}.`)
    refreshProviders()
  } catch (err) {
    flashToast('err', apiErrorDetail(err, 'Delete refused.'))
    consola.warn('enterprise delete failed', err)
  } finally {
    markDeleting(e.id, false)
  }
}
async function deleteOrg(o: OrgRow) {
  if (!confirm(`Delete org "${o.displayName}" (${o.provider}/${o.externalOrgId})? Future events for it fall back to telemetry-only until re-onboarded.`)) return
  markDeleting(o.id, true)
  try {
    await $fetch(`/api/v1/admin/reconciliation/orgs/${o.id}`, { method: 'DELETE' })
    flashToast('ok', `Deleted org ${o.displayName}.`)
    refreshProviders()
  } catch (err) {
    flashToast('err', apiErrorDetail(err, 'Delete refused.'))
    consola.warn('org delete failed', err)
  } finally {
    markDeleting(o.id, false)
  }
}

// ---- GitHub enterprise VERIFY (live reconciliation health probe) ----
// Clicking Verify GETs the classified, key-safe health probe for ONE github enterprise and
// shows exactly WHERE its pipeline breaks (egress / auth / metrics-empty / no-teammate-match)
// — the worker logs are NSP-locked, so this is the only live signal an admin has.
type GithubVerdict =
  | 'healthy' | 'no-teammate-match' | 'metrics-empty' | 'upstream-transient' | 'probe-error'
  | 'no-license-orgs' | 'auth-failed' | 'egress-blocked' | 'not-installed' | 'key-malformed' | 'no-credential'
interface GithubStage { ok: boolean; reason?: string; count?: number; rosterMatched?: number; recordCount?: number; matchedRecords?: number; skipped?: boolean; hint?: string }
// Coverage stage (Workstream D) — a cheap, persisted-only read attached to every
// Verify outcome. denominator null = no honest "N of M" claim can be made (never
// render "0 of 0"); nonConnected is the run-warning/banner trigger count.
interface CoverageStage {
  available: boolean
  capped: boolean
  reason: string | null
  denominator: number | null
  connected: number
  nonConnected: number
  stale: boolean
  observedAt: string | null
}
interface GithubHealth {
  enterpriseId: string
  externalId: string
  credentialKind: 'github-pat' | 'github-app'
  keyPresent: boolean
  probeDay: string
  stages: { credential: GithubStage; appAuth?: GithubStage; licenses: GithubStage; metrics: GithubStage }
  verdict: GithubVerdict
  color: 'green' | 'amber' | 'red'
  coverage: CoverageStage
}
const verifying = ref<Set<string>>(new Set())
const verifyResult = ref<GithubHealth | null>(null)
const verifyEntName = ref<string>('')
const VERDICT_LABEL: Record<GithubVerdict, string> = {
  'healthy': 'Healthy',
  'no-teammate-match': 'No teammate match',
  'metrics-empty': 'Metrics empty',
  'upstream-transient': 'GitHub upstream error / rate-limited — retry later',
  'probe-error': 'Probe error — retry',
  'no-license-orgs': 'No license orgs onboarded',
  'auth-failed': 'Auth failed',
  'egress-blocked': 'Egress blocked',
  'not-installed': 'App not installed',
  'key-malformed': 'Key malformed',
  'no-credential': 'No credential',
}
// Safe classified stage-reason → human label (never the raw provider text/key/token).
const STAGE_REASON_LABEL: Record<string, string> = {
  'no-credential': 'no credential wired',
  'key-malformed': 'App key malformed (PEM won’t decode)',
  'not-installed': 'App not installed on the enterprise',
  'no-license-orgs': 'no license org onboarded (add one under Orgs) — nothing to bridge',
  'auth-failed': 'unauthorized / forbidden (401/403)',
  'egress-blocked': 'could not reach GitHub (egress blocked)',
  'rate-limited': 'rate-limited by GitHub (429) — retry later',
  'not-ready': 'report not generated yet — retry later',
  'upstream-error': 'GitHub upstream error (5xx / unexpected response) — retry later',
  'probe-window-exceeded': 'probe window exceeded (GitHub unusually slow) — retry',
  'probe-internal-error': 'probe failed internally (server-side) — retry',
}
function stageReason(reason: string | undefined): string {
  return reason ? (STAGE_REASON_LABEL[reason] ?? reason) : ''
}
// Safe classified stage-hint → fixed remediation text (server returns only the enum; the
// actionable string lives client-side, never derived from an upstream body — key-safety).
const STAGE_HINT_LABEL: Record<string, string> = {
  'org-admin-read-denied':
    "App install on this org may be missing “organization_administration: read” — grant it on the GitHub App and re-approve the org installation.",
}
function stageHint(hint: string | undefined): string {
  return hint ? (STAGE_HINT_LABEL[hint] ?? '') : ''
}
async function verifyEnterprise(e: EnterpriseRow) {
  const next = new Set(verifying.value)
  next.add(e.id)
  verifying.value = next
  try {
    const res = await $fetch<GithubHealth>('/api/v1/admin/reconciliation/github/health', {
      params: { enterpriseId: e.id },
    })
    verifyEntName.value = e.displayName
    verifyResult.value = res
  } catch (err) {
    flashToast('err', apiErrorDetail(err, 'Verify failed — could not run the health probe.'))
    consola.warn('github verify failed', err)
  } finally {
    const done = new Set(verifying.value)
    done.delete(e.id)
    verifying.value = done
  }
}
function closeVerify() {
  verifyResult.value = null
  verifyEntName.value = ''
}
// Dialog a11y (mirrors the admin dialogs): Escape-to-close, Tab focus-trap, focus-restore.
const verifyDialogEl = ref<HTMLElement | null>(null)
useModalA11y({
  isOpen: () => verifyResult.value !== null,
  dialogEl: verifyDialogEl as Ref<HTMLElement | null>,
  onClose: closeVerify,
})

// ---- UNRESOLVED Copilot users (identity-tail layer 3) ----
// The unmatched github logins the live provider roster reports with Copilot spend/seats but
// which the identity map doesn't bind to a teammate. An admin maps each to an existing teammate
// (POST /map writes the enterprise lane) so the reconciler then attributes their spend. The list
// is LIVE (an unmapped login is skipped before reconciliation_record is written, so it's not
// persisted) — hence a per-enterprise on-demand button, like Verify.
interface UnresolvedLogin { login: string; licenseOrg: string | null; credits: number | null; lastSeenDay: string | null; profileName: string | null; profileEmail: string | null }
interface UnresolvedResult {
  enterpriseId: string
  externalId: string
  credentialKind: 'github-pat' | 'github-app'
  probeDay: string | null
  logins: UnresolvedLogin[]
}
const loadingUnresolved = ref<Set<string>>(new Set())
const unresolvedResult = ref<UnresolvedResult | null>(null)
const unresolvedEntName = ref<string>('')
const unresolvedEntId = ref<string>('')
// Per-login map state: the search box, results, and the busy login.
interface TeammateHit { id: string; email: string; displayName: string | null; regionCode: string | null; orgUnitCode: string | null }
/* A directory (Entra) candidate who is NOT yet a teammate. Kept in a SEPARATE list from
 * TeammateHit, never merged, because assigning one PROVISIONS a person — a different act
 * from binding to someone who already exists, and the operator has to be able to see which
 * one they are about to do. */
interface DirectoryHit { oid: string; email: string; displayName: string | null; department: string | null; jobTitle: string | null }
const mapSearchFor = ref<string | null>(null) // which login's picker is open
const mapQuery = ref('')
const mapResults = ref<TeammateHit[]>([])
const mapDirectory = ref<DirectoryHit[]>([])
const mapDirectoryError = ref<string | null>(null)
const mapSearching = ref(false)
/* A SET, not a scalar: two maps can be in flight at once, and a scalar let the first to finish
 * clear the second's busy flag, re-enabling a button whose request had not returned. */
const mapBusyLogins = ref<Set<string>>(new Set())
const isMapBusy = (login: string) => mapBusyLogins.value.has(login)

async function loadUnresolved(e: EnterpriseRow) {
  const next = new Set(loadingUnresolved.value)
  next.add(e.id)
  loadingUnresolved.value = next
  try {
    const res = await $fetch<UnresolvedResult>('/api/v1/admin/reconciliation/github/unresolved', {
      params: { enterpriseId: e.id },
    })
    unresolvedEntName.value = e.displayName
    unresolvedEntId.value = e.id
    unresolvedResult.value = res
    resetMapPicker()
  } catch (err) {
    flashToast('err', apiErrorDetail(err, 'Could not list unresolved Copilot users.'))
    consola.warn('unresolved list failed', err)
  } finally {
    const done = new Set(loadingUnresolved.value)
    done.delete(e.id)
    loadingUnresolved.value = done
  }
}
function resetMapPicker() {
  cancelPendingSearch()
  mapSearchFor.value = null
  mapQuery.value = ''
  mapResults.value = []
  mapDirectory.value = []
  mapDirectoryError.value = null
  mapSearching.value = false
}
function openMapPicker(login: string) {
  if (mapSearchFor.value === login) { resetMapPicker(); return }
  // Full invalidation, not just a timer clear: switching pickers with a request in flight must
  // not inherit the previous login's spinner (which would leave the new picker disabled until
  // an unrelated Graph call returns) or its results.
  cancelPendingSearch()
  mapSearchFor.value = login
  mapResults.value = []
  mapDirectory.value = []
  mapDirectoryError.value = null
  /*
   * Pre-seed from the github profile email and search immediately. This is the whole point of
   * carrying the hint: without it the admin leaves for github.com to find out who the login
   * belongs to, comes back, and types what they read. Pre-filling is safe precisely because the
   * search is a READ — the self-asserted email chooses what to LOOK UP, never what to bind, and
   * the admin still picks from the results.
   */
  // Email FIRST but name as the fallback: a GitHub profile commonly carries a name with no
  // public email, and seeding '' there would leave the admin retyping the very name we are
  // already showing them, which is the legwork this hint exists to remove.
  const hint = unresolvedResult.value?.logins.find((l) => l.login === login)
  const seed = hint?.profileEmail || hint?.profileName || ''
  mapQuery.value = seed
  if (seed) void searchTeammates()
}
/* Monotonic search token. Searches are fired on input and on picker-open, so responses can land
 * out of order or after the admin has moved to a DIFFERENT login. Applying a stale response
 * would repopulate the picker with candidates for the login they just left, and the next click
 * would bind the CURRENT login to that stale person. Only the newest search may write. */
let mapSearchSeq = 0
let mapSearchTimer: ReturnType<typeof setTimeout> | null = null

/* The ONE place in-flight search state is invalidated. Every transition that makes an
 * outstanding response irrelevant (typing, switching login, closing, unmounting) goes through
 * here, so there is no transition that drops the spinner but keeps the token, or vice versa. */
function cancelPendingSearch() {
  if (mapSearchTimer) { clearTimeout(mapSearchTimer); mapSearchTimer = null }
  mapSearchSeq++
  mapSearching.value = false
}

/* Debounced entry point for keystrokes. The picker now searches Entra as well as the local
 * table, so a per-keystroke call is a live Graph request per character. */
function onMapQueryInput() {
  // Invalidate FIRST. Clearing the lists alone left a window: a response from the previous
  // query could land during the debounce delay, repopulate the candidates the admin had just
  // typed over, and be clicked. The token has to move on the keystroke, not on the fetch.
  cancelPendingSearch()
  mapResults.value = []
  mapDirectory.value = []
  mapDirectoryError.value = null
  if (!mapQuery.value.trim()) return
  mapSearchTimer = setTimeout(() => { mapSearchTimer = null; void searchTeammates() }, 250)
}

onBeforeUnmount(cancelPendingSearch)

async function searchTeammates() {
  const q = mapQuery.value.trim()
  const seq = ++mapSearchSeq
  const forLogin = mapSearchFor.value
  if (!q) { mapResults.value = []; mapDirectory.value = []; mapDirectoryError.value = null; return }
  mapSearching.value = true
  try {
    const r = await $fetch<{ teammates: TeammateHit[]; directory?: DirectoryHit[]; directoryError?: string | null }>(
      '/api/v1/admin/reconciliation/github/teammate-search',
      { params: { q, limit: 10 } },
    )
    if (seq !== mapSearchSeq || mapSearchFor.value !== forLogin) return
    mapResults.value = r.teammates ?? []
    mapDirectory.value = r.directory ?? []
    mapDirectoryError.value = r.directoryError ?? null
  } catch (err) {
    if (seq !== mapSearchSeq || mapSearchFor.value !== forLogin) return
    flashToast('err', apiErrorDetail(err, 'Teammate search failed.'))
  } finally {
    if (seq === mapSearchSeq) mapSearching.value = false
  }
}
async function mapLogin(login: UnresolvedLogin, teammate: TeammateHit) {
  await postMap(login, { teammateId: teammate.id }, teammate.displayName ?? teammate.email)
}
/* Assigning a DIRECTORY hit resolves the person server-side, then binds, in ONE call — so the
 * resolve can never be left without its bind by a half-finished click sequence. The server may
 * provision a new teammate, adopt a `bill:` placeholder, or reuse an existing row; the response
 * says which, and the caller must not assume "new person" from this path. */
async function mapLoginToDirectory(login: UnresolvedLogin, hit: DirectoryHit) {
  // The OID, never the email: the server re-resolves it against Entra, so what gets written is
  // directory-attested rather than whatever this page happened to be displaying.
  await postMap(login, { directoryOid: hit.oid }, hit.displayName ?? hit.email)
}
async function postMap(
  login: UnresolvedLogin,
  target: { teammateId: string } | { directoryOid: string },
  label: string,
) {
  if (!unresolvedResult.value) return
  mapBusyLogins.value = new Set(mapBusyLogins.value).add(login.login)
  try {
    await $fetch('/api/v1/admin/reconciliation/github/map', {
      method: 'POST',
      body: {
        enterpriseId: unresolvedResult.value.enterpriseId,
        login: login.login,
        licenseOrg: login.licenseOrg ?? undefined,
        ...target,
      },
    })
    // Drop the now-resolved login from the live list (no refetch needed — it maps 1:1).
    unresolvedResult.value = {
      ...unresolvedResult.value,
      logins: unresolvedResult.value.logins.filter((l) => l.login !== login.login),
    }
    resetMapPicker()
    flashToast('ok', `Mapped ${login.login} → ${label}.`)
  } catch (err) {
    flashToast('err', apiErrorDetail(err, 'Mapping failed.'))
    consola.warn('map login failed', err)
  } finally {
    const done = new Set(mapBusyLogins.value)
    done.delete(login.login)
    mapBusyLogins.value = done
  }
}
function closeUnresolved() {
  unresolvedResult.value = null
  unresolvedEntName.value = ''
  unresolvedEntId.value = ''
  resetMapPicker()
}
const unresolvedDialogEl = ref<HTMLElement | null>(null)
useModalA11y({
  isOpen: () => unresolvedResult.value !== null,
  dialogEl: unresolvedDialogEl as Ref<HTMLElement | null>,
  onClose: closeUnresolved,
})

// Variant cell: anthropic shows the api_kind label; github shows "—".
function orgVariant(o: OrgRow): string {
  return o.provider === 'anthropic' ? (o.apiKindLabel ?? '—') : '—'
}

// ---- backfill (on-demand historical pull) ----
// A reconciled scope (anthropic org / github enterprise) can be backfilled so §A
// surfaces older unaccounted-usage days. The requests list polls while any is
// in-flight (pending|running); the page-level Refresh button doesn't touch it
// (it's its own panel below the provider tables).
interface BackfillRequest {
  id: string
  provider: string
  targetKind: string
  externalRef: string
  displayName: string | null
  startDate: string
  endDate: string
  status: 'pending' | 'running' | 'succeeded' | 'failed'
  rowsWritten: number
  error: string | null
  requestedAt: string
  finishedAt: string | null
}
const { data: backfills, error: backfillsError, refresh: refreshBackfills } = useLazyFetch<{ requests: BackfillRequest[] } | null>(
  () => '/api/v1/admin/reconciliation/backfill',
  { server: false, default: () => null, immediate: isAdmin.value },
)
const hasInflightBackfill = computed(() =>
  (backfills.value?.requests ?? []).some((r) => r.status === 'pending' || r.status === 'running'),
)
function backfillStatusBadge(s: string): { kind: BadgeKind; label: string } {
  if (s === 'succeeded') return { kind: 'rag-green', label: 'succeeded' }
  if (s === 'failed') return { kind: 'rag-red', label: 'failed' }
  if (s === 'running') return { kind: 'rag-amber', label: 'running' }
  return { kind: 'neutral', label: 'pending' } // pending
}

// Poll every ~5s while a request is in-flight; stop once none are.
let backfillPoll: ReturnType<typeof setInterval> | null = null
function stopBackfillPoll() {
  if (backfillPoll) {
    clearInterval(backfillPoll)
    backfillPoll = null
  }
}
watch(hasInflightBackfill, (inflight) => {
  if (!import.meta.client) return
  if (inflight && !backfillPoll) {
    backfillPoll = setInterval(() => refreshBackfills(), 5000)
  } else if (!inflight) {
    stopBackfillPoll()
  }
}, { immediate: true })
onBeforeUnmount(stopBackfillPoll)

const backfillTarget = ref<BackfillTarget | null>(null)
function openBackfillOrg(o: OrgRow) {
  backfillTarget.value = {
    targetKind: 'org',
    targetId: o.id,
    provider: o.provider,
    displayName: o.displayName,
    externalRef: o.externalOrgId,
  }
}
function openBackfillEnterprise(e: EnterpriseRow) {
  backfillTarget.value = {
    targetKind: 'enterprise',
    targetId: e.id,
    provider: e.provider,
    displayName: e.displayName,
    externalRef: e.externalId,
  }
}
function onBackfillSaved() {
  backfillTarget.value = null
  flashToast('ok', 'Backfill enqueued.')
  refreshBackfills()
}
</script>

<template>
  <div
    v-if="isAdmin"
    class="max-w-[1600px] mx-auto px-10 py-8 pb-20"
    data-testid="admin-reconciliation"
    data-admin-page="/admin/reconciliation"
  >
    <UiPageHead
      eyebrow="Administration"
      title="Reconciliation"
      sub="What the billing-reconciliation engine ran, and the deltas it produced. Read-only."
    >
      <template #actions>
        <UiButton
          v-if="tab === 'providers' && isPlatformAdmin"
          kind="primary"
          size="sm"
          data-testid="admin-recon-add-enterprise"
          @click="openCreateEnterprise"
        >
          + Add enterprise
        </UiButton>
        <UiButton
          v-if="tab === 'providers'"
          kind="primary"
          size="sm"
          data-testid="admin-recon-add-org"
          @click="openCreateOrg"
        >
          + Add org
        </UiButton>
        <UiButton
          kind="secondary"
          size="sm"
          :disabled="runsPending || recsPending || orgsPending || entPending"
          data-testid="admin-recon-refresh"
          @click="tab === 'runs' ? refreshRuns() : tab === 'records' ? refreshRecs() : refreshProviders()"
        >
          Refresh
        </UiButton>
      </template>
    </UiPageHead>

    <div
      v-if="toast"
      :data-testid="`admin-recon-toast-${toast.kind}`"
      class="mb-4 p-3 rounded-md text-sm font-medium"
      :class="toast.kind === 'ok'
        ? 'bg-brand-harmony-sheer text-brand-harmony border border-brand-harmony/30'
        : 'bg-brand-hunger/10 text-brand-hunger border border-brand-hunger/30'"
    >
      {{ toast.message }}
    </div>

    <!-- Tabs -->
    <div class="flex gap-1 border-b border-carbon-6 mb-5">
      <button
        v-for="t in (['runs', 'records', 'providers'] as const)"
        :key="t"
        class="px-4 py-2 text-sm font-bold capitalize border-b-2 -mb-px transition-colors"
        :class="tab === t ? 'border-brand-vision text-carbon' : 'border-transparent text-carbon-3 hover:text-carbon-2'"
        :data-testid="`admin-recon-tab-${t}`"
        @click="tab = t"
      >
        {{ t }}
      </button>
    </div>

    <!-- First paint: the active tab's primary read is absent and not failed →
         skeleton (D2). A refetch never re-enters this branch. -->
    <AdminPageSkeleton v-if="showPageSkeleton" :tiles="4" :rows="8" />
    <template v-else>
    <!-- ======================= RUNS ======================= -->
    <div v-show="tab === 'runs'" data-testid="admin-recon-runs">
      <!-- on-demand trigger: force a reconciliation-family worker to run now
           (e.g. bind freshly-onboarded Copilot seats without waiting for cron).
           platform-admin only — the workers are global. -->
      <div v-if="canRunWorkers" class="flex flex-wrap items-center gap-2 mb-4 p-3 rounded-md border border-carbon-6">
        <span class="text-[11px] uppercase font-bold text-carbon-3">Run now</span>
        <select v-model="triggerWorker" class="text-sm border border-carbon-6 rounded-md px-3 py-1.5 bg-white" data-testid="admin-recon-trigger-worker">
          <option v-for="w in TRIGGERABLE_WORKERS" :key="w" :value="w">{{ w }}</option>
        </select>
        <button
          class="text-sm font-bold rounded-md px-3 py-1.5 bg-brand-vision text-white disabled:opacity-50"
          :disabled="triggering"
          data-testid="admin-recon-trigger-run"
          @click="runWorkerNow()"
        >
          {{ triggering ? 'Running…' : 'Run now' }}
        </button>
        <span class="text-xs text-carbon-3">Forces an on-demand run. Idempotent; a run already in progress is a no-op.</span>
      </div>

      <div class="flex flex-wrap gap-3 mb-4">
        <select v-model="runWorker" class="text-sm border border-carbon-6 rounded-md px-3 py-1.5 bg-white" data-testid="admin-recon-run-worker">
          <option value="">All workers</option>
          <option value="reconciliation-sync">reconciliation-sync</option>
          <option value="identity-sync">identity-sync</option>
          <option value="reconciliation">reconciliation</option>
          <option value="reconciliation-gap">reconciliation-gap</option>
          <option value="connector-health">connector-health</option>
        </select>
        <select v-model="runStatus" class="text-sm border border-carbon-6 rounded-md px-3 py-1.5 bg-white" data-testid="admin-recon-run-status">
          <option value="">Any status</option>
          <option value="success">success</option>
          <option value="failure">failure</option>
          <option value="running">running</option>
        </select>
      </div>

      <UiFetchErrorBanner :error="runsError" label="worker runs" @retry="refreshRuns()" />
      <UiCard>
        <ul v-if="runs?.runs.length" class="divide-y divide-carbon-6">
          <li v-for="r in runs.runs" :key="r.id" :data-testid="`admin-recon-run-${r.id}`">
            <button class="w-full flex items-center justify-between py-3 gap-4 text-left" :disabled="!isPlatformAdmin" @click="openRun(r.id)">
              <div class="flex items-center gap-3 min-w-0">
                <UiBadge :kind="statusBadge(r.status).kind">{{ statusBadge(r.status).label }}</UiBadge>
                <span class="font-mono text-sm text-carbon truncate">{{ r.worker }}</span>
                <UiBadge v-if="r.warnings.length" kind="rag-amber">{{ r.warnings.length }} warning{{ r.warnings.length === 1 ? '' : 's' }}</UiBadge>
              </div>
              <div class="text-right text-xs text-carbon-3 shrink-0">
                {{ fmtTs(r.startedAt) }} · {{ fmtDur(r.durationMs) }} · {{ r.rowsAffected ?? 0 }} rows
              </div>
            </button>
            <!-- drill-down -->
            <div v-if="openRunId === r.id" class="pb-4 pl-1 text-sm" :data-testid="`admin-recon-run-detail-${r.id}`">
              <div v-if="runDetailPending" class="text-carbon-3 italic">Loading…</div>
              <div v-else-if="runDetailError" class="text-brand-hunger text-xs">{{ runDetailError }}</div>
              <template v-else-if="selectedRun">
                <div v-if="selectedRun.warnings.length" class="mb-3">
                  <div class="text-[11px] uppercase font-bold text-carbon-3 mb-1">Warnings</div>
                  <ul class="list-disc list-inside text-brand-hunger">
                    <li v-for="(w, i) in selectedRun.warnings" :key="i">{{ w }}</li>
                  </ul>
                </div>
                <div v-if="selectedRun.error" class="mb-3 font-mono text-xs text-brand-hunger break-all">{{ selectedRun.error }}</div>
                <div v-if="resultEntries.length" class="grid grid-cols-2 sm:grid-cols-3 gap-x-6 gap-y-1">
                  <div v-for="[k, v] in resultEntries" :key="k" class="flex items-center justify-between gap-2 border-b border-carbon-7 py-1">
                    <span class="text-carbon-2 font-mono text-xs">{{ k }}</span>
                    <span class="text-carbon font-mono text-xs font-bold">{{ v }}</span>
                  </div>
                </div>
                <p v-else class="text-carbon-3 italic text-xs">No per-run result recorded (legacy run).</p>
              </template>
            </div>
          </li>
        </ul>
        <p v-else-if="!runsError" class="text-sm text-carbon-3 italic">No worker runs match. Runs appear once the scheduler dispatches a worker.</p>
      </UiCard>
    </div>

    <!-- ======================= RECORDS ======================= -->
    <div v-show="tab === 'records'" data-testid="admin-recon-records">
      <UiFetchErrorBanner :error="recsError" label="reconciliation records" @retry="refreshRecs()" />
      <p v-if="recs?.scopeNote" class="text-xs text-carbon-3 mb-3 italic">{{ recs.scopeNote }}</p>

      <!-- KPI summary -->
      <div class="grid grid-cols-2 lg:grid-cols-4 gap-4 mb-5">
        <UiCard accent="vision">
          <UiEyebrow>{{ statusLabel }}</UiEyebrow>
          <h2 class="text-2xl font-bold text-carbon mt-1" data-testid="admin-recon-kpi-total">{{ recs?.summary.total ?? 0 }}</h2>
          <p class="text-xs text-carbon-3 mt-1">{{ recs?.summary.statusScope === 'proposed' ? 'records awaiting application' : 'records in scope' }}</p>
        </UiCard>
        <UiCard accent="harmony">
          <UiEyebrow>Untagged</UiEyebrow>
          <h2 class="text-2xl font-bold text-carbon mt-1" data-testid="admin-recon-kpi-untagged">{{ usd(recs?.summary.untaggedUsd ?? 0) }}</h2>
          <p class="text-xs text-carbon-3 mt-1">{{ recs?.summary.byDisposition.untagged ?? 0 }} records over OTel, awaiting allocation</p>
        </UiCard>
        <UiCard accent="zeal">
          <UiEyebrow>Walk-back</UiEyebrow>
          <h2 class="text-2xl font-bold text-carbon mt-1">{{ usd(recs?.summary.walkBackUsd ?? 0) }}</h2>
          <p class="text-xs text-carbon-3 mt-1">{{ recs?.summary.byDisposition.walk_back ?? 0 }} records reduced toward billed truth</p>
        </UiCard>
        <UiCard accent="hunger">
          <UiEyebrow>Net delta</UiEyebrow>
          <h2 class="text-2xl font-bold text-carbon mt-1">{{ usd(recs?.summary.netDeltaUsd ?? 0) }}</h2>
          <p class="text-xs text-carbon-3 mt-1">signed sum, all dispositions (incl. indicative)</p>
        </UiCard>
      </div>

      <div class="flex flex-wrap gap-3 mb-4">
        <select v-model="recStatus" class="text-sm border border-carbon-6 rounded-md px-3 py-1.5 bg-white" data-testid="admin-recon-rec-status">
          <option value="proposed">proposed</option>
          <option value="applied">applied</option>
          <option value="rejected">rejected</option>
          <option value="superseded">superseded</option>
          <option value="all">all statuses</option>
        </select>
        <select v-model="recDisposition" class="text-sm border border-carbon-6 rounded-md px-3 py-1.5 bg-white" data-testid="admin-recon-rec-dispo">
          <option value="">All dispositions</option>
          <option value="untagged">untagged</option>
          <option value="walk_back">walk-back</option>
          <option value="no_install">no-install</option>
          <option value="ingest_only">ingest-only</option>
        </select>
        <select v-model="recProvider" class="text-sm border border-carbon-6 rounded-md px-3 py-1.5 bg-white" data-testid="admin-recon-rec-provider">
          <option value="">All providers</option>
          <option value="anthropic">anthropic</option>
          <option value="github">github</option>
        </select>
      </div>

      <UiCard>
        <div v-if="recs?.records.length" class="overflow-x-auto">
          <table class="w-full text-sm">
            <thead>
              <tr class="text-[11px] uppercase tracking-wide text-carbon-3 text-left border-b border-carbon-6">
                <th class="py-2 pr-3 font-bold">Period</th>
                <th class="py-2 pr-3 font-bold">Subject</th>
                <th class="py-2 pr-3 font-bold">Category</th>
                <th class="py-2 pr-3 font-bold">Disposition</th>
                <th class="py-2 pr-3 font-bold">Class</th>
                <th class="py-2 pr-3 font-bold text-right">Actual</th>
                <th class="py-2 pr-3 font-bold text-right">OTel</th>
                <th class="py-2 pr-3 font-bold text-right">Delta</th>
              </tr>
            </thead>
            <tbody>
              <template v-for="r in recs.records" :key="r.id">
                <tr
                  class="border-b border-carbon-7 hover:bg-carbon-8 cursor-pointer"
                  :data-testid="`admin-recon-rec-${r.id}`"
                  @click="toggleRecord(r.id)"
                >
                  <td class="py-2 pr-3 font-mono text-xs">{{ r.periodDate }}</td>
                  <td class="py-2 pr-3 truncate max-w-[200px]">{{ r.teammateEmail ?? (r.scope === 'org' ? 'org-grain' : '—') }}</td>
                  <td class="py-2 pr-3 font-mono text-xs">{{ r.category }}</td>
                  <td class="py-2 pr-3"><UiBadge :kind="dispoBadge(r.disposition).kind">{{ dispoBadge(r.disposition).label }}</UiBadge></td>
                  <td class="py-2 pr-3"><UiBadge :kind="classBadge(r.spendClass).kind">{{ classBadge(r.spendClass).label }}</UiBadge></td>
                  <td class="py-2 pr-3 text-right font-mono text-xs">{{ usd(r.actualUsd) }}</td>
                  <td class="py-2 pr-3 text-right font-mono text-xs">{{ usd(r.otelAttributedUsd) }}</td>
                  <td class="py-2 pr-3 text-right font-mono text-xs font-bold">{{ usd(r.deltaUsd) }}</td>
                </tr>
                <tr v-if="openRecordId === r.id" :data-testid="`admin-recon-rec-detail-${r.id}`">
                  <td colspan="8" class="bg-carbon-8 px-3 py-3">
                    <div class="grid grid-cols-2 sm:grid-cols-4 gap-x-6 gap-y-2 text-xs">
                      <div><span class="text-carbon-3">Provider</span><div class="font-mono">{{ r.provider }} / {{ r.enterpriseRef }}</div></div>
                      <div v-if="r.licenseOrg"><span class="text-carbon-3">License org</span><div class="font-mono">{{ r.licenseOrg }}</div></div>
                      <div><span class="text-carbon-3">Cost-owning unit</span><div class="font-mono">{{ r.costOwningUnit ?? '—' }}</div></div>
                      <div><span class="text-carbon-3">Region</span><div class="font-mono">{{ r.regionCode ?? '—' }}</div></div>
                      <div><span class="text-carbon-3">Reconcile math</span><div class="font-mono">{{ usd(r.actualUsd) }} actual − {{ usd(r.otelAttributedUsd) }} OTel = {{ usd(r.deltaUsd) }}</div></div>
                      <div v-if="r.actualQty"><span class="text-carbon-3">Native qty</span><div class="font-mono">{{ Number(r.actualQty) }} {{ r.actualUnitType }}</div></div>
                      <div v-if="r.lagState"><span class="text-carbon-3">Lag state</span><div class="font-mono">{{ r.lagState }}</div></div>
                      <div v-if="r.indicativeReason"><span class="text-carbon-3">Indicative reason</span><div class="font-mono">{{ r.indicativeReason }}</div></div>
                      <div><span class="text-carbon-3">Status</span><div><UiBadge :kind="statusBadge(r.status).kind">{{ statusBadge(r.status).label }}</UiBadge></div></div>
                      <div v-if="r.runId"><span class="text-carbon-3">Produced by run</span><div class="font-mono truncate">{{ r.runId }}</div></div>
                      <div><span class="text-carbon-3">Computed</span><div class="font-mono">{{ fmtTs(r.computedAt) }}</div></div>
                    </div>
                  </td>
                </tr>
              </template>
            </tbody>
          </table>
        </div>
        <p
          v-if="recs && recs.total > recs.records.length"
          class="text-xs text-carbon-3 mt-3"
          data-testid="admin-recon-rec-more"
        >
          Showing first {{ recs.records.length }} of {{ recs.total }} matching records (the KPI cards above reflect the full total).
        </p>
        <p v-if="!recsError && !recs?.records.length" class="text-sm text-carbon-3 italic">
          No reconciliation records match. (Note: <strong>matched</strong> deltas — within rounding noise — never produce a record.)
        </p>
      </UiCard>
    </div>

    <!-- ======================= PROVIDERS (onboarding) ======================= -->
    <div v-show="tab === 'providers'" data-testid="admin-recon-providers">
      <p class="text-xs text-carbon-3 mb-4 italic">
        The managed onboarding surface — registers the providers the reconciliation engine reconciles
        against (anthropic AND github), replacing the seed templates. The anthropic health badge runs a
        live read-only probe with the wired key; the key itself is never shown — only presence + a safe verdict.
        <span v-if="anthHealth && !anthHealth.endpointConfigured" class="text-brand-hunger not-italic font-bold">
          NUXT_ANTHROPIC_API_ENDPOINT is not configured — live probes are amber until it is set.
        </span>
      </p>

      <UiFetchErrorBanner :error="coverageError" label="GitHub org coverage" @retry="refreshCoverage()" />
      <!-- ---------- COVERAGE BANNER (Workstream D) ---------- -->
      <!-- Persisted-only (no live network call on page load) — an org whose coverage was
           never observed contributes to neither count, so a fresh/never-swept enterprise
           never renders "0 of 0 — complete" (R1-M5). -->
      <div
        v-if="coverageBanner.hasAnyGithubEnterprise && (coverageBanner.nonConnected > 0 || coverageBanner.unknownEnterprises > 0)"
        class="mb-4 rounded-md border px-4 py-3 text-sm"
        :class="coverageBanner.nonConnected > 0 ? 'border-brand-hunger bg-brand-hunger/5' : 'border-carbon-6 bg-carbon-8'"
        data-testid="admin-recon-coverage-banner"
      >
        <div class="font-bold text-carbon">
          <span v-if="coverageBanner.nonConnected > 0" data-testid="admin-recon-coverage-banner-nonconnected">
            {{ coverageBanner.nonConnected }} GitHub org{{ coverageBanner.nonConnected === 1 ? '' : 's' }} need{{ coverageBanner.nonConnected === 1 ? 's' : '' }} attention
          </span>
          <span v-else>GitHub org coverage</span>
          <span v-if="coverageBanner.unknownEnterprises > 0" class="font-normal text-carbon-2">
            — {{ coverageBanner.unknownEnterprises }} enterprise{{ coverageBanner.unknownEnterprises === 1 ? '' : 's' }} with unknown/stale coverage (no completeness claim possible until rechecked)
          </span>
        </div>
        <div v-if="Object.keys(coverageBanner.stateCounts).length" class="mt-1.5 flex flex-wrap gap-1.5">
          <UiBadge
            v-for="(count, state) in coverageBanner.stateCounts"
            :key="state"
            :kind="COVERAGE_STATE_BADGE[state as CoverageOrgObservation['state']]"
          >
            {{ count }} {{ COVERAGE_STATE_LABEL[state as CoverageOrgObservation['state']] }}
          </UiBadge>
        </div>
        <p class="mt-1.5 text-xs text-carbon-3">See the Coverage column below for per-enterprise detail and a Recheck action; each org row's remediation uses the existing Edit / Discover / Delete actions.</p>
      </div>

      <!-- ---------- ENTERPRISES ---------- -->
      <div class="flex items-baseline justify-between mb-2">
        <h2 class="text-sm font-bold text-carbon">Enterprises</h2>
        <span class="text-[11px] text-carbon-3">credential-custody unit · github holds the billing PAT here</span>
      </div>
      <UiFetchErrorBanner :error="entError" label="provider enterprises" @retry="refreshEnterprises()" />
      <UiCard class="mb-6">
        <AdminPageSkeleton v-if="!entError && entData == null" :rows="3" :toolbar="false" />
        <div v-else-if="entData?.enterprises.length" class="overflow-x-auto">
          <table class="w-full text-sm">
            <thead>
              <tr class="text-[11px] uppercase tracking-wide text-carbon-3 text-left border-b border-carbon-6">
                <th class="py-2 pr-3 font-bold">Provider</th>
                <th class="py-2 pr-3 font-bold">Name</th>
                <th class="py-2 pr-3 font-bold">External id</th>
                <th class="py-2 pr-3 font-bold">Credential</th>
                <th class="py-2 pr-3 font-bold">Mode</th>
                <th class="py-2 pr-3 font-bold">Key</th>
                <th class="py-2 pr-3 font-bold">Orgs</th>
                <th class="py-2 pr-3 font-bold">Coverage</th>
                <th class="py-2 pr-3 font-bold text-right">Actions</th>
              </tr>
            </thead>
            <tbody>
              <tr
                v-for="e in entData.enterprises"
                :key="e.id"
                class="border-b border-carbon-7 hover:bg-carbon-8"
                :data-testid="`admin-recon-ent-${e.id}`"
              >
                <td class="py-2 pr-3"><UiBadge kind="neutral">{{ e.provider }}</UiBadge></td>
                <td class="py-2 pr-3 font-bold text-carbon">{{ e.displayName }}</td>
                <td class="py-2 pr-3 font-mono text-xs truncate max-w-[180px]">{{ e.externalId }}</td>
                <td class="py-2 pr-3 font-mono text-xs">
                  {{ e.credentialSecretName ?? '—' }}
                  <!-- App-mode auth indicator (mig 0078). github-app = GitHub App
                       installation tokens; otherwise the classic PAT path. -->
                  <UiBadge
                    v-if="e.credentialKind === 'github-app'"
                    kind="harmony"
                    class="ml-1"
                    title="Authenticates via a GitHub App (installation tokens), not a classic PAT."
                  >App</UiBadge>
                </td>
                <td class="py-2 pr-3 font-mono text-xs">{{ e.reconciliationMode }}</td>
                <td class="py-2 pr-3">
                  <UiBadge :kind="e.keyPresent ? 'rag-green' : 'rag-red'">{{ e.keyPresent ? '✓' : '✗' }}</UiBadge>
                </td>
                <td class="py-2 pr-3 font-mono text-xs">{{ e.orgCount }}</td>
                <td class="py-2 pr-3" :data-testid="`admin-recon-ent-coverage-${e.id}`">
                  <span v-if="e.provider !== 'github'" class="text-carbon-3 italic text-xs" title="Coverage detection is GitHub-only (org installations are a GitHub App concept).">n/a</span>
                  <template v-else>
                    <div class="flex items-center gap-1.5">
                      <UiBadge
                        v-if="coverageByEnterprise.get(e.id)?.census.available && !coverageByEnterprise.get(e.id)?.census.stale"
                        :kind="(coverageByEnterprise.get(e.id)!.orgs.some((o) => o.state !== 'connected')) ? 'rag-amber' : 'rag-green'"
                      >
                        {{ coverageByEnterprise.get(e.id)!.orgs.filter((o) => o.state === 'connected').length }} of {{ coverageByEnterprise.get(e.id)!.census.orgCount }} connected
                      </UiBadge>
                      <UiBadge v-else kind="neutral" title="No denominator can be claimed — census never obtained, capped, or expired since the last check.">
                        coverage unknown
                      </UiBadge>
                      <UiButton
                        kind="ghost"
                        size="sm"
                        :disabled="recheckingCoverage.has(e.id)"
                        :data-testid="`admin-recon-ent-coverage-recheck-${e.id}`"
                        title="Run a live capability probe + per-org installation check now, and persist the result."
                        @click="recheckCoverage(e)"
                      >
                        {{ recheckingCoverage.has(e.id) ? '…' : 'Recheck' }}
                      </UiButton>
                    </div>
                  </template>
                </td>
                <td class="py-2 pr-3 text-right whitespace-nowrap">
                  <UiButton
                    v-if="isPlatformAdmin"
                    kind="ghost"
                    size="sm"
                    :data-testid="`admin-recon-ent-edit-${e.id}`"
                    @click="openEditEnterprise(e)"
                  >
                    Edit
                  </UiButton>
                  <UiButton
                    v-if="e.provider === 'github'"
                    kind="ghost"
                    size="sm"
                    :disabled="discoveringOrgs.has(e.id)"
                    :title="discoverTitle(e.credentialKind)"
                    :data-testid="`admin-recon-ent-discover-${e.id}`"
                    @click="discoverOrgs(e)"
                  >
                    {{ discoveringOrgs.has(e.id) ? 'Discovering…' : 'Discover Copilot orgs' }}
                  </UiButton>
                  <UiButton
                    v-if="e.provider === 'github'"
                    kind="ghost"
                    size="sm"
                    :disabled="verifying.has(e.id)"
                    title="Run a LIVE, key-safe health probe: shows exactly where this enterprise's reconciliation pipeline breaks (egress / auth / metrics-empty / no-teammate-match). Worker logs are inaccessible — this is the live signal."
                    :data-testid="`admin-recon-ent-verify-${e.id}`"
                    @click="verifyEnterprise(e)"
                  >
                    {{ verifying.has(e.id) ? 'Verifying…' : 'Verify' }}
                  </UiButton>
                  <UiButton
                    v-if="e.provider === 'github' && e.reconciliationMode === 'reconciled'"
                    kind="ghost"
                    size="sm"
                    :disabled="loadingUnresolved.has(e.id)"
                    title="List the github Copilot logins with spend/seats that AREN'T bound to a teammate yet, and map each to an existing teammate so their spend attributes."
                    :data-testid="`admin-recon-ent-unresolved-${e.id}`"
                    @click="loadUnresolved(e)"
                  >
                    {{ loadingUnresolved.has(e.id) ? 'Loading…' : 'Unresolved users' }}
                  </UiButton>
                  <UiButton
                    v-if="e.provider === 'github' && e.reconciliationMode === 'reconciled'"
                    kind="ghost"
                    size="sm"
                    :data-testid="`backfill-btn-${e.id}`"
                    title="Pull this enterprise's historical provider usage from a chosen date."
                    @click="openBackfillEnterprise(e)"
                  >
                    Backfill
                  </UiButton>
                  <UiButton
                    v-if="isPlatformAdmin && e.orgCount === 0"
                    kind="ghost"
                    size="sm"
                    :disabled="deleting.has(e.id)"
                    :data-testid="`admin-recon-ent-delete-${e.id}`"
                    @click="deleteEnterprise(e)"
                  >
                    {{ deleting.has(e.id) ? '…' : 'Delete' }}
                  </UiButton>
                  <span
                    v-else-if="isPlatformAdmin"
                    class="text-[11px] text-carbon-3 italic cursor-help ml-1"
                    title="This enterprise has linked orgs. Re-link or delete them first (the API would 409)."
                    :data-testid="`admin-recon-ent-delete-blocked-${e.id}`"
                  >
                    linked
                  </span>
                </td>
              </tr>
            </tbody>
          </table>
        </div>
        <div v-else-if="!entError" class="py-6 text-center" data-testid="admin-recon-ent-empty">
          <div class="text-sm font-bold text-carbon">No enterprises registered</div>
          <p class="text-xs text-carbon-2 mt-1">Register a GitHub or Anthropic enterprise to hold its billing credential.</p>
          <UiButton kind="secondary" size="sm" class="mt-3" data-testid="admin-recon-ent-empty-add" @click="openCreateEnterprise">
            + Add enterprise
          </UiButton>
        </div>
      </UiCard>

      <!-- ---------- ORGS ---------- -->
      <div class="flex items-baseline justify-between mb-2">
        <h2 class="text-sm font-bold text-carbon">Orgs</h2>
        <span class="text-[11px] text-carbon-3">what events attribute to · anthropic carries the live health badge</span>
      </div>
      <UiFetchErrorBanner :error="orgsError" label="provider orgs" @retry="refreshOrgs()" />
      <UiFetchErrorBanner :error="anthHealthError" label="Anthropic org health" @retry="refreshAnthHealth()" />
      <UiCard>
        <AdminPageSkeleton v-if="!orgsError && orgsData == null" :rows="3" :toolbar="false" />
        <div v-else-if="orgsData?.orgs.length" class="overflow-x-auto">
          <table class="w-full text-sm">
            <thead>
              <tr class="text-[11px] uppercase tracking-wide text-carbon-3 text-left border-b border-carbon-6">
                <th class="py-2 pr-3 font-bold">Provider</th>
                <th class="py-2 pr-3 font-bold">Name</th>
                <th class="py-2 pr-3 font-bold">Variant</th>
                <th class="py-2 pr-3 font-bold">Enterprise</th>
                <th class="py-2 pr-3 font-bold">Credential</th>
                <th class="py-2 pr-3 font-bold">Region</th>
                <th class="py-2 pr-3 font-bold">Mode</th>
                <th class="py-2 pr-3 font-bold">Key</th>
                <th class="py-2 pr-3 font-bold">Health</th>
                <th class="py-2 pr-3 font-bold">Coverage</th>
                <th class="py-2 pr-3 font-bold text-right">Actions</th>
              </tr>
            </thead>
            <tbody>
              <tr
                v-for="o in orgsData.orgs"
                :key="o.id"
                class="border-b border-carbon-7 hover:bg-carbon-8"
                :data-testid="`admin-recon-org-${o.id}`"
              >
                <td class="py-2 pr-3"><UiBadge kind="neutral">{{ o.provider }}</UiBadge></td>
                <td class="py-2 pr-3">
                  <div class="font-bold text-carbon">{{ o.displayName }}</div>
                  <div class="font-mono text-[11px] text-carbon-3 truncate max-w-[200px]">{{ o.externalOrgId }}</div>
                </td>
                <td class="py-2 pr-3">
                  <UiBadge v-if="o.provider === 'anthropic'" :kind="o.apiKind === 'enterprise-analytics' ? 'rag-green' : 'neutral'">
                    {{ orgVariant(o) }}
                  </UiBadge>
                  <span v-else class="text-carbon-3 italic text-xs" title="Anthropic only — Copilot has a single billing API, so there's no variant.">n/a</span>
                </td>
                <td class="py-2 pr-3 text-xs">
                  <span v-if="o.enterprise">{{ o.enterprise.displayName }}</span>
                  <span v-else class="text-carbon-3">—</span>
                </td>
                <td class="py-2 pr-3 font-mono text-xs">
                  <span v-if="o.provider === 'github'" class="text-carbon-3 italic" title="GitHub uses ONE billing PAT on the enterprise (it reads every org) — see the Key column. There's no org-level credential.">via enterprise</span>
                  <span v-else>{{ o.credentialSecretName ?? '—' }}</span>
                </td>
                <td class="py-2 pr-3">
                  <span v-if="o.regionCode" class="text-xs font-mono">{{ o.regionCode }}</span>
                  <span v-else-if="o.provider === 'github'" class="text-carbon-3 italic text-xs" title="No region yet — open Edit to set this org's region home (where its Copilot cost belongs).">set in Edit</span>
                  <span v-else class="text-carbon-3 italic text-xs" title="Region home is a GitHub/Copilot concept (the per-org billing region). Anthropic attributes by teammate, not org.">n/a</span>
                </td>
                <td class="py-2 pr-3 font-mono text-xs">{{ o.reconciliationMode }}</td>
                <td class="py-2 pr-3">
                  <UiBadge :kind="o.keyPresent ? 'rag-green' : 'rag-red'">{{ o.keyPresent ? '✓' : '✗' }}</UiBadge>
                  <span v-if="orgHealth(o)?.keyFormatOk === false" class="ml-1">
                    <UiBadge kind="rag-red">format</UiBadge>
                  </span>
                </td>
                <td class="py-2 pr-3">
                  <span v-if="o.provider === 'github'" class="text-carbon-3 italic text-xs" title="GitHub reconciles via the enterprise PAT — health is at the enterprise, not per-org. The Key column shows the PAT is wired.">via enterprise</span>
                  <!-- anthropic: the verdict is joined from the health read by
                       externalOrgId, so it has its own loading and error state. -->
                  <UiBadge
                    v-else-if="orgHealth(o)"
                    :kind="colorBadge[orgHealth(o)!.color]"
                    :title="reasonLabel(orgHealth(o)!.reason)"
                    :data-testid="`admin-recon-org-health-${o.id}`"
                  >
                    {{ reasonLabel(orgHealth(o)!.reason) }}
                  </UiBadge>
                  <span
                    v-else-if="anthHealth == null && !anthHealthError"
                    class="inline-block h-5 w-16 rounded-full bg-calm-2 animate-pulse align-middle"
                    role="status"
                    aria-busy="true"
                    :data-testid="`admin-recon-org-health-loading-${o.id}`"
                  ><span class="sr-only">Checking health…</span></span>
                  <span v-else-if="anthHealthError" class="text-brand-hunger italic text-xs" title="The health read failed — Retry above.">unavailable</span>
                  <span v-else class="text-carbon-3 italic text-xs">—</span>
                </td>
                <td class="py-2 pr-3" :data-testid="`admin-recon-org-coverage-${o.id}`">
                  <span v-if="o.provider !== 'github'" class="text-carbon-3 italic text-xs" title="Coverage detection is GitHub-only.">n/a</span>
                  <template v-else-if="orgCoverage(o)">
                    <UiBadge :kind="COVERAGE_STATE_BADGE[orgCoverage(o)!.state]" :title="COVERAGE_REMEDIATION_HINT[orgCoverage(o)!.state]">
                      {{ COVERAGE_STATE_LABEL[orgCoverage(o)!.state] }}
                    </UiBadge>
                    <p v-if="orgCoverage(o)!.state !== 'connected'" class="text-[11px] text-carbon-3 mt-0.5 max-w-[220px]">
                      {{ COVERAGE_REMEDIATION_HINT[orgCoverage(o)!.state] }}
                    </p>
                  </template>
                  <span v-else class="text-carbon-3 italic text-xs" title="Not yet observed by a coverage sweep/recheck.">not yet observed</span>
                </td>
                <td class="py-2 pr-3 text-right whitespace-nowrap">
                  <UiButton
                    v-if="isPlatformAdmin || o.regionId"
                    kind="ghost"
                    size="sm"
                    :data-testid="`admin-recon-org-edit-${o.id}`"
                    @click="openEditOrg(o)"
                  >
                    Edit
                  </UiButton>
                  <UiButton
                    v-if="o.provider === 'anthropic' && o.reconciliationMode === 'reconciled'"
                    kind="ghost"
                    size="sm"
                    :data-testid="`backfill-btn-${o.id}`"
                    title="Pull this org's historical provider usage from a chosen date."
                    @click="openBackfillOrg(o)"
                  >
                    Backfill
                  </UiButton>
                  <UiButton
                    v-if="isPlatformAdmin || o.regionId"
                    kind="ghost"
                    size="sm"
                    :disabled="deleting.has(o.id)"
                    :data-testid="`admin-recon-org-delete-${o.id}`"
                    @click="deleteOrg(o)"
                  >
                    {{ deleting.has(o.id) ? '…' : 'Delete' }}
                  </UiButton>
                </td>
              </tr>
            </tbody>
          </table>
        </div>
        <div v-else-if="!orgsError" class="py-6 text-center" data-testid="admin-recon-org-empty">
          <div class="text-sm font-bold text-carbon">No orgs registered</div>
          <p class="text-xs text-carbon-2 mt-1">
            Onboard an Anthropic org (use Discover to read its id from the key) or a GitHub org.
          </p>
          <UiButton kind="secondary" size="sm" class="mt-3" data-testid="admin-recon-org-empty-add" @click="openCreateOrg">
            + Add org
          </UiButton>
        </div>
      </UiCard>

      <!-- ---------- RECENT BACKFILLS ---------- -->
      <div class="flex items-baseline justify-between mb-2 mt-6">
        <h2 class="text-sm font-bold text-carbon">Recent backfills</h2>
        <span class="text-[11px] text-carbon-3">on-demand historical pulls · last 25 · auto-refreshes while in flight</span>
      </div>
      <UiFetchErrorBanner :error="backfillsError" label="recent backfills" @retry="refreshBackfills()" />
      <UiCard>
        <AdminPageSkeleton v-if="!backfillsError && backfills == null" :rows="2" :toolbar="false" />
        <ul
          v-else-if="backfills?.requests.length"
          class="divide-y divide-carbon-6"
          data-testid="backfill-requests"
        >
          <li
            v-for="b in backfills.requests"
            :key="b.id"
            class="flex items-center justify-between py-3 gap-4"
            :data-testid="`backfill-request-${b.id}`"
          >
            <div class="flex items-center gap-3 min-w-0">
              <UiBadge :kind="backfillStatusBadge(b.status).kind">{{ backfillStatusBadge(b.status).label }}</UiBadge>
              <UiBadge kind="neutral">{{ b.provider }}</UiBadge>
              <div class="min-w-0">
                <span class="font-bold text-carbon text-sm">{{ b.displayName || b.externalRef }}</span>
                <span class="font-mono text-[11px] text-carbon-3 ml-2 truncate">{{ b.startDate }} → {{ b.endDate }}</span>
              </div>
            </div>
            <div class="text-right text-xs shrink-0">
              <span v-if="b.status === 'succeeded'" class="text-brand-harmony font-mono">{{ b.rowsWritten }} row{{ b.rowsWritten === 1 ? '' : 's' }}</span>
              <span v-else-if="b.status === 'failed' && b.error" class="text-brand-hunger font-mono break-all max-w-[280px] inline-block">{{ b.error }}</span>
              <span v-else class="text-carbon-3">{{ fmtTs(b.requestedAt) }}</span>
            </div>
          </li>
        </ul>
        <p v-else-if="!backfillsError" class="text-sm text-carbon-3 italic">
          No backfills requested yet. Use the Backfill action on a reconciled scope above to pull older provider usage.
        </p>
      </UiCard>
    </div>
    </template>

    <!-- Onboarding dialogs -->
    <ProviderEnterpriseDialog
      :open="entDialogOpen"
      :target="entEditTarget"
      @close="entDialogOpen = false"
      @saved="onEnterpriseSaved"
    />
    <ProviderOrgDialog
      :open="orgDialogOpen"
      :target="orgEditTarget"
      :enterprises="enterpriseOptions"
      :regions="regionOptions"
      :regions-error="regionsError"
      :regions-loading="!regionsError && regionsData == null"
      :governance-activated="governanceActivated"
      @close="orgDialogOpen = false"
      @saved="onOrgSaved"
      @retry-regions="refreshRegions"
    />
    <BackfillDialog
      :target="backfillTarget"
      @close="backfillTarget = null"
      @saved="onBackfillSaved"
    />

    <!-- GitHub enterprise VERIFY result — a key-safe classified health probe. Shows the
         verdict badge + one line per pipeline stage so the admin can see exactly WHERE the
         reconciliation pipeline breaks without any (NSP-locked) worker-log access. -->
    <div
      v-if="verifyResult"
      class="fixed inset-0 z-50 flex items-center justify-center bg-carbon/40 p-4"
      data-testid="admin-recon-verify-modal"
      @click.self="closeVerify"
    >
      <div
        ref="verifyDialogEl"
        class="w-full max-w-lg bg-white rounded-xl shadow-xl p-6 max-h-[90vh] overflow-y-auto"
        role="dialog"
        aria-modal="true"
        aria-labelledby="admin-recon-verify-title"
      >
        <div class="flex items-start justify-between gap-4 mb-4">
          <div class="min-w-0">
            <div class="text-[11px] uppercase tracking-wide text-carbon-3 font-bold">Reconciliation health</div>
            <h3 id="admin-recon-verify-title" class="text-base font-bold text-carbon truncate">{{ verifyEntName }}</h3>
            <div class="text-[11px] font-mono text-carbon-3 mt-0.5">
              {{ verifyResult.credentialKind }} · probe day {{ verifyResult.probeDay }}
            </div>
          </div>
          <UiBadge :kind="colorBadge[verifyResult.color]" data-testid="admin-recon-verify-verdict">
            {{ VERDICT_LABEL[verifyResult.verdict] }}
          </UiBadge>
        </div>

        <ul class="space-y-2 text-sm" data-testid="admin-recon-verify-stages">
          <!-- credential -->
          <li class="flex items-start gap-2">
            <UiBadge :kind="verifyResult.stages.credential.ok ? 'rag-green' : 'rag-red'">
              {{ verifyResult.stages.credential.ok ? '✓' : '✗' }}
            </UiBadge>
            <div>
              <span class="font-bold text-carbon">credential</span>
              <span class="text-carbon-2">
                — {{ verifyResult.stages.credential.ok ? 'resolved' : stageReason(verifyResult.stages.credential.reason) }}
              </span>
            </div>
          </li>
          <!-- appAuth (App mode only) -->
          <li v-if="verifyResult.stages.appAuth" class="flex items-start gap-2">
            <UiBadge :kind="verifyResult.stages.appAuth.ok ? 'rag-green' : 'rag-red'">
              {{ verifyResult.stages.appAuth.ok ? '✓' : '✗' }}
            </UiBadge>
            <div>
              <span class="font-bold text-carbon">installation token</span>
              <span class="text-carbon-2">
                — {{ verifyResult.stages.appAuth.ok ? 'minted' : stageReason(verifyResult.stages.appAuth.reason) }}
              </span>
            </div>
          </li>
          <!-- licenses / seats -->
          <li class="flex items-start gap-2">
            <UiBadge :kind="verifyResult.stages.licenses.ok ? 'rag-green' : 'rag-red'">
              {{ verifyResult.stages.licenses.ok ? '✓' : '✗' }}
            </UiBadge>
            <div>
              <span class="font-bold text-carbon">{{ verifyResult.credentialKind === 'github-app' ? 'externalIdentities' : 'seats' }}</span>
              <span v-if="verifyResult.stages.licenses.ok" class="text-carbon-2">
                — ok · {{ verifyResult.stages.licenses.count }} {{ verifyResult.credentialKind === 'github-app' ? 'identities' : 'seats' }},
                {{ verifyResult.stages.licenses.rosterMatched }} matched
              </span>
              <span v-else class="text-brand-hunger">— {{ stageReason(verifyResult.stages.licenses.reason) }}</span>
              <!-- actionable, key-safe remediation hint (App-mode externalIdentities org-admin-read denial) -->
              <p
                v-if="verifyResult.stages.licenses.hint"
                class="mt-1 rounded-md bg-brand-harmony-sheer border-l-2 border-brand-harmony px-2 py-1 text-[11px] text-carbon-2"
                data-testid="admin-recon-verify-licenses-hint"
              >
                {{ stageHint(verifyResult.stages.licenses.hint) }}
              </p>
            </div>
          </li>
          <!-- metrics -->
          <li class="flex items-start gap-2">
            <UiBadge :kind="verifyResult.stages.metrics.skipped ? 'rag-amber' : verifyResult.stages.metrics.ok ? (verifyResult.stages.metrics.matchedRecords ? 'rag-green' : 'rag-amber') : 'rag-red'">
              {{ verifyResult.stages.metrics.skipped ? '!' : verifyResult.stages.metrics.ok ? (verifyResult.stages.metrics.matchedRecords ? '✓' : '!') : '✗' }}
            </UiBadge>
            <div>
              <span class="font-bold text-carbon">{{ verifyResult.credentialKind === 'github-app' ? 'users-1-day' : 'ai_credit/usage' }}</span>
              <!-- skipped: never render fabricated counts — say WHY the read wasn't attempted -->
              <span v-if="verifyResult.stages.metrics.skipped" class="text-carbon-2">
                — skipped · {{ verifyResult.stages.metrics.reason ? stageReason(verifyResult.stages.metrics.reason) : 'no roster-matched login to probe' }}
              </span>
              <span v-else-if="verifyResult.stages.metrics.ok" class="text-carbon-2">
                — ok · {{ verifyResult.stages.metrics.recordCount }} records, {{ verifyResult.stages.metrics.matchedRecords }} matched
                <span v-if="verifyResult.stages.metrics.recordCount && !verifyResult.stages.metrics.matchedRecords" class="text-brand-hunger font-bold">→ NO TEAMMATE MATCH</span>
                <span v-else-if="!verifyResult.stages.metrics.recordCount" class="text-brand-hunger font-bold">→ EMPTY</span>
              </span>
              <span v-else class="text-brand-hunger">— {{ stageReason(verifyResult.stages.metrics.reason) }}</span>
            </div>
          </li>
          <!-- coverage (Workstream D) — a cheap, persisted-only read; NOT re-probed by
               Verify itself (see the field doc in github-health.ts). Recheck below runs
               the live probe on demand. -->
          <li class="flex items-start gap-2" data-testid="admin-recon-verify-coverage">
            <UiBadge :kind="verifyResult.coverage.available && !verifyResult.coverage.stale ? (verifyResult.coverage.nonConnected > 0 ? 'rag-amber' : 'rag-green') : 'neutral'">
              {{ verifyResult.coverage.available && !verifyResult.coverage.stale ? (verifyResult.coverage.nonConnected > 0 ? '!' : '✓') : '?' }}
            </UiBadge>
            <div class="flex-1">
              <span class="font-bold text-carbon">org coverage</span>
              <span v-if="verifyResult.coverage.available && !verifyResult.coverage.stale" class="text-carbon-2">
                — {{ verifyResult.coverage.denominator != null ? `${verifyResult.coverage.connected} of ${verifyResult.coverage.denominator} orgs connected` : `${verifyResult.coverage.connected} connected (no denominator — census capped)` }}
                <span v-if="verifyResult.coverage.nonConnected > 0" class="text-brand-hunger font-bold">→ {{ verifyResult.coverage.nonConnected }} NEED ATTENTION</span>
              </span>
              <span v-else class="text-carbon-2">
                — coverage unknown{{ verifyResult.coverage.observedAt ? ` (last observed ${verifyResult.coverage.observedAt}, now stale)` : ' (never observed)' }}
              </span>
              <p class="text-[11px] text-carbon-3 mt-0.5">See the Coverage column on the Orgs/Enterprises tables below, or Recheck this enterprise from its row.</p>
            </div>
          </li>
        </ul>

        <div class="flex justify-end mt-5">
          <UiButton kind="secondary" size="sm" data-testid="admin-recon-verify-close" @click="closeVerify">Close</UiButton>
        </div>
      </div>
    </div>

    <!-- UNRESOLVED Copilot users — the live github logins with spend/seats not yet bound to a
         teammate. Each row has a teammate picker → Map (POST writes the enterprise lane), then
         the reconciler attributes their spend. Key-safe: no secrets in the payload. -->
    <div
      v-if="unresolvedResult"
      class="fixed inset-0 z-50 flex items-center justify-center bg-carbon/40 p-4"
      data-testid="admin-recon-unresolved-modal"
      @click.self="closeUnresolved"
    >
      <div
        ref="unresolvedDialogEl"
        class="w-full max-w-2xl bg-white rounded-xl shadow-xl p-6 max-h-[90vh] overflow-y-auto"
        role="dialog"
        aria-modal="true"
        aria-labelledby="admin-recon-unresolved-title"
      >
        <div class="flex items-start justify-between gap-4 mb-4">
          <div class="min-w-0">
            <div class="text-[11px] uppercase tracking-wide text-carbon-3 font-bold">Unresolved Copilot users</div>
            <h3 id="admin-recon-unresolved-title" class="text-base font-bold text-carbon truncate">{{ unresolvedEntName }}</h3>
            <div class="text-[11px] font-mono text-carbon-3 mt-0.5">
              {{ unresolvedResult.credentialKind }}<span v-if="unresolvedResult.probeDay"> · probe day {{ unresolvedResult.probeDay }}</span>
            </div>
          </div>
          <UiBadge :kind="unresolvedResult.logins.length ? 'rag-amber' : 'rag-green'" data-testid="admin-recon-unresolved-count">
            {{ unresolvedResult.logins.length }} unresolved
          </UiBadge>
        </div>

        <p class="text-[12px] text-carbon-2 mb-3">
          These github logins have Copilot spend/seats but aren't bound to a teammate, so their
          spend isn't attributed. Map each to an existing teammate — the reconciler picks it up on
          its next run.
        </p>

        <div v-if="unresolvedResult.logins.length === 0" class="py-6 text-center text-sm text-carbon-2" data-testid="admin-recon-unresolved-empty">
          No unresolved Copilot users — every seat/spend login is bound to a teammate.
        </div>
        <ul v-else class="divide-y divide-calm-2 border border-calm-2 rounded-md" data-testid="admin-recon-unresolved-list">
          <li v-for="l in unresolvedResult.logins" :key="l.login" class="px-3 py-2.5">
            <div class="flex items-center gap-3">
              <div class="min-w-0 flex-1">
                <div class="text-sm font-mono text-carbon truncate">{{ l.login }}</div>
                <!-- Self-asserted github profile text. Labelled as such because it looks
                     authoritative and is not: it informs the admin's choice, it never makes
                     one. See getUserProfile in github-client.ts. -->
                <div v-if="l.profileName || l.profileEmail" class="text-[11px] text-carbon-2 truncate">
                  <span v-if="l.profileName">{{ l.profileName }}</span>
                  <span v-if="l.profileEmail"><span v-if="l.profileName"> · </span>{{ l.profileEmail }}</span>
                  <span class="text-carbon-3 italic"> · from github profile, unverified</span>
                </div>
                <div class="text-[11px] text-carbon-3 truncate">
                  <span v-if="l.licenseOrg">org {{ l.licenseOrg }}</span>
                  <span v-if="l.credits != null"><span v-if="l.licenseOrg"> · </span>{{ l.credits }} credits<span v-if="l.lastSeenDay"> ({{ l.lastSeenDay }})</span></span>
                  <span v-if="!l.licenseOrg && l.credits == null" class="italic">no extra context</span>
                </div>
              </div>
              <UiButton
                kind="primary"
                size="sm"
                :disabled="isMapBusy(l.login)"
                :data-testid="`admin-recon-unresolved-map-${l.login}`"
                @click="openMapPicker(l.login)"
              >
                {{ mapSearchFor === l.login ? 'Cancel' : 'Map' }}
              </UiButton>
            </div>

            <!-- Teammate picker (opens inline under the login being mapped). -->
            <div v-if="mapSearchFor === l.login" class="mt-2 pl-1">
              <input
                v-model="mapQuery"
                type="search"
                placeholder="Search teammates by name or email…"
                class="w-full px-3 py-2 text-sm border border-calm-2 rounded-md focus:border-brand-harmony focus:outline-none"
                :data-testid="`admin-recon-unresolved-search-${l.login}`"
                @input="onMapQueryInput"
              >
              <ul v-if="mapResults.length" class="mt-2 border border-calm-2 rounded-md divide-y divide-calm-2">
                <li v-for="tm in mapResults" :key="tm.id" class="flex items-center gap-3 px-3 py-2">
                  <div class="min-w-0 flex-1">
                    <div class="text-sm text-carbon truncate">{{ tm.displayName ?? tm.email }}</div>
                    <div class="text-[11px] text-carbon-3 truncate">
                      {{ tm.email }}<span v-if="tm.regionCode"> · {{ tm.regionCode }}</span><span v-if="tm.orgUnitCode"> · {{ tm.orgUnitCode }}</span>
                    </div>
                  </div>
                  <UiButton
                    kind="primary"
                    size="sm"
                    :disabled="isMapBusy(l.login) || mapSearching"
                    :data-testid="`admin-recon-unresolved-assign-${l.login}-${tm.id}`"
                    @click="mapLogin(l, tm)"
                  >
                    Assign
                  </UiButton>
                </li>
              </ul>
              <!-- Shown ALONGSIDE any teammate matches, not only when there are none: the
                   teammate search is a substring match, so one unrelated hit would otherwise
                   hide the directory result the admin is actually looking for. Anyone already
                   returned above is filtered out server-side, but that is a de-duplication
                   courtesy over one page of results, not a guarantee, which is why the label
                   says what the action DOES rather than asserting the person is not already a
                   teammate. -->
              <p v-if="mapDirectory.length" class="text-[12px] text-carbon-3 mt-2">
                Found in the directory (adding one assigns the login to them):
              </p>
              <ul v-if="mapDirectory.length" class="mt-1 border border-calm-2 rounded-md divide-y divide-calm-2">
                <li v-for="d in mapDirectory" :key="d.oid" class="flex items-center gap-3 px-3 py-2">
                  <div class="min-w-0 flex-1">
                    <div class="text-sm text-carbon truncate">{{ d.displayName ?? d.email }}</div>
                    <div class="text-[11px] text-carbon-3 truncate">
                      {{ d.email }}<span v-if="d.jobTitle"> · {{ d.jobTitle }}</span><span v-if="d.department"> · {{ d.department }}</span>
                    </div>
                  </div>
                  <UiButton
                    kind="secondary"
                    size="sm"
                    :disabled="isMapBusy(l.login) || mapSearching"
                    :data-testid="`admin-recon-unresolved-provision-${l.login}-${d.oid}`"
                    @click="mapLoginToDirectory(l, d)"
                  >
                    Add + assign
                  </UiButton>
                </li>
              </ul>
              <!-- Shown on ANY directory failure, even when teammates matched: a silent
                   omission would read as "this person is not in the directory", which is the one
                   outcome that misleads. -->
              <p
                v-if="mapDirectoryError"
                class="text-[12px] text-brand-hunger mt-2"
              >
                The directory could not be searched, so directory matches are not shown here —
                this does not mean the person is absent from it. Retry, or pick an existing teammate.
              </p>
              <p
                v-else-if="!mapResults.length && !mapDirectory.length && mapQuery.trim() && !mapSearching"
                class="text-[12px] text-carbon-3 mt-2"
              >
                No matching teammates or directory users.
              </p>
            </div>
          </li>
        </ul>

        <div class="flex justify-end mt-5">
          <UiButton kind="secondary" size="sm" data-testid="admin-recon-unresolved-close" @click="closeUnresolved">Close</UiButton>
        </div>
      </div>
    </div>
  </div>
  <div v-else class="max-w-[1600px] mx-auto px-10 py-16 text-center" data-admin-page="/admin/reconciliation">
    <div class="text-lg font-bold text-carbon">Admin access required.</div>
  </div>
</template>
