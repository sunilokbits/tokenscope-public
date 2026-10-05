// @vitest-environment node
/*
 * A device's 90-day lifetime is an IDLE window, not an age (ADR-0005 update,
 * 2026-09-23). Before this, `ts_expected_end` and a bound credential's
 * `refresh_expires_at` were both fixed at enrolment + 90d, so session-gc closed
 * every device on its 90th day while it was still emitting ("Session ended").
 *
 * Renewal paths under test: refresh (credential), /bearer (device),
 * re-provision reuse (device). Reclaim under test: session-gc still closes an
 * IDLE device, and never renews what it should not.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import { randomUUID } from 'node:crypto'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { sql } from 'drizzle-orm'
import { startTestDb, stopTestDb, type TestDb } from '../helpers/db'
import * as schema from '../../../drizzle/schema'
import { resetHmacKeyForTests, hashSessionToken } from '../../../server/auth/hmac'
import { issueEmitCredential } from '../../../server/auth/emit-credential'
import { refreshAccessToken, REFRESH_TOKEN_TTL_MS } from '../../../server/auth/oauth'
import { issueInstanceEmitCredentialTx, locateOrCreateInstance } from '../../../server/auth/emit-provision'
import { locateOrCreateProvisionalInstance } from '../../../server/auth/enroll-provision'
import { runSessionGc, CLOSE_CHUNK, idleDevicePredicate } from '../../../server/workers/session-gc'
import { runSoftPurge } from '../../../server/workers/soft-purge'
import bearerHandler from '../../../server/api/v1/instances/[instanceId]/bearer.get'

const DAY_MS = 24 * 60 * 60 * 1000

let t: TestDb
let regionId: string
let ouId: string
let ownerId: string
let otherId: string

beforeAll(async () => {
  t = await startTestDb()
  process.env.DATABASE_URL = t.url
  process.env.NUXT_HMAC_SESSION_KEY = 'device-idle-window-key-padded-well-beyond-32-chars'
  process.env.NUXT_SESSION_SECRET = 'device-idle-window-padded-to-thirty-two-chars!!'
  resetHmacKeyForTests()

  const [r] = await t.db.insert(schema.region).values({ code: 'diw-r', displayName: 'DIW R' }).returning()
  regionId = r!.id
  const [o] = await t.db
    .insert(schema.orgUnit)
    .values({ regionId, path: 'diw.svc', code: 'diw-svc', displayName: 'Svc', unitType: 'bu' })
    .returning()
  ouId = o!.id
  const [owner] = await t.db
    .insert(schema.teammate)
    .values({ entraOid: 'oid-diw-owner', email: 'diw-owner@x.test', role: 'developer', regionId, orgUnitId: ouId })
    .returning()
  ownerId = owner!.id
  const [other] = await t.db
    .insert(schema.teammate)
    .values({ entraOid: 'oid-diw-other', email: 'diw-other@x.test', role: 'developer', regionId, orgUnitId: ouId })
    .returning()
  otherId = other!.id
}, 60_000)

afterAll(async () => {
  await stopTestDb(t)
}, 30_000)

/**
 * A device enrolled `ageDays` ago under the pre-fix shape: ts_expected_end fixed
 * at enrolment + 90d. `expectedEnd` overrides it (null = legacy row).
 */
async function enrolDevice(
  teammateId: string,
  ageDays: number,
  expectedEnd: Date | null = new Date(Date.now() - ageDays * DAY_MS + REFRESH_TOKEN_TTL_MS),
  lastBearerAt: Date | null = null,
): Promise<string> {
  const instanceId = randomUUID()
  await t.client`
    INSERT INTO instance_attestation
      (instance_id, principal_oid, principal_email, teammate_id, tool, ts_start,
       ts_expected_end, last_bearer_at, region_id, org_unit_id, attestation_state)
    VALUES (${instanceId}::uuid, 'oid-diw', 'diw@x.test', ${teammateId}::uuid, 'claude-code',
            ${new Date(Date.now() - ageDays * DAY_MS).toISOString()}::timestamptz,
            ${expectedEnd?.toISOString() ?? null}::timestamptz,
            ${lastBearerAt?.toISOString() ?? null}::timestamptz,
            ${regionId}::uuid, ${ouId}::uuid, 'unassigned')`
  return instanceId
}

