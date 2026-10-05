#!/usr/bin/env node
// SYNC NOTE: Auto-generated copy for standalone copilot-plugin distribution. Source: plugin/scripts/copilot-forwarder.mjs. Re-generate with: npm run sync:copilot-plugin
/*
 * copilot-forwarder — PER-PROJECT file-forwarder for Copilot CLI telemetry.
 * The ONLY v1 host for Copilot OTel emission (locked decision §3.4).
 *
 * PER-PROJECT MODEL (owner-approved): Copilot runs container-per-project, so the
 * forwarder is per PROJECT, not per HOME. Telemetry + forwarder state live WITH the
 * project in `<project-root>/.tokenscope.local/` (= the daemon's launch cwd):
 *   - the span file (COPILOT_OTEL_FILE_EXPORTER_PATH, relative → resolves to cwd),
 *   - the persisted byte-offset (`.tokenscope.local/forwarder-offset`),
 *   - the singleton PID/heartbeat lock (`.tokenscope.local/copilot-forwarder.pid`).
 * Only the DEVICE CREDENTIAL (instance_id + endpoints + oauth) stays in the account's
 * home (`~/.tokenscope/config.copilot-cli.json`, resolved by TOKENSCOPE_DIR below — the PASSWD
 * home, not `$HOME`) — one enrolment per host, shared by every project.
 *
 * Because the forwarder is now scoped to ONE project root, there is exactly ONE repo
 * in play. The old cross-repo-bleed guard (boundRepo / lastBatchRepos / F3-deferral)
 * is therefore OBSOLETE and has been removed — per-project means the singleton can
 * never see a second repo to bleed into.
 *
 * Architecture (spec §2a, Slice 3):
 *   - One forwarder per project root. Started lazily by the first session's
 *     sessionStart hook (singleton — does not double-spawn; PID lock in the
 *     project-local dir).
 *   - Tails COPILOT_OTEL_FILE_EXPORTER_PATH by byte offset every ~60s.
 *   - NEVER truncates the file mid-session (Copilot holds the file handle open;
 *     truncating corrupts concurrent writes and can drop un-forwarded spans).
 *     The forwarder does NOT rotate the file: span-file growth is bounded by the
 *     container lifetime (v1 targets the ephemeral CW model). A long-lived host
 *     that needs rotation is a tracked follow-up, not a v1 behaviour.
 *   - Transcodes `chat` spans → api_request OTLP-logs protobuf via transcodeChatSpans
 *     (double-count guard baked in: invoke_agent excluded at the transcoder level).
 *   - Mints/refreshes the Azure bearer via otel-headers-helper.sh.
 *   - Forwards to the Azure Monitor DCR logs endpoint. Retry-once-on-401.
 *   - Demuxes automatically: spans are self-describing (gen_ai.conversation.id),
 *     so concurrent copilot sessions sharing the file attribute correctly, and
 *     subagents roll up to their parent conversation.id.
 *   - Reads creds from ~/.tokenscope/config.copilot-cli.json ONLY. No dependency on Claude /
 *     ~/.claude/settings.json.
 *   - Emits the server-attested instance_id from ~/.tokenscope/config.copilot-cli.json.
 *     NEVER a free-text label (security invariant — locked decision §3.8).
 *   - Stamps the GitHub ORG on the emit (F2 org→enterprise keying), derived from the
 *     project's git remote (deterministic) with a span-attr fallback.
 *
 * Lifecycle (hook-driven, spec §2a):
 *   --start           sessionStart hook: start if not running, then catch-up-forward.
 *   --final-forward   Stop hook: do a final forward of any pending spans then exit.
 *
 * Called by the plugin hooks.json (forwarder-lifecycle.mjs).
 *
 * Uses only Node.js built-ins (no external deps — ships into user space).
 */
import fs from 'node:fs'
import { execFileSync } from 'node:child_process'
import { trustedGitPath } from './trusted-git.mjs'
import { join, dirname, resolve } from 'node:path'
import { homedir } from 'node:os'
import { fileURLToPath } from 'node:url'
import {
  transcodeChatSpans,
  transcodeSignalSpans,
  buildCopilotOtlpPayload,
  encodeExportLogsServiceRequest,
} from './otlp-logs.mjs'
import { detectManagedTelemetry } from './managed-telemetry.mjs'
import { realHome } from './real-home.mjs'
import { resolveStorePath } from './device-store.mjs'
import {
  TOKENSCOPE_DIR,
  CONFIG_PATH,
  configPathNow,
  LEGACY_SPAN_PATH,
  extensionsEnabled,
  loadConfig,
  mintBearer,
  httpsPost,
  postWithRetry,
  parseGithubOrg,
  gitRemoteOrgUrl,
  resolveGithubOrg,
  resolveProjectCodeHash,
} from './copilot-emit.mjs'


// The account's home holds ONLY the device credential; span file, offset and lock
// are PER-PROJECT (projectLocalDir()). Credential/emit primitives: copilot-emit.mjs.
export { TOKENSCOPE_DIR, CONFIG_PATH, postWithRetry, parseGithubOrg, gitRemoteOrgUrl, resolveGithubOrg, resolveProjectCodeHash }
/** The per-PROJECT telemetry/state dir name, resolved against the daemon's cwd. */
const PROJECT_LOCAL_DIRNAME = '.tokenscope.local'

