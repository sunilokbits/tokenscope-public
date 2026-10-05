/*
 * Read joiner — feed synthetic spans to a fake reader, assert
 * attribution_record rows land + idempotent on re-run.
 *
 * Plus: end-to-end "Journey 1" simulation — attest a session, ingest
 * spans, run the joiner, query /me/usage-equivalent SQL, assert the
 * cost bucket is populated.
 */
import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest'
import { sql } from 'drizzle-orm'
import { startTestDb, stopTestDb, type TestDb } from '../helpers/db'
import { runReadJoiner, selectRecentJoinableSessionIds, selectJoinableInstances } from '../../../server/workers/azure-monitor-reader'
import { runMitigationQuery } from '../../../server/workers/mitigation-query'
import { WATERMARK_LOOKBACK_MS, type TelemetryReader, type UsageRecord } from '../../../server/azure/reader'

let t: TestDb

class StubReader {
  // Captures the `sinceTsEvent` the joiner passed per instance, so tests can
  // assert the high-water-mark drove the read. Also FILTERS the returned set the
  // way a real reader would (events newer than the watermark minus lookback), so
  // the joiner only ever sees the incremental slice.
  public readonly calls: Array<{ sessionId: string; sinceTsEvent?: Date }> = []
  constructor(public readonly map: Map<string, UsageRecord[]>) {}
  async getSessionUsage(sessionId: string, sinceTsEvent?: Date): Promise<UsageRecord[]> {
    this.calls.push({ sessionId, sinceTsEvent })
    const all = this.map.get(sessionId) ?? []
    if (!sinceTsEvent) return all
    const cutoff = sinceTsEvent.getTime() - WATERMARK_LOOKBACK_MS
    return all.filter((u) => new Date(u.tsEvent).getTime() > cutoff)
  }
}

beforeAll(async () => {
  t = await startTestDb()

  // Minimal world: region + org + teammate + project + session +
  // assignment + a rate card (optional but realistic).
  await t.client.unsafe(`
    INSERT INTO region (id, code, display_name) VALUES
      ('11111111-1111-1111-1111-111111111111', 'apac', 'APAC');
    INSERT INTO org_unit (id, region_id, path, code, display_name, unit_type)
      VALUES ('22222222-2222-2222-2222-222222222222', '11111111-1111-1111-1111-111111111111',
              'apac.services'::ltree, 'apac-svcs', 'APAC Services', 'bu');
    INSERT INTO teammate (id, entra_oid, email, region_id, org_unit_id)
      VALUES ('33333333-3333-3333-3333-333333333333', 'oid', 'dev@i.com',
              '11111111-1111-1111-1111-111111111111', '22222222-2222-2222-2222-222222222222');
    INSERT INTO project (id, code, code_hash, display_name, type, region_id, cost_owning_unit_id)
      VALUES ('44444444-4444-4444-4444-444444444444', 'CSL-AII', 'h-afl-aii', 'Contoso League · AI Insights',
              'billable', '11111111-1111-1111-1111-111111111111',
              '22222222-2222-2222-2222-222222222222');
    INSERT INTO project_assignment (project_id, teammate_id, effective)
      VALUES ('44444444-4444-4444-4444-444444444444', '33333333-3333-3333-3333-333333333333',
              '[2026-01-01, 2099-01-01)'::tstzrange);
    -- Migration 0004_default_rate_card.sql already seeds the
    -- anthropic:claude-code rate card and its lines; do not re-insert
    -- (the EXCLUDE-USING-gist would reject the overlap).
    INSERT INTO instance_attestation
      (instance_id, principal_oid, principal_email, teammate_id, project_code_hash,
       raw_project_code, tool, session_token_hash, ts_start, ts_actual_end,
       region_id, org_unit_id, cost_owning_unit_id)
    VALUES
      ('66666666-6666-6666-6666-666666666666', 'oid', 'dev@i.com',
       '33333333-3333-3333-3333-333333333333', 'h-afl-aii', 'CSL-AII',
       'claude-code', 'hashS', '2026-05-24 09:00:00+00', '2026-05-24 09:30:00+00',
       '11111111-1111-1111-1111-111111111111', '22222222-2222-2222-2222-222222222222',
       '22222222-2222-2222-2222-222222222222');
  `)
}, 120_000)

afterAll(async () => {
  await stopTestDb(t)
}, 30_000)

describe('runReadJoiner', () => {
  // The instance_attestation fixture is dated 2026-05-24. runReadJoiner's
  // default scan window is 24h back from new Date(), so as wall-clock
  // time advances past that window the time-based session query stops
  // finding the fixture — sessions=0, attributionRowsWritten=0.
  // Bypass the window by passing the session id explicitly: that's the
  // production code path the runtime scheduler also uses
  // (server/workers/registry.ts:azure-monitor-read entry).
  const FIXTURE_SESSION = '66666666-6666-6666-6666-666666666666'

  it('writes attribution_record rows for the session\'s spans', async () => {
    // ADR-0004 B′: project comes from the EMITTED project.code_hash, not the
    // attestation row. The teammate IS a member of h-afl-aii → attributed.
    const reader = new StubReader(
      new Map([
        [
          FIXTURE_SESSION,
          [
            { tokens: 1000, tokenType: 'input', model: 'claude-sonnet-4-7', tsEvent: '2026-05-24T09:10:00Z', projectCodeHash: 'h-afl-aii' },
            { tokens: 2000, tokenType: 'output', model: 'claude-sonnet-4-7', tsEvent: '2026-05-24T09:10:01Z', projectCodeHash: 'h-afl-aii' },
          ],
        ],
      ]),
    ) as unknown as TelemetryReader

    const result = await runReadJoiner(t.db, reader, { sessionIds: [FIXTURE_SESSION] })
    expect(result.attributionRowsWritten).toBe(2)
    expect(result.sessionsProcessed).toBeGreaterThan(0)

    const rows = await t.client<{ count: string }[]>`
      SELECT COUNT(*)::text AS count FROM attribution_record
      WHERE instance_id = ${FIXTURE_SESSION}::uuid
    `
    expect(Number(rows[0]!.count)).toBe(2)
  })

  it('second run is idempotent (no duplicates on the same session_id + ts_event + token_type)', async () => {
    const reader = new StubReader(
      new Map([
        [
          FIXTURE_SESSION,
          [
            { tokens: 1000, tokenType: 'input', model: 'claude-sonnet-4-7', tsEvent: '2026-05-24T09:10:00Z', projectCodeHash: 'h-afl-aii' },
            { tokens: 2000, tokenType: 'output', model: 'claude-sonnet-4-7', tsEvent: '2026-05-24T09:10:01Z', projectCodeHash: 'h-afl-aii' },
          ],
        ],
      ]),
    ) as unknown as TelemetryReader

    const result = await runReadJoiner(t.db, reader, { sessionIds: [FIXTURE_SESSION] })
    expect(result.attributionRowsWritten).toBe(0)
  })

  it('stamps identity_state onto attribution_record from the emitting instance (mig 0057)', async () => {
    // The default fixture instance came through the authenticated provision flow,
    // so its identity_state defaults to 'confirmed' — every row it wrote carries it.
    const confirmedRows = await t.client<{ count: string }[]>`
      SELECT COUNT(*)::text AS count FROM attribution_record
      WHERE instance_id = ${FIXTURE_SESSION}::uuid AND identity_state = 'confirmed'`
    expect(Number(confirmedRows[0]!.count)).toBe(2)

    // A PROVISIONAL instance (emit-on-install enroll, no sign-in yet) must stamp
    // 'provisional' onto every record the joiner writes for it.
    await t.client.unsafe(`
      INSERT INTO instance_attestation
        (instance_id, principal_oid, principal_email, teammate_id, project_code_hash,
         raw_project_code, tool, session_token_hash, ts_start, ts_actual_end,
         region_id, org_unit_id, cost_owning_unit_id, identity_state, claimed_email)
      VALUES
        ('99999999-9999-9999-9999-999999999999', 'oid', 'dev@i.com',
         '33333333-3333-3333-3333-333333333333', 'h-afl-aii', 'CSL-AII',
         'claude-code', 'hashP', '2026-05-24 10:00:00+00', '2026-05-24 10:30:00+00',
         '11111111-1111-1111-1111-111111111111', '22222222-2222-2222-2222-222222222222',
         '22222222-2222-2222-2222-222222222222', 'provisional', 'dev@i.com');
    `)
    const PROVISIONAL = '99999999-9999-9999-9999-999999999999'
    const reader = new StubReader(
      new Map([
        [PROVISIONAL, [{ tokens: 100, tokenType: 'input', model: 'claude-sonnet-4-7', tsEvent: '2026-05-24T10:10:00Z', projectCodeHash: 'h-afl-aii' }]],
      ]),
    ) as unknown as TelemetryReader

    const result = await runReadJoiner(t.db, reader, { sessionIds: [PROVISIONAL] })
    expect(result.attributionRowsWritten).toBe(1)
    const rows = await t.client<{ identity_state: string }[]>`
      SELECT identity_state FROM attribution_record WHERE instance_id = ${PROVISIONAL}::uuid`
    expect(rows[0]!.identity_state).toBe('provisional')
  })

  it('membership gate: spills (withholds + audits) when the teammate is NOT assigned to the tagged project', async () => {
    // A project the teammate is NOT a member of, plus a session tagged to it.
    // "Tag proposes, membership disposes" — the project attribution is withheld
    // (surfaces as untagged spend at reconciliation) and the rejection audited.
    await t.client.unsafe(`
      INSERT INTO project (id, code, code_hash, display_name, type, region_id, cost_owning_unit_id)
        VALUES ('55555555-5555-5555-5555-555555555555', 'INT-PLT', 'h-int-plt', 'Internal Platform',
                'internal', '11111111-1111-1111-1111-111111111111',
                '22222222-2222-2222-2222-222222222222');
      INSERT INTO instance_attestation
        (instance_id, principal_oid, principal_email, teammate_id, project_code_hash,
         raw_project_code, tool, session_token_hash, ts_start, ts_actual_end,
         region_id, org_unit_id, cost_owning_unit_id)
      VALUES
        ('88888888-8888-8888-8888-888888888888', 'oid', 'dev@i.com',
         '33333333-3333-3333-3333-333333333333', 'h-int-plt', 'INT-PLT',
         'claude-code', 'hashU', '2026-05-24 12:00:00+00', '2026-05-24 12:30:00+00',
         '11111111-1111-1111-1111-111111111111', '22222222-2222-2222-2222-222222222222',
         '22222222-2222-2222-2222-222222222222');
    `)
    const UNAUTH = '88888888-8888-8888-8888-888888888888'
    // B′: the emitted project hash (h-int-plt) is the CLAIM; the teammate is not
    // a member of it → spill + audit, regardless of the attestation row's hash.
    const reader = new StubReader(
      new Map([
        [UNAUTH, [{ tokens: 500, tokenType: 'input', model: 'claude-sonnet-4-7', tsEvent: '2026-05-24T12:10:00Z', projectCodeHash: 'h-int-plt' }]],
      ]),
    ) as unknown as TelemetryReader

    const result = await runReadJoiner(t.db, reader, { sessionIds: [UNAUTH] })
    expect(result.spansSpilledUnauthorized).toBe(1)
    // mig 0021: spill is now ITEMISED (project_id NULL = unallocated), not dropped.
    expect(result.attributionRowsWritten).toBe(1)

    const rows = await t.client<{ count: string; project_id: string | null }[]>`
      SELECT COUNT(*)::text AS count, MAX(project_id::text) AS project_id
      FROM attribution_record WHERE instance_id = ${UNAUTH}::uuid
    `
    expect(Number(rows[0]!.count)).toBe(1)
    expect(rows[0]!.project_id).toBeNull() // billed as unallocated, not to the project

    const audit = await t.client<{ count: string }[]>`
      SELECT COUNT(*)::text AS count FROM audit_event WHERE event_type = 'attribution-spill-unauthorized'
    `
    expect(Number(audit[0]!.count)).toBeGreaterThanOrEqual(1)
  })

  it('Journey 1: attribution flows through to a per-project sum', async () => {
    // The /me/usage query joins attribution_record per teammate + month.
    const monthStart = '2026-05-01T00:00:00Z'
    const rows = await t.client<{ project_code: string; tokens: string }[]>`
      SELECT p.code AS project_code, COALESCE(SUM(ar.tokens), 0)::text AS tokens
      FROM project p
      JOIN project_assignment pa ON pa.project_id = p.id
      LEFT JOIN attribution_record ar
        ON ar.project_id = p.id
       AND ar.teammate_id = '33333333-3333-3333-3333-333333333333'::uuid
       AND ar.ts_event >= ${monthStart}::timestamptz
      WHERE pa.teammate_id = '33333333-3333-3333-3333-333333333333'::uuid
      GROUP BY p.code
    `
    // 3000 from the two opening spans + 100 from the provisional-stamp test above:
    // identity_state is display-only and NEVER gates a per-project token sum, so a
    // provisional record bound to this teammate+project still counts toward their
    // own /me/usage total (the bill-anchored model — provisional spend is included,
    // just labeled; it's only excluded from human-paging alerts and money gates).
    expect(rows.find((r) => r.project_code === 'CSL-AII')!.tokens).toBe('3100')
  })
})

