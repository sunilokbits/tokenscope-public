/*
 * The BUDGET axis of the regional and Business Unit drivers — attributed (§A)
 * usage in BOTH lenses, and it says so.
 *
 * ── WHY THIS AXIS STAYS ATTRIBUTED ──────────────────────────────────────────
 *
 * Selecting *Chargeback · billed* moves teammate / cost centre / surface / model
 * onto `provider_usage_fact` (`engine/billed-axis.ts`), which has NO project
 * column (mig 0118:54-79). A project chargeback figure DOES exist: the bill
 * split by tagged share, `v_finance_project_overlay` (mig 0146,
 * docs/design/project-chargeback-lens.md). It is served on the project page;
 * a chargeback lens on this axis is out of that design's scope, so this axis
 * reads the tag that already exists on the attributed lane.
 *
 * ── WHAT "READ THE TAG THAT ALREADY EXISTS" ACTUALLY BUYS ───────────────────
 *
 * More than it sounds like, because of SHADOW FILL (§4). Where OTel is silent —
 * ~95% of the estate today — the API's own amount is written into the attributed
 * lane as ONE `unaccounted_usage` row per (teammate, day, tool), carrying ONE
 * tagging decision. The worklist calls these "Provider-recorded days". So for
 * the overwhelming majority of spend, the provider's money IS on the attributed
 * lane already, at day grain, wholly tagged or wholly untagged — exact, with no
 * arithmetic. A Copilot provider-recorded day tagged to a budget lands in that
 * budget's row here; an untagged one lands WHOLLY in the unallocated bucket.
 *
 * That leaves the partly-covered day (OTel saw some of it, the fill covers the
 * rest). Its OTel rows carry their own per-session tags and its fill row carries
 * one tag, so this axis still adds only figures that carry a claim — it never
 * splits a parent amount. Splitting a partly-covered day's ATTRIBUTED amount
 * across budgets is #47, DEFERRED by owner decision on 2026-08-02 with a state
 * table required before anyone builds it. Do not build it here.
 *
 * ── THE ONE THING A READER MUST BE TOLD ─────────────────────────────────────
 *
 * These rows are ATTRIBUTED-lane money in both lanes, and the response says so
 * through `MeasureLanes`: a reader who flips to the billed lane and sees a
 * budget breakdown is entitled to know it did not come from the bill.
 *
 * Lane firewall (build-design §7(7)): reads the §A lane through the
 * `completeProjectAxisSpend` seam only — never `attribution_record`, never
 * `unaccounted_usage` directly, never raw `actual_spend`. The seam scans the
 * day-grain rollup for this axis (`source: 'rollup'`, usage-rollup-lane.md
 * R5b), an ALLOWED §A source (R7): its content is defined as an aggregate of
 * `v_complete_usage`, so the lane's definition is unchanged.
 */
import { sql, type SQL } from 'drizzle-orm'
import type { PostgresJsDatabase } from 'drizzle-orm/postgres-js'
import type { SpendLens } from '../../../shared/usage/lens'
import type { DriverRow } from '../../../shared/reports/types'
import {
  UNALLOCATED_BUDGET_KEY,
  UNALLOCATED_BUDGET_LABEL,
} from '../../../shared/reports/vocabulary'
import {
  completeProjectAxisSpend,
  projectAxisRemainderLabel,
  PROJECT_AXIS_REMAINDER_KEY,
} from '../../usage/complete-spend'
import type { UsageWindow } from '../params'

type Tx = PostgresJsDatabase<Record<string, unknown>>

/** The usage lane's word for the same bucket — a bookkeeping statement. */
export const UNTAGGED_LABEL = 'Untagged'
/** The usage lane's key for it, unchanged since the axis shipped. */
export const UNTAGGED_KEY = '__null_project'

