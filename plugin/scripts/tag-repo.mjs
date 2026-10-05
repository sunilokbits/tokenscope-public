/*
 * tag-repo — shared helpers for the PER-REPO tagging path ("B′" model),
 * used by both the project MCP prompt (explicit) and the SessionStart hook
 * (zero-touch). All purely LOCAL: no server call, no cookie.
 *
 * Resolving the project CODE comes from the repo's committed `.tokenscope`
 * (or an explicit arg). The CODE -> code_hash mapping is computed client-side
 * with sha256 (plain hex) to match the server's project.code_hash exactly
 * (server: createHash('sha256').update(code).digest('hex')).
 */
import {
  writeFileSync,
  readFileSync,
  existsSync,
  mkdirSync,
  chmodSync,
  renameSync,
  unlinkSync,
  lstatSync,
} from 'node:fs'
import { join, dirname, resolve } from 'node:path'
import { randomBytes } from 'node:crypto'
import { homedir } from 'node:os'
import { fileURLToPath } from 'node:url'
import { parseTokenscope } from './tokenscope-reader.mjs'
import { buildRepoResourceAttrs, mergeClaudeSettings, readDeviceEnrolment } from './env-builder.mjs'
import { withinOwnInstall } from './plugin-runtime.mjs'
// The single .gitignore-hygiene helper, shared with the Copilot forwarder.
// Import is side-effect-free (that module main()-guards) and tag-repo.mjs is not
// vendored into the standalone Copilot distribution — see ensureRepoTagGitignored.
import { ensureGitignored, isGitTracked } from './copilot-forwarder.mjs'

// The client-neutral resolver/hasher (computeCodeHash, resolveRepoProjectCode)
// was extracted into the syncable tokenscope-project.mjs (P0-2) so the Copilot
// forwarder can reuse the SAME derivation — Claude + Copilot MUST hash an
// identical `.tokenscope` to the same project.code_hash (drift = split
// attribution). Re-exported here so the long-standing Claude-side import surface
// (project-check.mjs, the SessionStart hook, the unit tests) is unchanged. The
// Claude-coupled helpers below (writeTokenscopeFile/writeRepoTag) stay here.
export { computeCodeHash, resolveRepoProjectCode } from './tokenscope-project.mjs'

/**
 * Write (create or update) ./.tokenscope so the project tag is committable and
 * travels with the repo. Sets project.code = `code`, preserving any existing
 * project.id/name + optional.* fields. Returns the path. This is what lets
 * the project MCP prompt be a single step (write the file + tag) instead
 * of asking the user to hand-author the YAML first.
 */