describe('runReadJoiner — ADR-0004 B′ (project from emitted telemetry, membership-gated)', () => {
  // A second project the teammate IS a member of, to prove a single DEVICE_SID
  // can attribute to multiple projects by emitted hash (per-record, not per-session).
  const PROJ2 = '99999999-9999-9999-9999-999999999999'
  const SESSION_B = 'bbbbbbbb-0000-0000-0000-00000000000b'
  // SESSION_C is the REAL device-enrol shape: an 'unassigned' row, project NULL.
  const SESSION_C = 'cccccccc-0000-0000-0000-00000000000c'

  beforeAll(async () => {
    await t.client.unsafe(`
      INSERT INTO project (id, code, code_hash, display_name, type, region_id, cost_owning_unit_id)
        VALUES ('${PROJ2}', 'BHP-ANL', 'h-bhp-anl', 'BHP · Analytics',
                'billable', '11111111-1111-1111-1111-111111111111',
                '22222222-2222-2222-2222-222222222222')
      ON CONFLICT (id) DO NOTHING;
      INSERT INTO project_assignment (project_id, teammate_id, effective)
        VALUES ('${PROJ2}', '33333333-3333-3333-3333-333333333333', '[2026-01-01, 2099-01-01)'::tstzrange)
        ON CONFLICT DO NOTHING;
      -- SESSION_B: an 'attested' device-shaped row whose own project_code_hash
      -- ('h-device') is deliberately unrelated — proving B′ ignores the row's
      -- project and attributes by the EMITTED per-record hash.
      INSERT INTO instance_attestation
        (instance_id, principal_oid, principal_email, teammate_id, project_code_hash,
         raw_project_code, tool, session_token_hash, ts_start, ts_actual_end,
         region_id, org_unit_id, cost_owning_unit_id)
      VALUES
        ('${SESSION_B}', 'oid', 'dev@i.com', '33333333-3333-3333-3333-333333333333',
         'h-device', 'DEVICE', 'claude-code', 'hashB', '2026-05-24 14:00:00+00', '2026-05-24 14:30:00+00',
         '11111111-1111-1111-1111-111111111111', '22222222-2222-2222-2222-222222222222',
         '22222222-2222-2222-2222-222222222222');
      -- SESSION_C: the REAL device-enrol shape — attestation_state='unassigned',
      -- project_code_hash + cost_owning_unit_id NULL (allowed by the 0015 CHECK
      -- only for non-attested rows). The joiner must pick it up (gate includes
      -- 'unassigned') and attribute by the EMITTED hash.
      INSERT INTO instance_attestation
        (instance_id, principal_oid, principal_email, teammate_id, project_code_hash,
         raw_project_code, tool, session_token_hash, ts_start, ts_actual_end,
         region_id, org_unit_id, cost_owning_unit_id, attestation_state)
      VALUES
        ('${SESSION_C}', 'oid', 'dev@i.com', '33333333-3333-3333-3333-333333333333',
         NULL, NULL, 'claude-code', 'hashC', '2026-05-24 15:00:00+00', '2026-05-24 15:30:00+00',
         '11111111-1111-1111-1111-111111111111', '22222222-2222-2222-2222-222222222222',
         NULL, 'unassigned');
    `)
  }, 30_000)

  it('(a) attributes a record to the project it EMITS when the teammate is a member', async () => {
    const reader = new StubReader(
      new Map([[SESSION_B, [
        { tokens: 111, tokenType: 'input', model: 'claude-sonnet-4-7', tsEvent: '2026-05-24T14:01:00Z', projectCodeHash: 'h-afl-aii' },
      ]]]),
    ) as unknown as TelemetryReader
    const res = await runReadJoiner(t.db, reader, { sessionIds: [SESSION_B] })
    expect(res.attributionRowsWritten).toBe(1)
    const rows = await t.client<{ project_id: string }[]>`
      SELECT project_id::text AS project_id FROM attribution_record
      WHERE instance_id = ${SESSION_B}::uuid AND tokens = 111`
    expect(rows[0]!.project_id).toBe('44444444-4444-4444-4444-444444444444')
  })

  it('(b) spills + audits an emitted project the teammate is NOT a member of (itemised as unallocated)', async () => {
    const before = await t.client<{ count: string }[]>`
      SELECT COUNT(*)::text AS count FROM audit_event WHERE event_type = 'attribution-spill-unauthorized'`
    const reader = new StubReader(
      new Map([[SESSION_B, [
        { tokens: 222, tokenType: 'input', model: 'claude-sonnet-4-7', tsEvent: '2026-05-24T14:02:00Z', projectCodeHash: 'h-int-plt' },
      ]]]),
    ) as unknown as TelemetryReader
    const res = await runReadJoiner(t.db, reader, { sessionIds: [SESSION_B] })
    expect(res.spansSpilledUnauthorized).toBe(1)
    // mig 0021: itemised as unallocated (project_id NULL), not dropped.
    expect(res.attributionRowsWritten).toBe(1)
    const rows = await t.client<{ count: string; project_id: string | null }[]>`
      SELECT COUNT(*)::text AS count, MAX(project_id::text) AS project_id FROM attribution_record
      WHERE instance_id = ${SESSION_B}::uuid AND tokens = 222`
    expect(Number(rows[0]!.count)).toBe(1)
    expect(rows[0]!.project_id).toBeNull()
    const after = await t.client<{ count: string }[]>`
      SELECT COUNT(*)::text AS count FROM audit_event WHERE event_type = 'attribution-spill-unauthorized'`
    expect(Number(after[0]!.count)).toBe(Number(before[0]!.count) + 1)
  })

  it('(c) two repos under one DEVICE_SID → each record attributed to its own emitted project', async () => {
    const reader = new StubReader(
      new Map([[SESSION_B, [
        { tokens: 333, tokenType: 'input', model: 'claude-sonnet-4-7', tsEvent: '2026-05-24T14:03:00Z', projectCodeHash: 'h-afl-aii' },
        { tokens: 444, tokenType: 'output', model: 'claude-sonnet-4-7', tsEvent: '2026-05-24T14:03:01Z', projectCodeHash: 'h-bhp-anl' },
      ]]]),
    ) as unknown as TelemetryReader
    const res = await runReadJoiner(t.db, reader, { sessionIds: [SESSION_B] })
    expect(res.attributionRowsWritten).toBe(2)
    const r1 = await t.client<{ project_id: string }[]>`
      SELECT project_id::text AS project_id FROM attribution_record
      WHERE instance_id = ${SESSION_B}::uuid AND tokens = 333`
    expect(r1[0]!.project_id).toBe('44444444-4444-4444-4444-444444444444')
    const r2 = await t.client<{ project_id: string; cost_owning_unit_id: string }[]>`
      SELECT project_id::text AS project_id, cost_owning_unit_id::text AS cost_owning_unit_id
      FROM attribution_record WHERE instance_id = ${SESSION_B}::uuid AND tokens = 444`
    expect(r2[0]!.project_id).toBe(PROJ2)
  })

  it('(d) a record with NO emitted project is itemised as unallocated (project_id NULL, no spill)', async () => {
    const reader = new StubReader(
      new Map([[SESSION_B, [
        { tokens: 555, tokenType: 'input', model: 'claude-sonnet-4-7', tsEvent: '2026-05-24T14:04:00Z' },
      ]]]),
    ) as unknown as TelemetryReader
    const res = await runReadJoiner(t.db, reader, { sessionIds: [SESSION_B] })
    // mig 0021: untagged is itemised (project_id NULL), not skipped. Not a spill
    // (no unauthorised project claim).
    expect(res.attributionRowsWritten).toBe(1)
    expect(res.spansSpilledUnauthorized).toBe(0)
    const rows = await t.client<{ count: string; project_id: string | null }[]>`
      SELECT COUNT(*)::text AS count, MAX(project_id::text) AS project_id FROM attribution_record
      WHERE instance_id = ${SESSION_B}::uuid AND tokens = 555`
    expect(Number(rows[0]!.count)).toBe(1)
    expect(rows[0]!.project_id).toBeNull()
  })

  it('(e) an emitted project hash matching NO registered project is audited + itemised as unallocated', async () => {
    const before = await t.client<{ count: string }[]>`
      SELECT COUNT(*)::text AS count FROM audit_event WHERE event_type = 'attribution-unknown-project'`
    const reader = new StubReader(
      new Map([[SESSION_B, [
        { tokens: 666, tokenType: 'input', model: 'claude-sonnet-4-7', tsEvent: '2026-05-24T14:05:00Z', projectCodeHash: 'h-does-not-exist' },
      ]]]),
    ) as unknown as TelemetryReader
    const res = await runReadJoiner(t.db, reader, { sessionIds: [SESSION_B] })
    // mig 0021: unknown project → itemised unallocated (project_id NULL) + audit.
    expect(res.attributionRowsWritten).toBe(1)
    expect(res.spansSpilledUnauthorized).toBe(0)
    const after = await t.client<{ count: string }[]>`
      SELECT COUNT(*)::text AS count FROM audit_event WHERE event_type = 'attribution-unknown-project'`
    expect(Number(after[0]!.count)).toBe(Number(before[0]!.count) + 1)
  })

  it('(f) an UNASSIGNED device-enrol row (project NULL) is joined and attributes by the emitted hash', async () => {
    const reader = new StubReader(
      new Map([[SESSION_C, [
        { tokens: 777, tokenType: 'input', model: 'claude-sonnet-4-7', tsEvent: '2026-05-24T15:01:00Z', projectCodeHash: 'h-afl-aii' },
      ]]]),
    ) as unknown as TelemetryReader
    const res = await runReadJoiner(t.db, reader, { sessionIds: [SESSION_C] })
    expect(res.attributionRowsWritten).toBe(1)
    const rows = await t.client<{ project_id: string }[]>`
      SELECT project_id::text AS project_id FROM attribution_record
      WHERE instance_id = ${SESSION_C}::uuid AND tokens = 777`
    expect(rows[0]!.project_id).toBe('44444444-4444-4444-4444-444444444444')
  })
})

