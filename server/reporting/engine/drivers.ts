/*
 * §A ranked drivers, scope-parameterised — ONE implementation for the regional
 * and whole-company driver tables that previously carried a copy each.
 *
 * The pair these replace differed in exactly two things once the scope predicate
 * was normalised away: the whole-company copy offered a `region` axis, and its
 * NULL bucket on that axis is labelled "Unassigned". Every other branch —
 * teammate, surface, model, project, practice — was line-identical, including
 * the two grouping subtleties that are easy to lose in a rewrite (the
 * (teammate, tool, provenance) fold that yields the row total and both
 * breakdowns from ONE query, and the (model, provenance) grouping that keeps the
 * two reasons for a NULL model in separate rows).
 *
 * That the copies were already drifting is not hypothetical here: the cost-owner
 * LATERAL fix in #219 had to be applied to fetchRegionalDrivers AND
 * fetchAcrossDrivers in the same commit to avoid one scope keeping the slow plan.
 *
 * ── ONE LANE PER ANSWER, AND THE ANSWER SAYS WHICH ──────────────────────────
 *
 * This engine now answers at TWO lenses, because the reporting shell has a lane
 * toggle and Top drivers has to move with it. Selecting *Chargeback · billed*
 * used to re-lens the KPI hero and leave attributed rows underneath it.
 *
 *   usage      §A — `usage_rollup_daily` (the day-grain rollup of the
 *                   completeness lane, usage-rollup-lane.md R5) or the
 *                   project-spend seam over the live lane (that seam is shared
 *                   with non-report consumers and stays on `v_complete_usage`).
 *                   A driver row is "who
 *                   consumed this", never "who is billed for it" (contract C2).
 *   chargeback §B — the cost of record, PER PROVIDER, from TWO sources because
 *                   the two providers bill at different grains:
 *                   `provider_usage_fact` for Anthropic's per-teammate charge
 *                   (`engine/billed-axis.ts`), and the POOLED Copilot invoice
 *                   `v_finance_copilot_pool_chargeback` at the two axes that
 *                   home it (`engine/pooled-chargeback-axis.ts`).
 *
 *                   `provider_usage_fact` is NOT the chargeback lane for GitHub:
 *                   after mig 0120 its `github` rows are gross AI-credit
 *                   CONSUMPTION before the pooled allowance. Reading chargeback
 *                   from that table alone produced an Anthropic-only subtotal
 *                   under a company-wide label — the defect `chargebackCoverage`
 *                   and the pooled arm exist to close, from both ends: the axes
 *                   that CAN carry the Copilot charge now do, and the axes that
 *                   cannot say so in words instead of quietly answering for one
 *                   provider.
 *
 * WHAT DID NOT CHANGE IS THE RULE ITSELF. Each answer is still exactly ONE lane
 * end to end, so its `headlineUsd` is a denominator from the same lane as its
 * numerators and its rows sum back to it. What changed is that the answer is no
 * longer the same lane for every request — so the result now DECLARES its lane
 * (`DriversResult.lane`), and a response carrying more than one must label each
 * measure (`MeasureLanes`).
 *
 * THE BUDGET AXIS IS THE EXCEPTION AND IT IS DECLARED, NOT HIDDEN. It answers
 * `attributed` in BOTH lenses: `provider_usage_fact` has no project column, so
 * this engine has no billed project figure. The project chargeback split (the
 * bill split by tagged share, `v_finance_project_overlay`) is served on the
 * project page, not on this axis — docs/design/project-chargeback-lens.md and
 * `engine/budget-axis.ts`.
 */
