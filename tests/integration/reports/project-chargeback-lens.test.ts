// @vitest-environment node
/*
 * The project chargeback lens (docs/design/project-chargeback-lens.md), through
 * the REAL handlers against real Postgres:
 *   GET /api/v1/me/projects/{code}?lane=chargeback
 *   GET /api/v1/me/projects/{code}/team/export?lane=chargeback
 *   GET /api/v1/reports/project/{code}?lane=chargeback
 *
 * Fixture, May 2026, tool claude-code; P/Q/R all lead-owned by BU `cb`:
 *   05-04 alice  bill 50   worklist tag P 50 (no OTel)          -> P 50
 *   05-05 alice  bill 200  OTel P 30, Q 10, untagged 20;
 *                          worklist tag R 40                     -> P 60, Q 20, R 80, untagged 40
 *   05-06 bob    bill 90   OTel P 30 + untagged 15 provider-billed,
 *                          self-billed Q 60, quarantined R 1000  -> P 60, untagged 30
 *   05-07 bob    bill 70   indicative OTel S 40; untagged worklist 30
 *                          (the residual of 70 - 40)            -> S 40, untagged 30
 *   05-08 alice  exempt bill 500 + OTel P 10; Copilot bill 300
 *                          + Copilot worklist tag P 300          -> nothing
 *   05-09 bob    bill 100  OTel P 20; untagged worklist 80       -> P 20, untagged 80
 *   05-10 bob    bill 100  OTel S 20 unknown-lane, self-billed S 30,
 *                          untagged 50                          -> S 50, untagged 50
 *   04-30 bob    bill 60   archived (watermark 05-01): rollup S 45,
 *                          untagged 15                          -> S 45, untagged 15
 * So P = 190 (alice 110, bob 80), Q = 20, R = 80. S is asserted per cell only.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import { randomUUID } from 'node:crypto'
import { startTestDb, stopTestDb, type TestDb } from '../helpers/db'
import * as schema from '../../../drizzle/schema'
import { injectTestSession } from '../../helpers/auth'
import { grantReportAccess } from '../helpers/report-access'
import { resolveServerClock } from '../../../shared/reports/clock'
import { resetReportCache, reportCacheStats } from '../../../server/reporting/report-cache'
import type { Session } from '../../../server/utils/auth'
import type {
  MeProjectChargebackResponse,
  ReportsProjectChargebackResponse,
} from '../../../shared/reports/project-chargeback'
import meProject from '../../../server/api/v1/me/projects/[code]/index.get'
import teamExport from '../../../server/api/v1/me/projects/[code]/team/export.get'
import projectReport from '../../../server/api/v1/reports/project/[code].get'

let t: TestDb
let regionId = ''
let cbUnit = ''
let otherUnit = ''
let alice = ''
let bob = ''
let owner = ''
let outsider = ''
let admin = ''
let projP = ''
let projQ = ''
let projR = ''
let projS = ''

const CLOCK = '2026-06-10T12:00:00.000Z'
const MONTH = 'month=2026-05'

function ev(session: Session, query: string, code: string) {
  const url = '/x' + (query ? `?${query}` : '')
  const headers: Record<string, unknown> = {}
  const e = {
    method: 'GET',
    path: url,
    context: { params: { code }, serverClock: resolveServerClock(new Date(CLOCK)) },
    node: {
      req: {
        method: 'GET',
        url,
        socket: { remoteAddress: '127.0.0.1' },
        get headers() {
          return { host: 'localhost:3450', origin: 'http://localhost:3450' }
        },
      },
      res: {
        statusCode: 200,
        getHeader(k: string) {
          return headers[k.toLowerCase()]
        },
        setHeader(k: string, v: unknown) {
          headers[k.toLowerCase()] = v
        },
        removeHeader(k: string) {
          headers[k.toLowerCase()] = undefined
        },
        appendHeader() {},
        get headersSent() {
          return false
        },
      },
    },
  }
  injectTestSession(e as unknown as Parameters<typeof injectTestSession>[0], session)
  return { event: e as unknown as Parameters<typeof meProject>[0], headers }
}

const sess = (teammateId: string, role: string, orgPath: string): Session =>
  ({
    teammateId,
    email: 'cb@x.test',
    displayName: 'CB',
    role,
    regionId,
    orgPath,
    issuedAt: new Date().toISOString(),
  }) as unknown as Session

const aliceSess = () => sess(alice, 'developer', 'cb')
const ownerSess = () => sess(owner, 'developer', 'cb')
const outsiderSess = () => sess(outsider, 'developer', 'other')
const adminSess = () => sess(admin, 'platform-admin', 'cb')

const me = (s: Session, q: string, code = 'CB-P') =>
  meProject(ev(s, q, code).event) as unknown as Promise<MeProjectChargebackResponse>
const report = (s: Session, q: string, code = 'CB-P') =>
  projectReport(ev(s, q, code).event) as unknown as Promise<ReportsProjectChargebackResponse>
const status = (p: Promise<unknown>) =>
  p.then(
    () => 200,
    (e: { statusCode?: number }) => e.statusCode,
  )

async function bill(tm: string, day: string, usd: number, opts: { tool?: string; exempt?: boolean } = {}) {
  await t.db.insert(schema.actualSpend).values({
    teammateId: tm,
    date: day,
    tool: opts.tool ?? 'claude-code',
    inputTokens: 0n,
    outputTokens: 0n,
    costUsd: usd.toFixed(6),
    chargebackExempt: opts.exempt ?? false,
  })
}

async function otel(
  tm: string,
  unit: string,
  day: string,
  usd: number,
  opts: { project?: string | null; lane?: string; basis?: string; session?: string } = {},
) {
  const instanceId = randomUUID()
  await t.db.insert(schema.instanceAttestation).values({
    instanceId,
    principalOid: `oid-${instanceId}`,
    teammateId: tm,
    projectCodeHash: 'h-cb',
    rawProjectCode: 'CB',
    tool: 'claude-code',
    tsStart: new Date(`${day}T00:00:00.000Z`),
    regionId,
    orgUnitId: unit,
    costOwningUnitId: unit,
  })
  await t.db.insert(schema.attributionRecord).values({
    instanceId,
    teammateId: tm,
    projectId: opts.project ?? null,
    regionId,
    orgUnitId: unit,
    costOwningUnitId: unit,
    tool: 'claude-code',
    model: 'opus',
    tokenType: 'output',
    tokens: 1000n,
    costUsd: usd.toFixed(6),
    fidelityTier: 'tier-1',
    costBasis: opts.basis ?? 'estimated',
    billingLane: opts.lane ?? 'provider-billed',
    claudeSessionId: opts.session ?? null,
    tsEvent: new Date(`${day}T10:00:00.000Z`),
  })
  return instanceId
}

async function worklist(tm: string, unit: string, day: string, usd: number, project: string | null, tool = 'claude-code') {
  await t.db.insert(schema.unaccountedUsage).values({
    teammateId: tm,
    regionId,
    orgUnitId: unit,
    day,
    tool,
    costUsd: usd.toFixed(6),
    projectId: project,
    taggedAt: project ? new Date() : null,
  })
}

beforeAll(async () => {
  t = await startTestDb()
  process.env.DATABASE_URL = t.url
  resetReportCache()

  const [r] = await t.db.insert(schema.region).values({ code: 'cbr', displayName: 'CB' }).returning()
  regionId = r!.id
  const unit = async (path: string) => {
    const [u] = await t.db
      .insert(schema.orgUnit)
      .values({ regionId, path, code: path, displayName: path, unitType: 'bu', isCostOwningUnit: true })
      .returning()
    return u!.id
  }
  cbUnit = await unit('cb')
  otherUnit = await unit('other')
  const mate = async (name: string, unitId: string) => {
    const [tm] = await t.db
      .insert(schema.teammate)
      .values({ entraOid: `oid-cb-${name}`, email: `${name}@cb.test`, displayName: name, regionId, orgUnitId: unitId, isActive: true })
      .returning()
    return tm!.id
  }
  alice = await mate('Alice', cbUnit)
  bob = await mate('Bob', otherUnit)
  owner = await mate('Owner', cbUnit)
  outsider = await mate('Outsider', otherUnit)
  admin = await mate('Admin', cbUnit)
  await grantReportAccess(t.client, admin)
  await t.client`INSERT INTO cou_owner (org_unit_id, teammate_id) VALUES (${cbUnit}::uuid, ${owner}::uuid)`

  const proj = async (code: string) => {
    const [p] = await t.db
      .insert(schema.project)
      .values({ code, codeHash: `h-${code}`, displayName: code, type: 'billable', regionId, costOwningUnitId: cbUnit })
      .returning()
    return p!.id
  }
  projP = await proj('CB-P')
  projQ = await proj('CB-Q')
  projR = await proj('CB-R')
  projS = await proj('CB-S')
  const assign = async (project: string, tm: string) => {
    await t.client`INSERT INTO project_assignment (project_id, teammate_id, role, effective)
      VALUES (${project}::uuid, ${tm}::uuid, 'member', tstzrange('2020-01-01', NULL, '[)'))`
  }
  await assign(projP, alice)
  await assign(projP, bob)
  await assign(projQ, alice)
  await assign(projR, alice)

  // 05-04: worklist-only tag.
  await bill(alice, '2026-05-04', 50)
  await worklist(alice, cbUnit, '2026-05-04', 50, projP)
  // 05-05: mixed day.
  await bill(alice, '2026-05-05', 200)
  await otel(alice, cbUnit, '2026-05-05', 30, { project: projP })
  await otel(alice, cbUnit, '2026-05-05', 10, { project: projQ })
  await otel(alice, cbUnit, '2026-05-05', 20)
  await worklist(alice, cbUnit, '2026-05-05', 40, projR)
  // 05-06: self-billed and quarantined OTel steer nothing.
  await bill(bob, '2026-05-06', 90)
  await otel(bob, otherUnit, '2026-05-06', 30, { project: projP })
  await otel(bob, otherUnit, '2026-05-06', 15)
  await otel(bob, otherUnit, '2026-05-06', 60, { project: projQ, lane: 'self-billed' })
  const conv = 'cb-quarantined-conv'
  const qInst = await otel(bob, otherUnit, '2026-05-06', 1000, { project: projR, session: conv })
  await t.client`INSERT INTO session_quarantine
      (conversation_id, instance_id, teammate_id, region_id, org_unit_id, session_ts_start, session_ts_end, instance_ts_start, cost_usd, reason)
    VALUES (${conv}, ${qInst}::uuid, ${bob}::uuid, ${regionId}::uuid, ${otherUnit}::uuid,
            '2026-05-06T00:00:00Z', '2026-05-06T23:00:00Z', '2026-05-01T00:00:00Z', 1000, 'api-uncorroborated')`
  // 05-07: indicative OTel weighs, because the residual subtracts it.
  await bill(bob, '2026-05-07', 70)
  await otel(bob, otherUnit, '2026-05-07', 40, { project: projS, basis: 'telemetry-only' })
  await worklist(bob, otherUnit, '2026-05-07', 30, null)
  // 05-08: exempt and Copilot bills never reach a project.
  await bill(alice, '2026-05-08', 500, { exempt: true })
  await otel(alice, cbUnit, '2026-05-08', 10, { project: projP })
  await bill(alice, '2026-05-08', 300, { tool: 'copilot' })
  await worklist(alice, cbUnit, '2026-05-08', 300, projP, 'copilot')
  // 05-09: the untagged worklist residual keeps its untagged share.
  await bill(bob, '2026-05-09', 100)
  await otel(bob, otherUnit, '2026-05-09', 20, { project: projP })
  await worklist(bob, otherUnit, '2026-05-09', 80, null)
  // 05-10: one unknown-lane row makes the cell incomplete, so self-billed weighs.
  await bill(bob, '2026-05-10', 100)
  await otel(bob, otherUnit, '2026-05-10', 20, { project: projS, lane: 'unknown' })
  await otel(bob, otherUnit, '2026-05-10', 30, { project: projS, lane: 'self-billed' })
  await otel(bob, otherUnit, '2026-05-10', 50)
  // 04-30: below the archive watermark, the weights come from the cold rollup.
  await t.client`UPDATE ledger_archive_state SET archived_through = '2026-05-01T00:00:00Z' WHERE id = 'singleton'`
  await bill(bob, '2026-04-30', 60)
  for (const [project, usd] of [[projS, 45], [null, 15]] as const) {
    await t.client`INSERT INTO spend_rollup_daily
        (period_start, project_id, teammate_id, region_id, org_unit_id, tool, model, token_type, total_tokens, total_cost_usd, record_count)
      VALUES ('2026-04-30T00:00:00Z', ${project}::uuid, ${bob}::uuid, ${regionId}::uuid, ${otherUnit}::uuid,
              'claude-code', 'opus', 'output', 1000, ${usd}, 1)`
  }
}, 180_000)

afterAll(async () => {
  delete process.env.TOKENSCOPE_REPORT_CACHE_TTL_MS
  resetReportCache()
  if (t) await stopTestDb(t)
}, 30_000)

describe('the overlay rule (mig 0146), per (teammate, day, tool)', () => {
  async function cell(tm: string, day: string): Promise<Map<string | null, number>> {
    const rows = await t.client<{ project_id: string | null; charge_usd: string }[]>`
      SELECT project_id::text AS project_id, charge_usd::text AS charge_usd
        FROM v_finance_project_overlay WHERE teammate_id = ${tm}::uuid AND period_date = ${day}::date`
    const m = new Map<string | null, number>()
    for (const r of rows) m.set(r.project_id, (m.get(r.project_id) ?? 0) + Number(r.charge_usd))
    return m
  }
  const sum = (m: Map<string | null, number>) => [...m.values()].reduce((a, b) => a + b, 0)

  it('a worklist-only tagged day puts 100% of B on its project', async () => {
    const m = await cell(alice, '2026-05-04')
    expect(m.get(projP)).toBeCloseTo(50, 6)
    expect(m.get(null) ?? 0).toBeCloseTo(0, 6)
  })

  it('a mixed day splits B proportionally across OTel tags, untagged OTel and a worklist tag', async () => {
    const m = await cell(alice, '2026-05-05')
    expect(m.get(projP)).toBeCloseTo(60, 6)
    expect(m.get(projQ)).toBeCloseTo(20, 6)
    expect(m.get(projR)).toBeCloseTo(80, 6)
    expect(m.get(null)).toBeCloseTo(40, 6)
  })

  it('self-billed and quarantined OTel steer nothing', async () => {
    const m = await cell(bob, '2026-05-06')
    expect(m.get(projP)).toBeCloseTo(60, 6)
    expect(m.get(null)).toBeCloseTo(30, 6)
    expect(m.has(projQ)).toBe(false)
    expect(m.has(projR)).toBe(false)
  })

  it('indicative OTel weighs like the residual it was subtracted from', async () => {
    const m = await cell(bob, '2026-05-07')
    expect(m.get(projS)).toBeCloseTo(40, 6)
    expect(m.get(null)).toBeCloseTo(30, 6)
  })

  it('exempt and Copilot bills put $0 on any project', async () => {
    expect((await cell(alice, '2026-05-08')).size).toBe(0)
  })

  it('an unknown-lane row makes self-billed OTel weigh in its cell', async () => {
    const m = await cell(bob, '2026-05-10')
    expect(m.get(projS)).toBeCloseTo(50, 6)
    expect(m.get(null)).toBeCloseTo(50, 6)
  })

  it('an archived day weighs from the cold rollup', async () => {
    const m = await cell(bob, '2026-04-30')
    expect(m.get(projS)).toBeCloseTo(45, 6)
    expect(m.get(null)).toBeCloseTo(15, 6)
  })

  it('an untagged worklist day keeps its untagged share (untagged spend is never charged to a project)', async () => {
    const m = await cell(bob, '2026-05-09')
    expect(m.get(projP)).toBeCloseTo(20, 6)
    expect(m.get(null)).toBeCloseTo(80, 6)
  })

  it('project rows plus untagged equal B in every cell', async () => {
    expect(sum(await cell(bob, '2026-05-09'))).toBeCloseTo(100, 6)
    expect(sum(await cell(alice, '2026-05-04'))).toBeCloseTo(50, 6)
    expect(sum(await cell(alice, '2026-05-05'))).toBeCloseTo(200, 6)
    expect(sum(await cell(bob, '2026-05-06'))).toBeCloseTo(90, 6)
    expect(sum(await cell(bob, '2026-05-07'))).toBeCloseTo(70, 6)
  })
})

describe('GET me/projects/{code}?lane=chargeback (member depth)', () => {
  it('a member gets per-project bill dollars, named members and the series', async () => {
    const b = await me(aliceSess(), `${MONTH}&lane=chargeback`)
    expect(b.lane).toBe('chargeback')
    expect(b.chargeback.total_usd).toBe('190.00')
    expect(b.chargeback.series).toEqual([
      { date: '2026-05-04', cost_usd: '50.00' },
      { date: '2026-05-05', cost_usd: '60.00' },
      { date: '2026-05-06', cost_usd: '60.00' },
      { date: '2026-05-09', cost_usd: '20.00' },
    ])
    expect(b.chargeback.contributors.members.map((m) => [m.display_name, m.cost_usd])).toEqual([
      ['Alice', '110.00'],
      ['Bob', '80.00'],
    ])
    expect(b.chargeback.contributors.member_count).toBe(2)
    expect(b.chargeback.settling).toMatchObject({ vendor: 'anthropic', state: 'settling' })
    // No §A block is computed in chargeback mode.
    expect(b).not.toHaveProperty('budget')
    expect(b).not.toHaveProperty('mix')
  })

  it('other projects carry their own share', async () => {
    expect((await me(aliceSess(), `${MONTH}&lane=chargeback`, 'CB-Q')).chargeback.total_usd).toBe('20.00')
    expect((await me(aliceSess(), `${MONTH}&lane=chargeback`, 'CB-R')).chargeback.total_usd).toBe('80.00')
  })

  it('a cou-owner gets aggregates only, never named rows', async () => {
    const b = await me(ownerSess(), `${MONTH}&lane=chargeback`)
    expect(b.viewer.access).toBe('cou-owner')
    expect(b.chargeback.total_usd).toBe('190.00')
    expect(b.chargeback.contributors.members).toEqual([])
    expect(b.chargeback.contributors.member_count).toBe(2)
  })

  it('echoes the usage lane by default', async () => {
    const b = (await me(aliceSess(), MONTH)) as unknown as { lane: string; budget: unknown }
    expect(b.lane).toBe('usage')
    expect(b.budget).toBeDefined()
  })

  it('a non-member is 404 in both lanes', async () => {
    expect(await status(me(outsiderSess(), MONTH))).toBe(404)
    expect(await status(me(outsiderSess(), `${MONTH}&lane=chargeback`))).toBe(404)
  })
})

describe('GET me/projects/{code}/team/export?lane=chargeback', () => {
  it('exports the chargeback contributors and echoes the lane', async () => {
    const { event, headers } = ev(aliceSess(), `${MONTH}&lane=chargeback`, 'CB-P')
    const csv = (await teamExport(event)) as string
    expect(headers['x-spend-lane']).toBe('chargeback')
    expect(csv.trim().split('\n')).toEqual([
      'member,email,charge_usd,share_pct',
      'Alice,Alice@cb.test,110.00,57.9',
      'Bob,Bob@cb.test,80.00,42.1',
    ])
  })

  it('a cou-owner and a non-member get 404 in both lanes', async () => {
    for (const s of [ownerSess(), outsiderSess()]) {
      for (const q of [MONTH, `${MONTH}&lane=chargeback`]) {
        expect(await status(teamExport(ev(s, q, 'CB-P').event) as Promise<unknown>)).toBe(404)
      }
    }
  })
})

describe('GET reports/project/{code}?lane=chargeback (reports depth)', () => {
  it('a region-wide viewer sees everyone named; rows foot to the total', async () => {
    const b = await report(adminSess(), `${MONTH}&lane=chargeback`)
    expect(b.lane).toBe('chargeback')
    expect(b.chargeback.total_usd).toBe('190.00')
    expect(b.chargeback.contributors.named.map((r) => [r.display_name, r.cost_usd])).toEqual([
      ['Alice', '110.00'],
      ['Bob', '80.00'],
    ])
    expect(b.chargeback.contributors.remainder.cost_usd).toBe('0.00')
    expect(b.chargeback.contributors.rows_total_usd).toBe('190.00')
    expect(b.chargeback.settling).toMatchObject({ vendor: 'anthropic', state: 'settling' })
    expect(b).not.toHaveProperty('budget')
  })

  it('an owner names in-scope contributors and folds the rest into ONE remainder', async () => {
    const b = await report(ownerSess(), `${MONTH}&lane=chargeback`)
    expect(b.admitted_by).toBe('member-in-scope')
    expect(b.chargeback.contributors.named.map((r) => [r.display_name, r.cost_usd])).toEqual([
      ['Alice', '110.00'],
    ])
    expect(b.chargeback.contributors.remainder).toMatchObject({ members: 1, cost_usd: '80.00' })
    expect(b.chargeback.contributors.rows_total_usd).toBe(b.chargeback.total_usd)
  })

  it('a viewer without a project grant is 403 in both lanes', async () => {
    expect(await status(report(outsiderSess(), MONTH))).toBe(403)
    expect(await status(report(outsiderSess(), `${MONTH}&lane=chargeback`))).toBe(403)
  })

  it('the cache key differs by lane', async () => {
    process.env.TOKENSCOPE_REPORT_CACHE_TTL_MS = '60000'
    resetReportCache()
    try {
      const usage = (await report(adminSess(), MONTH)) as unknown as { lane: string }
      expect(usage.lane).toBe('usage')
      const cb = await report(adminSess(), `${MONTH}&lane=chargeback`)
      expect(cb.lane).toBe('chargeback')
      expect(reportCacheStats().responseMisses).toBe(2)
      await report(adminSess(), `${MONTH}&lane=chargeback`)
      expect(reportCacheStats().responseHits).toBe(1)
    } finally {
      delete process.env.TOKENSCOPE_REPORT_CACHE_TTL_MS
      resetReportCache()
    }
  })
})