describe('runReadJoiner — session_assignment fallback (§13)', () => {
  // One instance, two Claude conversations on it. Neither record emits a
  // project.code_hash (the device-enrol-only path). We assign ONLY convX via
  // session_assignment → the joiner must attribute convX's records to that
  // project and leave convY untagged (no attribution_record, no spill).
  const INST = 'dddddddd-0000-0000-0000-00000000000d'
  const CONV_X = 'conv-x-1111'
  const CONV_Y = 'conv-y-2222'

  beforeAll(async () => {
    await t.client.unsafe(`
      INSERT INTO instance_attestation
        (instance_id, principal_oid, principal_email, teammate_id, project_code_hash,
         raw_project_code, tool, session_token_hash, ts_start, ts_actual_end,
         region_id, org_unit_id, cost_owning_unit_id, attestation_state)
      VALUES
        ('${INST}', 'oid', 'dev@i.com', '33333333-3333-3333-3333-333333333333',
         NULL, NULL, 'claude-code', 'hashD', '2026-05-24 16:00:00+00', '2026-05-24 16:30:00+00',
         '11111111-1111-1111-1111-111111111111', '22222222-2222-2222-2222-222222222222',
         NULL, 'unassigned');
      -- Assign ONLY convX to CSL-AII (the teammate IS a member).
      INSERT INTO session_assignment (claude_session_id, teammate_id, project_id, source)
      VALUES ('${CONV_X}', '33333333-3333-3333-3333-333333333333',
              '44444444-4444-4444-4444-444444444444', 'manual');
    `)
  }, 30_000)

  it('attributes the ASSIGNED conversation; the sibling is itemised as unallocated', async () => {
    const reader = new StubReader(
      new Map([[INST, [
        { tokens: 1200, tokenType: 'input', model: 'claude-sonnet-4-7', tsEvent: '2026-05-24T16:01:00Z', claudeSessionId: CONV_X },
        { tokens: 1300, tokenType: 'input', model: 'claude-sonnet-4-7', tsEvent: '2026-05-24T16:02:00Z', claudeSessionId: CONV_Y },
      ]]]),
    ) as unknown as TelemetryReader
    const res = await runReadJoiner(t.db, reader, { sessionIds: [INST] })
    // convX → its project; convY (no hash, no assignment) → itemised unallocated.
    // Both are written now (mig 0021).
    expect(res.attributionRowsWritten).toBe(2)
    expect(res.spansSpilledUnauthorized).toBe(0)

    const x = await t.client<{ project_id: string; csid: string }[]>`
      SELECT project_id::text AS project_id, claude_session_id AS csid
      FROM attribution_record WHERE instance_id = ${INST}::uuid AND tokens = 1200`
    expect(x.length).toBe(1)
    expect(x[0]!.project_id).toBe('44444444-4444-4444-4444-444444444444')
    expect(x[0]!.csid).toBe(CONV_X)

    const y = await t.client<{ count: string; project_id: string | null }[]>`
      SELECT COUNT(*)::text AS count, MAX(project_id::text) AS project_id FROM attribution_record
      WHERE instance_id = ${INST}::uuid AND tokens = 1300`
    expect(Number(y[0]!.count)).toBe(1) // itemised…
    expect(y[0]!.project_id).toBeNull() // …as unallocated
  })

  it('spills an assignment to a project the teammate is NOT a member of (membership gate still applies)', async () => {
    // Assign convY to INT-PLT (the teammate is NOT a member of it).
    await t.client.unsafe(`
      INSERT INTO session_assignment (claude_session_id, teammate_id, project_id, source)
      VALUES ('${CONV_Y}', '33333333-3333-3333-3333-333333333333',
              '55555555-5555-5555-5555-555555555555', 'manual')
      ON CONFLICT (claude_session_id, teammate_id) DO UPDATE SET project_id = EXCLUDED.project_id;
    `)
    const reader = new StubReader(
      new Map([[INST, [
        { tokens: 1400, tokenType: 'input', model: 'claude-sonnet-4-7', tsEvent: '2026-05-24T16:03:00Z', claudeSessionId: CONV_Y },
      ]]]),
    ) as unknown as TelemetryReader
    const res = await runReadJoiner(t.db, reader, { sessionIds: [INST] })
    expect(res.spansSpilledUnauthorized).toBe(1)
    // mig 0021: spill is itemised as unallocated (project_id NULL), not dropped.
    const y = await t.client<{ count: string; project_id: string | null }[]>`
      SELECT COUNT(*)::text AS count, MAX(project_id::text) AS project_id FROM attribution_record
      WHERE instance_id = ${INST}::uuid AND tokens = 1400`
    expect(Number(y[0]!.count)).toBe(1)
    expect(y[0]!.project_id).toBeNull()
  })

  it('emitted hash still WINS over the assignment (B′ precedence)', async () => {
    // convX is assigned to CSL-AII, but this record EMITS h-bhp-anl — B′ wins.
    const reader = new StubReader(
      new Map([[INST, [
        { tokens: 1500, tokenType: 'input', model: 'claude-sonnet-4-7', tsEvent: '2026-05-24T16:04:00Z', claudeSessionId: CONV_X, projectCodeHash: 'h-bhp-anl' },
      ]]]),
    ) as unknown as TelemetryReader
    const res = await runReadJoiner(t.db, reader, { sessionIds: [INST] })
    expect(res.attributionRowsWritten).toBe(1)
    const r = await t.client<{ project_id: string }[]>`
      SELECT project_id::text AS project_id FROM attribution_record
      WHERE instance_id = ${INST}::uuid AND tokens = 1500`
    expect(r[0]!.project_id).toBe('99999999-9999-9999-9999-999999999999') // BHP-ANL, not CSL-AII
  })

  it('stamps the conversation activity onto newly-joined rows (mig 0020)', async () => {
    // Tag convX's activity (the CSL-AII project assignment from beforeAll stays —
    // activity is orthogonal to project).
    await t.client.unsafe(`
      UPDATE session_assignment SET activity = 'testing'
      WHERE claude_session_id = '${CONV_X}' AND teammate_id = '33333333-3333-3333-3333-333333333333';
    `)
    const reader = new StubReader(
      new Map([[INST, [
        { tokens: 1600, tokenType: 'input', model: 'claude-sonnet-4-7', tsEvent: '2026-05-24T16:05:00Z', claudeSessionId: CONV_X },
      ]]]),
    ) as unknown as TelemetryReader
    const res = await runReadJoiner(t.db, reader, { sessionIds: [INST] })
    expect(res.attributionRowsWritten).toBe(1)
    const r = await t.client<{ activity: string | null }[]>`
      SELECT activity FROM attribution_record WHERE instance_id = ${INST}::uuid AND tokens = 1600`
    expect(r[0]!.activity).toBe('testing')
  })
})

describe('session_assignment activity axis CHECK (mig 0020)', () => {
  const TM = '33333333-3333-3333-3333-333333333333'
  it('allows an activity-only assignment (project_id NULL)', async () => {
    await t.client.unsafe(`
      INSERT INTO session_assignment (claude_session_id, teammate_id, project_id, activity, source)
      VALUES ('conv-activity-only', '${TM}', NULL, 'research', 'manual')
    `)
    const r = await t.client<{ project_id: string | null; activity: string }[]>`
      SELECT project_id::text AS project_id, activity FROM session_assignment
      WHERE claude_session_id = 'conv-activity-only' AND teammate_id = ${TM}::uuid`
    expect(r[0]!.project_id).toBeNull()
    expect(r[0]!.activity).toBe('research')
  })

  it('rejects an assignment with NEITHER project nor activity (CHECK)', async () => {
    await expect(
      t.client.unsafe(`
        INSERT INTO session_assignment (claude_session_id, teammate_id, project_id, activity, source)
        VALUES ('conv-empty', '${TM}', NULL, NULL, 'manual')
      `),
    ).rejects.toThrow()
  })

  it('the project-tagged gate excludes activity-only assignments (R1 #1)', async () => {
    // The untagged/recent worklists exclude a conversation only once it has a
    // PROJECT (project_id IS NOT NULL). An activity-only tag must NOT exclude it,
    // or it vanishes from both worklists (becomes unassignable).
    const rows = await t.client<{ claude_session_id: string }[]>`
      SELECT claude_session_id FROM session_assignment
      WHERE teammate_id = ${TM}::uuid AND project_id IS NOT NULL`
    const tagged = new Set(rows.map((r) => r.claude_session_id))
    expect(tagged.has('conv-x-1111')).toBe(true) // has a project → tagged/excluded
    expect(tagged.has('conv-activity-only')).toBe(false) // activity-only → stays visible
  })
})

describe('assign re-point: already-attributed rows move to the new project (F1)', () => {
  // The bug: assign.post UPSERTs session_assignment to re-point convZ from
  // project A to B, but the joiner's dedup key omits project_id, so re-running it
  // onConflictDoNothing's and the rows stay on A. The fix: assign.post issues an
  // UPDATE re-pointing the conversation's existing attribution_record rows. This
  // test exercises that exact UPDATE (project_id + cost_owning_unit_id only).
  const INST_Z = 'eeeeeeee-0000-0000-0000-00000000000e'
  const CONV_Z = 'conv-z-3333'
  const TEAM = '33333333-3333-3333-3333-333333333333'
  const PROJ_A = '44444444-4444-4444-4444-444444444444' // CSL-AII (member)
  const PROJ_B = '99999999-9999-9999-9999-999999999999' // BHP-ANL (member)

  beforeAll(async () => {
    await t.client.unsafe(`
      INSERT INTO instance_attestation
        (instance_id, principal_oid, principal_email, teammate_id, project_code_hash,
         raw_project_code, tool, session_token_hash, ts_start, ts_actual_end,
         region_id, org_unit_id, cost_owning_unit_id, attestation_state)
      VALUES
        ('${INST_Z}', 'oid', 'dev@i.com', '${TEAM}',
         NULL, NULL, 'claude-code', 'hashZ', '2026-05-24 17:00:00+00', '2026-05-24 17:30:00+00',
         '11111111-1111-1111-1111-111111111111', '22222222-2222-2222-2222-222222222222',
         NULL, 'unassigned');
      -- First assign: convZ → CSL-AII (project A, member).
      INSERT INTO session_assignment (claude_session_id, teammate_id, project_id, source)
      VALUES ('${CONV_Z}', '${TEAM}', '${PROJ_A}', 'manual');
    `)
  }, 30_000)

  it('joiner attributes convZ to project A first', async () => {
    const reader = new StubReader(
      new Map([[INST_Z, [
        { tokens: 2100, tokenType: 'input', model: 'claude-sonnet-4-7', tsEvent: '2026-05-24T17:01:00Z', claudeSessionId: CONV_Z },
        { tokens: 2200, tokenType: 'output', model: 'claude-sonnet-4-7', tsEvent: '2026-05-24T17:01:01Z', claudeSessionId: CONV_Z },
      ]]]),
    ) as unknown as TelemetryReader
    const res = await runReadJoiner(t.db, reader, { sessionIds: [INST_Z] })
    expect(res.attributionRowsWritten).toBe(2)
    const rows = await t.client<{ project_id: string; n: string }[]>`
      SELECT project_id::text AS project_id, COUNT(*)::text AS n
      FROM attribution_record WHERE claude_session_id = ${CONV_Z} AND teammate_id = ${TEAM}::uuid
      GROUP BY project_id`
    expect(rows.length).toBe(1)
    expect(rows[0]!.project_id).toBe(PROJ_A)
    expect(Number(rows[0]!.n)).toBe(2)
  })

  it('re-pointing convZ → project B moves the existing rows (not duplicated, no stale A rows)', async () => {
    // The assign endpoint's two writes for a re-point: (1) UPSERT the assignment,
    // (2) re-point the already-attributed rows. Cost is model/rate-card-priced,
    // so it does NOT change; only project_id + cost_owning_unit_id move.
    const [pb] = await t.client<{ cou: string }[]>`
      SELECT cost_owning_unit_id::text AS cou FROM project WHERE id = ${PROJ_B}::uuid`
    await t.client.unsafe(`
      INSERT INTO session_assignment (claude_session_id, teammate_id, project_id, source)
      VALUES ('${CONV_Z}', '${TEAM}', '${PROJ_B}', 'manual')
      ON CONFLICT (claude_session_id, teammate_id)
        DO UPDATE SET project_id = EXCLUDED.project_id, source = EXCLUDED.source, created_at = now();
    `)
    await t.db.execute(sql`
      UPDATE attribution_record
         SET project_id = ${PROJ_B}::uuid, cost_owning_unit_id = ${pb!.cou}::uuid
       WHERE claude_session_id = ${CONV_Z}
         AND teammate_id = ${TEAM}::uuid
         AND project_id <> ${PROJ_B}::uuid
    `)

    const rows = await t.client<{ project_id: string; n: string }[]>`
      SELECT project_id::text AS project_id, COUNT(*)::text AS n
      FROM attribution_record WHERE claude_session_id = ${CONV_Z} AND teammate_id = ${TEAM}::uuid
      GROUP BY project_id`
    // Exactly one project group (B), still 2 rows — re-pointed, not duplicated.
    expect(rows.length).toBe(1)
    expect(rows[0]!.project_id).toBe(PROJ_B)
    expect(Number(rows[0]!.n)).toBe(2)
    // No rows left on A.
    const a = await t.client<{ count: string }[]>`
      SELECT COUNT(*)::text AS count FROM attribution_record
      WHERE claude_session_id = ${CONV_Z} AND project_id = ${PROJ_A}::uuid`
    expect(Number(a[0]!.count)).toBe(0)
  })

  it('re-running the joiner after the re-point does NOT pull the rows back to A (dedup key omits project_id)', async () => {
    // This is the bug the F1 UPDATE compensates for: the joiner would re-emit the
    // convZ→A attribution, but onConflictDoNothing keeps the re-pointed rows. The
    // assignment now points at B, so a fresh emit would attribute to B anyway.
    const reader = new StubReader(
      new Map([[INST_Z, [
        { tokens: 2100, tokenType: 'input', model: 'claude-sonnet-4-7', tsEvent: '2026-05-24T17:01:00Z', claudeSessionId: CONV_Z },
        { tokens: 2200, tokenType: 'output', model: 'claude-sonnet-4-7', tsEvent: '2026-05-24T17:01:01Z', claudeSessionId: CONV_Z },
      ]]]),
    ) as unknown as TelemetryReader
    const res = await runReadJoiner(t.db, reader, { sessionIds: [INST_Z] })
    expect(res.attributionRowsWritten).toBe(0) // dedup: nothing new written
    const rows = await t.client<{ project_id: string; n: string }[]>`
      SELECT project_id::text AS project_id, COUNT(*)::text AS n
      FROM attribution_record WHERE claude_session_id = ${CONV_Z} AND teammate_id = ${TEAM}::uuid
      GROUP BY project_id`
    expect(rows.length).toBe(1)
    expect(rows[0]!.project_id).toBe(PROJ_B) // still B
    expect(Number(rows[0]!.n)).toBe(2)
  })
})

