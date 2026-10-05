// SYNC NOTE: Auto-generated copy for standalone copilot-plugin distribution. Source: plugin/scripts/mcp-origin.mjs. Re-generate with: npm run sync:copilot-plugin
/**
 * Where is the TokenScope MCP server ACTUALLY registered?
 *
 * WHY THIS EXISTS. A one-time emit-handoff code can only be redeemed at the
 * server that minted it. The server returns an absolute `redeem_url`, but that
 * value reaches the redeem helper by way of the MODEL, which is why the helpers
 * do not take the destination from argv: `--redeem-url` is gone and `--api-base`
 * may only SELECT among origins this device already knows (argv-guard.mjs).
 * Nothing in the prompt layer can substitute for that — the Claude grant is a
 * PREFIX grant (`…claude-redeem.mjs":*`) under which any argv tail is
 * pre-approved, and Copilot CLI has no grant mechanism at all.
 *
 * That leaves a gap. An operator who registered the MCP server at their own URL
 * has a helper that still resolves the BAKED default, so the handoff is minted
 * by their server and redeemed against ours. Reading the registration from
 * local configuration closes it without reintroducing the model as an input:
 * these files are written by the human who ran the registration, never by the
 * model in-conversation.
 *
 * Order is most-specific-first WITHIN user-scope configuration: the entry the
 * human registered for THIS directory beats their global entry, which beats the
 * OTHER client's user config, which beats whatever shipped in the plugin bundle.
 *
 * "The other client's" is why callers must name themselves. The two CLIs can be
 * installed side by side on one host and registered against DIFFERENT servers --
 * a sandbox in one, production in the other -- and a handoff code is only
 * redeemable at the server that minted it. A fixed order that always read
 * Claude's config first meant Copilot's redeem resolved Claude's origin whenever
 * both were present, so the Copilot code was POSTed to the server that never
 * minted it. That fails, but it fails as a 401 with no hint that the wrong host
 * was chosen, and on a host where both point at real-but-different environments
 * it silently crosses them.
 *
 * Note the difference between using the working directory as a KEY and reading a
 * file FROM it. Selecting `projects[cwd]` out of the user's own `~/.claude.json`
 * is safe: a checked-out repository cannot add entries to that file, so cwd only
 * chooses among registrations the human already authored. Reading the repo's own
 * `.mcp.json` would be the opposite, and is deliberately not done (see
 * discoverMcpOrigin).
 *
 * Discovery NEVER throws. Every candidate is best-effort; an unreadable file, a
 * malformed JSON document, or a non-URL value simply falls through to the next.
 * The caller decides what an exhausted search means.
 */
import { existsSync, readFileSync, realpathSync } from 'node:fs'
import { join } from 'node:path'
import { realHome } from './real-home.mjs'

/** Pull `mcpServers.tokenscope.url`'s origin out of one JSON file. */
function originFromMcpConfig(path) {
  try {
    if (!existsSync(path)) return null
    const doc = JSON.parse(readFileSync(path, 'utf8'))
    const url = doc?.mcpServers?.tokenscope?.url
    if (typeof url !== 'string' || !url) return null
    return new URL(url).origin
  } catch {
    return null
  }
}

/** The url→origin step, shared by both shapes. */
function originOf(url) {
  if (typeof url !== 'string' || !url) return null
  try {
    return new URL(url).origin
  } catch {
    return null
  }
}

/** The working directory, symlinks resolved, since that is how Claude keys it. */
function currentProjectKey() {
  try {
    return realpathSync(process.cwd())
  } catch {
    return process.cwd()
  }
}

/**
 * Claude Code keeps user-scope MCP servers in `~/.claude.json`, either at the
 * top level or under a per-project key. Both shapes are checked because the
 * scope a human chose at registration time is not knowable here.
 *
 * Only THIS directory's project entry is consulted. Scanning every project and
 * taking the first match would let an unrelated project's registration decide
 * where this one's handoff code is redeemed — for a developer with a production
 * enrolment in one checkout and a sandbox in another, that silently crosses the
 * two, and whichever wins depends on JSON key order rather than on anything the
 * human chose.
 */
