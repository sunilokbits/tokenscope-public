// @vitest-environment node
/*
 * redeem-argv-guard — the argv of a redeem helper is composed by a MODEL (S16a).
 *
 * WHAT IS BEING DEFENDED. Both setup lanes hand a live single-use handoff code
 * to a local process, and neither lane can constrain the argv from outside:
 * Claude's `allowed-tools` entry is a PREFIX grant (`…claude-redeem.mjs":*`) so
 * every argv tail is pre-approved with no prompt, and Copilot CLI has no
 * allowed-tools mechanism at all. A prompt-injected model — a hostile repo's
 * auto-loaded CLAUDE.md, a file read earlier in the session — can therefore
 * append flags to the documented invocation. The control has to be inside the
 * scripts, which is what these tests pin:
 *
 *   1. `--redeem-url` (which named the POST target outright, bypassing every
 *      api-base control) is GONE, and cannot come back as "silently ignored" —
 *      an unknown flag refuses the whole argv.
 *   2. `--api-base` may SELECT among origins the device already knows (loopback,
 *      the packaged default, the discovered MCP registration) and can never
 *      INTRODUCE one.
 *   3. `--settings-path` — where the durable OAuth emit credential is written —
 *      is confined to the account's own home.
 *   4. `--shell-rc` — a file every future shell then executes — is confined to
 *      an rc file in the user's home.
 *
 * The behavioural half runs the REAL helper against a mock server on loopback,
 * because the two questions that matter ("did it POST at all", "where did it
 * POST") are only answerable from outside the process.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import { mkdtempSync, mkdirSync, rmSync, existsSync, symlinkSync, writeFileSync, realpathSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { createServer } from 'node:http'
import { spawn } from 'node:child_process'

/* eslint-disable @typescript-eslint/ban-ts-comment */
// @ts-ignore — mjs import resolved by Vitest
const { assertAllowedApiBase, acceptApiBaseArg, assertConfinedPath, flagValue, assertKnownFlag } =
  await import('../../../plugin/scripts/argv-guard.mjs')
// @ts-ignore — mjs import resolved by Vitest
const { realHome } = await import('../../../plugin/scripts/real-home.mjs')
// @ts-ignore — mjs import resolved by Vitest
const { DEFAULT_API_BASE } = await import('../../../plugin/scripts/api-base.mjs')
// Near-miss cases are built from the baked host so they stay meaningful in a fork
// that points the plugin at its own deployment.
const BAKED_HOST = new URL(DEFAULT_API_BASE).host
// @ts-ignore — mjs import resolved by Vitest
const { parseArgs: parseClaudeArgs } = await import('../../../plugin/scripts/claude-redeem.mjs')
// @ts-ignore — mjs import resolved by Vitest
const { parseArgs: parseCopilotArgs } = await import('../../../plugin/scripts/copilot-redeem.mjs')
/* eslint-enable @typescript-eslint/ban-ts-comment */

const DISCOVERED = 'https://ts-registered.example.com'
const EVIL = 'https://evil.example.com'

// A temp directory INSIDE the account's real home. The confinement being tested
// is "inside your home", so a tmpdir()-based fixture could only ever exercise
// the refusal — the accept case needs a real path under the anchor.
let homeTmp: string
beforeAll(() => {
  homeTmp = mkdtempSync(join(realHome(), '.ts-argv-guard-'))
})
afterAll(() => {
  // Only ever remove a path we minted, under the anchor we minted it in.
  if (homeTmp && homeTmp.startsWith(join(realHome(), '.ts-argv-guard-'))) {
    rmSync(homeTmp, { recursive: true, force: true })
  }
})

