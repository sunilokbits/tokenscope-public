// @vitest-environment node
/*
 * BILL-ANCHORED finance (mig 0059) — the two views + the teammate→CC ancestor
 * resolver, end-to-end against real Postgres (per AGENTS.md §"Never mock
 * Drizzle"; here the local PG16 shim).
 *
 * Model: finance = the provider bill (`actual_spend`) per user, homed to the
 * NEAREST cost-owning ancestor of that user's org_unit via LTREE
 * (v_finance_bill_chargeback). OTel is ONLY the project overlay — the bill split
 * proportionally by tagged share (mig 0146) + the untagged share
 * (v_finance_project_overlay), which sums back to the bill.
 *
 * Covers:
 *   - ancestor resolver: home under a CoU -> that CoU; home AT a CoU -> itself;
 *     home with no cost-owning ancestor -> NULL (unallocated bucket); a RETIRED
 *     ancestor is skipped.
 *   - bill_chargeback sums across actual_spend.source.
 *   - overlay: bill + zero OTel -> all untagged; otherwise each project gets
 *     bill × its weight ÷ all weights (tagged + untagged OTel), whether OTel is
 *     below or above the bill; the rows for a (teammate, day, tool) sum to
 *     bill_usd.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import { randomUUID } from 'node:crypto'
import { startTestDb, stopTestDb, type TestDb } from '../helpers/db'
import * as schema from '../../../drizzle/schema'

let t: TestDb
let regionId = ''
let couId = '' // top cost-owning unit (path 'co')
let teamId = '' // non-CoU sub-unit under 'co'
let orphId = '' // unit with NO cost-owning ancestor
let retiredCouId = '' // a RETIRED cost-owning unit (path 'rco')
let retiredChildId = '' // non-CoU under the retired CoU
let projA = ''
let projB = ''

const DAY = '2026-05-10'
const TS = new Date('2026-05-10T12:00:00.000Z')

async function mkTeammate(orgUnitId: string, suffix: string): Promise<string> {
  const [tm] = await t.db
    .insert(schema.teammate)
    .values({
      entraOid: `oid-ba-${suffix}-${randomUUID().slice(0, 8)}`,
      email: `${suffix}.${randomUUID().slice(0, 8)}@example.com`,
      regionId,
      orgUnitId,
    })
    .returning({ id: schema.teammate.id })
  return tm!.id
}

async function bill(
  teammateId: string,
  costUsd: string,
  opts?: { tokens?: bigint; source?: string; tool?: string },
): Promise<void> {
  await t.db.insert(schema.actualSpend).values({
    teammateId,
    date: DAY,
    tool: opts?.tool ?? 'claude-code',
    inputTokens: opts?.tokens ?? 0n,
    outputTokens: 0n,
    costUsd,
    source: opts?.source ?? 'anthropic-analytics-api',
  })
}

/** Emit a tagged OTel attribution row (source='attribution', estimated). */
async function tag(teammateId: string, projectId: string | null, costUsd: string): Promise<void> {
  const instanceId = randomUUID()
  await t.db.insert(schema.instanceAttestation).values({
    instanceId,
    principalOid: `oid-${instanceId}`,
    teammateId,
    projectCodeHash: 'h-ba',
    rawProjectCode: 'BA',
    tool: 'claude-code',
    tsStart: TS,
    regionId,
    orgUnitId: teamId,
    costOwningUnitId: couId,
  })
  await t.db.insert(schema.attributionRecord).values({
    instanceId,
    teammateId,
    projectId,
    regionId,
    orgUnitId: teamId,
    costOwningUnitId: couId,
    tool: 'claude-code',
    model: 'opus',
    tokenType: 'output',
    tokens: 1000n,
    costUsd,
    fidelityTier: 'tier-1',
    costBasis: 'estimated',
    tsEvent: TS,
  })
}

interface ChargebackRow {
  cost_owning_unit_id: string | null
  bill_usd: string
  bill_tokens: string
}
async function chargeback(teammateId: string): Promise<ChargebackRow | undefined> {
  const rows = await t.client<ChargebackRow[]>`
    SELECT cost_owning_unit_id::text AS cost_owning_unit_id,
           bill_usd::text AS bill_usd, bill_tokens::text AS bill_tokens
      FROM v_finance_bill_chargeback WHERE teammate_id = ${teammateId}::uuid`
  return rows[0]
}

/** Overlay rows for a teammate as { projectId|null -> charge_usd }. */
async function overlay(teammateId: string): Promise<Map<string | null, number>> {
  const rows = await t.client<{ project_id: string | null; charge_usd: string }[]>`
    SELECT project_id::text AS project_id, charge_usd::text AS charge_usd
      FROM v_finance_project_overlay WHERE teammate_id = ${teammateId}::uuid`
  const m = new Map<string | null, number>()
  for (const r of rows) m.set(r.project_id, Number(r.charge_usd))
  return m
}

