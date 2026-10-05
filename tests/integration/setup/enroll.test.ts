// @vitest-environment node
/*
 * POST /api/v1/setup/enroll — the no-login emit-on-install enroll path (slice 3).
 *
 * docs/design/emit-on-install-provisional-attribution.md §Flows 1. Covers the
 * threat-model invariants: secret gate (the ONLY distinguishable outcome →
 * 401), provisional-only shadow teammate + server-chosen instance, emit-only
 * credential, a re-enrol never touching an existing device, the bootstrap-secret
 * strength floor, constant-shape (known vs unknown email), and the
 * provisional caps (429).
 *
 * Real DB via testcontainers (AGENTS.md: never mock Drizzle). The h3 handler is
 * driven directly through the same ev() harness as
 * tests/integration/setup/provision-redeem-robustness.test.ts.
 */
import { randomUUID } from 'node:crypto'
import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import { startTestDb, stopTestDb, type TestDb } from '../helpers/db'
import * as schema from '../../../drizzle/schema'
import { hashSessionToken } from '../../../server/auth/hmac'
import enrollHandler from '../../../server/api/v1/setup/enroll.post'

let t: TestDb
let regionId: string
let ouId: string

const BOOTSTRAP_SECRET = 'enroll-bootstrap-secret-value-123456'

beforeAll(async () => {
  t = await startTestDb()
  process.env.DATABASE_URL = t.url
  process.env.NUXT_SESSION_SECRET = 'enroll-test-padded-to-thirty-two-chars!!!'
  process.env.NUXT_HMAC_SESSION_KEY = 'enroll-test-hmac-key-padded-well-beyond-32-chars'
  process.env.NUXT_ENROLLMENT_SECRET = BOOTSTRAP_SECRET

  const [r] = await t.db
    .insert(schema.region)
    .values({ code: 'en', displayName: 'EN Region' })
    .returning()
  regionId = r!.id
  const [ou] = await t.db
    .insert(schema.orgUnit)
    .values({
      regionId,
      path: 'en.svc',
      code: 'en-svc',
      displayName: 'EN Svc',
      unitType: 'bu',
      isCostOwningUnit: true,
    })
    .returning()
  ouId = ou!.id
  // A REAL (provisional=false) teammate whose email an attacker might claim — used
  // to assert constant-shape (known vs unknown) + that enroll never touches it.
  await t.db
    .insert(schema.teammate)
    .values({
      entraOid: 'en-oid-real',
      email: 'known@example.com',
      displayName: 'Known',
      role: 'developer',
      regionId,
      orgUnitId: ouId,
    })
    .returning()
}, 90_000)

afterAll(async () => {
  await stopTestDb(t)
}, 30_000)

// ── harness (mirrors provision-redeem-robustness.test.ts ev()) ────────────────

function ev(body: unknown, host = 'localhost:3450') {
  const headers: Record<string, string> = { host }
  return {
    method: 'POST',
    path: '/x',
    context: { params: {} },
    node: {
      req: {
        method: 'POST',
        url: '/x',
        body,
        get headers() {
          return { ...headers, 'content-type': 'application/json' }
        },
      },
      res: {
        _headers: {} as Record<string, string | string[]>,
        statusCode: 200,
        getHeader(n: string) {
          return this._headers[n.toLowerCase()]
        },
        setHeader(n: string, v: string | string[]) {
          this._headers[n.toLowerCase()] = v
        },
        removeHeader(n: string) {
          this._headers[n.toLowerCase()] = ''
        },
        appendHeader(n: string, v: string | string[]) {
          this._headers[n.toLowerCase()] = v
        },
        get headersSent() {
          return false
        },
      },
    },
  }
}

interface EnrollResponse {
  instance_id: string
  session_id: string
  bearer_endpoint: string
  oauth_refresh_token: string
  oauth_token_endpoint: string
  oauth_client_id: string
  project_code: null
  unassigned: boolean
  tool: string
  // claude-code → { claude }, copilot-cli → { copilot } (P1-5 discriminator).
  telemetry: { claude?: Record<string, unknown>; copilot?: Record<string, unknown> }
}