describe('assertAllowedApiBase — argv may select a known origin, never introduce one', () => {
  const allowed = [DEFAULT_API_BASE, DISCOVERED]

  it('accepts the packaged default and the discovered MCP origin', () => {
    expect(assertAllowedApiBase(DEFAULT_API_BASE, { allowed })).toBe(DEFAULT_API_BASE)
    expect(assertAllowedApiBase(DISCOVERED, { allowed })).toBe(DISCOVERED)
  })

  it('accepts loopback on any port and either http scheme form', () => {
    expect(assertAllowedApiBase('http://localhost:3450', { allowed: [] })).toBe(
      'http://localhost:3450',
    )
    expect(assertAllowedApiBase('http://127.0.0.1:9999', { allowed: [] })).toBe(
      'http://127.0.0.1:9999',
    )
    expect(assertAllowedApiBase('http://[::1]:3450', { allowed: [] })).toBe('http://[::1]:3450')
  })

  it('REFUSES an arbitrary external https host', () => {
    expect(() => assertAllowedApiBase(EVIL, { allowed })).toThrow(/not an origin this device/)
    try {
      assertAllowedApiBase(EVIL, { allowed })
      throw new Error('expected a throw')
    } catch (err) {
      expect((err as { reason?: string }).reason).toBe('origin-not-allowed')
      // The rejected value is argv, i.e. attacker-composable text on its way to
      // stderr. Same redaction rule as endpoint-guard's untrusted call sites.
      expect((err as Error).message).not.toContain('evil.example.com')
    }
  })

  it('is not fooled by the near-miss argv shapes', () => {
    const rejected = [
      // userinfo: the ALLOWED host in the credentials slot, the attacker's in the
      // authority. URL#origin reads the authority, and userinfo is refused outright.
      `${DEFAULT_API_BASE}@evil.example.com`,
      `${DEFAULT_API_BASE}@evil.example.com/api`,
      // a homoglyph host punycodes to a different origin
      'https://tokenscope-dev.insight.cоm',
      // a different port is a different endpoint
      `https://${BAKED_HOST}:8443`,
      // a subdomain/suffix of an allowed host is not that host
      `https://${BAKED_HOST}.evil.example.com`,
      `https://evil.${BAKED_HOST}`,
      // plaintext off-box, and a non-http(s) scheme on loopback
      `http://${BAKED_HOST}`,
      'ftp://127.0.0.1:3450',
      // not a URL at all / would read as a flag
      '--settings-path',
      BAKED_HOST,
      '',
    ]
    for (const value of rejected) {
      expect(() => assertAllowedApiBase(value, { allowed }), value).toThrow()
    }
  })

  it('canonicalises an accepted value rather than passing argv through verbatim', () => {
    // Trailing slash, default port, host casing and any path/query are all
    // normalised away — the POST target is built from the ORIGIN, so nothing a
    // caller appended to the flag survives into the URL.
    expect(assertAllowedApiBase(`${DEFAULT_API_BASE}/`, { allowed })).toBe(DEFAULT_API_BASE)
    expect(assertAllowedApiBase(`${DEFAULT_API_BASE}:443`, { allowed })).toBe(DEFAULT_API_BASE)
    expect(assertAllowedApiBase(`${DEFAULT_API_BASE}/evil/path?q=1#f`, { allowed })).toBe(
      DEFAULT_API_BASE,
    )
  })

  it('an EMPTY allowed list admits nothing but loopback', () => {
    expect(() => assertAllowedApiBase(DEFAULT_API_BASE, { allowed: [] })).toThrow()
    expect(() => assertAllowedApiBase(DEFAULT_API_BASE, { allowed: [null, undefined, ''] })).toThrow()
  })
})

describe('acceptApiBaseArg — a rejected flag warns and is dropped, never fatal', () => {
  it('returns the canonical origin for an accepted value, and warns about nothing', () => {
    const warnings: string[] = []
    expect(
      acceptApiBaseArg(`${DISCOVERED}/`, { allowed: [DISCOVERED], warn: (m: string) => warnings.push(m) }),
    ).toBe(DISCOVERED)
    expect(warnings).toEqual([])
  })

  it('drops a disallowed value with a warning, so resolution continues from local config', () => {
    const warnings: string[] = []
    expect(acceptApiBaseArg(EVIL, { allowed: [DISCOVERED], warn: (m: string) => warnings.push(m) })).toBeNull()
    expect(warnings).toHaveLength(1)
    expect(warnings[0]).toContain('ignoring --api-base')
    expect(warnings[0]).not.toContain('evil.example.com')
  })

  it('treats absent/blank as absent (not as an authoritative empty answer)', () => {
    const warn = () => {
      throw new Error('must not warn about an absent flag')
    }
    expect(acceptApiBaseArg(null, { allowed: [DISCOVERED], warn })).toBeNull()
    expect(acceptApiBaseArg('   ', { allowed: [DISCOVERED], warn })).toBeNull()
  })
})

