/*
 * POST /api/v1/oauth/register — registration ceilings and source keying.
 *
 *   - With AZURE_FRONT_DOOR_ID set, the per-source count keys on
 *     X-Azure-SocketIP, so rotating X-Forwarded-For (and the X-Azure-ClientIP
 *     Front Door derives from it) does not evade it.
 *   - Without it, X-Azure-SocketIP is client-supplied and ignored.
 *   - At HARD_MAX_OAUTH_CLIENTS every registration is refused, fresh source
 *     or not.
 *
 * Own database: the hard-cap case fills oauth_client past every ceiling.
 * The per-source window is module state, so each case uses its own addresses.
 */
import { describe, it, expect, beforeAll, afterAll, afterEach } from 'vitest'
import { sql } from 'drizzle-orm'
import { startTestDb, stopTestDb, type TestDb } from '../helpers/db'
import registerHandler from '../../../server/api/v1/oauth/register.post'
import {
  MAX_OAUTH_CLIENTS,
  HARD_MAX_OAUTH_CLIENTS,
  SOURCE_REGISTRATION_LIMIT,
} from '../../../server/auth/oauth'

const FDID = '9a1e0000-0000-4000-8000-000000000001'
const REDIRECT_URI = 'http://127.0.0.1:43117/callback'

let t: TestDb

beforeAll(async () => {
  t = await startTestDb()
  process.env.DATABASE_URL = t.url
  process.env.NUXT_SESSION_SECRET = 'register-ceiling-padded-to-thirty-two!!'
  process.env.NUXT_HMAC_SESSION_KEY = 'register-ceiling-hmac-key-padded-well-beyond-32-chars'
}, 60_000)

afterAll(async () => {
  await stopTestDb(t)
}, 30_000)

afterEach(() => {
  delete process.env.AZURE_FRONT_DOOR_ID
})

function ev(headers: Record<string, string>, clientName: string) {
  const all: Record<string, string> = { host: 'localhost:3450', 'content-type': 'application/json', ...headers }
  const res = {
    _headers: {} as Record<string, string | string[]>,
    _ended: false,
    statusCode: 200,
    getHeader(n: string) { return this._headers[n.toLowerCase()] },
    setHeader(n: string, v: string | string[]) { this._headers[n.toLowerCase()] = v },
    removeHeader(n: string) { this._headers[n.toLowerCase()] = '' },
    appendHeader(n: string, v: string | string[]) { this._headers[n.toLowerCase()] = v },
    write() { return true },
    end() { this._ended = true; return this },
    get headersSent() { return this._ended },
  }
  return {
    method: 'POST',
    path: '/api/v1/oauth/register',
    context: { params: {} },
    node: {
      req: {
        method: 'POST',
        url: '/api/v1/oauth/register',
        body: { client_name: clientName, redirect_uris: [REDIRECT_URI] },
        socket: { remoteAddress: '10.0.0.4' },
        headers: all,
      },
      res,
    },
  }
}

async function register(headers: Record<string, string>, clientName = 'Ceiling Test') {
  const e = ev(headers, clientName)
  const body = await (registerHandler as unknown as (e: unknown) => Promise<{ client_id?: string; error?: string }>)(e)
  return { status: e.node.res.statusCode, body }
}

async function clientCount(): Promise<number> {
  const rows = [...(await t.db.execute<{ count: string }>(sql`SELECT COUNT(*)::text AS count FROM oauth_client`))]
  return Number(rows[0]!.count)
}

async function fillTo(target: number): Promise<void> {
  const needed = target - (await clientCount())
  if (needed <= 0) return
  await t.db.execute(sql`
    INSERT INTO oauth_client (client_id, client_secret_hash, client_name, redirect_uris, internal, created_at)
    SELECT gen_random_uuid(), 'synthetic-hash-' || gen_random_uuid(), 'Synthetic Flood Client',
           ARRAY['http://127.0.0.1/cb'], false, now()
    FROM generate_series(1, ${needed})
  `)
}