/**
 * Resolve the per-PROJECT state dir (`<cwd>/.tokenscope.local`). The daemon's cwd is
 * the project root (Copilot launches per-project; the hook spawns the daemon from the
 * session's cwd). All forwarder STATE (offset + lock) lives here so telemetry never
 * leaks across projects sharing one HOME.
 */
function projectLocalDir(cwd = process.cwd()) {
  return join(cwd, PROJECT_LOCAL_DIRNAME)
}

/**
 * True when `<cwd>/.tokenscope.local` exists and is NOT a real directory (a
 * committed symlink): nothing under it may be read or written
 * (client-plugins:idor:0001). Absent is false. Exported for unit testing.
 */
export function projectLocalDirRedirected(cwd = process.cwd()) {
  try {
    return !fs.lstatSync(projectLocalDir(cwd)).isDirectory()
  } catch {
    return false
  }
}

// PID lock + offset live in the PROJECT-local dir (per-project singleton + offset).
// The TOKENSCOPE_FWD_PID_FILE / TOKENSCOPE_FWD_OFFSET_FILE env vars override the paths
// (used by unit tests for isolation); otherwise they resolve under <cwd>/.tokenscope.local.
const PID_FILE =
  process.env.TOKENSCOPE_FWD_PID_FILE ?? join(projectLocalDir(), 'copilot-forwarder.pid')
/**
 * Persisted byte-offset, stored as JSON {offset, ino} where ino is the inode
 * of the span file at the time the offset was last written (L2).
 * If the span file has a different inode now (recreated, Copilot upgrade) or
 * has shrunk, the stored offset is stale — discard it and start from 0.
 * TOKENSCOPE_FWD_OFFSET_FILE env var overrides the path (used by unit tests).
 */
const OFFSET_FILE =
  process.env.TOKENSCOPE_FWD_OFFSET_FILE ?? join(projectLocalDir(), 'forwarder-offset')
/**
 * Clamp a raw TOKENSCOPE_FORWARD_INTERVAL_MS value to a sane interval. A garbage
 * value (Number(bad) → NaN) would otherwise degrade setInterval to 1ms hot-loop
 * ticks AND poison HEARTBEAT_STALE_MS (Math.max(NaN, …) is NaN → isAlreadyRunning
 * never true → every session start spawns another daemon). A sub-second positive
 * (e.g. 1.5) is also a hot loop, so floor at 1000ms. Exported for tests.
 */
const MIN_FORWARD_INTERVAL_MS = 1_000
export function clampForwardIntervalMs(raw) {
  const n = Number(raw ?? 60_000)
  return Number.isFinite(n) && n >= MIN_FORWARD_INTERVAL_MS ? n : 60_000
}

/** Forward interval: ~60s as specified (configurable via TOKENSCOPE_FORWARD_INTERVAL_MS). */
const FORWARD_INTERVAL_MS = clampForwardIntervalMs(process.env.TOKENSCOPE_FORWARD_INTERVAL_MS)
/** A PID record older than this means the daemon died (2.5 missed heartbeats, min 150s). */
const HEARTBEAT_STALE_MS = Math.max(2.5 * FORWARD_INTERVAL_MS, 150_000)

/** Parse `project.code_hash` out of an `OTEL_RESOURCE_ATTRIBUTES`-style CSV string. */
export function extractCodeHash(attrString) {
  for (const pair of String(attrString || '').split(',')) {
    const eqIdx = pair.indexOf('=')
    if (eqIdx > 0) {
      const k = pair.slice(0, eqIdx).trim()
      const v = pair.slice(eqIdx + 1).trim()
      if (k === 'project.code_hash' && v) return v
    }
  }
  return null
}

/**
 * Read the per-span Copilot repo attribute (`github.copilot.git.repository`, e.g.
 * "org/repo") from a span, tolerating BOTH input shapes (file-exporter plain
 * key→value object AND OTLP/HTTP wire [{key,value:{stringValue}}] array). Returns
 * the trimmed string, or null if absent.
 *
 * IMPORTANT (spike-verified, docs/background/copilot-otel-spike/): this attr is
 * stamped on the `invoke_agent` span ONLY — the `chat` spans we actually forward do
 * NOT carry it. Used here only as the FALLBACK source for the org stamp when the
 * project has no git remote (the per-project model means there is only one repo, so a
 * single "org/repo" string is unambiguous).
 */
export function repoFromSpan(span) {
  const attrs = span?.attributes
  if (!attrs) return null
  let v
  if (Array.isArray(attrs)) {
    // OTLP/HTTP wire shape: [{key, value:{stringValue}}]
    const kv = attrs.find((a) => a.key === 'github.copilot.git.repository')
    v = kv?.value?.stringValue
  } else {
    // File-exporter shape: plain key→value object
    v = attrs['github.copilot.git.repository']
  }
  if (typeof v !== 'string') return null
  const t = v.trim()
  return t === '' ? null : t
}

/** True if `cwd` is a git work tree root (a `.git` entry — dir or worktree file). */
function isGitRepo(cwd = process.cwd()) {
  try {
    return fs.existsSync(join(cwd, '.git'))
  } catch {
    return false
  }
}