describe('runReadJoiner — org lanes (provider_org §2.1)', () => {
  beforeAll(async () => {
    await t.client.unsafe(`
      INSERT INTO provider_org (provider, external_org_id, display_name, reconciliation_mode, billing, api_kind)
      VALUES ('anthropic', 'org-reconciled', 'Reconciled', 'reconciled', 'billed', 'claude-code-admin'),
             ('anthropic', 'org-indicative', 'Indicative', 'indicative', 'tracked', 'claude-code-admin')
      ON CONFLICT (provider, (lower(external_org_id))) DO NOTHING;
      INSERT INTO instance_attestation
        (instance_id, principal_oid, principal_email, teammate_id, project_code_hash, raw_project_code,
         tool, session_token_hash, ts_start, ts_actual_end, region_id, org_unit_id, cost_owning_unit_id)
      VALUES
        ('aaaaaaaa-0000-0000-0000-000000000001', 'oid', 'dev@i.com', '33333333-3333-3333-3333-333333333333', 'h-afl-aii', 'CSL-AII', 'claude-code', 'hA', '2026-05-24 13:00:00+00', '2026-05-24 13:30:00+00', '11111111-1111-1111-1111-111111111111', '22222222-2222-2222-2222-222222222222', '22222222-2222-2222-2222-222222222222'),
        ('aaaaaaaa-0000-0000-0000-000000000002', 'oid', 'dev@i.com', '33333333-3333-3333-3333-333333333333', 'h-afl-aii', 'CSL-AII', 'claude-code', 'hB', '2026-05-24 13:00:00+00', '2026-05-24 13:30:00+00', '11111111-1111-1111-1111-111111111111', '22222222-2222-2222-2222-222222222222', '22222222-2222-2222-2222-222222222222'),
        ('aaaaaaaa-0000-0000-0000-000000000003', 'oid', 'dev@i.com', '33333333-3333-3333-3333-333333333333', 'h-afl-aii', 'CSL-AII', 'claude-code', 'hC', '2026-05-24 13:00:00+00', '2026-05-24 13:30:00+00', '11111111-1111-1111-1111-111111111111', '22222222-2222-2222-2222-222222222222', '22222222-2222-2222-2222-222222222222');
    `)
  }, 30_000)

  const orgReader = (sid: string, org: string) =>
    new StubReader(
      new Map([[sid, [{ tokens: 100, tokenType: 'input', model: 'claude-sonnet-4-7', tsEvent: '2026-05-24T13:10:00Z', organizationId: org, projectCodeHash: 'h-afl-aii' }]]]),
    ) as unknown as TelemetryReader

  it('reconciled org → tier-1 / estimated', async () => {
    const sid = 'aaaaaaaa-0000-0000-0000-000000000001'
    await runReadJoiner(t.db, orgReader(sid, 'org-reconciled'), { sessionIds: [sid] })
    const r = await t.client<{ fidelity_tier: string; cost_basis: string }[]>`
      SELECT fidelity_tier, cost_basis FROM attribution_record WHERE instance_id = ${sid}::uuid LIMIT 1`
    expect(r[0]!.fidelity_tier).toBe('tier-1')
    expect(r[0]!.cost_basis).toBe('estimated')
  })

  it('indicative org → tier-2 / telemetry-only', async () => {
    const sid = 'aaaaaaaa-0000-0000-0000-000000000002'
    await runReadJoiner(t.db, orgReader(sid, 'org-indicative'), { sessionIds: [sid] })
    const r = await t.client<{ fidelity_tier: string; cost_basis: string }[]>`
      SELECT fidelity_tier, cost_basis FROM attribution_record WHERE instance_id = ${sid}::uuid LIMIT 1`
    expect(r[0]!.fidelity_tier).toBe('tier-2')
    expect(r[0]!.cost_basis).toBe('telemetry-only')
  })

  it('unknown org → telemetry-only + flagged for classification', async () => {
    const sid = 'aaaaaaaa-0000-0000-0000-000000000003'
    await runReadJoiner(t.db, orgReader(sid, 'org-mystery'), { sessionIds: [sid] })
    const r = await t.client<{ cost_basis: string }[]>`
      SELECT cost_basis FROM attribution_record WHERE instance_id = ${sid}::uuid LIMIT 1`
    expect(r[0]!.cost_basis).toBe('telemetry-only')
    const audit = await t.client<{ count: string }[]>`
      SELECT COUNT(*)::text AS count FROM audit_event WHERE event_type = 'attribution-org-unclassified'`
    expect(Number(audit[0]!.count)).toBeGreaterThanOrEqual(1)
  })

  it('an OVER-LONG org id still picks its lane, while emitting_org_id stores nothing', async () => {
    /*
     * mig 0119 bounded organization.id for STORAGE (emitting_org_id, 128 chars).
     * The lane operand must not inherit that bound: this record's org is
     * registered `indicative`, so the correct outcome is tier-2/telemetry-only,
     * and a dropped operand would leave the joiner's tier-1/estimated DEFAULT —
     * PROMOTING an indicative org's spend into reconciliation because a
     * diagnostic column has a length limit.
     *
     * The record is the exact shape the parser now produces for such a value:
     * `organizationId` raw, `emittingOrgId` absent (server/azure/reader.ts).
     *
     * MUTATIONS, one per half:
     *   - lane reads the bounded field (`u.emittingOrgId` at
     *     azure-monitor-reader.ts's org-lane block) → tier-1/estimated → red
     *   - the write reads the raw field (`rec.organizationId` at the
     *     emittingOrgId insert) → emitting_org_id holds 200 chars → red
     */
    const LONG_ORG = `org-indicative-${'x'.repeat(185)}` // 200 chars, control-free
    expect(LONG_ORG.length).toBeGreaterThan(128)
    const sid = 'aaaaaaaa-0000-0000-0000-000000000004'
    await t.client.unsafe(`
      INSERT INTO provider_org (provider, external_org_id, display_name, reconciliation_mode, billing, api_kind)
      VALUES ('anthropic', '${LONG_ORG}', 'Long Indicative', 'indicative', 'tracked', 'claude-code-admin')
      ON CONFLICT (provider, (lower(external_org_id))) DO NOTHING;
      INSERT INTO instance_attestation
        (instance_id, principal_oid, principal_email, teammate_id, project_code_hash, raw_project_code,
         tool, session_token_hash, ts_start, ts_actual_end, region_id, org_unit_id, cost_owning_unit_id)
      VALUES
        ('${sid}', 'oid', 'dev@i.com', '33333333-3333-3333-3333-333333333333', 'h-afl-aii', 'CSL-AII',
         'claude-code', 'hD', '2026-05-24 13:00:00+00', '2026-05-24 13:30:00+00',
         '11111111-1111-1111-1111-111111111111', '22222222-2222-2222-2222-222222222222',
         '22222222-2222-2222-2222-222222222222');
    `)

    await runReadJoiner(t.db, orgReader(sid, LONG_ORG), { sessionIds: [sid] })

    const r = await t.client<{ fidelity_tier: string; cost_basis: string; emitting_org_id: string | null }[]>`
      SELECT fidelity_tier, cost_basis, emitting_org_id
        FROM attribution_record WHERE instance_id = ${sid}::uuid LIMIT 1`
    expect(r).toHaveLength(1)
    expect([r[0]!.fidelity_tier, r[0]!.cost_basis]).toEqual(['tier-2', 'telemetry-only'])
    expect(r[0]!.emitting_org_id).toBeNull()
  })
})

describe('runMitigationQuery', () => {
  it('writes a instance_attestation_health row for ended sessions with no attribution_record', async () => {
    // Insert a second session that ended but has NO spans.
    await t.client.unsafe(`
      INSERT INTO instance_attestation
        (instance_id, principal_oid, principal_email, teammate_id, project_code_hash,
         raw_project_code, tool, session_token_hash, ts_start, ts_actual_end,
         region_id, org_unit_id, cost_owning_unit_id)
      VALUES
        ('77777777-7777-7777-7777-777777777777', 'oid', 'dev@i.com',
         '33333333-3333-3333-3333-333333333333', 'h-afl-aii', 'CSL-AII',
         'claude-code', 'hashT', '2026-05-24 11:00:00+00', '2026-05-24 11:30:00+00',
         '11111111-1111-1111-1111-111111111111', '22222222-2222-2222-2222-222222222222',
         '22222222-2222-2222-2222-222222222222');
    `)

    const result = await runMitigationQuery(t.db)
    expect(result.newHealthRows).toBeGreaterThanOrEqual(1)

    const healthRows = await t.client<{ instance_id: string; status: string }[]>`
      SELECT instance_id::text AS instance_id, status FROM instance_attestation_health
    `
    const target = healthRows.find((r) => r.instance_id === '77777777-7777-7777-7777-777777777777')
    expect(target?.status).toBe('no-spans-received')
  })

  it('does not duplicate health rows on a second run for the same gap', async () => {
    const before = await t.client<{ count: string }[]>`
      SELECT COUNT(*)::text AS count FROM instance_attestation_health
    `
    await runMitigationQuery(t.db)
    const after = await t.client<{ count: string }[]>`
      SELECT COUNT(*)::text AS count FROM instance_attestation_health
    `
    expect(after[0]!.count).toBe(before[0]!.count)
  })
})

