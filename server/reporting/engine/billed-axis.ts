/*
 * Ranked drivers read from the BILLED lane — the chargeback lane's answer to
 * every axis `provider_usage_fact` carries a column for.
 *
 * docs/design/target-state-data-architecture.md §2 and §6 are the spec, and
 * docs/design/reporting-consolidation/04-prototype-delta.md §9 is the correction
 * this file exists to honour. Read both before changing anything here.
 *
 * ── WHAT THIS FIXES ──────────────────────────────────────────────────────────
 *
 * The reporting shell has a lane toggle. Selecting *Chargeback · billed*
 * re-lensed the KPI hero and the §B cards and left Top drivers alone, so the
 * headline changed and ATTRIBUTED rows stayed underneath it — two lanes
 * rendering as one screen, with nothing on the page saying which was which.
 * This is the drivers half of that toggle.
 *
 * It also closes the model gap the same way. 58% of Dev spend rendered as "not
 * split by model", which was never a collection failure: BOTH providers send a
 * model on every row. It was a SHAPING gap — the model axis was built from
 * `v_complete_usage`, whose model column comes from OTel (~5% of the estate),
 * while the provider API carries the dimension for 100% of what it bills. So
 * the axis reads `provider_usage_fact` instead. There is NO join to OTel, no
 * coverage ratio and no model-name normalisation, because OTel's model and the
 * API's model never meet.
 *
 * ── THE RULE THIS FILE IS ACCOUNTABLE FOR: DISCRIMINATE BEFORE SUMMING ───────
 *
 * `provider_usage_fact` holds TWO KINDS OF MONEY and mig 0120 says so on the
 * table itself: `anthropic` rows carry what the provider CHARGED, `github` rows
 * carry gross AI-credit CONSUMPTION before the pooled allowance. A single
 * `SUM(cost_usd)` over the table adds billed dollars to consumption dollars and
 * labels the result billed — 0120: "not a figure anyone is owed".
 *
 * So every figure this module produces is per-ARM (a {@link BilledAxisArm}
 * each), and the only cross-arm total it publishes is `billedUsd`, which sums
 * the CHARGE arms alone (`isChargeMeasure`). The consumption total is a SEPARATE
 * field. There is no field on the contract that holds both, which is what makes
 * the defect unspellable rather than merely discouraged. `shared/reports/
 * provider-measure.ts` is the single authority for which arm is which, and
 * `fetchTierExposure` applies the same discipline to the same table.
 *
 * ── AND `provider_usage_fact` IS NOT THE WHOLE CHARGEBACK LANE ───────────────
 *
 * It holds no Copilot CHARGE at all — the `github` arm here is a meter reading.
 * Copilot's chargeback is the pooled net invoice in
 * `v_finance_copilot_pool_chargeback`, which this module must never name
 * (`reports-billed-lane-contract.test.ts` asserts that statically, so a ratio
 * across the two relations cannot be built in one query here). It arrives as an
 * `extraArms` entry from `engine/drivers.ts`, which composes the two sources;
 * `engine/pooled-chargeback-axis.ts` holds that query and the reasoning for the
 * axes it can and cannot answer.
 *
 * ── NO RATIO. ANYWHERE. ─────────────────────────────────────────────────────
 *
 * Every number here is a `GROUP BY` over one relation. Nothing divides money by
 * a share, nothing scales one lane's amount by another lane's coverage, and
 * nothing splits a day's money across a dimension the provider did not report
 * it at. That is the apportionment target-state-data-architecture.md §5 deleted
 * (`f = min(1, T_otel/T_api)`, shares of `f·C`, largest-remainder rounding), and
 * it must not return: a ratio-derived cell is indistinguishable at read time
 * from a figure the provider sent, which is exactly what makes it dangerous —
 * it renders in an axis, foots to the right total, and is wrong in every cell.
 *
 * `tests/integration/reports/billed-drivers.test.ts` pins this BEHAVIOURALLY,
 * not by grep: every billed figure is invariant under an arbitrary change to
 * the attributed lane. A coverage factor, a share split or an in-memory
 * two-query fold all go red on it; the static lane-firewall test cannot see any
 * of them.
 *
 * ── ONE CLAMP, TWO RELATIONS, AND WHY THAT IS SOUND ──────────────────────────
 *
 * Callers pass the SAME scope predicate the attributed axes use, aliased `u`
 * over `(u.region_id, u.org_unit_id)`. That is not a shortcut: the billed lane
 * carries those columns with the SAME meaning as the usage lane — historical
 * homing, stamped at INSERT from the teammate's placement and never refreshed
 * (mig 0118:60-79). The scope resolves through the fact table's OWN homing,
 * never by joining back to a teammate's current placement, so a reorg cannot
 * restate a historical month.
 *
 * Reusing the USAGE clamp (rather than a §B `cost_owning_unit_id` one) is also
 * what makes the toggle honest: both lanes answer for the same population of
 * rows, so a reader flipping the toggle sees the same scope measured two ways
 * rather than two scopes.
 *
 * A row with no resolved teammate homes NOWHERE (all three columns NULL), so it
 * is in the whole-company figure and in no region or cost centre. The design
 * states the consequence rather than hiding it: Σ(cost-centre totals) < org
 * total by exactly the unresolved amount.
 *
 * ── TOKEN ROWS AND COST ROWS ─────────────────────────────────────────────────
 *
 * A `cost_type IS NULL` row carries the token lanes and NO cost; a non-NULL
 * `cost_type` row carries `cost_usd` and NO tokens (0118's `measure_chk`). The
 * NULLs are disjoint, so `SUM(cost_usd) GROUP BY <dimension>` is correct with no
 * filter — token rows contribute NULL and are ignored. Nothing multiplies, and
 * no merged view is needed.
 *
 * NEVER a §A usage figure, never `attribution_record` / `attribution_aggregate` /
 * raw `actual_spend` (the lane firewall, build-design §7(7)).
 */
