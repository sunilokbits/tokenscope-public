/*
 * reporting/finance — the query layer behind the FINANCE (end-of-month) reporting
 * scope (docs/design/reporting-consolidation/00-build-design.md §2/§3/§4/§5,
 * Wave 5; owner-decisions 02-owner-decisions.md D-Q5/D-Q6/D-Homing/D-Q8).
 *
 * This is the most correctness-sensitive scope: the chargeback pack global finance
 * validates the bill against and x-charges from. It reads the §B bill lanes ONLY —
 *   - per-CoU chargeback  → `v_finance_chargeback_month` (Anthropic month-rolled ∪
 *     Copilot per-org pooled net, org→CoU-map-homed) — grain (cou, tool, month).
 *   - the VISIBLE Σ=bill check → Σ chargeback vs `v_finance_bill_totals_month`
 *     (each provider from EXACTLY one authoritative surface). A mismatch OR an
 *     UNSETTLED month (a Copilot month with usage but no read license SKU) shows
 *     RED "unsettled" — never a silent pass (build-design §7(1), risk 7).
 *   - Anthropic per-teammate charges → `v_finance_bill_chargeback` (teammate-homed).
 *   - Copilot per-org pooled lines  → `copilot_pool_bill` (org→CoU map, mig 0080).
 *   - project overlay               → `v_finance_project_overlay` (chargeable split).
 * The one §A read is the exempt-gap card's INDICATIVE usage total (`v_complete_usage`)
 * and the Overage-Drivers per-teammate usage weight (`v_teammate_usage_daily` copilot
 * branch) — a §A DISPLAY weight, NEVER a charge (D-Q6 layer 3).
 *
 * HOMING (D-Homing = point-in-time) — CURRENT-ORG INTERIM. The canonical Anthropic
 * chargeback view homes teammate bill rows to their CURRENT org (mig 0059/0081); the
 * owner decision is point-in-time (home to the CoU AS-OF the billing month so a
 * teammate move never restates a closed month). Point-in-time teammate→CoU homing is
 * NOT cleanly derivable from existing data: `actual_spend` (the Anthropic bill, the
 * chargeback source of record) captures NO org dimension at bill time (only
 * teammate/date/tool/cost/source); there is NO teammate→org placement history table
 * (`teammate.org_unit_id` is overwritten in place by the placement workers); and
 * `spend_rollup_daily`'s point-in-time org context is the rate-carded USAGE lane, not
 * the bill, and is incomplete for un-enrolled days. So we consume the current-org
 * views AS-IS, label every finance surface "homed to current org structure", and the
 * report FLAGS point-in-time as needing a scoped org-history (SCD) follow-up. This is
 * acceptable for the build because chargeback MODE is separately gated on Wave-0
 * live-validation (`copilot.mode`); see build-design §0(5), risk 3, mig 0079 note.
 *
 * No reporting query here touches `attribution_record` or raw provider-bill tables
 * (the lane firewall, build-design §7(7) — test-enforced over `server/reporting/**`;
 * the Σ=bill term reads `v_finance_bill_totals_month`, keeping the firewall
 * exception-free). Copilot chargeback is gated on `copilot.mode` (build-design §6).
 *
 * These are the SAME functions `/reports/export` calls, so the ledger CSV is
 * byte-identical to the screen figures (build-design §2 "byte-identical rule").
 */
import { sql } from 'drizzle-orm'
import { createError } from 'h3'
import type { PostgresJsDatabase } from 'drizzle-orm/postgres-js'
import { csvEscape, csvMetaLine } from '../utils/csv-escape'
import { monthKeyUtc } from '../utils/period'
import {
  VENDOR_LANES,
  VENDOR_LABELS,
  chargeToVendor,
  laneListSql,
  type Vendor,
} from '../../shared/usage/vendor'
import {
  GITHUB_ALL_CHARGEBACK_LANES,
  GITHUB_CHARGEABLE_LANES,
  GITHUB_FIREWALL_EXCLUSIONS,
  GITHUB_USAGE_VIEW_TOOLS,
} from '../../shared/usage/github-surface'
import type { UsageWindow } from './params'
import {
  TEAMMATE_DRILL_FACTS_AGG,
  teammateDrillFacts,
  teammateDrillDims,
} from './teammate-drill-facts'
import type { DriverRow, SpendClass } from '../../shared/reports/types'
import { UNALLOCATED_KEY, UNALLOCATED_LABEL } from '../../shared/reports/unallocated'

type Tx = PostgresJsDatabase<Record<string, unknown>>

/*
 * The §B Copilot chargeback lane sets, from the registry (never hand literals in
 * SQL — copilot-surface-lanes checklist). `v_finance_chargeback_month`'s copilot
 * arm emits the chargeback LANE IDS in its `tool` column (mig 0085); the §A usage
 * tools ('copilot-cli'/'copilot-agent') never appear in chargeback views except
 * in §A-exclusion predicates. The routing set is the UNIFIED firewall export
 * (every GitHub lane id + §A tool literal) so this file and the SQL predicates
 * exclude the SAME set (r1 finding 1).
 */
const GITHUB_LANE_SET: ReadonlySet<string> = new Set(GITHUB_FIREWALL_EXCLUSIONS)
const GITHUB_CHARGEABLE_LANE_SET: ReadonlySet<string> = new Set(GITHUB_CHARGEABLE_LANES)

/** On-surface homing disclosure (D-Homing interim — see the file header). */
export const HOMING_NOTE =
  'Chargeback rows are homed to the current org structure. Point-in-time homing (charging to the CoU as-of the billing month, so a teammate move never restates a closed month) needs an org-history mechanism — a scoped follow-up.'

/**
 * The last COMPLETE calendar month (the month before `now`'s UTC month) as
 * `YYYY-MM` — the Finance default (you cannot chargeback an in-progress month).
 * `Date.UTC(y, m, 0)` = day 0 of the current month = the last day of the prior one.
 */
