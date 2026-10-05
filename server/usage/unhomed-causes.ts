/*
 * unhomed-causes — WHY chargeable (§B) spend reaches no cost-owning unit.
 *
 * The §A/§B card already states the unhomed TOTAL and its consequence ("it
 * disappears from every per-cost-centre view"). It states no cause, so an
 * operator can see that 63% of a month is unhomed and still not choose between
 * four completely different remediations, size any of them, or tell whether it
 * is one person or four hundred. This module is the cause split, the worklist
 * behind it, and the two counters that say whether automatic placement was ever
 * configured to succeed.
 *
 * READ-ONLY. No write path, no remediation action, no change to placement
 * itself. It exists to make a decision, not to be a dashboard.
 *
 * ── ONE DEFINITION, TWO STATEMENTS ─────────────────────────────────────────
 * `unhomedByMonthSql` is the ONLY expression in the codebase that says what
 * "unhomed chargeable spend" is. `computeAbDecomposition`'s
 * `diagnostics.unhomedChargeUsd` — the figure the card's unhomed line renders —
 * reads it, this probe's authoritative total reads it, and the month history
 * reads it. One definition, so the split cannot decompose a quantity defined
 * differently from the one it is shown under: the split needs teammate grain,
 * which `v_finance_chargeback_month` GROUP BYs away, so the obvious shape is to
 * recompute the total one level down — and then the total and its split drift
 * apart silently. Instead the month-view expression is carried VERBATIM into
 * the same statement as the buckets, and the difference is emitted as an
 * explicit residual.
 *
 * ONE DEFINITION IS NOT ONE STATEMENT, and this header used to claim "there is
 * deliberately no second query that could disagree". There is one: the card's
 * headline is computed by ab-decomposition.ts's §B block and this probe's total
 * by the statement below. Both evaluate the same expression, but under READ
 * COMMITTED each takes its own snapshot, so a placement committed between them
 * homes money for one read and not the other — and the residual, computed INSIDE
 * the statement below, cannot see that. The panel says so rather than promising
 * an agreement nothing enforces.
 *
 * The two are NOT merged, and the reason is CONTAINMENT rather than laziness.
 * This split is an independently-fallible sub-probe: its statement joins tables
 * the decomposition never touches (provider_org, provider_enterprise), so when
 * one of them cannot be read the card must lose the split ALONE and keep the
 * decomposition — including the unhomed figure the split decomposes. One
 * statement for both would put §B's fate in the split's hands, and
 * tests/integration/admin/ab-decomposition-route.test.ts pins that it does not.
 *
 * What each statement DOES guarantee is what its own consumers rely on: §B and
 * its unhomed slice are atomic, which is what makes "the unhomed figure is inside
 * the §B total above" true; and the total, the buckets, the residual, the drill
 * and the trend's money are atomic here, which is what makes the residual mean
 * anything at all.
 *
 * ── WHAT THE RESIDUAL DOES AND DOES NOT PROVE ──────────────────────────────
 * The residual is `total − Σ(buckets)`. Zero means the buckets SUM to the total.
 * It is one equation over signed sums, so what it detects is a NET discrepancy —
 * and that is strictly weaker than "nothing is missing and nothing is doubled":
 * a dollar dropped from one bucket and a dollar counted twice in another cancel
 * exactly, and this figure stays at zero. It also does NOT prove a dollar is in
 * the RIGHT bucket: moving a teammate between two holding nodes moves dollars
 * between `no-region` and `region-no-unit` and the residual stays exactly zero,
 * because moving money between terms cannot change a sum. That is this card's
 * own established finding (see ab-decomposition.ts's ABSORPTION SWEEP: four
 * review rounds each found a term absorbing a phenomenon instead of naming one,
 * with the residual at zero throughout). The panel copy says all of this in as
 * many words — a governance surface must not present a zero residual as proof
 * the split is right.
 *
 * ── THERE IS NO FIFTH BUCKET, BUT THE THIRD ONE IS A REMAINDER ─────────────
 * Stated plainly because an earlier version of this header claimed otherwise
 * and the claim was false.
 *
 * Over the per-teammate arm the three placement causes are STRUCTURALLY
 * EXHAUSTIVE: `teammate.org_unit_id` is NOT NULL, `org_unit.region_id` is NOT
 * NULL, and the chargeback view INNER JOINs teammate, so every unhomed row has
 * exactly one home node — which is either in the system-wide holding region, or
 * a holding node in a real region, or neither. `no-cost-owning-ancestor` is the
 * "or neither", i.e. the REMAINDER of that arm. Its `NOT EXISTS` is not an
 * independent partition (the arm only admits rows the view already resolved to
 * NO active cost-owning ancestor, so the sub-query cannot be false today) — it
 * is a MIRROR of `v_finance_bill_chargeback`'s LATERAL, kept so that if the
 * view's ancestor rule ever changes without this one, the row falls out of
 * every bucket and into the residual instead of being silently reclassified.
 * Replacing the whole sub-query with TRUE is therefore an EQUIVALENT MUTANT
 * today; dropping only its `retired_at IS NULL` is not, and the suite kills it.
 *
 * What the residual actually guards is CHANGE:
 *   - a THIRD arm added to `v_finance_chargeback_month` (a second pooled
 *     provider, say) — its money would be in the total and in no bucket, and
 *     the whole panel would suppress itself until the split is extended. That
 *     is the designed behaviour, and it is why the fourth bucket is named
 *     `pooled-copilot` rather than for a general case it does not cover;
 *   - the pooled bucket's mirror of migration 0107's fallback/allocation split
 *     drifting from the view it mirrors;
 *   - the ancestor mirror above drifting from the view's LATERAL;
 *   - a window whose two grains disagree (day-grained `period_date` vs
 *     month-grained `period_month`), which is why the endpoint accepts only
 *     month-aligned windows.
 * All four are real, and all four show up here rather than as four plausible
 * numbers that quietly do not add up.
 *
 * ── PORTABILITY, AND WHERE IT STOPS ────────────────────────────────────────
 * The three PLACEMENT buckets are tenant- and provider-neutral: no region name,
 * no tree depth, no tenant vocabulary. They derive from holding-node /
 * cost-owning-flag semantics (shared/placement/holding-nodes.ts) and walk the
 * ltree ancestry at ANY depth; the firewall list comes from the shared provider
 * registry.
 *
 * THE POOLED BUCKET IS NOT. It reads `copilot_pool_bill` and
 * `copilot_overage_allocation` by name and mirrors migration 0107's
 * GitHub-specific fallback/allocation rule. A second pooled provider is not
 * covered and would not be silently mis-bucketed either: its money would reach
 * the total, no bucket would claim it, and the residual would suppress the
 * split. The bucket is therefore called `pooled-copilot`, and the panel says so
 * on screen — an earlier `pooled-provider` promised a generality this code has
 * never had.
 */