export function writeTokenscopeFile(cwd, code) {
  // The code must round-trip through tokenscope-reader: `#` is stripped as a
  // comment, `"` collides with the value quoting, and newlines split lines —
  // any of these would make a later (no-arg) read derive a DIFFERENT
  // project.code_hash than the one we tag with now, silently splitting the
  // repo's spend server-side. Reject them at write time with a clear error.
  if (!code || !String(code).trim()) {
    throw new Error(
      'Project code is empty — pass the canonical project code (e.g. TokenScope-MVP) via the project MCP prompt or a committed .tokenscope.',
    )
  }
  if (/[#"\r\n]/.test(code)) {
    throw new Error(
      `Project code ${JSON.stringify(code)} contains a character that does not round-trip in .tokenscope (#, ", or newline). Use the canonical project code.`,
    )
  }
  // Leading/trailing whitespace is stripped by the reader, so it would also
  // make a later read derive a different hash. The slash command trims its arg
  // already; this guards the exported function for any other caller.
  if (code !== String(code).trim()) {
    throw new Error(
      `Project code ${JSON.stringify(code)} has leading/trailing whitespace — trim it to the canonical code.`,
    )
  }
  const path = join(cwd, '.tokenscope')
  let project = { code }
  let optional = {}
  if (existsSync(path)) {
    try {
      const parsed = parseTokenscope(path)
      project = { ...(parsed?.project ?? {}), code } // keep id/name, override code
      optional = parsed?.optional ?? {}
    } catch {
      /* unparseable — fall back to a minimal file */
    }
  }
  const lines = ['# TokenScope — commit this so the project tag travels with the repo.', 'project:']
  for (const [k, v] of Object.entries(project)) {
    if (v != null && v !== '') lines.push(`  ${k}: ${v}`)
  }
  // parseTokenscope reads optional fields (client/practice/...) at TOP LEVEL,
  // not nested under an `optional:` key — emit them that way so the file
  // round-trips through the reader.
  for (const [k, v] of Object.entries(optional)) {
    if (v != null && v !== '') lines.push(`${k}: ${v}`)
  }
  writeFileSync(path, lines.join('\n') + '\n', { encoding: 'utf8' })
  return path
}

/** Abs path to the GLOBAL ~/.claude/settings.json. */
export function globalSettingsPath() {
  return join(homedir(), '.claude', 'settings.json')
}

/**
 * Read the device enrolment (session id + helper path) from the GLOBAL config.
 * Returns { sessionId, helperPath } or null if not enrolled / unreadable.
 */
export function readGlobalEnrolment() {
  const path = globalSettingsPath()
  if (!existsSync(path)) return null
  let settings
  try {
    settings = JSON.parse(readFileSync(path, 'utf8'))
  } catch {
    return null
  }
  return readDeviceEnrolment(settings)
}

// resolveRepoProjectCode moved to tokenscope-project.mjs (P0-2) and re-exported
// at the top of this file — see the export statement near the imports.

/**
 * Abs path to the otel-headers-helper.sh the repo pin should use.
 *
 * Prefer the CURRENTLY-ACTIVE plugin version: Claude sets CLAUDE_PLUGIN_ROOT to
 * the live plugin dir when the hook/command runs, so
 * $CLAUDE_PLUGIN_ROOT/scripts/otel-headers-helper.sh is the active version's
 * helper. Writing THAT into the repo pin is what lets a plain `/plugin update`
 * auto-apply to every tagged repo on its NEXT launch WITHOUT a re-enrol (closes
 * ADR-0006's version-pinned-helper future-work): the self-heal re-points the repo
 * at the new active version each launch. Old cache versions persist (verified
 * across 0.1.0-0.1.3 on 2026-06-06; NOT a guaranteed Claude-internal behavior), so
 * the one-launch lag inherent to the startup-frozen OTel env does not break emit in
 * practice. If a future Claude release prunes old versions on update, that lag
 * could break a running session until relaunch — ADR-0006's stable `current`
 * symlink would remove the dependency entirely. Re-enrol then drops to genuinely
 * rare events (revocation, the read-credential migration) rather than every upgrade.
 *
 * Fall back to the version-pinned path from the global enrolment (when
 * CLAUDE_PLUGIN_ROOT is unset OR its helper is missing — e.g. a partial install),
 * then to this module's own dir, so every context still resolves to a real helper.
 */
/*
 * CONFINEMENT. CLAUDE_PLUGIN_ROOT chooses which otel-headers-helper.sh we
 * persist, and Claude Code executes it every ~29 minutes with a live emit
 * credential. Accept it ONLY when it resolves inside our own install; a newer
 * sibling version stays acceptable (that is the deliberate upgrade follow),
 * anything else falls back to the pinned enrolment path and then to this
 * module's own directory.
 *
 * Claude Code appears to protect this variable already, but that guarantee is
 * ITS to change, so do not depend on it here.
 * See docs/security-sprint/epic-mdash-remediation.md (Wave 1, §2.6).
 */
function resolveHelperPath(enrolment) {
  const active = process.env.CLAUDE_PLUGIN_ROOT
    ? join(process.env.CLAUDE_PLUGIN_ROOT, 'scripts', 'otel-headers-helper.sh')
    : null
  if (active && existsSync(active) && withinOwnInstall(active)) return active
  // The pinned enrolment path gets the SAME confinement. It comes from the
  // global settings file, which a repo-moved HOME (or a poisoned settings file)
  // can choose — so accepting it unchecked was a bypass sitting one line below
  // the check it bypassed.
  const pinned = enrolment?.helperPath
  if (pinned && existsSync(pinned) && withinOwnInstall(pinned)) return pinned
  return join(dirname(fileURLToPath(import.meta.url)), 'otel-headers-helper.sh')
}

/**
 * S1 fix (4c) — resolve the git repository ROOT for `cwd`. writeRepoTag used
 * to write `<cwd>/.claude/settings.local.json` with no root check at all, so
 * running any plugin script from a SUBDIRECTORY planted a fresh
 * device-config artefact there — deleting the one at the repo root
 * (or anywhere else) just made it come back on the next launch that happened
 * to run from that subdirectory.
 *
 * `git rev-parse --show-toplevel` first (handles a git WORKTREE, where `.git`
 * is a FILE pointing elsewhere, not a dir); falls back to walking up for the
 * nearest ancestor containing a `.git` entry (dir or file — `existsSync`
 * doesn't care which) when git itself is unavailable or the call fails (not a
 * repo, no `git` on PATH). Returns null when NEITHER resolves — the caller
 * refuses to write rather than guess a directory.
 *
 * EXPORTED (S16c follow-up) because "which directory is the repository?" must
 * have exactly ONE answer in this plugin: the SessionStart hook asks the same
 * question when it decides whether a repo-local settings file claimed
 * `TOKENSCOPE_STATE_DIR`, and a second resolver there could disagree with the
 * one that WRITES the repo tag — i.e. the hook could inspect a directory the
 * tagger never writes, or miss the one it does.
 */
export function resolveRepoRoot(cwd) {
  /*
   * NO SUBPROCESS. This is reached from `neutraliseRepoHome`, which runs BEFORE
   * the repair that strips a repo-set PATH, so any spawn here resolves through
   * the repo's environment. Callers realpath both ends themselves, so the walk
   * preserves the physical-path property; `.git` is matched by existence, so a
   * linked worktree still resolves; a repo-set GIT_DIR is deliberately not
   * honoured. Do not add an exec here.
   * See epic-mdash-remediation.md (F34) for the measured exploit.
   */
  let dir = resolve(cwd)
  const fsRoot = resolve('/')
  while (true) {
    if (existsSync(join(dir, '.git'))) return dir
    if (dir === fsRoot) return null
    const parent = dirname(dir)
    if (parent === dir) return null
    dir = parent
  }
}

/**
 * S1 fix (4) — idempotently ensure `<root>/.gitignore` ignores the repo tag, so
 * the device-config `settings.local.json` this function writes can never be
 * accidentally committed in a repo that doesn't already exclude `.claude/`.
 *
 * ONE implementation, shared with the Copilot forwarder. S1 originally landed a
 * same-shaped private copy here because copilot-forwarder.mjs was outside its
 * file-ownership boundary; S2 then parameterised the original. Both boundaries
 * are gone now, so the duplicate is retired rather than left to drift — two
 * copies of a "don't commit the credential" helper is exactly the sibling
 * divergence this sprint exists to remove.
 *
 * Importing is side-effect-free: copilot-forwarder.mjs runs `main()` only under
 * an `import.meta.url === process.argv[1]` guard. tag-repo.mjs is NOT vendored
 * into the standalone Copilot distribution (see scripts/sync-copilot-plugin.mjs
 * FILES), so this cross-file import cannot reach a checkout where the target is
 * absent.
 *
 * The shared version additionally refuses to touch a non-git directory, which
 * the private copy did not — a strict improvement: a repo tag written outside a
 * work tree should not conjure a .gitignore beside it.
 */
function ensureRepoTagGitignored(root) {
  return ensureGitignored(root, {
    entry: '.claude/settings.local.json',
    comment: '# TokenScope repo tag (carries device config; do not commit)',
  })
}

/**
 * Write the repo-local ./.claude/settings.local.json, overriding
 * OTEL_RESOURCE_ATTRIBUTES with the device session id + the repo's code_hash.
 *
 * SELF-HEALING (ADR-0006): the target is re-derived from the CURRENT global
 * enrolment on every call — the helper path and the instance id are taken from
 * global *as they are now*, NOT a snapshot frozen at pin time.
 *
 * The env block is an ALLOWLIST: OTEL_RESOURCE_ATTRIBUTES only. Every other key
 * applies from the user-level file (per-key env merge,
 * docs/security-sprint/env-precedence-capture.md), and otel-headers-helper.sh
 * reads its credential and destinations from the device store / user settings,
 * never the repo file. `otelHeadersHelper` is a top-level setting, not env.
 *
 * Refuses (writes nothing, `trackedRefused: true`) when settings.local.json is
 * git-tracked: overwriting it would publish device config on the next commit.
 *
 * Idempotent + change-detecting: computes the target settings, compares against
 * the existing file's content, and writes ONLY when they differ (so a true
 * no-op leaves the file — and its mtime — untouched). Merges any unrelated local
 * settings keys and preserves the 0o600 mode.
 *
 * Returns { settingsPath, changed, healed, instanceDrifted }:
 *   - changed: whether the file was (re)written this call.
 *   - healed:  whether a stale pin was reconciled — i.e. the PREVIOUS repo env's
 *              helper path or instance differed from the current global one (a
 *              drift this rewrite just corrected). false when there was no
 *              previous repo env to compare or nothing drifted.
 *   - instanceDrifted: the INSTANCE half of `healed`, on its own. True only when
 *              the previous repo env pinned a DIFFERENT tokenscope.instance_id
 *              than the current global enrolment. Callers use this — never
 *              `healed` — to decide whether the RUNNING session is misattributing:
 *              a helper-path move (the other half of `healed`) does not change
 *              which instance records land against, so warning on it cries wolf.
 *
 * S1 fix (4c): anchored to the REPO ROOT (resolveRepoRoot), never a
 * subdirectory `cwd` happens to be invoked from — see resolveRepoRoot's doc.
 * Returns `{ settingsPath: null, changed: false, healed: false, instanceDrifted: false }` without
 * writing anything when the root cannot be resolved (not inside a git work
 * tree, or no `.git` found walking up) — refusing beats guessing a directory.
 */
export function writeRepoTag({ cwd, enrolment, codeHash }) {
  const root = resolveRepoRoot(cwd)
  if (!root) {
    return { settingsPath: null, changed: false, healed: false, instanceDrifted: false }
  }
  ensureRepoTagGitignored(root)
  const helperPath = resolveHelperPath(enrolment)
  const claudeDir = join(root, '.claude')
  /*
   * REFUSE A SYMLINKED `.claude` (MDASH r3).
   *
   * Git stores a symlink as mode 120000 and checkout recreates it, so a hostile
   * repo can ship `.claude` as a link to any directory the developer can write.
   * `mkdirSync(..., { recursive: true })` SUCCEEDS on an existing link target,
   * and every write below then lands there — including settings.local.json,
   * which carries the instance id and helper path. That is the same class as the
   * `.gitignore` finding one function over.
   *
   * The file write itself is tmp+rename, which replaces the LINK rather than
   * following it, so the directory is the exposure.
   */
  try {
    const st = lstatSync(claudeDir)
    if (!st.isDirectory()) {
      // A link, a file, a socket — anything but a real directory here is a
      // redirect. Refuse the whole tag rather than write somewhere we did not
      // choose; the caller already treats a null settingsPath as "not tagged".
      return { settingsPath: null, changed: false, healed: false, instanceDrifted: false }
    }
  } catch {
    /* absent — mkdirSync below creates it, and creation cannot follow a link */
  }
  mkdirSync(claudeDir, { recursive: true })
  const settingsPath = join(claudeDir, 'settings.local.json')

  // The caller warns on `trackedRefused`.
  if (isGitTracked(settingsPath)) {
    return { settingsPath: null, changed: false, healed: false, instanceDrifted: false, trackedRefused: true }
  }

  /*
   * THE FILE, not only the directory.
   *
   * Guarding `.claude` stops the write landing outside the repo, and the
   * tmp+rename replaces a link rather than following it — but the READ below
   * still followed one. A committed `settings.local.json` symlink whose target
   * is valid JSON gets its unrelated fields merged into the new repo file, and a
   * target that is a FIFO or a device blocks the hook outright. Same class as
   * the `.gitignore` finding, one file over.
   */
  let existing = {}
  let existingRaw = null
  try {
    // Absent is fine — the write below creates it. Anything present that is not
    // a REGULAR file is a redirect and the whole tag is refused.
    if (!lstatSync(settingsPath).isFile()) {
      return { settingsPath: null, changed: false, healed: false, instanceDrifted: false }
    }
  } catch {
    /* absent */
  }
  if (existsSync(settingsPath)) {
    try {
      existingRaw = readFileSync(settingsPath, 'utf8')
      existing = JSON.parse(existingRaw)
    } catch {
      existing = {}
      existingRaw = null
    }
  }

  // Detect drift BEFORE we overwrite: did the previous repo env pin a different
  // helper path or a different instance than the current global one? If so this
  // rewrite IS the reconcile (ADR-0006 decision 3).
  let healed = false
  // INSTANCE drift specifically, kept separate from `healed`. A helper-path move
  // is cosmetic to attribution; a changed INSTANCE means the running process —
  // whose OTel resource attrs froze at startup, before this rewrite — is emitting
  // under a SUPERSEDED instance id, so its records land against an instance the
  // device no longer claims and this device's /health reads permanently silent.
  // That is the condition worth interrupting the developer for; `healed` is not,
  // and warning on it would cry wolf on every helper-path bump.
  let instanceDrifted = false
  const prevEnv = existing && typeof existing.env === 'object' ? existing.env : null
  if (prevEnv) {
    const prevHelper =
      typeof existing.otelHeadersHelper === 'string' ? existing.otelHeadersHelper : null
    const prevInstance = parseInstanceId(prevEnv.OTEL_RESOURCE_ATTRIBUTES)
    instanceDrifted = prevInstance != null && prevInstance !== enrolment.sessionId
    healed = (prevHelper != null && prevHelper !== helperPath) || instanceDrifted
  }

  // Allowlist, never a copy of the device env (SS-CP-2).
  const fullEnv = {
    OTEL_RESOURCE_ATTRIBUTES: buildRepoResourceAttrs(enrolment.sessionId, codeHash),
  }
  // REPLACE the repo env wholesale (not additive) so a key the current global
  // stopped emitting — e.g. the now-removed legacy TOKENSCOPE_SESSION_TOKEN left
  // behind by a pre-OAuth enrolment — cannot survive as a dead credential at rest.
  // Top-level non-env keys (permissions, etc.) are still preserved by
  // mergeClaudeSettings. (MEDIUM-1)
  const target = mergeClaudeSettings(existing, helperPath, fullEnv, { replaceEnv: true })
  const targetRaw = JSON.stringify(target, null, 2) + '\n'

  // Change-detect: only write when the serialised content actually differs, so a
  // true no-op keeps the file/mtime stable.
  if (targetRaw === existingRaw) {
    // Identical content implies the previous env already pinned THIS instance, so
    // instanceDrifted is necessarily false here — no rewrite, nothing superseded.
    return { settingsPath, changed: false, healed: false, instanceDrifted: false }
  }
  // Write-temp-then-rename so a concurrent SessionStart hook (the per-HOST shared
  // ~/.claude means multiple `claude` launches can race the same repo file) never
  // reads a half-written file — rename is atomic on the same filesystem. The temp
  // is created 0o600 (it carries device config); we also chmod the
  // landed file because writeFileSync's `mode` only applies on CREATE and a
  // pre-existing target could have looser perms. (LOW-B, mirrors
  // otel-headers-helper.sh's cache-write pattern.)
  // RANDOM, not the PID alone. Containers have separate PID namespaces over one
  // shared bind-mounted home, so two writers can pick the SAME pid, open the same
  // temp inode, and mutate it after the other has renamed it into place — which
  // defeats the atomicity this temp+rename exists to provide. This is the
  // REPO-local settings file, which deliberately carries no durable credential.
  const tmpPath = `${settingsPath}.tmp.${process.pid}.${randomBytes(6).toString('hex')}`
  try {
    writeFileSync(tmpPath, targetRaw, { encoding: 'utf8', mode: 0o600 })
    chmodSync(tmpPath, 0o600)
    renameSync(tmpPath, settingsPath)
  } catch (err) {
    try {
      unlinkSync(tmpPath)
    } catch {
      /* temp may not exist — best effort */
    }
    throw err
  }
  try {
    chmodSync(settingsPath, 0o600)
  } catch {
    /* best-effort hardening — never fail the tag over a chmod */
  }
  return {
    settingsPath,
    changed: true,
    healed: Boolean(healed),
    instanceDrifted: Boolean(instanceDrifted),
  }
}

/** Extract tokenscope.instance_id from an OTEL_RESOURCE_ATTRIBUTES string, or null. */
function parseInstanceId(attrs) {
  if (typeof attrs !== 'string') return null
  const m = /(?:^|,)\s*tokenscope\.instance_id=([^,]+)/.exec(attrs)
  return m ? m[1].trim() : null
}

/**
 * Read the project.code_hash currently set in a repo-local settings.local.json,
 * or null. Informational only — it is NOT the hook's skip gate (the hook now
 * always calls writeRepoTag, which self-skips true no-ops). Per ADR-0006, a
 * hash match alone must never gate the rewrite, or a plugin upgrade / re-enrol
 * (which leaves the hash unchanged) would never reach a pinned repo.
 */
export function readRepoTaggedHash(cwd) {
  const settingsPath = join(cwd, '.claude', 'settings.local.json')
  if (!existsSync(settingsPath)) return null
  let settings
  try {
    settings = JSON.parse(readFileSync(settingsPath, 'utf8'))
  } catch {
    return null
  }
  const attrs = settings?.env?.OTEL_RESOURCE_ATTRIBUTES
  if (typeof attrs !== 'string') return null
  const m = /(?:^|,)\s*project\.code_hash=([^,]+)/.exec(attrs)
  return m ? m[1].trim() : null
}