describe('assertConfinedPath — a path flag cannot leave the home it is anchored to', () => {
  it('accepts a path inside the account home', () => {
    const p = join(homeTmp, 'settings.json')
    expect(assertConfinedPath(p, { flag: '--settings-path', allowedBasenames: ['settings.json'] })).toBe(p)
  })

  it('refuses a path outside it, including via traversal', () => {
    for (const bad of [
      join(tmpdir(), 'ts-evil', 'settings.json'),
      '/etc/settings.json',
      join(homeTmp, '..', '..', '..', 'etc', 'settings.json'),
    ]) {
      expect(() => assertConfinedPath(bad, { flag: '--settings-path' }), bad).toThrow(/inside your home/)
    }
  })

  it('refuses a filename the flag was never for', () => {
    expect(() =>
      assertConfinedPath(join(homeTmp, '.bashrc'), {
        flag: '--settings-path',
        allowedBasenames: ['settings.json'],
      }),
    ).toThrow(/must name one of/)
  })

  /*
   * SYMLINKS (audit round 2 residual). `resolve()` is pure string arithmetic —
   * it never reads the filesystem — so the prefix test used to pass for a path
   * whose components point anywhere. A cloned repository can ship a symlink and
   * a shared/container home weakens the "you'd need write access to $HOME"
   * mitigation the old comment leaned on, so the check now realpaths both sides.
   *
   * `roots` is the seam: these fixtures own a whole fake home, which is the only
   * way to symlink a `.claude` without touching the developer's real one.
   */
  describe('symlinks are resolved BEFORE the prefix test', () => {
    let fakeHome: string
    let outside: string

    beforeAll(() => {
      fakeHome = mkdtempSync(join(tmpdir(), 'ts-argv-home-'))
      outside = mkdtempSync(join(tmpdir(), 'ts-argv-outside-'))
    })
    afterAll(() => {
      rmSync(fakeHome, { recursive: true, force: true })
      rmSync(outside, { recursive: true, force: true })
    })

    it('REFUSES a settings path under a ~/.claude that is a symlink out of the home', () => {
      // The exact shape from the finding: ~/.claude → an attacker-controlled dir.
      // The durable OAuth refresh token would land in `outside`.
      const claude = join(fakeHome, '.claude')
      symlinkSync(outside, claude, 'dir')
      expect(() =>
        assertConfinedPath(join(claude, 'settings.json'), {
          flag: '--settings-path',
          roots: [fakeHome],
          allowedBasenames: ['settings.json'],
        }),
      ).toThrow(/inside your home/)
    })

    it('REFUSES a settings.json that is itself a symlink pointing out of the home', () => {
      // The leaf EXISTS here, so this is the other half of realpathForWrite.
      const link = join(fakeHome, 'settings.json')
      writeFileSync(join(outside, 'stolen.json'), '{}\n')
      symlinkSync(join(outside, 'stolen.json'), link, 'file')
      expect(() =>
        assertConfinedPath(link, { flag: '--settings-path', roots: [fakeHome] }),
      ).toThrow(/inside your home/)
    })

    it('ACCEPTS a symlink that stays inside the home, and returns the RESOLVED target', () => {
      // The legitimate dotfiles shape (~/.config/claude → ~/dotfiles/claude):
      // hardening must not refuse it, and the caller must write where we checked.
      const real = join(fakeHome, 'dotfiles', 'claude')
      mkdirSync(real, { recursive: true })
      const link = join(fakeHome, '.claude-linked')
      symlinkSync(real, link, 'dir')
      expect(
        assertConfinedPath(join(link, 'settings.json'), {
          flag: '--settings-path',
          roots: [fakeHome],
          allowedBasenames: ['settings.json'],
        }),
      ).toBe(join(real, 'settings.json'))
    })

    it('still accepts a not-yet-existing file in an existing directory', () => {
      // realpath throws on a missing leaf; the deepest EXISTING ancestor is
      // resolved and the missing tail re-appended (a non-existent component
      // cannot be a symlink). This is the NORMAL redeem case — the file is
      // about to be created.
      const dir = join(fakeHome, 'fresh')
      mkdirSync(dir, { recursive: true })
      const fresh = join(dir, 'settings.json')
      expect(
        assertConfinedPath(fresh, {
          flag: '--settings-path',
          roots: [fakeHome],
          allowedBasenames: ['settings.json'],
        }),
      ).toBe(fresh)
    })

    it('REFUSES a DANGLING symlink pointing out of the home', () => {
      // The nastiest shape, and the one a first realpath fix misses: the link
      // exists, its target does not, so realpath raises ENOENT exactly as it
      // does for a file we are about to create. Opening it with O_CREAT would
      // create the target — outside the home, unchecked. lstat tells the two
      // apart. (Proven exploitable against the first cut of this fix.)
      const claude = join(fakeHome, 'dangling')
      mkdirSync(claude, { recursive: true })
      symlinkSync(join(outside, 'never-created.json'), join(claude, 'settings.json'), 'file')
      expect(() =>
        assertConfinedPath(join(claude, 'settings.json'), {
          flag: '--settings-path',
          roots: [fakeHome],
          allowedBasenames: ['settings.json'],
        }),
      ).toThrow(/could not be resolved/)
    })

    it('fails CLOSED when the path cannot be resolved at all', () => {
      // A non-directory in the middle (ENOTDIR) is not "missing" — we cannot say
      // where it points, so it is refused rather than assumed benign.
      const file = join(fakeHome, 'a-file')
      writeFileSync(file, 'x')
      expect(() =>
        assertConfinedPath(join(file, 'settings.json'), {
          flag: '--settings-path',
          roots: [fakeHome],
        }),
      ).toThrow(/could not be resolved/)
    })
  })
})