import type { PostgresJsDatabase } from 'drizzle-orm/postgres-js'
import { sql, type SQL } from 'drizzle-orm'
import { GITHUB_FIREWALL_EXCLUSIONS, COPILOT_UNCLASSIFIED_LANE } from '../../shared/usage/github-surface'
import {
  UNASSIGNED_REGION_CODE,
  HOLDING_UNIT_TYPE,
} from '../../shared/placement/holding-nodes'
import { getReportingSnapshot } from '../governance/reporting-snapshot'
import { UNHOMED_CAUSES, type UnhomedCause } from '../../shared/usage/unhomed-causes'

export { UNHOMED_CAUSES } from '../../shared/usage/unhomed-causes'
export type { UnhomedCause } from '../../shared/usage/unhomed-causes'

/*
 * Deliberately NOT PostgresJsDatabase<typeof schema> — same reasoning as
 * ab-decomposition.ts: this module only ever calls db.execute() with raw SQL,
 * and withRequestRls hands back a differently-parameterised handle. Pinning the
 * generic would force a cast at every call site, and a cast at the call site is
 * how a non-RLS handle gets passed in by accident.
 *
 * `transaction` is here for `fallible()` below, not for writing anything: this
 * module has no write path. Its callback handle is declared `unknown` on
 * purpose — drizzle parameterises a transaction on the SCHEMA, so pinning it
 * would refuse every real handle (`typeof schema`) at every call site, which is
 * the cast-at-the-call-site problem this type exists to avoid.
 */
type Db = Pick<PostgresJsDatabase<Record<string, never>>, 'execute'> & {
  transaction: <T>(fn: (tx: unknown) => Promise<T>) => Promise<T>
}

/**
 * Run an INDEPENDENTLY-FALLIBLE sub-read: `null` on failure, and — the part a
 * bare try/catch cannot do — the caller's transaction still usable afterwards.
 *
 * Every caller of this module runs inside `withRequestRls`'s transaction, and in
 * PostgreSQL a failed statement ABORTS the transaction: every subsequent command
 * returns "current transaction is aborted" until it ends. So `try { … } catch {
 * return null }` around a query reads like a contained failure and is not one —
 * the catch swallows the error, the next read fails, and the endpoint 500s
 * anyway. That was true of all four of this module's null paths and of the
 * route's own "no reading" wrapper, and nothing tested it.
 *
 * A nested `transaction()` on an open transaction is a SAVEPOINT: drizzle emits
 * ROLLBACK TO SAVEPOINT on the way out, which un-aborts the enclosing
 * transaction. Called with a plain (non-transaction) handle — as the tests do —
 * it opens a real transaction instead, which is equally correct here because
 * every statement in this module is a read.
 */
async function fallible<T>(db: Db, fn: (db: Db) => Promise<T>): Promise<T | null> {
  try {
    return await db.transaction(async (sp) => fn(sp as Db))
  } catch {
    return null
  }
}

const NUMERIC_ZERO = '0.000000'

/** How many worklist rows are returned per cause. The panel MUST disclose it. */
export const UNHOMED_WORKLIST_CAP = 20

/** How many complete months the history carries. */
export const UNHOMED_HISTORY_MONTHS = 6

export interface UnhomedWindow {
  /** ISO timestamp, inclusive start. MUST be the first instant of a month. */
  startIso: string
  /** ISO timestamp, exclusive end. MUST be the first instant of a month. */
  endIso: string
}

export interface UnhomedCauseRow {
  cause: UnhomedCause
  /** numeric(14,6) decimal string — never a float, never a display value. */
  usd: string
  /**
   * What `count` counts. NEVER view rows: the chargeback view is aggregated per
   * (unit, region, tool, month), so a row count would inflate with every extra
   * tool lane and read as a bigger population problem than it is.
   */
  countKind: 'teammates' | 'org-units' | 'provider-organisations'
  count: number
  /** The second population behind the row (people under the units; regions spanned). */
  secondaryCount: number | null
  secondaryKind: 'teammates' | 'regions' | null
  /**
   * FALSE for the pooled cause. Pooled money is an explicit, designed residual
   * with its own remediation surface — placing people cannot move it, and
   * totalling it as a peer of the three placement failures would invite an
   * operator to size a placement campaign against money no placement can touch.
   */
  placementFailure: boolean
}

export interface UnhomedWorklistRow {
  kind: 'teammate' | 'org-unit' | 'provider-organisation'
  label: string
  sublabel: string | null
  region: string | null
  usd: string
  /** People behind an org-unit row; null where the row IS a person/organisation. */
  headcount: number | null
}

export interface UnhomedWorklist {
  cause: UnhomedCause
  rows: UnhomedWorklistRow[]
  /** Rows returned (<= UNHOMED_WORKLIST_CAP). */
  shown: number
  /** Rows that exist. `shown < total` ⇒ the list is truncated and says so. */
  total: number
  /** Money in the SHOWN rows, against `bucketUsd` — a truncated list must never read as the whole bucket. */
  shownUsd: string
  bucketUsd: string
}

export interface PlacementConfigCounters {
  /** Cost-owning units that are not retired — the denominator. */
  activeCostOwningUnits: number
  /** …of which carry a directory cost-centre code (the automatic-placement match key). */
  unitsWithCostCentreCode: number
  /** Distinct teammates holding an active cou_owner row on an active cost-owning unit. */
  activeOwners: number
  /** Distinct units those owners cover. */
  unitsWithActiveOwner: number
  /**
   * …of those owners, how many carry a REAL directory identity. An owner whose
   * teammate is a bill placeholder counts toward accountability but can never
   * appear in a manager chain, so it cannot drive placement.
   */
  ownersWithDirectoryIdentity: number
}