import { sql, type SQL } from 'drizzle-orm'
import type { PostgresJsDatabase } from 'drizzle-orm/postgres-js'
import { toolToVendor, VENDOR_LANES, VENDOR_LABELS, type Vendor } from '../../../shared/usage/vendor'
import {
  BILLED_NO_MODEL_KEY,
  BILLED_NO_MODEL_LABEL,
} from '../../../shared/reports/model-attribution'
import {
  isChargeMeasure,
  providerMeasure,
  spendClassForMeasure,
  type ArmMeasure,
} from '../../../shared/reports/provider-measure'
import type {
  BilledAxisArm,
  BilledLaneAvailability,
  BilledLaneMeta,
  DriverRow,
} from '../../../shared/reports/types'
import type { UsageWindow } from '../params'

type Tx = PostgresJsDatabase<Record<string, unknown>>

/**
 * The axes the billed lane can answer, which is exactly the set
 * `provider_usage_fact` carries a column for (mig 0118:54-79).
 *
 * `project` is DELIBERATELY ABSENT: the table has no project column. The bill
 * split by tagged share is `v_finance_project_overlay`, served on the project
 * page (docs/design/project-chargeback-lens.md). The budget axis stays on the
 * attributed lane in BOTH lanes and says so through `MeasureLanes` — see
 * `engine/budget-axis.ts`.
 */
export const BILLED_AXES = ['region', 'practice', 'teammate', 'model', 'surface'] as const
export type BilledAxis = (typeof BILLED_AXES)[number]

export function isBilledAxis(axis: string): axis is BilledAxis {
  return (BILLED_AXES as readonly string[]).includes(axis)
}

