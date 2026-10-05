<script setup lang="ts">
/*
 * Region detail (feat/admin-region-lifecycle). Absorbs the old admin
 * mega-tab (app/pages/admin/region.vue) into a per-region page reached
 * from /admin/regions, and adds an EDITABLE Business Unit (org-unit) tree.
 *
 * Tabs (URL `?tab=`): Business Units (default, slug stays `cost-centres`) / Teammates / Setup
 * checklist / Connectors.
 *
 * RBAC: admin / platform-admin. Region scoping is
 * server-enforced; a region-bounded admin hitting another region's id
 * gets a 403 → the `regionError` state renders. Platform-admin can
 * additionally rename the region inline.
 *
 * Business Unit edit affordances live in THIS page (a compact depth-
 * indented list) rather than OrgTree, which stays a read-only renderer.
 * Re-parent is deferred server-side, so the UI signposts it as
 * coming-soon rather than hiding it.
 */

import { computed, ref, watch } from 'vue'
import { consola } from 'consola'
import AdminTabs, { type AdminTab } from '../../../components/admin/AdminTabs.vue'
import type { OrgNode } from '../../../components/admin/OrgTree.vue'
import OrgUnitDialog from '../../../components/admin/OrgUnitDialog.vue'
import MoveOrgUnitDialog from '../../../components/admin/MoveOrgUnitDialog.vue'
import EntityTable from '../../../components/admin/EntityTable.vue'
import ConnectorCard, { type ConnectorStatus } from '../../../components/admin/ConnectorCard.vue'
import ChecklistRow from '../../../components/admin/ChecklistRow.vue'
import SetupProgressBar from '../../../components/admin/SetupProgressBar.vue'
import BulkPlaceDialog from '../../../components/admin/BulkPlaceDialog.vue'
import PlacementRuleOffer from '../../../components/admin/PlacementRuleOffer.vue'
import ReResolvePlacementDialog from '../../../components/admin/ReResolvePlacementDialog.vue'
import DefaultUnitClustersDialog from '../../../components/admin/DefaultUnitClustersDialog.vue'
// `#shared`, never a relative path: a relative `shared/` import resolves in dev
// and vitest but RollupErrors in the Nitro prod build (which CI does not run).
import { HOLDING_UNIT_TYPE } from '#shared/placement/holding-nodes'
import { isPlacementFilter, type PlacementFilter } from '#shared/placement/placement-filter'
import { regionAttributeLabel } from '#shared/placement/region-attributes'
import { BU_LABEL_PLURAL } from '#shared/reports/vocabulary'
definePageMeta({
  layout: 'admin',
  middleware: 'admin',
  // Remount on region-id change (not on ?tab= changes) so route-param-derived
  // reads — and the breadcrumb tail — never serve a stale region when Vue Router
  // reuses this component between two /admin/regions/:id navigations.
  key: (route) => String(route.params.id),
})

interface RegionResp {
  region: { id: string; code: string; display_name: string }
  counts: Record<string, number>
  connector: { label: string; status: ConnectorStatus }
  checklist: {
    items: Array<{ key: string; label: string; status: 'done' | 'in_progress' | 'todo'; sub: string }>
    progress_pct: number
    done: number
    in_progress: number
    todo: number
  }
}

const { session } = useSession()

const isAdmin = computed(() => {
  const r = session.value?.role
  return r === 'admin' || r === 'platform-admin'
})
const isPlatformAdmin = computed(() => session.value?.role === 'platform-admin')

const route = useRoute()
const router = useRouter()
const regionId = String(route.params.id)

const activeTab = computed(() => String(route.query.tab ?? 'cost-centres'))
function setTab(key: string) {
  router.push({ query: { ...route.query, tab: key } })
}

/*
 * C1 — the placement filter lives in the URL, not in local state, so every
 * surface that wants to hand an admin a worklist can deep-link to it
 * (?tab=teammates&placement=unplaced) instead of re-implementing the filter.
 * The Unplaced row's count (C2) and the setup checklist (C6) are both just
 * links to this one view.
 *
 * An unrecognised value falls back to 'all' rather than 404ing the tab: a URL is
 * user-editable, and the honest response to "placement=banana" is the unfiltered
 * list, not a broken page.
 */
const placement = computed<PlacementFilter>(() =>
  isPlacementFilter(route.query.placement) ? route.query.placement : 'all',
)
function setPlacement(next: PlacementFilter) {
  // Selection is scoped to what is on screen; changing the filter changes that
  // set, so carrying a selection across it would act on rows nobody can see.
  selectedTeammateIds.value = []
  router.push({ query: { ...route.query, tab: 'teammates', placement: next } })
}
function openUnplacedWorklist() {
  setPlacement('unplaced')
}

// All five reads are lazy, client-only, null-default and never awaited — concurrent
// by construction: docs/design/admin-nav-responsiveness.md D1/D2.
const { data: region, error: regionError, refresh: refreshRegion } = useLazyFetch<RegionResp | null>(
  () => `/api/v1/admin/region/${regionId}`,
  { server: false, default: () => null, immediate: isAdmin.value },
)

// Contribute the region name as the trailing breadcrumb (Admin › Regions › X).
// Cleared automatically on navigation away by the admin layout.
const { setTail } = useAdminBreadcrumbTail()
watch(
  region,
  () => {
    const name = region.value?.region?.display_name
    setTail(name ? [{ label: name }] : [])
  },
  { immediate: true },
)

const { data: tree, error: treeError, refresh: refreshTree } = useLazyFetch<
  { nodes: OrgNode[]; default_unit_warn_threshold: number } | null
>(() => `/api/v1/admin/org-units?region=${regionId}`, {
  server: false,
  default: () => null,
  immediate: isAdmin.value,
})

/*
 * C5 — the standing rules that place people into THIS region's Business Units.
 *
 * Region-scoped on purpose: the same endpoint's unscoped mode lists org-wide
 * REGION rules, which are global config a region admin can neither edit nor
 * remove. Listing a row beside a Remove button that will 403 teaches an admin the
 * page is broken, so this list is exactly the rules they own.
 */