describe('selectRecentJoinableSessionIds (registry azure-monitor-read pre-query)', () => {
  // Regression guard for the scheduler tick's column/window/active contract.
  // The registry wrapper has no DI seam, so a wrong column (the old
  // `sa.created_at`, which does NOT exist — the column is `ts_start`) threw on
  // EVERY scheduled run, yet the suite never caught it (every other test calls
  // runReadJoiner directly with explicit sessionIds). This exercises the real
  // SQL against the live schema.
  const ACTIVE = '77777777-0000-0000-0000-000000000001' // active, started 1h ago
  const LONG_ACTIVE = '77777777-0000-0000-0000-000000000002' // active, started 10 DAYS ago (days/weeks case)
  const DEAD_ACTIVE = '77777777-0000-0000-0000-000000000003' // active but ts_start 40d ago — past the cap
  const ENDED_UNATTRIB = '77777777-0000-0000-0000-000000000004' // ended recently, not yet attributed
  const ENDED_OLD = '77777777-0000-0000-0000-000000000005' // ended, ts_start 48h ago — outside the window
  // The 2026-07-24 dead-zone outage: open, enrolled 40 DAYS ago (past the age cap)
  // but minting bearers RIGHT NOW — i.e. actively emitting. Must be joinable.
  const AGED_LIVE = '77777777-0000-0000-0000-000000000006'
  // Same age, but its last bearer mint is 30 DAYS old — genuinely dormant, must NOT
  // be scanned (the liveness window has to stay bounded).
  const AGED_DORMANT = '77777777-0000-0000-0000-000000000007'
  // Aged + live bearer, but its teammate was revoked after enrolment (E2, ADR-0005).
  // Liveness must NOT become a bypass for revocation.
  const AGED_LIVE_REVOKED = '77777777-0000-0000-0000-000000000008'
  const REVOKED_TEAMMATE = '33333333-0000-0000-0000-000000000001'

  beforeAll(async () => {
    await t.client.unsafe(`
      INSERT INTO instance_attestation
        (instance_id, principal_oid, principal_email, teammate_id, project_code_hash,
         raw_project_code, tool, session_token_hash, ts_start, ts_actual_end,
         region_id, org_unit_id, cost_owning_unit_id)
      VALUES
        ('${ACTIVE}', 'oid', 'dev@i.com', '33333333-3333-3333-3333-333333333333', 'h-afl-aii', 'CSL-AII',
         'claude-code', 'hActive', NOW() - INTERVAL '1 hour', NULL,
         '11111111-1111-1111-1111-111111111111', '22222222-2222-2222-2222-222222222222', '22222222-2222-2222-2222-222222222222'),
        ('${LONG_ACTIVE}', 'oid', 'dev@i.com', '33333333-3333-3333-3333-333333333333', 'h-afl-aii', 'CSL-AII',
         'claude-code', 'hLong', NOW() - INTERVAL '10 days', NULL,
         '11111111-1111-1111-1111-111111111111', '22222222-2222-2222-2222-222222222222', '22222222-2222-2222-2222-222222222222'),
        ('${DEAD_ACTIVE}', 'oid', 'dev@i.com', '33333333-3333-3333-3333-333333333333', 'h-afl-aii', 'CSL-AII',
         'claude-code', 'hDead', NOW() - INTERVAL '40 days', NULL,
         '11111111-1111-1111-1111-111111111111', '22222222-2222-2222-2222-222222222222', '22222222-2222-2222-2222-222222222222'),
        ('${ENDED_UNATTRIB}', 'oid', 'dev@i.com', '33333333-3333-3333-3333-333333333333', 'h-afl-aii', 'CSL-AII',
         'claude-code', 'hEndU', NOW() - INTERVAL '2 hours', NOW() - INTERVAL '1 hour',
         '11111111-1111-1111-1111-111111111111', '22222222-2222-2222-2222-222222222222', '22222222-2222-2222-2222-222222222222'),
        ('${ENDED_OLD}', 'oid', 'dev@i.com', '33333333-3333-3333-3333-333333333333', 'h-afl-aii', 'CSL-AII',
         'claude-code', 'hEndO', NOW() - INTERVAL '48 hours', NOW() - INTERVAL '47 hours',
         '11111111-1111-1111-1111-111111111111', '22222222-2222-2222-2222-222222222222', '22222222-2222-2222-2222-222222222222');

      -- A teammate revoked AFTER the enrolment below, for the E2 bypass check.
      INSERT INTO teammate (id, entra_oid, email, region_id, org_unit_id, revoked_at)
        VALUES ('${REVOKED_TEAMMATE}', 'oid-revoked', 'revoked@i.com',
                '11111111-1111-1111-1111-111111111111', '22222222-2222-2222-2222-222222222222',
                NOW() - INTERVAL '1 day');

      INSERT INTO instance_attestation
        (instance_id, principal_oid, principal_email, teammate_id, project_code_hash,
         raw_project_code, tool, session_token_hash, ts_start, ts_actual_end, last_bearer_at,
         region_id, org_unit_id, cost_owning_unit_id)
      VALUES
        ('${AGED_LIVE}', 'oid', 'dev@i.com', '33333333-3333-3333-3333-333333333333', 'h-afl-aii', 'CSL-AII',
         'claude-code', 'hAgedLive', NOW() - INTERVAL '40 days', NULL, NOW() - INTERVAL '1 hour',
         '11111111-1111-1111-1111-111111111111', '22222222-2222-2222-2222-222222222222', '22222222-2222-2222-2222-222222222222'),
        ('${AGED_DORMANT}', 'oid', 'dev@i.com', '33333333-3333-3333-3333-333333333333', 'h-afl-aii', 'CSL-AII',
         'claude-code', 'hAgedDorm', NOW() - INTERVAL '40 days', NULL, NOW() - INTERVAL '30 days',
         '11111111-1111-1111-1111-111111111111', '22222222-2222-2222-2222-222222222222', '22222222-2222-2222-2222-222222222222'),
        ('${AGED_LIVE_REVOKED}', 'oid-revoked', 'revoked@i.com', '${REVOKED_TEAMMATE}', 'h-afl-aii', 'CSL-AII',
         'claude-code', 'hAgedRev', NOW() - INTERVAL '40 days', NULL, NOW() - INTERVAL '1 hour',
         '11111111-1111-1111-1111-111111111111', '22222222-2222-2222-2222-222222222222', '22222222-2222-2222-2222-222222222222');
    `)
  }, 30_000)

  it('includes active sessions of any age within the cap (days/weeks), one-shots recent unattributed, drops the rest', async () => {
    const ids = await selectRecentJoinableSessionIds(t.db)
    expect(ids).toContain(ACTIVE)
    expect(ids).toContain(LONG_ACTIVE) // 10d-old but still active → keeps tracking
    expect(ids).toContain(ENDED_UNATTRIB)
    expect(ids).not.toContain(DEAD_ACTIVE) // past the age cap AND never minted a bearer → dormant
    expect(ids).not.toContain(ENDED_OLD) // ended + outside the window
  })

  // ── The 2026-07-24 dead-zone outage ────────────────────────────────────────
  // Enrolment age is NOT liveness. An open instance past `activeMaxAgeHours` that
  // is still emitting matched no clause, so its spend was accepted by the DCE
  // (HTTP 204) and never joined — silently, with emit-auth reporting healthy the
  // whole time. session-gc could not rescue it either: it closes on
  // ts_expected_end = REFRESH_TOKEN_TTL_MS (90d), 3x the 30d cap, so days 30..90
  // were unreachable by every clause.

  it('DEAD ZONE: scans an AGED, still-emitting instance (recent bearer mint beats enrolment age)', async () => {
    const ids = await selectRecentJoinableSessionIds(t.db)
    expect(ids).toContain(AGED_LIVE)
  })

  it('DEAD ZONE: keeps scanning it once it HAS attribution (not rescued by the never-attributed clause)', async () => {
    // The real outage instance had months of old attribution_records, so the
    // "ended/unknown but NEVER attributed" one-shot could never have covered it.
    // Attribute it, then confirm liveness — not that clause — keeps it selected.
    const reader = new StubReader(
      new Map([
        [AGED_LIVE, [{ tokens: 900, tokenType: 'input', model: 'claude-sonnet-4-7', tsEvent: '2026-06-02T08:00:00Z', projectCodeHash: 'h-afl-aii' }]],
      ]),
    ) as unknown as TelemetryReader
    try {
      const res = await runReadJoiner(t.db, reader, { sessionIds: [AGED_LIVE] })
      expect(res.attributionRowsWritten).toBeGreaterThan(0)
      expect(await selectRecentJoinableSessionIds(t.db)).toContain(AGED_LIVE)
    } finally {
      // Do not leak this write into sibling tests: without cleanup the block
      // only passes in declaration order, and a reorder/.only turns it into a flake.
      await t.client.unsafe(`DELETE FROM attribution_record WHERE instance_id = '${AGED_LIVE}'`)
    }
  })

  it('bounds liveness: an aged instance whose last bearer mint is outside the window is NOT scanned', async () => {
    // Liveness must not degrade into "scan every open instance forever".
    expect(await selectRecentJoinableSessionIds(t.db)).not.toContain(AGED_DORMANT)
  })

  it('liveness is NOT a revocation bypass: an aged+live instance of a revoked teammate stays excluded (E2)', async () => {
    expect(await selectRecentJoinableSessionIds(t.db)).not.toContain(AGED_LIVE_REVOKED)
  })

  it('CAP ORDERING: a live aged instance outranks a NEWER, less-recently-active one and survives the cap', async () => {
    // R1 caught the earlier version of this test being VACUOUS: with fewer
    // joinable rows than the limit the LIMIT never truncated, so it passed with
    // the ORDER BY reverted. This version forces truncation — it inserts its own
    // isolated cohort and asserts with limit = cohort-1, so exactly one row MUST
    // be shed. Reverting the ORDER BY to `ts_start DESC` fails it: CAP_NEW_IDLE
    // (enrolled most recently, never minted) would win on enrolment date and
    // evict CAP_OLD_LIVE, which is the instance actually emitting.
    const CAP_OLD_LIVE = '77777777-0000-0000-0000-0000000000c1' // enrolled 50d ago, minted 5 MIN ago
    const CAP_NEW_IDLE = '77777777-0000-0000-0000-0000000000c2' // enrolled 2h ago, NEVER minted
    await t.client.unsafe(`
      INSERT INTO instance_attestation
        (instance_id, principal_oid, principal_email, teammate_id, project_code_hash,
         raw_project_code, tool, session_token_hash, ts_start, ts_actual_end, last_bearer_at,
         region_id, org_unit_id, cost_owning_unit_id)
      VALUES
        ('${CAP_OLD_LIVE}', 'oid', 'dev@i.com', '33333333-3333-3333-3333-333333333333', 'h-afl-aii', 'CSL-AII',
         'claude-code', 'hCapLive', NOW() - INTERVAL '50 days', NULL, NOW() - INTERVAL '5 minutes',
         '11111111-1111-1111-1111-111111111111', '22222222-2222-2222-2222-222222222222', '22222222-2222-2222-2222-222222222222'),
        ('${CAP_NEW_IDLE}', 'oid', 'dev@i.com', '33333333-3333-3333-3333-333333333333', 'h-afl-aii', 'CSL-AII',
         'claude-code', 'hCapIdle', NOW() - INTERVAL '2 hours', NULL, NULL,
         '11111111-1111-1111-1111-111111111111', '22222222-2222-2222-2222-222222222222', '22222222-2222-2222-2222-222222222222');
    `)
    try {
      // Both are joinable on their own; RANK is what the cap then acts on.
      // Assert the ordering head-to-head rather than via an arbitrary limit —
      // the suite's other fixture rows (and closed rows, which always sort last)
      // otherwise decide which row the cap sheds.
      const uncapped = await selectRecentJoinableSessionIds(t.db)
      const iLive = uncapped.indexOf(CAP_OLD_LIVE)
      const iIdle = uncapped.indexOf(CAP_NEW_IDLE)
      expect(iLive).toBeGreaterThanOrEqual(0)
      expect(iIdle).toBeGreaterThanOrEqual(0)
      // THE INVARIANT: emitting 5 minutes ago outranks enrolled 2 hours ago.
      // Under `ORDER BY ts_start DESC` this inverts and the assertion fails.
      expect(iLive).toBeLessThan(iIdle)

      // And the consequence that matters: a cap falling between them keeps the
      // live instance and sheds the idle one.
      const cappedSel = await selectJoinableInstances(t.db, { limit: iIdle })
      const capped = cappedSel.ids
      expect(capped).toContain(CAP_OLD_LIVE) // emitting now → survives despite a 50d enrolment
      expect(capped).not.toContain(CAP_NEW_IDLE) // newer enrolment, zero activity → shed first
      // The cap-hit signal itself (every other test sees it only via a mock):
      // truncation MUST report the cap, and an untruncated selection must not.
      expect(cappedSel.capHit).toBe(iIdle)
      expect((await selectJoinableInstances(t.db)).capHit).toBeNull()
    } finally {
      await t.client.unsafe(`DELETE FROM instance_attestation WHERE instance_id IN ('${CAP_OLD_LIVE}', '${CAP_NEW_IDLE}')`)
    }
  })

  it('CAP ORDERING: a burst of recently-closed instances never evicts a live one (the standing R1 invariant)', async () => {
    // Pre-existing invariant, previously unpinned: closed rows sort after open
    // ones, so a wave of closures cannot starve a still-emitting instance.
    const LIVE = '77777777-0000-0000-0000-0000000000d0'
    const closed = ['d1', 'd2', 'd3'].map((s) => `77777777-0000-0000-0000-0000000000${s}`)
    await t.client.unsafe(`
      INSERT INTO instance_attestation
        (instance_id, principal_oid, principal_email, teammate_id, project_code_hash,
         raw_project_code, tool, session_token_hash, ts_start, ts_actual_end, last_bearer_at,
         region_id, org_unit_id, cost_owning_unit_id)
      VALUES
        ('${LIVE}', 'oid', 'dev@i.com', '33333333-3333-3333-3333-333333333333', 'h-afl-aii', 'CSL-AII',
         'claude-code', 'hCapL', NOW() - INTERVAL '50 days', NULL, NOW() - INTERVAL '2 minutes',
         '11111111-1111-1111-1111-111111111111', '22222222-2222-2222-2222-222222222222', '22222222-2222-2222-2222-222222222222'),
        ${closed
          .map(
            (id, i) => `('${id}', 'oid', 'dev@i.com', '33333333-3333-3333-3333-333333333333', 'h-afl-aii', 'CSL-AII',
         'claude-code', 'hCapC${i}', NOW() - INTERVAL '3 hours', NOW() - INTERVAL '${i + 1} minutes', NOW() - INTERVAL '1 minute',
         '11111111-1111-1111-1111-111111111111', '22222222-2222-2222-2222-222222222222', '22222222-2222-2222-2222-222222222222')`,
          )
          .join(',\n        ')};
    `)
    try {
      // Cap at 1: the single survivor must be an OPEN row, never one of the
      // just-closed ones (which have fresher ts_actual_end / bearer stamps).
      const capped = await selectRecentJoinableSessionIds(t.db, { limit: 1 })
      expect(capped).toHaveLength(1)
      for (const id of closed) expect(capped).not.toContain(id)
    } finally {
      await t.client.unsafe(
        `DELETE FROM instance_attestation WHERE instance_id IN ('${LIVE}', ${closed.map((c) => `'${c}'`).join(', ')})`,
      )
    }
  })

  it('CAP ORDERING: a provisional flood above the cap never displaces a confirmed emitting device (CS-EDGE-01)', async () => {
    // The flood is fresher on every other key (enrolled and minted NOW), so
    // only the confirmed-before-provisional rank keeps CONFIRMED under the cap.
    const CONFIRMED = '9a1e0000-0000-4000-8000-0000000000f0'
    const flood = [1, 2, 3, 4, 5, 6].map((i) => `9a1e0000-0000-4000-8000-0000000000f${i}`)
    await t.client.unsafe(`
      INSERT INTO instance_attestation
        (instance_id, principal_oid, principal_email, teammate_id, project_code_hash,
         raw_project_code, tool, session_token_hash, ts_start, ts_actual_end, last_bearer_at,
         region_id, org_unit_id, cost_owning_unit_id, identity_state, claimed_email, attestation_state)
      VALUES
        ('${CONFIRMED}', 'oid', 'dev@i.com', '33333333-3333-3333-3333-333333333333', 'h-afl-aii', 'CSL-AII',
         'claude-code', 'hFloodConf', NOW() - INTERVAL '20 days', NULL, NOW() - INTERVAL '1 minute',
         '11111111-1111-1111-1111-111111111111', '22222222-2222-2222-2222-222222222222', '22222222-2222-2222-2222-222222222222',
         'confirmed', NULL, 'attested'),
        ${flood
          .map(
            (id, i) => `('${id}', 'provisional:${id}', NULL, '33333333-3333-3333-3333-333333333333', NULL, NULL,
         'claude-code', 'hFloodProv${i}', NOW(), NULL, NOW(),
         '11111111-1111-1111-1111-111111111111', '22222222-2222-2222-2222-222222222222', '22222222-2222-2222-2222-222222222222',
         'provisional', 'flood-${i}@x.test', 'unassigned')`,
          )
          .join(',\n        ')};
    `)
    const prior = process.env.NUXT_JOINER_INSTANCE_CAP
    process.env.NUXT_JOINER_INSTANCE_CAP = '3'
    try {
      const sel = await selectJoinableInstances(t.db)
      // Vacuity guard: the flood alone exceeds the cap, so truncation happened.
      expect(sel.capHit).toBe(3)
      expect(sel.ids).toContain(CONFIRMED)
      for (const id of flood) expect(sel.ids).not.toContain(id)
    } finally {
      if (prior === undefined) delete process.env.NUXT_JOINER_INSTANCE_CAP
      else process.env.NUXT_JOINER_INSTANCE_CAP = prior
      await t.client.unsafe(
        `DELETE FROM instance_attestation WHERE instance_id IN ('${CONFIRMED}', ${flood.map((f) => `'${f}'`).join(', ')})`,
      )
    }
  })

  it('a never-minted OPEN instance ranks by ts_start and does NOT float above live ones', async () => {
    // COALESCE(last_bearer_at, ts_start) must rank a never-minted row by its
    // enrolment date. If it sorted NULLS FIRST instead, every never-minted row
    // would float to the head of the cap and starve the instances that are
    // actually emitting. Asserted by RANK against a known-live row, not by a
    // COUNT(*) that the NOT NULL constraint already guarantees.
    const OLD_NEVER = '77777777-0000-0000-0000-0000000000e1' // enrolled 10 min ago, never minted
    await t.client.unsafe(`
      INSERT INTO instance_attestation
        (instance_id, principal_oid, principal_email, teammate_id, project_code_hash,
         raw_project_code, tool, session_token_hash, ts_start, ts_actual_end, last_bearer_at,
         region_id, org_unit_id, cost_owning_unit_id)
      VALUES
        ('${OLD_NEVER}', 'oid', 'dev@i.com', '33333333-3333-3333-3333-333333333333', 'h-afl-aii', 'CSL-AII',
         'claude-code', 'hNever', NOW() - INTERVAL '10 minutes', NULL, NULL,
         '11111111-1111-1111-1111-111111111111', '22222222-2222-2222-2222-222222222222', '22222222-2222-2222-2222-222222222222');
    `)
    try {
      const ids = await selectRecentJoinableSessionIds(t.db)
      expect(ids).toContain(OLD_NEVER) // fresh enrolment is still selected (age clause)
      // AGED_LIVE minted 1h ago; OLD_NEVER enrolled 10 min ago. Ranking by
      // ts_start alone would put OLD_NEVER first; ranking by activity keeps the
      // 10-min-old enrolment ahead only because its ts_start IS its activity.
      // The load-bearing assertion is that it does not sort as NULL/unknown.
      expect(ids.indexOf(OLD_NEVER)).toBeGreaterThanOrEqual(0)
      expect(ids.indexOf(OLD_NEVER)).toBeLessThan(ids.indexOf(LONG_ACTIVE)) // 10 min > 10 days old
    } finally {
      await t.client.unsafe(`DELETE FROM instance_attestation WHERE instance_id = '${OLD_NEVER}'`)
    }
  })

  it('liveness knob: out-of-range overrides clamp instead of disabling the clause or throwing', async () => {
    // Floor: 0/negative/NaN would make the predicate `>= NOW()` — never true —
    // silently re-opening the dead zone.
    for (const bad of [0, -1, Number.NaN]) {
      expect(await selectRecentJoinableSessionIds(t.db, { liveBearerHours: bad })).toContain(AGED_LIVE)
    }
    // A legitimate tightening still takes effect: 1h excludes the 1h-old mint.
    expect(await selectRecentJoinableSessionIds(t.db, { liveBearerHours: 1 })).not.toContain(AGED_LIVE)
  })

  it('the RESULT carries the evidence fields (scoped + the window the READER applied)', async () => {
    // These are what an operator checks to tell a real 90-day scoped recovery
    // from a silently-downgraded default tick. Asserted on the RETURNED result,
    // not on the options passed in — the registry test mocks runReadJoiner, so
    // nothing else proves the values survive the return.
    const plain = await runReadJoiner(t.db, new StubReader(new Map()) as unknown as TelemetryReader, { sessionIds: [ACTIVE] })
    expect(plain.scoped).toBe(false)
    // A stub reader exposes no appliedLookbackDays → null, never a fabricated window.
    expect(plain.lookbackDaysApplied).toBeNull()

    const scoped = await runReadJoiner(t.db, new StubReader(new Map()) as unknown as TelemetryReader, {
      sessionIds: [ACTIVE],
      scoped: true,
    })
    expect(scoped.scoped).toBe(true)

    // The cap-hit echo is the third evidence field and the one runbook §4 queries.
    // Zeroing it would silence "live instances went unscanned" forever.
    expect(plain.selectionCapHit).toBeNull()
    const capped = await runReadJoiner(t.db, new StubReader(new Map()) as unknown as TelemetryReader, {
      sessionIds: [ACTIVE],
      selectionCapHit: 500,
    })
    expect(capped.selectionCapHit).toBe(500)

    // A reader that DOES declare a window has it reported verbatim.
    const widened = Object.assign(new StubReader(new Map()), { appliedLookbackDays: 90 })
    const rec = await runReadJoiner(t.db, widened as unknown as TelemetryReader, { sessionIds: [ACTIVE], scoped: true })
    expect(rec.lookbackDaysApplied).toBe(90)
  })

  it('an explicit sessionIds run SKIPS a purged instance (the override feeds caller-supplied ids)', async () => {
    // The scheduled selection gates on ts_purged; this branch takes ids straight
    // from its caller, and since the operator recovery override those ids no
    // longer necessarily passed that gate.
    const PURGED = '77777777-0000-0000-0000-0000000000e9'
    await t.client.unsafe(`
      INSERT INTO instance_attestation
        (instance_id, principal_oid, principal_email, teammate_id, project_code_hash,
         raw_project_code, tool, session_token_hash, ts_start, ts_actual_end, last_bearer_at, ts_purged,
         region_id, org_unit_id, cost_owning_unit_id)
      VALUES
        ('${PURGED}', 'oid', 'dev@i.com', '33333333-3333-3333-3333-333333333333', 'h-afl-aii', 'CSL-AII',
         'claude-code', 'hPurged', NOW() - INTERVAL '40 days', NULL, NOW() - INTERVAL '1 hour', NOW() - INTERVAL '1 day',
         '11111111-1111-1111-1111-111111111111', '22222222-2222-2222-2222-222222222222', '22222222-2222-2222-2222-222222222222');
    `)
    const reader = new StubReader(
      new Map([
        [PURGED, [{ tokens: 100, tokenType: 'input', model: 'claude-sonnet-4-7', tsEvent: new Date().toISOString(), projectCodeHash: 'h-afl-aii' }]],
      ]),
    ) as unknown as TelemetryReader
    try {
      const res = await runReadJoiner(t.db, reader, { sessionIds: [PURGED] })
      expect(res.sessionsProcessed).toBe(0) // gate held
      expect((reader as unknown as StubReader).calls).toHaveLength(0) // never even read
    } finally {
      await t.client.unsafe(`DELETE FROM instance_attestation WHERE instance_id = '${PURGED}'`)
    }
  })

  it('runReadJoiner WINDOW path (no sessionIds) also selects an aged+live instance', async () => {
    // The joiner's own fallback query carries a second copy of the selection
    // predicate. Every production caller passes explicit sessionIds, so this
    // branch is dead today — and therefore was completely untested: R3 proved
    // deleting its liveness disjunct left the whole integration suite green.
    // Pinned so a future caller does not inherit the dead zone.
    const WIN_LIVE = '77777777-0000-0000-0000-0000000000f2'
    await t.client.unsafe(`
      INSERT INTO instance_attestation
        (instance_id, principal_oid, principal_email, teammate_id, project_code_hash,
         raw_project_code, tool, session_token_hash, ts_start, ts_actual_end, last_bearer_at,
         region_id, org_unit_id, cost_owning_unit_id)
      VALUES
        ('${WIN_LIVE}', 'oid', 'dev@i.com', '33333333-3333-3333-3333-333333333333', 'h-afl-aii', 'CSL-AII',
         'claude-code', 'hWinLive', NOW() - INTERVAL '60 days', NULL, NOW() - INTERVAL '10 minutes',
         '11111111-1111-1111-1111-111111111111', '22222222-2222-2222-2222-222222222222', '22222222-2222-2222-2222-222222222222');
    `)
    const reader = new StubReader(
      new Map([
        [WIN_LIVE, [{ tokens: 400, tokenType: 'input', model: 'claude-sonnet-4-7', tsEvent: new Date().toISOString(), projectCodeHash: 'h-afl-aii' }]],
      ]),
    ) as unknown as TelemetryReader
    try {
      // No sessionIds → the window query decides. Enrolled 60d ago, so only the
      // liveness disjunct can select it.
      await runReadJoiner(t.db, reader, {})
      expect((reader as unknown as StubReader).calls.map((c) => c.sessionId)).toContain(WIN_LIVE)
    } finally {
      await t.client.unsafe(`DELETE FROM attribution_record WHERE instance_id = '${WIN_LIVE}'`)
      await t.client.unsafe(`DELETE FROM instance_attestation WHERE instance_id = '${WIN_LIVE}'`)
    }
  })

  it('liveness knob: the NUXT_JOINER_LIVE_BEARER_HOURS env override actually takes effect', async () => {
    // Documented in CONFIGURATION.md and .env.example but exercised by nothing —
    // R6 proved the whole env path could be made inert with the suite green.
    const saved = process.env.NUXT_JOINER_LIVE_BEARER_HOURS
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    try {
      // A valid override tightens the window: 1h excludes the 1h-old mint.
      process.env.NUXT_JOINER_LIVE_BEARER_HOURS = '1'
      expect(await selectRecentJoinableSessionIds(t.db)).not.toContain(AGED_LIVE)

      // A TYPO must warn and fall back to the default (which does include it) —
      // silently ignoring a mistyped dead-zone guard is this branch's own bug class.
      warn.mockClear()
      process.env.NUXT_JOINER_LIVE_BEARER_HOURS = 'abc'
      expect(await selectRecentJoinableSessionIds(t.db)).toContain(AGED_LIVE)
      expect(warn.mock.calls.some((c) => String(c[0]).includes('NUXT_JOINER_LIVE_BEARER_HOURS'))).toBe(true)

      // A blank value is UNSET, not zero — no warning, default applies.
      warn.mockClear()
      process.env.NUXT_JOINER_LIVE_BEARER_HOURS = '   '
      expect(await selectRecentJoinableSessionIds(t.db)).toContain(AGED_LIVE)
      expect(warn.mock.calls.some((c) => String(c[0]).includes('NUXT_JOINER_LIVE_BEARER_HOURS'))).toBe(false)
    } finally {
      warn.mockRestore()
      if (saved === undefined) delete process.env.NUXT_JOINER_LIVE_BEARER_HOURS
      else process.env.NUXT_JOINER_LIVE_BEARER_HOURS = saved
    }
  })

  it('liveness knob: over-ceiling values CLAMP to the max window (not the default) and never throw', async () => {
    // Postgres throws `interval out of range` on absurd values, which would fail
    // the WHOLE tick. The clamp target matters and must be distinguishable: this
    // instance's bearer is 30d old, so it is selected ONLY under the 90d ceiling
    // — never under the 14d default. An earlier version of this test used a
    // 1h-old bearer, which both windows match, so it could not tell them apart.
    const CLAMP_PROBE = '77777777-0000-0000-0000-0000000000f1'
    await t.client.unsafe(`
      INSERT INTO instance_attestation
        (instance_id, principal_oid, principal_email, teammate_id, project_code_hash,
         raw_project_code, tool, session_token_hash, ts_start, ts_actual_end, last_bearer_at,
         region_id, org_unit_id, cost_owning_unit_id)
      VALUES
        ('${CLAMP_PROBE}', 'oid', 'dev@i.com', '33333333-3333-3333-3333-333333333333', 'h-afl-aii', 'CSL-AII',
         'claude-code', 'hClamp', NOW() - INTERVAL '80 days', NULL, NOW() - INTERVAL '30 days',
         '11111111-1111-1111-1111-111111111111', '22222222-2222-2222-2222-222222222222', '22222222-2222-2222-2222-222222222222');
    `)
    try {
      // Baseline: outside the 14d default.
      expect(await selectRecentJoinableSessionIds(t.db)).not.toContain(CLAMP_PROBE)
      // Both spellings of "as wide as possible" clamp to the 90d ceiling, which
      // DOES cover a 30d-old mint — proving the clamp target, not just no-throw.
      const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
      try {
        for (const huge of [1e18, Number.POSITIVE_INFINITY]) {
          expect(await selectRecentJoinableSessionIds(t.db, { liveBearerHours: huge })).toContain(CLAMP_PROBE)
        }
        // A clamp changes WHICH instances get scanned, so it must not be silent —
        // the message is the only signal that the value asked for was not used.
        expect(warn.mock.calls.some((c) => String(c[0]).includes('out of range'))).toBe(true)
      } finally {
        warn.mockRestore()
      }
    } finally {
      await t.client.unsafe(`DELETE FROM instance_attestation WHERE instance_id = '${CLAMP_PROBE}'`)
    }
  })

  it('keeps re-scanning an ACTIVE session even after it has an attribution_record (incremental spend)', async () => {
    const reader = new StubReader(
      new Map([
        [LONG_ACTIVE, [{ tokens: 500, tokenType: 'input', model: 'claude-sonnet-4-7', tsEvent: '2026-06-02T07:00:00Z', projectCodeHash: 'h-afl-aii' }]],
      ]),
    ) as unknown as TelemetryReader
    const res = await runReadJoiner(t.db, reader, { sessionIds: [LONG_ACTIVE] })
    expect(res.attributionRowsWritten).toBeGreaterThan(0)
    const ids = await selectRecentJoinableSessionIds(t.db)
    expect(ids).toContain(LONG_ACTIVE) // still active → still re-scanned for new spend
  })

  it('keeps re-scanning a RECENTLY-closed session even after it has attribution (trailing emit; 2026-06-06 defense)', async () => {
    const reader = new StubReader(
      new Map([
        [ENDED_UNATTRIB, [{ tokens: 700, tokenType: 'input', model: 'claude-sonnet-4-7', tsEvent: '2026-06-02T06:30:00Z', projectCodeHash: 'h-afl-aii' }]],
      ]),
    ) as unknown as TelemetryReader
    const res = await runReadJoiner(t.db, reader, { sessionIds: [ENDED_UNATTRIB] })
    expect(res.attributionRowsWritten).toBeGreaterThan(0)
    const ids = await selectRecentJoinableSessionIds(t.db)
    // ts_actual_end is within the window → STILL re-scanned, so a close (session-gc
    // / /end) never instantly freezes an instance that is still emitting. This is
    // the defense-in-depth for the 2026-06-06 outage (a 12h gc-close froze a live
    // instance because closed+attributed matched no clause).
    expect(ids).toContain(ENDED_UNATTRIB)
  })

  it('excludes a LONG-closed session with attribution (aged past the recently-closed window)', async () => {
    // ENDED_OLD: ts_actual_end 47h ago (outside the 24h window) + ts_start 48h ago.
    // Attribute it, then confirm it is NOT re-scanned — a long-dead session is done.
    const reader = new StubReader(
      new Map([
        [ENDED_OLD, [{ tokens: 800, tokenType: 'input', model: 'claude-sonnet-4-7', tsEvent: '2026-06-02T05:30:00Z', projectCodeHash: 'h-afl-aii' }]],
      ]),
    ) as unknown as TelemetryReader
    await runReadJoiner(t.db, reader, { sessionIds: [ENDED_OLD] })
    const ids = await selectRecentJoinableSessionIds(t.db)
    expect(ids).not.toContain(ENDED_OLD)
  })
})

