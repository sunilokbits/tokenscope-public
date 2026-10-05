// @vitest-environment node
/*
 * THE SHARED §A OPERAND — "corroborated, provider-billed OTel", applied per
 * complete (teammate, day, tool) cell.
 * Design: docs/design/emitting-identity-and-subscription-type.md §7, §9, §12.
 *
 * Three queries net §A against this same quantity and must agree exactly:
 * `unaccounted-reconciliation` (the UNDER direction), `over-emission-detection`
 * (the OVER direction) and `ab-decomposition` (which MODELS both). This file
 * exercises all three against one definition
 * (server/usage/corroborated-otel.ts), because the decomposition is the one
 * that breaks SILENTLY when they drift — its residual still closes, since
 * moving money between terms cannot change a sum.
 *
 * Each day below is its own (teammate, day, tool) cell, so scenarios cannot
 * contaminate one another through the per-cell completeness test.
 */
import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest'
import { randomUUID } from 'node:crypto'
import { startTestDb, stopTestDb, type TestDb } from '../helpers/db'
import * as schema from '../../../drizzle/schema'
import { reconcileUnaccountedUsage } from '../../../server/usage/unaccounted-reconciliation'
import { detectOverEmission } from '../../../server/usage/over-emission-detection'
import { computeAbDecomposition } from '../../../server/usage/ab-decomposition'
import { completeProjectSpend } from '../../../server/usage/complete-spend'

let t: TestDb
let regionId = ''
let orgUnitId = ''
let teammateId = ''
let instanceId = ''
let projectId = ''

/**
 * The window ends well clear of every seeded day, so the over-emission
 * settled-bill lag (3 days) never suppresses a flag the test is asserting ON.
 */
const WINDOW = { startDate: '2026-07-01', endDate: '2026-07-31' }
const DECOMP_WINDOW = { startIso: '2026-07-01T00:00:00.000Z', endIso: '2026-08-01T00:00:00.000Z' }

type Lane = 'provider-billed' | 'self-billed' | 'unknown'

/** The provider API truth for a (teammate, day, tool). */
async function bill(day: string, costUsd: string, tokens = 0): Promise<void> {
  await t.db.insert(schema.actualSpend).values({
    teammateId,
    date: day,
    tool: 'claude-code',
    inputTokens: BigInt(tokens),
    outputTokens: 0n,
    costUsd,
    source: `api:${randomUUID().slice(0, 8)}`,
  })
}

/**
 * One OTel row. `lane` is omitted deliberately in the "pre-migration" cases so
 * the column DEFAULT ('unknown') is what is under test — a row written before
 * mig 0119 looks exactly like this.
 */
async function otel(
  day: string,
  costUsd: string,
  opts: { lane?: Lane; conv?: string; tokens?: number; projectId?: string } = {},
): Promise<string> {
  const conv = opts.conv ?? `conv-${randomUUID().slice(0, 8)}`
  await t.db.insert(schema.attributionRecord).values({
    instanceId,
    claudeSessionId: conv,
    teammateId,
    regionId,
    orgUnitId,
    projectId: opts.projectId ?? null,
    costOwningUnitId: opts.projectId ? orgUnitId : null,
    tool: 'claude-code',
    model: 'opus',
    tokenType: 'output',
    tokens: BigInt(opts.tokens ?? 0),
    costUsd,
    fidelityTier: 'tier-1',
    costBasis: 'estimated',
    tsEvent: new Date(`${day}T12:00:00.000Z`),
    sourceRunId: randomUUID(),
    ...(opts.lane ? { billingLane: opts.lane } : {}),
  })
  return conv
}

/** Open, dev-CONFIRMED forgery quarantine — the exclusion the operand has always applied. */
async function quarantine(conv: string, day: string): Promise<void> {
  await t.db.insert(schema.sessionQuarantine).values({
    conversationId: conv,
    instanceId,
    teammateId,
    regionId,
    orgUnitId,
    sessionTsStart: new Date(`${day}T12:00:00.000Z`),
    sessionTsEnd: new Date(`${day}T12:00:00.000Z`),
    instanceTsStart: new Date('2026-07-01T00:00:00.000Z'),
    reason: 'api-uncorroborated',
  })
}

