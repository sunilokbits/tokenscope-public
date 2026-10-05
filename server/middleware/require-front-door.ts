/*
 * require-front-door — Azure Front Door header enforcement.
 *
 * Why this exists: TokenScope sits behind Azure Front Door Standard.
 * Standard SKU CANNOT VNet-integrate with Container Apps, so the
 * container-app ingress STAYS public (external: true). Protection is
 * via header check — AFD injects an `X-Azure-FDID` header containing
 * the AFD instance ID, and this middleware rejects any request that
 * either lacks the header or carries the wrong value.
 *
 * Without this middleware, an attacker who learns the
 * *.azurecontainerapps.io FQDN can bypass the AFD WAF entirely. AFD
 * advertises the CA FQDN in the Origin host-header, so the FQDN is not
 * a secret — header enforcement is the actual control.
 *
 * Three-phase deploy (see docs/development/sandbox-setup.md):
 *   Phase 1: AZURE_FRONT_DOOR_ID unset/empty. Middleware is a no-op;
 *            container app reachable directly. Initial provisioning.
 *   Phase 2: AFD provisioned but env var still empty (deploy hasn't
 *            rolled the new revision yet). Middleware still no-op.
 *   Phase 3: AZURE_FRONT_DOOR_ID populated. Middleware enforces;
 *            direct-to-CA hits return 403; AFD-fronted hits succeed.
 *
 * The env var rather than a hard-coded value lets the same image deploy
 * to sandbox / staging / production with each env's own AFD instance.
 *
 * AZURE_FRONT_DOOR_REQUIRED (code half only — inert until an operator/UF-4
 * wires it): when `'true'` AND `AZURE_FRONT_DOOR_ID` is still empty, the
 * middleware REFUSES every request except EXCLUDED_PATHS instead of
 * no-op'ing. This exists so an operator can close the phase-1/2 window
 * explicitly (no AFD id yet, but direct access must not be allowed) without
 * this middleware ever trying to INFER "this looks like production" on its
 * own. Unset REQUIRED preserves the exact three-phase no-op above — do not
 * remove that no-op, `UF-4` depends on it during initial provisioning.
 *
 * Excluded paths (allowed to bypass the check):
 *   - /api/health — Container Apps' internal LB calls this directly
 *     (not via AFD); blocking it would loop-restart the replicas.
 *     Note: the CA probe doesn't carry the X-Azure-FDID header, hence
 *     the bypass.
 *
 * Note on logging: we log the request path and a coarse signal of
 * whether the header was present, but NOT the expected/received ID.
 * The AFD instance ID isn't a high-value secret — it's discoverable
 * via DNS reconnaissance of the *.azurefd.net hostname — but the
 * convention across this codebase is "don't log known-good values"
 * (mirrors the HMAC-key handling).
 *
 * RFC-9457 error shape: matches validate-session.ts + the rest of the
 * codebase. type/title/status/detail under `data`.
 */
import { defineEventHandler, getHeader, createError, type H3Event } from 'h3'

const FRONT_DOOR_HEADER = 'x-azure-fdid'

// Paths that bypass the FDID check. /api/health is hit by ACA's internal
// load balancer (probes don't transit AFD); enforcing here would mark
// replicas unhealthy and trigger a restart loop. Keep this list tight —
// every excluded path is an attack surface that skips the WAF.
const EXCLUDED_PATHS = new Set<string>(['/api/health'])

// The exemption must compare the path the router dispatches (event.path up to
// '?', not URL-normalised): getRequestURL resolves dot segments, so
// `/api/v1/mcp/x/../../../health` would read as `/api/health` here while the
// router serves the MCP catch-all. No other path rejection: `.well-known`,
// OAuth query strings, MCP subpaths and /_nuxt assets must keep passing.
function routedPath(event: H3Event): string {
  const path = event.path
  const q = path.indexOf('?')
  return q === -1 ? path : path.slice(0, q)
}

// Reject. Log path + coarse header-presence signal so an operator can
// debug "the API stopped responding from my laptop" without us dumping
// the expected value to logs.
//
// We `throw createError(...)` rather than `sendError(...)`. The h3
// dispatcher catches the thrown H3Error and writes the RFC-9457 response
// envelope; using sendError() here would write the response but let
// middleware execution fall through, which can produce double-responses
// in downstream handlers. h3's own docstring recommends throw createError
// for the rejection path.
function reject(path: string, headerPresent: boolean): never {
  console.warn(`[require-front-door] rejected request path=${path} headerPresent=${headerPresent}`)
  throw createError({
    statusCode: 403,
    statusMessage:
      'Direct access to the Container App is not permitted; route via Azure Front Door.',
    data: {
      type: 'https://tokenscope.example.com/errors/front-door-required',
      title: 'Front Door required',
      status: 403,
      detail:
        'This request did not arrive through the Azure Front Door distribution that fronts TokenScope. The Container App rejects direct-to-origin traffic. If you are an operator debugging from the *.azurecontainerapps.io URL, hit /api/health (excluded) or unset AZURE_FRONT_DOOR_ID locally.',
    },
  })
}

export default defineEventHandler((event) => {
  const expected = process.env.AZURE_FRONT_DOOR_ID
  const required = process.env.AZURE_FRONT_DOOR_REQUIRED === 'true'

  // Empty env var = pre-AFD deploy phase (1 + 2 of the three-phase
  // rollout). The container app is reachable directly and the
  // middleware is a deliberate no-op until the operator wires the
  // instance ID via the workflow's `frontDoorId` input — UNLESS
  // AZURE_FRONT_DOOR_REQUIRED='true' has been explicitly set, in which
  // case the operator has said "no direct access, ever" even before the
  // ID is wired.
  if (!expected || expected.length === 0) {
    if (!required) return
    const path = routedPath(event)
    if (EXCLUDED_PATHS.has(path)) return
    reject(path, false)
  }

  const path = routedPath(event)
  if (EXCLUDED_PATHS.has(path)) return

  const received = getHeader(event, FRONT_DOOR_HEADER)

  // Header present AND matches → allow. Constant-time comparison isn't
  // needed here: the AFD instance ID isn't a secret (it's discoverable),
  // and there is no timing-attack surface — the attacker either knows
  // the ID (allowed) or doesn't (denied).
  if (typeof received === 'string' && received === expected) return

  reject(path, typeof received === 'string')
})
