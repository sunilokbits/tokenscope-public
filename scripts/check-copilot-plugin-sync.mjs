#!/usr/bin/env node

/**
 * check-copilot-plugin-sync.mjs
 *
 * CI parity gate: diffs plugin/scripts/* against copilot-plugin/scripts/*,
 * ignoring the SYNC NOTE header line added by sync-copilot-plugin.mjs.
 *
 * Also verifies (PLG-9) that the baked TokenScope API host is CONSISTENT across
 * the four uncoordinated places it lives: plugin/scripts/api-base.mjs
 * (DEFAULT_API_BASE), plugin/.mcp.json (a literal URL), copilot-plugin/.mcp.json
 * (a literal URL), and copilot-plugin/scripts/enroll.mjs (its own DEFAULT_API_BASE — an
 * un-vendored file the parity check above cannot see). A partial host update
 * silently splits the plugin: MCP talks to one server while redeem/emit talk to
 * another.
 *
 * Exits 1 if any file pair differs (drift detected) or the API hosts diverge.
 * Run: npm run check:copilot-plugin-sync
 */
import { readFileSync, existsSync } from 'node:fs'
import { resolve, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

const __dir = dirname(fileURLToPath(import.meta.url))
const root = resolve(__dir, '..')

const FILES = [
  'copilot-forwarder.mjs',
  // copilot-emit.mjs / copilot-usage.mjs — the shared emit primitives and the
  // usage-extension core; both carry the credential and endpoint guards.
  'copilot-emit.mjs',
  'copilot-usage.mjs',
  'otlp-logs.mjs',
  'copilot-redeem.mjs',
  // tokenscope-project.mjs — extracted client-neutral resolver/hasher (P0-2).
  // Gated here so the vendored copilot copy can never drift from the canonical
  // plugin/scripts/ source (drift = Copilot + Claude hash the same .tokenscope
  // differently = split attribution).
  'tokenscope-project.mjs',
  'otel-headers-helper.sh',
  // endpoint-guard.mjs (S1) — the ONE endpoint validator. Gated the same way:
  // a second, un-gated (and therefore driftable) guard defeats the whole
  // point of having promoted it into one dependency-free file.
  'endpoint-guard.mjs',
  // argv-guard.mjs (S16a) — the shared validator for the flags handed to the
  // redeem helpers. Gated because the Copilot lane has no permission-grant
  // mechanism behind it: a drifted copy there is not a weaker control, it is
  // none.
  'argv-guard.mjs',
  // mcp-origin.mjs — the shared "where is the MCP server registered" resolver.
  // Gated so the vendored copy cannot drift: divergence means one client
  // redeems its handoff against a different host than the other.
  'mcp-origin.mjs',
  // real-home.mjs — the shared passwd-home resolver. Gated most sharply of all:
  // a drifted copy that fell back to os.homedir() would silently restore the
  // $HOME trust boundary this module exists to remove, on one client only.
  'real-home.mjs',
  // managed-telemetry.mjs (Workstream D §10.1) — the shared GitHub Copilot CLI
  // managed-`telemetry` detector. Gated so Copilot's vendored copy can never
  // drift from the canonical plugin/scripts/ source — a drift here means the
  // two clients disagree about whether a credential-valid probe is actually
  // emission-healthy.
  'managed-telemetry.mjs',
  // device-id.mjs (S16b) — the credential-free device-identity accessor both
  // setup prompts now call INSTEAD of naming ~/.claude/settings.json or
  // ~/.tokenscope/config.json. Gated so the copy that reads a credential store
  // can never drift from the reviewed source.
  'device-id.mjs',
  // device-store.mjs — the ONE definition of where each lane's enrolment lives
  // (config.<tool>.json / oauth-access.<tool>.json). Gated because a drifted
  // copy means the two lanes disagree about a FILENAME, and each then reads the
  // other's enrolment as absent: the exact split the module exists to end.
  'device-store.mjs',
  // trusted-git.mjs — vendored alongside the others; gated so the copy that
  // decides which `git` runs cannot drift on one client only.
  'trusted-git.mjs',
]

// Match the FULL auto-generated signature (not a bare `// SYNC NOTE:` prefix), so a
// legitimate body comment that happens to start with the prefix can't mask real drift
// by being stripped from both sides. Keep in sync with sync-copilot-plugin.mjs.
const SYNC_NOTE_SIGNATURE =
  'SYNC NOTE: Auto-generated copy for standalone copilot-plugin distribution.'

/** Strip the single auto-generated SYNC NOTE line (matched by its full signature). */
function stripSyncNote(content) {
  return content
    .split('\n')
    .filter((line) => !line.includes(SYNC_NOTE_SIGNATURE))
    .join('\n')
}

let failed = false

for (const name of FILES) {
  const canonical = resolve(root, 'plugin/scripts', name)
  const vendored = resolve(root, 'copilot-plugin/scripts', name)

  if (!existsSync(canonical)) {
    console.error(`ERROR: canonical source missing: plugin/scripts/${name}`)
    failed = true
    continue
  }
  if (!existsSync(vendored)) {
    console.error(`ERROR: vendored copy missing: copilot-plugin/scripts/${name}`)
    console.error(`  Run: npm run sync:copilot-plugin`)
    failed = true
    continue
  }

  const canonicalNorm = stripSyncNote(readFileSync(canonical, 'utf8'))
  const vendoredNorm = stripSyncNote(readFileSync(vendored, 'utf8'))

  if (canonicalNorm !== vendoredNorm) {
    console.error(
      `DRIFT: copilot-plugin/scripts/${name} is out of sync with plugin/scripts/${name}`,
    )
    console.error(`  Run: npm run sync:copilot-plugin`)
    failed = true
  }
}

if (!failed) {
  console.log('✓  copilot-plugin/scripts/ is in sync with plugin/scripts/')
}

// ── API-host consistency (PLG-9) ─────────────────────────────────────────────

/** Extract the origin (scheme://host[:port]) of a URL string, or null. */
function originOf(url) {
  try {
    return new URL(url).origin
  } catch {
    return null
  }
}

/** plugin/scripts/api-base.mjs — the exported DEFAULT_API_BASE literal. */
function apiBaseHost() {
  const src = readFileSync(resolve(root, 'plugin/scripts/api-base.mjs'), 'utf8')
  const m = src.match(/DEFAULT_API_BASE\s*=\s*'([^']+)'/)
  return m ? originOf(m[1]) : null
}