import { sql } from 'drizzle-orm'
import type { PostgresJsDatabase } from 'drizzle-orm/postgres-js'
import { toolToVendor, VENDOR_LANES, VENDOR_LABELS, type Vendor } from '../../../shared/usage/vendor'
import { modelDriverLabel, modelDriverKey } from '../../../shared/reports/model-attribution'
import { GITHUB_USAGE_LANE_IDS } from '../../../shared/usage/github-surface'
import type { SpendLens } from '../../../shared/usage/lens'
import { isChargeMeasure } from '../../../shared/reports/provider-measure'
import type {
  BilledAxisArm,
  BilledLaneMeta,
  ChargebackCoverage,
  ChargebackGap,
  DriverRow,
  MeasureLane,
} from '../../../shared/reports/types'
import {
  foldDriverBreakdown,
  driverSurfaceBreakdown,
  driverProvenanceBreakdown,
  isMonthAlignedWindow,
  isPooledSurfaceOnly,
  type UsageWindow,
} from '../params'
import { fetchBilledAxis, isBilledAxis } from './billed-axis'
import { fetchBudgetAxis } from './budget-axis'
import {
  fetchPooledChargebackArm,
  isPooledChargebackAxis,
  pooledChargebackAxisList,
  POOLED_CHARGEBACK_AXES,
  POOLED_CHARGEBACK_PROVIDER,
} from './pooled-chargeback-axis'
import { scopeSql, type FinanceScope, type UsageScope } from './scope'
import {
  TEAMMATE_DRILL_FACTS_AGG,
  foldTeammateDrillFacts,
  teammateDrillDims,
  NO_TEAMMATE_DRILL_FACTS,
} from '../teammate-drill-facts'

type Tx = PostgresJsDatabase<Record<string, unknown>>

/**
 * Every axis the engine CAN rank — NOT a per-scope menu. Each scope keeps its
 * own const array (REGIONAL_DRIVER_AXES / ACROSS_DRIVER_AXES) and that is what
 * gates a request.
 *
 * `region` is currently gated OUT of both: it is meaningless inside a
 * single-region clamp, and the whole-company scope retired it when Region got
 * its own card (`ACROSS_DRIVER_AXES`, prototype `note('fix 4a', …)`). The
 * capability stays here — the three §B axis helpers (`BILLED_AXES`,
 * `POOLED_CHARGEBACK_AXES`) address it and it is a scope's gate, not this
 * engine's, that decides whether a reader can ask for it.
 */
export type DriverAxis = 'region' | 'practice' | 'teammate' | 'model' | 'project' | 'surface'

/**
 * Ranked drivers for one axis over one scope and window, with the in-scope
 * denominator they share, and the LANE both were computed on.
 *
 * `headlineUsd` is Σ of the returned rows, so `sharePct` always sums to 1 and the
 * table foots to its own total. The NULL bucket (unattributed model / untagged
 * project / no-practice / unassigned region) is a ROW rather than a filter, which
 * is what makes that sum-back hold (build-design §7(4)).
 */
export interface DriversResult {
  rows: DriverRow[]
  /** Σ of `rows`, in `lane`. Never a denominator from the other lane. */
  headlineUsd: number
  /**
   * The lane `rows` and `headlineUsd` were computed on — NOT the lens that was
   * requested. The budget axis answers `attributed` even under
   * `lens: 'chargeback'`, and this is the field that says so.
   */
  lane: MeasureLane
  /**
   * Present ONLY on a billed-lane answer: how to read a $0, the billed total,
   * and the PER-PROVIDER arms. Absent on every attributed answer, where there is
   * no second meaning of `cost_usd` to qualify.
   */
  billedLane?: BilledLaneMeta
  /**
   * Present ONLY on the budget axis: the part of `headlineUsd` carrying no
   * budget claim. `Σ(budget rows) + unallocatedUsd === headlineUsd`.
   */
  unallocatedUsd?: number
  /**
   * Present ONLY under `lens: 'chargeback'`: WHOSE charge this answer is, and
   * which provider's charge this axis structurally cannot carry.
   *
   * It rides EVERY chargeback answer, including a complete one (where `gaps` is
   * empty), because "this figure is every provider that bills the scope" is a
   * claim and an undeclared response is indistinguishable from one nobody
   * checked — the same rule `measureLanes` follows.
   */
  chargebackCoverage?: ChargebackCoverage
}

