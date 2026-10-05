#!/usr/bin/env node
/*
 * SessionStart hook — two jobs, both fail-OPEN (a hook must never break the
 * user's session):
 *
 *  1. ZERO-TOUCH REPO TAGGING ("B′" model). If (a) this device is enrolled and
 *     (b) the cwd's repo has a committed `.tokenscope` with a project.code,
 *     reconcile the repo-local ./.claude/settings.local.json from the CURRENT
 *     global enrolment (ADR-0006 self-heal) so the NEXT `claude` launch is tagged.
 *     OTel resource attrs are frozen at process startup, so this can't re-tag the
 *     RUNNING session — it prepares the next one.
 *
 *  2. PROACTIVE EMISSION-HEALTH WARNING (ADR-0006 residual). The whole point of
 *     TokenScope is "track every token" — a developer must NOT have to ASK whether
 *     they're emitting and discover silent breakage only by running
 *     /tokenscope:status. On session start we surface a visible `systemMessage` on
 *     a DEFINITE auth failure, and stay SILENT on a transient/unverifiable failure
 *     (network blip — the exporter keeps its last bearer) so it never cries wolf.
 *
 *     It runs the REAL emit path (the helper) and warns only on a LIVE,
 *     retry-surviving failure. It does NOT trust a pre-existing sentinel (a
 *     stale/transient one — e.g. a superseded-cache 401 the helper self-heals on
 *     retry, or a since-resolved failure — would cry wolf), and it does NOT
 *     throttle on a prior-success stamp (that would MASK a credential that died
 *     inside the window). Both shortcuts traded correctness for a saved network
 *     call; the probe is cheap (cached ~30-day access token → a single /bearer
 *     GET), so we always run the live, self-healing check.
 *
 * Fail-OPEN throughout: any error exits 0 with no output, and a warning is the
 * ONLY thing ever written to stdout (a SessionStart hook's top-level
 * `systemMessage` is shown to the developer; `additionalContext` goes to the
 * model). No credential/token material is ever written to stdout or stderr.
 */