export function lastCompleteMonth(now: Date): string {
  return monthKeyUtc(new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 0)))
}

/**
 * The window's inclusive lower / exclusive upper date keys the monthly bill views
 * group on. For a calendar-month window these are `YYYY-MM-01` and the next
 * month-start; the index queries filter `period_month >= start AND period_month <
 * end`, which reduces to exactly `period_month = start` for a single month
 * (byte-identical) and sums the whole `period_month`s a custom range spans.
 */
function monthStartDate(range: UsageWindow): string {
  return range.startIso.slice(0, 10)
}
function nextMonthDate(range: UsageWindow): string {
  return range.endIso.slice(0, 10)
}

// ── The Σ=bill check row (VISIBLE reconciliation) ─────────────────────────────
export interface FinanceBillProvider {
  provider: string
  billUsd: number
  /** A Copilot month with usage but no read license SKU (missing line → unsettled). */
  unsettled: boolean
}

export interface FinanceBillCheck {
  /** Σ `v_finance_chargeback_month` for the month (Anthropic ∪ Copilot pooled net). */
  chargebackUsd: number
  /** Σ `v_finance_bill_totals_month` for the month (each provider one surface). */
  billUsd: number
  /** chargeback − bill (structurally ~0; a non-zero delta is a real reconciliation break). */
  deltaUsd: number
  /** true iff the chargeback reconciles to the bill AND no provider month is unsettled. */
  matched: boolean
  /** true when ANY provider month is unsettled (missing license SKU) → RED. */
  unsettled: boolean
  /**
   * The Copilot pooled-net portion of the whole-company chargeback — Σ of the three §B
   * chargeback lanes (copilot-license + copilot-usage + copilot-unclassified, mig 0085).
   * The Σ=bill check is whole-truth (includes this, unclassified and all), but the per-CoU
   * Chargeable column holds Copilot back in pool-utilisation mode — this is the exact
   * held-back delta the UI captions with so the GREEN Σ=bill headline reconciles to the
   * smaller Chargeable footing (M1).
   */
  copilotChargebackUsd: number
  /**
   * The Copilot chargeback split by §B lane (GITHUB_ALL_CHARGEBACK_LANES order, zero lanes
   * included — the UI elides). copilot-unclassified is rendered badged "needs mapping"
   * and is NEVER part of a chargeable total.
   */
  copilotLanes: FinanceCouLane[]
  /**
   * The ANTHROPIC chargeback split by surface lane (lane-visuals V3) — the same
   * `v_finance_chargeback_month` window GROUP BY tool over the Anthropic remainder
   * (everything outside the unified GitHub firewall set), mapped to registry lanes
   * via `chargeToVendor`, VENDOR_LANES order, zero lanes elided. CONSERVATION:
   * Σ anthropicLanes == chargebackUsd − copilotChargebackUsd, cent-exact
   * (test-pinned) — the per-lane structure of the Anthropic provider group in the
   * bill-compare card. The UI folds it (r1-F3); the wire carries every lane.
   */
  anthropicLanes: FinanceCouLane[]
  providers: FinanceBillProvider[]
}

/**
 * The whole-company Σ=bill reconciliation for the month. Deliberately GLOBAL (never
 * region-filtered): the entire bill must reconcile to the entire chargeback — a
 * region view of the CoU table does not narrow the reconciliation obligation. RED
 * on a delta OR an unsettled provider month; the amounts are always surfaced so an
 * unsettled month is never a silent pass (build-design §7(1), risk 7; D gate fold-in).
 */
export async function fetchFinanceBillCheck(
  tx: Tx,
  range: UsageWindow,
): Promise<FinanceBillCheck> {
  const start = monthStartDate(range)
  const end = nextMonthDate(range)

  // The copilot term = Σ of the §B chargeback lanes (mig 0085) — registry-driven, never
  // 'copilot-cli' (the §A usage lane id is banned from chargeback predicates except exclusions).
  const [cb] = [
    ...(await tx.execute<{ total: string; copilot: string }>(sql`
      SELECT COALESCE(SUM(charge_usd), 0)::text AS total,
             COALESCE(SUM(charge_usd) FILTER (WHERE tool IN (${laneListSql(GITHUB_ALL_CHARGEBACK_LANES)})), 0)::text AS copilot
      FROM v_finance_chargeback_month
      WHERE period_month >= ${start}::date AND period_month < ${end}::date`)),
  ]

  // Per-lane Copilot split for the bill-compare rendering (all three lanes, zero-filled).
  const laneRows = await tx.execute<{ tool: string; usd: string }>(sql`
    SELECT tool, COALESCE(SUM(charge_usd), 0)::text AS usd
    FROM v_finance_chargeback_month
    WHERE tool IN (${laneListSql(GITHUB_ALL_CHARGEBACK_LANES)})
      AND period_month >= ${start}::date AND period_month < ${end}::date
    GROUP BY tool`)
  const usdByLane = new Map([...laneRows].map((r) => [r.tool, Number(r.usd)]))
  const copilotLanes: FinanceCouLane[] = GITHUB_ALL_CHARGEBACK_LANES.map((lane) => ({
    lane,
    label: VENDOR_LABELS[lane],
    usd: usdByLane.get(lane) ?? 0,
  }))

  // Per-lane ANTHROPIC split (lane-visuals V3): the Anthropic remainder — everything
  // OUTSIDE the unified GitHub firewall set (never the narrower chargeback-lane list,
  // r1 finding 1) — GROUP BY tool → registry lanes. The `OR tool IS NULL` keeps a
  // NULL-tool row (structurally impossible today, but NOT IN is NULL-unsafe) inside
  // the remainder so Σ anthropicLanes always equals chargebackUsd − copilotChargebackUsd.
  const anthropicLaneRows = await tx.execute<{ tool: string | null; usd: string }>(sql`
    SELECT tool, COALESCE(SUM(charge_usd), 0)::text AS usd
    FROM v_finance_chargeback_month
    WHERE (tool NOT IN (${laneListSql(GITHUB_FIREWALL_EXCLUSIONS)}) OR tool IS NULL)
      AND period_month >= ${start}::date AND period_month < ${end}::date
    GROUP BY tool`)
  const anthropicByLane = new Map<Vendor, number>()
  for (const r of anthropicLaneRows) {
    const lane = chargeToVendor(r.tool)
    anthropicByLane.set(lane, (anthropicByLane.get(lane) ?? 0) + Number(r.usd))
  }
  const anthropicLanes: FinanceCouLane[] = VENDOR_LANES.filter(
    (lane) => (anthropicByLane.get(lane) ?? 0) !== 0,
  ).map((lane) => ({ lane, label: VENDOR_LABELS[lane], usd: anthropicByLane.get(lane) ?? 0 }))

  const billRows = await tx.execute<{ provider: string; bill: string; unsettled: boolean }>(sql`
    SELECT provider, COALESCE(SUM(bill_usd), 0)::text AS bill, bool_or(unsettled) AS unsettled
    FROM v_finance_bill_totals_month
    WHERE period_month >= ${start}::date AND period_month < ${end}::date
    GROUP BY provider
    ORDER BY provider`)

  const providers: FinanceBillProvider[] = [...billRows].map((r) => ({
    provider: r.provider,
    billUsd: Number(r.bill),
    unsettled: Boolean(r.unsettled),
  }))
  const chargebackUsd = Number(cb?.total ?? 0)
  const copilotChargebackUsd = Number(cb?.copilot ?? 0)
  const billUsd = providers.reduce((a, p) => a + p.billUsd, 0)
  const deltaUsd = chargebackUsd - billUsd
  const unsettled = providers.some((p) => p.unsettled)
  return {
    chargebackUsd,
    billUsd,
    deltaUsd,
    matched: Math.abs(deltaUsd) < 0.005 && !unsettled,
    unsettled,
    copilotChargebackUsd,
    copilotLanes,
    anthropicLanes,
    providers,
  }
}