/**
 * The providers an arm is ALWAYS emitted for, so an unwritten adapter is stated
 * rather than absent — the same list, for the same reason, as
 * `engine/tier-exposure.ts`'s. A provider with no rows anywhere reports
 * `no-data-yet`, which a card must render differently from a genuine zero.
 */
const KNOWN_PROVIDERS = ['anthropic', 'github'] as const

export interface BilledAxisResult {
  /**
   * The CHARGE arms' rows (`isChargeMeasure` — `'billed'` plus any
   * `'pooled-chargeback'` arm the caller folded in), summed on key and
   * re-ranked. Σ === `headlineUsd` exactly. Consumption rows are NOT here; they
   * live on their own arm inside {@link billedLane}.
   */
  rows: DriverRow[]
  /** Σ `rows` — the chargeback denominator. Never includes a consumption arm. */
  headlineUsd: number
  billedLane: BilledLaneMeta
}

/**
 * The billed lane is DATE-grained; the reporting window is a pair of ISO
 * instants. Windows are always UTC-day aligned (`resolveReportWindow`), so the
 * date half of the instant is the day — the same slice `engine/kpis.ts` takes
 * for the day-grained bill views. Taken as a string rather than cast in SQL on
 * purpose: `timestamptz::date` resolves in the SESSION time zone, which would
 * silently move a day boundary under a non-UTC connection.
 */
function windowDates(range: UsageWindow): { startDate: string; endDate: string } {
  return { startDate: range.startIso.slice(0, 10), endDate: range.endIso.slice(0, 10) }
}

/** One `(provider, dimension)` aggregate of the billed lane. */
interface BilledGrainRow extends Record<string, unknown> {
  provider: string
  /** The dimension's raw key — NULL is a real bucket, never a filter. */
  key: string | null
  /** The dimension's display name, when it comes from a joined relation. */
  label: string | null
  /** Σ `cost_usd` (numeric, so it crosses the wire as text). */
  value: string
  /** Rows carrying a cost — 0 means this grain is token-only, not $0 of money. */
  cost_rows: string
}

/**
 * The per-axis SELECT: how the dimension is keyed, named and grouped, plus the
 * relation that supplies its display name.
 *
 * LEFT JOIN, ALWAYS. An inner join would silently drop the exact rows the design
 * promises to carry: a `provider_usage_fact` row with an unresolved actor has a
 * NULL `teammate_id` and no homing at all, and it is money. The NULL bucket is a
 * ROW, which is what makes the sum-back hold (build-design §7(4)).
 */
function axisSelect(axis: BilledAxis): { key: SQL; label: SQL; join: SQL; groupBy: SQL } {
  switch (axis) {
    case 'region':
      return {
        key: sql`u.region_id::text`,
        label: sql`r.display_name`,
        join: sql`LEFT JOIN region r ON r.id = u.region_id`,
        groupBy: sql`u.region_id, r.display_name`,
      }
    case 'practice':
      /*
       * The billed lane stamps `cost_owning_unit_id` AT INGEST (0118:61-79), so
       * this axis reads it directly rather than re-deriving the cost owner from
       * `org_unit_id` through `v_org_unit_cost_owner` the way the attributed
       * axis must. That is not a divergence: the ingest stamp IS that
       * resolution, taken at the time the money was spent, which is the answer a
       * historical month wants. Re-deriving it now would restate a closed month
       * whenever the org tree moves.
       */
      return {
        key: sql`u.cost_owning_unit_id::text`,
        label: sql`cou.display_name`,
        join: sql`LEFT JOIN org_unit cou ON cou.id = u.cost_owning_unit_id`,
        groupBy: sql`u.cost_owning_unit_id, cou.display_name`,
      }
    case 'teammate':
      return {
        key: sql`u.teammate_id::text`,
        label: sql`COALESCE(t.display_name, t.email)`,
        join: sql`LEFT JOIN teammate t ON t.id = u.teammate_id`,
        groupBy: sql`u.teammate_id, t.display_name, t.email`,
      }
    case 'model':
      return {
        key: sql`u.model`,
        label: sql`u.model`,
        join: sql``,
        groupBy: sql`u.model`,
      }
    case 'surface':
      // Keyed on the raw tool and folded to registry LANES in TypeScript, exactly
      // as the attributed surface axis does — `toolToVendor` is the registry, and
      // a hand-written SQL CASE over tool names is a second copy of it.
      return {
        key: sql`u.tool`,
        label: sql`u.tool`,
        join: sql``,
        groupBy: sql`u.tool`,
      }
  }
}

