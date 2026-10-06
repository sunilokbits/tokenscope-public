/*
 * enroll (Copilot CLI) — emit-on-install enrollment for the privately-distributed
 * Insight Copilot plugin (docs/design/emit-on-install-provisional-attribution.md
 * §Flows 1). The Copilot analogue of plugin/scripts/enroll.mjs (the Claude half).
 *
 * On a FRESH install of the real (publish-injected) plugin, the SessionStart hook
 * (forwarder-lifecycle.mjs `start`) calls enrollIfNeeded() so the device emits
 * WITHOUT any login (the Copilot App from this session; the CLI from its next launch,
 * since it reads the EXTENSIONS feature only at start): the plugin presents its bundled enrollment
 * secret + a claimed email to POST /api/v1/setup/enroll, and writes the returned
 * emit-only credential + the forwarder's config into ~/.tokenscope/config.copilot-cli.json
 * (mode 0600, atomic temp+rename) using the SAME on-disk shape the redeem flow
 * writes (copilot-redeem's writeTokenscopeConfig). Usage then attributes
 * PROVISIONALLY to the claimed email until the human signs in and confirms.
 *
 * It is a strict NO-OP unless ALL of these hold, so it never re-enrols, never
 * clobbers a real credential, and never fires for an un-injected dev checkout:
 *   - the device is NOT already enrolled (no complete emit credential in
 *     ~/.tokenscope/config.copilot-cli.json), AND
 *   - a bundled enrollment secret IS configured (publish-injected, not the
 *     placeholder), AND
 *   - we can determine a real claimed email (never guessed).
 *
 * Best-effort + fail-OPEN throughout: a short timeout, and every failure path
 * returns a reason rather than throwing — the SessionStart hook must never break
 * the user's session over enrolment, and must not delay the forwarder spawn.
 *
 * EMAIL SOURCE (the claim) — DELIBERATELY DIFFERENT from the Claude half. Claude
 * reads ~/.claude.json → oauthAccount.emailAddress (the email Claude Code itself
 * authenticated with). Copilot CLI has NO such app-managed OAuth email file the
 * plugin can read, so the source order here is:
 *   1. `git config user.email` (the repo / global git identity) — the email the
 *      developer commits as; the closest stable "email this device already knows".
 *   2. ~/.copilot/config.json (or apps.json) — IF Copilot ever persists an email
 *      there, use it (best-effort, schema-tolerant scan for an `@` string value).
 * The hook's invocation carries NO email, so it is not a source. If neither yields
 * an `@` address we SKIP enrolment rather than claim a bad identity. The claimed
 * email is just a PROVISIONAL attribution hint the server reconciles on first
 * human sign-in (slice 5) — it is never an auth factor — so git identity is a
 * sound, low-risk source for it.
 *
 * DEVICE BINDING (a display hint only — NOT an auth factor and NOT a dedup key;
 * the server HMAC-hashes it at rest, and every enrol mints a fresh provisional
 * device even for a binding seen before): a stable per-host id = `<hostname>:<machine-id>`, where
 * machine-id is /etc/machine-id when present, else just the hostname. Per-host
 * matches the instance model (all containers on a host share the home → one
 * instance).
 *
 * STANDALONE: this file imports nothing from plugin/scripts/* — the copilot-plugin
 * ships independently (like copilot-redeem.mjs, it inlines its own HTTP + api-base
 * + config IO). It reads ~/.tokenscope/config.copilot-cli.json inline; it does NOT introduce a
 * shared config-reader module.
 */
