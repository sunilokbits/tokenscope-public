/*
 * copilot-enroll — emit-on-install enrolment unit tests (the Copilot CLI client
 * half of docs/design/emit-on-install-provisional-attribution.md §Flows 1; the
 * analogue of tests/unit/plugin/enroll.test.ts for the Claude plugin).
 *
 * enrollIfNeeded() must be a strict NO-OP unless it's a fresh install of the real
 * (publish-injected) plugin, and on success must write the enroll response onto the
 * forwarder-readable ~/.tokenscope/config.json contract. These tests pin the
 * decision logic + the wire body + the config.json mapping:
 *
 *   1. already-enrolled  → no-op (never re-enrol / never clobber a credential)
 *   2. no bundled secret → no-op (un-injected dev build enrols no one)
 *   3. no claimed email  → no-op (never guess a bad identity)
 *   4. success           → POSTs {secret, claimed_email, device_binding} and
 *                          writes config.copilot-cli.json
 *   5. failures (network / bad bundle) stay silent and write NOTHING
 *
 * plus the email-source selection (git identity first — Copilot has no Claude OAuth
 * email file), device-binding shape, the tool=copilot-cli rewrite, and the
 * placeholder bundled-secret resolution.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { mkdtempSync, writeFileSync, readFileSync, existsSync, rmSync, mkdirSync, readdirSync } from 'node:fs'
import { tmpdir, hostname } from 'node:os'
import { join } from 'node:path'
// The baked host (copilot-plugin/scripts/enroll.mjs must agree: check:copilot-plugin-sync).
import { DEFAULT_API_BASE } from '../../../plugin/scripts/api-base.mjs'
import { execFileSync } from 'node:child_process'

import {
  enrollIfNeeded,
  isEnrolled,
  readClaimedEmail,
  computeDeviceBinding,
  buildCopilotConfig,
  writeTokenscopeConfig,
  resolveApiBase,
  // eslint-disable-next-line @typescript-eslint/ban-ts-comment
  // @ts-ignore — .mjs resolved by Vitest
} from '../../../copilot-plugin/scripts/enroll.mjs'
import {
  resolveEnrollmentSecret,
  // eslint-disable-next-line @typescript-eslint/ban-ts-comment
  // @ts-ignore — .mjs resolved by Vitest
} from '../../../copilot-plugin/scripts/enrollment-secret.mjs'

// A complete, valid enroll response. With P1-5 the POST passes tool=copilot-cli, so
// the shared POST /api/v1/setup/enroll endpoint returns the COPILOT-shaped bundle
// directly (telemetry.copilot, the CopilotBundle shape — TOKENSCOPE_* endpoints +
// resource attrs that ALREADY say tool=copilot-cli). The client consumes it verbatim
// (no regex rewrite). Mirrors the redeem-path copilot bundle copilot-redeem.mjs maps.
const FAKE_ENROLL_RESPONSE = {
  instance_id: 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee',
  tool: 'copilot-cli',
  bearer_endpoint: 'https://ts.example.com/api/v1/instances/aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee/bearer',
  oauth_refresh_token: 'rt_provisional_secret',
  oauth_token_endpoint: 'https://ts.example.com/api/v1/oauth/token',
  oauth_client_id: 'client-prov',
  telemetry: {
    copilot: {
      TOKENSCOPE_BEARER_ENDPOINT: 'https://ts.example.com/api/v1/instances/aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee/bearer',
      TOKENSCOPE_OAUTH_TOKEN_ENDPOINT: 'https://ts.example.com/api/v1/oauth/token',
      TOKENSCOPE_OAUTH_CLIENT_ID: 'client-prov',
      TOKENSCOPE_LOGS_ENDPOINT: 'https://ts.example.com/v1/logs',
      COPILOT_OTEL_FILE_EXPORTER_PATH: '~/.tokenscope/copilot-otel.jsonl',
      OTEL_RESOURCE_ATTRIBUTES: 'tokenscope.instance_id=aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee,tool=copilot-cli',
      instance_id: 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee',
    },
  },
}

// A config.json that already carries a complete emit enrolment.
const ENROLLED_CONFIG = {
  instance_id: 'existing-id',
  bearer_endpoint: 'https://ts.example.com/bearer',
  oauth_refresh_token: 'rt_existing',
  oauth_token_endpoint: 'https://ts.example.com/oauth/token',
  oauth_client_id: 'client-existing',
  logs_endpoint: 'https://ts.example.com/logs',
}

let dir: string
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'ts-copilot-enroll-'))
})
afterEach(() => {
  rmSync(dir, { recursive: true, force: true })
})

// Common injected deps so a unit test never touches the real network / fs / env.
const baseOpts = () => ({
  apiBase: 'https://ts.example.com',
  enrollmentSecret: 'BUNDLED_SECRET',
  claimedEmail: 'dev@example.com',
  deviceBinding: 'host:machine',
  targetDir: dir,
  // No-op the shell-rc arming by default so a unit test never writes the real ~/.bashrc.
  // The dedicated test below injects a spy to assert it fires.
  armRc: () => {},
})

describe('isEnrolled', () => {
  it('true only when refresh token + bearer endpoint + non-empty instance id all present', () => {
    expect(isEnrolled(ENROLLED_CONFIG)).toBe(true)
  })
  it('false for null / non-object / empty config', () => {
    expect(isEnrolled(null)).toBe(false)
    expect(isEnrolled(undefined)).toBe(false)
    expect(isEnrolled({})).toBe(false)
  })
  it('false when any of the three is missing or blank', () => {
    expect(isEnrolled({ ...ENROLLED_CONFIG, oauth_refresh_token: '' })).toBe(false)
    expect(isEnrolled({ ...ENROLLED_CONFIG, bearer_endpoint: '  ' })).toBe(false)
    expect(isEnrolled({ ...ENROLLED_CONFIG, instance_id: '' })).toBe(false)
  })
})

describe('resolveEnrollmentSecret', () => {
  it('returns "" for the un-injected source build (placeholder)', () => {
    expect(resolveEnrollmentSecret({})).toBe('')
  })
  it('honours the TOKENSCOPE_ENROLLMENT_SECRET env override', () => {
    expect(resolveEnrollmentSecret({ TOKENSCOPE_ENROLLMENT_SECRET: '  real-secret  ' })).toBe('real-secret')
  })
})

/*
 * The Copilot enrol door's destination.
 *
 * This resolver used to rank TOKENSCOPE_API_BASE FIRST — above even an explicit
 * argument — which is the precedence plugin/scripts/api-base.mjs identifies as
 * the vulnerability, in the one place that POSTs the bundled enrollment secret
 * and persists the endpoints that come back. It was a second, private copy
 * outside sync-copilot-plugin.mjs's FILES list, so the drift check could not see
 * it. `discovered` is passed explicitly throughout so these never read the real
 * home directory.
 */