/**
 * The current-effective baseline+top-up allocation for a SET of project ids —
 * the same allocation terms `fetchCostCentreProjectBudgets` sums, keyed by
 * project rather than clamped to one cost centre.
 *
 * WHY BY ID AND NOT BY SCOPE. The axis has already decided which projects it is
 * showing (ranked, capped), and the budget column must answer for exactly those
 * rows. A second scope predicate here would be a second definition of "in
 * scope", and the two would eventually disagree about which project belongs to
 * this table. An id list cannot.
 *
 * A project with no active allocation is ABSENT from the map, never 0: the
 * caller renders that absence as "no budget set", which is a decision nobody has
 * made rather than a budget that has been fully spent.
 */
export async function fetchProjectBudgets(
  tx: Tx,
  projectIds: string[],
): Promise<Map<string, number>> {
  if (projectIds.length === 0) return new Map()
  // A plain JS array bound as `${ids}` expands to comma-separated scalar params
  // (an IN-list shape), NOT a native Postgres array, and ANY() then fails — the
  // same trap `server/reconciliation/github-coverage.ts` documents. Build a real
  // ARRAY[...] literal, the `server/reporting/cost-centres.ts` precedent.
  const ids = sql`ARRAY[${sql.join(
    projectIds.map((id) => sql`${id}::uuid`),
    sql`, `,
  )}]`
  const rows = await tx.execute<{ project_id: string; alloc: string }>(sql`
    SELECT a.scope_id::text AS project_id, COALESCE(SUM(a.budget_usd), 0)::text AS alloc
    FROM allocation a
    WHERE a.scope_type = 'project'
      AND a.allocation_kind IN ('baseline', 'top-up')
      AND a.effective @> now()
      AND a.scope_id = ANY(${ids})
    GROUP BY a.scope_id`)
  return new Map([...rows].map((r) => [r.project_id, Number(r.alloc)]))
}

export interface BudgetAxisResult {
  rows: DriverRow[]
  /** Σ `rows` — the scope's own attributed total, including the unallocated row. */
  headlineUsd: number
  /**
   * The part of `headlineUsd` carrying no budget claim. Published separately so
   * a caller can state it without re-finding the row by label, and so the
   * identity `Σ(budget rows) + unallocated === headlineUsd` is checkable at the
   * seam rather than only on screen.
   */
  unallocatedUsd: number
}

/**
 * Ranked budgets over one scope and window, plus the unallocated remainder.
 *
 * `clamp` is a boolean SQL fragment over the alias `u` (the `v_complete_usage`
 * row), the same clamp every attributed axis takes. Clamping on the USAGE row —
 * not on the project's home — is what admits the NULL-project rows the
 * unallocated bucket is made of, and therefore what makes the sum-back hold.
 *
 * RANKED AND CAPPED, unchanged: the seam folds its tail into ONE named
 * remainder row (`PROJECT_AXIS_ROW_CAP`), which is a fold of REAL budgets and is
 * never the unallocated bucket. Both are rows, so Σ still equals the headline.
 *
 * ROW ORDER IS PART OF THE ANSWER: real budgets ranked by amount, then the
 * folded remainder, then the unallocated bucket LAST. Only real budget rows
 * carry `budgetUsd`. Both are stated in the function body, where the reasoning
 * sits beside the code that does it.
 */