import { readFileSync, writeFileSync, existsSync, mkdirSync, chmodSync, renameSync, rmSync, linkSync } from 'node:fs'
import { homedir, hostname } from 'node:os'
import { join } from 'node:path'
import { randomBytes } from 'node:crypto'
import { deviceStorePath, legacyStorePath, assertStoreConsistent } from './device-store.mjs'
import { fileURLToPath } from 'node:url'
import { execFileSync } from 'node:child_process'
import { trustedGitPath } from './trusted-git.mjs'
import https from 'node:https'
import http from 'node:http'
import { resolveEnrollmentSecret } from './enrollment-secret.mjs'
// Span emission is armed via the SAME relative-path mechanism as the manual redeem —
// reuse it so emit-on-install and `copilot-redeem` agree on the on-disk contract.
// assertSafeRedeemBundle (S2) is REACHED here too, not re-implemented: enroll.mjs
// already imports from this vendored sibling, so validating the server-supplied
// endpoint bundle before it is persisted uses the SAME check copilot-redeem.mjs's
// own redeem path uses (both write onto the identical ~/.tokenscope/config.copilot-cli.json
// contract, so they must agree on what "safe" means).
import {
  armUsageExtension,
  copilotSettingsPath,
  detectShellRcTargets,
  assertSafeRedeemBundle,
} from './copilot-redeem.mjs'
// endpoint-guard.mjs (S1/S2) — the ONE endpoint validator, vendored verbatim (see
// scripts/sync-copilot-plugin.mjs). Never write a second one; import it here too,
// same as landed-check.mjs and status.mjs.
import { assertSafeEndpoint } from './endpoint-guard.mjs'
// real-home.mjs — the ONE answer to "where is the account's home", vendored verbatim
// like endpoint-guard.mjs. This door WRITES config.copilot-cli.json (oauth_refresh_token), so it
// must land on the same anchor copilot-redeem.mjs writes and copilot-forwarder.mjs
// reads; see stateDir() below.
import { realHome } from './real-home.mjs'
// mcp-origin.mjs — the ONE resolver for "where is the MCP server actually
// registered", vendored verbatim like endpoint-guard.mjs. Used here so the enrol
// door resolves its destination from user-scope config rather than from the
// environment; see resolveApiBase below.
import { discoverMcpOrigin } from './mcp-origin.mjs'
// managed-telemetry.mjs (Workstream D §10.1) — best-effort post-enrol check: a
// hostile enterprise-managed telemetry setting can silently kill the file exporter
// this very enrolment just armed. Vendored verbatim like the two above.

// Bound the enroll POST so a network blackhole can't hang session startup (the
// SessionStart hook has a 15s budget shared with the forwarder spawn).
const ENROLL_TIMEOUT_MS = 4000

// The baked API base — mirrors plugin/scripts/api-base.mjs's DEFAULT_API_BASE.
// The plugin ships from a specific deployment's marketplace, so it implies its
// server; TOKENSCOPE_API_BASE overrides for local dev / another instance. A public
// hostname, not a secret.
const DEFAULT_API_BASE = 'https://ca-tscope-sandbox-wus3.wittydune-91621c23.westus3.azurecontainerapps.io'

/**
 * Resolve the API base (explicit arg > discovered registration > baked default),
 * trailing slash stripped.
 *
 * TOKENSCOPE_API_BASE IS DELIBERATELY NOT A SOURCE HERE, and it used to be the
 * FIRST one — above even the explicit argument. This is the call that POSTs the
 * bundled ENROLLMENT SECRET and then persists whatever bearer / OTLP / oauth
 * endpoints come back into ~/.tokenscope/config.copilot-cli.json, so whoever names the host
 * gets the org-wide secret on the way out and the destination of every future
 * token and span on the way back. `plugin/scripts/api-base.mjs` documents why
 * that env var is not a trustworthy source (a repository can supply it, and
 * repo-supplied env is indistinguishable from shell-exported env), and
 * `claude-redeem.mjs` / `plugin/scripts/enroll.mjs` resolve with `trustEnv:false`
 * for exactly this reason. This function was the remaining copy that had not
 * caught up — a SECOND, private resolver outside `scripts/sync-copilot-plugin.mjs`'s
 * FILES list, so the drift check could not see it.
 *
 * Discovery takes the env var's place rather than nothing following the argument,
 * so an operator who registered their own MCP server still enrols against their
 * own server, and a local dev whose registration IS localhost:3450 still reaches
 * it. Those origins come from user-scope config the human wrote (see
 * mcp-origin.mjs); a checked-out repository cannot author them.
 */
export function resolveApiBase(argBase, { discovered } = {}) {
  const found = discovered === undefined ? defaultDiscoverOrigin() : discovered
  const raw = (argBase ?? '').trim() || (found ?? '').trim() || DEFAULT_API_BASE
  return raw.replace(/\/+$/, '')
}