describe('resolveApiBase', () => {
  it('falls back to the baked default and strips a trailing slash', () => {
    expect(resolveApiBase('https://ts.example.com/', { discovered: null })).toBe(
      'https://ts.example.com',
    )
    expect(resolveApiBase(null, { discovered: null })).toBe(DEFAULT_API_BASE)
  })

  it('prefers a registered MCP origin over the baked default', () => {
    // The operator who registered their own server enrols against their own
    // server. This is what replaced the env var as the middle source.
    expect(resolveApiBase(null, { discovered: 'https://ts-own.example.com' })).toBe(
      'https://ts-own.example.com',
    )
  })

  it('lets an explicitly passed base outrank discovery', () => {
    expect(
      resolveApiBase('https://typed.example.com', { discovered: 'https://ts-own.example.com' }),
    ).toBe('https://typed.example.com')
  })

  it('does NOT let TOKENSCOPE_API_BASE choose where the enrollment secret is POSTed', () => {
    // The pin. A repository can supply this variable, and repo-supplied env is
    // indistinguishable from shell-exported env, so it is not a source for a
    // path that ships an org-wide secret and stores whatever comes back.
    const saved = process.env.TOKENSCOPE_API_BASE
    process.env.TOKENSCOPE_API_BASE = 'https://attacker.example.com'
    try {
      expect(resolveApiBase(null, { discovered: null })).toBe(DEFAULT_API_BASE)
      expect(resolveApiBase(null, { discovered: 'https://ts-own.example.com' })).toBe(
        'https://ts-own.example.com',
      )
      expect(resolveApiBase('https://typed.example.com', { discovered: null })).not.toContain(
        'attacker',
      )
    } finally {
      if (saved === undefined) delete process.env.TOKENSCOPE_API_BASE
      else process.env.TOKENSCOPE_API_BASE = saved
    }
  })
})