beforeAll(async () => {
  t = await startTestDb()
  const [r] = await t.db.insert(schema.region).values({ code: 'ba', displayName: 'BA' }).returning()
  regionId = r!.id
  const [co] = await t.db
    .insert(schema.orgUnit)
    .values({ regionId, path: 'co', code: 'co', displayName: 'CoU', unitType: 'bu', isCostOwningUnit: true })
    .returning()
  couId = co!.id
  const [team] = await t.db
    .insert(schema.orgUnit)
    .values({ regionId, parentId: couId, path: 'co.team', code: 'co-team', displayName: 'Team', unitType: 'team', isCostOwningUnit: false })
    .returning()
  teamId = team!.id
  const [orph] = await t.db
    .insert(schema.orgUnit)
    .values({ regionId, path: 'orph', code: 'orph', displayName: 'Orphan', unitType: 'team', isCostOwningUnit: false })
    .returning()
  orphId = orph!.id
  const [rco] = await t.db
    .insert(schema.orgUnit)
    .values({ regionId, path: 'rco', code: 'rco', displayName: 'Retired CoU', unitType: 'bu', isCostOwningUnit: true, retiredAt: TS })
    .returning()
  retiredCouId = rco!.id
  const [rchild] = await t.db
    .insert(schema.orgUnit)
    .values({ regionId, parentId: retiredCouId, path: 'rco.child', code: 'rco-child', displayName: 'Retired Child', unitType: 'team', isCostOwningUnit: false })
    .returning()
  retiredChildId = rchild!.id
  const [pa] = await t.db
    .insert(schema.project)
    .values({ code: 'BA-A', codeHash: 'h-ba-a', displayName: 'BA A', type: 'billable', regionId, costOwningUnitId: couId })
    .returning()
  projA = pa!.id
  const [pb] = await t.db
    .insert(schema.project)
    .values({ code: 'BA-B', codeHash: 'h-ba-b', displayName: 'BA B', type: 'billable', regionId, costOwningUnitId: couId })
    .returning()
  projB = pb!.id
}, 180_000)

afterAll(async () => {
  if (t) await stopTestDb(t)
}, 30_000)

describe('v_finance_bill_chargeback — teammate -> nearest cost-owning ancestor', () => {
  it('homes a teammate under a CoU to that CoU', async () => {
    const tm = await mkTeammate(teamId, 'under')
    await bill(tm, '100.00', { tokens: 1234n })
    const row = await chargeback(tm)
    expect(row?.cost_owning_unit_id).toBe(couId)
    expect(Number(row?.bill_usd)).toBe(100)
    expect(Number(row?.bill_tokens)).toBe(1234)
  })

  it('homes a teammate sitting AT a CoU to itself', async () => {
    const tm = await mkTeammate(couId, 'at')
    await bill(tm, '20.00')
    const row = await chargeback(tm)
    expect(row?.cost_owning_unit_id).toBe(couId)
  })

  it('a teammate with no cost-owning ancestor -> NULL (unallocated bucket)', async () => {
    const tm = await mkTeammate(orphId, 'orphan')
    await bill(tm, '10.00')
    const row = await chargeback(tm)
    expect(row?.cost_owning_unit_id).toBeNull()
    expect(Number(row?.bill_usd)).toBe(10)
  })

  it('skips a RETIRED cost-owning ancestor -> NULL', async () => {
    const tm = await mkTeammate(retiredChildId, 'retired')
    await bill(tm, '7.00')
    const row = await chargeback(tm)
    expect(row?.cost_owning_unit_id).toBeNull()
  })

  it('sums the bill across actual_spend.source', async () => {
    const tm = await mkTeammate(couId, 'multisrc')
    await bill(tm, '15.00', { source: 'anthropic-analytics-api' })
    await bill(tm, '5.00', { source: 'manual-adjustment' })
    const row = await chargeback(tm)
    expect(Number(row?.bill_usd)).toBe(20)
  })
})

describe('v_finance_project_overlay — the bill split', () => {
  it('bill + zero OTel -> all untagged (= bill)', async () => {
    const tm = await mkTeammate(teamId, 'zero-otel')
    await bill(tm, '20.00')
    const o = await overlay(tm)
    expect(o.get(null)).toBe(20) // untagged row
    expect([...o.keys()].filter((k) => k !== null)).toHaveLength(0) // no project rows
  })

  it('OTel < bill -> the whole bill split by tagged share (mig 0146)', async () => {
    const tm = await mkTeammate(teamId, 'under-bill')
    await bill(tm, '100.00')
    await tag(tm, projA, '40.00')
    await tag(tm, null, '10.00') // untagged OTel keeps its share
    const o = await overlay(tm)
    // weights A 40, untagged 10 -> A = 100 × 40/50, untagged = 100 × 10/50
    expect(o.get(projA)).toBeCloseTo(80, 6)
    expect(o.get(null)).toBeCloseTo(20, 6)
    const sum = [...o.values()].reduce((a, b) => a + b, 0)
    expect(sum).toBeCloseTo(100, 6)
  })

  it('OTel > bill -> tagged split of the bill, no untagged share', async () => {
    const tm = await mkTeammate(teamId, 'over-bill')
    await bill(tm, '50.00')
    await tag(tm, projA, '50.00')
    await tag(tm, projB, '30.00') // tagged OTel total 80 > bill 50
    const o = await overlay(tm)
    // shares 50/80 and 30/80 of the bill
    expect(o.get(projA)).toBeCloseTo(31.25, 6)
    expect(o.get(projB)).toBeCloseTo(18.75, 6)
    expect(o.get(null) ?? 0).toBeCloseTo(0, 6) // no untagged weight
    const sum = [...o.values()].reduce((a, b) => a + b, 0)
    expect(sum).toBeCloseTo(50, 6) // sums back to the bill
  })
})