/**
 * The registered MCP origin, or null.
 *
 * `discoverMcpOrigin` never throws, but locating the plugin's own bundle to hand
 * it does: `import.meta.url` is a `file:` URL when node runs this script
 * directly (every production path) and is NOT one under a bundler's module
 * transform, where `fileURLToPath` raises `ERR_INVALID_URL_SCHEME`. Enrolment is
 * fail-OPEN and runs from a lifecycle hook, so an unresolvable bundle path must
 * degrade to "nothing registered" rather than abort it. Degrading to null falls
 * to the baked default, never to TOKENSCOPE_API_BASE, which this path does not
 * consult at all.
 */
function defaultDiscoverOrigin() {
  try {
    return discoverMcpOrigin(fileURLToPath(new URL('.', import.meta.url)), { client: 'copilot' })
  } catch {
    return null
  }
}

/**
 * POST a JSON body, resolve the parsed JSON response. Dependency-free; mirrors the
 * httpsPost in copilot-redeem.mjs. Rejects on a non-2xx status or a non-JSON body.
 * NEVER logs the body — it redeems credential material. Bounded by timeoutMs.
 *
 * The URL is validated via assertSafeEndpoint (S2 — closes the Copilot leg of
 * client-plugins:mitm:0003) BEFORE any request is built: this used to pick
 * `http` for ANY non-https URL with no complaint (the "plain-http fallback"),
 * silently downgrading a poisoned api base to plaintext instead of refusing it.
 * allowLoopback:true — a locally-running dev server (TOKENSCOPE_API_BASE=
 * http://localhost:3450) legitimately answers on 127.0.0.1/::1.
 */
export function httpsPostJson(urlStr, body, { timeoutMs = 30_000 } = {}) {
  return new Promise((resolve, reject) => {
    let url
    try {
      url = assertSafeEndpoint(urlStr, { allowLoopback: true })
    } catch (err) {
      reject(err instanceof Error ? err : new Error(String(err)))
      return
    }
    const bodyBuf = Buffer.from(JSON.stringify(body), 'utf8')
    const mod = url.protocol === 'https:' ? https : http
    const req = mod.request(
      {
        method: 'POST',
        hostname: url.hostname,
        port: url.port || undefined,
        path: url.pathname + url.search,
        headers: {
          'Content-Type': 'application/json',
          'Content-Length': bodyBuf.length,
          Accept: 'application/json',
        },
      },
      (res) => {
        let data = ''
        res.on('data', (c) => (data += c))
        res.on('end', () => {
          if (res.statusCode >= 200 && res.statusCode < 300) {
            try {
              resolve(JSON.parse(data))
            } catch {
              reject(new Error(`Non-JSON response: ${data.slice(0, 200)}`))
            }
          } else {
            reject(new Error(`HTTP ${res.statusCode}: ${data.slice(0, 500)}`))
          }
        })
      },
    )
    if (timeoutMs > 0) {
      req.setTimeout(timeoutMs, () => {
        req.destroy(new Error(`request timed out after ${timeoutMs}ms`))
      })
    }
    req.on('error', reject)
    req.write(bodyBuf)
    req.end()
  })
}

/**
 * The TokenScope state dir: a `TOKENSCOPE_STATE_DIR` pin first, else `~/.tokenscope`
 * under the PASSWD home. The house form — `plugin-runtime.mjs`'s `stateDir()`,
 * `status.mjs`, `landed-check.mjs` and `copilot-forwarder.mjs` all resolve this way,
 * and `copilot-redeem.mjs` anchors its own `TOKENSCOPE_DIR` on `realHome()` too.
 *
 * The anchor is `realHome()`, not `homedir()`, because this is the SECOND writer of
 * `config.copilot-cli.json` — which holds `oauth_refresh_token`. `os.homedir()` consults `HOME`
 * first, so a leaked or model-set `HOME` would decide where a live durable credential
 * lands, and would split this writer from the forwarder that has to read it back.
 *
 * The `home` parameter is still honoured when passed (tests inject one); it only
 * changed what the DEFAULT is. Note that the caller's own `home` option — the one
 * `enrollIfNeeded` threads into `readClaimedEmail` and `armRc` — is deliberately NOT
 * this value: `~/.copilot/*` is read by Copilot itself and a shell rc is read by the
 * user's shell, and both of those resolve through `$HOME`.
 */