/** A credential bound to `instanceId`, its refresh expiry pinned `expiresInDays` out. */
async function boundCredential(teammateId: string, instanceId: string, expiresInDays = 1) {
  const cred = await t.db.transaction((tx) =>
    issueInstanceEmitCredentialTx(tx as never, teammateId, instanceId, issueEmitCredential),
  )
  await pinRefreshExpiry(cred.refreshToken, expiresInDays)
  return cred
}

async function pinRefreshExpiry(refreshToken: string, expiresInDays: number) {
  await t.client`
    UPDATE oauth_token SET refresh_expires_at = now() + make_interval(days => ${expiresInDays})
     WHERE refresh_token_hash = ${hashSessionToken(refreshToken)}`
}

async function refreshExpiresInDays(refreshToken: string): Promise<number> {
  const [row] = await t.client<{ ms: string }[]>`
    SELECT (EXTRACT(EPOCH FROM (refresh_expires_at - now())) * 1000)::text AS ms
      FROM oauth_token WHERE refresh_token_hash = ${hashSessionToken(refreshToken)}`
  return Number(row!.ms) / DAY_MS
}

async function expectedEndInDays(instanceId: string): Promise<number> {
  const [row] = await t.client<{ ms: string }[]>`
    SELECT (EXTRACT(EPOCH FROM (ts_expected_end - now())) * 1000)::text AS ms
      FROM instance_attestation WHERE instance_id = ${instanceId}::uuid`
  return Number(row!.ms) / DAY_MS
}

async function isEnded(instanceId: string): Promise<boolean> {
  const [row] = await t.client<{ ended: boolean }[]>`
    SELECT ts_actual_end IS NOT NULL AS ended FROM instance_attestation WHERE instance_id = ${instanceId}::uuid`
  return row!.ended
}

function bearerEvent(instanceId: string, token: string) {
  return {
    path: '/x',
    context: { params: { instanceId } },
    node: {
      req: { method: 'GET', url: '/x', headers: { authorization: `Bearer ${token}` } },
      res: {
        _headers: {} as Record<string, string | string[]>,
        statusCode: 200,
        getHeader(n: string) { return this._headers[n.toLowerCase()] },
        setHeader(n: string, v: string | string[]) { this._headers[n.toLowerCase()] = v },
        removeHeader(n: string) { this._headers[n.toLowerCase()] = '' },
        appendHeader(n: string, v: string | string[]) { this._headers[n.toLowerCase()] = v },
        get headersSent() { return false },
      },
    },
  }
}

const FULL_WINDOW_DAYS = REFRESH_TOKEN_TTL_MS / DAY_MS

/**
 * Resolves once another backend is waiting on a lock, i.e. the competing
 * statement really is parked behind the transaction the caller holds open.
 * Polls the server instead of sleeping, so the race tests order by fact.
 */
async function untilBlockedOnRowLock(timeoutMs = 10_000): Promise<void> {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    const [row] = await t.client<{ n: number }[]>`
      SELECT count(*)::int AS n FROM pg_stat_activity
       WHERE datname = current_database() AND wait_event_type = 'Lock' AND pid <> pg_backend_pid()`
    if (row!.n > 0) return
    await new Promise((r) => setTimeout(r, 10))
  }
  throw new Error('untilBlockedOnRowLock: nothing blocked; the race under test never happened')
}