describe('runReadJoiner — per-instance high-water-mark (incremental read)', () => {
  // A dedicated instance so the watermark math is isolated from other suites'
  // rows on the shared instances.
  const INST_WM = 'ffffffff-0000-0000-0000-0000000000f1'
  const TEAM = '33333333-3333-3333-3333-333333333333'

  beforeAll(async () => {
    await t.client.unsafe(`
      INSERT INTO instance_attestation
        (instance_id, principal_oid, principal_email, teammate_id, project_code_hash,
         raw_project_code, tool, session_token_hash, ts_start, ts_actual_end,
         region_id, org_unit_id, cost_owning_unit_id)
      VALUES
        ('${INST_WM}', 'oid', 'dev@i.com', '${TEAM}', 'h-afl-aii', 'CSL-AII',
         'claude-code', 'hashWM', '2026-05-24 18:00:00+00', '2026-05-24 18:30:00+00',
         '11111111-1111-1111-1111-111111111111', '22222222-2222-2222-2222-222222222222',
         '22222222-2222-2222-2222-222222222222');
    `)
  }, 30_000)

  it('(b) first scan with NO prior attribution reads the full window (sinceTsEvent undefined)', async () => {
    const reader = new StubReader(
      new Map([[INST_WM, [
        { tokens: 100, tokenType: 'input', model: 'claude-sonnet-4-7', tsEvent: '2026-05-24T18:01:00Z', projectCodeHash: 'h-afl-aii' },
        { tokens: 200, tokenType: 'output', model: 'claude-sonnet-4-7', tsEvent: '2026-05-24T18:02:00Z', projectCodeHash: 'h-afl-aii' },
      ]]]),
    )
    const res = await runReadJoiner(t.db, reader as unknown as TelemetryReader, { sessionIds: [INST_WM] })
    expect(res.attributionRowsWritten).toBe(2)
    // No prior attribution → no watermark → full-window read.
    expect(reader.calls).toHaveLength(1)
    expect(reader.calls[0]!.sinceTsEvent).toBeUndefined()
  })

  it('(a) a later tick passes the watermark (MAX ts_event) and only attributes newer events', async () => {
    // After (b) the latest attributed event is 18:02:00Z. A new tick must ask the
    // reader for sinceTsEvent === that MAX, and a brand-new 18:10 event lands.
    // The two old events fall within the lookback window — the StubReader returns
    // them too (boundary re-read) but dedup prevents a re-write.
    const reader = new StubReader(
      new Map([[INST_WM, [
        { tokens: 100, tokenType: 'input', model: 'claude-sonnet-4-7', tsEvent: '2026-05-24T18:01:00Z', projectCodeHash: 'h-afl-aii' },
        { tokens: 200, tokenType: 'output', model: 'claude-sonnet-4-7', tsEvent: '2026-05-24T18:02:00Z', projectCodeHash: 'h-afl-aii' },
        { tokens: 300, tokenType: 'input', model: 'claude-sonnet-4-7', tsEvent: '2026-05-24T18:10:00Z', projectCodeHash: 'h-afl-aii' },
      ]]]),
    )
    const res = await runReadJoiner(t.db, reader as unknown as TelemetryReader, { sessionIds: [INST_WM] })
    // Only the new 18:10 event is written; the two re-read olds are deduped.
    expect(res.attributionRowsWritten).toBe(1)
    expect(reader.calls).toHaveLength(1)
    expect(reader.calls[0]!.sinceTsEvent).toBeInstanceOf(Date)
    expect(reader.calls[0]!.sinceTsEvent!.toISOString()).toBe('2026-05-24T18:02:00.000Z')

    const rows = await t.client<{ count: string }[]>`
      SELECT COUNT(*)::text AS count FROM attribution_record WHERE instance_id = ${INST_WM}::uuid`
    expect(Number(rows[0]!.count)).toBe(3) // 2 from (b) + 1 new
  })

  it('(c) the lookback re-reads a near-boundary event but dedup prevents a double-write (idempotent)', async () => {
    // Watermark is now 18:10:00Z. The 18:08 event is WITHIN the lookback window
    // (watermark - 5min = 18:05), so the StubReader returns it on a re-read — but
    // it was already attributed at 18:10's tick? No: it's a never-before-seen
    // event INSIDE the overlap that arrived out-of-order. First time → written.
    // Re-running the same tick → deduped (idempotent), proving the overlap is safe.
    const reader = new StubReader(
      new Map([[INST_WM, [
        { tokens: 200, tokenType: 'output', model: 'claude-sonnet-4-7', tsEvent: '2026-05-24T18:02:00Z', projectCodeHash: 'h-afl-aii' }, // far behind watermark, NOT re-read
        { tokens: 300, tokenType: 'input', model: 'claude-sonnet-4-7', tsEvent: '2026-05-24T18:10:00Z', projectCodeHash: 'h-afl-aii' }, // == watermark, re-read, deduped
        { tokens: 350, tokenType: 'input', model: 'claude-sonnet-4-7', tsEvent: '2026-05-24T18:08:00Z', projectCodeHash: 'h-afl-aii' }, // within lookback, out-of-order, NEW → written
      ]]]),
    )
    const res = await runReadJoiner(t.db, reader as unknown as TelemetryReader, { sessionIds: [INST_WM] })
    // Reader asked for sinceTsEvent = 18:10 (the current MAX); cutoff = 18:05.
    expect(reader.calls[0]!.sinceTsEvent!.toISOString()).toBe('2026-05-24T18:10:00.000Z')
    // 18:02 is below cutoff → not even returned by the reader. 18:10 deduped.
    // Only the new out-of-order 18:08 is written.
    expect(res.attributionRowsWritten).toBe(1)

    // Re-run the identical tick: everything now deduped → idempotent no-op.
    const reader2 = new StubReader(
      new Map([[INST_WM, [
        { tokens: 350, tokenType: 'input', model: 'claude-sonnet-4-7', tsEvent: '2026-05-24T18:08:00Z', projectCodeHash: 'h-afl-aii' },
        { tokens: 300, tokenType: 'input', model: 'claude-sonnet-4-7', tsEvent: '2026-05-24T18:10:00Z', projectCodeHash: 'h-afl-aii' },
      ]]]),
    )
    const res2 = await runReadJoiner(t.db, reader2 as unknown as TelemetryReader, { sessionIds: [INST_WM] })
    expect(res2.attributionRowsWritten).toBe(0)

    const rows = await t.client<{ count: string }[]>`
      SELECT COUNT(*)::text AS count FROM attribution_record WHERE instance_id = ${INST_WM}::uuid`
    expect(Number(rows[0]!.count)).toBe(4) // 100@18:01, 200@18:02, 300@18:10, 350@18:08
  })
})