export function stateDir(env = process.env, home = realHome()) {
  return (env?.TOKENSCOPE_STATE_DIR ?? '').trim() || join(home, '.tokenscope')
}

/** Read the Copilot store (or null on any failure — missing/unparseable). */
export function readConfig(configPath) {
  try {
    return JSON.parse(readFileSync(configPath, 'utf8'))
  } catch {
    return null
  }
}

/**
 * True if `config` (the parsed ~/.tokenscope/config.copilot-cli.json) already carries a
 * COMPLETE emit enrolment — a durable OAuth refresh token AND a bearer endpoint
 * AND a non-empty instance id. When enrolled we must NEVER re-enrol (it would mint
 * a second provisional instance) or clobber the existing (possibly
 * redeemed/confirmed) credential. The Copilot analogue of the Claude isEnrolled
 * env-block check — the forwarder's mintBearer needs exactly these three keys.
 */
export function isEnrolled(config) {
  if (!config || typeof config !== 'object') return false
  const hasRefresh = Boolean((config.oauth_refresh_token ?? '').trim?.())
  const hasBearer = Boolean((config.bearer_endpoint ?? '').trim?.())
  const hasInstance = Boolean((config.instance_id ?? '').trim?.())
  return hasRefresh && hasBearer && hasInstance
}

/**
 * Best-effort scan of a Copilot config object for an `@` email string value.
 * Schema-tolerant: Copilot does not document a stable email field, so we look at a
 * few likely shapes and otherwise give up (never guesses a non-email value).
 */
function emailFromCopilotConfig(obj) {
  if (!obj || typeof obj !== 'object') return null
  const candidates = [
    obj.email,
    obj.user?.email,
    obj.account?.email,
    obj.oauthAccount?.emailAddress,
    obj.user?.login, // GitHub login is sometimes an email
  ]
  for (const c of candidates) {
    if (typeof c === 'string' && c.includes('@')) return c.trim()
  }
  return null
}

/**
 * Determine the claimed email for the enrol, or null if none is trustworthy.
 * Source order documented in the module header (git identity first — Copilot has
 * no Claude OAuth email file). NEVER guesses — a missing email skips enrolment
 * rather than claiming a wrong identity.
 */
export function readClaimedEmail({ cwd = process.cwd(), home = homedir() } = {}) {
  // 1. The repo's / global git identity — the email the developer commits as.
  try {
    const git = trustedGitPath()
    if (!git) throw new Error('no trusted git') // caught below; never a name lookup
    const e = execFileSync(git, ['config', 'user.email'], {
      cwd,
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
    }).trim()
    if (e.includes('@')) return e
  } catch {
    /* no git / no configured identity — fall through */
  }
  // 2. Fallback: any email Copilot persisted in ~/.copilot/{config,apps}.json.
  for (const f of ['config.json', 'apps.json']) {
    try {
      const obj = JSON.parse(readFileSync(join(home, '.copilot', f), 'utf8'))
      const e = emailFromCopilotConfig(obj)
      if (e) return e
    } catch {
      /* no such file / not parseable — try the next */
    }
  }
  return null
}

/**
 * A stable per-host device-binding hint. The server stores it HMAC-hashed as a
 * display hint only — never a dedup key or an auth factor — so a best-effort stable
 * value is sufficient. /etc/machine-id when present, else just the hostname.
 */
export function computeDeviceBinding() {
  let machineId = ''
  try {
    machineId = readFileSync('/etc/machine-id', 'utf8').trim()
  } catch {
    /* not a systemd host */
  }
  return machineId ? `${hostname()}:${machineId}` : hostname()
}

