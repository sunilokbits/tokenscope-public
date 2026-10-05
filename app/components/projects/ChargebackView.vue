<script setup lang="ts">
/*
 * The project page's chargeback lens body, shared by member depth and reports
 * depth. Renders only what the server's `chargeback` block carries
 * (docs/design/project-chargeback-lens.md); it computes no money of its own.
 */
import { computed } from 'vue'
import SettlingStateChip from '../reporting/SettlingStateChip.vue'
import DrillName from '../reporting/DrillName.vue'
import type { DrillTarget } from '../reporting/drill-contract'
import { PROJECT_LENS_COPY } from '#shared/usage/lens'
import type {
  ProjectChargeback,
  ProjectChargebackMemberContributors,
  ProjectChargebackScopedContributors,
  ProjectChargebackWindow,
} from '#shared/reports/project-chargeback'

type ScopedNamed = ProjectChargebackScopedContributors['named'][number]

const props = defineProps<{
  block: ProjectChargeback<ProjectChargebackMemberContributors | ProjectChargebackScopedContributors>
  window: ProjectChargebackWindow
  windowWord: string
  /** Reports depth only: resolves a named row's drill; null renders plain text. */
  drillTarget?: (row: ScopedNamed) => DrillTarget | null
}>()

const DAY_MS = 86_400_000
const dayOf = (ms: number) => new Date(ms).toISOString().slice(0, 10)

interface Row {
  key: string
  label: string
  cost_usd: string
  kind: 'named' | 'aggregate'
  scoped?: ScopedNamed
}

/*
 * One row list for both depths. Member depth names every member, or (cou-owner)
 * shows one aggregate over `member_count`; reports depth names in-scope rows and
 * folds the rest into the server's single labelled remainder.
 */
const rows = computed<Row[]>(() => {
  const c = props.block.contributors
  if ('named' in c) {
    const out: Row[] = c.named.map((n) => ({
      key: n.teammate_id,
      label: n.display_name,
      cost_usd: n.cost_usd,
      kind: 'named',
      scoped: n,
    }))
    if (c.remainder.members > 0) {
      out.push({ key: 'remainder', label: c.remainder.label, cost_usd: c.remainder.cost_usd, kind: 'aggregate' })
    }
    return out
  }
  if (c.members.length) {
    return c.members.map((m) => ({
      key: m.teammate_id,
      label: m.display_name ?? m.email,
      cost_usd: m.cost_usd,
      kind: 'named',
    }))
  }
  if (c.member_count > 0) {
    return [
      {
        key: 'aggregate',
        label: `${c.member_count} teammate${c.member_count === 1 ? '' : 's'}`,
        cost_usd: props.block.total_usd,
        kind: 'aggregate',
      },
    ]
  }
  return []
})

/*
 * The axis comes from the payload's own window: `days_elapsed` counts days
 * begun, so a window still in progress has today as its last begun day, drawn
 * partial; a complete window runs to its own `to`.
 */
const axis = computed(() => {
  const w = props.window
  const start = Date.parse(`${w.from}T00:00:00Z`)
  if (w.days_elapsed >= w.days_in_window) {
    return { endDay: w.to, days: w.days_in_window, partialDay: null as string | null }
  }
  const today = dayOf(start + (w.days_elapsed - 1) * DAY_MS)
  return {
    endDay: dayOf(start + (w.days_elapsed - 2) * DAY_MS),
    days: Math.max(0, w.days_elapsed - 1),
    partialDay: today,
  }
})

const seriesRows = computed(() =>
  props.block.series.map((p) => ({ day: p.date, key: 'chargeback', value: Number(p.cost_usd) })),
)

const barMax = computed(() => Math.max(0, ...rows.value.map((r) => Number(r.cost_usd))))
function barWidth(usd: string): string {
  return barMax.value > 0 ? `${Math.min(100, (Number(usd) / barMax.value) * 100).toFixed(1)}%` : '0%'
}
</script>

<template>
  <div class="space-y-5" data-testid="proj-chargeback">
    <p class="text-[12px] text-carbon-3" data-testid="proj-cb-hidden-cards">
      Model mix, activity mix, burn vs allocation, velocity and untagged pressure measure
      attributed usage, not the bill, so they are hidden under chargeback.
    </p>

    <section class="flex items-baseline gap-3 flex-wrap border-b border-calm-2 pb-3" data-testid="proj-cb-band">
      <span class="text-[17px] font-extrabold text-carbon">{{ windowWord }}</span>
      <span
        class="text-[22px] font-extrabold text-carbon tracking-[-0.02em] tabular-nums"
        data-testid="proj-cb-total"
      >{{ fmtUsd(block.total_usd) }}</span>
      <span class="text-[12.5px] text-carbon-2">{{ PROJECT_LENS_COPY.chargeback.basis }}</span>
      <SettlingStateChip
        :state="block.settling.state"
        :horizon-date="block.settling.settlesAt"
        :vendor="block.settling.vendor"
        :data-testid="`proj-cb-settling-${block.settling.vendor}`"
      />
    </section>

    <div class="space-y-1 text-[12px] text-carbon-2">
      <p data-testid="proj-cb-copilot-note">Copilot is billed per Business Unit, not per project.</p>
      <p data-testid="proj-cb-untagged-note">
        Untagged spend is not on any project until it is tagged in the worklist.
      </p>
    </div>

    <UiCard data-testid="proj-cb-daily">
      <UiEyebrow>Daily bill chargeback · {{ windowWord }}</UiEyebrow>
      <ChartsStackedBars
        :rows="seriesRows"
        :label-for="() => 'Bill chargeback'"
        :window-days="axis.days"
        :end-day="axis.endDay"
        :partial-day="axis.partialDay"
        :height="150"
      />
    </UiCard>

    <UiCard data-testid="proj-cb-contributors">
      <div class="flex items-center justify-between mb-1 gap-3">
        <UiEyebrow>Contributors</UiEyebrow>
        <slot name="actions" />
      </div>
      <ul class="mt-3 divide-y divide-calm-1">
        <li
          v-for="r in rows"
          :key="r.key"
          class="flex items-center gap-3 py-2"
          :data-testid="r.kind === 'aggregate' ? 'proj-cb-remainder' : 'proj-cb-contributor'"
        >
          <span class="w-[180px] shrink-0 truncate text-sm" :class="r.kind === 'aggregate' ? 'text-carbon-3' : ''">
            <DrillName v-if="r.scoped" :target="drillTarget ? drillTarget(r.scoped) : null" :label="r.label" />
            <template v-else>{{ r.label }}</template>
          </span>
          <span class="flex-1 h-2 rounded-full bg-calm-1 overflow-hidden">
            <span
              class="block h-full rounded-full"
              :class="r.kind === 'aggregate' ? 'bg-calm-2' : 'bg-brand-harmony'"
              :style="{ width: barWidth(r.cost_usd) }"
            />
          </span>
          <span class="w-[90px] text-right tabular-nums text-sm">{{ fmtUsd(r.cost_usd) }}</span>
        </li>
      </ul>
      <p
        v-if="!rows.length"
        class="text-sm text-carbon-3 italic py-4"
        data-testid="proj-cb-empty"
      >
        No bill chargeback on this project in this window.
      </p>
    </UiCard>
  </div>
</template>