// ── Per-CoU chargeback (index table) ──────────────────────────────────────────
/** One per-surface chargeback lane of a CoU's charge (#142). */
export interface FinanceCouLane {
  lane: Vendor
  label: string
  usd: number
}

export interface FinanceCouRow {
  /** null = the VISIBLE unallocated bucket (unmapped org / enterprise residual / no CoU). */
  couId: string | null
  code: string | null
  displayName: string
  regionCode: string | null
  /** Anthropic per-teammate chargeable, month-rolled (exempt-excluded). */
  anthropicUsd: number
  /** Copilot per-org pooled NET — Σ of the three §B chargeback lanes (license + usage +
   * unclassified; whole-truth display figure). Held back from the total when pending. */
  copilotUsd: number
  /** true in pool-utilisation mode — no Copilot chargeback lane folds into the total. */
  copilotPending: boolean
  /** anthropicUsd + (chargeback mode ? copilot-license + copilot-usage : 0).
   * copilot-unclassified is NEVER included, even in chargeback mode — an unclassified
   * bill line is money we cannot yet attribute to a SKU class, so it is surfaced (lane +
   * badge + alert) but not charged until classified (design D2, r1-F10). */
  chargeableUsd: number
  /**
   * Per-surface split (#142): the CoU's charge by vendor lane (Claude Code,
   * each non-Code Claude surface, Copilot, catch-all) in VENDOR_LANES order,
   * all-zero lanes elided. Folded from the SAME rows as the totals, so
   * Σ non-copilot lanes == anthropicUsd and the copilot lane == copilotUsd.
   */
  lanes: FinanceCouLane[]
}

/**
 * Per-CoU chargeback for the month from `v_finance_chargeback_month`. The NULL-CoU
 * bucket is retained as an explicit "Unallocated" row (never dropped). `region`
 * filters the TABLE only (a convenience view for platform-admin — never a gate
 * relaxation; the caller is already whole-company). `copilotChargeback` decides
 * whether the Copilot pooled net folds into `chargeableUsd` or is held back pending
 * (build-design §6).
 */
