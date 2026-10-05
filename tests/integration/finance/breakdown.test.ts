// @vitest-environment node
/*
 * Epic 14 finance breakdown — BILL-ANCHORED SQL-contract integration test
 * (mig 0059).
 *
 * Validates the breakdown's actual data sources:
 *  - per-project charge comes from v_finance_project_overlay (the bill split),
 *    NOT a raw attribution_record SUM
 *  - dev_count uses COUNT(DISTINCT teammate_id) so a project with one developer
 *    firing N sessions still reports devs=1
 *  - the untagged remainder is read directly from the overlay (project_id NULL),
 *    and projects + untagged sum to the CoU's BILL (not the OTel estimate)
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import { sql } from 'drizzle-orm'
import { randomUUID } from 'node:crypto'
import { startTestDb, stopTestDb, type TestDb } from '../helpers/db'
import * as schema from '../../../drizzle/schema'

let t: TestDb
let regionId: string
let orgUnitId: string
let projectId: string
let priyaId: string
let aniId: string

beforeAll(async () => {
  t = await startTestDb()
  const [r] = await t.db.insert(schema.region).values({ code: 'fin', displayName: 'FIN' }).returning()
  regionId = r!.id
  const [bu] = await t.db
    .insert(schema.orgUnit)
    .values({
      regionId,
      path: 'fin.svc',
      code: 'fin-svc',
      displayName: 'FIN Services',
      unitType: 'bu',
      isCostOwningUnit: true,
    })
    .returning()
  orgUnitId = bu!.id
  const [priya] = await t.db
    .insert(schema.teammate)
    .values({ entraOid: 'oid-fin-p', email: 'p@fin.com', regionId, orgUnitId })
    .returning()
  priyaId = priya!.id
  const [ani] = await t.db
    .insert(schema.teammate)
    .values({ entraOid: 'oid-fin-a', email: 'a@fin.com', regionId, orgUnitId })
    .returning()
  aniId = ani!.id

  const [proj] = await t.db
    .insert(schema.project)
    .values({
      code: 'FIN-AAA',
      codeHash: 'h-fin-aaa',
      displayName: 'FIN Project AAA',
      type: 'billable',
      regionId,
      costOwningUnitId: orgUnitId,
    })
    .returning()
  projectId = proj!.id

  // 2 attribution rows for priya, 1 for ani — distinct dev count = 2.
  const [rc] = await t.db.select({ id: schema.rateCard.id, version: schema.rateCard.version }).from(schema.rateCard).limit(1)
  const monthStart = new Date(Date.UTC(new Date().getUTCFullYear(), new Date().getUTCMonth(), 5))
  async function emit(who: string, cost: number, tagged = true) {
    const sid = randomUUID()
    await t.db.insert(schema.instanceAttestation).values({
      instanceId: sid,
      principalOid: 'oid-' + who,
      teammateId: who,
      projectCodeHash: 'h-fin-aaa',
      rawProjectCode: 'FIN-AAA',
      tool: 'claude-code',
      sessionTokenHash: 'tok-fin-' + sid,
      tsStart: monthStart,
      regionId,
      orgUnitId,
      costOwningUnitId: orgUnitId,
    })
    await t.db.insert(schema.attributionRecord).values({
      instanceId: sid,
      teammateId: who,
      projectId: tagged ? projectId : null,
      regionId,
      orgUnitId,
      costOwningUnitId: orgUnitId,
      tool: 'claude-code',
      model: 'claude-opus-4-1',
      tokenType: 'output',
      tokens: BigInt(1000),
      costUsd: cost.toFixed(6),
      rateCardId: rc!.id,
      rateCardVersion: rc!.version,
      fidelityTier: 'tier-1',
      costBasis: 'estimated',
      tsEvent: monthStart,
    })
  }
  await emit(priyaId, 5.5)
  await emit(priyaId, 4.5)
  await emit(aniId, 10)
  await emit(aniId, 5, false)

  // BILL-ANCHORED: the provider bill per teammate (homed to this CoU, since both
  // teammates sit directly at the cost-owning unit), split by tagged share
  // (mig 0146). Priya: all 10 of OTel tagged, bill 12 -> projA 12. Ani: 10
  // tagged + 5 untagged OTel, bill 15 -> projA 10 + untagged 5. Aggregated:
  // projA = 22, untagged = 5, CoU bill = 27.
  const billDay = new Date(Date.UTC(new Date().getUTCFullYear(), new Date().getUTCMonth(), 5))
    .toISOString()
    .slice(0, 10)
  await t.db.insert(schema.actualSpend).values([
    { teammateId: priyaId, date: billDay, tool: 'claude-code', inputTokens: 0n, outputTokens: 0n, costUsd: '12.00' },
    { teammateId: aniId, date: billDay, tool: 'claude-code', inputTokens: 0n, outputTokens: 0n, costUsd: '15.00' },
  ])
}, 60_000)

afterAll(async () => {
  await stopTestDb(t)
}, 30_000)

describe('finance breakdown SQL contract (bill-anchored)', () => {
  const monthStart = new Date(Date.UTC(new Date().getUTCFullYear(), new Date().getUTCMonth(), 1)).toISOString().slice(0, 10)
  const monthEnd = new Date(Date.UTC(new Date().getUTCFullYear(), new Date().getUTCMonth() + 1, 1)).toISOString().slice(0, 10)

  it('per-project rows use the overlay charge + COUNT(DISTINCT teammate_id) for dev count', async () => {
    const rows = await t.db.execute<{
      project_code: string
      dev_count: string
      total_cost_usd: string
    }>(sql`
      SELECT p.code AS project_code,
             COUNT(DISTINCT o.teammate_id)::text AS dev_count,
             COALESCE(SUM(o.charge_usd), 0)::text AS total_cost_usd
      FROM v_finance_project_overlay o
      JOIN project p ON p.id = o.project_id
      WHERE o.cost_owning_unit_id = ${orgUnitId}::uuid
        AND o.period_date >= ${monthStart}::date
        AND o.period_date <  ${monthEnd}::date
      GROUP BY p.code
    `)
    const list = [...rows]
    expect(list.length).toBe(1)
    expect(list[0]?.project_code).toBe('FIN-AAA')
    expect(list[0]?.dev_count).toBe('2')
    expect(Number(list[0]?.total_cost_usd)).toBeCloseTo(22, 6) // priya 12 + ani 10
  })

  it('untagged remainder + projects sum to the CoU BILL (read directly from the overlay)', async () => {
    const untagged = await t.db.execute<{ untagged: string }>(sql`
      SELECT COALESCE(SUM(o.charge_usd), 0)::text AS untagged
      FROM v_finance_project_overlay o
      WHERE o.cost_owning_unit_id = ${orgUnitId}::uuid
        AND o.project_id IS NULL
        AND o.period_date >= ${monthStart}::date
        AND o.period_date <  ${monthEnd}::date
    `)
    expect(Number([...untagged][0]?.untagged)).toBeCloseTo(5, 6) // ani's untagged share

    const total = await t.db.execute<{ total: string }>(sql`
      SELECT COALESCE(SUM(o.charge_usd), 0)::text AS total
      FROM v_finance_project_overlay o
      WHERE o.cost_owning_unit_id = ${orgUnitId}::uuid
        AND o.period_date >= ${monthStart}::date
        AND o.period_date <  ${monthEnd}::date
    `)
    expect(Number([...total][0]?.total)).toBeCloseTo(27, 6) // the bill: 12 + 15
  })
})