function originFromClaudeUserConfig(home) {
  const path = join(home, '.claude.json')
  try {
    if (!existsSync(path)) return null
    const doc = JSON.parse(readFileSync(path, 'utf8'))
    const scoped = originOf(doc?.projects?.[currentProjectKey()]?.mcpServers?.tokenscope?.url)
    if (scoped) return scoped
    return originOf(doc?.mcpServers?.tokenscope?.url)
  } catch {
    // Unreadable or not JSON — treat as "no registration here".
    return null
  }
}

/**
 * Resolve the registered MCP origin, or null.
 *
 * @param {string} scriptsDir absolute path of the calling script's directory,
 *   used to locate the plugin's own bundled `.mcp.json` as the last resort.
 * @param {{client: 'claude'|'copilot', home?: string}} opts
 *   `client` is REQUIRED and names the CLI whose handoff is being redeemed, so
 *   that CLI's own registration is consulted before the other's. It has no
 *   default on purpose: a default would be silently wrong for exactly one of
 *   the two callers, which is the bug this parameter exists to fix, and a
 *   caller that forgets it should fail loudly at the call rather than quietly
 *   redeem against the wrong host.
 *   `home` defaults to the account's PASSWD home
 *   and exists so a test can point the lookup somewhere without moving `$HOME`,
 *   which by design no longer works. Production never passes it.
 *
 * `realHome()` rather than `os.homedir()` is load-bearing: homedir() trusts
 * `$HOME`, and what this function returns becomes the API base a one-time
 * handoff code is POSTed to. A leaked or planted HOME pointing at a directory
 * holding a crafted `.claude.json` would therefore name that destination -- the
 * same breach the repo-supplied TOKENSCOPE_API_BASE fix closes, reached through
 * the filesystem instead of the environment. The passwd entry cannot be moved
 * by an env var. This is not hypothetical: plugin-runtime.mjs's realHome()
 * docstring records a live incident where a leaked HOME silently broke exports.
 */
export function discoverMcpOrigin(scriptsDir, { client, home = realHome() } = {}) {
  if (client !== 'claude' && client !== 'copilot') {
    throw new TypeError(
      `discoverMcpOrigin requires client: 'claude' | 'copilot' (got ${JSON.stringify(client)})`,
    )
  }
  // The calling CLI's OWN registration, then the other's. Both are user-scope
  // config written by the human who ran the registration, so both are trusted
  // inputs; only their ORDER is in question, and the caller's own is the one
  // that minted the code being redeemed.
  const claudeProbe = () => originFromClaudeUserConfig(home)
  const copilotProbe = () => originFromMcpConfig(join(home, '.copilot', 'mcp-config.json'))
  const ownFirst = client === 'copilot' ? [copilotProbe, claudeProbe] : [claudeProbe, copilotProbe]
  const candidates = [
    // NOTE: the working directory's own `.mcp.json` is deliberately NOT a
    // candidate, even though Claude Code supports project-scoped registration
    // there. That file is REPO-SUPPLIED, and what this function returns becomes
    // the API base a one-time handoff code is POSTed to. Honouring it would let
    // any checked-out repository redirect a live single-use credential to a host
    // of its choosing — the same hole plugin-runtime.mjs's safeProcessEnv
    // already closes by listing TOKENSCOPE_API_BASE in
    // REPO_UNTRUSTED_ENV_KEYS_NO_RESTORE ("deleted outright and never
    // restored"). Re-opening it through a file instead of an env var would be
    // the same defect wearing a different hat. User-scope config is written by
    // the human who ran the registration; a repo is not.
    ...ownFirst,
    // Whatever shipped in the bundle. This is the BAKED default: correct for a
    // stock install, wrong for a custom registration, hence last. Both plugins
    // ship a literal URL here; a ${VAR} template is never expanded (it would let
    // a repository choose where a credential goes) and yields null.
    () => originFromMcpConfig(join(scriptsDir, '..', '.mcp.json')),
    () => originFromMcpConfig(join(scriptsDir, '.mcp.json')),
  ]
  for (const probe of candidates) {
    const origin = probe()
    if (origin) return origin
  }
  return null
}