describe('readClaimedEmail — source selection (git first — Copilot has no Claude OAuth file)', () => {
  it('prefers git config user.email', () => {
    const home = mkdtempSync(join(tmpdir(), 'ts-home-'))
    const repo = mkdtempSync(join(tmpdir(), 'ts-repo-'))
    execFileSync('git', ['init', '-q'], { cwd: repo })
    execFileSync('git', ['config', 'user.email', 'git@example.com'], { cwd: repo })
    expect(readClaimedEmail({ home, cwd: repo })).toBe('git@example.com')
    rmSync(home, { recursive: true, force: true })
    rmSync(repo, { recursive: true, force: true })
  })

  it('falls back to ~/.copilot/config.json email when git yields nothing', () => {
    const home = mkdtempSync(join(tmpdir(), 'ts-home-'))
    const repo = mkdtempSync(join(tmpdir(), 'ts-norepo-')) // not a git repo
    mkdirSync(join(home, '.copilot'), { recursive: true })
    writeFileSync(join(home, '.copilot', 'config.json'), JSON.stringify({ user: { email: 'copilot@example.com' } }))
    const saved = { g: process.env.GIT_CONFIG_GLOBAL, s: process.env.GIT_CONFIG_SYSTEM }
    process.env.GIT_CONFIG_GLOBAL = '/dev/null'
    process.env.GIT_CONFIG_SYSTEM = '/dev/null'
    try {
      expect(readClaimedEmail({ home, cwd: repo })).toBe('copilot@example.com')
    } finally {
      if (saved.g === undefined) delete process.env.GIT_CONFIG_GLOBAL
      else process.env.GIT_CONFIG_GLOBAL = saved.g
      if (saved.s === undefined) delete process.env.GIT_CONFIG_SYSTEM
      else process.env.GIT_CONFIG_SYSTEM = saved.s
      rmSync(home, { recursive: true, force: true })
      rmSync(repo, { recursive: true, force: true })
    }
  })

  it('returns null when neither source yields an @ address (never guesses)', () => {
    const home = mkdtempSync(join(tmpdir(), 'ts-home-')) // no .copilot
    const repo = mkdtempSync(join(tmpdir(), 'ts-norepo-')) // not a git repo
    const saved = { g: process.env.GIT_CONFIG_GLOBAL, s: process.env.GIT_CONFIG_SYSTEM }
    process.env.GIT_CONFIG_GLOBAL = '/dev/null'
    process.env.GIT_CONFIG_SYSTEM = '/dev/null'
    try {
      expect(readClaimedEmail({ home, cwd: repo })).toBeNull()
    } finally {
      if (saved.g === undefined) delete process.env.GIT_CONFIG_GLOBAL
      else process.env.GIT_CONFIG_GLOBAL = saved.g
      if (saved.s === undefined) delete process.env.GIT_CONFIG_SYSTEM
      else process.env.GIT_CONFIG_SYSTEM = saved.s
      rmSync(home, { recursive: true, force: true })
      rmSync(repo, { recursive: true, force: true })
    }
  })
})

describe('computeDeviceBinding', () => {
  it('is a stable per-host id beginning with the hostname', () => {
    const b = computeDeviceBinding()
    expect(b.startsWith(hostname())).toBe(true)
  })
})

