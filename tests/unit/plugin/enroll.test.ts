/*
 * enroll — emit-on-install enrolment unit tests (slice 6, the plugin client half
 * of docs/design/emit-on-install-provisional-attribution.md §Flows 1).
 *
 * enrollIfNeeded() must be a strict NO-OP unless it's a fresh install of the real
 * (publish-injected) plugin, and on success must write the enroll response through
 * the SAME path redeem uses. These tests pin the decision logic + the wire body:
 *
 *   1. already-enrolled  → no-op (never re-enrol / never clobber a credential)
 *   2. no bundled secret → no-op (un-injected dev build enrols no one)
 *   3. no claimed email  → no-op (never guess a bad identity)
 *   4. success           → POSTs {secret, claimed_email, device_binding} and
 *                          writes the OTel/emit env via writeClaudeSettings
 *   5. failures (network / bad bundle) stay silent and write NOTHING
 *
 * plus the email-source selection, device-binding shape, and the placeholder
 * bundled-secret resolution.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs'
import { tmpdir, hostname } from 'node:os'
import { join } from 'node:path'
import { DEFAULT_API_BASE } from '../../../plugin/scripts/api-base.mjs'
import { execFileSync } from 'node:child_process'

import {
  enrollIfNeeded,
  isEnrolled,
  readClaimedEmail,
  computeDeviceBinding,
} from '../../../plugin/scripts/enroll.mjs'
import { resolveEnrollmentSecret } from '../../../plugin/scripts/enrollment-secret.mjs'

// A complete, valid enroll response — shape mirrors /setup/redeem (so the redeem
// writer is reused verbatim): top-level oauth_* + a telemetry.claude bundle whose
// OTEL_RESOURCE_ATTRIBUTES carries a non-empty instance id.
const FAKE_ENROLL_RESPONSE = {
  instance_id: 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee',
  tool: 'claude-code',
  bearer_endpoint: 'https://ts.example.com/api/v1/instances/aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee/bearer',
  oauth_refresh_token: 'rt_provisional_secret',
  oauth_token_endpoint: 'https://ts.example.com/api/v1/oauth/token',
  oauth_client_id: 'client-prov',
  telemetry: {
    claude: {
      OTEL_LOGS_EXPORTER: 'otlp',
      OTEL_METRICS_EXPORTER: 'none',
      OTEL_EXPORTER_OTLP_LOGS_ENDPOINT: 'https://ts.example.com/v1/logs',
      OTEL_EXPORTER_OTLP_LOGS_PROTOCOL: 'http/protobuf',
      otel_headers_helper_url: 'https://ts.example.com/api/v1/instances/aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee/bearer',
      OTEL_RESOURCE_ATTRIBUTES: 'tokenscope.instance_id=aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee,tool=claude-code',
    },
  },
}

const ENROLLED_ENV = {
  TOKENSCOPE_OAUTH_REFRESH_TOKEN: 'rt_existing',
  TOKENSCOPE_BEARER_ENDPOINT: 'https://ts.example.com/bearer',
  OTEL_RESOURCE_ATTRIBUTES: 'tokenscope.instance_id=existing,tool=claude-code',
}

let dir: string
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'ts-enroll-'))
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
  settingsPath: join(dir, 'settings.json'),
  helperPath: '/plugin/scripts/otel-headers-helper.sh',
})

describe('isEnrolled', () => {
  it('true only when refresh token + bearer endpoint + non-empty instance id all present', () => {
    expect(isEnrolled(ENROLLED_ENV)).toBe(true)
  })
  it('false when any of the three is missing', () => {
    expect(isEnrolled({})).toBe(false)
    expect(isEnrolled({ ...ENROLLED_ENV, TOKENSCOPE_OAUTH_REFRESH_TOKEN: '' })).toBe(false)
    expect(isEnrolled({ ...ENROLLED_ENV, TOKENSCOPE_BEARER_ENDPOINT: '  ' })).toBe(false)
  })
  it('false when the instance id value is empty (tokenscope.instance_id=,...)', () => {
    expect(isEnrolled({ ...ENROLLED_ENV, OTEL_RESOURCE_ATTRIBUTES: 'tokenscope.instance_id=,tool=claude-code' })).toBe(
      false,
    )
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

describe('readClaimedEmail — source selection', () => {
  it('prefers ~/.claude.json oauthAccount.emailAddress (the email Claude knows)', () => {
    const home = mkdtempSync(join(tmpdir(), 'ts-home-'))
    writeFileSync(join(home, '.claude.json'), JSON.stringify({ oauthAccount: { emailAddress: 'claude@example.com' } }))
    expect(readClaimedEmail({ home, cwd: dir })).toBe('claude@example.com')
    rmSync(home, { recursive: true, force: true })
  })

  it('falls back to git config user.email when no Claude oauth email', () => {
    const home = mkdtempSync(join(tmpdir(), 'ts-home-')) // no .claude.json here
    const repo = mkdtempSync(join(tmpdir(), 'ts-repo-'))
    execFileSync('git', ['init', '-q'], { cwd: repo })
    execFileSync('git', ['config', 'user.email', 'git@example.com'], { cwd: repo })
    expect(readClaimedEmail({ home, cwd: repo })).toBe('git@example.com')
    rmSync(home, { recursive: true, force: true })
    rmSync(repo, { recursive: true, force: true })
  })

  it('returns null when neither source yields an @ address (never guesses)', () => {
    const home = mkdtempSync(join(tmpdir(), 'ts-home-'))
    const repo = mkdtempSync(join(tmpdir(), 'ts-norepo-')) // not a git repo, no .claude.json
    // Neutralise the runner's global/system git identity so `git config
    // user.email` genuinely finds nothing (it reads global config even outside a
    // repo — the real, intended fallback behaviour).
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

describe('enrollIfNeeded — decision logic', () => {
  it('no-op when already enrolled (no POST, no write)', async () => {
    const post = vi.fn()
    const writeSettings = vi.fn()
    const r = await enrollIfNeeded({ ...baseOpts(), env: ENROLLED_ENV, post, writeSettings })
    expect(r).toEqual({ enrolled: false, reason: 'already-enrolled' })
    expect(post).not.toHaveBeenCalled()
    expect(writeSettings).not.toHaveBeenCalled()
  })

  it('no-op when no bundled secret is configured (un-injected dev build)', async () => {
    const post = vi.fn()
    const writeSettings = vi.fn()
    const r = await enrollIfNeeded({ ...baseOpts(), env: {}, enrollmentSecret: '', post, writeSettings })
    expect(r).toEqual({ enrolled: false, reason: 'no-secret' })
    expect(post).not.toHaveBeenCalled()
    expect(writeSettings).not.toHaveBeenCalled()
  })

  it('no-op when no claimed email can be determined (never guess)', async () => {
    const post = vi.fn()
    const writeSettings = vi.fn()
    const r = await enrollIfNeeded({ ...baseOpts(), env: {}, claimedEmail: null, post, writeSettings })
    expect(r).toEqual({ enrolled: false, reason: 'no-email' })
    expect(post).not.toHaveBeenCalled()
    expect(writeSettings).not.toHaveBeenCalled()
  })

  it('success: POSTs the gated body and writes the emit env via the redeem writer', async () => {
    const post = vi.fn().mockResolvedValue(FAKE_ENROLL_RESPONSE)
    const writeSettings = vi.fn()
    const r = await enrollIfNeeded({ ...baseOpts(), env: {}, post, writeSettings })

    expect(r.enrolled).toBe(true)
    expect(r.instanceId).toBe('aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee')

    // POSTed to the enroll endpoint with the gated body.
    expect(post).toHaveBeenCalledTimes(1)
    const [url, body] = post.mock.calls[0]
    expect(url).toBe('https://ts.example.com/api/v1/setup/enroll')
    expect(body).toEqual({
      enrollment_secret: 'BUNDLED_SECRET',
      claimed_email: 'dev@example.com',
      device_binding: 'host:machine',
    })

    // Wrote via the redeem writer: (settingsPath, helperPath, envBlock) with the
    // durable OAuth emit credential + the instance-id-bearing resource attrs.
    expect(writeSettings).toHaveBeenCalledTimes(1)
    const [settingsPath, helperPath, envBlock] = writeSettings.mock.calls[0]
    expect(settingsPath).toBe(join(dir, 'settings.json'))
    expect(helperPath).toBe('/plugin/scripts/otel-headers-helper.sh')
    expect(envBlock.TOKENSCOPE_OAUTH_REFRESH_TOKEN).toBe('rt_provisional_secret')
    expect(envBlock.TOKENSCOPE_BEARER_ENDPOINT).toBe(FAKE_ENROLL_RESPONSE.telemetry.claude.otel_headers_helper_url)
    expect(envBlock.OTEL_RESOURCE_ATTRIBUTES).toContain('tokenscope.instance_id=aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee')
  })

  it('stays silent and writes NOTHING when the POST fails', async () => {
    const post = vi.fn().mockRejectedValue(new Error('network'))
    const writeSettings = vi.fn()
    const r = await enrollIfNeeded({ ...baseOpts(), env: {}, post, writeSettings })
    expect(r).toEqual({ enrolled: false, reason: 'post-failed' })
    expect(writeSettings).not.toHaveBeenCalled()
  })

  it('writes NOTHING when the response is missing the instance id (unattributable)', async () => {
    const bad = {
      ...FAKE_ENROLL_RESPONSE,
      telemetry: { claude: { ...FAKE_ENROLL_RESPONSE.telemetry.claude, OTEL_RESOURCE_ATTRIBUTES: 'tool=claude-code' } },
    }
    const post = vi.fn().mockResolvedValue(bad)
    const writeSettings = vi.fn()
    const r = await enrollIfNeeded({ ...baseOpts(), env: {}, post, writeSettings })
    expect(r).toEqual({ enrolled: false, reason: 'write-failed' })
    expect(writeSettings).not.toHaveBeenCalled()
  })

  // S1 fix 2/3: resolveApiBase now VALIDATES the resolved base and THROWS on
  // an unsafe one (e.g. a repo-poisoned TOKENSCOPE_API_BASE downgrading to
  // plaintext http). enrollIfNeeded's contract is fail-OPEN / never-throws —
  // prove the throw is caught and surfaces as reason:'no-base', not an
  // unhandled rejection, and that nothing is POSTed to the unsafe base.
  it('an unsafe apiBase (plaintext http, off-box) never throws — surfaces as reason:no-base, no POST', async () => {
    const post = vi.fn()
    const writeSettings = vi.fn()
    const r = await enrollIfNeeded({ ...baseOpts(), apiBase: 'http://evil.example.com', env: {}, post, writeSettings })
    expect(r).toEqual({ enrolled: false, reason: 'no-base' })
    expect(post).not.toHaveBeenCalled()
    expect(writeSettings).not.toHaveBeenCalled()
  })

  /*
   * The hostile-repository boundary, on the door that carries the most.
   *
   * Claude Code merges a repository's .claude/settings.json env OVER the global
   * one, so TOKENSCOPE_API_BASE is a value a cloned repo controls, and the
   * SessionStart hook calls enrollIfNeeded with no apiBase. This is the call
   * that ships the bundled ENROLLMENT SECRET and then persists whatever
   * endpoints come back, so a repo winning here gets the org-wide secret on the
   * way out and every future token and span on the way back — strictly worse
   * than the redeem door, whose handoff code is single-use and device-bound.
   *
   * `discoverOrigin` is stubbed so the assertion is about precedence and not
   * about whether the machine running the test has an MCP registration.
   */
  describe('repo-supplied env is not a destination', () => {
    let prior: string | undefined
    beforeEach(() => {
      prior = process.env.TOKENSCOPE_API_BASE
      process.env.TOKENSCOPE_API_BASE = 'https://attacker.example.com'
    })
    afterEach(() => {
      if (prior === undefined) delete process.env.TOKENSCOPE_API_BASE
      else process.env.TOKENSCOPE_API_BASE = prior
    })

    it('never POSTs the enrollment secret to a host named by TOKENSCOPE_API_BASE', async () => {
      const post = vi.fn().mockResolvedValue(FAKE_ENROLL_RESPONSE)
      const writeSettings = vi.fn()
      await enrollIfNeeded({
        ...baseOpts(),
        apiBase: null, // the SessionStart hook passes none
        discoverOrigin: () => null, // stock install: nothing registered locally
        env: {},
        post,
        writeSettings,
      })
      expect(post).toHaveBeenCalledTimes(1)
      const [url, body] = post.mock.calls[0]
      expect(url).toBe(`${DEFAULT_API_BASE}/api/v1/setup/enroll`)
      expect(url).not.toContain('attacker')
      // Name what would have leaked, so a future reader sees the stake.
      expect(body.enrollment_secret).toBe('BUNDLED_SECRET')
    })

    it('prefers the operator’s own registered MCP origin over the env var', async () => {
      const post = vi.fn().mockResolvedValue(FAKE_ENROLL_RESPONSE)
      const writeSettings = vi.fn()
      await enrollIfNeeded({
        ...baseOpts(),
        apiBase: null,
        discoverOrigin: () => 'https://ts-own.example.com',
        env: {},
        post,
        writeSettings,
      })
      const [url] = post.mock.calls[0]
      expect(url).toBe('https://ts-own.example.com/api/v1/setup/enroll')
    })
  })
})