/** The NULL bucket's label per axis — a named row, never a dropped one. */
function nullLabelFor(axis: BilledAxis): string {
  switch (axis) {
    case 'region':
      return 'Unassigned'
    case 'practice':
      return 'No Business Unit resolved'
    case 'teammate':
      // The provider billed this and we cannot yet say who for. It is NOT
      // "Unattributed" in the model sense and NOT an untagged budget: it is an
      // identity we have not resolved, and mig 0118 carries it on purpose so the
      // org total still matches the invoice.
      return 'Not yet attributed to a person'
    case 'model':
      return BILLED_NO_MODEL_LABEL
    case 'surface':
      return VENDOR_LABELS.other
  }
}

/** The NULL bucket's stable row key per axis. */
function nullKeyFor(axis: BilledAxis): string {
  return axis === 'model' ? BILLED_NO_MODEL_KEY : `__null_${axis}`
}

/**
 * Ranked billed-lane drivers for one axis over one scope and window, split by
 * provider.
 *
 * `clamp` is a boolean SQL fragment over the alias `u`, addressing the homing
 * columns both lanes share (`u.region_id` / `u.org_unit_id`). `scopeSql(scope)`
 * produces exactly that, and `TRUE` for whole-company.
 */
export async function fetchBilledAxis(
  tx: Tx,
  clamp: SQL,
  range: UsageWindow,
  axis: BilledAxis,
  /*
   * Arms this module cannot produce, folded in by the CALLER.
   *
   * The chargeback lane has a second source — the POOLED Copilot invoice
   * (`engine/pooled-chargeback-axis.ts`) — which this module must never name:
   * `tests/unit/server/reports-billed-lane-contract.test.ts` asserts statically
   * that this file reads `provider_usage_fact` and no `v_finance_*` relation, so
   * that a coverage ratio across two relations cannot be built INSIDE one query
   * here. Composition happens in `engine/drivers.ts`; the fold, the ranking and
   * the availability roll-up stay here so there is exactly one of each.
   */
  extraArms: readonly BilledAxisArm[] = [],
): Promise<BilledAxisResult> {
  const { startDate, endDate } = windowDates(range)
  const { key, label, join, groupBy } = axisSelect(axis)

  /*
   * ONE scan, at (provider, dimension) grain. `cost_rows` is what makes "not
   * counted" distinguishable from "zero": `COALESCE(SUM(cost_usd), 0)` over a
   * set containing only TOKEN rows returns 0, and a $0 driver row is noise in a
   * money ranking, not information.
   */
  const grain = await tx.execute<BilledGrainRow>(sql`
    SELECT u.provider                                     AS provider,
           ${key}                                         AS key,
           ${label}                                       AS label,
           COALESCE(SUM(u.cost_usd), 0)::text             AS value,
           COUNT(*) FILTER (WHERE u.cost_usd IS NOT NULL)::text AS cost_rows
    FROM provider_usage_fact u
    ${join}
    WHERE ${clamp}
      AND u.date >= ${startDate}::date
      AND u.date <  ${endDate}::date
    GROUP BY u.provider, ${groupBy}`)

  /*
   * HAS THIS PROVIDER'S ADAPTER WRITTEN ANYTHING IN THIS WINDOW? Deliberately
   * UNCLAMPED, because that is exactly the question: "no rows in this scope" is
   * a genuine zero, while "no rows in this window anywhere" means the transform
   * has not reached it. Conflating the two is what makes an operator chase a
   * spend anomaly that is really a missing adapter run.
   *
   * It yields BOOLEANS, never counts or amounts: the caller learns something
   * about our own derivation pipeline and nothing about another scope's money.
   */
  const derived = await tx.execute<{ provider: string; present: boolean }>(sql`
    SELECT provider, TRUE AS present
    FROM provider_usage_fact
    WHERE cost_usd IS NOT NULL
      AND date >= ${startDate}::date
      AND date <  ${endDate}::date
    GROUP BY provider`)
  const derivedInWindow = new Set<string>([...derived].map((d) => d.provider))

  const providers = new Set<string>([...KNOWN_PROVIDERS, ...[...grain].map((r) => r.provider)])
  const arms: BilledAxisArm[] = []
  for (const provider of providers) {
    const measure = providerMeasure(provider)
    const mine = [...grain].filter((r) => r.provider === provider)
    const inScopeCostRows = mine.reduce((a, r) => a + Number(r.cost_rows), 0)

    const availability: BilledLaneAvailability =
      inScopeCostRows > 0 ? 'present' : derivedInWindow.has(provider) ? 'none-in-scope' : 'no-data-yet'

    const rows = rankRows(mine, axis, measure)
    arms.push({
      id: `${provider}:${measure}`,
      provider,
      measure,
      source: 'provider_usage_fact',
      availability,
      totalUsd: rows.reduce((a, r) => a + r.usd, 0),
      rows,
    })
  }
  arms.push(...extraArms)

  // Known providers first, in their declared order, so the arm order is stable
  // whatever order the scan returned rows in. Within one provider the CHARGE arm
  // leads its consumption arm — the charge is the answer, the meter reading is
  // the caveat beside it.
  const rank = (p: string) => {
    const i = (KNOWN_PROVIDERS as readonly string[]).indexOf(p)
    return i === -1 ? KNOWN_PROVIDERS.length : i
  }
  arms.sort(
    (a, b) =>
      rank(a.provider) - rank(b.provider) ||
      a.provider.localeCompare(b.provider) ||
      Number(isChargeMeasure(b.measure)) - Number(isChargeMeasure(a.measure)),
  )

  /*
   * The headline folds the CHARGE arms only, on key, and re-ranks. Two providers
   * charging for the same cost centre are one row of chargeback money — an
   * Anthropic per-teammate charge and a pooled Copilot invoice line are both
   * money owed, differing in grain rather than in kind (`isChargeMeasure`; the
   * arm's `source` says which relation each came from). A CONSUMPTION arm is
   * never a term in this sum. `billedUsd` is derived from the same fold rather
   * than summed separately, so the table and its own denominator cannot
   * disagree.
   */
  const billedArms = arms.filter((a) => isChargeMeasure(a.measure))
  const rows = foldArms(billedArms, axis)
  const headlineUsd = rows.reduce((a, r) => a + r.usd, 0)
  for (const r of rows) r.sharePct = headlineUsd > 0 ? r.usd / headlineUsd : 0

  return {
    rows,
    headlineUsd,
    billedLane: {
      availability: rollUpAvailability(arms),
      billedUsd: headlineUsd,
      consumptionUsd: arms
        .filter((a) => a.measure === 'consumption')
        .reduce((a, arm) => a + arm.totalUsd, 0),
      arms,
    },
  }
}