interface UnitRule {
  id: string
  attribute: string
  match_mode: string
  /** Normalised — what the matcher actually compares against. */
  match_value: string
  match_value_raw: string
  org_unit_id: string | null
  org_unit_display_name: string | null
  target_placeable: boolean | null
}
// The rules read keeps its `error`: collapsed into `[]` the whole Placement
// rules block disappears and reads as "this region has no standing rules" — the
// false empty D2 forbids (docs/design/admin-nav-responsiveness.md). The same `[]`
// silently disables PlacementRuleOffer's shadow check (`existingRuleFor` can only
// return null over an empty list), so the offer would promise an outcome a
// higher-precedence rule already overrides — it is withheld instead.
const { data: rulesData, error: rulesError, refresh: refreshRules } = useLazyFetch<{ rules: UnitRule[] } | null>(
  () => `/api/v1/admin/directory-region-rules?region=${regionId}`,
  { server: false, default: () => null, immediate: isAdmin.value },
)
const unitRules = computed(() => rulesData.value?.rules ?? [])

/*
 * The teammates worklist. `limit=200` is the endpoint's maximum and the bulk
 * action's cap — one page, one selectable set, one number. Re-fetched on the
 * placement filter (watch) so the deep link lands on the filtered table with no
 * further clicks.
 */
interface TeammateRow extends Record<string, unknown> {
  id: string
  email: string
  display_name: string | null
  org_unit_display_name: string
  source: string
  on_holding_node: boolean
  department: string | null
  company_name: string | null
  directory_captured_at: string | null
  spend_usd: string
}
interface TeammatesResp {
  teammates: TeammateRow[]
  total: number
  unfiltered_total: number
  spend_window: { start: string; end: string }
}
const { data: teammates, error: teammatesError, refresh: refreshTeammates } = useLazyFetch<TeammatesResp | null>(
  () => `/api/v1/admin/teammates?region=${regionId}&limit=200&placement=${placement.value}`,
  { server: false, default: () => null, immediate: isAdmin.value, watch: [placement] },
)

// Project-lifecycle region override (D9): grace/warn for this region, or the
// inherited platform default. Region admins (and org-wide) can set/clear it.
interface LifecycleResp {
  override: { grace_hours: number; warn_days: number } | null
  platform: { grace_hours: number; warn_days: number }
  effective: { grace_hours: number; warn_days: number }
}
// Its `error` is kept for the opposite reason to the pickers: the captions below
// fall back to LITERAL 2h/7d, so a failed read renders a fabricated platform
// default as fact and seeds nothing into the two inputs.
const { data: lifecycle, error: lifecycleError, refresh: refreshLifecycle } = useLazyFetch<LifecycleResp | null>(
  () => `/api/v1/admin/regions/${regionId}/project-lifecycle`,
  { server: false, default: () => null, immediate: isAdmin.value },
)
const lcGrace = ref<number | null>(null)
const lcWarn = ref<number | null>(null)
const lcSaving = ref(false)
watch(
  lifecycle,
  (v) => {
    if (v) {
      lcGrace.value = v.effective.grace_hours
      lcWarn.value = v.effective.warn_days
    }
  },
  { immediate: true },
)
async function saveLifecycleOverride() {
  if (lcGrace.value === null || lcWarn.value === null) return
  lcSaving.value = true
  try {
    await $fetch(`/api/v1/admin/regions/${regionId}/project-lifecycle`, {
      method: 'PUT',
      body: { grace_hours: lcGrace.value, warn_days: lcWarn.value },
    })
    flashToast('ok', 'Region lifecycle override saved.')
    await refreshLifecycle()
  } catch (err) {
    flashToast('err', apiErrorDetail(err, 'Save failed.'))
  } finally {
    lcSaving.value = false
  }
}
async function clearLifecycleOverride() {
  lcSaving.value = true
  try {
    await $fetch(`/api/v1/admin/regions/${regionId}/project-lifecycle`, { method: 'DELETE' })
    flashToast('ok', 'Reverted to platform default.')
    await refreshLifecycle()
  } catch (err) {
    flashToast('err', apiErrorDetail(err, 'Clear failed.'))
  } finally {
    lcSaving.value = false
  }
}

const nodes = computed<OrgNode[]>(() => tree.value?.nodes ?? [])

const tabs = computed<AdminTab[]>(() => [
  { key: 'cost-centres', label: BU_LABEL_PLURAL, count: nodes.value.length },
  // The tab count follows the FILTER (C1) — an admin working the unplaced
  // worklist needs the tab to agree with the table in front of them. The
  // unfiltered total stays visible on the filter control below it.
  { key: 'teammates', label: 'Teammates', count: teammates.value?.total ?? 0 },
  { key: 'checklist', label: 'Setup checklist' },
  { key: 'connectors', label: 'Connectors' },
])

const headline = computed(() => `${region.value?.region.display_name ?? '—'} region`)
const headsUpVisible = computed(() => region.value?.connector?.status === 'none')

// ── Toast (users.vue pattern) ─────────────────────────────────────────────
const toast = ref<{ kind: 'ok' | 'err'; message: string } | null>(null)
let toastTimer: ReturnType<typeof setTimeout> | null = null
function flashToast(kind: 'ok' | 'err', message: string) {
  toast.value = { kind, message }
  if (toastTimer) clearTimeout(toastTimer)
  toastTimer = setTimeout(() => { toast.value = null }, 3500)
}

// ── Business Unit dialog ────────────────────────────────────────────────────
const dialog = ref<{ mode: 'create' | 'edit'; node: OrgNode | null } | null>(null)
function openCreate() { dialog.value = { mode: 'create', node: null } }
function openEdit(node: OrgNode) { dialog.value = { mode: 'edit', node } }

// ── CC-owner assignment (J4, mig 0048) ────────────────────────────────────
const ownersFor = ref<OrgNode | null>(null)
function openOwners(node: OrgNode) { ownersFor.value = node }
function onOwnersChanged() {
  refreshTree()
  refreshRegion()
}
function onSaved() {
  const wasCreate = dialog.value?.mode === 'create'
  dialog.value = null
  flashToast('ok', wasCreate ? 'Business Unit created.' : 'Business Unit updated.')
  refreshTree()
  refreshRegion()
}

// ── Business Unit move (reparent) ───────────────────────────────────────────
const moveFor = ref<OrgNode | null>(null)
function openMove(node: OrgNode) { moveFor.value = node }
function onMoved() {
  moveFor.value = null
  flashToast('ok', 'Business Unit moved.')
  refreshTree()
  refreshRegion()
}

async function retire(node: OrgNode) {
  if (!confirm(`Retire Business Unit "${node.display_name}" (${node.code})? This cannot be undone.`)) return
  try {
    await $fetch(`/api/v1/admin/org-units/${node.id}`, { method: 'DELETE' })
    flashToast('ok', `Retired ${node.display_name}.`)
    await refreshTree()
    await refreshRegion()
  } catch (err) {
    flashToast(
      'err',
      apiErrorDetail(err, 'Retire failed — the Business Unit may have children, projects or teammates.'),
    )
    consola.warn('org-unit retire failed', err)
  }
}