/** Atomic temp+rename write (mode if given) — never truncates on a crash mid-write. */
function writeFileAtomic(path, content, mode, { exclusive = false } = {}) {
  // Random, not PID-only: PIDs collide across containers on the shared mount.
  const tmp = `${path}.tmp.${process.pid}.${randomBytes(6).toString('hex')}`
  try {
    writeFileSync(tmp, content, { encoding: 'utf8', ...(mode != null ? { mode } : {}) })
    if (mode != null) chmodSync(tmp, mode) // defeat umask
    if (exclusive) {
      // link fails with EEXIST: check and create in one operation.
      linkSync(tmp, path)
    } else {
      renameSync(tmp, path)
    }
  } catch (err) {
    try {
      rmSync(tmp, { force: true })
    } catch {
      /* best-effort cleanup */
    }
    throw err
  } finally {
    if (exclusive) {
      try {
        rmSync(tmp, { force: true })
      } catch {
        /* best-effort */
      }
    }
  }
}

/**
 * Build the ~/.tokenscope/config.copilot-cli.json payload from a COPILOT-shaped enroll response.
 *
 * The enroll POST now passes `tool: 'copilot-cli'` (P1-5), so the server returns the
 * copilot bundle directly (telemetry.copilot, the CopilotBundle shape — TOKENSCOPE_*
 * endpoints + an OTEL_RESOURCE_ATTRIBUTES that ALREADY says tool=copilot-cli) instead
 * of a claude bundle the client had to regex-rewrite. We map those fields onto the
 * forwarder's config shape — the SAME mapping copilot-redeem.mjs's writeTokenscopeConfig
 * uses (the exact keys copilot-emit.mjs's loadConfig + mintBearer read).
 * Throws if the attribution-critical fields are missing (so we never write a
 * half-config the forwarder would silently fail on). Exported for unit testing.
 */
export function buildCopilotConfig(resp) {
  const copilot = resp?.telemetry?.copilot
  const instanceId = (resp?.instance_id ?? copilot?.instance_id ?? '').trim?.() || ''
  const bearerEndpoint =
    (resp?.bearer_endpoint ?? copilot?.TOKENSCOPE_BEARER_ENDPOINT ?? '').trim?.() || ''
  const logsEndpoint =
    (copilot?.TOKENSCOPE_LOGS_ENDPOINT ?? resp?.logs_endpoint ?? '').trim?.() || ''
  const tokenEndpoint =
    (resp?.oauth_token_endpoint ?? copilot?.TOKENSCOPE_OAUTH_TOKEN_ENDPOINT ?? '').trim?.() || ''
  const clientId =
    (resp?.oauth_client_id ?? copilot?.TOKENSCOPE_OAUTH_CLIENT_ID ?? '').trim?.() || ''
  const refreshToken = (resp?.oauth_refresh_token ?? '').trim?.() || ''
  // tool=copilot-cli is already baked into the server bundle — no client rewrite.
  const attrs = (copilot?.OTEL_RESOURCE_ATTRIBUTES ?? '').trim?.() || ''

  // Attribution invariant: a non-empty instance id, or every record is unjoinable
  // to a teammate. `tokenscope.instance_id=` with an empty value is just as broken.
  if (!instanceId) throw new Error('enroll response missing instance_id')
  if (!/tokenscope\.instance_id=[^,\s]/.test(attrs)) {
    throw new Error(
      'enroll response missing a non-empty OTEL_RESOURCE_ATTRIBUTES tokenscope.instance_id',
    )
  }
  // The durable emit credential + endpoints the forwarder's mintBearer requires —
  // a partial response would write a credential otel-headers-helper.sh treats as
  // NOT CONFIGURED (silent zero telemetry).
  if (!bearerEndpoint) throw new Error('enroll response missing bearer endpoint')
  if (!logsEndpoint) throw new Error('enroll response missing logs endpoint')
  if (!tokenEndpoint || !clientId || !refreshToken) {
    throw new Error('enroll response missing a complete OAuth emit credential')
  }
  // S2 fix — validate the resolved endpoint bundle is SAFE (https, or an
  // explicitly allowed loopback) BEFORE it is returned for persisting. Reuses
  // copilot-redeem.mjs's assertSafeRedeemBundle (imported above) rather than a
  // second validator: emit-on-install and the manual redeem write onto the
  // IDENTICAL ~/.tokenscope/config.copilot-cli.json contract, so both paths must agree on
  // what "safe" means. Throws — the caller (enrollIfNeeded) already treats any
  // throw from buildCopilotConfig as a fail-open 'write-failed'.
  assertSafeRedeemBundle({
    TOKENSCOPE_BEARER_ENDPOINT: bearerEndpoint,
    TOKENSCOPE_LOGS_ENDPOINT: logsEndpoint,
    TOKENSCOPE_OAUTH_TOKEN_ENDPOINT: tokenEndpoint,
  })

  const config = {
    // The same v2 envelope copilot-redeem writes.
    version: 2,
    tool: 'copilot-cli',
    instance_id: instanceId,
    bearer_endpoint: bearerEndpoint,
    logs_endpoint: logsEndpoint,
    oauth_token_endpoint: tokenEndpoint,
    oauth_client_id: clientId,
    oauth_refresh_token: refreshToken,
    otel_resource_attributes: attrs,
  }
  // Same rule the helper refuses on. enrollIfNeeded treats a throw here as a
  // fail-open 'write-failed', which is right: never persist a store setup
  // cannot later repair.
  assertStoreConsistent('copilot-cli', config)
  return config
}