/**
 * How the pooled Copilot invoice is missing from an axis it cannot be ranked on
 * — the reader-facing sentence, written ONCE, server-side.
 *
 * It names the BILLING MODEL rather than a data gap, because that is what it is:
 * Copilot raises one pooled invoice per cost-owning unit, so a per-teammate or
 * per-model Copilot charge does not exist and no amount of collection would
 * produce one. Copy that said "not yet available" would promise a number that is
 * never coming.
 *
 * The axis set it points readers AT is derived from `POOLED_CHARGEBACK_AXES`
 * (`pooledChargebackAxisList`), never typed out here — the previous revision
 * gapped the SURFACE axis and told readers to use Practice, and both halves of
 * that sentence were wrong the moment the pooled view's own `tool` column was
 * read for what it is.
 *
 * It is intersected with `offeredAxes`, the CALLING SCOPE's own gate, because
 * "this axis can be ranked" and "this reader can pick it" are different facts and
 * this sentence is about the second. Region is the case that split them: still
 * rankable, no longer offered (prototype fix 4a). If the intersection is empty
 * there is nowhere to send anyone, and the sentence stops at the gap itself
 * rather than inventing a destination.
 */
function pooledAxisGap(axis: 'teammate' | 'model', offeredAxes: readonly string[]): ChargebackGap {
  const noun = axis === 'teammate' ? 'per-teammate' : 'per-model'
  const where = pooledChargebackAxisList(offeredAxes)
  return {
    provider: POOLED_CHARGEBACK_PROVIDER,
    reason:
      `Copilot bills pooled per Business Unit, so it has no ${noun} charge — this figure is Anthropic's alone.` +
      (where ? ` Break down by ${where} to see the Copilot charge.` : ''),
  }
}

/**
 * A charge arm that EXISTS but has had NOTHING derived for this window — the
 * difference between "we measured zero" and "we have not measured".
 *
 * WHY THIS IS A GAP AND NOT SILENCE. `coverage.providers` used to be read off
 * the arm LIST, so an arm that returned `no-data-yet` still put its provider in
 * the sentence "this figure is every provider that bills the scope". With the
 * pooled Copilot gate ON and no bill rows for the window, that published
 * Anthropic's subtotal under a label claiming both providers and emitted no gap
 * at all — arm EXISTENCE mistaken for data AVAILABILITY. `'none-in-scope'` is
 * deliberately NOT here: the arm was derived, this scope simply has none of it,
 * which is a real zero and belongs in the figure.
 */
function notDerivedGap(provider: string): ChargebackGap {
  return {
    provider,
    reason: `No ${provider} charge has been derived for this window yet, so it is not in this figure — a missing derivation, not a measured zero.`,
  }
}

/**
 * @param lens which question is being asked — `usage` (§A attributed) or
 *   `chargeback` (§B billed). Defaults to `usage`, the shipped behaviour, so a
 *   caller that has not been taught about the toggle cannot silently start
 *   answering the other question.
 *
 * The lane is aliased `u` and clamps must address `u.region_id` / `u.org_unit_id`
 * — the same contract `fetchDailyMetrics` has with its callers, and load-bearing
 * rather than cosmetic here: three of the six branches JOIN a second relation, so
 * an unqualified `region_id` in a caller's predicate would be ambiguous rather
 * than merely untidy.
 *
 * That contract is ALSO what lets the billed axes reuse the clamp VERBATIM
 * against `provider_usage_fact`: it carries the same homing columns
 * (`provider_usage_fact` is NOT billed-only — it is every row the provider
 * reported, normalised; §B is a FILTER over it, joining the org/enterprise
 * flags at read time. See target-state-data-architecture.md §6.)
 * with the same historical meaning (mig 0118), so a scope resolves through the
 * fact table's OWN homing rather than through a join back to a teammate's
 * current placement.
 */