export interface UnhomedMonthRow {
  /** YYYY-MM. */
  month: string
  /**
   * `measured`     — the month carries chargeable SOURCE ROWS, whatever they sum
   *                  to.
   * `no-spend`     — the month exists in the estate and holds NO chargeable
   *                  source row at all. Decided on the row count, NEVER on a sum:
   *                  chargeable and unhomed are both SIGNED, so a positive row and
   *                  a negative row net to $0.00 with real activity between them.
   *                  Requiring both sums to be zero was not enough — it is only
   *                  the cross-cancel (a credit note against a homed row) that it
   *                  caught. This is the same source-row rule the panel's
   *                  `unhomedNothingToSplit` applies to the selected window.
   * `not-measured` — the month predates any recorded provider spend at all.
   */
  state: 'measured' | 'no-spend' | 'not-measured'
  unhomedUsd: string | null
  chargeableUsd: string | null
  /**
   * unhomed ÷ chargeable, as a percentage. null in every non-`measured` state,
   * AND in a `measured` month whose chargeable nets to exactly $0.00 — there the
   * share is undefined (the divisor is zero), which is a third thing from 0% and
   * from 100%. The panel prints no percentage for it rather than an invented one.
   */
  sharePct: number | null
  /**
   * Has this month been RECORDED (a reporting snapshot taken)?
   *
   * `null` = the read for THIS month failed, and renders "Unknown". Still a
   * third thing from recorded and not-recorded: absence of a snapshot IS
   * not-recorded, absence of an ANSWER is not.
   *
   * Was `periodState: 'open' | 'closed'`. There is no open/closed axis any
   * more — closing records a month, it does not lock it — so the honest
   * question is whether a record exists.
   */
  recorded: boolean | null
  selected: boolean
  /** The month has not finished, so its figures are partial by definition. */
  partial: boolean
}

export interface UnhomedProbeResult {
  window: UnhomedWindow
  /** The AUTHORITATIVE unhomed total — the same expression the card's unhomed line renders. */
  unhomedUsd: string
  /** Total chargeable in the same window (the §B figure the share is against). */
  chargeableUsd: string
  /**
   * Chargeable SOURCE ROWS in the window — the ONLY basis on which anything here
   * calls a window empty. Both money figures above are signed sums, so a $0.00
   * total is not an empty window: two rows that cancel produce exactly the same
   * zeros as no rows at all, and "nothing to home" over live activity is the one
   * sentence this panel must never print. 0 ⇒ genuinely nothing was billed.
   */
  sourceRows: number
  causes: UnhomedCauseRow[]
  /** unhomedUsd − Σ(causes). MUST be '0.000000'. */
  residualUsd: string
  /** residualUsd === 0. When false the split is incomplete and must not size anything. */
  reconciles: boolean
  worklists: UnhomedWorklist[]
  /** null = the counters could not be read. Renders "Coverage unknown", NEVER "0". */
  placementConfig: PlacementConfigCounters | null
  /**
   * Always UNHOMED_HISTORY_MONTHS rows. The money comes out of the split's own
   * statement, so a history that could not be read is a probe that could not be
   * read — there is no half-answer to render.
   */
  history: UnhomedMonthRow[]
  /**
   * First month the estate holds ANY RECORDED PROVIDER SPEND — NOT the first
   * chargeable month. It is read from `actual_spend` and `copilot_pool_bill`
   * with no chargeback-exempt and no §A-firewall filtering, so a month whose
   * only row is chargeback-exempt counts: the estate WAS measuring, it simply
   * billed nothing chargeable. That is the distinction this field exists to
   * draw ("billed nothing" vs "we were not measuring yet"), and it is why it is
   * deliberately NOT derived from `unhomedByMonthSql`'s chargeable sources.
   * null = no recorded spend at all.
   */
  estateFirstMonth: string | null
}

function orZero(v: string | null | undefined): string {
  return v ?? NUMERIC_ZERO
}

function num(v: string | number | null | undefined): number {
  return v == null ? 0 : Number(v)
}

/*
 * The §A-exclusion firewall, rendered as a SQL list from the shared provider
 * registry (never hand literals). Mirrors what mig 0085 bakes into
 * v_finance_chargeback_month's Anthropic arm and into v_finance_bill_chargeback
 * — a SQL view cannot import TS, so the two are kept in step by the
 * pg_get_viewdef test, and this reader derives its copy from the registry.
 */
const firewallList = sql.join(
  GITHUB_FIREWALL_EXCLUSIONS.map((t) => sql`${t}`),
  sql`, `,
)

/**
 * THE definition of unhomed chargeable spend, per calendar month.
 *
 * ONE copy, consumed by `computeAbDecomposition`'s `unhomedChargeUsd`
 * diagnostic, by this probe's authoritative total, and by the month history.
 * The `tool <> copilot-unclassified` exclusion is load-bearing: that lane is
 * visible everywhere and NEVER chargeable (it raises its own alert), so
 * including it would make this figure disagree with every finance surface.
 *
 * Emits `(period_month, unhomed_usd, chargeable_usd, source_rows)`. Summing the
 * rows gives the window totals, so a caller never needs a second predicate to
 * get either.
 *
 * `source_rows` is what EMPTINESS is decided on, here and on the panel. Both
 * money columns are signed sums and a zero says nothing on its own: a credit
 * note against a homed row nets chargeable to $0.00, and two unhomed rows of
 * opposite sign net BOTH columns to $0.00 while the split behind them is full of
 * money. A row count cannot cancel. (It is a count of VIEW rows — the month view
 * is grouped by (unit, region, tool), so it is a presence signal, never a
 * population: the causes count people and units, never view rows.)
 */
export function unhomedByMonthSql(startIso: string, endIso: string): SQL {
  return sql`
    SELECT period_month,
           COALESCE(SUM(charge_usd) FILTER (WHERE cost_owning_unit_id IS NULL), 0) AS unhomed_usd,
           COALESCE(SUM(charge_usd), 0) AS chargeable_usd,
           COUNT(*) AS source_rows
    FROM v_finance_chargeback_month
    WHERE period_month >= ${startIso}::date AND period_month < ${endIso}::date
      AND tool <> ${COPILOT_UNCLASSIFIED_LANE}
    GROUP BY period_month
  `
}