async function residual(day: string): Promise<{ cost: number; tokens: number }> {
  const [row] = await t.client<{ cost_usd: string; tokens: string }[]>`
    SELECT cost_usd::text AS cost_usd, tokens::text AS tokens
      FROM unaccounted_usage
     WHERE teammate_id = ${teammateId}::uuid AND day = ${day}::date AND tool = 'claude-code'`
  return { cost: Number(row?.cost_usd ?? 0), tokens: Number(row?.tokens ?? 0) }
}

async function reset(): Promise<void> {
  await t.client`DELETE FROM over_emission WHERE teammate_id = ${teammateId}::uuid`
  await t.client`DELETE FROM unaccounted_usage WHERE teammate_id = ${teammateId}::uuid`
  await t.client`DELETE FROM session_quarantine WHERE teammate_id = ${teammateId}::uuid`
  await t.client`DELETE FROM attribution_record WHERE teammate_id = ${teammateId}::uuid`
  await t.client`DELETE FROM actual_spend WHERE teammate_id = ${teammateId}::uuid`
}

beforeAll(async () => {
  t = await startTestDb()
  const [r] = await t.db.insert(schema.region).values({ code: 'ln', displayName: 'Lane' }).returning()
  regionId = r!.id
  const [ou] = await t.db
    .insert(schema.orgUnit)
    .values({ regionId, path: 'ln', code: 'ln-bu', displayName: 'Lane BU', unitType: 'bu', isCostOwningUnit: true })
    .returning()
  orgUnitId = ou!.id
  const [tm] = await t.db
    .insert(schema.teammate)
    .values({ entraOid: 'oid-ln', email: 'ln@example.com', regionId, orgUnitId })
    .returning()
  teammateId = tm!.id
  const [p] = await t.db
    .insert(schema.project)
    .values({ code: 'LN-P', codeHash: 'h-ln-p', displayName: 'Lane Project', type: 'billable', regionId, costOwningUnitId: orgUnitId })
    .returning()
  projectId = p!.id
  instanceId = randomUUID()
  await t.db.insert(schema.instanceAttestation).values({
    instanceId,
    principalOid: 'oid-ln',
    teammateId,
    projectCodeHash: 'h-ln-p',
    rawProjectCode: 'LN-P',
    tool: 'claude-code',
    tsStart: new Date('2026-07-01T00:00:00Z'),
    regionId,
    orgUnitId,
  })
}, 180_000)

afterAll(async () => {
  if (t) await stopTestDb(t)
}, 30_000)

beforeEach(reset)

describe("'unknown' reproduces today's behaviour exactly (§1)", () => {
  it('an all-unknown cell and the same cell stamped provider-billed produce identical §A and budget figures', async () => {
    /*
     * The migration's safety claim, made falsifiable. Every row written before
     * mig 0119 sits at 'unknown', so if 'unknown' behaved like ANY of the other
     * lanes the column landing would silently restate history.
     *
     * Two runs over the SAME amounts, differing only in the lane, compared
     * field by field. Reverting the 'unknown' arm of the CASE in
     * corroborated-otel.ts (folding it into the self-billed exclusion) makes the
     * first run's residual jump from $40 to $100 and this goes red.
     */
    const DAY = '2026-07-02'
    // The §A total, and the PROJECT figure a budget threshold is evaluated
    // against — `completeProjectSpend` is the exact call budget-alert makes, so
    // this compares the number that would page a PM, not a proxy for it.
    const figures = async () => ({
      residual: await residual(DAY),
      sectionA: (
        await t.client<{ total: string }[]>`
          SELECT COALESCE(SUM(cost_usd), 0)::text AS total FROM v_complete_usage
           WHERE ts_event >= '2026-07-01'::timestamptz AND ts_event < '2026-08-01'::timestamptz`
      )[0]!.total,
      projectSpend: [
        ...(await completeProjectSpend(t.db, { startIso: '2026-07-01T00:00:00.000Z', endIso: '2026-08-01T00:00:00.000Z' })),
      ],
    })

    const seed = async (lane?: Lane) => {
      await reset()
      await bill(DAY, '100.00', 1000)
      await otel(DAY, '35.00', { lane, tokens: 200, projectId })
      await otel(DAY, '25.00', { lane, tokens: 150, projectId })
      await reconcileUnaccountedUsage(t.db, WINDOW)
    }

    // Pre-0119 rows: no lane written at all, so the column DEFAULT applies.
    await seed()
    const asUnknown = await figures()
    // Sanity + anti-vacuity: this is the pre-0119 arithmetic, max(0, 100 − 60),
    // and the project really is carrying the $60.
    expect(asUnknown.residual).toEqual({ cost: 40, tokens: 650 })
    expect(asUnknown.projectSpend).toHaveLength(1)
    expect(asUnknown.projectSpend[0]![1].costUsd).toBe(60)

    await seed('provider-billed')
    expect(await figures()).toEqual(asUnknown)
  })
})