export async function fetchFinanceCous(
  tx: Tx,
  range: UsageWindow,
  opts: { copilotChargeback: boolean; region?: string | null },
): Promise<FinanceCouRow[]> {
  const start = monthStartDate(range)
  const end = nextMonthDate(range)
  const region = opts.region ?? null
  // #142: grouped by (CoU × tool) so the per-surface lanes and the per-provider
  // totals fold from the SAME rows — Σ non-copilot lanes == anthropicUsd by
  // construction (conservation). Same view / window / region filter as before.
  const rows = await tx.execute<{
    cou_id: string | null
    code: string | null
    display_name: string | null
    region_code: string | null
    tool: string | null
    charge: string
  }>(sql`
    SELECT c.cost_owning_unit_id::text AS cou_id, ou.code, ou.display_name, r.code AS region_code,
           c.tool AS tool,
           COALESCE(SUM(c.charge_usd), 0)::text AS charge
    FROM v_finance_chargeback_month c
    LEFT JOIN org_unit ou ON ou.id = c.cost_owning_unit_id
    LEFT JOIN region r ON r.id = c.region_id
    WHERE c.period_month >= ${start}::date AND c.period_month < ${end}::date
      AND (${region}::uuid IS NULL OR c.region_id = ${region}::uuid)
    GROUP BY c.cost_owning_unit_id, ou.code, ou.display_name, r.code, c.tool`)

  interface Agg {
    couId: string | null
    code: string | null
    displayName: string
    regionCode: string | null
    byLane: Map<Vendor, number>
  }
  const byCou = new Map<string, Agg>()
  for (const r of rows) {
    const key = r.cou_id ?? ''
    const agg =
      byCou.get(key) ??
      ({
        couId: r.cou_id,
        code: r.code,
        displayName: r.display_name ?? UNALLOCATED_LABEL,
        regionCode: r.region_code,
        byLane: new Map<Vendor, number>(),
      } satisfies Agg)
    // chargeToVendor, not toolToVendor: the view's copilot arm emits the §B LANE IDS
    // (copilot-license / copilot-usage / copilot-unclassified) in its `tool` column.
    const lane = chargeToVendor(r.tool)
    agg.byLane.set(lane, (agg.byLane.get(lane) ?? 0) + Number(r.charge))
    byCou.set(key, agg)
  }

  return [...byCou.values()]
    .map((agg) => {
      // copilotUsd (display) = Σ the three §B chargeback lanes; the chargeable copilot
      // term = license + usage ONLY. copilot-unclassified NEVER enters chargeableUsd —
      // unclassified money is surfaced-but-unchargeable until an operator classifies the
      // SKU and re-runs the month (design D2, r1-F10; runbook worker-scheduler.md).
      let copilotUsd = 0
      let copilotChargeableUsd = 0
      let anthropicUsd = 0
      for (const [lane, usd] of agg.byLane) {
        if (GITHUB_LANE_SET.has(lane)) {
          // Any GitHub lane counts into the display figure (belt-and-braces: the §A
          // 'copilot' usage lane cannot reach this view, but if it ever did it must
          // stay visible here, not vanish); ONLY the chargeable subset may charge.
          copilotUsd += usd
          if (GITHUB_CHARGEABLE_LANE_SET.has(lane)) copilotChargeableUsd += usd
        } else {
          anthropicUsd += usd
        }
      }
      const lanes: FinanceCouLane[] = VENDOR_LANES.filter(
        (lane) => (agg.byLane.get(lane) ?? 0) !== 0,
      ).map((lane) => ({ lane, label: VENDOR_LABELS[lane], usd: agg.byLane.get(lane) ?? 0 }))
      return {
        couId: agg.couId,
        code: agg.code,
        displayName: agg.displayName,
        regionCode: agg.regionCode,
        anthropicUsd,
        copilotUsd,
        copilotPending: !opts.copilotChargeback,
        chargeableUsd: anthropicUsd + (opts.copilotChargeback ? copilotChargeableUsd : 0),
        lanes,
      }
    })
    .sort((a, b) => b.anthropicUsd + b.copilotUsd - (a.anthropicUsd + a.copilotUsd))
}

// ── Exempt gap (indicative usage lane − chargeback) ───────────────────────────
export interface FinanceExemptGap {
  /** Σ `v_complete_usage` genuine usage for the month (the §A indicative lane). */
  indicativeUsageUsd: number
  /** Σ `v_finance_chargeback_month` for the month (the §B chargeable lane). */
  chargebackUsd: number
  /** indicativeUsage − chargeback: usage the bill did not (or cannot) charge (exempt/pooled). */
  gapUsd: number
  /**
   * The Copilot pooled-net portion of this (region-scoped) chargeback. The gap is whole-truth
   * (chargeback includes Copilot), but the per-CoU Chargeable column holds Copilot back in
   * pool-utilisation mode — the UI captions this figure so the card reads mode-consistently (M1).
   */
  copilotChargebackUsd: number
}

/**
 * The exempt gap — usage-lane INDICATIVE total minus chargeback (build-design §2/§4,
 * violation 4: NOT showback−chargeback; exempt orgs are never written to bill
 * surfaces, so their spend only ever appears in the usage lane). A whole-company
 * summary figure (both operands are whole-month sums — no per-CoU axis mix, so the
 * two-axis trap never fires). Region-filtered for the convenience view when set.
 */
export async function fetchFinanceExemptGap(
  tx: Tx,
  range: UsageWindow,
  opts: { region?: string | null } = {},
): Promise<FinanceExemptGap> {
  const start = monthStartDate(range)
  const end = nextMonthDate(range)
  const region = opts.region ?? null

  const [usage] = [
    ...(await tx.execute<{ usage: string }>(sql`
      SELECT COALESCE(SUM(cost_usd), 0)::text AS usage
      FROM v_complete_usage
      WHERE ts_event >= ${range.startIso}::timestamptz
        AND ts_event <  ${range.endIso}::timestamptz
        AND (${region}::uuid IS NULL OR region_id = ${region}::uuid)`)),
  ]
  // Copilot caption term = Σ the §B chargeback lanes (whole-truth, matching the Σ=bill
  // check) — registry-driven lane list, never the §A 'copilot-cli' id.
  const [cb] = [
    ...(await tx.execute<{ total: string; copilot: string }>(sql`
      SELECT COALESCE(SUM(charge_usd), 0)::text AS total,
             COALESCE(SUM(charge_usd) FILTER (WHERE tool IN (${laneListSql(GITHUB_ALL_CHARGEBACK_LANES)})), 0)::text AS copilot
      FROM v_finance_chargeback_month
      WHERE period_month >= ${start}::date AND period_month < ${end}::date
        AND (${region}::uuid IS NULL OR region_id = ${region}::uuid)`)),
  ]
  const indicativeUsageUsd = Number(usage?.usage ?? 0)
  const chargebackUsd = Number(cb?.total ?? 0)
  const copilotChargebackUsd = Number(cb?.copilot ?? 0)
  return {
    indicativeUsageUsd,
    chargebackUsd,
    gapUsd: indicativeUsageUsd - chargebackUsd,
    copilotChargebackUsd,
  }
}

// ── Drill: resolve + authorise a single CoU (anti-IDOR) ───────────────────────
export interface FinanceCouRef {
  id: string
  code: string
  displayName: string
  regionId: string | null
  regionCode: string | null
}

/**
 * Resolve a CoU for the drill (build-design §2 — resource-anchored). Only
 * region-unbounded roles (platform-admin) reach this endpoint, so
 * there is no cross-region 403 to enforce — anti-IDOR here means a non-existent /
 * non-cost-owning id is a 404 (never a 500, never a silent empty). The id is a real
 * cost-owning unit or nothing.
 */