// ── Region rename (platform-admin only) ───────────────────────────────────
const renaming = ref(false)
const renameValue = ref('')
const renameSaving = ref(false)
function openRename() {
  renameValue.value = region.value?.region.display_name ?? ''
  renaming.value = true
}
async function saveRename() {
  const name = renameValue.value.trim()
  if (!name) return
  renameSaving.value = true
  try {
    await $fetch(`/api/v1/admin/regions/${regionId}`, { method: 'PATCH', body: { display_name: name } })
    flashToast('ok', 'Region renamed.')
    renaming.value = false
    await refreshRegion()
  } catch (err) {
    flashToast('err', apiErrorDetail(err, 'Rename failed.'))
    consola.warn('region rename failed', err)
  } finally {
    renameSaving.value = false
  }
}

// ── Region leaders (region derivation, mig 0068) ──────────────────────────
// The manager-walk fallback target: unplaced users whose manager chain reaches
// a leader are homed in that leader's region.
const leadersOpen = ref(false)
function openLeaders() { leadersOpen.value = true }

/*
 * Checklist → action wiring. The Setup checklist used to be read-only; each
 * row now deep-links to the thing it's asking you to do — switch to the
 * relevant tab (and open the right dialog) or jump to the page that owns the
 * entity. Keyed off the server's checklist item `key`s
 * (see server/api/v1/admin/region/[regionId]/index.get.ts). Unknown keys get
 * no action (ChecklistRow falls back to its disabled placeholder), so the
 * checklist degrades gracefully if the server adds an item we don't map yet.
 */
const checklistActions: Record<string, { label: string; run: () => void }> = {
  'org-units': {
    label: 'Add Business Unit',
    run: () => { setTab('cost-centres'); openCreate() },
  },
  teammates: {
    label: 'Add teammates',
    run: () => { setTab('teammates') },
  },
  // C6 — the checklist row that owns the biggest attribution defect. Its action
  // IS C1's filtered view: one worklist, reached from wherever the admin noticed
  // the problem.
  'teammates-placed': {
    label: 'Place teammates',
    run: () => { openUnplacedWorklist() },
  },
  projects: {
    label: 'Manage projects',
    run: () => { navigateTo('/admin/projects') },
  },
  repos: {
    label: 'Manage projects',
    run: () => { navigateTo('/admin/projects') },
  },
  'admin-roles': {
    label: 'Manage roles',
    run: () => { navigateTo('/admin/users') },
  },
  'cou-owners': {
    label: 'Assign owners',
    run: () => { setTab('cost-centres') },
  },
  'project-pms': {
    label: 'Manage projects',
    run: () => { navigateTo('/admin/projects') },
  },
}
function runChecklistAction(key: string) {
  checklistActions[key]?.run()
}

/*
 * C3 — what the directory knows, and what it costs.
 *
 * Department + Company are the two attributes this estate populates and the two
 * an admin groups by to recognise a cluster ("40 people in Sales-Solution Sales
 * Management obviously belong in EMEA Solutions Core"). There is deliberately NO
 * cost-centre column: employeeOrgData.costCenter is empty across this estate, so
 * a column for it would be blank for everyone and imply the data exists.
 *
 * Both render '—' when we have no directory snapshot for that teammate yet
 * (the placement lanes capture it — see server/reconciliation/directory-
 * snapshot.ts), which is "not known" rather than "empty in the directory".
 *
 * "DIRECTORY AS OF" IS PART OF THAT PAIR, not an extra. They are a SNAPSHOT, and
 * a snapshot with no date on screen reads as live truth: the admin about to move
 * forty people because they share a department has no way to see the department
 * was captured six months ago. The capture date is what makes the two columns
 * beside it honest.
 *
 * THE SPEND COLUMN NAMES ITS PROVIDER. It sums v_finance_bill_chargeback, which
 * excludes every Copilot lane by construction (§B Copilot money is pooled per
 * Business Unit and has no per-user figure — provider-billing-attribution-model.md
 * §B). A Copilot-only teammate reads $0.00 and always will, so a generic "Spend"
 * header over this number tells an admin that person costs nothing. It says
 * Claude.
 *
 * Spend sorts on the NUMBER, not the rendered text: '$9.00' sorts above '$10.00'
 * as a string, which is exactly backwards for "deal with the largest first".
 */
const money = new Intl.NumberFormat('en-US', { style: 'currency', currency: 'USD' })
const spendWindowLabel = computed(() => {
  const start = teammates.value?.spend_window?.start
  if (!start) return 'Claude spend'
  return `Claude spend · ${new Date(start).toLocaleDateString(undefined, { month: 'short', year: 'numeric', timeZone: 'UTC' })}`
})
const shortDate = new Intl.DateTimeFormat(undefined, { day: 'numeric', month: 'short', year: 'numeric', timeZone: 'UTC' })
const teammateColumns = computed(() => [
  { key: 'display_name', label: 'Name', sortable: true },
  { key: 'email', label: 'Email', sortable: true },
  { key: 'org_unit_display_name', label: 'Org unit', sortable: true },
  { key: 'department', label: 'Department', sortable: true },
  { key: 'company_name', label: 'Company', sortable: true },
  {
    key: 'directory_captured_at',
    label: 'Directory as of',
    sortable: true,
    // Sort on the raw timestamp, never the rendered '3 Jul 2026' — that string
    // orders alphabetically, which is not chronological.
    sortValue: (row: Record<string, unknown>) => String(row.directory_captured_at ?? ''),
    render: (row: Record<string, unknown>) => {
      const at = row.directory_captured_at
      if (!at) return 'never'
      const d = new Date(String(at))
      return Number.isNaN(d.getTime()) ? 'never' : shortDate.format(d)
    },
  },
  {
    key: 'spend_usd',
    label: spendWindowLabel.value,
    sortable: true,
    align: 'right' as const,
    sortValue: (row: Record<string, unknown>) => Number(row.spend_usd ?? 0),
    render: (row: Record<string, unknown>) => money.format(Number(row.spend_usd ?? 0)),
  },
  { key: 'source', label: 'Source' },
])

// ── C4: bulk place ────────────────────────────────────────────────────────
const selectedTeammateIds = ref<string[]>([])
const bulkPlaceOpen = ref(false)
const teammateRowKey = (row: Record<string, unknown>) => String(row.id)

/*
 * Only cost-owning units are offered as targets: the bulk action's purpose is to
 * make spend reach a Business Unit, and the server refuses anything else (422). A
 * picker that offers a destination the write will reject is a picker that teaches
 * the admin the feature is broken.
 */