async function enroll(body: unknown, host?: string): Promise<EnrollResponse> {
  return (await enrollHandler(
    ev(body, host) as unknown as Parameters<typeof enrollHandler>[0],
  )) as EnrollResponse
}

function validBody(overrides: Record<string, unknown> = {}) {
  return {
    enrollment_secret: BOOTSTRAP_SECRET,
    claimed_email: 'alice@example.com',
    device_binding: 'device-aaa',
    ...overrides,
  }
}

async function emitScopesForInstance(instanceId: string): Promise<string[]> {
  const rows = await t.client<{ scope: string }[]>`
    SELECT scope FROM oauth_token
     WHERE instance_id = ${instanceId}::uuid AND revoked_at IS NULL`
  return rows.map((r) => r.scope)
}

// ── secret gate ───────────────────────────────────────────────────────────────

describe('enroll — secret gate', () => {
  it('a valid bootstrap secret mints a provisional instance bound to a provisional teammate', async () => {
    const out = await enroll(
      validBody({ claimed_email: 'gate-ok@example.com', device_binding: 'dev-gate-ok' }),
    )
    expect(out.instance_id).toMatch(/^[0-9a-f-]{36}$/)
    expect(out.oauth_refresh_token).toMatch(/.{20,}/)

    const att = await t.client<
      {
        identity_state: string
        claimed_email: string
        teammate_id: string
        principal_email: string | null
      }[]
    >`
      SELECT identity_state, claimed_email, teammate_id::text AS teammate_id, principal_email
        FROM instance_attestation WHERE instance_id = ${out.instance_id}::uuid`
    expect(att[0]!.identity_state).toBe('provisional')
    expect(att[0]!.claimed_email).toBe('gate-ok@example.com')
    expect(att[0]!.principal_email).toBeNull()

    const tm = await t.client<{ provisional: boolean; entra_oid: string; email: string }[]>`
      SELECT provisional, entra_oid, email FROM teammate WHERE id = ${att[0]!.teammate_id}::uuid`
    expect(tm[0]!.provisional).toBe(true)
    expect(tm[0]!.entra_oid).toMatch(/^provisional:/)
    expect(tm[0]!.email).toBe('gate-ok@example.com')
  })

  it('accepts a secret from a live enrollment_secret row (the durable accept-list)', async () => {
    const rowSecret = 'table-secret-rotation-cohort-A-7777'
    await t.client`
      INSERT INTO enrollment_secret (secret_hash, label, not_before, not_after)
      VALUES (${hashSessionToken(rowSecret)}, 'cohort-A', now() - interval '1 hour', now() + interval '1 hour')`
    const out = await enroll(
      validBody({
        enrollment_secret: rowSecret,
        claimed_email: 'table@example.com',
        device_binding: 'dev-table',
      }),
    )
    expect(out.instance_id).toMatch(/^[0-9a-f-]{36}$/)
  })

  it('rejects a bad secret with 401 (the only distinguishable failure)', async () => {
    await expect(
      enroll(validBody({ enrollment_secret: 'totally-wrong-secret' })),
    ).rejects.toMatchObject({ statusCode: 401 })
  })

  it('refuses a bootstrap secret below the key-strength floor (fails closed with 401)', async () => {
    const weak = [
      'short-secret', // under the 32-char floor
      'a'.repeat(48), // long enough, near-zero entropy
      '__TOKENSCOPE_ENROLLMENT_SECRET__', // the plugin's inert placeholder
    ]
    try {
      for (const secret of weak) {
        process.env.NUXT_ENROLLMENT_SECRET = secret
        await expect(
          enroll(
            validBody({
              enrollment_secret: secret,
              claimed_email: 'weak-secret@example.com',
              device_binding: `dev-weak-${randomUUID()}`,
            }),
          ),
        ).rejects.toMatchObject({ statusCode: 401 })
      }
    } finally {
      process.env.NUXT_ENROLLMENT_SECRET = BOOTSTRAP_SECRET
    }
    const rows = await t.client<{ n: string }[]>`
      SELECT COUNT(*)::text AS n FROM instance_attestation WHERE claimed_email = 'weak-secret@example.com'`
    expect(Number(rows[0]!.n)).toBe(0)
  })

  it('rejects a revoked enrollment_secret row with 401', async () => {
    const revoked = 'revoked-secret-value-999'
    await t.client`
      INSERT INTO enrollment_secret (secret_hash, revoked_at) VALUES (${hashSessionToken(revoked)}, now())`
    await expect(enroll(validBody({ enrollment_secret: revoked }))).rejects.toMatchObject({
      statusCode: 401,
    })
  })

  it('rejects an expired (not_after in the past) enrollment_secret row with 401', async () => {
    const expired = 'expired-secret-value-888'
    await t.client`
      INSERT INTO enrollment_secret (secret_hash, not_after) VALUES (${hashSessionToken(expired)}, now() - interval '1 minute')`
    await expect(enroll(validBody({ enrollment_secret: expired }))).rejects.toMatchObject({
      statusCode: 401,
    })
  })
})