/*
 * The per-teammate arm of the SAME money, one level down, where teammate_id
 * still exists. `v_finance_chargeback_month`'s Anthropic arm is exactly this
 * view GROUPed to month with the same firewall filter, so Σ over the rows whose
 * cost_owning_unit_id IS NULL is identical to the month view's unhomed
 * Anthropic contribution — for a MONTH-ALIGNED window. A window that splits a
 * month compares day-grained `period_date` against month-grained
 * `period_month`, the two stop agreeing, and the residual says so instead of
 * the split quietly lying.
 *
 * Classification is by the teammate's home node, which partitions cleanly
 * because a teammate has exactly one. The three predicates are positive and
 * ordered:
 *   1. the home node's REGION is the system-wide holding region (the person was
 *      never placed in any region at all);
 *   2. otherwise the home node is a HOLDING node (region known, unit not);
 *   3. otherwise no active cost-owning unit exists anywhere in the node's
 *      same-region ancestry, at ANY depth.
 *
 * (3) IS THE REMAINDER of this arm, and the header says so rather than dressing
 * it up as an independent partition: this arm only admits rows the view already
 * resolved to a NULL `cost_owning_unit_id`, and the view resolves that with the
 * SAME rule (same-region `anc.is_cost_owning_unit AND anc.retired_at IS NULL`,
 * v_org_unit_cost_owner, mig 0147), so the NOT EXISTS cannot be false for a row
 * that reaches it. It is written out anyway as a MIRROR of that rule — if the view's rule
 * ever changes without this one, the CASE yields NULL, the row falls out of
 * every bucket, and the residual reports it instead of the split quietly
 * reclassifying money. `retired_at IS NULL` is the half of the mirror that IS
 * falsifiable from data: a teammate whose only cost-owning ancestor is retired
 * is unhomed AND lands here, and the suite pins both.
 */
function teammateCauseSql(startIso: string, endIso: string): SQL {
  return sql`
    SELECT ta.usd, ta.teammate_id, t.org_unit_id AS home_unit_id, ou.region_id,
           CASE
             WHEN r.code = ${UNASSIGNED_REGION_CODE} THEN 'no-region'
             WHEN ou.unit_type = ${HOLDING_UNIT_TYPE} THEN 'region-no-unit'
             WHEN NOT EXISTS (
               SELECT 1 FROM org_unit anc
               WHERE ou.path <@ anc.path AND anc.region_id = ou.region_id
                 AND anc.is_cost_owning_unit = TRUE AND anc.retired_at IS NULL
             ) THEN 'no-cost-owning-ancestor'
           END AS cause
    FROM (
      SELECT b.teammate_id, SUM(b.bill_usd) AS usd
      FROM v_finance_bill_chargeback b
      WHERE b.period_date >= ${startIso}::date AND b.period_date < ${endIso}::date
        AND b.cost_owning_unit_id IS NULL
        AND b.tool NOT IN (${firewallList})
      GROUP BY b.teammate_id
    ) ta
    JOIN teammate t ON t.id = ta.teammate_id
    JOIN org_unit ou ON ou.id = t.org_unit_id
    JOIN region r ON r.id = ou.region_id
  `
}

/*
 * The POOLED COPILOT arm, keyed by the provider organisation the invoice names.
 *
 * COPILOT ONLY, by name and by rule — `copilot_pool_bill`,
 * `copilot_overage_allocation`, and migration 0107's GitHub-specific
 * fallback/allocation split. It is not a provider-neutral adapter and the bucket
 * is not named as though it were (`pooled-copilot`). A second pooled provider
 * lands in the residual, not in here.
 *
 * HOMING HERE IS A STORED SNAPSHOT, unlike the per-teammate arm above. The
 * bill row carries the `cost_owning_unit_id` that `provider_org` held when the
 * copilot-pool-bill worker pulled that month; re-pointing the org today moves
 * nothing until that month is re-pulled. The teammate arm, by contrast, walks
 * the ancestry live on every read. The panel discloses both halves — a single
 * "recomputed from today's rules" sentence covers only one of them.
 *
 * Mirrors migration 0107's two mutually-exclusive overage arms exactly: an
 * (enterprise, month) with a persisted allocation takes the allocation and NOT
 * the org-homed fallback. The license lane is always org-homed;
 * copilot-unclassified is excluded because the authoritative total excludes it.
 *
 * Read from the BILL rather than from the pooled view on purpose. The view has
 * no organisation column, so a drill built from it could only name the money,
 * never the thing to fix — and the bucket total and its drill would then come
 * from different places. Sourcing BOTH here keeps them identical to each other,
 * and any drift from the view lands in the residual, which is exactly where a
 * disagreement about what the pooled arm contains belongs.
 */
function pooledUnhomedSql(startIso: string, endIso: string): SQL {
  return sql`
    SELECT b.provider_enterprise_id AS enterprise_id, b.provider_org_id AS org_id,
           SUM(
             COALESCE(b.license_net_usd, 0)
             + CASE WHEN NOT EXISTS (
                 SELECT 1 FROM copilot_overage_allocation coa
                 WHERE coa.provider_enterprise_id = b.provider_enterprise_id
                   AND coa.month = b.month
               ) THEN COALESCE(b.overage_net_usd, 0) ELSE 0 END
           ) AS usd
    FROM copilot_pool_bill b
    WHERE b.month >= ${startIso}::date AND b.month < ${endIso}::date
      AND b.cost_owning_unit_id IS NULL
    GROUP BY b.provider_enterprise_id, b.provider_org_id
    UNION ALL
    SELECT coa.provider_enterprise_id, NULL::uuid AS org_id, SUM(coa.allocated_usd) AS usd
    FROM copilot_overage_allocation coa
    WHERE coa.month >= ${startIso}::date AND coa.month < ${endIso}::date
      AND coa.cost_owning_unit_id IS NULL
    GROUP BY coa.provider_enterprise_id
  `
}

/*
 * The drill rows, carried out of the SAME statement as the split as JSON.
 *
 * Every money field is `numeric(14,6)::text` before it enters the JSON, so it
 * never round-trips through a float on the way out of PostgreSQL.
 */
interface PeopleDrillRow {
  cause: UnhomedCause
  label: string
  sublabel: string | null
  region: string
  usd: string
  /** Rows that EXIST for this cause, before the cap. */
  total: number
}
interface UnitDrillRow {
  label: string
  sublabel: string | null
  region: string
  usd: string
  headcount: number
  total: number
}
interface OrgDrillRow {
  label: string | null
  sublabel: string | null
  usd: string
  total: number
}
interface HistoryMoneyRow {
  month: string
  unhomed: string
  chargeable: string
  /** Chargeable view rows in the month. Emptiness is decided on THIS, not on the sums. */
  rows: string
}