export async function resolveFinanceCou(tx: Tx, couId: string): Promise<FinanceCouRef> {
  const rows = await tx.execute<{
    id: string
    code: string
    display_name: string
    region_id: string | null
    region_code: string | null
  }>(sql`
    SELECT ou.id::text AS id, ou.code, ou.display_name,
           ou.region_id::text AS region_id, r.code AS region_code
    FROM org_unit ou LEFT JOIN region r ON r.id = ou.region_id
    WHERE ou.id = ${couId}::uuid AND ou.is_cost_owning_unit = TRUE AND ou.retired_at IS NULL
    LIMIT 1`)
  const cou = [...rows][0]
  if (!cou) throw createError({ statusCode: 404, statusMessage: 'cost-owning unit not found' })
  return {
    id: cou.id,
    code: cou.code,
    displayName: cou.display_name,
    regionId: cou.region_id,
    regionCode: cou.region_code,
  }
}

// ── Drill: Anthropic per-teammate charges (teammate-homed finance axis) ────────
export interface AnthropicCharge {
  teammateId: string
  label: string
  chargeUsd: number
  /**
   * The teammate's charge split by surface lane (lane-visuals V3): the SAME
   * `v_finance_bill_chargeback` rows GROUP BY (teammate × tool), mapped to
   * registry lanes via `chargeToVendor`, VENDOR_LANES order, zero lanes elided.
   * CONSERVATION BY CONSTRUCTION: `chargeUsd` is the Σ of exactly these lanes
   * (both fold from the same rows), cent-exact — test-pinned. Feeds the drill's
   * dominant-lane badge + "+N surfaces" tooltip (r1-F7/r2-5 — row-resolution
   * legibility, deliberately NOT a per-row mini-stack).
   */
  lanes: FinanceCouLane[]
}

/**
 * The CoU's Anthropic per-teammate charges (the bill names the person), month-bounded,
 * from `v_finance_bill_chargeback` (copilot + exempt already excluded by the view),
 * grouped (teammate × tool) so each row carries its per-lane split alongside the
 * total (lane-visuals V3). These ARE the chargeable P&L figure
 * (settling-provisional). Σ = anthropicChargeableUsd.
 */
export async function fetchAnthropicCharges(
  tx: Tx,
  couId: string,
  range: UsageWindow,
): Promise<{ charges: AnthropicCharge[]; totalUsd: number }> {
  const start = monthStartDate(range)
  const end = nextMonthDate(range)
  // V3: grouped (teammate × tool) so the per-lane split and the per-teammate total
  // fold from the SAME rows — Σ lanes == chargeUsd by construction (conservation).
  // Same view / window / firewall predicate as the pre-widening query, so the
  // teammate totals are byte-identical.
  const rows = await tx.execute<{
    teammate_id: string
    label: string | null
    tool: string | null
    value: string
  }>(sql`
    SELECT b.teammate_id::text AS teammate_id, COALESCE(t.display_name, t.email) AS label,
           b.tool AS tool,
           COALESCE(SUM(b.bill_usd), 0)::text AS value
    FROM v_finance_bill_chargeback b JOIN teammate t ON t.id = b.teammate_id
    WHERE b.cost_owning_unit_id = ${couId}::uuid
      -- Unified GitHub firewall (registry-driven, never a hand literal) — belt-and-
      -- braces on top of the view's own §A exclusion (mig 0085 §1b). The
      -- "OR b.tool IS NULL" matches the billCheck sibling EXACTLY (r3-1): NOT IN
      -- is NULL-unsafe, so without it a NULL-tool chargeback row would vanish
      -- from the drill (breaking Σ charges == anthropicChargeableUsd) instead of
      -- landing in chargeToVendor(null)'s catch-all lane.
      AND (b.tool NOT IN (${laneListSql(GITHUB_FIREWALL_EXCLUSIONS)}) OR b.tool IS NULL)
      AND b.period_date >= ${start}::date AND b.period_date < ${end}::date
    GROUP BY b.teammate_id, t.display_name, t.email, b.tool`)

  interface Agg {
    teammateId: string
    label: string
    byLane: Map<Vendor, number>
  }
  const byTeammate = new Map<string, Agg>()
  for (const r of rows) {
    const agg =
      byTeammate.get(r.teammate_id) ??
      ({ teammateId: r.teammate_id, label: r.label ?? 'Unknown', byLane: new Map<Vendor, number>() } satisfies Agg)
    const lane = chargeToVendor(r.tool)
    agg.byLane.set(lane, (agg.byLane.get(lane) ?? 0) + Number(r.value))
    byTeammate.set(r.teammate_id, agg)
  }

  const charges: AnthropicCharge[] = [...byTeammate.values()]
    .map((agg) => {
      let chargeUsd = 0
      for (const usd of agg.byLane.values()) chargeUsd += usd
      const lanes: FinanceCouLane[] = VENDOR_LANES.filter(
        (lane) => (agg.byLane.get(lane) ?? 0) !== 0,
      ).map((lane) => ({ lane, label: VENDOR_LABELS[lane], usd: agg.byLane.get(lane) ?? 0 }))
      return { teammateId: agg.teammateId, label: agg.label, chargeUsd, lanes }
    })
    .sort((a, b) => b.chargeUsd - a.chargeUsd)
  return { charges, totalUsd: charges.reduce((a, c) => a + c.chargeUsd, 0) }
}

// ── Drill: Copilot per-org pooled lines (org→CoU-map-homed) ────────────────────
export interface CopilotPooledLine {
  orgId: string | null
  label: string
  licenseUsd: number
  overageUsd: number
  /** Copilot lines matching neither SKU classifier (mig 0085) — visible, badged
   * "needs mapping", NEVER part of netUsd or any chargeable figure. */
  unclassifiedUsd: number
  /** license + overage — the CHARGEABLE net (unclassified deliberately excluded). */
  netUsd: number
  /** license absent but usage present → the month reports unsettled (risk 7). */
  unsettled: boolean
}