describe('flagValue / assertKnownFlag', () => {
  it('refuses a flag whose value is missing or is the next flag', () => {
    expect(() => flagValue(['--api-base'], 1, '--api-base')).toThrow(/requires a value/)
    expect(() => flagValue(['--api-base', '--settings-path'], 1, '--api-base')).toThrow(/requires a value/)
  })

  it('lets a handoff code start with a dash, which is why --handoff-code exists', () => {
    expect(flagValue(['--handoff-code', '-abc'], 1, '--handoff-code', { allowLeadingDash: true })).toBe('-abc')
  })

  it('refuses any unknown --flag, and does not echo raw control bytes back to the terminal', () => {
    expect(() => assertKnownFlag('--redeem-url')).toThrow(/unknown flag/)
    try {
      assertKnownFlag(`--${String.fromCharCode(27)}[31mboom`)
      throw new Error('expected a throw')
    } catch (err) {
      expect((err as Error).message).not.toContain(String.fromCharCode(27))
      expect((err as Error).message).toContain('unknown flag')
    }
    // A single leading dash is left alone: a bare positional handoff code may
    // legitimately start with one.
    expect(() => assertKnownFlag('-abc')).not.toThrow()
  })
})

describe('claude-redeem parseArgs', () => {
  it('refuses --redeem-url outright — the flag is gone, not silently ignored', () => {
    expect(() => parseClaudeArgs(['--handoff-code', 'h', '--redeem-url', EVIL])).toThrow(
      /unknown flag/,
    )
    // Order-independent: the value must not survive as a stray positional either.
    expect(() => parseClaudeArgs(['--redeem-url', EVIL, '--handoff-code', 'h'])).toThrow(
      /unknown flag/,
    )
  })

  it('refuses a --settings-path outside the account home, accepts one inside it', () => {
    expect(() =>
      parseClaudeArgs(['--handoff-code', 'h', '--settings-path', join(tmpdir(), 'settings.json')]),
    ).toThrow(/inside your home/)
    const good = join(homeTmp, 'settings.json')
    expect(parseClaudeArgs(['--handoff-code', 'h', '--settings-path', good]).settingsPath).toBe(good)
  })

  it('still accepts the documented invocations', () => {
    expect(parseClaudeArgs(['abc123']).handoffCode).toBe('abc123')
    const a = parseClaudeArgs(['--handoff-code', 'h', '--api-base', DISCOVERED, '--instance-id', 'i'])
    expect(a.handoffCode).toBe('h')
    expect(a.apiBase).toBe(DISCOVERED) // value-checked later, against the known origins
    expect(a.instanceId).toBe('i')
  })

  it('refuses a second positional (an argv this flow never produces)', () => {
    expect(() => parseClaudeArgs(['abc123', 'def456'])).toThrow(/extra argument/)
  })
})