async function forwardSpans(spans) {
  if (!spans.length) return 0
  const cfg = loadConfig()
  // Security invariant: instance_id from config only — never from span (locked §3.8).
  const instanceId = cfg.instance_id
  // Per-project: the daemon's cwd is the project root, so a single cwd-derived hash is
  // always correct (one repo per forwarder — no cross-repo guard needed).
  const projectCodeHash = resolveProjectCodeHash(cfg, { cwd: process.cwd() })
  // Org stamp (F2 org→enterprise keying): git remote first, span repo as fallback.
  const githubOrg = resolveGithubOrg({ cwd: process.cwd(), spanRepo: lastBatchRepo })

  // Token records (billing) + behavioural signal records (non-billing lane). The
  // two are independent: a batch may carry signals but no chat tokens (e.g. an
  // invoke_agent turn), so don't gate forwarding on token records alone.
  const logRecords = [
    ...transcodeChatSpans(spans, { instanceId, projectCodeHash }),
    ...transcodeSignalSpans(spans, { instanceId }),
  ]
  if (!logRecords.length) return 0

  const payload = buildCopilotOtlpPayload(logRecords, instanceId, projectCodeHash, { githubOrg })
  const proto = encodeExportLogsServiceRequest(payload)

  const result = await postWithRetry(cfg.logs_endpoint, proto, mintBearer, httpsPost)

  if (result.status >= 200 && result.status < 300) {
    return logRecords.length
  }
  throw new Error(`Azure Monitor forward HTTP ${result.status}: ${result.body}`)
}

// ── file tail ─────────────────────────────────────────────────────────────────
let offset = 0
let buf = ''
/**
 * The repo (`github.copilot.git.repository`, "org/repo") last seen in a readNewSpans
 * batch — the FALLBACK source for the org stamp when the project has no git remote.
 * The attr rides invoke_agent ONLY (spike-verified), so we scan all span types. In the
 * per-project model there is one repo, so a single last-seen value is unambiguous.
 * Recomputed every read; null when no span in the batch carried the attr.
 */
let lastBatchRepo = null

/**
 * Load the persisted byte-offset from OFFSET_FILE.
 * Stored as JSON {offset: number, ino: number} where ino is the span file's
 * inode at persist-time. If the span file has a different inode now (recreated,
 * Copilot upgrade) or has shrunk, the stored offset is stale — discard it and
 * start from 0 (L2 fix: prevents silent "forward nothing forever" after file shrink).
 */
export function loadPersistedOffset(filePath) {
  try {
    const stored = JSON.parse(fs.readFileSync(OFFSET_FILE, 'utf8'))
    let currentIno = null
    try {
      currentIno = fs.statSync(filePath).ino
    } catch {
      return
    }
    if (stored.ino === currentIno && Number.isFinite(stored.offset) && stored.offset >= 0) {
      offset = stored.offset
    }
    // If inode differs: span file was recreated — offset stays 0.
  } catch {
    /* first run or absent — offset stays 0 */
  }
}

/**
 * Persist the current offset + span file inode to OFFSET_FILE.
 * Stored as {offset, ino} so the next process can detect file recreation.
 */
export function persistOffset(filePath) {
  try {
    let ino = 0
    try {
      ino = fs.statSync(filePath).ino
    } catch {
      /* best effort */
    }
    fs.writeFileSync(OFFSET_FILE, JSON.stringify({ offset, ino }), { encoding: 'utf8' })
  } catch {
    /* best effort */
  }
}

/** Reset module-level state — only called by unit tests. */
export function _resetStateForTest() {
  offset = 0
  buf = ''
  lastBatchRepo = null
}

/** The repo from the last readNewSpans batch (org-stamp fallback). Test seam. */
export function _getLastBatchRepo() {
  return lastBatchRepo
}

// ── span-file provenance (S2 — closes client-plugins:idor:0002) ───────────────
// Root cause: the forwarder tails <repo>/.tokenscope.local/copilot-otel.jsonl with
// no provenance check. On the FIRST run in a fresh clone the offset starts at 0
// (loadPersistedOffset finds no stash), so a file COMMITTED INTO THE REPOSITORY —
// planted by a hostile contributor, surviving a stale/missing .gitignore, or
// simply present before ensureGitignored's self-heal ever ran — is read from byte
// 0 and POSTed to the ingest endpoint under the DEVELOPER'S OWN emit bearer. This
// extends the distrust decision 3.8 already applies to span DATA (otlp-logs.mjs
// refuses instance_id from a span) to the FILE ITSELF: a span file this process
// does not own, or that git tracks, is refused outright — never partially trusted.
//
// Cost-ordered per the story (cheapest check first, short-circuits the rest):
//   (1) uid — the file's owner must match this process's uid (statSync is free;
//       already paid for by the shrink/size check below).
//   (2) git-tracked — `git ls-files --error-unmatch` (one subprocess) kills the
//       committed-file vector directly: ensureGitignored keeps a HEALTHY project's
//       .tokenscope.local/ out of git, so a tracked span file means either a repo
//       that predates/bypasses that self-heal or an actively hostile commit.
//   (3) a per-spawn byte-offset baseline (inode+size+ctime at daemon start,
//       forward only bytes appended after it) is DELIBERATELY NOT shipped this
//       sprint. Copilot's own exporter writes on its own schedule — a baseline
//       enforced from day one risks dropping genuine spend written between
//       process start and the first tick. Ship (1)+(2) now; measure real-world
//       write timing before enforcing (3) (tracked follow-up, not a v1 behaviour).
//
// Both checks run on EVERY read (not just at daemon spawn): cheap (one stat + one
// short-lived git subprocess, no worse than resolveGithubOrg's existing per-batch
// git call below) and it catches a file that becomes untrustworthy MID-SESSION
// (e.g. `git add .tokenscope.local` run after the daemon already started tailing
// a legitimate file) — not only the first-run case. A refusal returns [] WITHOUT
// touching offset/buf/the persisted offset, so the file is simply never read —
// fail closed — for as long as it stays untrustworthy; if it later becomes safe
// (uid fixed, `git rm --cached` run) reading resumes from the same position.