/**
 * Write the enroll config into `targetDir` (default ~/.tokenscope), mirroring
 * copilot-redeem's writeTokenscopeConfig on-disk contract:
 *   - config.copilot-cli.json (mode 0600, atomic) — the forwarder-readable durable store.
 * The access-token cache is the helper's alone; nothing here writes it.
 * Exported for unit testing.
 */
export function writeTokenscopeConfig(config, targetDir = stateDir(), { exclusive = false } = {}) {
  mkdirSync(targetDir, { recursive: true, mode: 0o700 })
  // Per-tool: this lane owns config.copilot-cli.json. Two writers though
  // (auto-enrol here, manual redeem), so auto-enrol creates EXCLUSIVELY and
  // treats EEXIST as already-enrolled; redeem keeps replacement semantics.
  const configPath = deviceStorePath('copilot-cli', targetDir)
  if (exclusive && existsSync(configPath)) {
    const err = new Error(`EEXIST: ${configPath} already exists`)
    err.code = 'EEXIST'
    throw err
  }
  writeFileAtomic(configPath, JSON.stringify(config, null, 2) + '\n', 0o600, { exclusive })
}

/**
 * Enrol this device for emit-on-install IFF it is a fresh install of the real
 * (publish-injected) plugin. Returns { enrolled, reason?, instanceId? }; never
 * throws (fail-open). Dependencies are injectable for unit testing.
 *
 * @param {{
 *   targetDir?: string,
 *   apiBase?: string|null,
 *   enrollmentSecret?: string,
 *   claimedEmail?: string|null,
 *   deviceBinding?: string,
 *   timeoutMs?: number,
 *   post?: typeof httpsPostJson,
 *   writeConfig?: typeof writeTokenscopeConfig,
 *   env?: NodeJS.ProcessEnv,
 *   cwd?: string,
 *   home?: string,
 * }} [opts]
 */