// ── emit-only credential ───────────────────────────────────────────────────────

describe('enroll — emit-only credential', () => {
  it('mints a credential carrying tokenscope.emit ONLY (never read/tag)', async () => {
    const out = await enroll(
      validBody({ claimed_email: 'emit-only@example.com', device_binding: 'dev-emit-only' }),
    )
    const scopes = await emitScopesForInstance(out.instance_id)
    expect(scopes).toEqual(['tokenscope.emit'])
  })
})

// ── tool discriminator (P1-5 / gap #16) ─────────────────────────────────────────

describe('enroll — tool discriminator', () => {
  it('defaults to claude-code (no tool field) → claude bundle + attestation.tool=claude-code', async () => {
    const out = await enroll(
      validBody({ claimed_email: 'tool-default@example.com', device_binding: 'dev-tool-default' }),
    )
    expect(out.tool).toBe('claude-code')
    expect(out.telemetry.claude).toBeDefined()
    expect(out.telemetry.copilot).toBeUndefined()
    // The claude bundle's resource attrs carry tool=claude-code, no copilot keys.
    const claude = out.telemetry.claude as Record<string, unknown>
    expect(claude.OTEL_RESOURCE_ATTRIBUTES).toContain(`tokenscope.instance_id=${out.instance_id}`)
    expect(claude.OTEL_RESOURCE_ATTRIBUTES).toContain('tool=claude-code')
    expect(claude.OTEL_LOGS_EXPORTER).toBe('otlp')

    const att = await t.client<{ tool: string }[]>`
      SELECT tool FROM instance_attestation WHERE instance_id = ${out.instance_id}::uuid`
    expect(att[0]!.tool).toBe('claude-code')
  })

  it('tool=copilot-cli → copilot bundle (telemetry.copilot, tool=copilot-cli) + attestation.tool=copilot-cli', async () => {
    const out = await enroll(
      validBody({
        claimed_email: 'tool-copilot@example.com',
        device_binding: 'dev-tool-copilot',
        tool: 'copilot-cli',
      }),
    )
    expect(out.tool).toBe('copilot-cli')
    expect(out.telemetry.copilot).toBeDefined()
    expect(out.telemetry.claude).toBeUndefined()

    // The copilot bundle is the CopilotBundle shape — TOKENSCOPE_* endpoints + the
    // baked tool=copilot-cli resource attrs (no client-side rewrite needed).
    const copilot = out.telemetry.copilot as Record<string, unknown>
    expect(copilot.instance_id).toBe(out.instance_id)
    expect(copilot.TOKENSCOPE_BEARER_ENDPOINT).toBe(out.bearer_endpoint)
    expect(copilot.TOKENSCOPE_OAUTH_TOKEN_ENDPOINT).toBe(out.oauth_token_endpoint)
    expect(typeof copilot.TOKENSCOPE_LOGS_ENDPOINT).toBe('string')
    expect(copilot.OTEL_RESOURCE_ATTRIBUTES).toBe(
      `tokenscope.instance_id=${out.instance_id},tool=copilot-cli`,
    )
    // No claude-only keys leaked into the copilot bundle.
    expect(copilot.OTEL_LOGS_EXPORTER).toBeUndefined()

    // The attestation row is stamped copilot-cli (so the instance's spend groups right).
    const att = await t.client<{ tool: string }[]>`
      SELECT tool FROM instance_attestation WHERE instance_id = ${out.instance_id}::uuid`
    expect(att[0]!.tool).toBe('copilot-cli')
  })

  it('rejects an unknown tool value (the enum is closed)', async () => {
    await expect(
      enroll(
        validBody({
          claimed_email: 'tool-bad@example.com',
          device_binding: 'dev-tool-bad',
          tool: 'gemini-cli',
        }),
      ),
    ).rejects.toBeTruthy()
  })

  it('emit-only credential is identical regardless of tool (copilot enroll is still tokenscope.emit ONLY)', async () => {
    const out = await enroll(
      validBody({
        claimed_email: 'copilot-emit@example.com',
        device_binding: 'dev-copilot-emit',
        tool: 'copilot-cli',
      }),
    )
    expect(await emitScopesForInstance(out.instance_id)).toEqual(['tokenscope.emit'])
  })
})