describe('a device in use outlives its 90th day (the 2026-09-22 regression)', () => {
  it('day 89: refresh + mint renew both clocks, and session-gc two days later leaves the device open', async () => {
    const instanceId = await enrolDevice(ownerId, 89)
    const cred = await boundCredential(ownerId, instanceId)

    const refreshed = await refreshAccessToken(t.db as never, cred.refreshToken, cred.clientId)
    expect(await refreshExpiresInDays(cred.refreshToken)).toBeGreaterThan(FULL_WINDOW_DAYS - 1)

    const out = (await bearerHandler(bearerEvent(instanceId, refreshed.access_token) as never)) as {
      Authorization: string
    }
    expect(out.Authorization).toMatch(/^Bearer /)
    expect(await expectedEndInDays(instanceId)).toBeGreaterThan(FULL_WINDOW_DAYS - 1)

    await runSessionGc(t.db, new Date(Date.now() + 2 * DAY_MS))
    expect(await isEnded(instanceId)).toBe(false)
  })

  it('an IDLE device past its window is still closed by session-gc', async () => {
    const instanceId = await enrolDevice(ownerId, 91)
    await runSessionGc(t.db, new Date())
    expect(await isEnded(instanceId)).toBe(true)
  })

  it('renewal never SHORTENS a longer horizon', async () => {
    const far = new Date(Date.now() + 400 * DAY_MS)
    const instanceId = await enrolDevice(ownerId, 1, far)
    const cred = await boundCredential(ownerId, instanceId, 400)
    const refreshed = await refreshAccessToken(t.db as never, cred.refreshToken, cred.clientId)
    await bearerHandler(bearerEvent(instanceId, refreshed.access_token) as never)

    expect(await refreshExpiresInDays(cred.refreshToken)).toBeGreaterThan(399)
    expect(await expectedEndInDays(instanceId)).toBeGreaterThan(399)
  })
})

describe('refresh: an unbound credential keeps its fixed expiry; a bound one needs its live, owned device', () => {
  it('an UNBOUND credential refreshes and keeps its fixed expiry', async () => {
    const cred = await issueEmitCredential(t.db as never, ownerId)
    await pinRefreshExpiry(cred.tokens.refresh_token, 1)
    await refreshAccessToken(t.db as never, cred.tokens.refresh_token, cred.clientId)
    expect(await refreshExpiresInDays(cred.tokens.refresh_token)).toBeLessThan(1.01)
  })

  it('a credential bound to an ENDED device is refused, and its expiry is untouched', async () => {
    const instanceId = await enrolDevice(ownerId, 10)
    const cred = await boundCredential(ownerId, instanceId)
    await t.client`UPDATE instance_attestation SET ts_actual_end = now() WHERE instance_id = ${instanceId}::uuid`
    await expect(refreshAccessToken(t.db as never, cred.refreshToken, cred.clientId)).rejects.toMatchObject({
      code: 'invalid_grant',
    })
    expect(await refreshExpiresInDays(cred.refreshToken)).toBeLessThan(1.01)
  })

  it('a credential bound to a PURGED device is refused', async () => {
    const instanceId = await enrolDevice(ownerId, 10)
    const cred = await boundCredential(ownerId, instanceId)
    await t.client.begin(async (tx) => {
      // A purged-but-open row is impossible since mig 0144; build it to cover the defence-in-depth arm.
      await tx`ALTER TABLE instance_attestation DISABLE TRIGGER instance_attestation_purge_only_ended`
      await tx`UPDATE instance_attestation SET ts_purged = now() WHERE instance_id = ${instanceId}::uuid`
      await tx`ALTER TABLE instance_attestation ENABLE TRIGGER instance_attestation_purge_only_ended`
    })
    await expect(refreshAccessToken(t.db as never, cred.refreshToken, cred.clientId)).rejects.toMatchObject({
      code: 'invalid_grant',
    })
  })

  it("a credential bound to ANOTHER teammate's device is refused (defence in depth: mig 0143 forbids the bind)", async () => {
    const othersDevice = await enrolDevice(otherId, 10)
    const cred = await issueEmitCredential(t.db as never, ownerId)
    await t.client.begin(async (tx) => {
      await tx`ALTER TABLE oauth_token DISABLE TRIGGER oauth_token_bind_only_to_live_device`
      await tx`UPDATE oauth_token SET instance_id = ${othersDevice}::uuid
                WHERE refresh_token_hash = ${hashSessionToken(cred.tokens.refresh_token)}`
      await tx`ALTER TABLE oauth_token ENABLE TRIGGER oauth_token_bind_only_to_live_device`
    })
    await expect(refreshAccessToken(t.db as never, cred.tokens.refresh_token, cred.clientId)).rejects.toMatchObject({
      code: 'invalid_grant',
    })
  })

  it('an expired credential is still refused — renewal happens only on a successful refresh', async () => {
    const instanceId = await enrolDevice(ownerId, 10)
    const cred = await boundCredential(ownerId, instanceId, -1)
    await expect(refreshAccessToken(t.db as never, cred.refreshToken, cred.clientId)).rejects.toMatchObject({
      code: 'invalid_grant',
    })
    expect(await refreshExpiresInDays(cred.refreshToken)).toBeLessThan(0)
  })
})