describe('copilot-redeem parseArgs', () => {
  it('refuses --redeem-url outright', () => {
    expect(() => parseCopilotArgs(['--handoff-code', 'h', '--redeem-url', EVIL])).toThrow(
      /unknown flag/,
    )
  })

  it('refuses a --shell-rc outside the home, or with a filename no shell reads', () => {
    expect(() => parseCopilotArgs(['--shell-rc', join(tmpdir(), '.bashrc'), '--remove'])).toThrow(
      /inside your home/,
    )
    expect(() => parseCopilotArgs(['--shell-rc', '/etc/profile', '--remove'])).toThrow(
      /inside your home/,
    )
    expect(() => parseCopilotArgs(['--shell-rc', join(homeTmp, 'evil.sh'), '--remove'])).toThrow(
      /must name one of/,
    )
  })

  it('accepts an rc file in the home', () => {
    const rc = join(homeTmp, '.bashrc')
    expect(parseCopilotArgs(['--shell-rc', rc, '--remove']).shellRc).toBe(rc)
  })
})

/*
 * BEHAVIOURAL. parseArgs can be proven in-process; "the POST went somewhere
 * else" cannot. These run the real helper as a child against a mock server on
 * loopback, and assert on what the server RECEIVED — the only place a redirect
 * would be visible.
 */