// ── re-enrol never touches an existing device (TS-EDGE-01) ─────────────────────

async function credentialIsLive(refreshToken: string): Promise<boolean> {
  const rows = await t.client<{ revoked_at: Date | null }[]>`
    SELECT revoked_at FROM oauth_token WHERE refresh_token_hash = ${hashSessionToken(refreshToken)}`
  expect(rows.length).toBe(1) // vacuity guard: a mis-hashed token must fail, not read as live
  return rows[0]!.revoked_at === null
}

describe('enroll — a reuse match mints a fresh device', () => {
  it('re-enrolling the same (claimed_email, device_binding, tool) leaves the original credential live and yields a different instance id', async () => {
    const body = validBody({ claimed_email: 'victim@example.com', device_binding: 'dev-victim' })
    const first = await enroll(body)
    const second = await enroll(body)

    expect(second.instance_id).not.toBe(first.instance_id)
    expect(second.oauth_refresh_token).not.toBe(first.oauth_refresh_token)
    expect(await credentialIsLive(first.oauth_refresh_token)).toBe(true)
    expect(await credentialIsLive(second.oauth_refresh_token)).toBe(true)

    // The original device keeps its own credential, and the second caller's
    // credential is bound to the second instance only.
    const bound = await t.client<{ instance_id: string }[]>`
      SELECT instance_id::text AS instance_id FROM oauth_token
       WHERE refresh_token_hash = ${hashSessionToken(second.oauth_refresh_token)}`
    expect(bound[0]!.instance_id).toBe(second.instance_id)
    expect(await emitScopesForInstance(first.instance_id)).toEqual(['tokenscope.emit'])
  })

  it('a different device for the same email mints a SEPARATE instance + provisional teammate', async () => {
    await enroll(validBody({ claimed_email: 'multi@example.com', device_binding: 'dev-1' }))
    await enroll(validBody({ claimed_email: 'multi@example.com', device_binding: 'dev-2' }))
    const insts = await t.client<{ n: string }[]>`
      SELECT COUNT(*)::text AS n FROM instance_attestation WHERE claimed_email = 'multi@example.com'`
    expect(Number(insts[0]!.n)).toBe(2)
  })
})

// ── constant-shape / no existence oracle ──────────────────────────────────────