describe('re-provisioning a live device renews its window', () => {
  it('reuse of an 89-day-old device pushes ts_expected_end a full window out', async () => {
    const instanceId = await enrolDevice(ownerId, 89)
    const tm = { teammateId: ownerId, principalOid: 'oid-diw', email: 'diw@x.test', regionId, orgUnitId: ouId }
    const res = await t.db.transaction((tx) => locateOrCreateInstance(tx as never, tm, instanceId, 'claude-code', 'dev'))
    expect(res).toEqual({ instanceId, reused: true })
    expect(await expectedEndInDays(instanceId)).toBeGreaterThan(FULL_WINDOW_DAYS - 1)
  })

  it('a PURGED device id is never reused: re-provisioning mints a fresh device', async () => {
    const instanceId = await enrolDevice(ownerId, 10)
    await t.client.begin(async (tx) => {
      // A purged-but-open row is impossible since mig 0144; build it to cover the defence-in-depth arm.
      await tx`ALTER TABLE instance_attestation DISABLE TRIGGER instance_attestation_purge_only_ended`
      await tx`UPDATE instance_attestation SET ts_purged = now() WHERE instance_id = ${instanceId}::uuid`
      await tx`ALTER TABLE instance_attestation ENABLE TRIGGER instance_attestation_purge_only_ended`
    })
    const tm = { teammateId: ownerId, principalOid: 'oid-diw', email: 'diw@x.test', regionId, orgUnitId: ouId }
    const res = await t.db.transaction((tx) => locateOrCreateInstance(tx as never, tm, instanceId, 'claude-code', 'dev'))
    expect(res).toMatchObject({ reused: false })
    expect((res as { instanceId: string }).instanceId).not.toBe(instanceId)
  })
})

describe('session-gc never closes a device that is being renewed', () => {
  it('a renewal holding the row: GC skips it without waiting, and the device stays open', async () => {
    const instanceId = await enrolDevice(ownerId, 91)
    await t.client.begin(async (tx) => {
      await tx`UPDATE instance_attestation SET ts_expected_end = now() + interval '90 days'
                WHERE instance_id = ${instanceId}::uuid`
      // Completes while the renewal is still uncommitted: SKIP LOCKED, not a wait.
      await runSessionGc(t.db, new Date())
    })
    expect(await isEnded(instanceId)).toBe(false)
  })
})