interface SplitRow extends Record<string, unknown> {
  unhomed_usd: string
  chargeable_usd: string
  source_rows: string
  a_usd: string
  a_people: string
  c_usd: string
  c_people: string
  c_regions: string
  b_usd: string
  b_units: string
  b_people: string
  d_usd: string
  d_orgs: string
  residual_usd: string
  people_rows: PeopleDrillRow[] | null
  unit_rows: UnitDrillRow[] | null
  org_rows: OrgDrillRow[] | null
  history_rows: HistoryMoneyRow[] | null
}

/** YYYY-MM for a first-of-month date string or Date. */
function monthKey(d: Date): string {
  return `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, '0')}`
}

function monthKeyFromDateString(v: string): string {
  return v.slice(0, 7)
}

/** The first instant of `offset` months before `month` (YYYY-MM), UTC. */
function shiftMonth(month: string, offset: number): string {
  const [y, m] = month.split('-').map(Number) as [number, number]
  const d = new Date(Date.UTC(y, m - 1 + offset, 1))
  return monthKey(d)
}

function monthStartIso(month: string): string {
  return `${month}-01T00:00:00.000Z`
}

function monthEndIso(month: string): string {
  return `${shiftMonth(month, 1)}-01T00:00:00.000Z`
}

/**
 * The cause split, the drill, the counters and the month history for one
 * month-aligned window.
 *
 * `anchorMonth` (YYYY-MM) is the month the card's selector holds — the history
 * ends there and marks it, so the trend is anchored on what the operator is
 * actually looking at rather than on a wall-clock month they did not choose.
 */