const placementTargets = computed(() =>
  nodes.value.filter((n) => n.is_cost_owning_unit && n.unit_type !== HOLDING_UNIT_TYPE),
)

/** Name a teammate in a per-id refusal — a uuid tells the admin nothing. */
function teammateLabelFor(teammateId: string): string {
  const row = teammates.value?.teammates.find((t) => t.id === teammateId)
  return row?.display_name ?? row?.email ?? teammateId
}

/*
 * C5 — the rule offer, which exists only after a batch actually committed.
 *
 * The ROWS are snapshotted here rather than read live from `teammates`, because
 * the refresh below re-fetches the worklist and the placed people drop straight
 * out of the (unplaced) filter — the offer would then be computed from an empty
 * intersection and never appear. It is the batch that was placed, not whatever
 * the table shows a moment later.
 */
const ruleOffer = ref<{
  teammateIds: string[]
  rows: Array<{ id: string; department: string | null; company_name: string | null }>
  orgUnitId: string
  orgUnitName: string
} | null>(null)

/** Every id succeeded (or was already there): close, say so, resync. */
async function onBulkPlaced(summary: {
  placed: number
  noop: number
  historyRepaired: number
  unitName: string
  unitId: string
  placedIds: string[]
}) {
  bulkPlaceOpen.value = false
  selectedTeammateIds.value = []
  /*
   * THREE OUTCOMES, NAMED SEPARATELY. A repair is not a placement: those people
   * did not move, their stranded history did. On the estate this exists to fix
   * most of a batch can be repairs, and folding them into "Placed N" would
   * report placements that never happened.
   */
  const already = summary.noop ? ` ${summary.noop} were already there.` : ''
  const repaired = summary.historyRepaired
    ? ` ${summary.historyRepaired} were already there and had their recorded usage brought across.`
    : ''
  flashToast(
    'ok',
    `Placed ${summary.placed} ${summary.placed === 1 ? 'teammate' : 'teammates'} into ${summary.unitName}.${already}${repaired}`,
  )
  ruleOffer.value = summary.placedIds.length
    ? {
        teammateIds: summary.placedIds,
        rows: (teammates.value?.teammates ?? []).map((t) => ({
          id: t.id,
          department: t.department,
          company_name: t.company_name,
        })),
        orgUnitId: summary.unitId,
        orgUnitName: summary.unitName,
      }
    : null
  await refreshAfterPlacement()
}

async function onRuleCreated(summary: { attribute: string; value: string }) {
  ruleOffer.value = null
  flashToast('ok', `Rule saved — ${regionAttributeLabel(summary.attribute)} “${summary.value}” now places automatically.`)
  await refreshRules()
}

async function removeUnitRule(rule: UnitRule) {
  // NOT "they stay where they are". A rule placement is a DERIVED placement:
  // rows carry placedVia='attribute-rule' and are re-derived by re-resolve and by
  // region-reenrichment, so removing the rule does eventually move them — to
  // whatever the chain resolves next, or to the holding node if nothing does.
  // Promising immutability here would be the pleasant version of the truth, and
  // the admin would discover the real one after the next pass.
  if (!confirm(`Remove the rule ${regionAttributeLabel(rule.attribute)} “${rule.match_value_raw}” → ${rule.org_unit_display_name}? People it placed keep their unit until the next re-resolve, which will re-derive them without it.`)) return
  try {
    await $fetch(`/api/v1/admin/directory-region-rules/${rule.id}`, { method: 'DELETE' })
    flashToast('ok', 'Rule removed.')
    await refreshRules()
  } catch (err) {
    flashToast('err', apiErrorDetail(err, 'Remove failed.'))
    consola.warn('unit rule remove failed', err)
  }
}

// ── C7: re-resolve placement, on the page where the config was changed ────
const reResolveOpen = ref(false)
async function onReResolveApplied(summary: { moved: number; more: boolean }) {
  if (summary.moved === 0) return
  flashToast(
    'ok',
    `Re-resolved ${summary.moved} ${summary.moved === 1 ? 'teammate' : 'teammates'}.${summary.more ? ' More remain — run it again.' : ''}`,
  )
  await refreshAfterPlacement()
}

// ── C9: the catch-all's manager clusters ──────────────────────────────────
const clustersFor = ref<OrgNode | null>(null)
function openClusters(node: OrgNode) { clustersFor.value = node }

/*
 * Some committed, some were refused. The dialog STAYS open listing the refusals,
 * so this handler's whole job is the part the dialog cannot do: make the page
 * behind it agree with what actually committed, and narrow the selection to the
 * ids still to place. Without the refresh the successful rows sit there as
 * unplaced; without the reselect, retrying resubmits people who are already
 * placed.
 */
async function onBulkPartial(summary: {
  placed: number
  noop: number
  failed: number
  unitName: string
  failedIds: string[]
}) {
  selectedTeammateIds.value = summary.failedIds
  await refreshAfterPlacement()
}

// The tree's per-node counts (including C9's catch-all occupancy), the region's
// unplaced count and the worklist all moved — refresh all three rather than the
// one the eye is on.
async function refreshAfterPlacement() {
  await Promise.all([refreshTeammates(), refreshTree(), refreshRegion()])
}
</script>

