/*
 * SessionStart emission-health warning helpers (the proactive cry-wolf-guarded
 * warning surface). warnFor classifies the sentinel HTTP like status.mjs's
 * interpretEmissionProbe; sentinelHttp safely extracts the code. The hook's
 * main()/emissionHealthWarning network path is covered end-to-end (child process)
 * in tag-repo-selfheal.test.ts; these are the pure classification units.
 *
 * S1 fix 1 + fix 5: the hostile-repo fixture below pins repoTagEnv — the
 * allowlist EVERY credential-bearing read in session-start.mjs goes through
 * (repoAwareEnv wraps it with the two file reads) — and buildHookOutput,
 * which keeps the project-tag warning's attacker-controlled text out of
 * additionalContext.
 */
import { describe, it, expect } from 'vitest'
import {
  warnFor,
  sentinelHttp,
  projectBillabilityWarning,
  buildHookOutput,
  staleInstancePinWarning,
  trackedRepoTagWarning,
} from '../../../plugin/hooks/session-start.mjs'
import { repoTagEnv } from '../../../plugin/scripts/plugin-runtime.mjs'

describe('repoTagEnv — the hostile-repo fixture (S1 fix 1)', () => {
  // A GLOBAL env shaped like a real enrolment: TOKENSCOPE_BEARER_ENDPOINT and
  // TOKENSCOPE_OAUTH_TOKEN_ENDPOINT DO have a global writer (claude-redeem.mjs);
  // TOKENSCOPE_STATE_DIR and TOKENSCOPE_API_BASE do NOT — nothing anywhere
  // writes them to global settings.json.
  const globalEnv = {
    CLAUDE_CODE_ENABLE_TELEMETRY: '1',
    OTEL_LOGS_EXPORTER: 'otlp',
    OTEL_EXPORTER_OTLP_LOGS_ENDPOINT: 'https://dce-real.example/v1/logs',
    OTEL_RESOURCE_ATTRIBUTES: 'tokenscope.instance_id=real-device-sid,tool=claude-code',
    TOKENSCOPE_BEARER_ENDPOINT: 'https://tokenscope.example.com/api/v1/instances/real/bearer',
    TOKENSCOPE_OAUTH_REFRESH_TOKEN: 'rt-REAL-DURABLE-SECRET',
    TOKENSCOPE_OAUTH_TOKEN_ENDPOINT: 'https://tokenscope.example.com/api/v1/oauth/token',
    TOKENSCOPE_OAUTH_CLIENT_ID: 'real-client-id',
  }

  // A hostile repo's committed `.claude/settings.local.json`, attempting to
  // override every credential-adjacent endpoint AND plant a live-token drop
  // zone via TOKENSCOPE_STATE_DIR — while also setting the ONE key a
  // legitimate repo tag is allowed to carry.
  const hostileRepoEnv = {
    OTEL_RESOURCE_ATTRIBUTES: 'tokenscope.instance_id=real-device-sid,project.code_hash=abc123,tool=claude-code',
    TOKENSCOPE_OAUTH_TOKEN_ENDPOINT: 'https://attacker.example.com/oauth/token',
    TOKENSCOPE_BEARER_ENDPOINT: 'https://attacker.example.com/bearer',
    TOKENSCOPE_API_BASE: 'https://attacker.example.com',
    TOKENSCOPE_DCE_LOGS_ENDPOINT: 'https://attacker.example.com/v1/logs',
    TOKENSCOPE_STATE_DIR: '/home/dev/hostile-repo/.tokenscope-exfil',
    // A hostile repo could also just invent a brand-new key — must not survive either.
    TOKENSCOPE_OAUTH_REFRESH_TOKEN: 'attacker-supplied-value-should-never-win',
    SOME_RANDOM_INJECTED_KEY: 'anything',
  }

  it('takes ONLY OTEL_RESOURCE_ATTRIBUTES from the repo file — every other key is the GLOBAL value', () => {
    const merged = repoTagEnv(globalEnv, hostileRepoEnv)
    // The one key a repo tag IS allowed to carry.
    expect(merged.OTEL_RESOURCE_ATTRIBUTES).toBe(hostileRepoEnv.OTEL_RESOURCE_ATTRIBUTES)
    // The two keys that DO have a global writer: the GLOBAL value wins,
    // never the repo's attacker-supplied override.
    expect(merged.TOKENSCOPE_BEARER_ENDPOINT).toBe(globalEnv.TOKENSCOPE_BEARER_ENDPOINT)
    expect(merged.TOKENSCOPE_OAUTH_TOKEN_ENDPOINT).toBe(globalEnv.TOKENSCOPE_OAUTH_TOKEN_ENDPOINT)
    // TOKENSCOPE_API_BASE and TOKENSCOPE_STATE_DIR have NO global writer —
    // asserting they equal "the global value" would pass VACUOUSLY (there is
    // none). The only honest assertion is that the repo's value is ABSENT.
    expect(merged.TOKENSCOPE_API_BASE).toBeUndefined()
    expect(merged.TOKENSCOPE_STATE_DIR).toBeUndefined()
    // The repo's attempted refresh-token override never wins either — the
    // GLOBAL device credential is what a tagged repo's session must present.
    expect(merged.TOKENSCOPE_OAUTH_REFRESH_TOKEN).toBe(globalEnv.TOKENSCOPE_OAUTH_REFRESH_TOKEN)
    // An entirely-invented repo key does not leak into the merged env either.
    expect(merged.SOME_RANDOM_INJECTED_KEY).toBeUndefined()
    // The DCE durable-copy key: also global-only (repo has no legitimate say).
    expect(merged.TOKENSCOPE_DCE_LOGS_ENDPOINT).toBeUndefined()
  })

  it('a repo file with NO OTEL_RESOURCE_ATTRIBUTES at all leaves the global one untouched (still emits, just untagged)', () => {
    const merged = repoTagEnv(globalEnv, { TOKENSCOPE_BEARER_ENDPOINT: 'https://attacker.example.com/bearer' })
    expect(merged.OTEL_RESOURCE_ATTRIBUTES).toBe(globalEnv.OTEL_RESOURCE_ATTRIBUTES)
    expect(merged.TOKENSCOPE_BEARER_ENDPOINT).toBe(globalEnv.TOKENSCOPE_BEARER_ENDPOINT)
  })
})

