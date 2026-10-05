// @vitest-environment node
/*
 * Cross-TOOL guard on the ENROL path — enroll-provision.ts.
 *
 * WHY A SECOND FILE. cross-tool-guard.test.ts covers the AUTHENTICATED
 * provision_emit path (emit-provision.ts §locateOrCreateInstance). This file
 * covers the UNAUTHENTICATED emit-on-install path
 * (enroll-provision.ts §locateOrCreateProvisionalInstance), which reaches the
 * SAME destructive rotation through a different door:
 *
 *   /setup/enroll -> locateOrCreateProvisionalInstance -> issueInstanceEmitCredentialTx
 *                                                          ^ revokes every live
 *                                                            emit credential on
 *                                                            that instance
 *
 * The reuse branch there accepted a `tool` argument and STAMPED it on create,
 * but never COMPARED it on reuse — so enrolling copilot-cli on a host that had
 * already enrolled claude-code returned that same instance and revoked the
 * claude credential. Identical blast radius to the bug the sibling file
 * documents, through a route that needs no authentication.
 *
 * The enrol path now mints a fresh instance on every call (TS-EDGE-01), so no
 * enrol can reach another instance's credential, whatever the tool. Two tools
 * on one host get two instances; a 409 would turn an unauthenticated route
 * into an enrolled-email oracle.
 *
 * These tests assert the property that actually matters — the FIRST tool's
 * credential is still LIVE afterwards — not merely that the ids differ.
 *
 * Real DB via testcontainers (AGENTS.md: never mock Drizzle).
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import { randomUUID } from 'node:crypto'
import { sql } from 'drizzle-orm'
import { startTestDb, stopTestDb, type TestDb } from '../helpers/db'
import * as schema from '../../../drizzle/schema'
import { locateOrCreateProvisionalInstance } from '../../../server/auth/enroll-provision'
import { issueInstanceEmitCredentialTx } from '../../../server/auth/emit-provision'
import { hashSessionToken } from '../../../server/auth/hmac'

let t: TestDb

beforeAll(async () => {
  t = await startTestDb()
  process.env.DATABASE_URL = t.url
  process.env.NUXT_HMAC_SESSION_KEY = 'cross-tool-enrol-test-hmac-key-padded-beyond-32'

  const [r] = await t.db
    .insert(schema.region)
    .values({ code: 'apac', displayName: 'APAC' })
    .returning()
  await t.db.insert(schema.orgUnit).values({
    regionId: r!.id,
    path: 'apac.unplaced',
    code: '__UNPLACED__',
    displayName: 'Unplaced',
    unitType: 'holding',
    isCostOwningUnit: false,
  })
}, 90_000)

afterAll(async () => {
  await stopTestDb(t)
}, 30_000)

async function toolOf(instanceId: string): Promise<string | null> {
  const rows = await t.client<
    { tool: string }[]
  >`SELECT tool FROM instance_attestation WHERE instance_id = ${instanceId}::uuid`
  return rows[0]?.tool ?? null
}

/**
 * Mints a live emit credential bound to `instanceId`, exactly the way
 * /setup/enroll does (issueInstanceEmitCredentialTx with an issue() that
 * inserts the row). Returns the refresh token so a later assertion can prove
 * THAT SPECIFIC credential is still live, rather than merely counting rows.
 */
async function mintEmitCredential(teammateId: string, instanceId: string): Promise<string> {
  const clientId = randomUUID()
  await t.client`
    INSERT INTO oauth_client (client_id, client_secret_hash, client_name, redirect_uris)
    VALUES (${clientId}::uuid, 'test-secret-hash', 'test-cli', ARRAY['http://127.0.0.1/cb'])
  `
  const refreshToken = `rt-${randomUUID()}`
  await t.db.transaction(async (tx) => {
    await issueInstanceEmitCredentialTx(tx as never, teammateId, instanceId, async (db) => {
      // Insert through the DB handle the callback is HANDED, not through
      // t.client. t.client is a separate autocommit connection, so using it here
      // would put the credential outside the transaction that is rotating it:
      // the rotate would roll back while the new row survived, which is the
      // opposite of the atomicity issueInstanceEmitCredentialTx exists to
      // provide, and would leave this helper quietly not exercising it.
      await (db as unknown as typeof tx).execute(sql`
        INSERT INTO oauth_token
          (access_token_hash, refresh_token_hash, client_id, teammate_id, scope,
           access_expires_at, refresh_expires_at)
        VALUES (${hashSessionToken(`at-${refreshToken}`)}, ${hashSessionToken(refreshToken)},
                ${clientId}::uuid, ${teammateId}::uuid, 'tokenscope.emit',
                now() + interval '1 hour', now() + interval '90 days')
      `)
      return { clientId, tokens: { refresh_token: refreshToken } }
    })
  })
  return refreshToken
}

async function credentialIsLive(refreshToken: string): Promise<boolean> {
  const rows = await t.client<{ revoked_at: Date | null }[]>`
    SELECT revoked_at FROM oauth_token WHERE refresh_token_hash = ${hashSessionToken(refreshToken)}
  `
  expect(rows.length).toBe(1) // vacuity guard: a typo'd hash must fail, not read as "live"
  return rows[0]!.revoked_at === null
}