<template>
  <div v-if="!isAdmin" class="max-w-[1600px] mx-auto px-10 py-16 text-center" data-testid="admin-access-required" data-admin-page="/admin/regions/[id]">
    <div class="text-lg font-bold text-carbon">Admin access required.</div>
  </div>

  <div v-else-if="!regionError && region" class="max-w-[1600px] mx-auto px-10 py-8 pb-20" data-testid="region-detail" data-admin-page="/admin/regions/[id]">
    <UiPageHead
      eyebrow="Region"
      :title="headline"
    >
      <template #actions>
        <span class="inline-flex items-center gap-1">
          <UiButton
            kind="ghost"
            size="sm"
            data-testid="region-leaders-open"
            title="Placement anchors (SVP / shared function) that decide which Business Unit a teammate rolls up to. Not a role, not an owner."
            @click="openLeaders"
          >
            Region leaders
          </UiButton>
          <AdminHelpLink anchor="region-leader" label="a Region leader" />
        </span>
        <!-- C7: apply the configuration to the people who already exist, from
             the page where the configuration was changed. Preview first. -->
        <UiButton
          kind="ghost"
          size="sm"
          data-testid="re-resolve-open"
          title="Re-run placement for people in this region who have never signed in — against the configuration as it stands now. Shows what would move before anything is written."
          @click="reResolveOpen = true"
        >
          Re-resolve placement
        </UiButton>
        <UiButton
          v-if="isPlatformAdmin"
          kind="ghost"
          size="sm"
          data-testid="region-rename-open"
          title="Rename this region"
          @click="openRename"
        >
          ✎ Rename
        </UiButton>
        <UiBadge :kind="region.connector.status === 'planned' ? 'harmony' : 'neutral'">
          {{ region.connector.status === 'planned' ? region.connector.label : 'No connector' }}
        </UiBadge>
      </template>
    </UiPageHead>

    <!-- Toast -->
    <div
      v-if="toast"
      :data-testid="`region-detail-toast-${toast.kind}`"
      class="mb-4 p-3 rounded-md text-sm font-medium"
      :class="toast.kind === 'ok'
        ? 'bg-brand-harmony-sheer text-brand-harmony border border-brand-harmony/30'
        : 'bg-brand-hunger/10 text-brand-hunger border border-brand-hunger/30'"
    >
      {{ toast.message }}
    </div>

    <!-- KPI row -->
    <div class="grid grid-cols-1 md:grid-cols-4 gap-5 mb-8" data-testid="admin-kpi-row">
      <UiKpi accent="harmony" label="Org units" :value="String(region.counts.org_units ?? 0)" :sub="`across ${region.counts.bus ?? 0} business ${region.counts.bus === 1 ? 'unit' : 'units'}`" />
      <UiKpi accent="vision" label="Teammates" :value="String(region.counts.teammates ?? 0)" sub="in this region" />
      <UiKpi accent="hunger" label="Projects" :value="String(region.counts.projects ?? 0)" :sub="`${region.counts.projects_onboarded ?? 0} onboarded · ${Math.max(0, (region.counts.projects ?? 0) - (region.counts.projects_onboarded ?? 0))} catalogue`" />
      <UiKpi accent="zeal" label="Connector status" :value="region.connector.status === 'planned' ? 'PSR' : 'None'" :sub="region.connector.status === 'planned' ? 'planned for pilot' : 'manual setup mode'" />
    </div>

    <AdminTabs :tabs="tabs" :model-value="activeTab" @update:model-value="setTab" />

    <!-- Business Units -->
    <UiCard v-if="activeTab === 'cost-centres'" data-testid="panel-cost-centres">
      <div class="flex items-start justify-between mb-4 gap-3 flex-wrap">
        <p class="text-[11px] text-carbon-3 max-w-xl leading-relaxed m-0">
          Nested by depth. Projects bill to the nearest <strong>Business Unit
          that owns cost</strong> — a unit can group others without carrying
          spend of its own. Each one can have
          <strong>owners</strong><AdminHelpLink anchor="cost-centre-owner" label="a Business Unit owner" />
          — the people who can see its spend &amp; budget, and who are members of
          it. <em>(Different from Region leaders, above.)</em>
        </p>
        <UiButton kind="primary" size="sm" data-testid="cost-centre-create-open" @click="openCreate">
          + New Business Unit
        </UiButton>
      </div>

      <UiFetchErrorBanner v-if="treeError" :error="treeError" label="the Business Unit tree" @retry="refreshTree" />
      <AdminPageSkeleton v-else-if="tree == null" :rows="6" :toolbar="false" />

      <!-- Get-started CTA: shown when the Business Unit tree is empty so a new
           region admin sees the very first action front-and-centre. -->
      <div
        v-if="tree && !nodes.length"
        class="mb-5 p-5 rounded-lg bg-brand-harmony-sheer border border-brand-harmony/25"
        data-testid="cost-centre-getstarted"
      >
        <div class="text-sm font-bold text-carbon">Set up your region's structure</div>
        <p class="text-sm text-carbon-2 mt-1 leading-relaxed">
          Create your first business unit, then add practices under it. Projects
          bill to the nearest cost-owning unit, so this tree is the backbone of
          attribution.
        </p>
        <div class="mt-4">
          <UiButton kind="primary" size="sm" data-testid="cost-centre-getstarted-create" @click="openCreate">
            + Create your first business unit
          </UiButton>
        </div>
      </div>

      <div v-if="nodes.length" data-testid="cost-centre-list">
        <div
          v-for="node in nodes"
          :key="node.id"
          class="grid grid-cols-[1fr_auto] items-center gap-3 py-2 border-b border-calm-2 last:border-b-0 hover:bg-brand-harmony-sheer/40 rounded-md"
          :style="{ paddingLeft: `${node.depth * 20}px` }"
          :data-depth="node.depth"
          :data-testid="`cc-row-${node.code}`"
          :data-path="node.path"
        >
          <div class="flex items-center gap-2 min-w-0 flex-wrap">
            <span class="text-sm font-bold text-carbon truncate">{{ node.display_name }}</span>
            <span class="text-[10px] text-carbon-3 font-mono">{{ node.code }}</span>
            <UiBadge v-if="node.is_cost_owning_unit" kind="zeal" :data-testid="`cc-cou-${node.code}`" title="Cost-owning unit (CoU) — a P&L node that projects bill to.">Cost-owning</UiBadge>
            <!-- C2: on the holding node the teammate count is the ENTRY POINT to
                 the placement worklist, not a label. Everywhere else it stays a
                 plain count — placement is a teammate action, not a node one. -->
            <span class="text-[11px] text-carbon-3">
              <button
                v-if="node.unit_type === HOLDING_UNIT_TYPE && node.teammate_count > 0"
                type="button"
                class="font-bold text-brand-harmony underline underline-offset-2 hover:text-brand-heart"
                :data-testid="`cc-unplaced-link-${node.code}`"
                title="Open the placement worklist filtered to these teammates"
                @click="openUnplacedWorklist"
              >
                {{ node.teammate_count }} {{ node.teammate_count === 1 ? 'teammate' : 'teammates' }}
              </button>
              <template v-else>
                {{ node.teammate_count }} {{ node.teammate_count === 1 ? 'teammate' : 'teammates' }}
              </template>
              · {{ node.project_count }} {{ node.project_count === 1 ? 'project' : 'projects' }}
            </span>
            <span
              v-if="node.is_cost_owning_unit"
              class="text-[11px]"
              :class="node.owners.length ? 'text-carbon-2' : 'text-rag-amber'"
              :data-testid="`cc-owners-${node.code}`"
            >
              {{ node.owners.length
                ? `Owner: ${node.owners.map((o) => o.display_name ?? o.email).join(', ')}`
                : 'No owner' }}
            </span>
            <!-- C8b: an owner the manager-chain walk cannot use places NOBODY,
                 on either of their units, and until now looked identical on this
                 row to one that works. -->
            <span
              v-for="o in node.owners.filter((x) => x.placement_status === 'ambiguous')"
              :key="`amb-${o.teammate_id}`"
              class="text-[11px] font-bold text-rag-amber"
              :data-testid="`cc-owner-ambiguous-${node.code}`"
              :title="`${o.display_name ?? o.email} owns ${o.owns_unit_count} active Business Units, so the manager-chain walk cannot tell which one a report belongs to. It skips them, and they place nobody — on this unit or the other.`"
            >
              ⚠ Ambiguous owner
            </span>
            <!-- C9: the catch-all is only honest while it nags. A default unit
                 holding people who do not report to its owner is the org tree
                 saying which units have no owner — and every report downstream
                 reads them as placed. -->
            <button
              v-if="node.default_occupancy?.warn"
              type="button"
              class="text-[11px] font-bold text-rag-amber underline underline-offset-2 hover:text-brand-heart"
              :data-testid="`cc-default-warning-${node.code}`"
              :title="`${node.default_occupancy.not_direct_reports} of ${node.default_occupancy.occupants} people here do not report to this unit's owner. They landed here because no nearer owner exists on their manager chain.`"
              @click="openClusters(node)"
            >
              ⚠ {{ node.default_occupancy.not_direct_reports }} of
              {{ node.default_occupancy.occupants }} do not belong here
            </button>
          </div>
          <div class="flex items-center gap-1 whitespace-nowrap">
            <UiButton
              v-if="node.is_default"
              kind="ghost"
              size="sm"
              :data-testid="`cc-default-clusters-${node.code}`"
              title="Who is in this fallback unit that should not be, grouped by their own manager."
              @click="openClusters(node)"
            >
              Occupancy
            </UiButton>
            <UiButton
              v-if="node.is_cost_owning_unit"
              kind="ghost"
              size="sm"
              :data-testid="`cc-owners-open-${node.code}`"
              @click="openOwners(node)"
            >
              Owners
            </UiButton>
            <UiButton kind="ghost" size="sm" :data-testid="`cc-edit-${node.code}`" @click="openEdit(node)">Edit</UiButton>
            <UiButton
              kind="ghost"
              size="sm"
              :data-testid="`move-btn-${node.id}`"
              title="Move this Business Unit (and its subtree) under a different parent in this region."
              @click="openMove(node)"
            >
              Move
            </UiButton>
            <UiButton kind="ghost" size="sm" :data-testid="`cc-retire-${node.code}`" @click="retire(node)">Retire</UiButton>
          </div>
        </div>
      </div>

      <!-- C5: the standing rules that place people into this region's cost
           centres. Created from the offer after a bulk place, and removable
           here — an offer whose result an admin cannot see or undo is a trap. -->
      <div v-if="rulesError" class="mt-6 pt-5 border-t border-calm-2" data-testid="unit-rules-unavailable">
        <div class="text-[12px] font-semibold text-carbon uppercase tracking-wide">Placement rules</div>
        <UiAuxFetchError
          :error="rulesError"
          label="the placement rules"
          testid="unit-rules-error"
          @retry="refreshRules"
        />
      </div>
      <div v-else-if="rulesData == null" class="mt-6 pt-5 border-t border-calm-2" data-testid="unit-rules-loading">
        <div class="text-[12px] font-semibold text-carbon uppercase tracking-wide">Placement rules</div>
        <p class="text-xs text-carbon-3 mt-1" role="status" aria-busy="true">Loading placement rules…</p>
      </div>
      <div v-else-if="unitRules.length" class="mt-6 pt-5 border-t border-calm-2" data-testid="unit-rules">
        <div class="text-[12px] font-semibold text-carbon uppercase tracking-wide">Placement rules</div>
        <p class="text-xs text-carbon-3 mt-1 mb-3 leading-relaxed">
          A new joiner whose directory profile matches one of these lands in that Business Unit
          without anyone having to spot them on the unplaced worklist. They outrank the manager
          chain — an admin writing a rule is stating something the chain can only infer.
        </p>
        <div class="rounded-lg border border-calm-2 divide-y divide-calm-2">
          <div
            v-for="r in unitRules"
            :key="r.id"
            class="flex items-center justify-between gap-3 px-4 py-2.5"
            :data-testid="`unit-rule-row-${r.id}`"
          >
            <div class="flex items-center gap-2 min-w-0 flex-wrap">
              <span class="text-[11px] text-carbon-3">{{ regionAttributeLabel(r.attribute) }}</span>
              <span class="text-sm font-semibold text-carbon truncate">{{ r.match_value_raw }}</span>
              <UiBadge v-if="r.match_mode === 'prefix'" kind="neutral">prefix</UiBadge>
              <span class="text-carbon-3 text-sm">→</span>
              <UiBadge kind="harmony">{{ r.org_unit_display_name }}</UiBadge>
              <!-- A rule whose target has been retired or un-flagged places
                   NOBODY: the loader drops the unit and the rule degrades to its
                   region. Say so rather than let it look like it works. -->
              <span
                v-if="r.target_placeable === false"
                class="text-[11px] font-bold text-rag-amber"
                :data-testid="`unit-rule-inert-${r.id}`"
                title="This rule's Business Unit is retired or is no longer cost-owning, so the rule places nobody. Point it at an active cost-owning unit, or remove it."
              >
                ⚠ Places nobody
              </span>
            </div>
            <button
              type="button"
              class="text-xs font-semibold text-brand-hunger hover:underline shrink-0"
              :data-testid="`unit-rule-remove-${r.id}`"
              @click="removeUnitRule(r)"
            >
              Remove
            </button>
          </div>
        </div>
      </div>
      <!-- Empty state is handled by the get-started CTA above (shown when
           `!nodes.length`) — a single, action-first treatment. -->
    </UiCard>

    <!-- Teammates: also the placement worklist (C1/C3/C4). -->
    <UiFetchErrorBanner
      v-else-if="activeTab === 'teammates' && teammatesError"
      :error="teammatesError"
      label="the teammates list"
      @retry="refreshTeammates"
    />
    <AdminPageSkeleton v-else-if="activeTab === 'teammates' && teammates == null" :rows="8" />
    <EntityTable
      v-else-if="activeTab === 'teammates'"
      v-model:selected="selectedTeammateIds"
      entity-label="Teammates"
      :rows="teammates?.teammates ?? []"
      :columns="teammateColumns"
      :total="teammates?.total"
      :row-key="teammateRowKey"
      :empty-headline="placement === 'unplaced' ? 'Every teammate is in a Business Unit' : undefined"
      :empty-sub="placement === 'unplaced'
        ? `All ${teammates?.unfiltered_total ?? 0} teammates in this region are placed — none are sitting on the holding node.`
        : undefined"
    >
      <template #toolbar>
        <!-- C5: offered ONLY after a batch actually committed, and never acted
             on without a click. This is what turns a one-off clean-up into
             something that stops the cluster coming back next month. -->
        <PlacementRuleOffer
          v-if="isPlatformAdmin && ruleOffer && !rulesError"
          class="w-full"
          :teammate-ids="ruleOffer.teammateIds"
          :rows="ruleOffer.rows"
          :org-unit-id="ruleOffer.orgUnitId"
          :org-unit-name="ruleOffer.orgUnitName"
          :existing-rules="unitRules"
          @created="onRuleCreated"
          @dismiss="ruleOffer = null"
        />
        <UiAuxFetchError
          v-else-if="isPlatformAdmin && ruleOffer"
          :error="rulesError"
          label="the placement rules"
          testid="rule-offer-rules-error"
          class="w-full"
          @retry="refreshRules"
        />
        <div class="flex items-center gap-2" data-testid="teammates-placement-filter">
          <span class="text-[11px] font-bold uppercase tracking-[1.2px] text-carbon-3">Placement</span>
          <div class="inline-flex rounded-md border border-calm-2 overflow-hidden">
            <button
              v-for="opt in [
                { key: 'all', label: 'All' },
                { key: 'unplaced', label: 'Unplaced' },
                { key: 'placed', label: 'Placed' },
              ]"
              :key="opt.key"
              type="button"
              class="px-3 py-1.5 text-xs font-bold transition-colors"
              :class="placement === opt.key
                ? 'bg-brand-harmony text-white'
                : 'bg-white text-carbon-2 hover:text-brand-harmony'"
              :data-testid="`placement-filter-${opt.key}`"
              @click="setPlacement(opt.key as PlacementFilter)"
            >
              {{ opt.label }}
            </button>
          </div>
          <!-- The unfiltered total stays visible so the admin reads "290 of 513",
               not an unqualified 290. -->
          <span class="text-[11px] text-carbon-3" data-testid="teammates-filter-count">
            {{ teammates?.total ?? 0 }} of {{ teammates?.unfiltered_total ?? 0 }}
          </span>
        </div>
        <!-- What the two data columns are and are not. Both would otherwise be
             read as live, complete truth: the directory pair is a snapshot, and
             the money is Claude's only. -->
        <p class="w-full text-[11px] text-carbon-3 m-0 leading-relaxed" data-testid="teammates-column-caveats">
          Department and Company are a <strong>snapshot</strong> taken the last time a
          placement run looked this person up — the “Directory as of” column dates it.
          Spend is <strong>Claude only</strong>: Copilot is billed pooled per Business Unit,
          so it has no per-teammate figure and a Copilot-only teammate reads $0.00.
        </p>
      </template>

      <template #selectionActions>
        <UiButton
          kind="primary"
          size="sm"
          data-testid="teammates-bulk-place-open"
          @click="bulkPlaceOpen = true"
        >
          Place in Business Unit
        </UiButton>
      </template>

      <template #addHint>Teammates self-onboard on first sign-in — set role + region from Admin → Users.</template>
    </EntityTable>

    <!-- Setup checklist -->
    <UiCard v-else-if="activeTab === 'checklist'" data-testid="panel-checklist">
      <SetupProgressBar
        :done="region.checklist.done"
        :in-progress="region.checklist.in_progress"
        :todo="region.checklist.todo"
      />
      <div class="mt-5">
        <ChecklistRow
          v-for="(item, idx) in region.checklist.items"
          :key="item.key"
          :index="idx + 1"
          :label="item.label"
          :sub="item.sub"
          :status="item.status"
          :action-label="checklistActions[item.key]?.label"
          @action="runChecklistAction(item.key)"
        />
      </div>
      <div
        v-if="headsUpVisible"
        class="mt-5 p-3 rounded-md bg-brand-vision-lite/60 border border-brand-vision/30 text-xs text-[#1f4ea3] leading-relaxed"
        data-testid="checklist-headsup"
      >
        <span class="font-bold">Heads up.</span>
        {{ region.region.display_name }} has no FIN connector configured yet.
        Teammates, projects and repos are added manually — TokenScope tolerates
        this. You can still attribute every session.
      </div>

      <!-- Project-lifecycle override (D9) -->
      <div class="mt-6 pt-5 border-t border-calm-2" data-testid="region-lifecycle">
        <div class="text-[12px] font-semibold text-carbon uppercase tracking-wide">Project lifecycle</div>
        <!-- The platform figures render only once the read has landed. The old
             `?? 2` / `?? 7` fallbacks stated a default nobody had fetched, which
             on a failed or in-flight read is a fabricated fact, not a default. -->
        <UiAuxFetchError
          v-if="lifecycleError"
          :error="lifecycleError"
          label="the project-lifecycle policy"
          testid="region-lifecycle-error"
          class="mt-1 mb-3"
          @retry="refreshLifecycle"
        />
        <p v-else class="text-xs text-carbon-3 mt-1 mb-3 leading-relaxed">
          End-date cadence for this region. Leave at the platform default<span
            v-if="lifecycle"> ({{ lifecycle.platform.grace_hours }}h grace /
            {{ lifecycle.platform.warn_days }}d warning)</span>,
          or override it for {{ region.region.display_name }}.
          <span v-if="lifecycle?.override" class="text-brand-zeal font-semibold" data-testid="region-lifecycle-overridden">
            Currently overridden.
          </span>
        </p>
        <div v-if="!lifecycleError" class="flex flex-wrap items-end gap-3">
          <label class="text-xs text-carbon-2">
            Grace (hours)
            <input
              v-model.number="lcGrace"
              type="number"
              min="0"
              max="168"
              data-testid="region-lifecycle-grace"
              class="mt-1 block w-28 px-3 py-2 text-sm border border-calm-2 rounded-md focus:border-brand-harmony focus:outline-none"
            >
          </label>
          <label class="text-xs text-carbon-2">
            Warning (days)
            <input
              v-model.number="lcWarn"
              type="number"
              min="1"
              max="90"
              data-testid="region-lifecycle-warn"
              class="mt-1 block w-28 px-3 py-2 text-sm border border-calm-2 rounded-md focus:border-brand-harmony focus:outline-none"
            >
          </label>
          <UiButton
            kind="primary"
            size="sm"
            :disabled="lcSaving || lcGrace === null || lcWarn === null"
            data-testid="region-lifecycle-save"
            @click="saveLifecycleOverride"
          >
            {{ lcSaving ? 'Saving…' : 'Save override' }}
          </UiButton>
          <UiButton
            v-if="lifecycle?.override"
            kind="ghost"
            size="sm"
            :disabled="lcSaving"
            data-testid="region-lifecycle-clear"
            @click="clearLifecycleOverride"
          >
            Revert to default
          </UiButton>
        </div>
      </div>
    </UiCard>

    <!-- Connectors -->
    <div v-else-if="activeTab === 'connectors'" data-testid="panel-connectors">
      <div
        v-if="headsUpVisible"
        class="mb-5 p-3 rounded-md bg-brand-vision-lite/60 border border-brand-vision/30 text-xs text-[#1f4ea3] leading-relaxed"
      >
        <span class="font-bold">{{ region.region.display_name }} has no FIN-system connector yet.</span>
        APAC will get a PSR-based connector during the pilot. US will stay manual through pilot.
      </div>
      <div class="grid grid-cols-1 md:grid-cols-3 gap-4">
        <ConnectorCard
          name="PSR (APAC)"
          scope="Inbound APAC"
          description="Project + teammate sync from PSR. Coming during pilot."
          :status="region.region.code === 'apac' ? 'planned' : 'unconfigured'"
          cta="configure"
        />
        <ConnectorCard
          name="Workday (EMEA)"
          scope="Inbound EMEA"
          description="Inbound org / teammate connector — not configured."
          status="unconfigured"
          cta="configure"
        />
        <ConnectorCard
          name="NetSuite (US)"
          scope="Inbound US"
          description="Inbound project / CoU connector — not configured."
          status="unconfigured"
          cta="configure"
        />
      </div>
      <div class="mt-4">
        <ConnectorCard
          name="CSV upload"
          scope="Manual · any region"
          description="Bulk upload of teammates / projects / repos. Use anytime."
          status="available"
          cta="upload-csv"
        />
      </div>
    </div>

    <!-- Business Unit create/edit dialog -->
    <OrgUnitDialog
      v-if="dialog"
      :mode="dialog.mode"
      :region-id="regionId"
      :node="dialog.node"
      :parents="nodes"
      @close="dialog = null"
      @saved="onSaved"
    />

    <!-- Business Unit move (reparent) dialog -->
    <MoveOrgUnitDialog
      v-if="moveFor"
      :node="moveFor"
      :units="nodes"
      @close="moveFor = null"
      @moved="onMoved"
    />

    <!-- Bulk placement (C4) -->
    <BulkPlaceDialog
      :open="bulkPlaceOpen"
      :teammate-ids="selectedTeammateIds"
      :targets="placementTargets"
      :label-for="teammateLabelFor"
      @close="bulkPlaceOpen = false"
      @placed="onBulkPlaced"
      @partial="onBulkPartial"
    />

    <!-- Re-resolve placement (C7) — preview, then apply, batched -->
    <ReResolvePlacementDialog
      :open="reResolveOpen"
      :region-id="regionId"
      :region-name="region.region.display_name"
      @close="reResolveOpen = false"
      @applied="onReResolveApplied"
    />

    <!-- The catch-all's manager clusters (C9) -->
    <DefaultUnitClustersDialog
      :org-unit-id="clustersFor?.id ?? null"
      :unit-name="clustersFor?.display_name ?? ''"
      @close="clustersFor = null"
      @open-worklist="clustersFor = null; openUnplacedWorklist()"
    />

    <!-- CC-owner assignment (J4) -->
    <AdminCouOwnersModal
      :cou="ownersFor"
      :region-id="regionId"
      @close="ownersFor = null"
      @changed="onOwnersChanged"
    />

    <!-- Region leaders — manager-walk fallback target (mig 0068) -->
    <AdminRegionLeadersModal
      :region-id="leadersOpen ? regionId : null"
      :region-name="region.region.display_name"
      :region-code="region.region.code"
      @close="leadersOpen = false"
      @changed="refreshRegion"
    />

    <!-- Rename region (platform-admin) -->
    <div
      v-if="renaming"
      class="fixed inset-0 z-50 flex items-center justify-center bg-carbon/40 p-4"
      data-testid="region-rename-overlay"
      @click.self="renaming = false"
    >
      <div
        class="w-full max-w-sm bg-white rounded-xl shadow-xl"
        role="dialog"
        aria-modal="true"
        aria-labelledby="region-rename-title"
        data-testid="region-rename-dialog"
      >
        <div class="px-6 py-4 border-b border-calm-2">
          <p class="text-xs font-bold uppercase tracking-[1.4px] text-brand-harmony">Region</p>
          <h2 id="region-rename-title" class="text-lg font-bold text-carbon mt-0.5">Rename region</h2>
        </div>
        <div class="px-6 py-4">
          <label for="region-rename-input" class="text-[12px] font-semibold text-carbon">Display name</label>
          <input
            id="region-rename-input"
            v-model="renameValue"
            class="mt-1 w-full px-3 py-2 text-sm border border-calm-2 rounded-md bg-white focus:border-brand-harmony focus:outline-none"
            data-testid="region-rename-input"
            @keyup.enter="saveRename"
            @keyup.escape="renaming = false"
          >
          <div class="flex justify-end gap-2 mt-5">
            <UiButton kind="ghost" data-testid="region-rename-cancel" @click="renaming = false">Cancel</UiButton>
            <UiButton kind="primary" :disabled="renameSaving" data-testid="region-rename-submit" @click="saveRename">
              {{ renameSaving ? 'Saving…' : 'Save' }}
            </UiButton>
          </div>
        </div>
      </div>
    </div>
  </div>

  <div v-else-if="regionError" class="max-w-[1600px] mx-auto px-10 py-16 text-center" data-testid="admin-error" data-admin-page="/admin/regions/[id]">
    <div class="text-lg font-bold text-carbon">Region not available.</div>
    <p class="text-sm text-carbon-2 mt-2">
      You don't have permission to view this region, or the region was removed.
    </p>
    <NuxtLink to="/admin/regions" class="inline-block mt-4 text-sm font-semibold text-brand-harmony no-underline" data-testid="admin-no-region">
      ← Back to all regions
    </NuxtLink>
  </div>

  <div v-else class="max-w-[1600px] mx-auto px-10 py-8 pb-20" data-admin-page="/admin/regions/[id]">
    <AdminPageSkeleton :tiles="4" :rows="8" />
  </div>
</template>