describe('buildCopilotConfig — response → config.json mapping', () => {
  it('maps the copilot-shaped enroll bundle onto the forwarder config shape', () => {
    const cfg = buildCopilotConfig(FAKE_ENROLL_RESPONSE)
    expect(cfg.instance_id).toBe('aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee')
    expect(cfg.bearer_endpoint).toBe(FAKE_ENROLL_RESPONSE.bearer_endpoint)
    expect(cfg.logs_endpoint).toBe('https://ts.example.com/v1/logs')
    expect(cfg.oauth_token_endpoint).toBe(FAKE_ENROLL_RESPONSE.oauth_token_endpoint)
    expect(cfg.oauth_client_id).toBe('client-prov')
    expect(cfg.oauth_refresh_token).toBe('rt_provisional_secret')
    // RELATIVE per-project span path (matches copilot-redeem) — resolved by Copilot
    // against its launch cwd (= project root), NOT an absolute HOME path.
    expect(cfg).not.toHaveProperty('copilot_otel_file_path') // the extension needs no span path
    // tool=copilot-cli comes baked from the server bundle — consumed verbatim, no rewrite.
    expect(cfg.otel_resource_attributes).toBe('tokenscope.instance_id=aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee,tool=copilot-cli')
  })

  /*
   * THE SAME v2 SHAPE THE MANUAL REDEEM WRITES. Emit-on-install used to produce
   * a v2-NAMED file with a v1 body, so the helper's own tool check — the one
   * that catches a store renamed or copied between lanes — silently did nothing
   * on every auto-enrolled device.
   */
  it('REFUSES a response whose attributes disagree with the envelope (fail-open, nothing written)', () => {
    const bad = JSON.parse(JSON.stringify(FAKE_ENROLL_RESPONSE))
    bad.telemetry.copilot.OTEL_RESOURCE_ATTRIBUTES = 'tokenscope.instance_id=someone-else,tool=copilot-cli'
    expect(() => buildCopilotConfig(bad)).toThrow(/instance/)
  })

  it('stamps the v2 envelope so the helper tool check is not a no-op', () => {
    const cfg = buildCopilotConfig(FAKE_ENROLL_RESPONSE)
    expect(cfg.version).toBe(2)
    expect(cfg.tool).toBe('copilot-cli')
    // and it agrees with the marker the client actually emits
    expect(cfg.otel_resource_attributes).toContain(`tool=${cfg.tool}`)
  })

  it('maps the bundle even when the top-level oauth/endpoint mirrors are absent (bundle is the source of truth)', () => {
    // The CopilotBundle carries the endpoints itself; buildCopilotConfig must fall
    // back to them so it does not depend on the redeem-shaped top-level mirrors.
    const bundleOnly = {
      instance_id: FAKE_ENROLL_RESPONSE.instance_id,
      tool: 'copilot-cli',
      oauth_refresh_token: 'rt_provisional_secret',
      telemetry: { copilot: { ...FAKE_ENROLL_RESPONSE.telemetry.copilot } },
    }
    const cfg = buildCopilotConfig(bundleOnly)
    expect(cfg.bearer_endpoint).toBe('https://ts.example.com/api/v1/instances/aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee/bearer')
    expect(cfg.logs_endpoint).toBe('https://ts.example.com/v1/logs')
    expect(cfg.oauth_token_endpoint).toBe('https://ts.example.com/api/v1/oauth/token')
    expect(cfg.oauth_client_id).toBe('client-prov')
    expect(cfg.otel_resource_attributes).toBe('tokenscope.instance_id=aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee,tool=copilot-cli')
  })

  it('throws when the resource attrs carry no non-empty instance id', () => {
    const bad = {
      ...FAKE_ENROLL_RESPONSE,
      instance_id: '', // also blank top-level
      telemetry: { copilot: { ...FAKE_ENROLL_RESPONSE.telemetry.copilot, instance_id: '', OTEL_RESOURCE_ATTRIBUTES: 'tool=copilot-cli' } },
    }
    expect(() => buildCopilotConfig(bad)).toThrow()
  })

  it('throws when the OAuth credential is incomplete', () => {
    const bad = { ...FAKE_ENROLL_RESPONSE, oauth_refresh_token: '' }
    expect(() => buildCopilotConfig(bad)).toThrow()
  })

  it('throws when the logs endpoint is missing', () => {
    const bad = {
      ...FAKE_ENROLL_RESPONSE,
      logs_endpoint: '',
      telemetry: { copilot: { ...FAKE_ENROLL_RESPONSE.telemetry.copilot, TOKENSCOPE_LOGS_ENDPOINT: '' } },
    }
    expect(() => buildCopilotConfig(bad)).toThrow()
  })

  // S2 — closes the Copilot leg of client-plugins:mitm:0003: buildCopilotConfig
  // now validates the resolved endpoint bundle via assertSafeRedeemBundle (reused
  // from copilot-redeem.mjs, not re-implemented) BEFORE returning a config the
  // caller persists to ~/.tokenscope/config.json.
  it('throws when the bearer endpoint downgrades to plaintext http (off-box)', () => {
    const bad = {
      ...FAKE_ENROLL_RESPONSE,
      bearer_endpoint: 'http://attacker.example.com/api/v1/instances/abc/bearer',
      telemetry: {
        copilot: {
          ...FAKE_ENROLL_RESPONSE.telemetry.copilot,
          TOKENSCOPE_BEARER_ENDPOINT: 'http://attacker.example.com/api/v1/instances/abc/bearer',
        },
      },
    }
    expect(() => buildCopilotConfig(bad)).toThrow(/TOKENSCOPE_BEARER_ENDPOINT/)
  })

  it('throws when the logs endpoint downgrades to plaintext http (off-box)', () => {
    const bad = {
      ...FAKE_ENROLL_RESPONSE,
      telemetry: {
        copilot: { ...FAKE_ENROLL_RESPONSE.telemetry.copilot, TOKENSCOPE_LOGS_ENDPOINT: 'http://attacker.example.com/v1/logs' },
      },
    }
    expect(() => buildCopilotConfig(bad)).toThrow(/TOKENSCOPE_LOGS_ENDPOINT/)
  })

  it('throws when the oauth token endpoint downgrades to plaintext http (off-box)', () => {
    const bad = {
      ...FAKE_ENROLL_RESPONSE,
      oauth_token_endpoint: 'http://attacker.example.com/api/v1/oauth/token',
      telemetry: {
        copilot: {
          ...FAKE_ENROLL_RESPONSE.telemetry.copilot,
          TOKENSCOPE_OAUTH_TOKEN_ENDPOINT: 'http://attacker.example.com/api/v1/oauth/token',
        },
      },
    }
    expect(() => buildCopilotConfig(bad)).toThrow(/TOKENSCOPE_OAUTH_TOKEN_ENDPOINT/)
  })

  it('throws when the response carries a CLAUDE bundle instead of a copilot bundle (wrong tool)', () => {
    // Belt-and-braces: if the server ever returned telemetry.claude for a copilot
    // enroll, there is no telemetry.copilot to map → unattributable → throw, not a
    // silently mis-shaped config.
    const claudeShaped = {
      instance_id: FAKE_ENROLL_RESPONSE.instance_id,
      tool: 'claude-code',
      oauth_refresh_token: 'rt_provisional_secret',
      telemetry: {
        claude: {
          OTEL_EXPORTER_OTLP_LOGS_ENDPOINT: 'https://ts.example.com/v1/logs',
          otel_headers_helper_url: 'https://ts.example.com/api/v1/instances/aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee/bearer',
          OTEL_RESOURCE_ATTRIBUTES: 'tokenscope.instance_id=aaaaaaaa,tool=claude-code',
        },
      },
    }
    expect(() => buildCopilotConfig(claudeShaped)).toThrow()
  })
})

