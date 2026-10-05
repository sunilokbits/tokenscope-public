/*
 * reporting/project-chargeback — one project's chargeback figure: its rows of
 * `v_finance_project_overlay` (mig 0146) over a window. Bill dollars only; the
 * rule that splits them is docs/design/project-chargeback-lens.md "The figure".
 *
 * Reads no §A source. Callers apply their own admission and naming rules.
 */
import { sql } from 'drizzle-orm'
import type { SQL } from 'drizzle-orm'
import type { PostgresJsDatabase } from 'drizzle-orm/postgres-js'
import type { UsageWindow } from './params'
import { TEAMMATE_DRILL_FACTS_AGG } from './teammate-drill-facts'

type Tx = PostgresJsDatabase<Record<string, unknown>>

/** Window bounds as UTC dates; `endIso` is exclusive, so its date is too. */
function windowDates(win: UsageWindow): { start: string; end: string } {
  return { start: win.startIso.slice(0, 10), end: win.endIso.slice(0, 10) }
}

/**
 * Teammates who carry any weight for the project in the window. Only their bill
 * cells can hold a row for the project, and filtering on `teammate_id` lets the
 * planner push the bound into the bill side of the overlay rather than
 * evaluating every bill cell. Must stay a superset of the overlay's weight
 * sources (mig 0146): live OTel and tagged worklist rows reach it through
 * `v_complete_usage`, archived days through the cold rollup.
 */
function weightedTeammates(projectId: string, start: string, end: string): SQL {
  return sql`(
    SELECT cu.teammate_id FROM v_complete_usage cu
     WHERE cu.project_id = ${projectId}::uuid
       AND cu.ts_event >= (${start}::date::timestamp AT TIME ZONE 'UTC')
       AND cu.ts_event <  (${end}::date::timestamp AT TIME ZONE 'UTC')
    UNION
    SELECT srd.teammate_id FROM spend_rollup_daily srd
     WHERE srd.project_id = ${projectId}::uuid
       AND srd.period_start >= (${start}::date::timestamp AT TIME ZONE 'UTC')
       AND srd.period_start <  (${end}::date::timestamp AT TIME ZONE 'UTC'))`
}

export interface ProjectChargebackSeries {
  totalUsd: number
  series: { date: string; usd: number }[]
}

/** The project's charge per UTC day, and its window total. */
export async function fetchProjectChargebackSeries(
  tx: Tx,
  projectId: string,
  win: UsageWindow,
): Promise<ProjectChargebackSeries> {
  const { start, end } = windowDates(win)
  const rows = await tx.execute<{ date: string; usd: string }>(sql`
    SELECT o.period_date::text AS date, SUM(o.charge_usd)::text AS usd
      FROM v_finance_project_overlay o
     WHERE o.project_id = ${projectId}::uuid
       AND o.teammate_id IN ${weightedTeammates(projectId, start, end)}
       AND o.period_date >= ${start}::date
       AND o.period_date <  ${end}::date
     GROUP BY o.period_date
    HAVING SUM(o.charge_usd) <> 0
     ORDER BY o.period_date`)
  const series = [...rows].map((r) => ({ date: r.date, usd: Number(r.usd) }))
  return { totalUsd: series.reduce((a, r) => a + r.usd, 0), series }
}

export interface ProjectChargebackContributor extends Record<string, unknown> {
  teammate_id: string
  display_name: string | null
  email: string
  label: string
  usd: string
  drill_is_active: boolean | null
  drill_is_provisional: boolean | null
  in_scope: boolean
}

/**
 * The project's charge per teammate over the window, largest first. `inScope`
 * is a predicate over the teammate alias `t`; omit it when the caller names
 * nobody by scope.
 */
export async function fetchProjectChargebackContributors(
  tx: Tx,
  projectId: string,
  win: UsageWindow,
  inScope: SQL = sql`TRUE`,
): Promise<ProjectChargebackContributor[]> {
  const { start, end } = windowDates(win)
  const rows = await tx.execute<ProjectChargebackContributor>(sql`
    SELECT o.teammate_id::text AS teammate_id,
           t.display_name, t.email,
           COALESCE(NULLIF(t.display_name, ''), t.email) AS label,
           SUM(o.charge_usd)::text AS usd,
           ${TEAMMATE_DRILL_FACTS_AGG},
           bool_or(${inScope}) AS in_scope
      FROM v_finance_project_overlay o
      JOIN teammate t ON t.id = o.teammate_id
     WHERE o.project_id = ${projectId}::uuid
       AND o.teammate_id IN ${weightedTeammates(projectId, start, end)}
       AND o.period_date >= ${start}::date
       AND o.period_date <  ${end}::date
     GROUP BY o.teammate_id, t.display_name, t.email
    HAVING SUM(o.charge_usd) <> 0
     ORDER BY SUM(o.charge_usd) DESC, COALESCE(NULLIF(t.display_name, ''), t.email) ASC`)
  return [...rows]
}