/**
 * The lane's state across arms. `present` wins because one arm having money in
 * scope makes the card's figures real; `no-data-yet` is reserved for the case
 * where NOTHING has been derived for this window, which is the state a fresh
 * environment is in and the only one that must never render as "$0 spent".
 */
function rollUpAvailability(arms: readonly BilledAxisArm[]): BilledLaneAvailability {
  if (arms.some((a) => a.availability === 'present')) return 'present'
  if (arms.some((a) => a.availability === 'none-in-scope')) return 'none-in-scope'
  return 'no-data-yet'
}

/** Rank one provider's grain rows into driver rows. */
function rankRows(
  grain: readonly BilledGrainRow[],
  axis: BilledAxis,
  measure: ArmMeasure,
): DriverRow[] {
  const byKey = new Map<string, { label: string; usd: number }>()
  for (const r of grain) {
    /*
     * The surface axis folds raw tools to REGISTRY lanes here rather than in
     * SQL. `toolToVendor` is the registry; a CASE expression over tool names in
     * the query would be a second copy that drifts the first time a lane is
     * added.
     */
    const rawKey = axis === 'surface' ? toolToVendor(r.key) : r.key
    const k = rawKey ?? nullKeyFor(axis)
    const displayLabel =
      axis === 'surface'
        ? VENDOR_LABELS[k as Vendor]
        : (r.label ?? (r.key ? r.key : nullLabelFor(axis)))
    const acc = byKey.get(k) ?? { label: displayLabel, usd: 0 }
    acc.usd += Number(r.value)
    byKey.set(k, acc)
  }

  /*
   * A grain summing to exactly $0 is dropped: it is a token-only grain (usage
   * rows carry tokens and no cost), and a $0.00 row in a money ranking is noise,
   * not information. It cannot affect the sum-back — it contributes zero to both
   * sides.
   */
  const entries = [...byKey.entries()].filter(([, v]) => v.usd !== 0)
  const total = entries.reduce((a, [, v]) => a + v.usd, 0)

  const ordered =
    axis === 'surface'
      ? // A fixed composition, like the provider split and the lane legend:
        // registry order, never $-desc (build-design's registry rule).
        entries.sort(
          ([a], [b]) => VENDOR_LANES.indexOf(a as Vendor) - VENDOR_LANES.indexOf(b as Vendor),
        )
      : entries.sort((a, b) => b[1].usd - a[1].usd)

  return ordered.map(([key, v]) => ({
    key,
    label: v.label,
    usd: v.usd,
    sharePct: total > 0 ? v.usd / total : 0,
    /*
     * THE CLASS IS THE MEASURE, not the lane. A charge arm's row is the
     * provider's own money and renders as a hard dollar — muting it under
     * "informational — not a charge" would state the exact opposite of what it
     * is, and is why the 'billed' class was added rather than these rows being
     * repointed under 'indicative'.
     *
     * A CONSUMPTION arm's row is not a charge and must never render as one.
     * 'pooled-usage' already carries precisely that meaning ("informational
     * only, billing is POOLED per cost-centre — NEVER a per-user charge"), so it
     * is reused rather than a fourth class invented to say the same thing.
     *
     * The mapping itself lives in `shared/reports/provider-measure.ts` so this
     * ranking and the CSV export's serialiser cannot disagree about whether the
     * same money is a charge.
     */
    spendClass: spendClassForMeasure(measure),
  }))
}

/**
 * Fold several billed arms' rows onto one ranked list, summing on key.
 *
 * The ORDER is the axis's own, not "whatever the fold produced": the surface
 * axis renders in registry order at every scope and lane, and re-sorting it by
 * money here would make the folded list disagree with each arm's list beside it.
 */
function foldArms(arms: readonly BilledAxisArm[], axis: BilledAxis): DriverRow[] {
  const byKey = new Map<string, DriverRow>()
  for (const arm of arms) {
    for (const r of arm.rows) {
      const hit = byKey.get(r.key)
      if (hit) hit.usd += r.usd
      else byKey.set(r.key, { ...r })
    }
  }
  const out = [...byKey.values()]
  return axis === 'surface'
    ? out.sort((a, b) => VENDOR_LANES.indexOf(a.key as Vendor) - VENDOR_LANES.indexOf(b.key as Vendor))
    : out.sort((a, b) => b.usd - a.usd)
}