export interface CopilotPoolUtilisation {
  /** Σ gross AI-credit consumption for the CoU's orgs (context weight, never a charge). */
  usageGrossUsd: number
  /** Σ `included` pool allowance for the CoU's orgs (the interim estimate). */
  poolUsd: number
  /** usageGross / pool as a FRACTION in [0,1], or null when no pool. */
  utilisation: number | null
  /** Σ unclassified NET for the CoU's orgs — surfaced on the pool-utilisation card
   * too (unclassified money is visible in EVERY mode, chargeable in none). */
  unclassifiedNetUsd: number
}

/**
 * The CoU's Copilot pooled bill — org→CoU-map-homed (mig 0080). Returns BOTH the
 * per-org pooled lines (license net + overage net, the chargeback-mode surface) and
 * the pool-utilisation summary (usage-gross vs the `included` allowance, the
 * pool-utilisation-mode surface). The endpoint renders one or the other by
 * `copilot.mode` (build-design §6). Both read `copilot_pool_bill` ONLY — no
 * actual_spend copilot row is a chargeback operand (§7 lane firewall).
 */
export async function fetchCopilotPool(
  tx: Tx,
  couId: string,
  range: UsageWindow,
): Promise<{
  lines: CopilotPooledLine[]
  utilisation: CopilotPoolUtilisation
  licenseNetUsd: number
  overageNetUsd: number
  /** Σ unclassified NET — visible in both modes, NEVER chargeable (design D2). */
  unclassifiedNetUsd: number
  seats: number
  poolUsd: number
  /** true when ANY pooled line is unsettled (license absent but usage present) → the CoU-month
   * is unsettled: `licenseNetUsd` (and thus `chargeableUsd`) silently drops the unread license,
   * so the drill must caveat the Chargeable headline + swap the green chip for amber (M2). */
  unsettled: boolean
}> {
  // Range-aware (mirrors the finance index generalization `period_month = start` →
  // `>= start AND < end`): a quarter sums the whole `month`s it spans. GROUP BY org so
  // each org is ONE line summing its months (never a duplicate-key row across months);
  // `unsettled` is bool_or of the per-MONTH "license absent but usage present" predicate,
  // so an unsettled month is never masked by a settled one in the same range (risk 7).
  // Month mode (one month) is byte-identical: the SUMs reduce to the single row's values.
  const start = monthStartDate(range)
  const end = nextMonthDate(range)
  const rows = await tx.execute<{
    org_id: string | null
    label: string | null
    license: string | null
    overage: string | null
    unclassified: string | null
    included: string | null
    usage_gross: string | null
    seats: number | null
    unsettled: boolean
  }>(sql`
    SELECT b.provider_org_id::text AS org_id,
           COALESCE(po.display_name, po.external_org_id) AS label,
           SUM(b.license_net_usd)::text AS license, SUM(b.overage_net_usd)::text AS overage,
           SUM(b.unclassified_net_usd)::text AS unclassified,
           SUM(b.included_allowance_usd)::text AS included, SUM(b.usage_gross_usd)::text AS usage_gross,
           COALESCE(SUM(b.seats), 0)::int AS seats,
           bool_or(b.license_net_usd IS NULL AND COALESCE(b.usage_gross_usd, 0) > 0) AS unsettled
    FROM copilot_pool_bill b LEFT JOIN provider_org po ON po.id = b.provider_org_id
    WHERE b.cost_owning_unit_id = ${couId}::uuid
      AND b.month >= ${start}::date AND b.month < ${end}::date
    GROUP BY b.provider_org_id, po.display_name, po.external_org_id
    ORDER BY (COALESCE(SUM(b.license_net_usd), 0) + COALESCE(SUM(b.overage_net_usd), 0)) DESC NULLS LAST`)

  const lines: CopilotPooledLine[] = []
  let licenseNetUsd = 0
  let overageNetUsd = 0
  let unclassifiedNetUsd = 0
  let seats = 0
  let poolUsd = 0
  let usageGrossUsd = 0
  let unsettled = false
  for (const r of rows) {
    const license = r.license == null ? 0 : Number(r.license)
    const overage = r.overage == null ? 0 : Number(r.overage)
    const unclassified = r.unclassified == null ? 0 : Number(r.unclassified)
    const included = r.included == null ? 0 : Number(r.included)
    const usageGross = r.usage_gross == null ? 0 : Number(r.usage_gross)
    const lineUnsettled = Boolean(r.unsettled)
    if (lineUnsettled) unsettled = true
    licenseNetUsd += license
    overageNetUsd += overage
    unclassifiedNetUsd += unclassified
    poolUsd += included
    usageGrossUsd += usageGross
    seats += Number(r.seats ?? 0)
    lines.push({
      orgId: r.org_id,
      label: r.label ?? (r.org_id ? 'Unknown org' : 'Enterprise residual (no org)'),
      licenseUsd: license,
      overageUsd: overage,
      unclassifiedUsd: unclassified,
      // netUsd = the CHARGEABLE net (license + overage). unclassified is shown on the
      // line but never folded in — it cannot charge until classified (design D2).
      netUsd: license + overage,
      unsettled: lineUnsettled,
    })
  }
  return {
    lines,
    utilisation: {
      usageGrossUsd,
      poolUsd,
      utilisation: poolUsd > 0 ? usageGrossUsd / poolUsd : null,
      unclassifiedNetUsd,
    },
    licenseNetUsd,
    overageNetUsd,
    unclassifiedNetUsd,
    seats,
    poolUsd,
    unsettled,
  }
}

// ── Drill: project overlay (chargeable split, Anthropic) ──────────────────────
/**
 * The CoU's tagged project split from `v_finance_project_overlay` (chargeable-only,
 * Anthropic; overlay excludes Copilot + exempt; bill split proportionally by
 * tagged share, docs/design/project-chargeback-lens.md). The rows sum back to the CoU's
 * Anthropic chargeable (the untagged remainder is an explicit "Untagged" bucket).
 */