// ─────────────────────────────────────────────────────────────────────────────
// Copilot CLI money path — runReadJoiner with nano_aiu rows
//
// Required by S2 (Opus review): assert the full cost path end-to-end:
//   nanoAiu → cost_usd via COPILOT_AI_CREDIT_USD; rate_card_id NULL;
//   fidelity_tier='tier-2'; telemetry-only cost_basis.
// Also: parallel-subagent same-ms persistence (the reason source_run_id exists).
// ─────────────────────────────────────────────────────────────────────────────
describe('Copilot CLI money path — nano_aiu → cost_usd via joiner', () => {
  const INST_COP = 'c0000000-0000-0000-0000-000000000001'
  const CONV_COP = 'conv-copilot-money-test'
  const TS_COP   = '2026-06-07T10:00:00Z'
  const MODEL_COP = 'copilot/claude-sonnet-4-6'

  beforeAll(async () => {
    await t.client.unsafe(`
      INSERT INTO instance_attestation
        (instance_id, principal_oid, principal_email, teammate_id, project_code_hash,
         raw_project_code, tool, session_token_hash, ts_start, ts_actual_end,
         region_id, org_unit_id, cost_owning_unit_id)
      VALUES
        ('${INST_COP}', 'oid', 'dev@i.com', '33333333-3333-3333-3333-333333333333',
         'h-afl-aii', 'CSL-AII', 'copilot-cli', 'hashCOP1',
         '2026-06-07 09:00:00+00', '2026-06-07 09:30:00+00',
         '11111111-1111-1111-1111-111111111111', '22222222-2222-2222-2222-222222222222',
         '22222222-2222-2222-2222-222222222222');
    `)
  }, 30_000)

  it('nanoAiu row → cost_usd correct, rate_card_id NULL, tier-2/telemetry-only', async () => {
    // 9111525000 nano_aiu = 9.111525 credits = $0.09111525 ≈ $0.091115 (6dp)
    const nanoAiu = 9111525000
    const reader = new StubReader(
      new Map([[INST_COP, [
        { tokens: 12000, tokenType: 'input',  model: MODEL_COP, tsEvent: TS_COP,
          claudeSessionId: CONV_COP, sourceRunId: 'cop-span-001',
          projectCodeHash: 'h-afl-aii', nanoAiu },
        { tokens: 3000,  tokenType: 'output', model: MODEL_COP, tsEvent: TS_COP,
          claudeSessionId: CONV_COP, sourceRunId: 'cop-span-001',
          projectCodeHash: 'h-afl-aii', nanoAiu },
      ]]]),
    ) as unknown as TelemetryReader

    const res = await runReadJoiner(t.db, reader, { sessionIds: [INST_COP] })
    // Two token-type rows are written; cost charged on first surviving row only.
    expect(res.attributionRowsWritten).toBe(2)

    const rows = await t.client<{
      token_type: string; cost_usd: string; credit_qty: string | null; rate_card_id: string | null;
      fidelity_tier: string; cost_basis: string;
    }[]>`
      SELECT token_type, cost_usd::text, credit_qty::text, rate_card_id::text, fidelity_tier, cost_basis
      FROM attribution_record
      WHERE instance_id = ${INST_COP}::uuid
        AND ts_event    = ${TS_COP}::timestamptz
      ORDER BY token_type
    `
    expect(rows).toHaveLength(2)

    // input row carries the full nano_aiu cost AND the native credit operand
    const inputRow = rows.find((r) => r.token_type === 'input')!
    expect(parseFloat(inputRow.cost_usd)).toBeCloseTo(0.091115, 5)
    // credit_qty = nano_aiu / 1e9 = 9.111525 credits (the reconciliation operand)
    expect(parseFloat(inputRow.credit_qty!)).toBeCloseTo(9.111525, 6)
    expect(inputRow.rate_card_id).toBeNull()
    expect(inputRow.fidelity_tier).toBe('tier-2')
    expect(inputRow.cost_basis).toBe('telemetry-only')

    // output row: tokens recorded for reporting; cost AND credits are 0 (priced once above)
    const outputRow = rows.find((r) => r.token_type === 'output')!
    expect(parseFloat(outputRow.cost_usd)).toBe(0)
    expect(parseFloat(outputRow.credit_qty!)).toBe(0)
    expect(outputRow.rate_card_id).toBeNull()
  })

  it('re-forward the same Copilot span → exactly one row set (dedup)', async () => {
    const TS2 = '2026-06-07T10:01:00Z'
    const nanoAiu = 5000000000 // 5 credits = $0.05
    const reader = new StubReader(
      new Map([[INST_COP, [
        { tokens: 8000, tokenType: 'input', model: MODEL_COP, tsEvent: TS2,
          claudeSessionId: CONV_COP, sourceRunId: 'cop-span-002',
          projectCodeHash: 'h-afl-aii', nanoAiu },
      ]]]),
    ) as unknown as TelemetryReader

    const res1 = await runReadJoiner(t.db, reader, { sessionIds: [INST_COP] })
    expect(res1.attributionRowsWritten).toBe(1)

    // Forward the identical record a second time.
    const res2 = await runReadJoiner(t.db, reader, { sessionIds: [INST_COP] })
    expect(res2.attributionRowsWritten).toBe(0)

    const rows = await t.client<{ count: string }[]>`
      SELECT COUNT(*)::text AS count FROM attribution_record
      WHERE instance_id = ${INST_COP}::uuid
        AND ts_event     = ${TS2}::timestamptz
        AND source_run_id = 'cop-span-002'
    `
    expect(Number(rows[0]!.count)).toBe(1)
  })

  it('parallel Copilot subagents at same ts → both rows persist', async () => {
    const TS3 = '2026-06-07T10:02:00Z'
    const nanoAiu = 3000000000 // 3 credits each
    const readerA = new StubReader(
      new Map([[INST_COP, [
        { tokens: 5000, tokenType: 'input', model: MODEL_COP, tsEvent: TS3,
          claudeSessionId: CONV_COP, sourceRunId: 'cop-sub-aaa',
          projectCodeHash: 'h-afl-aii', nanoAiu },
      ]]]),
    ) as unknown as TelemetryReader
    const readerB = new StubReader(
      new Map([[INST_COP, [
        { tokens: 5000, tokenType: 'input', model: MODEL_COP, tsEvent: TS3,
          claudeSessionId: CONV_COP, sourceRunId: 'cop-sub-bbb',
          projectCodeHash: 'h-afl-aii', nanoAiu },
      ]]]),
    ) as unknown as TelemetryReader

    const resA = await runReadJoiner(t.db, readerA, { sessionIds: [INST_COP] })
    const resB = await runReadJoiner(t.db, readerB, { sessionIds: [INST_COP] })
    expect(resA.attributionRowsWritten).toBe(1)
    expect(resB.attributionRowsWritten).toBe(1)

    const rows = await t.client<{ count: string }[]>`
      SELECT COUNT(*)::text AS count FROM attribution_record
      WHERE instance_id = ${INST_COP}::uuid
        AND ts_event = ${TS3}::timestamptz
        AND token_type = 'input'
    `
    expect(Number(rows[0]!.count)).toBe(2)
  })

  it('M1: output+cache_read span with NO input row → exactly one row carries cost, total cost = $0.04', async () => {
    // M1 regression guard: first-surviving-record pricing charges the FIRST record
    // in array-iteration order for a given (tsEvent, sourceRunId) pair; the rest get $0.
    // This test has only output + cache_read rows (no input) — proving that the fix
    // works even when the input row is absent (was dropped because input_tokens==0).
    // If the fix is reverted to `tokenType==='input'` pricing, BOTH rows get $0 → test FAILS.
    const TS4 = '2026-06-07T10:03:00Z'
    const nanoAiu = 4000000000 // 4 credits = $0.04
    const reader = new StubReader(
      new Map([[INST_COP, [
        { tokens: 6000, tokenType: 'output',     model: MODEL_COP, tsEvent: TS4,
          claudeSessionId: CONV_COP, sourceRunId: 'cop-span-003',
          projectCodeHash: 'h-afl-aii', nanoAiu },
        { tokens: 2000, tokenType: 'cache_read', model: MODEL_COP, tsEvent: TS4,
          claudeSessionId: CONV_COP, sourceRunId: 'cop-span-003',
          projectCodeHash: 'h-afl-aii', nanoAiu },
      ]]]),
    ) as unknown as TelemetryReader

    const res = await runReadJoiner(t.db, reader, { sessionIds: [INST_COP] })
    expect(res.attributionRowsWritten).toBe(2)

    const rows = await t.client<{
      token_type: string; cost_usd: string;
    }[]>`
      SELECT token_type, cost_usd::text
      FROM attribution_record
      WHERE instance_id   = ${INST_COP}::uuid
        AND ts_event       = ${TS4}::timestamptz
        AND source_run_id  = 'cop-span-003'
      ORDER BY token_type
    `
    expect(rows).toHaveLength(2)

    // The joiner iterates groupUsage in the array order returned by the reader.
    // The first record (output, since it is listed first in the StubReader) carries
    // the full cost; the second (cache_read) gets $0.000000.
    // Total must equal exactly 4 credits × $0.01 = $0.04.
    const totalCost = rows.reduce((sum, r) => sum + parseFloat(r.cost_usd), 0)
    expect(totalCost).toBeCloseTo(0.04, 5)

    // Exactly ONE row should have non-zero cost (no double-charge).
    const nonZeroCostRows = rows.filter((r) => parseFloat(r.cost_usd) > 0)
    expect(nonZeroCostRows).toHaveLength(1)
  })
})