/**
 * True if `st` (a fs.Stat for the span file) is NOT owned by this process's uid.
 * Fails OPEN on platforms/environments where the check is meaningless (no
 * process.getuid — Windows) rather than refusing every read there; fails CLOSED
 * (refuses) only on a confident, confirmed mismatch. Exported for unit testing.
 */
export function isForeignOwned(st) {
  if (typeof process.getuid !== 'function') return false
  return typeof st?.uid === 'number' && st.uid !== process.getuid()
}

/**
 * True if `filePath` is tracked by git (staged or committed) in its containing
 * repo — the committed-file vector this guard exists to kill. `git ls-files
 * --error-unmatch` exits 0 iff the path is tracked; anything else (not a repo, git
 * absent, untracked, any spawn failure) is treated as "not tracked" — this check
 * NEVER throws, so a missing git binary degrades to "no extra protection", not a
 * crashed forwarder. Exported for unit testing.
 */
export function isGitTracked(filePath) {
  try {
    const git = trustedGitPath()
    if (!git) return false // no trusted git — treat as untracked, never name-lookup
    execFileSync(git, ['ls-files', '--error-unmatch', filePath], {
      cwd: dirname(filePath),
      stdio: ['ignore', 'ignore', 'ignore'],
    })
    return true
  } catch {
    return false
  }
}

/**
 * Read new lines from the file since last offset. Returns chat spans found.
 * NEVER truncates the file (Copilot holds the handle open mid-session).
 */
export function readNewSpans(filePath) {
  let st
  try {
    st = fs.statSync(filePath)
  } catch {
    return []
  }

  // Provenance guard — see the block comment above. A refusal is silent-to-the-
  // batch (empty array) but loud on stderr so a genuinely misplaced/hostile file
  // is debuggable rather than a mysterious "nothing forwards".
  if (projectLocalDirRedirected()) {
    console.error(
      `[tokenscope-fwd] refusing ${filePath}: ${PROJECT_LOCAL_DIRNAME} is not a real directory (provenance guard)`,
    )
    return []
  }
  if (isForeignOwned(st)) {
    console.error(
      `[tokenscope-fwd] refusing ${filePath}: not owned by this process's uid (provenance guard)`,
    )
    return []
  }
  if (isGitTracked(filePath)) {
    console.error(
      `[tokenscope-fwd] refusing ${filePath}: file is tracked by git — a committed span file is never forwarded (provenance guard)`,
    )
    return []
  }

  // L2: detect file shrink (truncation by external tool) or recreation (different
  // inode, already handled in loadPersistedOffset). If the file is smaller than
  // our stored offset it was truncated — reset so we don't silently skip forever.
  if (st.size < offset) {
    offset = 0
    buf = ''
    persistOffset(filePath) // persist the reset
  }

  if (st.size <= offset) return []

  const fd = fs.openSync(filePath, 'r')
  const len = st.size - offset
  const b = Buffer.alloc(len)
  fs.readSync(fd, b, 0, len, offset)
  fs.closeSync(fd)
  offset = st.size
  // R4: do NOT persist the advance here. readAndForward() persists ONLY after a
  // successful forward, so a failed/crashed forward leaves the persisted offset at
  // the pre-batch position; the batch is re-read and re-sent (dedup-absorbed by the
  // stable request_id) rather than silently dropped.

  buf += b.toString('utf8')
  const lines = buf.split('\n')
  buf = lines.pop() // keep incomplete last line

  const chatSpans = []
  // Org-stamp fallback: capture the repo across ALL span types in this batch. The repo
  // attr rides invoke_agent ONLY (spike-verified), so scan every span here — the
  // returned chatSpans alone would never reveal it. Per-project = one repo, so the
  // last non-null value is the batch's repo.
  let batchRepo = null
  for (const line of lines) {
    if (!line.trim()) continue
    let obj
    try {
      obj = JSON.parse(line)
    } catch {
      continue
    }
    if (obj.type !== 'span') continue
    const r = repoFromSpan(obj)
    if (r) batchRepo = r
    // File-exporter shape: { type:"span", attributes:{gen_ai.operation.name: ...} }
    if (obj.attributes?.['gen_ai.operation.name'] === 'chat') {
      chatSpans.push(obj)
    }
  }
  lastBatchRepo = batchRepo
  return chatSpans
}