export async function computeUnhomedCauses(
  db: Db,
  window: UnhomedWindow,
  anchorMonth: string,
  now: Date = new Date(),
): Promise<UnhomedProbeResult> {
  const { startIso, endIso } = window
  const oldestHistoryMonth = shiftMonth(anchorMonth, -(UNHOMED_HISTORY_MONTHS - 1))

  /*
   * ONE STATEMENT: the authoritative total, all four buckets, the residual, the
   * per-cause DRILL and the month history's money. They cannot be computed
   * against different snapshots, different windows or different predicates,
   * because there is only one query.
   *
   * The drill lived in three further statements until review round 5. Under
   * READ COMMITTED each statement takes its own snapshot, so a teammate placed
   * between them moved money out of a bucket after the bucket total had been
   * read — and `shownUsd` could then exceed `bucketUsd` on screen with the
   * residual, computed in the first statement, still reading zero. Same
   * statement, same snapshot, no window in which that can happen. (The
   * alternative — REPEATABLE READ around the whole probe — was rejected: this
   * module is handed a `db` whose transaction it does not own, and it is called
   * from tests with a plain pooled handle where `SET TRANSACTION ISOLATION
   * LEVEL` is a silent no-op. A guarantee that depends on how the caller
   * happened to open the connection is not a guarantee.)
   *
   * `teammate_cause` is referenced three times, so PostgreSQL materialises it
   * once: the classification the buckets count is byte-for-byte the one the
   * drill lists.
   */
  const [split] = await db.execute<SplitRow>(sql`
    WITH by_month AS (${unhomedByMonthSql(startIso, endIso)}),
    totals AS (
      SELECT COALESCE(SUM(unhomed_usd), 0) AS unhomed,
             COALESCE(SUM(chargeable_usd), 0) AS chargeable,
             COALESCE(SUM(source_rows), 0) AS source_rows
      FROM by_month
    ),
    teammate_cause AS (${teammateCauseSql(startIso, endIso)}),
    teammate_agg AS (
      SELECT
        COALESCE(SUM(usd) FILTER (WHERE cause = 'no-region'), 0) AS a_usd,
        COUNT(DISTINCT teammate_id) FILTER (WHERE cause = 'no-region') AS a_people,
        COALESCE(SUM(usd) FILTER (WHERE cause = 'region-no-unit'), 0) AS c_usd,
        COUNT(DISTINCT teammate_id) FILTER (WHERE cause = 'region-no-unit') AS c_people,
        COUNT(DISTINCT region_id) FILTER (WHERE cause = 'region-no-unit') AS c_regions,
        COALESCE(SUM(usd) FILTER (WHERE cause = 'no-cost-owning-ancestor'), 0) AS b_usd,
        COUNT(DISTINCT home_unit_id) FILTER (WHERE cause = 'no-cost-owning-ancestor') AS b_units,
        COUNT(DISTINCT teammate_id) FILTER (WHERE cause = 'no-cost-owning-ancestor') AS b_people
      FROM teammate_cause
    ),
    pooled AS (${pooledUnhomedSql(startIso, endIso)}),
    pooled_agg AS (
      -- An enterprise-level residual line (no organisation on the invoice) counts
      -- as one entry of its own rather than vanishing from the count.
      SELECT COALESCE(SUM(usd), 0) AS d_usd,
             COUNT(DISTINCT COALESCE(org_id::text, 'enterprise:' || enterprise_id::text)) AS d_orgs
      FROM pooled
    ),
    /*
     * THE DRILL. Row type follows the CAUSE: the two holding-node causes put
     * every teammate on the same one or two nodes, so a unit-keyed row there
     * would name something no admin surface can act on.
     *
     * Every ORDER BY below is bound to the NUMERIC column, qualified against
     * its relation. It was "ORDER BY cause, usd DESC" over a projected
     * "usd::numeric(14,6)::text AS usd", and SQL resolves a bare name in
     * ORDER BY to the OUTPUT column first — so the largest-dollars-first list
     * sorted 9.00 above 10.00, as text. No text alias is in scope here for a
     * bare name to bind to, and every sort key below is qualified anyway.
     */
    people_ranked AS (
      SELECT tc.cause, tc.teammate_id, tc.usd,
             COALESCE(t.display_name, t.email) AS label,
             t.email AS sublabel,
             r.display_name || ' · ' || ou.display_name AS region,
             ROW_NUMBER() OVER (PARTITION BY tc.cause ORDER BY tc.usd DESC, tc.teammate_id) AS rn,
             COUNT(*) OVER (PARTITION BY tc.cause) AS cause_total
      FROM teammate_cause tc
      JOIN teammate t ON t.id = tc.teammate_id
      JOIN org_unit ou ON ou.id = tc.home_unit_id
      JOIN region r ON r.id = tc.region_id
      WHERE tc.cause IN ('no-region', 'region-no-unit')
    ),
    unit_agg AS (
      SELECT tc.home_unit_id, SUM(tc.usd) AS usd, COUNT(DISTINCT tc.teammate_id) AS people
      FROM teammate_cause tc
      WHERE tc.cause = 'no-cost-owning-ancestor'
      GROUP BY tc.home_unit_id
    ),
    unit_ranked AS (
      SELECT ua.usd, ua.people, ou.id AS unit_id,
             ou.display_name AS label, ou.code AS sublabel, r.display_name AS region,
             ROW_NUMBER() OVER (ORDER BY ua.usd DESC, ou.id) AS rn,
             COUNT(*) OVER () AS unit_total
      FROM unit_agg ua
      JOIN org_unit ou ON ou.id = ua.home_unit_id
      JOIN region r ON r.id = ou.region_id
    ),
    org_agg AS (
      SELECT COALESCE(p.org_id::text, 'enterprise:' || p.enterprise_id::text) AS key,
             MIN(p.org_id::text) AS org_id, MIN(p.enterprise_id::text) AS enterprise_id,
             SUM(p.usd) AS usd
      FROM pooled p GROUP BY 1
    ),
    org_ranked AS (
      SELECT oa.key, oa.usd, po.display_name AS label, pe.display_name AS sublabel,
             ROW_NUMBER() OVER (ORDER BY oa.usd DESC, oa.key) AS rn,
             COUNT(*) OVER () AS org_total
      FROM org_agg oa
      LEFT JOIN provider_org po ON po.id = oa.org_id::uuid
      LEFT JOIN provider_enterprise pe ON pe.id = oa.enterprise_id::uuid
    ),
    -- The trend's money, from the SAME expression and the SAME snapshot as the
    -- total above, so the anchor month's row cannot disagree with THIS probe's
    -- own total. The card's headline is a different statement (see the header).
    history AS (${unhomedByMonthSql(monthStartIso(oldestHistoryMonth), monthEndIso(anchorMonth))})
    SELECT
      t.unhomed::numeric(14,6)::text     AS unhomed_usd,
      t.chargeable::numeric(14,6)::text  AS chargeable_usd,
      t.source_rows::text                AS source_rows,
      ta.a_usd::numeric(14,6)::text      AS a_usd,
      ta.a_people::text                  AS a_people,
      ta.c_usd::numeric(14,6)::text      AS c_usd,
      ta.c_people::text                  AS c_people,
      ta.c_regions::text                 AS c_regions,
      ta.b_usd::numeric(14,6)::text      AS b_usd,
      ta.b_units::text                   AS b_units,
      ta.b_people::text                  AS b_people,
      pa.d_usd::numeric(14,6)::text      AS d_usd,
      pa.d_orgs::text                    AS d_orgs,
      (t.unhomed - (ta.a_usd + ta.c_usd + ta.b_usd + pa.d_usd))::numeric(14,6)::text AS residual_usd,
      /*
       * ORDERED BY rn, the rank the row was CUT on — never by a second copy of
       * the sort key. The cut and the page order are then one expression: change
       * how the list ranks and the page follows, rather than the top 20 by one
       * rule being displayed in another. (The unit and organisation lists sit
       * below the cap on every fixture, so a second ORDER BY there was
       * unobservable — which is exactly how the two would drift apart.)
       */
      (SELECT json_agg(json_build_object(
                'cause', pr.cause, 'label', pr.label, 'sublabel', pr.sublabel,
                'region', pr.region, 'usd', pr.usd::numeric(14,6)::text,
                'total', pr.cause_total)
              ORDER BY pr.cause, pr.rn)
       FROM people_ranked pr WHERE pr.rn <= ${UNHOMED_WORKLIST_CAP})           AS people_rows,
      (SELECT json_agg(json_build_object(
                'label', ur.label, 'sublabel', ur.sublabel, 'region', ur.region,
                'usd', ur.usd::numeric(14,6)::text, 'headcount', ur.people,
                'total', ur.unit_total)
              ORDER BY ur.rn)
       FROM unit_ranked ur WHERE ur.rn <= ${UNHOMED_WORKLIST_CAP})             AS unit_rows,
      (SELECT json_agg(json_build_object(
                'label', orr.label, 'sublabel', orr.sublabel,
                'usd', orr.usd::numeric(14,6)::text, 'total', orr.org_total)
              ORDER BY orr.rn)
       FROM org_ranked orr WHERE orr.rn <= ${UNHOMED_WORKLIST_CAP})            AS org_rows,
      -- NO ORDER BY: buildHistory re-keys these rows into a Map by month and
      -- reads them back in its own order, so any order this emitted was dead.
      (SELECT json_agg(json_build_object(
                'month', h.period_month::text,
                'unhomed', h.unhomed_usd::numeric(14,6)::text,
                'chargeable', h.chargeable_usd::numeric(14,6)::text,
                'rows', h.source_rows::text))
       FROM history h)                                                          AS history_rows
    FROM totals t CROSS JOIN teammate_agg ta CROSS JOIN pooled_agg pa
  `)

  const unhomedUsd = orZero(split?.unhomed_usd)
  const chargeableUsd = orZero(split?.chargeable_usd)
  const sourceRows = num(split?.source_rows)
  const residualUsd = orZero(split?.residual_usd)
  const reconciles = Number(residualUsd) === 0

  /*
   * Built by mapping over the SHARED const, so the const is the list AND the
   * order (ab-decomposition's rule, learned there the hard way twice): a cause
   * added to shared/usage/unhomed-causes.ts is a compile error here until it is
   * given a row, rather than silently missing from one surface.
   */
  const causeRows: Record<UnhomedCause, Omit<UnhomedCauseRow, 'cause'>> = {
    'no-region': {
      usd: orZero(split?.a_usd),
      countKind: 'teammates',
      count: num(split?.a_people),
      secondaryCount: null,
      secondaryKind: null,
      placementFailure: true,
    },
    'region-no-unit': {
      usd: orZero(split?.c_usd),
      countKind: 'teammates',
      count: num(split?.c_people),
      secondaryCount: num(split?.c_regions),
      secondaryKind: 'regions',
      placementFailure: true,
    },
    'no-cost-owning-ancestor': {
      usd: orZero(split?.b_usd),
      countKind: 'org-units',
      count: num(split?.b_units),
      secondaryCount: num(split?.b_people),
      secondaryKind: 'teammates',
      placementFailure: true,
    },
    'pooled-copilot': {
      usd: orZero(split?.d_usd),
      countKind: 'provider-organisations',
      count: num(split?.d_orgs),
      secondaryCount: null,
      secondaryKind: null,
      placementFailure: false,
    },
  }
  const causes: UnhomedCauseRow[] = UNHOMED_CAUSES.map((cause) => ({ cause, ...causeRows[cause] }))

  /*
   * The worklists come out of the SAME row as the buckets — see the statement
   * above. `shownUsd` is summed in integer micro-dollars from the rows that were
   * actually RETURNED, and `bucketUsd` is that bucket's own total out of the same
   * statement and the same snapshot. What that guarantees, exactly:
   *   - both figures describe ONE reading of the estate, so a truncated list can
   *     never be read against a bucket total taken a moment later;
   *   - `shownUsd` is Σ of THESE rows, never a re-render of the bucket total;
   *   - when nothing was truncated the two are EQUAL, and the suite pins it.
   *
   * It does NOT guarantee `shownUsd <= bucketUsd`, and an earlier version of this
   * comment called that inequality "structural". It is not. The rows are the top
   * N BY DOLLARS and this money is SIGNED: a bucket holding a credit note keeps
   * its negative rows below the cut, so Σ(shown) can exceed a bucket the credit
   * has netted down. That is why the panel renders both figures side by side
   * rather than inferring either from the other.
   */
  const sumUsd = (rows: { usd: string }[]) =>
    rows.reduce((acc, r) => acc + Math.round(Number(r.usd) * 1e6), 0)
  const bucketUsdOf = (c: UnhomedCause) => causes.find((x) => x.cause === c)?.usd ?? NUMERIC_ZERO
  const build = (
    cause: UnhomedCause,
    rows: UnhomedWorklistRow[],
    total: number,
  ): UnhomedWorklist => ({
    cause,
    rows,
    shown: rows.length,
    total,
    shownUsd: (sumUsd(rows) / 1e6).toFixed(6),
    bucketUsd: bucketUsdOf(cause),
  })

  const people = split?.people_rows ?? []
  const units = split?.unit_rows ?? []
  const orgs = split?.org_rows ?? []

  const worklists: UnhomedWorklist[] = []
  for (const c of ['no-region', 'region-no-unit'] as const) {
    const rows = people.filter((r) => r.cause === c)
    worklists.push(
      build(
        c,
        rows.map((r) => ({
          kind: 'teammate' as const,
          label: r.label,
          sublabel: r.sublabel,
          region: r.region,
          usd: r.usd,
          headcount: null,
        })),
        num(rows[0]?.total),
      ),
    )
  }
  worklists.push(
    build(
      'no-cost-owning-ancestor',
      units.map((r) => ({
        kind: 'org-unit' as const,
        label: r.label,
        sublabel: r.sublabel,
        region: r.region,
        usd: r.usd,
        headcount: num(r.headcount),
      })),
      num(units[0]?.total),
    ),
  )
  worklists.push(
    build(
      'pooled-copilot',
      orgs.map((r) => ({
        kind: 'provider-organisation' as const,
        // A pooled invoice line with no organisation IS the enterprise residual —
        // naming it as such beats rendering a blank cell.
        label: r.label ?? 'Enterprise residual (no organisation on the invoice)',
        sublabel: r.sublabel,
        region: null,
        usd: r.usd,
        headcount: null,
      })),
      num(orgs[0]?.total),
    ),
  )

  const placementConfig = await loadPlacementConfig(db)
  const estateFirstMonth = await loadEstateFirstMonth(db)
  const history = await buildHistory(
    db,
    split?.history_rows ?? [],
    anchorMonth,
    estateFirstMonth,
    now,
  )

  return {
    window,
    unhomedUsd,
    chargeableUsd,
    sourceRows,
    causes,
    residualUsd,
    reconciles,
    worklists,
    placementConfig,
    history,
    estateFirstMonth,
  }
}