export async function enrollIfNeeded({
  targetDir = stateDir(),
  apiBase = null,
  enrollmentSecret = resolveEnrollmentSecret(),
  claimedEmail = undefined,
  deviceBinding = undefined,
  timeoutMs = ENROLL_TIMEOUT_MS,
  post = httpsPostJson,
  writeConfig = writeTokenscopeConfig,
  // The Copilot process's environment: picks the lane and where Copilot's settings live.
  env = process.env,
  // Arms span emission for future copilot launches (the shell-rc export). Injectable so
  // unit tests don't touch the real ~/.bashrc; defaults to the real relative-path arming.
  // Its messages (including the hand-enable guidance when settings.json cannot be
  // updated) go to stderr beside the managed-telemetry warning below.
  armRc = (h) =>
    armUsageExtension(detectShellRcTargets(undefined, h), {
      settingsPath: copilotSettingsPath(env, h),
      log: (m) => console.error(m),
    }),
  cwd = process.cwd(),
  home = homedir(),
} = {}) {
  // 1. An OWN store on disk, in ANY shape, is a no-op, and it is checked FIRST:
  //    auto-enrol creates the file exclusively and can never replace it, so
  //    re-POSTing here would present the enrolment secret on every launch and
  //    never repair the device. Repair is the manual redeem. Only when no own
  //    store exists does a COMPLETE legacy shared store count as enrolled (this
  //    lane's pre-split read); an incomplete or corrupt legacy file is not ours.
  const ownStore = deviceStorePath('copilot-cli', targetDir)
  if (existsSync(ownStore)) {
    const reason = isEnrolled(readConfig(ownStore)) ? 'already-enrolled' : 'own-store-incomplete'
    return { enrolled: false, reason }
  }
  if (isEnrolled(readConfig(legacyStorePath(targetDir)))) {
    return { enrolled: false, reason: 'already-enrolled' }
  }

  // 2. No bundled secret (un-injected dev build) — only the real distributed plugin
  //    enrols. Trim-guarded inside resolveEnrollmentSecret.
  if (!enrollmentSecret) return { enrolled: false, reason: 'no-secret' }

  // 3. Need a trustworthy claimed email — never guess.
  const email = claimedEmail === undefined ? readClaimedEmail({ cwd, home }) : claimedEmail
  if (!email) return { enrolled: false, reason: 'no-email' }

  // 4. Resolve the enroll URL from the configured api base. S2 fix: a naive
  //    startsWith('http') guard accepts http:// as readily as https:// — replaced
  //    with assertSafeEndpoint so a misconfigured (or MITM'd) TOKENSCOPE_API_BASE
  //    is refused, not silently POSTed to in plaintext (allowLoopback for local dev).
  const base = resolveApiBase(apiBase)
  const url = `${base}/api/v1/setup/enroll`
  try {
    assertSafeEndpoint(url, { allowLoopback: true })
  } catch {
    return { enrolled: false, reason: 'no-base' }
  }

  // 5. POST best-effort (bounded). A failure here must stay silent.
  const binding = deviceBinding === undefined ? computeDeviceBinding() : deviceBinding
  let resp
  try {
    // tool=copilot-cli (P1-5): a SERVER-SIDE discriminator so the endpoint returns
    // the copilot bundle (telemetry.copilot, tool=copilot-cli) directly — no
    // client-side regex rewrite of a claude bundle's tool= token.
    resp = await post(
      url,
      {
        enrollment_secret: enrollmentSecret,
        claimed_email: email,
        device_binding: binding,
        tool: 'copilot-cli',
      },
      { timeoutMs },
    )
  } catch {
    return { enrolled: false, reason: 'post-failed' }
  }

  // 6. Validate + write. buildCopilotConfig throws on any incomplete/unattributable
  //    bundle BEFORE we touch config.copilot-cli.json (so we never write a half-config).
  try {
    const config = buildCopilotConfig(resp)
    // Exclusive: a redeem may have landed during the POST above. EEXIST is the
    // outcome we wanted, not a failure.
    try {
      writeConfig(config, targetDir, { exclusive: true })
    } catch (err) {
      if (err && err.code === 'EEXIST') return { enrolled: false, reason: 'already-enrolled' }
      throw err
    }
    // Arm usage capture for FUTURE copilot launches (parity with Claude's settings.json
    // emit-on-install): enable the EXTENSIONS feature so the usage extension loads, and
    // remove any old shell-rc exporter block. Copilot reads both at launch, so this
    // takes effect next launch. Best-effort: a failed write must not fail the enrol.
    let extensions = 'failed'
    try {
      extensions = armRc(home)?.extensions ?? 'failed'
    } catch (err) {
      console.error(`[tokenscope-enroll] could not enable usage capture: ${err?.code ?? err?.message ?? err}`)
    }
    // No managed-telemetry check here: that policy only reaches the legacy span
    // exporter, and a fresh install is on the usage-extension lane (setup never
    // exports the span variable any more). The status reports the policy regardless.
    return { enrolled: true, instanceId: config.instance_id, extensions }
  } catch {
    return { enrolled: false, reason: 'write-failed' }
  }
}