// ── singleton guard (heartbeat-based liveness) ───────────────────────────────
// PID_FILE lives in the PER-PROJECT dir (<project-root>/.tokenscope.local), so the
// singleton is now per-PROJECT: each project root gets exactly one forwarder, and
// projects sharing one HOME no longer contend for a single host-wide lock.
// process.kill(pid, 0) is still meaningless across PID namespaces (a CW shares its
// home + project mount with siblings): a reused PID in another container's namespace
// gives a false "alive" that suppresses the daemon forever, and a hard-killed daemon
// (SIGKILL) never runs its exit handler so the file lingers. So liveness is by
// HEARTBEAT FRESHNESS, not PID existence — the daemon rewrites {pid, startedAt,
// heartbeatAt} every tick; a record older than HEARTBEAT_STALE_MS means the writer
// died. Correct whether the project dir is shared across siblings or per-container.

/** Parse the PID record ({pid, startedAt, heartbeatAt}), or null if absent/corrupt/legacy. */
export function readPidRecord() {
  try {
    const rec = JSON.parse(fs.readFileSync(PID_FILE, 'utf8'))
    if (rec && typeof rec === 'object' && Number.isFinite(rec.heartbeatAt)) return rec
  } catch {
    /* missing / corrupt / legacy plain-pid format */
  }
  return null
}

export function isAlreadyRunning() {
  const rec = readPidRecord()
  if (!rec) {
    removePidFile() // missing/corrupt/legacy — clear so claimSingleton's wx won't wedge
    return false
  }
  if (Date.now() - rec.heartbeatAt < HEARTBEAT_STALE_MS) return true // fresh → a daemon is live
  // Stale heartbeat: the writer died (hard-kill, or a dead daemon in another container).
  removePidFile()
  return false
}

/** Rewrite the PID record with a fresh heartbeat. Called every daemon tick. */
export function writeHeartbeat(startedAt) {
  try {
    fs.writeFileSync(
      PID_FILE,
      JSON.stringify({ pid: process.pid, startedAt, heartbeatAt: Date.now() }),
      { encoding: 'utf8' },
    )
  } catch {
    /* best effort */
  }
}

/**
 * Become the singleton. Atomic exclusive-create (wx) guards the TOCTOU where two
 * concurrent starts both pass isAlreadyRunning() before either writes; the loser
 * gets EEXIST and yields. Returns startedAt for the heartbeat loop to reuse.
 *
 * Residual race (LOW, dedup-absorbed): if a STALE record is present, two concurrent
 * starts can both reap it and both wx-create, briefly running two daemons tailing the
 * same file. The joiner's onConflictDoNothing (stable request_id) absorbs the duplicate
 * forwards and the loser exits when its session ends — so it is wasteful, never wrong.
 * A hard lock (O_EXCL lockfile) is a tracked follow-up, not needed for correctness.
 */
export function claimSingleton() {
  // Ensure the dir holding the lock exists (the per-project .tokenscope.local, or the
  // test override's dir). Use dirname(PID_FILE) so it tracks whichever path is active.
  fs.mkdirSync(dirname(PID_FILE), { recursive: true })
  const startedAt = Date.now()
  try {
    fs.writeFileSync(
      PID_FILE,
      JSON.stringify({ pid: process.pid, startedAt, heartbeatAt: startedAt }),
      { encoding: 'utf8', flag: 'wx' },
    )
  } catch (err) {
    if (err.code === 'EEXIST') {
      console.error('[tokenscope-fwd] lost singleton race, yielding to existing process')
      process.exit(0)
    }
    throw err
  }
  return startedAt
}

function removePidFile() {
  try {
    fs.unlinkSync(PID_FILE)
  } catch {
    /* best effort */
  }
}

// ── .gitignore self-heal (per-project telemetry must never be committed) ───────
/**
 * Idempotently ensure `<cwd>/.gitignore` contains `entry`. Appends it only when
 * missing (matched flexibly: with an optional leading `/`, and — for a DIRECTORY
 * entry ending in `/` — also matched against the bare name without the trailing
 * slash, the common alternate .gitignore spelling). Best-effort: a
 * missing/unwritable .gitignore or a non-git dir is a no-op, never an error (a
 * caller must not fail its primary write over .gitignore hygiene).
 *
 * PARAMETERISED (S2 — carried over from S1's fix 4): this used to be hardcoded to
 * ONE entry (`.tokenscope.local/`, the per-project telemetry dir). S1 needed the
 * same idempotent-append shape for a DIFFERENT entry (`.claude/settings.local.json`,
 * the credential-bearing repo tag) but couldn't import this file (outside that
 * story's ownership boundary), so it wrote a same-shaped independent copy
 * (`tag-repo.mjs`'s `ensureRepoTagGitignored`) and documented the follow-up. This
 * IS that follow-up: the entry + comment are now parameters (defaulting to the
 * original telemetry-dir values, so the call below is unchanged) so a caller that
 * CAN reach this module has exactly one implementation to call, not a reason to
 * write a second one. (tag-repo.mjs's own call site is outside this story's
 * ownership boundary too — the reciprocal case — so switching it over is a
 * follow-up for whoever owns that file next; flagged in this story's report.)
 *
 * @param {string} [cwd] — the project root (defaults to process.cwd()).
 * @param {{ entry?: string, comment?: string }} [opts]
 *   @param {string} [opts.entry] — the .gitignore line to ensure. Defaults to the
 *     per-project telemetry dir (`.tokenscope.local/`).
 *   @param {string} [opts.comment] — the explanatory comment line written above a
 *     NEWLY-appended entry (never itself checked for presence).
 * @returns {boolean} true if it appended (or would have), false if already present/skipped.
 */