export async function fetchBudgetAxis(
  tx: Tx,
  clamp: SQL,
  range: UsageWindow,
  lens: SpendLens,
): Promise<BudgetAxisResult> {
  // CONSTRAINT: rollup-sourced, so this axis may lag a source mutation by up
  // to one worker cadence — never feed it a real-time decision
  // (usage-rollup-lane.md R5b.3/R5b.4).
  const raw = await completeProjectAxisSpend(tx, range, { scope: clamp, source: 'rollup' })

  // The unallocated bucket is named for the LANE's question — see
  // `shared/reports/vocabulary.ts`. The key moves with the label so the two can
  // never disagree about which question a row answers.
  const nullKey = lens === 'chargeback' ? UNALLOCATED_BUDGET_KEY : UNTAGGED_KEY
  const nullLabel = lens === 'chargeback' ? UNALLOCATED_BUDGET_LABEL : UNTAGGED_LABEL

  const headlineUsd = raw.reduce((a, r) => a + r.costUsd, 0)
  let unallocatedUsd = 0

  /*
   * ── THE UNALLOCATED BUCKET IS NOT A DRIVER, AND IT NO LONGER RANKS LIKE ONE ─
   *
   * `projectAxisRows` orders the whole axis by amount, so the untagged bucket
   * competed with real budgets for rank — and won, at 82% of the estate on Dev.
   * That buried every real project under an ABSENCE and told the coverage story a
   * second time, three cards below where Budget coverage already told it
   * (prototype.html `note('fix 4', …)`).
   *
   * It is still a ROW. Dropping it would break the sum-back this axis is built on
   * (`Σ(rows) === headlineUsd`) and delete the tokensheet signal
   * `shared/reports/vocabulary.ts` calls "the row the product exists to surface".
   * What changes is ORDER, not membership: real budgets rank, then the folded
   * remainder, then the unallocated bucket LAST.
   *
   * Done here rather than in the SQL seam because the ordering is this AXIS's
   * editorial decision, not a property of the grouping — and because the seam is
   * shared with the uncapped cost-centre population variant.
   */
  const projects: DriverRow[] = []
  let remainderRow: DriverRow | null = null
  let unallocatedRow: DriverRow | null = null

  for (const r of raw) {
    const isRemainder = r.remainderProjects > 0
    // NULL projectId means TWO different things and they must not merge: the
    // untagged bucket, and the folded tail of real budgets. `remainderProjects`
    // is the discriminator (never the id alone) — labelling the remainder
    // "unallocated" would claim nobody tagged money that several people did.
    const isUnallocated = !isRemainder && r.projectId === null
    if (isUnallocated) unallocatedUsd += r.costUsd
    const row: DriverRow = {
      key: isRemainder ? PROJECT_AXIS_REMAINDER_KEY : (r.projectId ?? nullKey),
      label: isRemainder
        ? projectAxisRemainderLabel(r.remainderProjects)
        : (r.label ?? nullLabel),
      usd: r.costUsd,
      sharePct: headlineUsd > 0 ? r.costUsd / headlineUsd : 0,
      /*
       * ATTRIBUTED money, in BOTH lanes, and the class says so. It is never
       * 'billed': these dollars were not read off a provider bill at this grain,
       * and rendering them as a hard dollar beside genuinely billed rows would
       * make the one distinction this axis exists to preserve invisible.
       */
      spendClass: 'indicative',
      indicativeReason: 'usage-not-yet-billed',
      /*
       * THE DRILL TARGET (developer pages D29). `/projects/{code}` is keyed on
       * the code while this axis keys on the id, so the code rides the row —
       * a row that cannot name its target renders as plain text, and the
       * untagged bucket and the folded remainder name no single project, so
       * neither carries one and both stay plain text BY CONSTRUCTION.
       */
      ...(!isRemainder && !isUnallocated && r.code ? { dims: { project_code: r.code } } : {}),
    }
    if (isRemainder) remainderRow = row
    else if (isUnallocated) unallocatedRow = row
    else projects.push(row)
  }

  /*
   * AGAINST BUDGET — only a real project row carries the field at all.
   *
   * The three states stay distinct, and the two absences are NOT the same
   * absence: `number` is an allocation to consume, `null` is "no budget set" (a
   * decision nobody has made), and the field being ABSENT means the row has no
   * budget concept to have a decision about — the folded remainder is several
   * projects' worth of allocations that cannot be one percentage, and the
   * unallocated bucket is by definition money carrying no budget claim.
   * Rendering either as "no budget set" would state something false about them.
   */
  const budgets = await fetchProjectBudgets(
    tx,
    projects.map((p) => p.key),
  )
  for (const p of projects) p.budgetUsd = budgets.get(p.key) ?? null

  const rows: DriverRow[] = [
    ...projects,
    ...(remainderRow ? [remainderRow] : []),
    ...(unallocatedRow ? [unallocatedRow] : []),
  ]

  return { rows, headlineUsd, unallocatedUsd }
}
