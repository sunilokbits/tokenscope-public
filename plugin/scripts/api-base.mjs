/*
 * Resolve the TokenScope API base URL.
 *
 * The API base is PART OF THE PLUGIN, not a user-managed env var: the plugin
 * ships from a specific deployment's marketplace, so it already implies its
 * server. Resolution order, most-explicit first:
 *   1. explicit arg             — the caller named it outright, so nothing
 *      ambient should be able to override that. The env var used to win here,
 *      which meant a stale exported TOKENSCOPE_API_BASE silently beat a base the
 *      caller had just passed in.
 *   2. TOKENSCOPE_API_BASE env, BUT ONLY WHEN IT NAMES LOOPBACK — the documented
 *      local-dev override (http://localhost:3450). An off-box value is ignored
 *      outright: a cloned repository can supply this variable and there is no way
 *      to tell a repo-injected value from a shell-exported one, so "point it at
 *      another deployment" is not a capability this resolver can safely offer.
 *      Use --api-base, or register that server as your MCP server, instead.
 *   3. discovered               — the MCP registration the human actually made
 *      with `claude mcp add` (see mcp-origin.mjs). NOT a stock install: a plugin
 *      that ships its own .mcp.json is not recorded in ~/.claude.json at all, so
 *      most installs have nothing to discover and land on 4.
 *   4. DEFAULT_API_BASE         — the baked deployment URL (below).
 *
 * The marketplace serves the plugin straight from the repo (no build step), so
 * the default is committed here. It's a public hostname, not a secret.
 *
 * DEFAULT_API_BASE is the GBS Dev environment's stable custom domain
 * (tokenscope.example.com, behind IT's WAF) — the dogfood + pilot target as
 * of 2026-06-17, superseding the old sandbox Front Door host. A custom domain is
 * used deliberately (the random *.azurefd.net suffix regenerates if the endpoint
 * is recreated). The OTLP ingestion endpoint, bearer endpoint and emit credential
 * are NOT baked here — they are returned by THIS deployment's server at provision
 * time (server/auth/emit-provision.ts), so pointing at dev is the whole switch.
 * Sandbox stays reachable via the TOKENSCOPE_API_BASE override.
 */
import { assertSafeEndpoint, unsafeEndpointError } from './endpoint-guard.mjs'

export const DEFAULT_API_BASE = 'https://ca-tscope-sandbox-wus3.wittydune-91621c23.westus3.azurecontainerapps.io'

/**
 * Is this base one only somebody already ON the machine could be served by?
 *
 * The whole reason TOKENSCOPE_API_BASE is dangerous is that it can name an
 * OFF-BOX destination: a cloned repository supplies it (Claude Code merges a
 * repo's `.claude` env over the global one), and there is no way to tell a
 * repo-injected value from a shell-exported one — they are the same
 * `process.env`. A loopback value cannot express that threat. To be served by
 * `127.0.0.1` an attacker must already be running a process on the developer's
 * machine, and a cloned repo does not run until the developer runs it, at which
 * point the machine is compromised by a much shorter path than an env var.
 *
 * Same reasoning `isPublicOriginTrusted` uses server-side for a loopback Host,
 * so the two halves of the system agree on where the trust boundary is.
 */
function isLoopbackBase(value) {
  try {
    const u = new URL(value)
    // Scheme FIRST. A loopback hostname alone is not enough: `assertSafeEndpoint`
    // takes an early exit for loopback (that is the documented dev exception),
    // so it does not re-check the scheme, and `ftp://127.0.0.1` or
    // `gopher://[::1]` would sail through to become an "API base" that fails
    // later and confusingly. This gate is the one that has to say http(s).
    if (u.protocol !== 'http:' && u.protocol !== 'https:') return false
    const h = u.hostname.replace(/^\[|\]$/g, '').toLowerCase()
    return h === 'localhost' || h === '127.0.0.1' || h === '::1'
  } catch {
    return false
  }
}

/**
 * Resolve the API base (explicit arg > loopback env override > discovered
 * registration > baked default), trailing slash stripped, VALIDATED before it is
 * returned (S1 fix 2/3).
 *
 * WHY THE ARG OUTRANKS EVERYTHING. This used to read env-first, on the general
 * principle that an operator's environment overrides a script default. That is
 * right when the arg IS a default, and wrong here, because the argument the
 * redeem flow passes is not a default: it is the origin of the server that
 * MINTED the one-time handoff code, returned by that server in the same
 * response. A handoff can only be redeemed at its issuer, so a stale
 * TOKENSCOPE_API_BASE outranking it does not "override a default", it sends a
 * live single-use secret to a host that cannot honour it — silently, since the
 * wrong host simply 404s.
 *
 * WHY THE ENV SOURCE IS NOW LOOPBACK-ONLY, and why there is no longer a
 * `trustEnv` flag. That flag defaulted to TRUE with `trustEnv: false` as the
 * opt-out, which made "is this safe?" mean "did we enumerate every caller?" —
 * a question answered from memory, and answered wrong. The redeem helpers were
 * hardened and both ENROL doors kept the old precedence for weeks, carrying the
 * org-wide enrollment secret outbound and the durable emit destination back.
 * By the time every caller passed `false`, the flag's only remaining value was
 * `false`, so the branch was already unreachable and deleting it is provably
 * behaviour-preserving rather than merely tidier. A parameter whose safe setting
 * has to be remembered is the defect; a required parameter would only have made
 * the remembering louder.
 *
 * What deletion alone would NOT have fixed is local Claude development, which
 * that state left broken: no env read, and no discoverable bundle either — see
 * `mcp-origin.mjs` on why the Claude bundle tier is structurally invisible to
 * discovery — so a local developer fell silently through to the baked dev host.
 * Gating on loopback restores exactly that case and expresses none of the
 * threat, because the threat is naming an off-box destination.
 *
 * Callers therefore inherit the safe behaviour with nothing to pass and nothing
 * to forget, which is the only form of this fix that a caller written next year
 * cannot undo by omission.
 *
 * Validating the RESOLVED base here, once, means every caller inherits the
 * endpoint guard rather than each needing its own.
 */
export function resolveApiBase(argBase, { discovered } = {}) {
  // Trim EVERY source: a whitespace-only TOKENSCOPE_API_BASE (e.g. a
  // fat-fingered `export`) is truthy and would otherwise become a garbage base.
  //
  // `discovered` sits below the loopback override: the override is a value a
  // human deliberately exported for this shell, while discovery is read from
  // config and is a better guess than the baked default but still a guess.
  const envBase = (process.env.TOKENSCOPE_API_BASE || '').trim()
  const raw =
    (argBase ?? '').trim() ||
    (isLoopbackBase(envBase) ? envBase : '') ||
    (discovered ?? '').trim() ||
    DEFAULT_API_BASE
  const stripped = raw.replace(/\/+$/, '')
  try {
    assertSafeEndpoint(stripped, { allowLoopback: true })
  } catch (err) {
    // Redact at the resolution boundary. This throw propagates to callers that
    // print err.message from a generic top-level handler, so the raw guard
    // error would put the rejected base on stdout/stderr in clear text. The
    // base can come from an env var or a discovered MCP registration, i.e. not
    // always something the user typed and already knows.
    throw unsafeEndpointError('API base', err)
  }
  return stripped
}