describe('DCR per-source keying', () => {
  it('Front Door configured: keys on X-Azure-SocketIP, so rotating X-Forwarded-For and X-Azure-ClientIP is still denied', async () => {
    process.env.AZURE_FRONT_DOOR_ID = FDID
    await fillTo(MAX_OAUTH_CLIENTS)

    const flooder = '203.0.113.10'
    for (let i = 0; i < SOURCE_REGISTRATION_LIMIT; i++) {
      const spoofed = `198.18.0.${i + 1}`
      const r = await register(
        { 'x-azure-socketip': flooder, 'x-azure-clientip': spoofed, 'x-forwarded-for': spoofed },
        `Flood ${i}`,
      )
      expect(r.status).toBe(201)
    }
    const denied = await register({ 'x-azure-socketip': flooder, 'x-azure-clientip': '198.18.1.1', 'x-forwarded-for': '198.18.1.1' })
    expect(denied.status).toBe(429)
    expect(denied.body.error).toBe('temporarily_unavailable')

    // Reserved headroom: another client address still registers.
    const fresh = await register({ 'x-azure-socketip': '203.0.113.11', 'x-forwarded-for': '198.18.1.2' })
    expect(fresh.status).toBe(201)
    expect(fresh.body.client_id).toBeTruthy()
  })

  it('no Front Door: X-Azure-SocketIP is client-supplied and ignored; today\'s key applies', async () => {
    await fillTo(MAX_OAUTH_CLIENTS)

    const xff = '203.0.113.20'
    for (let i = 0; i < SOURCE_REGISTRATION_LIMIT; i++) {
      const r = await register({ 'x-forwarded-for': xff, 'x-azure-socketip': `198.18.2.${i + 1}` }, `Dev ${i}`)
      expect(r.status).toBe(201)
    }
    const denied = await register({ 'x-forwarded-for': xff, 'x-azure-socketip': '198.18.3.1' })
    expect(denied.status).toBe(429)
  })
})

describe('DCR per-source ceiling under concurrency', () => {
  it('concurrent registrations from one source admit exactly the per-source limit', async () => {
    await fillTo(MAX_OAUTH_CLIENTS)
    const results = await Promise.all(
      Array.from({ length: SOURCE_REGISTRATION_LIMIT + 5 }, (_, i) =>
        register({ 'x-forwarded-for': '203.0.113.40' }, `Same Source ${i}`),
      ),
    )
    expect(results.filter((r) => r.status === 201)).toHaveLength(SOURCE_REGISTRATION_LIMIT)
    expect(results.filter((r) => r.status === 429)).toHaveLength(5)
  })
})

describe('DCR hard cap', () => {
  it('is well above the per-source + global ceiling', () => {
    expect(HARD_MAX_OAUTH_CLIENTS).toBe(10 * MAX_OAUTH_CLIENTS)
  })

  it('concurrent registrations one below the cap admit exactly one', async () => {
    await fillTo(HARD_MAX_OAUTH_CLIENTS - 1)
    const results = await Promise.all(
      Array.from({ length: 8 }, (_, i) => register({ 'x-forwarded-for': `203.0.113.${150 + i}` }, `Race ${i}`)),
    )
    expect(results.filter((r) => r.status === 201)).toHaveLength(1)
    expect(results.filter((r) => r.status === 429)).toHaveLength(7)
    expect(await clientCount()).toBe(HARD_MAX_OAUTH_CLIENTS)
  })

  it('at HARD_MAX_OAUTH_CLIENTS a fresh, never-seen source is refused and no row is written', async () => {
    await fillTo(HARD_MAX_OAUTH_CLIENTS)
    const before = await clientCount()
    const r = await register({ 'x-forwarded-for': '203.0.113.99' }, 'Fresh After Hard Cap')
    expect(r.status).toBe(429)
    expect(r.body.error).toBe('temporarily_unavailable')
    expect(await clientCount()).toBe(before)
  })
})