import { existsSync, realpathSync, readFileSync, rmSync, chmodSync } from 'node:fs'
import { homedir } from 'node:os'
import { join, dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { resolveRepoProjectCode, computeCodeHash, readGlobalEnrolment, writeRepoTag, resolveRepoRoot } from '../scripts/tag-repo.mjs'
import { reconcilePluginPaths } from '../scripts/env-builder.mjs'
import {
  readSettingsEnv,
  readEmitSentinel,
  runEmitHelper,
  stateDir,
  globalSettingsEnv,
  repoTagEnv,
  safeProcessEnv,
  realHome,
  migrateStoredEndpoints,
  casWriteFile,
} from '../scripts/plugin-runtime.mjs'
import { refreshLanded } from '../scripts/landed-check.mjs'
import { checkRepoProjectBillable } from '../scripts/project-check.mjs'
import { enrollIfNeeded } from '../scripts/enroll.mjs'
import { assertSafeEndpoint, isLoopbackHostname } from '../scripts/endpoint-guard.mjs'

// This hook always runs at the ACTIVE plugin version (its command uses
// ${CLAUDE_PLUGIN_ROOT}), so its own dir locates the active scripts.
const HOOK_DIR = dirname(fileURLToPath(import.meta.url))

// Bound the active probe so a network blackhole can't hang session startup.
const PROBE_TIMEOUT_MS = 4000

/**
 * The env the NEXT launch in `cwd` will actually use — GLOBAL settings, with
 * ONLY `OTEL_RESOURCE_ATTRIBUTES` taken from the repo-local tag (S1 fix 1,
 * `repoTagEnv` in plugin-runtime.mjs). Every credential-bearing read in this
 * hook (the emit-health probe, the enrol/landed/
 * project-billability calls) MUST go through this — never a raw
 * `{...global, ...repo}` spread, which lets a repo committed into any cloned
 * repository override the endpoint a credential gets POSTed to while the
 * credential itself still comes from the trusted global file.
 */
function repoAwareEnv(cwd) {
  return repoTagEnv(globalSettingsEnv(), readSettingsEnv(join(cwd, '.claude', 'settings.local.json')))
}

/**
 * The repo-local settings files whose `env` blocks Claude Code merges over the
 * global one. BOTH are repo-controlled: `settings.json` is committed to the
 * repository, `settings.local.json` is the file our own tagger writes — a
 * hostile repository can ship either.
 */
const REPO_SETTINGS_FILES = ['settings.json', 'settings.local.json']

/** The one key whose provenance this hook has to establish. */
const STATE_DIR_KEY = 'TOKENSCOPE_STATE_DIR'

/**
 * The keys that decide WHERE `os.homedir()` points. `homedir()` consults `HOME`
 * (POSIX) / `USERPROFILE` (Windows) before the passwd entry, so these choose the
 * file `globalSettingsEnv()` opens — and that file is this hook's trust anchor
 * three times over: it is what `hookStateDir` restores a repo-claimed state dir
 * FROM, what `safeProcessEnv()` restores every credential-steering key from, and
 * what `repoAwareEnv()` builds the emit-probe env out of.
 * They are also the one class `hookStateDir`'s restore-from-global trick cannot
 * settle by itself: the global file's own LOCATION is what they decide.
 */
const HOME_KEYS = ['HOME', 'USERPROFILE']

/**
 * Does `env` name `key` at all, in ANY letter case?
 *
 * Case-folded because `process.env` is case-INSENSITIVE on Windows: there a
 * repo-supplied `tokenscope_state_dir` sets the same variable Node hands back
 * for `process.env.TOKENSCOPE_STATE_DIR`, so an exact-key test on the settings
 * JSON would miss a claim that still steers `stateDir()`. On POSIX the cases
 * are distinct variables and only the exact spelling can steer anything, so
 * folding costs nothing there and closes the Windows case.
 *
 * Presence-based, not string-typed: a repo naming the key with a number or a
 * null is still a repo that named the key, and "did a repo file claim this?"
 * is the whole question. (The GLOBAL side below still requires a non-empty
 * string, because there the value is used, not just counted.)
 */
function namesKey(env, key) {
  const want = key.toLowerCase()
  return Object.keys(env && typeof env === 'object' ? env : {}).some(
    (k) => k.toLowerCase() === want,
  )
}

/** The value `env` gives `key` in any letter case, or undefined. See namesKey. */
function pickKey(env, key) {
  const want = key.toLowerCase()
  for (const [k, v] of Object.entries(env && typeof env === 'object' ? env : {})) {
    if (k.toLowerCase() === want && typeof v === 'string') return v
  }
  return undefined
}

/** A path deeper than this is pathological — the ancestor walk stops regardless. */
const MAX_ANCESTOR_DEPTH = 64

/** realpathSync, or the input unchanged when it cannot be resolved. */
function realpathOr(p) {
  try {
    return realpathSync(p)
  } catch {
    return p
  }
}

/**
 * Every directory whose `.claude/` could hold a settings file Claude Code
 * merges for a session launched in `cwd`: the cwd itself, and each ancestor up
 * to AND INCLUDING the git root.
 *
 * WHY MORE THAN THE CWD (verified against Claude Code 2.1.231's own bundle,
 * `Cln`/`vet` in the settings loader — this is not inferred from our own code):
 * the two repo-scoped files do NOT resolve from the same directory.
 *   - `projectSettings` (`.claude/settings.json`) resolves at `resolve(cwd)`.
 *   - `localSettings` (`.claude/settings.local.json`) resolves at the
 *     CANONICAL GIT ROOT, falling back to the cwd when there is no git root,
 *     when the root IS the cwd, when the root is the home directory, when the
 *     root fails an owner-uid check, or on a platform with no uid semantics
 *     (that canonicalisation is POSIX-only).
 * `localSettings` is the highest-precedence half of the merge AND the file our
 * own tagger writes (`writeRepoTag` anchors on `resolveRepoRoot` for the same
 * reason), so `claude` launched from `repo/subdir` merges a `settings.local.json`
 * sitting at `repo/` that a cwd-only check never opens.
 *
 * Rather than mirror Claude's per-file rule — which would re-derive an upstream
 * detail that can change under us — inspect the whole cwd→root chain. Checking
 * extra directories is the SAFE direction: the only consequence of a match is
 * that an inherited `TOKENSCOPE_STATE_DIR` is replaced by the global one or
 * dropped, and `stateDir()` then falls back to `~/.tokenscope`.
 *
 * BOUNDED, three ways: it never walks ABOVE the git root, it stops at the
 * filesystem root (`dirname(dir) === dir`), and it stops at MAX_ANCESTOR_DEPTH
 * regardless. With no git root at all (not a work tree) it inspects the cwd
 * alone — outside a repository there is no principled place to stop.
 *
 * Symlinked cwd: the walk runs on the REAL cwd, and `resolveRepoRoot` is given
 * that real path, so both ends are physical and the chain meets. (It used to be
 * git that guaranteed a physical root; `resolveRepoRoot` no longer spawns
 * anything — see its header — so the realpath here is what carries the property.)
 * If the chain still fails to reach the root (a bind mount, an exotic layout),
 * the collected ancestors are discarded and only the three directories whose
 * provenance is certain — the cwd as given, the real cwd, and the root — are
 * inspected.
 *
 * Memoised per resolved cwd: `hookStateDir()` is called from five points in one
 * hook run and each asks for the repo root. A directory's git root cannot change
 * inside the lifetime of this short-lived process, so the cache cannot go stale
 * in production; it is per-process, so nothing outlives the hook. (The memo was
 * originally there to avoid five `git rev-parse` spawns; the spawn is gone, but
 * five filesystem walks are still worth doing once.) Exported for tests.
 */
const REPO_DIRS_CACHE = new Map()

export function repoSettingsDirs(cwd) {
  const asGiven = resolve(cwd)
  const cached = REPO_DIRS_CACHE.get(asGiven)
  if (cached) return cached
  const dirs = computeRepoSettingsDirs(asGiven)
  REPO_DIRS_CACHE.set(asGiven, dirs)
  return dirs
}

function computeRepoSettingsDirs(asGiven) {
  const start = realpathOr(asGiven)
  let root
  try {
    root = resolveRepoRoot(start)
  } catch {
    root = null // resolveRepoRoot threw outright — treat as "no repo": cwd only
  }
  if (!root) return [...new Set([asGiven, start])]
  const rootReal = realpathOr(resolve(root))
  const chain = []
  let dir = start
  for (let i = 0; i < MAX_ANCESTOR_DEPTH; i++) {
    chain.push(dir)
    if (dir === rootReal) return [...new Set([asGiven, ...chain])]
    const parent = dirname(dir)
    if (parent === dir) break // filesystem root, without ever meeting the git root
    dir = parent
  }
  return [...new Set([asGiven, start, rootReal])]
}

/**
 * Does ANY repo-controlled settings file reachable from `cwd` name `key`? The
 * provenance question, asked of the FILES — `process.env` cannot answer it,
 * because Claude Code has already flattened the merge by the time a hook runs.
 */
function repoClaims(cwd, key) {
  return repoSettingsDirs(cwd).some((dir) =>
    REPO_SETTINGS_FILES.some((f) => namesKey(readSettingsEnv(join(dir, '.claude', f)), key)),
  )
}

/**
 * Put `HOME` / `USERPROFILE` back on the passwd entry IF a repo-local settings
 * file named either one. Returns the keys it reset (empty when none was claimed).
 *
 * WHY THIS IS NOT COVERED BY `hookStateDir` OR `safeProcessEnv`. Claude Code
 * applies the repo-local `env` block by REPLACEMENT (`tag-repo.mjs:236-240`), so
 * a repository can set ANY variable in the environment a hook inherits — not
 * only the `TOKENSCOPE_*` / `OTEL_*` keys `REPO_UNTRUSTED_ENV_KEYS` enumerates.
 * `HOME` is the one that matters most, because `os.homedir()` trusts it and
 * `globalSettingsEnv()` resolves `~/.claude/settings.json` through it. A repo
 * that sets BOTH `HOME` and `TOKENSCOPE_STATE_DIR` therefore gets to plant the
 * very file `hookStateDir` treats as the trustworthy value to restore from — and
 * the emit helper then caches its freshly minted access token wherever that
 * planted file says. `safeProcessEnv()` cannot help: it restores the keys it
 * strips FROM `globalSettingsEnv()`, so under a moved `HOME` it hands the
 * emit helper the attacker's endpoints with a live credential attached.
 *
 * WHY THE PASSWD ENTRY, AND NOT THE GLOBAL SETTINGS FILE. The restore-from-global
 * shape used for `TOKENSCOPE_STATE_DIR` is circular here — reading the global
 * file requires already knowing the home. `realHome()` (`real-home.mjs`) is the
 * only source an env var cannot move, and it is already this project's answer
 * wherever a path decides who receives a secret.
 *
 * WHY ONLY WHEN A REPO NAMED IT. A developer whose `HOME` legitimately differs
 * from their passwd home must keep reading THEIR `~/.claude/settings.json` —
 * that is the file Claude Code itself will read, and `plugin-runtime.mjs:129`
 * keeps `~/.claude` on `homedir()` for exactly that reason. A blanket swap to
 * `realHome()` would silently read the wrong settings for that person. Nothing
 * legitimately writes `HOME` into a repository's `.claude/settings*.json`, so
 * acting only on a repo CLAIM fixes the provenance without touching that case.
 *
 * Mutates `process.env` (idempotent) rather than returning a value, because the
 * consumers are `os.homedir()` calls scattered across the modules this hook
 * reaches (`globalSettingsEnv`, `selfHealPluginPaths`, `tag-repo`, `enroll`,
 * `landed-check`, `project-check`) and the environment every child inherits.
 * Key matching is case-folded (see `namesKey`) for the Windows case-insensitive
 * `process.env`; on POSIX a lower-case `home` is a different variable and
 * resetting the real one is harmless.
 */
export function neutraliseRepoHome(cwd = process.cwd()) {
  const claimed = HOME_KEYS.filter((key) => repoClaims(cwd, key))
  if (!claimed.length) return claimed
  const real = realHome()
  for (const key of claimed) process.env[key] = real
  return claimed
}

/**
 * The keys that decide WHICH CODE RUNS in anything this hook spawns — as opposed
 * to `HOME_KEYS`, which decide which FILES it reads.
 *
 * Every one of them is a strictly stronger primitive than the
 * `TOKENSCOPE_STATE_DIR` steering `hookStateDir` exists to stop, against exactly
 * the same attacker. Verified reachable, not theorised: a repository shipping
 * `.claude/settings.json` with an `env` block has that block merged into the
 * environment a hook inherits (captured against Claude Code 2.1.232 —
 * docs/security-sprint/repo-env-inheritance-capture.md, where a repo-set `PATH`
 * removed `node` from the search path and silently killed EVERY node hook on the
 * device, and a repo-set `TOKENSCOPE_STATE_DIR` collected a live emit access
 * token).
 *
 *   - `PATH`        — chooses the `sh`, `curl`, `git`… any child resolves by name.
 *   - `NODE_OPTIONS`— `--require <file>` executes attacker code inside any
 *                     Node child this hook spawns, before its first line runs.
 *   - `BASH_ENV` / `ENV`        — sourced by a non-interactive shell at startup.
 *   - `LD_PRELOAD` / `LD_LIBRARY_PATH` — inject a shared object into any child.
 *   - `NODE_PATH`   — re-points bare `require`/`import` resolution.
 *
 * `safeProcessEnv()` cannot cover these: it enumerates the `TOKENSCOPE_*`/`OTEL_*`
 * keys whose VALUES are credential-bearing, and restores them from the global
 * settings file. These are not restorable that way — nothing legitimately writes
 * `PATH` into `~/.claude/settings.json` — and they steer execution rather than
 * data.
 *
 * SAME PROVENANCE TEST, DIFFERENT REPAIR. Like `neutraliseRepoHome` this acts
 * only when a repo-local settings file NAMES the key, so a developer's own shell
 * `PATH` (the overwhelmingly normal case) is untouched. The repair is:
 *   1. the global settings value, if the device has one — the same "restore from
 *      the file the repository cannot write" trick `hookStateDir` uses; else
 *   2. for `PATH`, a conservative default, because deleting `PATH` outright is
 *      not safe: children resolved by name would fall back to the libc default
 *      (`/bin:/usr/bin`) and a Node installed under nvm/homebrew/`/usr/local`
 *      would vanish — which is the very outage the capture recorded. The
 *      directory holding THIS process's own interpreter is prepended, so `node`
 *      is always findable by the same interpreter that is already running;
 *   3. for everything else, deletion. None of them has a safe default value, and
 *      absent is their normal state.
 *
 * THIS PROTECTS CHILDREN, NOT THIS PROCESS. Said explicitly because the
 * function name invites the opposite reading: by the time any of this runs, node
 * has already started, so a repo-set `NODE_OPTIONS=--require` has ALREADY
 * executed its module and a repo-set `PATH` already chose which `node` we are.
 * Nothing running inside the compromised process can undo that. What the repair
 * buys is that everything spawned FROM here — the emit helper, `git` —
 * inherits a repaired environment instead of the hostile one.
 * Closing the startup half needs the hook to be launched through a trusted
 * interpreter with an allowlisted environment, which is not ours to change: the
 * hook command lives in `hooks.json` and Claude Code expands and spawns it.
 *
 * NOT a claim that the whole class is closed, either. A repository can set
 * variables beyond this list, and the list is a denylist. It is here because
 * these are the keys that turn a data-steering bug into code execution; the
 * structural answer (build credential-bearing child environments from an
 * allowlist rather than from `process.env`) is a larger change and is recorded
 * as such in docs/security-sprint/owner-decisions.md §0.
 */
const EXEC_STEERING_KEYS = [
  'PATH',
  'NODE_OPTIONS',
  'BASH_ENV',
  'ENV',
  'LD_PRELOAD',
  'LD_LIBRARY_PATH',
  'NODE_PATH',
]

/**
 * A `PATH` that is safe to fall back to when a repository claimed the real one
 * and the global settings file offers no replacement.
 *
 * `dirname(process.execPath)` first, so the Node already executing this hook can
 * always be found by name by the children it spawns — that is the one entry we
 * can be certain about, because it is where we ourselves came from.
 */
function fallbackPath() {
  const own = dirname(process.execPath)
  const base = ['/usr/local/bin', '/usr/bin', '/bin', '/usr/local/sbin', '/usr/sbin', '/sbin']
  return [own, ...base.filter((p) => p !== own)].join(':')
}

/**
 * Put the execution-steering keys back on a value a repository did not choose,
 * IF a repo-local settings file named them. Returns the keys it repaired.
 *
 * Mutates `process.env` (idempotent) rather than returning an env object,
 * because the consumers are `spawn`/`spawnSync` calls in modules this hook only
 * reaches indirectly, plus every child's inherited environment. See
 * EXEC_STEERING_KEYS for why each key is on the list and what the repair is.
 */
export function neutraliseRepoExecEnv(cwd = process.cwd()) {
  const claimed = EXEC_STEERING_KEYS.filter((key) => repoClaims(cwd, key))
  if (!claimed.length) return claimed
  const global = globalSettingsEnv()
  for (const key of claimed) {
    const fromGlobal = pickKey(global, key)
    if (typeof fromGlobal === 'string' && fromGlobal.trim()) process.env[key] = fromGlobal
    else if (key === 'PATH') process.env.PATH = fallbackPath()
    else delete process.env[key]
  }
  return claimed
}

/**
 * The state dir this hook uses, with a REPO-SUPPLIED `TOKENSCOPE_STATE_DIR` —
 * and a repo-supplied `HOME`, which would otherwise choose the "trusted" file
 * the restore below reads (neutraliseRepoHome) — neutralised first. Every
 * state-dir read in this hook goes through this, and anything we spawn is
 * pinned to its result.
 *
 * `stateDir()` resolves `TOKENSCOPE_STATE_DIR` from `process.env` deliberately
 * (plugin-runtime.mjs) — that is right for a genuine process-level pin (a shell
 * export, a container/deployment config, a test sandbox). But a hook inherits
 * the environment Claude Code assembled from the merged settings, and the
 * repo-local block is the highest-precedence half of that merge (applied by
 * REPLACEMENT — the fact `tag-repo.mjs:236-240` builds the whole self-contained
 * repo env copy around), so that one variable can also be repo-supplied. The
 * state dir is where `otel-headers-helper.sh` caches the freshly minted emit
 * ACCESS TOKEN (`oauth-access.<tool>.json`) — credential-bearing, so a repository must not
 * get to choose it.
 *
 * `safeProcessEnv()` cannot settle this one: it strips the key from a COPY,
 * while `stateDir()` reads the live `process.env`, and it has no way to tell a
 * repo-supplied value from the developer's own once the merge has flattened the
 * two. The settings FILES still carry that provenance, so read them: if a
 * repo-local settings file names `TOKENSCOPE_STATE_DIR` at all, the inherited
 * value is not trustworthy — replace it with the GLOBAL settings value when
 * there is one, else remove it so `stateDir()` falls back to `~/.tokenscope`
 * anchored on the passwd home. A repo that says nothing about the key leaves a
 * genuine process-level pin exactly as it was.
 *
 * WHICH files: every `.claude/settings*.json` from the cwd up to and including
 * the GIT ROOT — see repoSettingsDirs. A cwd-only check missed the git-root
 * `settings.local.json`, which is exactly the file Claude Code resolves from
 * the git root and the one our own tagger writes there, so `claude` launched
 * from a subdirectory left a hostile claim undetected. Key matching is
 * case-folded (namesKey) for the Windows case-insensitive `process.env`.
 *
 * Deliberately conservative in one case: if a repo names the key we drop the
 * inherited value even when the developer's shell also exported one, because
 * the merge makes those two indistinguishable in `process.env` and nothing
 * legitimately writes `TOKENSCOPE_STATE_DIR` to a repo settings file.
 *
 * Mutates `process.env` (idempotent) rather than only returning a value,
 * because consumers we do not call directly — `stateDir()` inside
 * `readEmitSentinel` — resolve the dir by that same
 * live read.
 */
export function hookStateDir(cwd = process.cwd()) {
  // FIRST — the global settings file is what the restore below trusts, and a
  // repo-claimed HOME would choose which file that is. See neutraliseRepoHome.
  //
  // This ordering was itself the F34 finding: neutraliseRepoHome asks
  // `resolveRepoRoot` which directory the repo is, and that used to spawn `git`
  // — through a PATH the repo could set, seven lines before the repair that
  // strips it. The order could not simply be flipped (the exec repair reads the
  // global settings file, so the HOME repair must precede it, and BOTH ask for
  // the repo root). It is safe now because `resolveRepoRoot` spawns NOTHING:
  // there is no exec on this path to steer. Keep it that way — a subprocess
  // added anywhere under these two calls is executing with the repo's env.
  neutraliseRepoHome(cwd)
  // Then the keys that decide which CODE runs in anything spawned from here.
  // Ordered after the HOME repair because this one also reads the global
  // settings file, and under a repo-claimed HOME that would be the repository's
  // own planted copy. Riding on hookStateDir rather than sitting beside it in
  // main() for the reason emissionHealthWarning documents: these functions are
  // exported, so the guarantee must not depend on call order.
  neutraliseRepoExecEnv(cwd)
  const claimedByRepo = repoClaims(cwd, STATE_DIR_KEY)
  if (claimedByRepo) {
    const fromGlobal = pickKey(globalSettingsEnv(), STATE_DIR_KEY)
    if (typeof fromGlobal === 'string' && fromGlobal.trim()) process.env.TOKENSCOPE_STATE_DIR = fromGlobal
    else delete process.env.TOKENSCOPE_STATE_DIR
  }
  return stateDir()
}

/**
 * Job 0: repoint OUR version-pinned GLOBAL settings paths (statusLine.command,
 * otelHeadersHelper) to the ACTIVE plugin version. `/plugin update` leaves them
 * pinned at the version they were written, so an old renderer (cosmetic) or — far
 * worse — a stale bearer-minting helper (emission dies if that cache version is
 * GC'd) lingers. Change-detecting + atomic; fail-OPEN. The new paths take effect
 * on the NEXT launch (Claude reads these at startup), so this self-heals within
 * one relaunch of any update. Idempotent once reconciled.
 */
export function selfHealPluginPaths({
  settingsPath = join(homedir(), '.claude', 'settings.json'),
  scriptsDir = resolve(HOOK_DIR, '..', 'scripts'),
} = {}) {
  if (!existsSync(settingsPath)) return
  // casWriteFile: re-derived from the CURRENT bytes on each attempt, so a stale
  // snapshot can never roll back a rotated refresh token.
  casWriteFile(settingsPath, (raw) => {
    if (raw === null) return null
    let settings
    try {
      settings = JSON.parse(raw)
    } catch {
      return null // unparseable — NEVER clobber (would wipe the emit credential)
    }
    // Only ever repoint to a target that actually exists — never create a phantom path.
    const statuslinePath = join(scriptsDir, 'statusline.mjs')
    const helperPath = join(scriptsDir, 'otel-headers-helper.sh')
    const { settings: next, changed } = reconcilePluginPaths(settings, {
      statuslinePath: existsSync(statuslinePath) ? statuslinePath : null,
      helperPath: existsSync(helperPath) ? helperPath : null,
    })
    if (!changed) return null
    return `${JSON.stringify(next, null, 2)}\n`
  })
}

/**
 * Job 1: reconcile the repo-local tag from the current global enrolment.
 *
 * Returns writeRepoTag's `{ settingsPath, changed, healed, instanceDrifted }`, or
 * undefined when there was nothing to reconcile (device not enrolled, no
 * `.tokenscope`, or the resolved code did not come from one). Callers must treat
 * an absent result as "no drift".
 */
function selfHealRepoTag() {
  const cwd = process.cwd()
  const enrolment = readGlobalEnrolment()
  if (!enrolment) return // device not enrolled — nothing to do

  let resolved
  try {
    resolved = resolveRepoProjectCode({ arg: '', cwd }) // .tokenscope only in hook context
  } catch {
    return // no .tokenscope / no project.code — leave untagged
  }
  if (resolved.source !== 'tokenscope') return

  const codeHash = computeCodeHash(resolved.code)
  // SELF-HEAL (ADR-0006): always re-derive from the CURRENT global enrolment.
  // writeRepoTag is change-detecting, so a true no-op leaves the file untouched.
  // The result is RETURNED, not discarded: when it reports `instanceDrifted` this
  // very session is emitting under the superseded instance (see the job-1 note at
  // the top of this file — resource attrs froze at startup, before this write), and
  // main() turns that into the one warning that tells the developer to relaunch.
  return writeRepoTag({ cwd, enrolment, codeHash })
}

/**
 * PURE: the warning shown when the repo tag we just reconciled had pinned a
 * DIFFERENT instance than the device's current enrolment.
 *
 * THE INVARIANT: a session whose repo pin named a different instance than the
 * device's current enrolment is misattributing for its whole life, and must be
 * told so. Job 1 above can only fix the FILE (resource attrs froze at startup),
 * so the running session's only remedy is a relaunch.
 *
 * Deliberately NOT gated on `healed`: that is also true for a helper-path move,
 * which does not change which instance records land against.
 *
 * Full incident timeline (2026-09-01 dogfood) in ADR-0006 decision 3 — kept there
 * rather than restated here, so the two cannot drift apart.
 *
 * Exported for tests. Returns a string, or null when there is nothing to say.
 */
export function staleInstancePinWarning(repoTagResult) {
  if (!repoTagResult || repoTagResult.instanceDrifted !== true) return null
  return [
    'TokenScope: this session is emitting under a SUPERSEDED device enrolment.',
    "This repo's .claude/settings.local.json pinned an older tokenscope.instance_id;",
    'it has just been reconciled, but OTel resource attributes are frozen at process',
    'start, so THIS session keeps emitting under the old instance and its usage will',
    'not appear against this device. Restart `claude` to pick up the current enrolment.',
  ].join(' ')
}

/** PURE: the warning shown when the repo tag refused a git-tracked target. */
export function trackedRepoTagWarning(repoTagResult) {
  if (!repoTagResult || repoTagResult.trackedRefused !== true) return null
  return [
    "TokenScope: this repo's .claude/settings.local.json is tracked by git, so the",
    'project tag was NOT written to it (it would be published on your next commit).',
    "To tag this repo's spend, untrack it (`git rm --cached .claude/settings.local.json`);",
    'the next session start writes the tag, and sessions launched after that carry it.',
  ].join(' ')
}

/** HTTP status from a sentinel, or null. */
function sentinelHttp(sentinel) {
  return sentinel && Number.isFinite(sentinel.http_status) ? sentinel.http_status : null
}

function warnFor(http) {
  // Classify like status.mjs's interpretEmissionProbe: an auth failure (401/403/
  // 404) means the emit credential lapsed or the instance is unknown — re-provision
  // it; a 5xx/other is likely a transient server-side issue, so do NOT steer the
  // developer to churn their instance id over a blip.
  if (http === 401 || http === 403 || http === 404) {
    return `⚠ TokenScope: your Claude telemetry is NOT emitting — emission auth failed (HTTP ${http}). Spend is going untracked this session. Run /tokenscope:status; the credential likely lapsed or the instance is unknown — re-provision emit via the tokenscope-setup MCP prompt.`
  }
  return `⚠ TokenScope: your Claude telemetry may not be emitting (HTTP ${http}) — likely a transient server-side issue. Run /tokenscope:status to confirm; spend may be going untracked this session.`
}

/**
 * Job 2: decide whether to warn. Returns a warning string, or null (healthy,
 * not-enrolled, throttled-healthy, or only transiently unverifiable).
 */
function emissionHealthWarning() {
  const cwd = process.cwd()
  // BEFORE the "global" read below: hookStateDir also puts a repo-claimed HOME
  // back on the passwd entry (neutraliseRepoHome), and repoAwareEnv resolves
  // ~/.claude/settings.json through HOME — so under a repo-supplied one that
  // read would open a file the repository planted and every value below would
  // be attacker-chosen. main() already ran this; doing it here too means the
  // guarantee does not depend on call order (this function is exported).
  const dir = hookStateDir(cwd)
  // The env the NEXT launch will use: global device env with ONLY the repo's
  // OTEL_RESOURCE_ATTRIBUTES overlaid (repoAwareEnv / repoTagEnv — S1 fix 1).
  const env = repoAwareEnv(cwd)
  const endpoint = (env.TOKENSCOPE_BEARER_ENDPOINT ?? '').trim()
  const hasOAuth = Boolean(
    (env.TOKENSCOPE_OAUTH_REFRESH_TOKEN ?? '').trim() &&
      (env.TOKENSCOPE_OAUTH_TOKEN_ENDPOINT ?? '').trim() &&
      (env.TOKENSCOPE_OAUTH_CLIENT_ID ?? '').trim(),
  )
  if (!endpoint || !hasOAuth) return null // not enrolled — don't nag

  // Run the REAL emit path once (bounded). We do NOT short-circuit on a
  // pre-existing sentinel: it can be STALE — a superseded-cache 401 the helper now
  // self-heals on retry (0.1.6), or a since-resolved failure — so trusting it
  // would cry wolf. The helper IS the live, self-healing source of truth; run it.
  //
  // The helper MINTS a credential and caches it under its state dir, so the env
  // it runs under is credential-steering input, not merely context. The BASE is
  // safeProcessEnv(), not raw `process.env`: Claude Code merged the repo's
  // settings `env` into the environment this hook inherited, and `env` above is
  // an OVERLAY — it can only outvote a base key it actually holds. The global
  // settings file has no writer for TOKENSCOPE_STATE_DIR, so on a normal device
  // the overlay does not hold it and a repo-supplied one survived the spread,
  // dropping the freshly minted access token inside the repository's own tree.
  // The state dir is then pinned to the one this hook resolved, so the helper
  // writes its cache and failure sentinel exactly where readEmitSentinel() below
  // looks for them. (`dir` was resolved at the top of this function — it has to
  // be, because the same call is what un-poisons HOME for the reads above.)
  // `stateDir` is passed as an ARGUMENT, not left to the env key: the helper no
  // longer reads TOKENSCOPE_STATE_DIR at all, because Claude Code invokes it
  // directly (every ~29 min, to mint the bearer) with an environment that
  // carries the repository's merged settings — a process no hook can repair.
  // The env key is kept alongside only for the JS-side readers further down that
  // still resolve through `stateDir()`.
  const { ran, status } = runEmitHelper({
    env: { ...safeProcessEnv(), ...env, TOKENSCOPE_STATE_DIR: dir },
    stateDir: dir,
    timeoutMs: PROBE_TIMEOUT_MS,
  })
  if (!ran) return null
  // Exit 0 = healthy (the helper only exits 0 via the /bearer-200 path, which mints
  // a bearer + clears the sentinel). A null exit = killed (timeout) before
  // completing → couldn't verify. BOTH stay silent, and crucially we do NOT read
  // the sentinel in either case — so a STALE sentinel (a prior or since-resolved
  // failure) can never cry wolf. Only a genuine NON-ZERO exit code means the helper
  // ran and failed THIS run, writing a fresh sentinel (adversarial R: MEDIUM-1).
  if (status === 0 || status === null) return null
  // Live failure (even after the helper's in-run retry). Warn only on a DEFINITE
  // auth failure (http > 0); a network error (fresh sentinel http 0) stays SILENT.
  const http = sentinelHttp(readEmitSentinel(env))
  if (http && http !== 0) return warnFor(http)
  return null
}

/**
 * Build the wrong-env project-tag warning from a checkRepoProjectBillable result,
 * or null. Warns ONLY on an explicit 'not-billable' (the firewall already made
 * every other status silent). Hedges on point-in-time membership (names the env,
 * doesn't assert a permanent misconfig) so it never cries wolf during membership
 * propagation, and points at the re-tag action.
 */
function projectBillabilityWarning(result) {
  if (!result || result.status !== 'not-billable') return null
  const code = result.code ? `“${result.code}”` : "this repo’s .tokenscope project"
  const projects = (result.yourProjects || []).map((p) => p && p.code).filter(Boolean)
  const hint = projects.length ? ` Budgets you can bill: ${projects.join(', ')}.` : ''
  return `⚠ TokenScope: ${code} is not a budget you can currently bill on this environment — spend this session is landing UNTAGGED. Re-tag with the project MCP prompt (/tokenscope:project).${hint}`
}

/**
 * ONE-RELEASE MIGRATION — delete in the release after Claude plugin 0.1.41.
 * 0.1.41 removed the local OTLP forwarder (the CLI 2.1.191-2.1.211 chunked-export
 * workaround). A device whose USER-LEVEL logs endpoint still points at it would send
 * telemetry, emit bearer attached, to a local port nothing will own after a reboot.
 * Restore the real endpoint from the copy the forwarder kept (the settings env, else
 * its state-dir stash) and drop both copies; with neither, warn to re-run setup. A
 * tagged repo whose own file still names the forwarder is rewritten by the repo tag,
 * which only takes effect next launch, so that gets the relaunch note too. The
 * forwarder's leftover files, and a stale copy on an already-direct device, are
 * removed. Returns a message string or null.
 */
export function migrateOffForwarderEndpoint({
  settingsPath = join(homedir(), '.claude', 'settings.json'),
  dir = hookStateDir(),
  repoSettingsPath = null,
} = {}) {
  const port = String(Number(process.env.TOKENSCOPE_OTLP_PROXY_PORT) || 14318)
  const forwarderUrl = (v) => {
    try {
      // The only URL the forwarder ever wrote; a user's own local collector is left alone.
      const u = new URL(String(v ?? ''))
      return u.protocol === 'http:' && u.hostname === '127.0.0.1' && u.port === port && u.pathname === '/v1/logs'
    } catch {
      return false
    }
  }
  const realDce = (v) => {
    const t = typeof v === 'string' ? v.trim() : ''
    try {
      return t && !isLoopbackHostname(assertSafeEndpoint(t, { allowLoopback: false }).hostname) ? t : null
    } catch {
      return null
    }
  }
  const endpointOf = (path) => {
    try {
      return JSON.parse(readFileSync(path, 'utf8'))?.env ?? null
    } catch {
      return null
    }
  }
  const relaunch =
    'ℹ TokenScope: moved your Claude telemetry off the removed local OTLP forwarder. Restart `claude` so new sessions send directly (this one keeps the old address until it exits).'
  const stashPath = join(dir, 'otlp-forward.json')
  const dropLeftovers = () => {
    for (const f of ['otlp-forward.json', 'otlp-forwarder.pid', 'otlp-forwarder.log']) {
      try {
        rmSync(join(dir, f), { force: true })
      } catch {
        /* best-effort */
      }
    }
  }
  const repoPinned = repoSettingsPath ? forwarderUrl(endpointOf(repoSettingsPath)?.OTEL_EXPORTER_OTLP_LOGS_ENDPOINT) : false
  const env = endpointOf(settingsPath)
  if (!env) return repoPinned ? relaunch : null
  const before = env.OTEL_EXPORTER_OTLP_LOGS_ENDPOINT
  if (!forwarderUrl(before)) {
    // Already direct: clear what the forwarder left behind, then only the repo pin matters.
    dropLeftovers()
    if ('TOKENSCOPE_DCE_LOGS_ENDPOINT' in env) {
      casWriteFile(settingsPath, (raw) => {
        try {
          const s = JSON.parse(raw)
          if (!s?.env || !('TOKENSCOPE_DCE_LOGS_ENDPOINT' in s.env) || forwarderUrl(s.env.OTEL_EXPORTER_OTLP_LOGS_ENDPOINT)) return null
          const next = { ...s.env }
          delete next.TOKENSCOPE_DCE_LOGS_ENDPOINT
          return `${JSON.stringify({ ...s, env: next }, null, 2)}\n`
        } catch {
          return null // never clobber a file we cannot read back
        }
      })
    }
    return repoPinned ? relaunch : null
  }
  let stashed = null
  try {
    stashed = JSON.parse(readFileSync(stashPath, 'utf8')).dceLogsEndpoint
  } catch {
    /* no stash */
  }
  const result = casWriteFile(settingsPath, (raw) => {
    let s
    try {
      s = JSON.parse(raw)
    } catch {
      return null // never clobber a file we cannot read back
    }
    if (s?.env?.OTEL_EXPORTER_OTLP_LOGS_ENDPOINT !== before) return null
    const real = realDce(s.env.TOKENSCOPE_DCE_LOGS_ENDPOINT) ?? realDce(stashed)
    if (!real) return null
    const next = { ...s.env, OTEL_EXPORTER_OTLP_LOGS_ENDPOINT: real }
    delete next.TOKENSCOPE_DCE_LOGS_ENDPOINT
    return `${JSON.stringify({ ...s, env: next }, null, 2)}\n`
  })
  // Judge by the file, not the attempt: a lost compare-and-swap is not a restore, and
  // another session may have restored it meanwhile.
  if (result?.changed || !forwarderUrl(endpointOf(settingsPath)?.OTEL_EXPORTER_OTLP_LOGS_ENDPOINT)) {
    dropLeftovers()
    return relaunch
  }
  return '⚠ TokenScope: your Claude telemetry endpoint still points at the removed local OTLP forwarder and the real endpoint cannot be recovered, so telemetry will not be delivered once the old forwarder stops. Re-run /tokenscope:setup to restore it.'
}

async function main() {
  // FIRST: neutralise a repo-supplied TOKENSCOPE_STATE_DIR — and a repo-supplied
  // HOME — on this process's env, before anything resolves a state dir or opens
  // the global settings file. The jobs below reach modules that call
  // `stateDir()` and `homedir()` themselves — selfHealPluginPaths/tag-repo/enroll open
  // `~/.claude/settings.json` — and those reads are of the live `process.env`,
  // so this one call is what keeps them off a path the repository chose.
  try {
    // It holds the emit access-token cache and failure sentinels: owner-only, every
    // session (mkdirSync's mode is ignored on a directory that already exists).
    const dir = hookStateDir()
    if (existsSync(dir)) chmodSync(dir, 0o700)
  } catch {
    /* fail-open */
  }

  try {
    // Legacy enrolments stored a credential but no endpoint; copy the endpoints
    // across from the device's OWN settings so the helper's refuse-to-pair rule
    // never becomes an outage. Trusted source only — see migrateStoredEndpoints.
    migrateStoredEndpoints()
    selfHealPluginPaths()
  } catch {
    /* fail-open */
  }

  // One-release migration off the removed OTLP forwarder (see the function).
  let forwarderWarning = null
  try {
    const root = resolveRepoRoot(process.cwd())
    forwarderWarning = migrateOffForwarderEndpoint({ repoSettingsPath: root ? join(root, '.claude', 'settings.local.json') : null })
  } catch {
    /* fail-open */
  }

  // Captured, not discarded: `instanceDrifted` is the only in-process evidence
  // that THIS session's frozen resource attrs name a superseded instance.
  let repoTagResult = null
  try {
    repoTagResult = selfHealRepoTag()
  } catch {
    /* fail-open */
  }

  // EMIT-ON-INSTALL (slice 6): on a FRESH install of the real (publish-injected)
  // plugin, enrol now — BEFORE the emit probe + landed refresh below — so this very
  // session starts emitting with no login. A no-op when already enrolled or when no
  // bundled secret is configured (dev). Writes the credential into settings.json,
  // which the probe + landed refresh then re-read from disk and exercise. Fail-open.
  try {
    const cwd = process.cwd()
    const env = repoAwareEnv(cwd)
    await enrollIfNeeded({ env })
  } catch {
    /* fail-open: never break session start over enrolment */
  }

  // Collect session-start warnings into ONE systemMessage: (1) a superseded
  // instance pin, (2) emission health and (3) a wrong-env project tag (the repo's
  // .tokenscope isn't billable where the device emits → spend spills untagged).
  // All fail-open — our own errors never warn.
  const lines = []
  // FIRST: a superseded instance pin outranks the rest. Emit auth can be perfectly
  // healthy while every record lands against an instance this device no longer
  // claims, so this must not sit below a green-looking emission check.
  try {
    const w = staleInstancePinWarning(repoTagResult)
    if (w) lines.push(w)
  } catch {
    /* fail-open: never warn on our own error */
  }
  try {
    const w = trackedRepoTagWarning(repoTagResult)
    if (w) lines.push(w)
  } catch {
    /* fail-open: never warn on our own error */
  }

  if (forwarderWarning) lines.push(forwarderWarning)

  try {
    const w = emissionHealthWarning() // also runs the emit helper → refreshes the token
    if (w) lines.push(w)
  } catch {
    /* fail-open: never warn on our own error */
  }

  // With the emit token now fresh, refresh the landed cache (for the statusline's
  // real green `✓ landed`) AND check project billability CONCURRENTLY — both bounded,
  // best-effort, under the same merged env. project-check warns ONLY on an explicit
  // not-billable; every other path (offline, unauth, no-tag, errors) is silent.
  let projectWarning = null
  try {
    const cwd = process.cwd()
    const env = repoAwareEnv(cwd)
    const hasBearer = Boolean((env.TOKENSCOPE_BEARER_ENDPOINT ?? '').trim())
    const [, projectResult] = await Promise.all([
      hasBearer ? refreshLanded({ env }).catch(() => null) : Promise.resolve(null),
      hasBearer ? checkRepoProjectBillable({ env, cwd }).catch(() => null) : Promise.resolve(null),
    ])
    projectWarning = projectBillabilityWarning(projectResult)
  } catch {
    /* fail-open — the statusline simply stays ◎ emit-auth */
  }

  const output = buildHookOutput(lines, projectWarning)
  if (output) process.stdout.write(JSON.stringify(output))
}

/**
 * Compose the hook's stdout payload from the collected warning `lines` and
 * the (possibly null) `projectWarning`. Pure + exported for tests. Returns
 * null when there is nothing to say at all.
 *
 * S1 fix 5: `additionalContext` carries ONLY `lines`, NEVER `projectWarning`.
 * projectWarning interpolates the repo's OWN `.tokenscope`-declared code — an
 * ATTACKER-CONTROLLED string in a hostile repo — and `additionalContext`
 * reaches the MODEL's context, not just the developer. The SessionStart
 * `systemMessage` (which DOES carry projectWarning) already reaches the
 * developer, which is the actual requirement; the model does not need it, so
 * it is omitted entirely rather than sanitised (the charset validation on
 * `code` in tokenscope-project.mjs is the parse-boundary defence; this is the
 * render-boundary one — belt and suspenders, not a substitute).
 */
export function buildHookOutput(lines, projectWarning) {
  const allLines = projectWarning ? [...lines, projectWarning] : lines
  if (!allLines.length) return null
  const output = { systemMessage: allLines.join('\n\n') }
  if (lines.length) {
    output.hookSpecificOutput = {
      hookEventName: 'SessionStart',
      additionalContext: `TokenScope session-start checks: ${lines.join('\n\n')}`,
    }
  }
  return output
}

// Exported for unit tests (the pure-ish warning helpers).
export { emissionHealthWarning, warnFor, sentinelHttp, projectBillabilityWarning }

// CLI entry guard: run the hook ONLY when invoked as the entry script (Claude's
// SessionStart). Importing the module (unit tests) must NOT run main / exit.
const isMain = process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]
if (isMain) {
  // AWAIT the full async chain before exiting: emit-on-install enrol POST + the
  // landed refresh are async, and a fresh install must finish enrolling (and then
  // probe/refresh against the new credential) within this one session. The hook's
  // own 10s timeout bounds it. Fail-open — any rejection still exits 0.
  main()
    .catch(() => {
      /* Fail-open: never break the session. */
    })
    .finally(() => process.exit(0))
}