describe('per-cell completeness (§9)', () => {
  it('a PARTIAL cell keeps the OLD operand; the same cell, fully stamped, uses the new one', async () => {
    /*
     * The hazard §9 names. If a cell mixes stamped and unstamped rows and the
     * new operand were applied globally, the still-'unknown' self-billed rows
     * would stay in the subtrahend and PARTIALLY suppress the residual — a
     * figure that is neither the old behaviour nor the new one.
     *
     * Reverting the bool_or gate (always applying the self-billed FILTER) turns
     * the first assertion from $40 into $60. The SECOND assertion is what stops
     * this test passing vacuously: it proves the new operand really does apply
     * once the cell is complete, so $40 is a decision and not an inert default.
     */
    const DAY = '2026-07-05'
    await bill(DAY, '100.00', 1000)
    const stillUnknown = await otel(DAY, '40.00', { tokens: 300 })
    await otel(DAY, '20.00', { lane: 'self-billed', tokens: 100 })

    await reconcileUnaccountedUsage(t.db, WINDOW)
    // Subtrahend = 40 + 20 (everything), because the cell is not fully classified.
    expect(await residual(DAY)).toEqual({ cost: 40, tokens: 600 })

    // Complete the cell — exactly what a backfill replay would do.
    await t.client`
      UPDATE attribution_record SET billing_lane = 'provider-billed'
       WHERE teammate_id = ${teammateId}::uuid AND claude_session_id = ${stillUnknown}`
    await reconcileUnaccountedUsage(t.db, WINDOW)
    // Subtrahend = 40 only. The self-billed $20 has left, so the residual grows.
    expect(await residual(DAY)).toEqual({ cost: 60, tokens: 700 })
  })

  it('a QUARANTINED unknown row does not vote on completeness', async () => {
    /*
     * §9's precise instruction: evaluate completeness over the POST-quarantine
     * population. The quarantine exclusion lives in the WHERE clause, so
     * `bool_or` never sees an excluded row.
     *
     * Move that exclusion into a FILTER and this goes red: the quarantined
     * 'unknown' row — which contributes NOTHING to either total — would drag
     * the cell back to "partially classified", putting the valid self-billed
     * $20 back into the subtrahend and dropping the residual from $60 to $40.
     */
    const DAY = '2026-07-08'
    await bill(DAY, '100.00', 1000)
    const forged = await otel(DAY, '30.00', { tokens: 500 })
    await quarantine(forged, DAY)
    await otel(DAY, '20.00', { lane: 'self-billed', tokens: 100 })
    await otel(DAY, '40.00', { lane: 'provider-billed', tokens: 300 })

    await reconcileUnaccountedUsage(t.db, WINDOW)
    // Corroborated population = {self-billed 20, provider-billed 40} → complete
    // → subtrahend = 40. The quarantined 30 is invisible to both the sum and
    // the completeness test.
    expect(await residual(DAY)).toEqual({ cost: 60, tokens: 700 })
  })
})