describe('enrol path — cross-tool device reuse is partitioned, not shared', () => {
  it('a copilot-cli enrol does NOT reuse the claude-code instance for the same (email, device)', async () => {
    const email = 'enrol-tool-1@example.com'
    const device = 'device-enrol-1'

    const claude = await locateOrCreateProvisionalInstance(
      t.db as never,
      email,
      device,
      'claude-code',
    )
    if ('capExceeded' in claude) throw new Error('unexpected cap')
    const copilot = await locateOrCreateProvisionalInstance(
      t.db as never,
      email,
      device,
      'copilot-cli',
    )
    if ('capExceeded' in copilot) throw new Error('unexpected cap')

    expect(copilot.instanceId).not.toBe(claude.instanceId)
    // The two instances carry SEPARATE shadow teammates. That is the accepted
    // cost of partitioning (see the long note in enroll-provision.ts): sharing
    // one shadow would be nicer, but "a fresh shadow per (email, device)" is an
    // invariant confirm-instance.test.ts already encodes. Pinned here so the
    // trade-off is visible rather than incidental — and so that a later change
    // to share the shadow has to come here and state its case.
    expect(copilot.teammateId).not.toBe(claude.teammateId)
    const shadows = await t.client<{ email: string }[]>`
      SELECT email FROM teammate WHERE provisional = true AND lower(email) = ${email}
    `
    expect(shadows.length).toBe(2)
    // Both are the SAME human by claimed email, which is what the provisional
    // instance list keys on, so neither instance goes missing from their view.
    expect(new Set(shadows.map((r) => r.email)).size).toBe(1)
    expect(await toolOf(claude.instanceId)).toBe('claude-code')
    expect(await toolOf(copilot.instanceId)).toBe('copilot-cli')
  })

  it('the claude-code emit credential is STILL LIVE after a copilot-cli enrol — the whole point', async () => {
    const email = 'enrol-tool-2@example.com'
    const device = 'device-enrol-2'

    const claude = await locateOrCreateProvisionalInstance(
      t.db as never,
      email,
      device,
      'claude-code',
    )
    if ('capExceeded' in claude) throw new Error('unexpected cap')
    const claudeRefresh = await mintEmitCredential(claude.teammateId, claude.instanceId)
    expect(await credentialIsLive(claudeRefresh)).toBe(true)

    // Now the other CLI enrols from the same host, and rotates on ITS instance.
    const copilot = await locateOrCreateProvisionalInstance(
      t.db as never,
      email,
      device,
      'copilot-cli',
    )
    if ('capExceeded' in copilot) throw new Error('unexpected cap')
    await mintEmitCredential(copilot.teammateId, copilot.instanceId)

    // Before the fix this read false: the enrol reused claude's instance, so
    // issueInstanceEmitCredentialTx revoked claude's credential and claude
    // kept running while emitting nothing.
    expect(await credentialIsLive(claudeRefresh)).toBe(true)
  })

  it('re-enrolling the SAME tool mints a new instance and leaves the first credential live (TS-EDGE-01)', async () => {
    const email = 'enrol-tool-3@example.com'
    const device = 'device-enrol-3'

    const first = await locateOrCreateProvisionalInstance(
      t.db as never,
      email,
      device,
      'copilot-cli',
    )
    if ('capExceeded' in first) throw new Error('unexpected cap')
    const firstRefresh = await mintEmitCredential(first.teammateId, first.instanceId)

    const second = await locateOrCreateProvisionalInstance(
      t.db as never,
      email,
      device,
      'copilot-cli',
    )
    if ('capExceeded' in second) throw new Error('unexpected cap')
    await mintEmitCredential(second.teammateId, second.instanceId)

    expect(second.instanceId).not.toBe(first.instanceId)
    expect(await credentialIsLive(firstRefresh)).toBe(true)
  })

  it('rotation on one tool revokes only THAT tool — proving the partition is the thing protecting it', async () => {
    const email = 'enrol-tool-4@example.com'
    const device = 'device-enrol-4'

    const claude = await locateOrCreateProvisionalInstance(
      t.db as never,
      email,
      device,
      'claude-code',
    )
    if ('capExceeded' in claude) throw new Error('unexpected cap')
    const copilot = await locateOrCreateProvisionalInstance(
      t.db as never,
      email,
      device,
      'copilot-cli',
    )
    if ('capExceeded' in copilot) throw new Error('unexpected cap')

    const claudeRefresh = await mintEmitCredential(claude.teammateId, claude.instanceId)
    const copilotRefresh = await mintEmitCredential(copilot.teammateId, copilot.instanceId)

    // Re-provision copilot only. Its OWN previous credential must die (that is
    // correct rotation); claude's must not.
    await mintEmitCredential(copilot.teammateId, copilot.instanceId)

    expect(await credentialIsLive(copilotRefresh)).toBe(false)
    expect(await credentialIsLive(claudeRefresh)).toBe(true)
  })
})