describe('writeTokenscopeConfig — on-disk contract', () => {
  it('writes config.copilot-cli.json (with refresh token) and never the access-token cache', () => {
    const cfg = buildCopilotConfig(FAKE_ENROLL_RESPONSE)
    writeTokenscopeConfig(cfg, dir)
    const written = JSON.parse(readFileSync(join(dir, 'config.copilot-cli.json'), 'utf8'))
    expect(written.oauth_refresh_token).toBe('rt_provisional_secret')
    expect(written.instance_id).toBe(cfg.instance_id)
    // The cache has one writer, the helper.
    expect(existsSync(join(dir, 'oauth-access.copilot-cli.json'))).toBe(false)
  })

  it('does NOT clobber an existing oauth-access.json (live helper cache)', () => {
    const cfg = buildCopilotConfig(FAKE_ENROLL_RESPONSE)
    const live = { access_token: 'live', expires_at: 9999999999 }
    writeFileSync(join(dir, 'oauth-access.copilot-cli.json'), JSON.stringify(live))
    writeTokenscopeConfig(cfg, dir)
    expect(JSON.parse(readFileSync(join(dir, 'oauth-access.copilot-cli.json'), 'utf8'))).toEqual(live)
  })

  it('leaves no temp droppings', () => {
    writeTokenscopeConfig(buildCopilotConfig(FAKE_ENROLL_RESPONSE), dir)
    expect(readdirSync(dir).filter((f) => f.includes('.tmp.'))).toEqual([])
  })
})

