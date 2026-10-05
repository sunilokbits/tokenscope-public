<script setup lang="ts">
/*
 * AdminWorkerRunsPanel — the recent runs of ONE worker, and the drill-down into
 * a single run.
 *
 * Why: docs/design/alert-diagnosability.md D5. An operator paged by ops-alert
 * opened Admin → Workers and could see only `95 runs · p50 1.7s`. The run that
 * raised the alert took 5 293 ms; a median cannot show a tail, and there was no
 * route from this page to the run itself. The data was already in the API.
 *
 * Both reads are ON DEMAND — a `$fetch` on mount (the panel only mounts after a
 * click) and a second on opening a run. Nothing here runs at page setup, which
 * is what keeps the workers page inside the navigation budget
 * (docs/design/admin-nav-responsiveness.md D1: setup awaits no network call).
 *
 * The list is the RAW ledger, newest first: no bucketing and no invented
 * "healthy/slow" verdict. The only computed emphasis is the slowest run in the
 * window — a fact about the rows on screen, not a threshold (D5).
 */
import { computed, onMounted, ref } from 'vue'
import { fmtDurationMs } from '../../composables/useFormat'
import type { WorkerRunDetailData } from './WorkerRunDetail.vue'

/** A row of GET /api/v1/admin/worker-runs?worker=<name>. */
interface WorkerRunRow {
  id: string
  worker: string
  status: string
  startedAt: string
  finishedAt: string | null
  durationMs: number | null
  hasError: boolean
  warnings: string[]
}

const props = withDefaults(defineProps<{
  worker: string
  /** How much history to pull. 30 runs is ~7 h of a 15-minute job. */
  limit?: number
  /** Run detail is platform-admin only (GET worker-runs/[id]). */
  canOpenDetail?: boolean
}>(), { limit: 30, canOpenDetail: true })

const EM_DASH = '—'

const runs = ref<WorkerRunRow[] | null>(null)
const listError = ref<unknown>(null)
const listPending = ref(false)

async function loadRuns() {
  listPending.value = true
  listError.value = null
  try {
    const res = await $fetch<{ runs: WorkerRunRow[] }>('/api/v1/admin/worker-runs', {
      query: { worker: props.worker, limit: props.limit },
    })
    runs.value = res.runs
  } catch (e) {
    listError.value = e
  } finally {
    listPending.value = false
  }
}
onMounted(loadRuns)

/*
 * The slowest run AMONG THE ROWS SHOWN. Not a health verdict — the marker says
 * "this is the tail of what you are looking at", which is exactly the thing p50
 * hides. Runs with no recorded duration (reaped rows) cannot compete for it.
 */
const slowestRunId = computed<string | null>(() => {
  let best: WorkerRunRow | null = null
  for (const r of runs.value ?? []) {
    if (r.durationMs === null) continue
    if (best === null || r.durationMs > (best.durationMs ?? -1)) best = r
  }
  return best?.id ?? null
})

type BadgeKind = 'rag-green' | 'rag-red' | 'rag-amber' | 'neutral'
function statusKind(s: string): BadgeKind {
  if (s === 'success') return 'rag-green'
  if (s === 'failure') return 'rag-red'
  if (s === 'running') return 'rag-amber'
  return 'neutral'
}
/** An instant, not a day bucket — viewer's zone (CLAUDE.md, the clock). */
function fmtStamp(iso: string | null): string {
  return iso ? new Date(iso).toLocaleString() : EM_DASH
}
function msTitle(ms: number | null): string {
  return ms === null ? 'No duration recorded for this run' : `${ms.toLocaleString()} ms`
}

// ── one run's detail ────────────────────────────────────────────────────────
const openRunId = ref<string | null>(null)
const detail = ref<WorkerRunDetailData | null>(null)
const detailPending = ref(false)
const detailError = ref<string | null>(null)

async function openRun(id: string) {
  if (openRunId.value === id) {
    openRunId.value = null
    detail.value = null
    return
  }
  const reqId = id
  openRunId.value = id
  detail.value = null
  detailError.value = null
  detailPending.value = true
  try {
    const d = await $fetch<WorkerRunDetailData>(`/api/v1/admin/worker-runs/${id}`)
    if (openRunId.value !== reqId) return // a newer selection superseded this fetch
    detail.value = d
  } catch {
    if (openRunId.value !== reqId) return // ignore a stale failure
    detailError.value = 'Failed to load run detail (it may have been cleaned up).'
  } finally {
    if (openRunId.value === reqId) detailPending.value = false
  }
}
</script>

<template>
  <div
    class="mt-2 border-t border-carbon-6 pt-3"
    data-testid="worker-runs-panel"
    :aria-busy="listPending && runs === null ? 'true' : undefined"
  >
    <UiFetchErrorBanner :error="listError" label="this worker's recent runs" @retry="loadRuns()" />

    <p v-if="listError === null && runs === null" class="text-xs text-carbon-3 italic">
      Loading recent runs…
    </p>
    <p v-else-if="runs && runs.length === 0" class="text-xs text-carbon-3 italic">
      No runs recorded for this worker.
    </p>
    <ul v-else-if="runs" class="divide-y divide-carbon-7">
      <li v-for="r in runs" :key="r.id" :data-testid="`worker-run-${r.id}`">
        <button
          type="button"
          class="w-full flex items-center justify-between gap-3 py-1.5 text-left cursor-pointer disabled:cursor-default"
          :aria-expanded="openRunId === r.id"
          :disabled="!props.canOpenDetail"
          @click="openRun(r.id)"
        >
          <span class="flex items-center gap-2 min-w-0">
            <UiBadge :kind="statusKind(r.status)">{{ r.status }}</UiBadge>
            <span class="text-[11px] text-carbon-3 truncate">{{ fmtStamp(r.startedAt) }}</span>
            <!-- An error recorded on a run the ledger did not mark 'failure' is
                 still an error; the status badge alone would hide it. -->
            <UiBadge v-if="r.hasError && r.status !== 'failure'" kind="rag-red">error</UiBadge>
            <UiBadge v-if="r.warnings.length" kind="rag-amber">
              {{ r.warnings.length }} warning{{ r.warnings.length === 1 ? '' : 's' }}
            </UiBadge>
          </span>
          <span class="flex items-center gap-2 shrink-0">
            <UiBadge
              v-if="r.id === slowestRunId"
              kind="vision"
              title="Slowest of the runs listed here"
              data-testid="worker-run-slowest"
            >
              slowest
            </UiBadge>
            <span class="font-mono text-xs text-carbon-2" :title="msTitle(r.durationMs)">
              {{ fmtDurationMs(r.durationMs) }}
            </span>
          </span>
        </button>

        <div v-if="openRunId === r.id" :data-testid="`worker-run-detail-${r.id}`">
          <p v-if="detailPending" class="text-xs text-carbon-3 italic pb-3">Loading…</p>
          <p v-else-if="detailError" class="text-xs text-brand-hunger pb-3">{{ detailError }}</p>
          <AdminWorkerRunDetail v-else-if="detail" :run="detail" />
        </div>
      </li>
    </ul>
  </div>
</template>