export async function fetchDrivers(
  tx: Tx,
  scope: UsageScope,
  range: UsageWindow,
  axis: DriverAxis,
  lens: SpendLens = 'usage',
  /*
   * The chargeback lane's SECOND source and its gate. Both are inert in the
   * usage lane, which is why they are optional rather than required positional
   * arguments: a caller that has not been taught about the pooled Copilot
   * invoice keeps exactly its previous behaviour, and its chargeback answers
   * declare the Copilot charge as an unresolved gap rather than quietly omitting
   * it.
   */
  billing: {
    /**
     * The §B clamp over (`u.region_id`, `u.cost_owning_unit_id`) — a DIFFERENT
     * pair of columns from the §A clamp above, which is why it is a separate
     * argument rather than a reuse (`engine/scope.ts`'s phantom lane parameter).
     */
    financeScope?: FinanceScope
    /**
     * `copilotChargebackEnabled()` — whether the pooled Copilot chargeback has
     * been validated on Dev and may render as a charge (build-design §6). The
     * SAME gate every other §B Copilot surface honours; rendering an unvalidated
     * pooled charge as a hard dollar here while Finance withholds it would be a
     * new inconsistency between two screens showing the same money.
     */
    copilotChargeback?: boolean
    /**
     * The CALLING SCOPE's own axis gate (`ACROSS_DRIVER_AXES` /
     * `REGIONAL_DRIVER_AXES`) — the axes this reader can actually pick.
     *
     * Used only to compose the "break down by …" half of a gap sentence, so it
     * can never send someone to a chip that is not on their page. Optional and
     * defaulting to every rankable axis, which is the behaviour a caller that has
     * not been taught its own gate already had.
     */
    offeredAxes?: readonly string[]
  } = {},
): Promise<DriversResult> {
  const clamp = scopeSql(scope)
  /*
   * The §A axes below read `usage_rollup_daily` (usage-rollup-lane.md R5) —
   * every dim they group or join on (teammate, tool, provenance, model,
   * model_gap_reason, region, org_unit) is in the rollup grain, so each query
   * translates 1:1. This `window` fragment is applied ONLY to those rollup
   * reads: the billed axes below build their own `period`-windowed predicates
   * over provider_usage_fact (§B — untouched), and the budget axis passes
   * `range` to the shared project-spend seam, which builds its own rollup day
   * translation (`source: 'rollup'`, usage-rollup-lane.md R5b). Exact because
   * startIso/endIso are UTC-midnight instants by construction
   * (resolveReportWindow) — the seam THROWS on a non-midnight bound.
   */
  const window = sql`u.day >= ${range.startIso.slice(0, 10)}::date AND u.day < ${range.endIso.slice(0, 10)}::date`

  /*
   * BUDGET — attributed usage in BOTH lenses, the ONE axis whose lane does not
   * follow the toggle (`engine/budget-axis.ts`). It is routed FIRST so no reader
   * has to check whether the billed branch below might also claim it.
   */
  if (axis === 'project') {
    const budget = await fetchBudgetAxis(tx, clamp, range, lens)
    return {
      rows: budget.rows,
      headlineUsd: budget.headlineUsd,
      lane: 'attributed',
      unallocatedUsd: budget.unallocatedUsd,
      // This axis carries no chargeback: `providers` is empty and the gap names
      // no provider, so a reader who arrived through the chargeback toggle does
      // not take an attributed total for a cost of record.
      ...(lens === 'chargeback'
        ? {
            chargebackCoverage: {
              providers: [],
              gaps: [
                {
                  provider: null,
                  reason:
                    "No provider bills at project grain and this axis does not split the bill, so these rows are attributed usage, not a cost of record. A project's chargeback figure is on its project page.",
                },
              ],
            } satisfies ChargebackCoverage,
          }
        : {}),
    }
  }

  /*
   * THE BILLED LANE — every axis `provider_usage_fact` carries a column for,
   * split by provider so Copilot consumption can never be folded into a figure
   * labelled billed (mig 0120; engine/billed-axis.ts) — PLUS, at the two axes
   * that home it, the pooled Copilot invoice that fact table does not hold at
   * all (engine/pooled-chargeback-axis.ts).
   */
  if (lens === 'chargeback' && isBilledAxis(axis)) {
    const extraArms: BilledAxisArm[] = []
    const gaps: ChargebackGap[] = []

    if (!isPooledChargebackAxis(axis)) {
      // teammate / model — the pooled invoice has no such column and never will.
      // A stated gap, never an apportioned number. (`surface` IS answerable: the
      // view's `tool` is the bill's own chargeback lane — pooled-chargeback-axis.ts.)
      gaps.push(pooledAxisGap(axis, billing.offeredAxes ?? POOLED_CHARGEBACK_AXES))
    } else if (!billing.copilotChargeback) {
      gaps.push({
        provider: POOLED_CHARGEBACK_PROVIDER,
        reason:
          'The pooled Copilot chargeback is pending validation (Σ=bill on Dev), so it is not in this figure — this is Anthropic’s charge alone.',
      })
    } else if (!isMonthAlignedWindow(range)) {
      /*
       * The pooled invoice is MONTH-grained (`period_month`). Folding it over a
       * partial range would either charge a whole month's pool against a
       * fraction of the month or — when the range misses the month start — drop
       * it silently under a label claiming both providers. Both are worse than
       * saying which range would answer.
       */
      gaps.push({
        provider: POOLED_CHARGEBACK_PROVIDER,
        reason:
          'The Copilot charge is raised monthly and pooled per Business Unit, so it is not in this figure for a part-month range — select whole months to include it.',
      })
    } else if (!billing.financeScope) {
      gaps.push({
        provider: POOLED_CHARGEBACK_PROVIDER,
        reason:
          'The Copilot charge is not in this figure: this caller resolved no Business Unit scope for the bill lane.',
      })
    } else {
      extraArms.push(
        await fetchPooledChargebackArm(tx, scopeSql(billing.financeScope), range, axis),
      )
    }

    // NOT waved (request-floor-performance.md F5): the pooled arm above is an
    // ARGUMENT to this call — fetchBilledAxis folds, ranks and headlines
    // `extraArms` internally, so the two are a real dependency chain.
    const billed = await fetchBilledAxis(tx, clamp, range, axis, extraArms)

    /*
     * COVERAGE IS DATA AVAILABILITY, NOT ARM EXISTENCE.
     *
     * A provider belongs in `providers` because its charge is genuinely IN the
     * sum. An arm that reports `no-data-yet` has had nothing derived for this
     * window anywhere — `fetchBilledAxis` and `fetchPooledChargebackArm` both
     * answer that question UNCLAMPED for exactly this reason — so its $0 is not
     * a measurement and the claim "this figure is every provider that bills the
     * scope" is false while it is in the list.
     *
     * Applied to EVERY charge arm rather than only the pooled one: the Anthropic
     * arm is emitted unconditionally too (`KNOWN_PROVIDERS`), so a window the
     * Anthropic transform has not reached had exactly the same defect.
     */
    const chargeArms = billed.billedLane.arms.filter((a) => isChargeMeasure(a.measure))
    const derivedArms = chargeArms.filter((a) => a.availability !== 'no-data-yet')
    const derivedProviders = new Set(derivedArms.map((a) => a.provider))
    for (const provider of new Set(
      chargeArms.filter((a) => a.availability === 'no-data-yet').map((a) => a.provider),
    )) {
      // A provider contributing a SECOND charge arm that IS derived is covered;
      // only a provider with no derived charge arm at all is a gap.
      if (derivedProviders.has(provider)) continue
      gaps.push(notDerivedGap(provider))
    }

    return {
      rows: billed.rows,
      headlineUsd: billed.headlineUsd,
      lane: 'billed',
      billedLane: billed.billedLane,
      chargebackCoverage: { providers: [...derivedProviders], gaps },
    }
  }

  // 'teammate' (requirements 3/4): grouped by (teammate, tool, usage_provenance)
  // so ONE query yields the row total AND both breakdowns from the SAME rows
  // (foldDriverBreakdown) — a teammate/client/surface can never drift from the
  // headline. Replaces the old teammate-only aggregate query.
  if (axis === 'teammate') {
    const raws = await tx.execute<{
      key: string | null
      label: string | null
      tool: string | null
      provenance: string | null
      value: string
      drill_is_active: boolean | null
      drill_is_provisional: boolean | null
    }>(sql`
      SELECT u.teammate_id::text AS key, COALESCE(t.display_name, t.email) AS label,
             u.tool AS tool, u.usage_provenance AS provenance,
             COALESCE(SUM(u.cost_usd), 0)::text AS value,
             ${TEAMMATE_DRILL_FACTS_AGG}
      FROM usage_rollup_daily u JOIN teammate t ON t.id = u.teammate_id
      WHERE ${clamp} AND ${window}
      GROUP BY u.teammate_id, t.display_name, t.email, u.tool, u.usage_provenance`)
    /*
     * `is_active` and `provisional` ride the row for the DRILL CONTRACT
     * (developer pages D29/D34, r4-H2). They are the two conjuncts of
     * `teammateDrillAdmission` a client cannot infer: the row's own existence
     * proves the emit-time homing, but a DEACTIVATED subject — and, since r3-H2,
     * an UNCONFIRMED provisional shadow — still 403s at
     * `/reports/teammate/{id}`. Without them the name renders as a link that
     * cannot open, which is exactly the live-looking dead button the contract
     * bans.
     *
     * ── WHY THE ROW STAYS, RATHER THAN BEING FILTERED OUT ───────────────────
     * This axis is a DECOMPOSITION: `headlineUsd` is Σ of the returned rows and
     * the table foots to it, so the axis's own money must equal the §A total the
     * scope's KPI hero states. Dropping provisional subjects here would silently
     * shrink that total on ONE card while every other §A figure on the page kept
     * counting the same dollars — trading a dead link for a broken sum-back.
     * (The manager-facing project/budget figures take the opposite decision, and
     * correctly so: those are BUDGET figures with a budget denominator, and
     * `excludeProvisional` is reported back as `provisionalUsd` so the omission
     * is disclosed. Here there is no second figure to disclose it against.)
     *
     * So the money stays and the DOOR closes: the fact rides `dims`, and
     * `teammateDrillTarget` renders the row as plain text.
     */
    const factsByKey = foldTeammateDrillFacts(raws, (r) => r.key)
    const byKey = foldDriverBreakdown(raws)
    const entries = [...byKey.entries()].sort((a, b) => b[1].total - a[1].total)
    const headlineUsd = entries.reduce((a, [, agg]) => a + agg.total, 0)
    const rows: DriverRow[] = entries.map(([key, agg]) => {
      const usd = agg.total
      // A teammate whose ENTIRE usage sits on a GitHub USAGE lane (copilot /
      // copilot-agent — both draw the SAME pooled per-org allowance) is
      // pooled-usage (never a per-user charge); mixed/Claude usage is
      // indicative (build-design §5, docs/wiki/Reporting.md §5).
      const pooled = isPooledSurfaceOnly(agg.bySurface)
      return {
        key: key || `__null_${axis}`,
        label: agg.label ?? 'Unattributed',
        usd,
        sharePct: headlineUsd > 0 ? usd / headlineUsd : 0,
        spendClass: pooled ? 'pooled-usage' : 'indicative',
        indicativeReason: pooled ? undefined : 'usage-not-yet-billed',
        surfaceBreakdown: driverSurfaceBreakdown(agg.bySurface),
        provenanceBreakdown: driverProvenanceBreakdown(agg.byProvenance),
        ...(key
          ? { dims: teammateDrillDims(factsByKey.get(key) ?? NO_TEAMMATE_DRILL_FACTS) }
          : {}),
      }
    })
    return { rows, headlineUsd, lane: 'attributed' }
  }

  // 'surface' (requirement 2): the vendor-lane axis itself — grouped straight
  // by tool (+ usage_provenance, so a lane's OWN provenance mix is exposed too),
  // folded to registry lanes via toolToVendor (no hand-coded tool predicates).
  // Rows render in CANONICAL REGISTRY ORDER (never $-desc — a fixed composition,
  // like the provider split / lane legend), matching build-design's registry
  // rule ("Add a lane means updating the registry, never hand-editing a view").
  if (axis === 'surface') {
    const raws = await tx.execute<{
      key: string | null
      label: string | null
      tool: string | null
      provenance: string | null
      value: string
    }>(sql`
      SELECT NULL::text AS key, NULL::text AS label, u.tool AS tool, u.usage_provenance AS provenance,
             COALESCE(SUM(u.cost_usd), 0)::text AS value
      FROM usage_rollup_daily u
      WHERE ${clamp} AND ${window}
      GROUP BY u.tool, u.usage_provenance`)
    // Fold straight into ONE aggregate (key is irrelevant here — every row
    // belongs to the single in-scope surface breakdown).
    const folded = foldDriverBreakdown(raws).get('') ?? {
      label: null,
      total: 0,
      bySurface: new Map<Vendor, number>(),
      byProvenance: new Map<string, number>(),
    }
    const headlineUsd = folded.total
    const rows: DriverRow[] = [...folded.bySurface.entries()]
      .filter(([, usd]) => usd !== 0)
      .sort(([a], [b]) => VENDOR_LANES.indexOf(a) - VENDOR_LANES.indexOf(b))
      .map(([lane, usd]) => {
        const pooled = GITHUB_USAGE_LANE_IDS.includes(lane) && usd > 0
        // The lane's OWN provenance mix — a per-(lane) fold of the SAME raw rows.
        const byProvenance = new Map<string, number>()
        for (const r of raws) {
          if (toolToVendor(r.tool) !== lane || !r.provenance) continue
          byProvenance.set(r.provenance, (byProvenance.get(r.provenance) ?? 0) + Number(r.value))
        }
        return {
          key: lane,
          label: VENDOR_LABELS[lane],
          usd,
          sharePct: headlineUsd > 0 ? usd / headlineUsd : 0,
          spendClass: pooled ? 'pooled-usage' : 'indicative',
          indicativeReason: pooled ? undefined : 'usage-not-yet-billed',
          provenanceBreakdown: driverProvenanceBreakdown(byProvenance),
        }
      })
    return { rows, headlineUsd, lane: 'attributed' }
  }

  interface Raw extends Record<string, unknown> {
    key: string | null
    label: string | null
    value: string
    pooled: boolean
    /** Only populated on the 'model' axis (R1-M3) — see the model branch below. */
    provenance?: string | null
    /** Only populated on the 'model' axis (mig 0124, r1-H5): WHY a NULL-model
     *  row carries no model — see shared/reports/model-attribution.ts. */
    gap_reason?: string | null
  }
  let raws: Raw[]
  if (axis === 'region') {
    raws = [
      ...(await tx.execute<Raw>(sql`
        SELECT u.region_id::text AS key, r.display_name AS label,
               COALESCE(SUM(u.cost_usd), 0)::text AS value, FALSE AS pooled
        FROM usage_rollup_daily u LEFT JOIN region r ON r.id = u.region_id
        WHERE ${clamp} AND ${window}
        GROUP BY u.region_id, r.display_name
        ORDER BY SUM(u.cost_usd) DESC NULLS LAST`)),
    ]
  } else if (axis === 'model') {
    const grouped = [
      ...(await tx.execute<Raw>(sql`
        SELECT u.model AS key, u.model AS label, u.usage_provenance AS provenance,
               u.model_gap_reason AS gap_reason,
               COALESCE(SUM(u.cost_usd), 0)::text AS value, FALSE AS pooled
        FROM usage_rollup_daily u
        WHERE ${clamp} AND ${window}
        -- GROUP BY includes usage_provenance (R1-M3, mig 0101) AND
        -- model_gap_reason (mig 0124, r1-H5): after the fan-out, a NULL model
        -- is a REMAINDER whose reason ('provider-day-grain' Copilot money vs a
        -- transient 'awaiting-provider-detail' vs model-less provider cost)
        -- provenance alone cannot tell apart — and the Top-models coverage
        -- footer prices each reason separately. Grouping by the triple keeps
        -- distinct reasons in SEPARATE rows so
        -- shared/reports/model-attribution.ts can key/label them distinctly.
        GROUP BY u.model, u.usage_provenance, u.model_gap_reason
        ORDER BY SUM(u.cost_usd) DESC NULLS LAST`)),
    ]
    /*
     * FOLD BY DRIVER KEY (mig 0124 + D9 pairing). Before the fan-out a named
     * model only ever arrived on ONE provenance (arm 1); now the same id can
     * arrive as OTel (arm 1), an arm-2 child AND an arm-3 fan-out row — and a
     * per-provenance GROUP BY would DOUBLE-LIST its bar. The key computed by
     * the shared helper is the fold identity: named models merge across
     * provenances (their mix preserved in provenanceBreakdown), while
     * remainder keys are provenance+reason-scoped and never collide.
     */
    const byKey = new Map<string, Raw & { provMap: Map<string, number> }>()
    for (const r of grouped) {
      const key = modelDriverKey(r.key, r.provenance, r.gap_reason)
      const usd = Number(r.value)
      const cur = byKey.get(key)
      if (cur) {
        cur.value = String(Number(cur.value) + usd)
        if (r.provenance) cur.provMap.set(r.provenance, (cur.provMap.get(r.provenance) ?? 0) + usd)
      } else {
        byKey.set(key, {
          ...r,
          provMap: new Map(r.provenance ? [[r.provenance, usd]] : []),
        })
      }
    }
    raws = [...byKey.values()].sort((a, b) => Number(b.value) - Number(a.value))
  } else {
    // practice — the nearest cost-owning ancestor of each record's emit-home unit.
    raws = [
      ...(await tx.execute<Raw>(sql`
        SELECT cou.cost_owning_unit_id::text AS key, cou.cost_owning_unit_name AS label, COALESCE(SUM(u.cost_usd), 0)::text AS value, FALSE AS pooled
        FROM usage_rollup_daily u
        -- ONE cost-owner resolution (v_org_unit_cost_owner, mig 0114), not a
        -- correlated LATERAL per usage row. LEFT, so unhomed spend keeps its row.
        LEFT JOIN v_org_unit_cost_owner cou ON cou.org_unit_id = u.org_unit_id
        WHERE ${clamp} AND ${window}
        GROUP BY cou.cost_owning_unit_id, cou.cost_owning_unit_name
        ORDER BY SUM(u.cost_usd) DESC NULLS LAST`)),
    ]
  }

  const headlineUsd = raws.reduce((a, r) => a + Number(r.value), 0)
  // One vocabulary (consistency contract §6.6). The project axis is not here —
  // it returns above through `engine/budget-axis.ts`, which owns the UNTAGGED /
  // unallocated vocabulary for both lenses in one place.
  const nullLabel = axis === 'region' ? 'Unassigned' : 'Unattributed'
  const rows: DriverRow[] = raws.map((r) => {
    const usd = Number(r.value)
    return {
      // model axis (R1-M3 + mig 0124): route the NULL-model remainder through
      // the shared helper so its key/label are reason-typed and distinct
      // reasons never collapse onto one row. The reason itself rides the row
      // (`gap_reason`) — the coverage footer's operand (D6).
      key: axis === 'model' ? modelDriverKey(r.key, r.provenance, r.gap_reason) : (r.key ?? `__null_${axis}`),
      label: axis === 'model' ? modelDriverLabel(r.key, r.provenance, r.gap_reason) : (r.label ?? nullLabel),
      usd,
      sharePct: headlineUsd > 0 ? usd / headlineUsd : 0,
      spendClass: r.pooled ? 'pooled-usage' : 'indicative',
      indicativeReason: r.pooled ? undefined : 'usage-not-yet-billed',
      ...(axis === 'model' && r.gap_reason ? { gap_reason: r.gap_reason } : {}),
      // The fold above merged same-key rows across provenances; the row's
      // provenance MIX rides the breakdown (Σ = usd by construction).
      ...(axis === 'model' && (r as Raw & { provMap?: Map<string, number> }).provMap?.size
        ? {
            provenanceBreakdown: driverProvenanceBreakdown(
              (r as Raw & { provMap: Map<string, number> }).provMap,
            ),
          }
        : {}),
    }
  })
  return { rows, headlineUsd, lane: 'attributed' }
}