export async function fetchFinanceProjectOverlay(
  tx: Tx,
  couId: string,
  range: UsageWindow,
  headlineUsd: number,
): Promise<DriverRow[]> {
  const start = monthStartDate(range)
  const end = nextMonthDate(range)
  const rows = await tx.execute<{ key: string | null; label: string | null; value: string }>(sql`
    SELECT o.project_id::text AS key, COALESCE(p.display_name, p.code) AS label,
           COALESCE(SUM(o.charge_usd), 0)::text AS value
    FROM v_finance_project_overlay o LEFT JOIN project p ON p.id = o.project_id
    WHERE o.cost_owning_unit_id = ${couId}::uuid
      AND o.period_date >= ${start}::date AND o.period_date < ${end}::date
    GROUP BY o.project_id, p.display_name, p.code
    ORDER BY SUM(o.charge_usd) DESC NULLS LAST`)
  return [...rows].map((r) => {
    const usd = Number(r.value)
    return {
      key: r.key ?? '__untagged',
      label: r.label ?? 'Untagged',
      usd,
      sharePct: headlineUsd > 0 ? usd / headlineUsd : 0,
      // The chargeable Anthropic project split is settling-provisional, not finalised
      // (build-design bans "finalised") — rendered `indicative`, matching the CC scope.
      spendClass: 'indicative' as SpendClass,
    }
  })
}

// ── Drill: Overage Drivers (D-Q6 layer 3 — INFORMATIONAL, never a charge) ──────
export interface OverageDrivers {
  /** The paid pooled overage the informational shares sum back to. */
  overageNetUsd: number
  /** pool / seats — the per-seat allowance a teammate's usage is measured against. */
  perSeatShareUsd: number
  /** Proportional INDICATIVE shares (excess_i / Σexcess × overage_net); Σ = overage_net. */
  rows: DriverRow[]
}

/**
 * The Overage Drivers panel (D-Q6 layer 3), computed ONLY when the CoU has PAID
 * overage (overage_net > 0) in chargeback mode. For each teammate homed to the CoU
 * (current org) with Copilot usage in the month, EXCESS above their per-seat share
 * is `max(0, usage_i − pool/seats)`; each teammate's PROPORTIONAL indicative share is
 * `excess_i / Σexcess × overage_net`. When no one exceeds their share (Σexcess = 0)
 * the paid overage is still real, so the shares distribute by raw usage instead — the
 * shares ALWAYS sum back to the paid overage. This is INFORMATIONAL (spendClass
 * `indicative`, "informational — not a charge"), a §A display weight — it is NEVER
 * written as a charge (in-product per-user charging is canon-rejected; the CSV lets
 * finance distribute manually if they choose).
 *
 * NOT the same mechanism as the PERSISTED overage allocation (ADR-0011 D10,
 * `server/governance/copilot-overage-allocation.ts`, Workstream C): that one is
 * the real, audited, conservation-asserted redistribution
 * `v_finance_copilot_pool_chargeback`'s `copilot-usage` lane actually charges
 * from; this panel is a separate, in-memory, per-CoU, per-teammate display that
 * never writes anything and must never be read as the charge. Keep the two
 * clearly labelled and never merge them into one figure.
 */