export function ensureGitignored(
  cwd = process.cwd(),
  {
    entry = `${PROJECT_LOCAL_DIRNAME}/`,
    comment = '# TokenScope per-project telemetry (do not commit)',
  } = {},
) {
  // Only touch a real git work tree — never create a .gitignore in a non-git dir
  // (e.g. $HOME), which would be surprising noise in the user's filesystem.
  if (!isGitRepo(cwd)) return false
  // A directory entry (trailing '/') is also matched WITHOUT the slash — the
  // common alternate .gitignore spelling. A file entry (e.g.
  // `.claude/settings.local.json`) has no such alternate form.
  const bare = entry.endsWith('/') ? entry.slice(0, -1) : null
  const gitignorePath = join(cwd, '.gitignore')
  try {
    /*
     * VALIDATE BEFORE READING, not only before writing.
     *
     * The no-follow open below protects the APPEND, but this read ran first and
     * followed the link anyway: a committed `.gitignore` pointing at a FIFO or a
     * character device blocks or exhausts the plugin the moment the repo is
     * opened, which needs no write at all. lstat first and refuse anything that
     * is not a regular file; absent is fine, the open creates it.
     */
    try {
      const st = fs.lstatSync(gitignorePath)
      if (!st.isFile()) return false
    } catch {
      /* absent → the open below creates it */
    }
    let content = ''
    try {
      content = fs.readFileSync(gitignorePath, 'utf8')
    } catch {
      /* absent → create */
    }
    // Already ignored? Match any line that is exactly `entry`, with an optional
    // leading slash, and (for a directory entry) the bare form too.
    const already = content.split(/\r?\n/).some((line) => {
      const t = line.trim().replace(/#.*$/, '').trim()
      return t === entry || t === `/${entry}` || (bare !== null && (t === bare || t === `/${bare}`))
    })
    if (already) return false
    const prefix = content === '' ? '' : content.endsWith('\n') ? '' : '\n'
    /*
     * REFUSE TO FOLLOW A LINK (MDASH F299). Git stores a symlink as mode 120000
     * and checkout recreates it, so a hostile repo can ship a `.gitignore` that
     * is a symlink and redirect this append to any file the developer can write.
     * The content appended is fixed, so it is not code execution — but pointed
     * at ~/.claude/settings.json it makes that file unparseable, and every
     * reader fails closed: a silent, durable, device-wide de-enrolment. Both
     * lanes reach here (the Claude lane on every tagged repo at session start).
     *
     * O_NOFOLLOW fails with ELOOP when the FINAL component is a symlink, so the
     * check and the write are one atomic operation — an lstat beforehand would
     * leave a window between the two. Where the flag is unavailable (Windows),
     * fall back to an lstat guard, which closes the class if not the race.
     */
    const NOFOLLOW = fs.constants.O_NOFOLLOW ?? 0
    if (NOFOLLOW === 0) {
      try {
        if (!fs.lstatSync(gitignorePath).isFile()) return false
      } catch {
        /* absent — the open below creates it */
      }
    }
    let fd
    try {
      fd = fs.openSync(
        gitignorePath,
        fs.constants.O_WRONLY | fs.constants.O_APPEND | fs.constants.O_CREAT | NOFOLLOW,
        0o644,
      )
    } catch {
      return false // ELOOP (a symlink), or not ours to write — refuse, quietly
    }
    try {
      fs.writeSync(fd, `${prefix}${comment}\n${entry}\n`)
    } finally {
      fs.closeSync(fd)
    }
    return true
  } catch {
    return false // best-effort: never fail the caller over .gitignore hygiene
  }
}

// ── read + forward (one rollback-safe path for all three callers) ────────────
/**
 * Read pending spans and forward them. On forward FAILURE, roll back the byte
 * offset + line buffer so the next pass re-reads and retries the same batch
 * (R4: a transient forward error must not permanently drop a batch; the server
 * dedups the re-send by stable request_id). Persists the offset ONLY after a
 * successful send. The single path shared by catch-up, the loop, and final-forward.
 */
export async function readAndForward(filePath, label, forwardFn = forwardSpans) {
  const snapOffset = offset
  const snapBuf = buf
  const spans = readNewSpans(filePath) // advances offset+buf in memory (no persist)
  if (!spans.length) return 0
  try {
    const n = await forwardFn(spans)
    persistOffset(filePath) // commit the advance only after a successful send
    if (n > 0) console.error(`[tokenscope-fwd] ${label}: forwarded ${n} chat span(s)`)
    return n
  } catch (err) {
    offset = snapOffset // roll back → next pass re-reads + retries (dedup-absorbed)
    buf = snapBuf
    console.error(`[tokenscope-fwd] ${label} error (will retry): ${String(err)}`)
    return 0
  }
}

/** sessionStart: pick up spans left behind by a hard-killed prior forwarder. */
async function catchUpForward(filePath) {
  await readAndForward(filePath, 'catch-up')
}

/** The periodic daemon loop: heartbeat (liveness) then forward, every interval. */
function startDaemonLoop(filePath, startedAt) {
  // Tick-overlap guard: while tick A awaits a slow POST, tick B must NOT read/persist
  // the same module-level offset/buf — A's eventual rollback would restore a pre-B
  // snapshot (re-reading data B forwarded, restoring a stale partial-line buf that
  // can mis-frame JSONL lines). Overlapping ticks are no-ops; the heartbeat still
  // fires every tick so liveness is never starved by a slow forward.
  let inFlight = false
  const timer = setInterval(async () => {
    // Setup migrated this device while the daemon was running: the extension now sends
    // every session, so forwarding another span would count it twice. Stop for good.
    if (extensionsEnabled(process.env)) {
      console.error('[tokenscope-fwd] Copilot extensions were enabled: the usage extension captures sessions now; forwarder exiting.')
      removePidFile()
      process.exit(0)
    }
    writeHeartbeat(startedAt) // prove liveness every tick, before the async forward
    if (inFlight) return
    inFlight = true
    try {
      await readAndForward(filePath, 'forward')
    } finally {
      inFlight = false
    }
  }, FORWARD_INTERVAL_MS)
  timer.unref() // don't block process exit — the keepalive interval holds us open
}

/** Stop hook: flush spans the daemon hasn't sent yet, then exit (daemon lives on). */
async function finalForward(filePath) {
  // Resume from the daemon's committed offset so we only send not-yet-forwarded spans.
  loadPersistedOffset(filePath)
  await readAndForward(filePath, 'final-forward')
  // L1: the daemon is a container-lifetime singleton — Stop NEVER kills it. Multiple
  // sessions share one daemon; killing it on any Stop would orphan the others. The
  // daemon exits only with the container (SIGTERM/SIGINT from the OS); Stop just flushes.
  process.exit(0)
}

// ── main ──────────────────────────────────────────────────────────────────────
async function main() {
  const rawMode = process.argv[2] // '--start' | '--final-forward' | 'start' | 'stop'

  // Normalise both the dashed CLI form (legacy ~/.copilot/config.json hooks written
  // by older copilot-redeem.mjs) and the plain form (plugin hooks.json via
  // forwarder-lifecycle.mjs).  B3 fix: 'stop' was falling into the --start branch.
  let mode
  if (rawMode === '--start' || rawMode === 'start') {
    mode = '--start'
  } else if (rawMode === '--final-forward' || rawMode === 'stop') {
    mode = '--final-forward'
  } else {
    mode = rawMode ?? '--start'
  }

  if (projectLocalDirRedirected()) {
    console.error(
      `[tokenscope-fwd] ${PROJECT_LOCAL_DIRNAME} in ${process.cwd()} is not a real directory (a symlink?) — refusing to read or write under it; forwarder idle.`,
    )
    process.exit(0)
  }

  // Not provisioned yet (tokenscope-setup never run on this host): there is
  // nothing to forward, so this is a graceful no-op, NOT an error. Exit 0 for
  // both start and stop. The Stop hook runs this synchronously and propagates
  // the exit code, so a non-zero here surfaced as "Hook ... failed with code 1"
  // on every pre-provision session. Guard once here at main() entry so it covers
  // BOTH start and stop, not only the stop path that exhibited the failure.
  if (!fs.existsSync(configPathNow())) {
    console.error(
      `[tokenscope-fwd] not provisioned (${CONFIG_PATH} absent) — run the tokenscope-setup skill to enable forwarding; skipping.`,
    )
    // There is deliberately NO read-time fallback to the default store (see
    // TOKENSCOPE_DIR), so a pinned dir that holds nothing means "not provisioned"
    // full stop. But a pin is also the ONE way this reader can legitimately land
    // somewhere copilot-redeem.mjs never writes — redeem has no TOKENSCOPE_STATE_DIR
    // override, it always writes the passwd-home store — so when that is what
    // happened, name BOTH paths rather than let a provisioned device read as
    // unprovisioned. A warning, never a fallback.
    const defaultConfigPath = resolveStorePath('copilot-cli', join(realHome(), '.tokenscope'))
    if (CONFIG_PATH !== defaultConfigPath && fs.existsSync(defaultConfigPath)) {
      console.error(
        `[tokenscope-fwd] NOTE: TOKENSCOPE_STATE_DIR pins this forwarder to ${TOKENSCOPE_DIR}, but a credential does exist at ${defaultConfigPath} (where copilot-redeem writes — it has no such pin). Unset the pin, or point it at that directory, to forward from this device.`,
      )
    }
    process.exit(0)
  }

  // A migrated device (setup turned on Copilot extensions): the usage extension sends
  // every session, old terminals included, so the forwarder never runs; files a legacy
  // session left behind are ignored (setup removes them once, at migration).
  if (extensionsEnabled(process.env)) {
    // Whatever an old terminal appended here meanwhile was sent by its extension: mark it
    // consumed (never delete), so switching back to the forwarder cannot replay it.
    const spanFile = resolve(process.cwd(), LEGACY_SPAN_PATH)
    try {
      offset = fs.statSync(spanFile).size
      persistOffset(spanFile)
    } catch {
      /* no span file here */
    }
    console.error('[tokenscope-fwd] Copilot extensions are enabled: the usage extension captures this session; forwarder idle.')
    return
  }
  // Not migrated. Copilot hides COPILOT_OTEL_FILE_EXPORTER_PATH from hooks, so read what
  // this process CAN see: Copilot writes the project's span file only for a session
  // started with that variable. None here: nothing to forward. The variable, when
  // visible (a test), names the file instead of the default.
  const rawFilePath = (process.env.COPILOT_OTEL_FILE_EXPORTER_PATH ?? '').trim() || LEGACY_SPAN_PATH
  const filePath = resolve(process.cwd(), rawFilePath)
  if (!fs.existsSync(filePath)) {
    console.error('[tokenscope-fwd] no span file in this project; forwarder idle.')
    return
  }
  // Load config early to surface misconfiguration clearly.
  loadConfig()

  if (mode === '--final-forward') {
    await finalForward(filePath)
    return
  }

  // --start (sessionStart hook)
  // The per-project model assumes the daemon's cwd IS the project root — the relative
  // span file, offset, lock, and .gitignore all resolve against it. If cwd is $HOME or
  // not a git work tree, telemetry/state land in the wrong place, SILENTLY. Warn loudly
  // so a misconfigured launch is debuggable. Do not refuse (a non-git project is still
  // valid spend; the org stamp just falls back / is null).
  if (process.cwd() === homedir() || !isGitRepo(process.cwd())) {
    console.error(
      `[tokenscope-fwd] WARNING: cwd ${process.cwd()} is not a project root (no .git / is $HOME) — ` +
        'per-project telemetry may land in the wrong directory. Launch copilot from the project root.',
    )
  }
  // Self-heal .gitignore so the project-local telemetry dir is never committed.
  // Idempotent + best-effort; run on every start (cheap), not only first-spawn, so it
  // also covers a pre-existing daemon picking up a project whose .gitignore lacks it.
  ensureGitignored(process.cwd())

  if (isAlreadyRunning()) {
    // Singleton already up — load offset so the catch-up sees the right position,
    // do a catch-up forward, then exit (hook has a 15s timeout).
    loadPersistedOffset(filePath)
    console.error('[tokenscope-fwd] singleton already running — performing catch-up forward')
    await catchUpForward(filePath)
    return
  }

  // First session in this container — become the singleton.
  // Load persisted offset to resume from where a prior daemon left off
  // (handles container restart with same span file still present).
  loadPersistedOffset(filePath)
  const startedAt = claimSingleton()
  process.on('exit', removePidFile)
  process.on('SIGTERM', () => {
    removePidFile()
    process.exit(0)
  })
  process.on('SIGINT', () => {
    removePidFile()
    process.exit(0)
  })

  console.error(
    `[tokenscope-fwd] started (pid=${process.pid}), tailing ${filePath} every ${FORWARD_INTERVAL_MS}ms`,
  )

  // Workstream D §10.1 — an enterprise-managed `telemetry` block can silently kill
  // the file exporter Copilot writes to (this forwarder's ENTIRE input) while the
  // emit credential still mints a healthy bearer. Check ONCE at start (best-effort,
  // NEVER blocks/aborts startup — a detection failure must not stop real forwarding)
  // and log LOUDLY so this is diagnosable from forwarder.log even though nothing else
  // here would ever explain "zero spans forever" on its own.
  try {
    const managed = await detectManagedTelemetry()
    if (managed.classification === 'hostile') {
      console.error(
        `[tokenscope-fwd] WARNING: an enterprise-managed Copilot telemetry setting (source: ${managed.source}) is HOSTILE to the file exporter — Copilot itself may never write to ${filePath} regardless of COPILOT_OTEL_FILE_EXPORTER_PATH. Run the tokenscope-status skill for detail; this is a policy-level block, not a credential problem.`,
      )
    } else if (managed.classification === 'unknown') {
      console.error(
        `[tokenscope-fwd] managed-telemetry check was inconclusive (source: ${managed.source}) — cannot confirm the file exporter is unblocked. ${managed.serverManagedNote}`,
      )
    }
  } catch (err) {
    // Best-effort diagnostic only — never let a detector bug break real forwarding.
    console.error(`[tokenscope-fwd] managed-telemetry check itself failed (non-fatal): ${String(err)}`)
  }

  // Catch-up forward first (may have orphaned spans from a prior killed session).
  await catchUpForward(filePath)

  // Start the periodic forward loop.
  startDaemonLoop(filePath, startedAt)

  // Keep the process alive until a SIGTERM / SIGINT.
  // The timer is unref'd so it won't prevent exit — we keep ourselves alive
  // by a keep-alive interval that IS ref'd.
  setInterval(
    () => {
      /* keepalive */
    },
    60 * 60 * 1000,
  )
}

// Only run main() when executed directly (not when imported as a module for testing).
// Same pattern as copilot-redeem.mjs — makes L5 forwarder unit tests possible.
if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  main().catch((err) => {
    console.error(`[tokenscope-fwd] fatal: ${String(err)}`)
    process.exit(1)
  })
}