describe('one operand, three consumers (§7)', () => {
  it('a self-billed row is excluded from unaccounted_usage, over_emission AND the A/B decomposition', async () => {
    /*
     * The reason the operand is a module. Each consumer is asserted on the same
     * seeded day, so a change that fixes two and misses the third fails here
     * rather than in production six weeks later.
     *
     * Numbers chosen so every consumer flips:
     *   API $100, provider-billed OTel $50, self-billed OTel $500
     *
     *   OLD operand (subtrahend 550): residual max(0, 100−550) = $0;
     *     over = 450 > max($25, 1.0 × 100) → FLAGGED; floor = −450.
     *   NEW operand (subtrahend 50):  residual max(0, 100−50) = $50;
     *     over = max(0, 50−100) = 0 → not flagged; floor = 0.
     *
     * Reverting the self-billed exclusion in corroborated-otel.ts moves all
     * three at once.
     */
    const DAY = '2026-07-12'
    await bill(DAY, '100.00', 1000)
    await otel(DAY, '50.00', { lane: 'provider-billed', tokens: 400 })
    await otel(DAY, '500.00', { lane: 'self-billed', tokens: 9000 })

    // 1. The UNDER direction — the needs-tagging worklist this design exists to unsuppress.
    await reconcileUnaccountedUsage(t.db, WINDOW)
    expect(await residual(DAY)).toEqual({ cost: 50, tokens: 600 })

    // 2. The OVER direction — a developer's personal subscription is not a forgery.
    const over = await detectOverEmission(t.db, WINDOW)
    expect(over.flagged).toBe(0)
    const flags = await t.client<{ n: string }[]>`
      SELECT COUNT(*)::text AS n FROM over_emission WHERE teammate_id = ${teammateId}::uuid`
    expect(Number(flags[0]!.n)).toBe(0)

    // 3. The decomposition's floor term, which MODELS the max(0, …) the
    //    reconciliation applies. It must net against the identical operand or
    //    it reports a $450 floor that no query ever produced.
    const decomp = await computeAbDecomposition(t.db, DECOMP_WINDOW)
    expect(Number(decomp.terms.floor)).toBe(0)
  })

  it('COST and TOKENS leave together — one row cannot describe two populations', async () => {
    /*
     * §7's second half. `unaccounted_usage` recomputes both measures, so the
     * completeness gate is applied to each with the same `bool_or`. Gate the
     * cost and forget the tokens and you get a row whose dollars and tokens
     * describe different populations — internally inconsistent, and nothing
     * downstream would flag it.
     *
     * Removing the tokens branch of the gate leaves cost at $50 (correct) while
     * tokens collapse to 0 (max(0, 1000 − 9400)), so the tokens assertion is
     * the one that goes red.
     */
    const DAY = '2026-07-15'
    await bill(DAY, '100.00', 1000)
    await otel(DAY, '50.00', { lane: 'provider-billed', tokens: 400 })
    await otel(DAY, '500.00', { lane: 'self-billed', tokens: 9000 })
    await reconcileUnaccountedUsage(t.db, WINDOW)
    expect(await residual(DAY)).toEqual({ cost: 50, tokens: 600 })
  })
})

describe('§B is untouched (§15)', () => {
  it('CHARGEBACK AMOUNTS are byte-identical across both lanes', async () => {
    /*
     * The boundary this change must not cross. §B never reads OTel, so no
     * billing-lane value can move a charged figure.
     *
     * Asserted on AMOUNTS, not on view SQL.
     *
     * v_finance_project_overlay is deliberately NOT in this snapshot: since mig
     * 0146 its weights exclude self-billed OTel, so the lane steers how the bill
     * splits across projects (never the bill total). That is pinned in
     * tests/integration/reports/project-chargeback-lens.test.ts.
     */
    const DAY = '2026-07-20'
    await bill(DAY, '100.00', 1000)
    await otel(DAY, '60.00', { lane: 'provider-billed', tokens: 400, projectId })
    await otel(DAY, '40.00', { lane: 'self-billed', tokens: 300, projectId })

    const snapshot = async () => ({
      billChargeback: await t.client<{ tool: string; bill_usd: string }[]>`
        SELECT tool, bill_usd::text AS bill_usd FROM v_finance_bill_chargeback
         WHERE teammate_id = ${teammateId}::uuid AND period_date = ${DAY}::date ORDER BY tool`,
      chargebackMonth: await t.client<{ tool: string; charge_usd: string }[]>`
        SELECT tool, charge_usd::text AS charge_usd FROM v_finance_chargeback_month
         WHERE cost_owning_unit_id = ${orgUnitId}::uuid AND period_month = '2026-07-01'::date
         ORDER BY tool`,
    })

    const before = await snapshot()
    // Anti-vacuity: a snapshot of nothing would compare equal to a snapshot of
    // nothing. Every arm must carry real money for the comparison to mean anything.
    expect(before.billChargeback).toHaveLength(1)
    expect(Number(before.billChargeback[0]!.bill_usd)).toBe(100)
    expect(before.chargebackMonth.some((r) => Number(r.charge_usd) > 0)).toBe(true)

    // Flip BOTH lanes — the most aggressive reclassification possible on this day.
    await t.client`
      UPDATE attribution_record
         SET billing_lane = CASE WHEN billing_lane = 'self-billed' THEN 'provider-billed' ELSE 'self-billed' END
       WHERE teammate_id = ${teammateId}::uuid`

    expect(await snapshot()).toEqual(before)
  })
})