describe('enroll — constant-shape (no existence oracle)', () => {
  it('a known real email and an unknown email return the identical response shape', async () => {
    const known = await enroll(
      validBody({ claimed_email: 'known@example.com', device_binding: 'dev-known' }),
    )
    const unknown = await enroll(
      validBody({ claimed_email: 'nobody-here@example.com', device_binding: 'dev-unknown' }),
    )

    expect(Object.keys(known).sort()).toEqual(Object.keys(unknown).sort())
    // No teammate field / canonicalised email leaks into the body.
    expect(JSON.stringify(known)).not.toContain('known@example.com')
    expect((known as Record<string, unknown>).reused).toBeUndefined()

    // The real teammate was NOT touched (enroll minted a provisional shadow instead).
    const real = await t.client<{ provisional: boolean }[]>`
      SELECT provisional FROM teammate WHERE email = 'known@example.com' AND NOT provisional`
    expect(real.length).toBe(1)
    const att = await t.client<{ identity_state: string }[]>`
      SELECT identity_state FROM instance_attestation WHERE instance_id = ${known.instance_id}::uuid`
    expect(att[0]!.identity_state).toBe('provisional')
  })
})

// ── caps ────────────────────────────────────────────────────────────────────

describe('enroll — provisional caps return 429', () => {
  it('the per-claimed_email cap returns 429 once exceeded, including for a re-enrol of the same device', async () => {
    process.env.MAX_PROVISIONAL_INSTANCES_PER_EMAIL = '1'
    try {
      await enroll(validBody({ claimed_email: 'capped@example.com', device_binding: 'cap-dev-1' }))
      // A second DISTINCT device for the same email trips the cap.
      await expect(
        enroll(validBody({ claimed_email: 'capped@example.com', device_binding: 'cap-dev-2' })),
      ).rejects.toMatchObject({ statusCode: 429 })
      // A re-enrol of the FIRST device is a create too, so it trips the cap.
      await expect(
        enroll(validBody({ claimed_email: 'capped@example.com', device_binding: 'cap-dev-1' })),
      ).rejects.toMatchObject({ statusCode: 429 })
    } finally {
      delete process.env.MAX_PROVISIONAL_INSTANCES_PER_EMAIL
    }
  })

  it('an ENDED or PURGED provisional instance does NOT consume quota', async () => {
    /*
     * The caps bound how many devices a claimed identity may have RIGHT NOW, not
     * how many it has ever had. Counting retired rows makes revoke-then-re-enrol
     * cost a permanent slot, so a laptop rebuilt often enough locks its owner out
     * of a door they hold no live device behind. The authenticated sibling
     * (emit-provision.ts) has always filtered on the lifecycle columns; this is
     * the enrol door catching up.
     */
    process.env.MAX_PROVISIONAL_INSTANCES_PER_EMAIL = '1'
    try {
      const first = await enroll(
        validBody({ claimed_email: 'lifecycle@example.com', device_binding: 'lifecycle-dev-1' }),
      )
      // Retire it the way a revoke does — the row stays, the device does not.
      await t.client`
        UPDATE instance_attestation SET ts_actual_end = now()
         WHERE instance_id = ${first.instance_id}::uuid`

      // A different device for the same email now fits under the cap of 1.
      const second = await enroll(
        validBody({ claimed_email: 'lifecycle@example.com', device_binding: 'lifecycle-dev-2' }),
      )
      expect(second.instance_id).not.toBe(first.instance_id)

      // Same again for a PURGED row (soft-purge, the other lifecycle terminal).
      await t.client`
        UPDATE instance_attestation SET ts_actual_end = now(), ts_purged = now()
         WHERE instance_id = ${second.instance_id}::uuid`
      const third = await enroll(
        validBody({ claimed_email: 'lifecycle@example.com', device_binding: 'lifecycle-dev-3' }),
      )
      expect(third.instance_id).not.toBe(second.instance_id)

      // …and the cap still BITES on the one live row that remains.
      await expect(
        enroll(validBody({ claimed_email: 'lifecycle@example.com', device_binding: 'lifecycle-dev-4' })),
      ).rejects.toMatchObject({ statusCode: 429 })
    } finally {
      delete process.env.MAX_PROVISIONAL_INSTANCES_PER_EMAIL
    }
  })

  it('the global provisional cap returns 429 once exceeded', async () => {
    // Many provisional instances already exist from the cases above, so a cap of 1
    // is already exceeded. (A cap of '0' is deliberately treated as garbage and
    // falls back to the default — the guard rejects non-positive values.)
    process.env.MAX_PROVISIONAL_INSTANCES = '1'
    try {
      await expect(
        enroll(
          validBody({
            claimed_email: `global-${randomUUID()}@example.com`,
            device_binding: 'global-dev',
          }),
        ),
      ).rejects.toMatchObject({ statusCode: 429 })
    } finally {
      delete process.env.MAX_PROVISIONAL_INSTANCES
    }
  })
  // ── durable-origin trust gate ───────────────────────────────────────────────
  // What enroll returns is not a one-request answer: bearer_endpoint and the OTLP
  // endpoint are written to the device and re-read for the life of the enrolment.
  // Azure Container Apps rewrites `Host` to the internal CA FQDN, so trusting it
  // blind mints an enrolment that reports success and then emits nothing, forever.

  it('refuses to enrol when it cannot trust its own public origin', async () => {
    const saved = { origin: process.env.APP_PUBLIC_ORIGIN, fd: process.env.AZURE_FRONT_DOOR_ID }
    delete process.env.APP_PUBLIC_ORIGIN
    delete process.env.AZURE_FRONT_DOOR_ID
    const beforeRows = await t.client<{ n: string }[]>`
      SELECT COUNT(*)::text AS n FROM instance_attestation
       WHERE claimed_email = 'alice@example.com' AND identity_state = 'provisional'`
    const before = Number(beforeRows[0]!.n)
    try {
      await expect(
        enroll(
          validBody({ device_binding: `device-untrusted-${randomUUID()}` }),
          'internal.a1b2c3.eastus.azurecontainerapps.io',
        ),
      ).rejects.toMatchObject({ statusCode: 500 })
      // And it must cost the caller NOTHING. The handler commits its
      // transaction before building the bundle, so a check that fired only at
      // bundle-build time would have consumed a provisional cap slot and minted
      // an orphaned credential for a fault the caller cannot fix.
      const rows = await t.client<{ n: string }[]>`
        SELECT COUNT(*)::text AS n FROM instance_attestation
         WHERE claimed_email = 'alice@example.com' AND identity_state = 'provisional'`
      expect(Number(rows[0]!.n)).toBe(before)
    } finally {
      if (saved.origin === undefined) delete process.env.APP_PUBLIC_ORIGIN
      else process.env.APP_PUBLIC_ORIGIN = saved.origin
      if (saved.fd === undefined) delete process.env.AZURE_FRONT_DOOR_ID
      else process.env.AZURE_FRONT_DOOR_ID = saved.fd
    }
  })

  it('the remedy the error names actually works: APP_PUBLIC_ORIGIN unblocks it', async () => {
    // An error that prescribes a fix the operator cannot apply is worse than no
    // error, so pin that the named remedy is the real one AND that the pinned
    // origin (not the untrusted Host) is what gets baked.
    const saved = { origin: process.env.APP_PUBLIC_ORIGIN, fd: process.env.AZURE_FRONT_DOOR_ID }
    delete process.env.AZURE_FRONT_DOOR_ID
    process.env.APP_PUBLIC_ORIGIN = 'https://tokenscope.example.com'
    try {
      const res = await enroll(
        validBody({ device_binding: `device-pinned-${randomUUID()}` }),
        'internal.a1b2c3.eastus.azurecontainerapps.io',
      )
      expect(res.bearer_endpoint).toMatch(/^https:\/\/tokenscope\.example\.com\//)
      expect(res.bearer_endpoint).not.toContain('azurecontainerapps.io')
      expect(res.oauth_token_endpoint).toMatch(/^https:\/\/tokenscope\.example\.com\//)
    } finally {
      if (saved.origin === undefined) delete process.env.APP_PUBLIC_ORIGIN
      else process.env.APP_PUBLIC_ORIGIN = saved.origin
      if (saved.fd === undefined) delete process.env.AZURE_FRONT_DOOR_ID
      else process.env.AZURE_FRONT_DOOR_ID = saved.fd
    }
  })
})