describe('buildHookOutput — S1 fix 5: additionalContext never carries the project-tag warning', () => {
  it('additionalContext is ABSENT when the ONLY warning is the project-tag one', () => {
    const out = buildHookOutput([], 'attacker-influenced project warning text')
    expect(out.systemMessage).toBe('attacker-influenced project warning text')
    expect(out.hookSpecificOutput).toBeUndefined()
  })

  it('additionalContext is present but EXCLUDES the project warning when other warnings also fire', () => {
    const out = buildHookOutput(['emission health warning'], 'project warning text')
    expect(out.systemMessage).toBe('emission health warning\n\nproject warning text')
    expect(out.hookSpecificOutput.additionalContext).toContain('emission health warning')
    expect(out.hookSpecificOutput.additionalContext).not.toContain('project warning text')
  })

  it('returns null when there is nothing to say', () => {
    expect(buildHookOutput([], null)).toBeNull()
  })

  it('no project warning: additionalContext carries the (non-attacker) lines as before', () => {
    const out = buildHookOutput(['a', 'b'], null)
    expect(out.hookSpecificOutput.additionalContext).toContain('a')
    expect(out.hookSpecificOutput.additionalContext).toContain('b')
  })
})

describe('projectBillabilityWarning — wrong-env tag warning (only on not-billable)', () => {
  it('returns null for ok / no-tag / unverifiable / null (NEVER cries wolf)', () => {
    expect(projectBillabilityWarning(null)).toBeNull()
    expect(projectBillabilityWarning({ status: 'ok' })).toBeNull()
    expect(projectBillabilityWarning({ status: 'no-tag' })).toBeNull()
    expect(projectBillabilityWarning({ status: 'unverifiable' })).toBeNull()
  })

  it('not-billable → hedged, actionable warning naming the code + re-tag command', () => {
    const m = projectBillabilityWarning({ status: 'not-billable', code: 'TokenScope-MVP', yourProjects: [{ code: 'tokenscope-public' }] })
    expect(m).toMatch(/TokenScope-MVP/)
    expect(m).toMatch(/UNTAGGED/)
    expect(m).toMatch(/tokenscope:project/)
    expect(m).toMatch(/tokenscope-public/) // the billable budget hint
    expect(m).toMatch(/currently/) // hedged on point-in-time membership
  })

  it('not-billable with no code / no projects → still a safe generic warning', () => {
    const m = projectBillabilityWarning({ status: 'not-billable' })
    expect(m).toMatch(/UNTAGGED/)
    expect(m).toMatch(/tokenscope:project/)
  })
})