export async function fetchOverageDrivers(
  tx: Tx,
  couId: string,
  range: UsageWindow,
  opts: { overageNetUsd: number; poolUsd: number; seats: number },
): Promise<OverageDrivers> {
  const start = monthStartDate(range)
  const end = nextMonthDate(range)
  const perSeatShareUsd = opts.seats > 0 ? opts.poolUsd / opts.seats : 0

  // Per-teammate Copilot USAGE (the §A display weight) homed to the CoU (current org).
  // ALL Copilot usage lanes weigh in (GITHUB_USAGE_VIEW_TOOLS: copilot-cli + copilot-agent,
  // i.e. what mig 0086's view — `ud` here — can emit) — the paid overage_net the shares
  // distribute is the AI-credit/agent SKU pool (mig 0085 copilot-usage lane), which the
  // coding agent draws from exactly like interactive use.
  const rows = await tx.execute<{
    key: string
    label: string | null
    usage: string
    drill_is_active: boolean | null
    drill_is_provisional: boolean | null
  }>(sql`
    SELECT ud.teammate_id::text AS key, COALESCE(t.display_name, t.email) AS label,
           COALESCE(SUM(ud.usage_usd), 0)::text AS usage,
           -- The drill facts, from the ONE shared producer (teammate-drill-facts.ts).
           -- (No backticks inside this literal: one in a SQL comment CLOSES the sql
           -- template and the parse error points at the wrong line.)
           --
           -- provisional is carried here even though the GitHub identity writer
           -- resolves seats against NOT provisional only (adapters/github-identity.ts
           -- resolveTeammateId) and bill-driven provisioning mints provisional = false
           -- (placement-store.ts createBillTeammate) -- i.e. a provisional shadow
           -- cannot currently reach v_teammate_usage_daily at all. That is an invariant
           -- of a DIFFERENT module, three lanes away, which nothing here rechecks and
           -- no test ties to this row. Carrying the fact makes the door closed BY
           -- CONSTRUCTION instead of by a remote coincidence (r5-H1).
           ${TEAMMATE_DRILL_FACTS_AGG}
    FROM v_teammate_usage_daily ud JOIN teammate t ON t.id = ud.teammate_id
    -- ONE cost-owner resolution (v_org_unit_cost_owner, mig 0114), not a
    -- correlated LATERAL per usage-daily row. INNER, deliberately: the clamp
    -- below is cc.cost_owning_unit_id = couId, so a teammate with no
    -- cost-owning ancestor is excluded either way — an outer join would only
    -- add NULL rows for the predicate to discard.
    JOIN v_org_unit_cost_owner cc ON cc.org_unit_id = t.org_unit_id
    WHERE ud.tool IN (${laneListSql(GITHUB_USAGE_VIEW_TOOLS)}) AND cc.cost_owning_unit_id = ${couId}::uuid
      AND ud.day >= ${start}::date AND ud.day < ${end}::date
    GROUP BY ud.teammate_id, t.display_name, t.email
    ORDER BY SUM(ud.usage_usd) DESC NULLS LAST`)

  const used = [...rows].map((r) => ({
    key: r.key,
    label: r.label ?? 'Unknown',
    usage: Number(r.usage),
    excess: Math.max(0, Number(r.usage) - perSeatShareUsd),
    // The drill-admission conjuncts (D34) — see engine/drivers.ts's teammate axis.
    // Read back through the shared helper, never re-derived per producer.
    facts: teammateDrillFacts(r),
  }))

  const totalExcess = used.reduce((a, u) => a + u.excess, 0)
  // Prefer the excess weight; when nobody is over their share, distribute the (still
  // real) paid overage by raw usage so the shares always sum to the paid overage.
  const byExcess = totalExcess > 0
  const totalWeight = byExcess ? totalExcess : used.reduce((a, u) => a + u.usage, 0)

  const driverRows: DriverRow[] = used
    .map((u) => {
      const weight = byExcess ? u.excess : u.usage
      const shareUsd = totalWeight > 0 ? (weight / totalWeight) * opts.overageNetUsd : 0
      return {
        key: u.key,
        label: u.label,
        usd: shareUsd,
        sharePct: opts.overageNetUsd > 0 ? shareUsd / opts.overageNetUsd : 0,
        // INFORMATIONAL — a proportional indicative share, never a charge (D-Q6).
        spendClass: 'indicative' as SpendClass,
        dims: {
          usageUsd: u.usage.toFixed(6),
          excessUsd: u.excess.toFixed(6),
          ...teammateDrillDims(u.facts),
        },
      }
    })
    .filter((r) => r.usd > 0)

  // Empty-distribution edge: PAID overage but nothing to weight it over (no teammate homed to
  // the CoU had Copilot usage in the month, or all usage was zero → totalWeight = 0). Without a
  // row the informational shares sum to 0 ≠ overage and the panel's sum-back goes RED on an
  // informational surface. Emit ONE explicit unallocated-overage row so it still foots (L2).
  if (opts.overageNetUsd > 0 && totalWeight === 0) {
    driverRows.push({
      key: UNALLOCATED_KEY,
      label: `${UNALLOCATED_LABEL} overage — no attributable usage`,
      usd: opts.overageNetUsd,
      sharePct: 1,
      // INFORMATIONAL — indicative, never a charge (D-Q6); the paid overage is real but no §A
      // usage weight exists to distribute it, so it lands whole in an explicit unallocated row.
      spendClass: 'indicative' as SpendClass,
      indicativeReason: 'no-attributable-usage',
      dims: { usageUsd: '0.000000', excessUsd: '0.000000' },
    })
  }

  return { overageNetUsd: opts.overageNetUsd, perSeatShareUsd, rows: driverRows }
}

// ── CSV: the finance LEDGER (cost-centre × provider × month) ───────────────────
/** `spend_usd` two-decimal, matching the on-screen `fmtUsd` precision. */
function usd(n: number): string {
  return n.toFixed(2)
}

/**
 * The finance ledger CSV — grain cost-centre × provider(× lane) × month (owner D-Q8).
 * Per CoU: one aggregate Anthropic row (lane blank) and one row PER §B Copilot
 * chargeback lane (copilot-license / copilot-usage / copilot-unclassified, zero lanes
 * skipped — the pre-split convention for a $0 github row). `chargeback_pending` flags
 * a lane finance must not x-charge yet: every github lane in pool-utilisation mode,
 * and copilot-unclassified ALWAYS (unclassified money is never chargeable, even in
 * chargeback mode — classify + re-run first). asOf-stamped (owner gate fold-in).
 * Byte-identical to the per-CoU screen figures.
 *
 * COLUMN CONVENTION — ADDITIVE-ONLY: downstream BI/FinOps consumers may parse this
 * ledger by column INDEX, so an existing column's position is a contract. New columns
 * (like `lane`, added by the mig-0085 lane split) are appended at the END of the row,
 * never spliced into the middle (r1 finding 4).
 */
export function financeLedgerToCsv(
  cous: FinanceCouRow[],
  meta: {
    month: string
    asOfDate: string | null
    anthropicState: string
    githubState: string
    check: FinanceBillCheck
  },
): string {
  const lines: string[] = [
    csvMetaLine(`# tokenscope finance ledger · month=${meta.month} · as_of=${meta.asOfDate ?? 'n/a'} · reconciliation=${meta.check.matched ? 'matched' : 'UNSETTLED'} · chargeback=${usd(meta.check.chargebackUsd)} · bill=${usd(meta.check.billUsd)}`),
    'cost_centre,region,provider,month,charge_usd,chargeback_pending,settling_state,lane',
  ]
  for (const c of cous) {
    const region = c.regionCode ?? ''
    if (c.anthropicUsd !== 0) {
      lines.push(
        [csvEscape(c.displayName), csvEscape(region), 'anthropic', meta.month, usd(c.anthropicUsd), 'false', meta.anthropicState, ''].join(','),
      )
    }
    // One row per non-zero §B Copilot lane, registry order (c.lanes is zero-elided).
    for (const laneId of GITHUB_ALL_CHARGEBACK_LANES) {
      const lane = c.lanes.find((l) => l.lane === laneId)
      if (!lane || lane.usd === 0) continue
      const pending = !GITHUB_CHARGEABLE_LANE_SET.has(laneId) ? true : c.copilotPending
      lines.push(
        [csvEscape(c.displayName), csvEscape(region), 'github', meta.month, usd(lane.usd), String(pending), meta.githubState, laneId].join(','),
      )
    }
  }
  return lines.join('\n') + '\n'
}