// Suppress unused-symbol noise.
void sql


// ─────────────────────────────────────────────────────────────────────────────
// Migration 0035 — source_run_id in dedup index (COALESCE'd for parallel-subagent safety)
//
// Three cases required by the spec:
//   (a) Same Claude request_id → still collapses (no double-count)
//   (b) Two distinct request_ids at same 5-tuple → both persist (parallel subagents)
//   (c) NULL source_run_id legacy rows → still dedup on the old 5-tuple (COALESCE)
// ─────────────────────────────────────────────────────────────────────────────
describe('Dedup index mig 0035 — source_run_id COALESCE regression', () => {
  const INST_DEDUP = 'f0000000-0000-0000-0000-000000000035'
  const CONV_DEDUP = 'conv-dedup-0035'
  const TS = '2026-05-30T10:00:00Z'
  const MODEL = 'claude-sonnet-4-7'

  beforeAll(async () => {
    await t.client.unsafe(`
      INSERT INTO instance_attestation
        (instance_id, principal_oid, principal_email, teammate_id, project_code_hash,
         raw_project_code, tool, session_token_hash, ts_start, ts_actual_end,
         region_id, org_unit_id, cost_owning_unit_id)
      VALUES
        ('${INST_DEDUP}', 'oid', 'dev@i.com', '33333333-3333-3333-3333-333333333333',
         'h-afl-aii', 'CSL-AII', 'claude-code', 'hashDEDUP',
         '2026-05-30 09:00:00+00', '2026-05-30 09:30:00+00',
         '11111111-1111-1111-1111-111111111111', '22222222-2222-2222-2222-222222222222',
         '22222222-2222-2222-2222-222222222222');
    `)
  }, 30_000)

  it('(a) same request_id (source_run_id) at the same 5-tuple → collapses to one row (no double-count)', async () => {
    const reader = new StubReader(
      new Map([[INST_DEDUP, [
        { tokens: 9000, tokenType: 'input', model: MODEL, tsEvent: TS, claudeSessionId: CONV_DEDUP, sourceRunId: 'req-same-aaa', projectCodeHash: 'h-afl-aii' },
      ]]]),
    ) as unknown as TelemetryReader

    const res1 = await runReadJoiner(t.db, reader, { sessionIds: [INST_DEDUP] })
    expect(res1.attributionRowsWritten).toBe(1)

    // Re-forward the IDENTICAL record (same instance, session, ts, token_type, model, source_run_id).
    const res2 = await runReadJoiner(t.db, reader, { sessionIds: [INST_DEDUP] })
    expect(res2.attributionRowsWritten).toBe(0)

    const rows = await t.client<{ count: string }[]>`
      SELECT COUNT(*)::text AS count FROM attribution_record
      WHERE instance_id = ${INST_DEDUP}::uuid
        AND claude_session_id = ${CONV_DEDUP}
        AND source_run_id = 'req-same-aaa'
        AND ts_event = ${TS}::timestamptz
    `
    expect(Number(rows[0]!.count)).toBe(1)
  })

  it('(b) two DISTINCT request_ids at the same 5-tuple → both rows persist (parallel subagents)', async () => {
    const tsB = '2026-05-30T10:01:00Z'
    const readerA = new StubReader(
      new Map([[INST_DEDUP, [
        { tokens: 8000, tokenType: 'input', model: MODEL, tsEvent: tsB, claudeSessionId: CONV_DEDUP, sourceRunId: 'req-para-aaa', projectCodeHash: 'h-afl-aii' },
      ]]]),
    ) as unknown as TelemetryReader
    const readerB = new StubReader(
      new Map([[INST_DEDUP, [
        { tokens: 8000, tokenType: 'input', model: MODEL, tsEvent: tsB, claudeSessionId: CONV_DEDUP, sourceRunId: 'req-para-bbb', projectCodeHash: 'h-afl-aii' },
      ]]]),
    ) as unknown as TelemetryReader

    const resA = await runReadJoiner(t.db, readerA, { sessionIds: [INST_DEDUP] })
    const resB = await runReadJoiner(t.db, readerB, { sessionIds: [INST_DEDUP] })
    expect(resA.attributionRowsWritten).toBe(1)
    expect(resB.attributionRowsWritten).toBe(1)

    const rows = await t.client<{ count: string }[]>`
      SELECT COUNT(*)::text AS count FROM attribution_record
      WHERE instance_id = ${INST_DEDUP}::uuid
        AND ts_event = ${tsB}::timestamptz
        AND token_type = 'input'
    `
    expect(Number(rows[0]!.count)).toBe(2)
  })

  it('(c) NULL source_run_id legacy rows dedup on the old 5-tuple (COALESCE safety)', async () => {
    const tsC = '2026-05-30T10:02:00Z'
    const reader = new StubReader(
      new Map([[INST_DEDUP, [
        // No sourceRunId → NULL → COALESCE(''). Same 5-tuple twice.
        { tokens: 7000, tokenType: 'input', model: MODEL, tsEvent: tsC, claudeSessionId: CONV_DEDUP, projectCodeHash: 'h-afl-aii' },
      ]]]),
    ) as unknown as TelemetryReader

    const res1 = await runReadJoiner(t.db, reader, { sessionIds: [INST_DEDUP] })
    expect(res1.attributionRowsWritten).toBe(1)

    const res2 = await runReadJoiner(t.db, reader, { sessionIds: [INST_DEDUP] })
    expect(res2.attributionRowsWritten).toBe(0)

    const rows = await t.client<{ count: string; source_run_id: string | null }[]>`
      SELECT COUNT(*)::text AS count, MAX(source_run_id) AS source_run_id FROM attribution_record
      WHERE instance_id = ${INST_DEDUP}::uuid
        AND ts_event = ${tsC}::timestamptz
        AND token_type = 'input'
    `
    expect(Number(rows[0]!.count)).toBe(1)
    expect(rows[0]!.source_run_id).toBeNull()
  })
})