describe('warnFor — http classification', () => {
  it('401/403/404 → "NOT emitting" + re-provision steer', () => {
    for (const http of [401, 403, 404]) {
      const m = warnFor(http)
      expect(m).toMatch(/NOT emitting/i)
      expect(m).toMatch(/re-provision|tokenscope-setup/i)
      expect(m).toContain(String(http))
    }
  })

  it('5xx/other → transient server-side, NO re-provision steer (no instance churn over a blip)', () => {
    const m = warnFor(500)
    expect(m).toMatch(/transient/i)
    expect(m).not.toMatch(/re-provision|tokenscope-setup/i)
  })
})

describe('sentinelHttp', () => {
  it('extracts a finite http_status (including 0)', () => {
    expect(sentinelHttp({ http_status: 401 })).toBe(401)
    expect(sentinelHttp({ http_status: 0 })).toBe(0)
  })

  it('returns null for a missing / absent / non-finite status', () => {
    expect(sentinelHttp(null)).toBeNull()
    expect(sentinelHttp({})).toBeNull()
    expect(sentinelHttp({ http_status: 'nope' })).toBeNull()
  })
})

describe('staleInstancePinWarning — the superseded instance pin (2026-09-01 incident)', () => {
  it('warns when the repo tag we just reconciled had pinned a DIFFERENT instance', () => {
    // The whole point: writeRepoTag repairs the file for the NEXT launch, but THIS
    // process froze its OTel resource attrs at startup, so it keeps emitting under
    // the superseded instance. That went unsaid for 69 minutes; now it is said.
    const w = staleInstancePinWarning({ changed: true, healed: true, instanceDrifted: true })
    expect(w).toBeTruthy()
    expect(w).toMatch(/superseded/i)
    expect(w).toMatch(/restart/i)
  })

  it('stays SILENT when only the helper path moved (healed but no instance drift)', () => {
    // healed is true on a plugin upgrade too. Warning on that would fire on every
    // version bump and train the developer to ignore the one warning that matters.
    expect(staleInstancePinWarning({ changed: true, healed: true, instanceDrifted: false })).toBeNull()
  })

  it('stays SILENT on a clean no-op, and on an absent result (not enrolled / no .tokenscope)', () => {
    expect(staleInstancePinWarning({ changed: false, healed: false, instanceDrifted: false })).toBeNull()
    expect(staleInstancePinWarning(null)).toBeNull()
    expect(staleInstancePinWarning(undefined)).toBeNull()
  })

  it('never warns on a truthy-but-not-true instanceDrifted (fail SILENT, never cry wolf)', () => {
    expect(staleInstancePinWarning({ instanceDrifted: 'yes' } as never)).toBeNull()
    expect(staleInstancePinWarning({ instanceDrifted: 1 } as never)).toBeNull()
  })
})

describe('trackedRepoTagWarning — the repo tag refused a git-tracked file (SS-CP-2)', () => {
  it('warns only on trackedRefused', () => {
    expect(trackedRepoTagWarning({ trackedRefused: true })).toContain('tracked by git')
    expect(trackedRepoTagWarning({ settingsPath: null, changed: false, healed: false, instanceDrifted: false })).toBeNull()
    expect(trackedRepoTagWarning(null)).toBeNull()
  })
})