describe('claude-redeem main() — no flag can redirect the handoff POST', () => {
  const HELPER = join(process.cwd(), 'plugin/scripts/claude-redeem.mjs')
  let server: ReturnType<typeof createServer>
  let baseUrl: string
  let hits: string[] = []
  let dir: string

  beforeAll(async () => {
    dir = mkdtempSync(join(realHome(), '.ts-argv-guard-main-'))
    server = createServer((req, res) => {
      hits.push(req.url ?? '')
      let raw = ''
      req.on('data', (c) => (raw += c))
      req.on('end', () => {
        res.writeHead(200, { 'Content-Type': 'application/json' })
        res.end(
          JSON.stringify({
            instance_id: 'f825e796-ef29-4aa0-9a35-4aa2a5b8059c',
            tool: 'claude-code',
            oauth_refresh_token: 'rt_DURABLE_SECRET',
            oauth_token_endpoint: `${baseUrl}/api/v1/oauth/token`,
            oauth_client_id: 'client-xyz',
            telemetry: {
              claude: {
                OTEL_LOGS_EXPORTER: 'otlp',
                OTEL_METRICS_EXPORTER: 'none',
                OTEL_EXPORTER_OTLP_LOGS_ENDPOINT: `${baseUrl}/azmon-stub/v1/logs`,
                OTEL_EXPORTER_OTLP_LOGS_PROTOCOL: 'http/protobuf',
                otel_headers_helper_url: `${baseUrl}/api/v1/instances/f825e796/bearer`,
                OTEL_RESOURCE_ATTRIBUTES: 'tokenscope.instance_id=f825e796,tool=claude-code',
              },
            },
          }),
        )
      })
    })
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
    const addr = server.address()
    baseUrl = `http://127.0.0.1:${typeof addr === 'object' && addr ? addr.port : 0}`
  })
  afterAll(async () => {
    await new Promise<void>((resolve) => server.close(() => resolve()))
    if (dir && dir.startsWith(join(realHome(), '.ts-argv-guard-main-'))) {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  // Async spawn (NOT spawnSync): the mock server runs in this worker's event
  // loop, so a synchronous spawn would deadlock.
  const run = (args: string[]) =>
    new Promise<{ status: number | null; out: string }>((resolve) => {
      // --state-dir keeps the spawned CLI's credential store in the sandbox; the
      // store now refuses to write the real ~/.tokenscope under a test runner.
      const child = spawn('node', [HELPER, ...args, '--state-dir', join(dir, 'state')], {
        env: {
          ...process.env,
          // The ONLY off-argv source in play: a LOOPBACK TOKENSCOPE_API_BASE is
          // the documented dev override, and it is what the helper falls back to
          // when a hostile --api-base is dropped. That fallback landing on this
          // mock server is the proof the flag did not choose the destination.
          TOKENSCOPE_API_BASE: baseUrl,
          TOKENSCOPE_STATE_DIR: join(dir, 'state'),
        },
      })
      let out = ''
      child.stdout.on('data', (c) => (out += c))
      child.stderr.on('data', (c) => (out += c))
      child.on('close', (status) => resolve({ status, out }))
    })

  it('a hostile --api-base is dropped: the POST still lands on the resolved host', async () => {
    hits = []
    const settings = join(dir, 'settings.json')
    const r = await run([
      '--handoff-code',
      'GOOD',
      '--api-base',
      'https://evil.invalid',
      '--settings-path',
      settings,
    ])
    expect(r.status).toBe(0)
    // It POSTed to the mock (loopback), not to evil.invalid — which would have
    // failed DNS and exited 1 with a network error.
    expect(hits).toEqual(['/api/v1/setup/redeem'])
    expect(r.out).toContain('ignoring --api-base')
    expect(existsSync(settings)).toBe(true)
  })

  it('--redeem-url is refused before any request is made', async () => {
    hits = []
    const settings = join(dir, 'settings2.json')
    const r = await run([
      '--handoff-code',
      'GOOD',
      '--redeem-url',
      `${baseUrl}/api/v1/setup/redeem`,
      '--settings-path',
      settings,
    ])
    expect(r.status).toBe(1)
    expect(r.out).toMatch(/unknown flag/)
    // The point of the flag was to name the POST target; nothing was posted at
    // all, so the handoff code was never spent.
    expect(hits).toEqual([])
    expect(existsSync(settings)).toBe(false)
  })

  it('a --settings-path outside the home is refused before any request is made', async () => {
    hits = []
    const outside = join(tmpdir(), `ts-argv-guard-${process.pid}-settings.json`)
    const r = await run(['--handoff-code', 'GOOD', '--settings-path', outside])
    expect(r.status).toBe(1)
    expect(r.out).toMatch(/inside your home/)
    expect(hits).toEqual([])
    expect(existsSync(outside)).toBe(false)
  })
})

describe('copilot-redeem main() — --shell-rc cannot name a file outside the home', () => {
  const HELPER = join(process.cwd(), 'plugin/scripts/copilot-redeem.mjs')
  let dir: string

  beforeAll(() => {
    dir = mkdtempSync(join(realHome(), '.ts-argv-guard-rc-'))
  })
  afterAll(() => {
    if (dir && dir.startsWith(join(realHome(), '.ts-argv-guard-rc-'))) {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  const run = (args: string[]) =>
    new Promise<{ status: number | null; out: string }>((resolve) => {
      const child = spawn('node', [HELPER, ...args])
      let out = ''
      child.stdout.on('data', (c) => (out += c))
      child.stderr.on('data', (c) => (out += c))
      child.on('close', (status) => resolve({ status, out }))
    })

  it('refuses an out-of-home rc target and leaves the file untouched', async () => {
    // --remove is the shortest path that reaches the rc files: it needs no
    // server and no handoff code, and it WRITES (rewrites the file without the
    // TokenScope block), so a refusal here is a refusal to touch the file.
    const outside = join(tmpdir(), `ts-argv-guard-${process.pid}-victim`)
    writeFileSync(outside, '# untouched\n')
    try {
      const r = await run(['--remove', '--shell-rc', outside])
      expect(r.status).toBe(1)
      expect(r.out).toMatch(/inside your home|must name one of/)
    } finally {
      rmSync(outside, { force: true })
    }
  })

  it('accepts an rc file inside the home (the flag still works for what it is for)', async () => {
    const rc = join(dir, '.bashrc')
    writeFileSync(rc, '# mine\n')
    const r = await run(['--remove', '--shell-rc', rc])
    expect(r.status).toBe(0)
    expect(r.out).toContain('nothing to remove')
  })
})

describe('the repository refusal survives a symlinked home', () => {
  it('canonicalises the stop root, so a symlinked home does not skip the repo check', () => {
    /*
     * The candidate arrives already realpath'd. If the confinement ROOT is only
     * resolved lexically, then the moment the account home is itself reached
     * through a symlink (/home/x -> /mnt/home/x, common on macOS and on mounted
     * homes) the prefix test is false immediately, the walk never runs, and a
     * credential destination inside a git repository is accepted.
     *
     * Modelled here by anchoring to a symlinked root rather than by moving the
     * real home: same asymmetry between a canonical candidate and a lexical root.
     */
    const base = mkdtempSync(join(realHome(), '.ts-symlink-root-'))
    try {
      const physical = join(base, 'physical')
      const repo = join(physical, 'cloned-repo')
      const target = join(repo, 'nested')
      mkdirSync(target, { recursive: true })
      mkdirSync(join(repo, '.git'), { recursive: true })
      const link = join(base, 'via-link')
      symlinkSync(physical, link)

      expect(() =>
        assertConfinedPath(join(link, 'cloned-repo', 'nested'), {
          flag: '--state-dir',
          roots: [link],
          refuseInsideRepo: true,
        }),
      ).toThrow(/inside a git repository/i)
    } finally {
      rmSync(base, { recursive: true, force: true })
    }
  })
})

describe('--state-dir is confined (the flag added for tests must not be a sink)', () => {
  /*
   * This flag exists so the suite can redirect the credential store after
   * trustedStateDir() stopped honouring TOKENSCOPE_STATE_DIR. Unconfined it
   * reopened the sink this whole module exists to close: the setup command's
   * grant ends in `:*`, so a prompt-injected model can append any argv tail with
   * no permission prompt — and this path receives the DURABLE refresh token.
   * argv may SELECT a file under the account's own home; it may never INTRODUCE
   * one, which is exactly what an unconfined --state-dir did.
   */
  it('refuses a state dir outside the account home', () => {
    expect(() =>
      parseClaudeArgs(['--handoff-code', 'GOOD', '--state-dir', '/tmp/anywhere']),
    ).toThrow(/inside your home directory|outside-home|could not be resolved/i)
  })

  it('accepts one inside the home', () => {
    const inside = mkdtempSync(join(realHome(), '.ts-state-dir-'))
    try {
      const out = parseClaudeArgs(['--handoff-code', 'GOOD', '--state-dir', inside])
      expect(out.stateDir).toBe(realpathSync(inside))
    } finally {
      rmSync(inside, { recursive: true, force: true })
    }
  })

  /*
   * HOME CONTAINMENT IS NOT ENOUGH FOR A CREDENTIAL DESTINATION.
   *
   * A cloned repository normally lives under the account's own home, so
   * "inside your home directory" cheerfully accepts `~/projects/<repo>/exfil`.
   * A durable refresh token written there is then committed and pushed by the
   * very repo that chose the path — exfiltration through ordinary git, with no
   * second bug required. Both flags are the same sink: --state-dir writes
   * config.json, and --settings-path writes the env block that CARRIES the
   * token.
   */
  for (const flag of ['--state-dir', '--settings-path'] as const) {
    it(`refuses ${flag} inside a git repository even though it is under the home`, () => {
      const home = mkdtempSync(join(realHome(), '.ts-repo-sink-'))
      try {
        const repo = join(home, 'cloned-repo')
        const target = join(repo, 'nested', 'deeper')
        mkdirSync(target, { recursive: true })
        mkdirSync(join(repo, '.git'), { recursive: true })
        const value = flag === '--settings-path' ? join(target, 'settings.json') : target
        expect(() => parseClaudeArgs(['--handoff-code', 'GOOD', flag, value])).toThrow(
          /inside a git repository/i,
        )
      } finally {
        rmSync(home, { recursive: true, force: true })
      }
    })

    it(`still accepts ${flag} in a plain home directory that is not a repository`, () => {
      const home = mkdtempSync(join(realHome(), '.ts-repo-sink-ok-'))
      try {
        const target = join(home, 'nested')
        mkdirSync(target, { recursive: true })
        const value = flag === '--settings-path' ? join(target, 'settings.json') : target
        expect(() => parseClaudeArgs(['--handoff-code', 'GOOD', flag, value])).not.toThrow()
      } finally {
        rmSync(home, { recursive: true, force: true })
      }
    })
  }
})