/*
 * Can automatic placement work AT ALL?
 *
 * Counter 1 mirrors `PlacementStore.loadCostOwningCandidates()` exactly — the
 * query the placement service actually matches a person's directory cost centre
 * against. A unit without a code can never be matched however correct the rest
 * of the tree is.
 *
 * Counter 2 is the manager-chain path's precondition and the accountability
 * fact: active cou_owner rows on active cost-owning units. The
 * directory-identity sub-count mirrors `loadActiveUnitOwners`'s exclusion of
 * placeholder oids — an owner who is a bill placeholder cannot appear in
 * anyone's manager chain.
 *
 * Returns null on ANY failure so the panel can say "Coverage unknown" rather
 * than print a 0 that reads as "none configured".
 */
async function loadPlacementConfig(db: Db): Promise<PlacementConfigCounters | null> {
  return fallible(db, async (tx) => {
    const [row] = await tx.execute<{
      active_units: string
      with_code: string
      owners: string
      owned_units: string
      owners_with_identity: string
    }>(sql`
      SELECT
        (SELECT COUNT(*)::text FROM org_unit
          WHERE is_cost_owning_unit AND retired_at IS NULL) AS active_units,
        (SELECT COUNT(*)::text FROM org_unit
          WHERE is_cost_owning_unit AND retired_at IS NULL AND cost_centre_code IS NOT NULL) AS with_code,
        (SELECT COUNT(DISTINCT co.teammate_id)::text FROM cou_owner co
          JOIN org_unit ou ON ou.id = co.org_unit_id
          WHERE co.revoked_at IS NULL AND ou.is_cost_owning_unit AND ou.retired_at IS NULL) AS owners,
        (SELECT COUNT(DISTINCT co.org_unit_id)::text FROM cou_owner co
          JOIN org_unit ou ON ou.id = co.org_unit_id
          WHERE co.revoked_at IS NULL AND ou.is_cost_owning_unit AND ou.retired_at IS NULL) AS owned_units,
        (SELECT COUNT(DISTINCT co.teammate_id)::text FROM cou_owner co
          JOIN org_unit ou ON ou.id = co.org_unit_id
          JOIN teammate t ON t.id = co.teammate_id
          WHERE co.revoked_at IS NULL AND ou.is_cost_owning_unit AND ou.retired_at IS NULL
            AND t.entra_oid NOT LIKE 'bill:%' AND t.entra_oid NOT LIKE 'provisional:%') AS owners_with_identity
    `)
    if (!row) return null
    return {
      activeCostOwningUnits: num(row.active_units),
      unitsWithCostCentreCode: num(row.with_code),
      activeOwners: num(row.owners),
      unitsWithActiveOwner: num(row.owned_units),
      ownersWithDirectoryIdentity: num(row.owners_with_identity),
    }
  })
}

