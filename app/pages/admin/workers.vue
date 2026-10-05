<script setup lang="ts">
/*
 * Admin -> Operations -> Worker controls.
 *
 * Turning a worker on or off is an ACTION, not an observation, so it lives on
 * its own page rather than inside Diagnostics. Diagnostics answers "are the
 * workers running correctly"; this page answers "which ones should be running".
 * Keeping a mutating control inside a read-only health page made the destructive
 * affordance easy to hit while scanning for a fault, and made the health page
 * the answer to two unrelated questions.
 *
 * The two surfaces stay linked, in both directions, because you almost always
 * arrive at one from the other: you disable a worker BECAUSE its health is bad,
 * and you check health AFTER disabling something.
 *
 * The cron keeps firing when a worker is off (mig 0090) — the dispatch
 * short-circuits and records a 'skipped' run, so Diagnostics shows WHY nothing
 * happened rather than an unexplained gap.
 */
import { computed, ref } from 'vue'

definePageMeta({ layout: 'admin', middleware: 'admin' })
useHead({ title: 'Worker controls · TokenScope' })

const { session } = useSession()

// The two enablement endpoints sit at DIFFERENT tiers, so this page needs two
// checks, not one. Reading is admin / platform-admin (enablement.get); the fetch
// stays cold for anyone else so an unauthorised visit does not fire a 403 on load.
const isAdmin = computed(() => {
  const r = session.value?.role
  return r === 'admin' || r === 'platform-admin'
})

// Writing is platform-admin only (enablement.put) — `worker_enablement` has no
// region column and every worker it governs runs estate-wide, so a toggle exceeds
// a region admin's scope. A region admin still SEES the card: knowing which
// kill-switches are thrown is not a region boundary crossing, and hiding it would
// leave them unable to explain a gap in their own region's attribution. The API is
// the real gate — withholding the button just avoids offering a certain 403.
const canToggle = computed(() => {
  const r = session.value?.role
  return r === 'platform-admin'
})

interface WorkerEnablementRow {
  name: string
  recommendedCron: string | null
  scheduled: boolean
  unscheduledReason: string | null
  enabled: boolean
  reason: string | null
  explicit: boolean
}

// Lazy, client-only, null default: docs/design/admin-nav-responsiveness.md D1/D2.
const {
  data: enablementData,
  error: enablementError,
  refresh: refreshEnablement,
  pending: enablementPending,
} = useLazyFetch<{ workers: WorkerEnablementRow[] } | null>('/api/v1/admin/workers/enablement', {
  server: false,
  default: () => null,
  immediate: isAdmin.value,
})

// 24 h duty-cycle summary — this card is O4's SPECIFIED consumer
// (docs/design/performance-observability-baseline.md, dr-H7). Same read gate as
// the list above (admin | platform-admin), so the same cold-fetch guard applies.
// A worker with no completed run in the window has no entry; the row renders
// em-dashes for it.
const {
  data: summaryData,
  error: summaryError,
  refresh: refreshSummary,
} = useLazyFetch<{ summary: WorkerRunSummary[] } | null>('/api/v1/admin/worker-runs', {
  query: { summary: '24h' },
  server: false,
  default: () => null,
  immediate: isAdmin.value,
})

interface WorkerRunSummary {
  workerName: string
  runs: number
  p50Ms: number | null
  maxMs: number | null
  busyMs: number
}

const summaryByWorker = computed(
  () => new Map((summaryData.value?.summary ?? []).map((s) => [s.workerName, s])),
)

async function refreshAll() {
  await Promise.all([refreshEnablement(), refreshSummary()])
}

/*
 * Which worker's recent-runs panel is open (docs/design/alert-diagnosability.md
 * D5). One at a time: an operator arrives here holding a page about ONE worker,
 * and an accordion keeps the run reads on demand — the panel is only mounted
 * while open, so nothing here is fetched during navigation.
 */
const openRunsWorker = ref<string | null>(null)
function toggleRuns(name: string) {
  openRunsWorker.value = openRunsWorker.value === name ? null : name
}

const togglingWorker = ref<string | null>(null)
async function toggleWorker(w: WorkerEnablementRow) {
  const turningOff = w.enabled
  // A disable must say why — the next person (or the next incident) should not
  // have to guess, and the API rejects a reasonless disable.
  const reason = turningOff
    ? (globalThis.prompt(`Disable "${w.name}"? Give a reason (recorded + audited):`) ?? '').trim()
    : ''
  if (turningOff && !reason) return
  togglingWorker.value = w.name
  try {
    await $fetch('/api/v1/admin/workers/enablement', {
      method: 'PUT',
      body: { workerName: w.name, enabled: !w.enabled, ...(turningOff ? { reason } : {}) },
    })
    await refreshEnablement()
  } finally {
    togglingWorker.value = null
  }
}
</script>

<template>
  <div class="flex flex-col gap-4" data-admin-page="/admin/workers">
    <header class="flex items-start justify-between gap-4">
      <div>
        <h1 class="text-lg font-bold text-carbon m-0">Worker controls</h1>
        <p class="text-xs text-carbon-3 mt-1 max-w-2xl">
          Turn a scheduled worker off without a deploy — it takes effect on its next tick.
          Disabling is audited and needs a reason. A disabled worker still records a
          <span class="font-mono">skipped</span> run, so it never looks like a silent gap.
          To see whether the workers are actually succeeding, use
          <NuxtLink to="/admin/diagnostics" class="text-brand-harmony underline">Diagnostics</NuxtLink>.
          <span class="font-bold">Recent runs</span> on a row opens that worker's run history and
          what each run recorded.
        </p>
      </div>
      <UiButton
        kind="secondary"
        size="sm"
        :disabled="enablementPending"
        data-testid="worker-controls-refresh"
        @click="refreshAll()"
      >
        {{ enablementPending ? 'Loading…' : 'Refresh' }}
      </UiButton>
    </header>

    <UiCard accent="vision" data-testid="admin-worker-enablement">
      <!-- A failed summary fetch must be DISTINGUISHABLE from "no completed
           runs" (r3-M4): silent em-dashes would read as a healthy idle fleet. -->
      <p
        v-if="summaryError"
        class="mb-2 text-xs text-amber-600"
        data-testid="worker-summary-error"
      >
        24 h run summary unavailable ({{ summaryError.statusCode ?? 'fetch failed' }}) — the
        columns below show only enablement state.
      </p>
      <UiFetchErrorBanner v-if="enablementError" :error="enablementError" label="worker controls" @retry="refreshEnablement" />
      <AdminPageSkeleton v-else-if="enablementData == null" :rows="6" :toolbar="false" />
      <ul v-else-if="enablementData.workers.length" class="divide-y divide-carbon-6">
        <AdminWorkerControlRow
          v-for="w in enablementData.workers"
          :key="w.name"
          :worker="w"
          :busy="togglingWorker === w.name"
          :can-toggle="canToggle"
          :summary="summaryByWorker.get(w.name) ?? null"
          :runs-open="openRunsWorker === w.name"
          @toggle="toggleWorker(w)"
          @toggle-runs="toggleRuns(w.name)"
        >
          <template #runs>
            <AdminWorkerRunsPanel :worker="w.name" :can-open-detail="canToggle" />
          </template>
        </AdminWorkerControlRow>
      </ul>
      <p v-else class="text-sm text-carbon-3 italic">
        No workers registered. This is a bootstrap state, not a healthy one.
      </p>
    </UiCard>
  </div>
</template>