describe('enrollIfNeeded — decision logic', () => {
  /*
   * THE RACE THE EXCLUSIVE CREATE CLOSES. The already-enrolled check runs BEFORE
   * the async POST, so a manual redeem can land during that request. An
   * unconditional write would then replace a deliberate re-provision with this
   * PROVISIONAL instance and token. EEXIST is the same outcome we wanted, so it
   * reports already-enrolled rather than an error.
   */
  it('does NOT overwrite a store that appeared during its own POST', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'ts-enrol-race-'))
    const existing = JSON.stringify({ version: 2, tool: 'copilot-cli', instance_id: 'from-redeem' })
    const res = await enrollIfNeeded({
      targetDir: dir,
      cwd: dir,
      home: dir,
      claimedEmail: 'dev@example.com',
      enrollmentSecret: 'secret',
      deviceBinding: { device_id: 'd' },
      apiBase: 'https://api.example.com',
      post: async () => {
        // a manual redeem lands WHILE the POST is in flight
        writeFileSync(join(dir, 'config.copilot-cli.json'), existing)
        return FAKE_ENROLL_RESPONSE
      },
    })
    expect(res.enrolled).toBe(false)
    expect(res.reason).toBe('already-enrolled')
    expect(readFileSync(join(dir, 'config.copilot-cli.json'), 'utf8')).toBe(existing)
  })

  // An own store in ANY shape is a no-op: auto-enrol can only create, never
  // repair, so re-POSTing would present the enrolment secret every launch.
  it.each([
    ['incomplete (no refresh token)', JSON.stringify({ ...ENROLLED_CONFIG, oauth_refresh_token: '' })],
    ['corrupt (not JSON)', '{ not json'],
    ['empty', ''],
  ])('own store present but %s: no POST, no write, distinct reason', async (_l, body) => {
    mkdirSync(dir, { recursive: true })
    writeFileSync(join(dir, 'config.copilot-cli.json'), body)
    const post = vi.fn()
    const writeConfig = vi.fn()
    const r = await enrollIfNeeded({ ...baseOpts(), post, writeConfig })
    expect(r).toEqual({ enrolled: false, reason: 'own-store-incomplete' })
    expect(post).not.toHaveBeenCalled()
    expect(writeConfig).not.toHaveBeenCalled()
    expect(readFileSync(join(dir, 'config.copilot-cli.json'), 'utf8')).toBe(body) // untouched
  })

  /*
   * Precedence, as a table: the own store decides whenever it exists; the
   * legacy file is consulted only when it does not.
   */
  it.each([
    ['own incomplete + legacy complete', JSON.stringify({ ...ENROLLED_CONFIG, oauth_refresh_token: '' }), JSON.stringify(ENROLLED_CONFIG), 'own-store-incomplete', 0],
    ['own complete + legacy corrupt', JSON.stringify(ENROLLED_CONFIG), '{ not json', 'already-enrolled', 0],
    ['own absent + legacy corrupt', null, '{ not json', null, 1],
    ['own absent + legacy complete', null, JSON.stringify(ENROLLED_CONFIG), 'already-enrolled', 0],
  ])('%s', async (_l, own, legacy, reason, posts) => {
    mkdirSync(dir, { recursive: true })
    if (own !== null) writeFileSync(join(dir, 'config.copilot-cli.json'), own)
    if (legacy !== null) writeFileSync(join(dir, 'config.json'), legacy)
    const post = vi.fn().mockResolvedValue(FAKE_ENROLL_RESPONSE)
    const r = await enrollIfNeeded({ ...baseOpts(), post })
    expect(post).toHaveBeenCalledTimes(posts)
    if (reason) expect(r).toEqual({ enrolled: false, reason })
    else expect(r.enrolled).toBe(true)
  })

  it('a complete LEGACY config.json still counts as enrolled (pre-split read)', async () => {
    mkdirSync(dir, { recursive: true })
    writeFileSync(join(dir, 'config.json'), JSON.stringify(ENROLLED_CONFIG))
    const post = vi.fn()
    const r = await enrollIfNeeded({ ...baseOpts(), post, writeConfig: vi.fn() })
    expect(r).toEqual({ enrolled: false, reason: 'already-enrolled' })
    expect(post).not.toHaveBeenCalled()
  })

  it('an INCOMPLETE legacy config.json does not block a fresh enrolment of this lane', async () => {
    mkdirSync(dir, { recursive: true })
    writeFileSync(join(dir, 'config.json'), JSON.stringify({ ...ENROLLED_CONFIG, oauth_refresh_token: '' }))
    const post = vi.fn().mockResolvedValue(FAKE_ENROLL_RESPONSE)
    const r = await enrollIfNeeded({ ...baseOpts(), post })
    expect(r.enrolled).toBe(true)
    expect(post).toHaveBeenCalledTimes(1)
  })

  it('no-op when already enrolled (no POST, no write)', async () => {
    // Seed an enrolled config.json in the target dir.
    mkdirSync(dir, { recursive: true })
    writeFileSync(join(dir, 'config.copilot-cli.json'), JSON.stringify(ENROLLED_CONFIG))
    const post = vi.fn()
    const writeConfig = vi.fn()
    const r = await enrollIfNeeded({ ...baseOpts(), post, writeConfig })
    expect(r).toEqual({ enrolled: false, reason: 'already-enrolled' })
    expect(post).not.toHaveBeenCalled()
    expect(writeConfig).not.toHaveBeenCalled()
  })

  it('no-op when no bundled secret is configured (un-injected dev build)', async () => {
    const post = vi.fn()
    const writeConfig = vi.fn()
    const r = await enrollIfNeeded({ ...baseOpts(), enrollmentSecret: '', post, writeConfig })
    expect(r).toEqual({ enrolled: false, reason: 'no-secret' })
    expect(post).not.toHaveBeenCalled()
    expect(writeConfig).not.toHaveBeenCalled()
  })

  it('no-op when no claimed email can be determined (never guess)', async () => {
    const post = vi.fn()
    const writeConfig = vi.fn()
    const r = await enrollIfNeeded({ ...baseOpts(), claimedEmail: null, post, writeConfig })
    expect(r).toEqual({ enrolled: false, reason: 'no-email' })
    expect(post).not.toHaveBeenCalled()
    expect(writeConfig).not.toHaveBeenCalled()
  })

  // S2 — closes the Copilot leg of client-plugins:mitm:0003: the enroll URL is
  // validated via assertSafeEndpoint BEFORE the POST is issued (replacing a naive
  // startsWith('http') guard that accepted http:// as readily as https://). An
  // off-box http:// api base must never reach the network — no request at all.
  it('no-op (no POST, no write) when the resolved api base is off-box plaintext http', async () => {
    const post = vi.fn()
    const writeConfig = vi.fn()
    const r = await enrollIfNeeded({ ...baseOpts(), apiBase: 'http://attacker.example.com', post, writeConfig })
    expect(r).toEqual({ enrolled: false, reason: 'no-base' })
    expect(post).not.toHaveBeenCalled()
    expect(writeConfig).not.toHaveBeenCalled()
  })

  it('still enrols against a loopback api base (local dev server)', async () => {
    const post = vi.fn().mockResolvedValue(FAKE_ENROLL_RESPONSE)
    const writeConfig = vi.fn()
    const r = await enrollIfNeeded({ ...baseOpts(), apiBase: 'http://localhost:3450', post, writeConfig })
    expect(r.enrolled).toBe(true)
    expect(post).toHaveBeenCalledTimes(1)
    expect(post.mock.calls[0][0]).toBe('http://localhost:3450/api/v1/setup/enroll')
  })

  it('success: POSTs the gated body and writes the forwarder config', async () => {
    const post = vi.fn().mockResolvedValue(FAKE_ENROLL_RESPONSE)
    const writeConfig = vi.fn()
    const r = await enrollIfNeeded({ ...baseOpts(), post, writeConfig })

    expect(r.enrolled).toBe(true)
    expect(r.instanceId).toBe('aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee')

    // POSTed to the enroll endpoint with the gated body.
    expect(post).toHaveBeenCalledTimes(1)
    const [url, body] = post.mock.calls[0]
    expect(url).toBe('https://ts.example.com/api/v1/setup/enroll')
    // Includes the tool=copilot-cli discriminator (P1-5) so the server returns the
    // copilot bundle directly — no client-side regex rewrite of a claude bundle.
    expect(body).toEqual({
      enrollment_secret: 'BUNDLED_SECRET',
      claimed_email: 'dev@example.com',
      device_binding: 'host:machine',
      tool: 'copilot-cli',
    })

    // Wrote the forwarder config with the durable OAuth emit credential, the logs
    // endpoint, and the instance-id-bearing resource attrs (tool=copilot-cli baked
    // in by the server bundle — consumed verbatim).
    expect(writeConfig).toHaveBeenCalledTimes(1)
    const [cfg, targetDir] = writeConfig.mock.calls[0]
    expect(targetDir).toBe(dir)
    expect(cfg.oauth_refresh_token).toBe('rt_provisional_secret')
    expect(cfg.bearer_endpoint).toBe(FAKE_ENROLL_RESPONSE.bearer_endpoint)
    expect(cfg.logs_endpoint).toBe('https://ts.example.com/v1/logs')
    expect(cfg.otel_resource_attributes).toBe('tokenscope.instance_id=aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee,tool=copilot-cli')
  })

  it('end-to-end: with the real writer, config.copilot-cli.json lands on disk and the cache is left to the helper', async () => {
    const post = vi.fn().mockResolvedValue(FAKE_ENROLL_RESPONSE)
    const r = await enrollIfNeeded({ ...baseOpts(), post }) // real writeTokenscopeConfig
    expect(r.enrolled).toBe(true)
    expect(existsSync(join(dir, 'config.copilot-cli.json'))).toBe(true)
    expect(existsSync(join(dir, 'oauth-access.copilot-cli.json'))).toBe(false)
    const written = JSON.parse(readFileSync(join(dir, 'config.copilot-cli.json'), 'utf8'))
    expect(written.oauth_refresh_token).toBe('rt_provisional_secret')
    expect(written).not.toHaveProperty('copilot_otel_file_path')
  })

  it('arms span emission on a successful enrol (emit-on-install parity)', async () => {
    // Without arming the shell-rc export, Copilot writes spans nowhere and the forwarder
    // tails an empty file — so emit-on-install must arm emission, passing the resolved home.
    const post = vi.fn().mockResolvedValue(FAKE_ENROLL_RESPONSE)
    const armRc = vi.fn()
    const writeConfig = vi.fn()
    const r = await enrollIfNeeded({ ...baseOpts(), post, writeConfig, armRc, home: '/tmp/fake-home' })
    expect(r.enrolled).toBe(true)
    expect(armRc).toHaveBeenCalledTimes(1)
    expect(armRc).toHaveBeenCalledWith('/tmp/fake-home')
  })

  it('never runs a managed-telemetry check: a fresh install is on the usage-extension lane', async () => {
    const post = vi.fn().mockResolvedValue(FAKE_ENROLL_RESPONSE)
    const r = await enrollIfNeeded({ ...baseOpts(), post, writeConfig: vi.fn() })
    expect(r).toEqual({ enrolled: true, instanceId: expect.any(String), extensions: expect.any(String) })
  })

  it("reports usage-capture arming: 'manual' is surfaced, a throwing arm is 'failed' and logged, never an enrol failure", async () => {
    const post = vi.fn().mockResolvedValue(FAKE_ENROLL_RESPONSE)
    const manual = await enrollIfNeeded({ ...baseOpts(), post, writeConfig: vi.fn(), armRc: () => ({ rcCleaned: [], extensions: 'manual' }), env: {} })
    expect(manual).toMatchObject({ enrolled: true, extensions: 'manual' })
    const errSpy = vi.spyOn(console, 'error').mockImplementation(() => {})
    try {
      const thrown = await enrollIfNeeded({
        ...baseOpts(),
        post,
        writeConfig: vi.fn(),
        armRc: () => {
          throw Object.assign(new Error('x'), { code: 'EACCES' })
        },
        env: {},
      })
      expect(thrown).toMatchObject({ enrolled: true, extensions: 'failed' })
      expect(String(errSpy.mock.calls.flat())).toMatch(/EACCES/)
    } finally {
      errSpy.mockRestore()
    }
  })

  it('the default arming logs to stderr, so the hand-enable guidance is not silent', async () => {
    const home = mkdtempSync(join(tmpdir(), 'ts-enroll-arm-'))
    try {
      mkdirSync(join(home, '.copilot'))
      writeFileSync(join(home, '.copilot', 'settings.json'), '// jsonc\n{}')
      const errSpy = vi.spyOn(console, 'error').mockImplementation(() => {})
      try {
        const opts = { ...(baseOpts() as Record<string, unknown>) }
        delete opts.armRc // the DEFAULT arming is under test
        const r = await enrollIfNeeded({ ...opts, post: vi.fn().mockResolvedValue(FAKE_ENROLL_RESPONSE), writeConfig: vi.fn(), home, env: {} })
        expect(r).toMatchObject({ enrolled: true, extensions: 'manual' })
        expect(String(errSpy.mock.calls.flat())).toMatch(/"EXTENSIONS": true/)
      } finally {
        errSpy.mockRestore()
      }
    } finally {
      rmSync(home, { recursive: true, force: true })
    }
  })

  it('stays silent and writes NOTHING when the POST fails', async () => {
    const post = vi.fn().mockRejectedValue(new Error('network'))
    const writeConfig = vi.fn()
    const r = await enrollIfNeeded({ ...baseOpts(), post, writeConfig })
    expect(r).toEqual({ enrolled: false, reason: 'post-failed' })
    expect(writeConfig).not.toHaveBeenCalled()
  })

  it('writes NOTHING when the response is missing the instance id (unattributable)', async () => {
    const bad = {
      ...FAKE_ENROLL_RESPONSE,
      instance_id: '',
      telemetry: { copilot: { ...FAKE_ENROLL_RESPONSE.telemetry.copilot, instance_id: '', OTEL_RESOURCE_ATTRIBUTES: 'tool=copilot-cli' } },
    }
    const post = vi.fn().mockResolvedValue(bad)
    const writeConfig = vi.fn()
    const r = await enrollIfNeeded({ ...baseOpts(), post, writeConfig })
    expect(r).toEqual({ enrolled: false, reason: 'write-failed' })
    expect(writeConfig).not.toHaveBeenCalled()
  })
})