describe("session-gc's idle scan is index-backed (mig 0142)", () => {
  it("the worker's own predicate plans onto the partial open-row index", async () => {
    const plan = await t.db.transaction(async (tx) => {
      // A small test table would otherwise be seq-scanned whatever the index;
      // disabling that asks the planner only whether the predicate CAN use it.
      await tx.execute(sql`SET LOCAL enable_seqscan = off`)
      return tx.execute<{ 'QUERY PLAN': string }>(
        sql`EXPLAIN SELECT instance_id FROM instance_attestation WHERE ${idleDevicePredicate(new Date())} LIMIT 500`,
      )
    })
    const text = [...plan].map((r) => r['QUERY PLAN']).join('\n')
    expect(text).toContain('instance_attestation_open_last_sign_idx')
    // The KEY is used, not merely the partial index walked as a filter.
    expect(text).toMatch(/Index Cond: \(COALESCE\(last_bearer_at, ts_start\) </)
  })
})

describe('session-gc honours a renewed window even when the last mint is old', () => {
  it('re-provisioned (window renewed) but not yet minted since: stays open', async () => {
    const instanceId = await enrolDevice(ownerId, 100, new Date(Date.now() + 10 * DAY_MS))
    await runSessionGc(t.db, new Date())
    expect(await isEnded(instanceId)).toBe(false)
  })
})

describe('session-gc closes a large idle cohort in committed chunks', () => {
  it(`more than one chunk (${CLOSE_CHUNK}) of idle devices: every one is closed and audited`, async () => {
    const n = CLOSE_CHUNK * 2 + 200
    const ids = await t.client<{ id: string }[]>`
      INSERT INTO instance_attestation
        (instance_id, principal_oid, principal_email, teammate_id, tool, ts_start, ts_expected_end,
         region_id, org_unit_id, attestation_state)
      SELECT gen_random_uuid(), 'oid-cohort', 'cohort@x.test', ${ownerId}::uuid, 'claude-code',
             now() - interval '120 days', now() - interval '30 days', ${regionId}::uuid, ${ouId}::uuid, 'unassigned'
        FROM generate_series(1, ${n})
      RETURNING instance_id::text AS id`
    const res = await runSessionGc(t.db, new Date())
    expect(res.closeBacklog).toBe(false)
    const [row] = await t.client<{ open: number; audited: number }[]>`
      SELECT
        (SELECT count(*)::int FROM instance_attestation
          WHERE instance_id = ANY(${ids.map((r) => r.id)}::uuid[]) AND ts_actual_end IS NULL) AS open,
        (SELECT count(*)::int FROM audit_event
          WHERE event_type = 'session-gc-closed' AND subject_id = ANY(${ids.map((r) => r.id)}::uuid[])) AS audited`
    expect(row).toEqual({ open: 0, audited: n })
  })
})

describe('a device session-gc ends mid-request is never renewed or re-issued', () => {
  /** Run `fn` while an uncommitted close holds the device's row, then commit the close. */
  async function underConcurrentClose<T>(instanceId: string, fn: () => Promise<T>): Promise<T> {
    let pending: Promise<T> | undefined
    await t.client.begin(async (tx) => {
      await tx`UPDATE instance_attestation SET ts_actual_end = now() WHERE instance_id = ${instanceId}::uuid`
      pending = fn()
      pending.catch(() => {}) // settled below, after the close commits
      await untilBlockedOnRowLock() // fn is now waiting on this row lock
    })
    return pending!
  }

  it('/bearer: the close lands first, so the lifecycle gate refuses (401) instead of minting', async () => {
    const instanceId = await enrolDevice(ownerId, 10)
    const cred = await boundCredential(ownerId, instanceId, 30)
    const { access_token } = await refreshAccessToken(t.db as never, cred.refreshToken, cred.clientId)
    await expect(
      underConcurrentClose(instanceId, () => bearerHandler(bearerEvent(instanceId, access_token) as never)),
    ).rejects.toMatchObject({ statusCode: 401 })
  })

  it('re-provision: the ended row is not reused; a fresh device is minted', async () => {
    const instanceId = await enrolDevice(ownerId, 10)
    const tm = { teammateId: ownerId, principalOid: 'oid-diw', email: 'diw@x.test', regionId, orgUnitId: ouId }
    const res = await underConcurrentClose(instanceId, () =>
      t.db.transaction((tx) => locateOrCreateInstance(tx as never, tm, instanceId, 'claude-code', 'dev')),
    )
    expect(res).toMatchObject({ reused: false })
  })
})

describe('session-gc: closes and their audit events commit together', () => {
  it('a failing audit write rolls the close back, so the next run retries it', async () => {
    const instanceId = await enrolDevice(ownerId, 91)
    await t.client.unsafe(`
      CREATE FUNCTION diw_fail_gc_audit() RETURNS trigger LANGUAGE plpgsql AS $$
      BEGIN
        IF NEW.event_type = 'session-gc-closed' THEN RAISE EXCEPTION 'audit down'; END IF;
        RETURN NEW;
      END $$;
      CREATE TRIGGER diw_fail_gc_audit BEFORE INSERT ON audit_event
        FOR EACH ROW EXECUTE FUNCTION diw_fail_gc_audit();`)
    try {
      await expect(runSessionGc(t.db, new Date())).rejects.toThrow()
      expect(await isEnded(instanceId)).toBe(false)
    } finally {
      await t.client.unsafe(`DROP TRIGGER diw_fail_gc_audit ON audit_event; DROP FUNCTION diw_fail_gc_audit();`)
    }
    await runSessionGc(t.db, new Date())
    expect(await isEnded(instanceId)).toBe(true)
  })
})

describe('soft-purge retires ENDED devices only', () => {
  it('an open device enrolled over a year ago keeps its identity and stays refreshable', async () => {
    const instanceId = await enrolDevice(ownerId, 400, new Date(Date.now() + 80 * DAY_MS))
    const cred = await boundCredential(ownerId, instanceId)
    await runSoftPurge(t.db, new Date())
    const [row] = await t.client<{ purged: boolean }[]>`
      SELECT ts_purged IS NOT NULL AS purged FROM instance_attestation WHERE instance_id = ${instanceId}::uuid`
    expect(row!.purged).toBe(false)
    await expect(refreshAccessToken(t.db as never, cred.refreshToken, cred.clientId)).resolves.toBeTruthy()
  })

  it('an ended device enrolled over a year ago is purged', async () => {
    const instanceId = await enrolDevice(ownerId, 400)
    await t.client`UPDATE instance_attestation SET ts_actual_end = now() WHERE instance_id = ${instanceId}::uuid`
    const res = await runSoftPurge(t.db, new Date())
    expect(res.purgedSessionIds).toContain(instanceId)
  })
})

describe('provisional enrolment (/setup/enroll) starts a full window', () => {
  it('a re-enrol mints a new device with a full window and leaves the existing device untouched', async () => {
    const enrol = () =>
      t.db.transaction((tx) => locateOrCreateProvisionalInstance(tx as never, 'diw-prov@x.test', 'diw-device-1'))
    const first = (await enrol()) as { instanceId: string }
    await t.client`UPDATE instance_attestation SET ts_expected_end = now() + interval '1 day'
                    WHERE instance_id = ${first.instanceId}::uuid`

    const again = (await enrol()) as { instanceId: string }
    expect(again.instanceId).not.toBe(first.instanceId)
    expect(await expectedEndInDays(again.instanceId)).toBeGreaterThan(FULL_WINDOW_DAYS - 1)
    expect(await expectedEndInDays(first.instanceId)).toBeLessThan(2)
  })
})

describe('rollout: a device still carrying its pre-fix enrolment horizon', () => {
  it('horizon passed but it minted yesterday → session-gc leaves it open', async () => {
    const instanceId = await enrolDevice(ownerId, 95, new Date(Date.now() - 5 * DAY_MS), new Date(Date.now() - DAY_MS))
    await runSessionGc(t.db, new Date())
    expect(await isEnded(instanceId)).toBe(false)
  })
})

describe('mig 0142: open devices get their horizon renewed, so a pre-change session-gc agrees', () => {
  it('a daily-minting device still carrying enrolment + 90d is renewed to last mint + 90d', async () => {
    const instanceId = await enrolDevice(ownerId, 95, new Date(Date.now() - 5 * DAY_MS), new Date(Date.now() - DAY_MS))
    await t.client.unsafe(
      readFileSync(join(process.cwd(), 'drizzle', 'migrations', '0142_open_instance_idle_idx.sql'), 'utf8'),
    )
    // The OLD session-gc closed on ts_expected_end alone; it must now read "open".
    expect(await expectedEndInDays(instanceId)).toBeGreaterThan(FULL_WINDOW_DAYS - 2)
  })
})

describe('session-gc: a legacy row with no ts_expected_end is judged by its last sign of life', () => {
  it('enrolled 100 days ago but minted yesterday → open', async () => {
    const instanceId = await enrolDevice(ownerId, 100, null, new Date(Date.now() - DAY_MS))
    await runSessionGc(t.db, new Date())
    expect(await isEnded(instanceId)).toBe(false)
  })

  it('enrolled 100 days ago and never minted → closed', async () => {
    const instanceId = await enrolDevice(ownerId, 100, null, null)
    await runSessionGc(t.db, new Date())
    expect(await isEnded(instanceId)).toBe(true)
  })
})

// Guard against a vacuous suite: the bound-credential fixture must really bind.
it('fixture sanity: boundCredential produces an instance-bound emit row', async () => {
  const instanceId = await enrolDevice(ownerId, 1)
  const cred = await boundCredential(ownerId, instanceId)
  const rows = await t.db.execute<{ n: string }>(sql`
    SELECT COUNT(*)::text AS n FROM oauth_token
     WHERE refresh_token_hash = ${hashSessionToken(cred.refreshToken)} AND instance_id = ${instanceId}::uuid`)
  expect(Number([...rows][0]!.n)).toBe(1)
})