/** plugin/.mcp.json — a literal URL; a ${VAR} would let a repository choose the host (AG-CP-01). */
function claudeMcpHost() {
  const cfg = JSON.parse(readFileSync(resolve(root, 'plugin/.mcp.json'), 'utf8'))
  const url = cfg?.mcpServers?.tokenscope?.url ?? ''
  return url.includes('${') ? null : originOf(url)
}

/** copilot-plugin/.mcp.json — a literal URL (Copilot CLI does not expand ${VAR}). */
function copilotMcpHost() {
  const cfg = JSON.parse(readFileSync(resolve(root, 'copilot-plugin/.mcp.json'), 'utf8'))
  return originOf(cfg?.mcpServers?.tokenscope?.url ?? '')
}

/**
 * copilot-plugin/scripts/enroll.mjs — its OWN DEFAULT_API_BASE literal.
 *
 * A FOURTH copy, and the one this check used to miss. That file is not vendored
 * from plugin/scripts/ (Copilot's enrol writes a different on-disk contract), so
 * the parity check above cannot see it, and it is the enrol door: the call that
 * ships the bundled enrollment secret and stores whatever endpoints come back.
 * A drifted default there would point the enrol at a stale deployment while
 * every other surface agreed with itself.
 */
function copilotEnrollHost() {
  const src = readFileSync(resolve(root, 'copilot-plugin/scripts/enroll.mjs'), 'utf8')
  const m = src.match(/DEFAULT_API_BASE\s*=\s*'([^']+)'/)
  return m ? originOf(m[1]) : null
}

const hosts = [
  { where: 'plugin/scripts/api-base.mjs (DEFAULT_API_BASE)', host: apiBaseHost() },
  { where: 'plugin/.mcp.json (mcpServers.tokenscope.url, literal)', host: claudeMcpHost() },
  { where: 'copilot-plugin/.mcp.json (mcpServers.tokenscope.url)', host: copilotMcpHost() },
  { where: 'copilot-plugin/scripts/enroll.mjs (DEFAULT_API_BASE)', host: copilotEnrollHost() },
]

let hostFailed = false
for (const { where, host } of hosts) {
  if (!host) {
    console.error(`ERROR: could not extract an API host from ${where}`)
    hostFailed = true
  }
}
if (!hostFailed && new Set(hosts.map((h) => h.host)).size !== 1) {
  console.error('DRIFT: the baked TokenScope API host differs between:')
  for (const { where, host } of hosts) console.error(`  ${host}  ←  ${where}`)
  console.error(
    '  A partial update silently splits the plugin (MCP at one server, redeem at another). Update all four together.',
  )
  hostFailed = true
}
if (hostFailed) {
  failed = true
} else {
  console.log(
    `✓  API host consistent across api-base.mjs, both .mcp.json + copilot enroll (${hosts[0].host})`,
  )
}

process.exit(failed ? 1 : 0)