/**
 * The first month the estate holds ANY RECORDED PROVIDER SPEND. Distinguishes
 * "this month billed nothing" from "this month is before we were measuring at
 * all" — two zeros that mean opposite things.
 *
 * DELIBERATELY WIDER THAN CHARGEABLE. No `chargeback_exempt` filter and no §A
 * firewall: a month whose only row is chargeback-exempt still proves the estate
 * was measuring, which is exactly the fact this answers. Filtering it down to
 * the chargeable sources would make the earliest exempt-only months read
 * "before this estate recorded any spend", which is false. The name of the
 * concept — and the sentence on screen — say "recorded spend", never "billed".
 *
 * `LEAST` IGNORES NULLS in PostgreSQL: with one source empty it returns the
 * other arm, and NULL only when BOTH are null (MySQL is the engine that
 * propagates the NULL — the two have been confused here before). Verified
 * against postgres:16, the image the test suite and production both run.
 */
async function loadEstateFirstMonth(db: Db): Promise<string | null> {
  return fallible(db, async (tx) => {
    const [row] = await tx.execute<{ first_month: string | null }>(sql`
      SELECT LEAST(
        (SELECT date_trunc('month', MIN(a.date))::date FROM actual_spend a),
        (SELECT MIN(b.month) FROM copilot_pool_bill b)
      )::text AS first_month
    `)
    return row?.first_month ? monthKeyFromDateString(row.first_month) : null
  })
}

/*
 * "Is this getting worse?", answered on screen rather than by comparing
 * screenshots — and admitting what it is.
 *
 * THE SERIES IS HALF LIVE AND HALF SNAPSHOT, and saying only the first half was
 * the false claim this comment used to carry. The per-teammate arm is RECOMPUTED
 * on every read from today's tree, so placing someone today changes every month
 * they appear in, closed months included. The pooled Copilot arm is NOT: it reads
 * the `cost_owning_unit_id` stored on each bill row when that month was pulled,
 * and re-pointing an organisation moves nothing until the month is re-pulled.
 * Both halves also sit under views that have themselves changed (mig 0085 split
 * the Copilot lanes, mig 0107 changed how pooled overage is distributed), so a
 * step in this series can be a rule change rather than an operational event. The
 * panel says all three things; this comment is not the only place they are said.
 *
 * The MONEY is already in hand — it came out of the split's own statement, so
 * the anchor month's row and the headline above it are the same expression over
 * the same snapshot. What remains is per-month state, and the snapshot read is
 * fenced PER MONTH: a read that fails must cost that month its recorded flag,
 * not blank a trend whose money read perfectly well. `recorded: null` renders
 * "Unknown", a third thing from recorded and not-recorded — absence of a row IS
 * not-recorded, absence of an ANSWER is not.
 */
async function buildHistory(
  db: Db,
  moneyRows: HistoryMoneyRow[],
  anchorMonth: string,
  estateFirstMonth: string | null,
  now: Date,
): Promise<UnhomedMonthRow[]> {
  const byMonth = new Map<string, { unhomed: string; chargeable: string; rows: string }>()
  for (const r of moneyRows) {
    byMonth.set(monthKeyFromDateString(r.month), {
      unhomed: r.unhomed,
      chargeable: r.chargeable,
      rows: r.rows,
    })
  }

  const currentMonth = monthKey(now)
  const out: UnhomedMonthRow[] = []
  for (let i = 0; i < UNHOMED_HISTORY_MONTHS; i++) {
    const month = shiftMonth(anchorMonth, -i)
    const hit = byMonth.get(month)
    const chargeable = hit ? Number(hit.chargeable) : 0
    const unhomed = hit ? Number(hit.unhomed) : 0

    /*
     * Absence of a snapshot IS not-recorded. A failed READ is neither, and must
     * not poison the reads after it (see `fallible`).
     *
     * `fallible` collapses a failure to null, and `getReportingSnapshot`
     * legitimately returns null for a month nobody has recorded — so the two are
     * indistinguishable unless the read reports its own success. It returns a
     * WRAPPER for that reason: `{ snap }` means the read worked and null means
     * it did not. The predecessor never needed this because its reader defaulted
     * absence to 'open' and only ever returned null on failure.
     */
    const read = await fallible(db, async (tx) => ({ snap: await getReportingSnapshot(tx, month) }))
    const recorded: boolean | null = read === null ? null : read.snap !== null

    /*
     * SOURCE ROWS, exactly as the panel's `unhomedNothingToSplit` guards the
     * selected window. Both money columns are SIGNED sums, so neither one nor
     * both being zero means the month was empty: a credit note nets chargeable
     * to $0.00 over homed money, and two unhomed rows of opposite sign net BOTH
     * columns to $0.00 with the whole split still full. Requiring both sums to be
     * zero caught only the first of those, and printed "No chargeable spend in
     * this month" over the second. A row count cannot cancel.
     */
    let state: UnhomedMonthRow['state']
    if (estateFirstMonth === null || month < estateFirstMonth) state = 'not-measured'
    else if (num(hit?.rows) === 0) state = 'no-spend'
    else state = 'measured'

    out.push({
      month,
      state,
      unhomedUsd: state === 'measured' ? orZero(hit?.unhomed) : null,
      chargeableUsd: state === 'measured' ? orZero(hit?.chargeable) : null,
      // …and the share of a month whose divisor is zero is UNDEFINED, not 0% and
      // not Infinity%. The panel prints no percentage rather than an invented one.
      sharePct: state === 'measured' && chargeable !== 0 ? (unhomed / chargeable) * 100 : null,
      recorded,
      selected: month === anchorMonth,
      partial: month >= currentMonth,
    })
  }
  return out
}
