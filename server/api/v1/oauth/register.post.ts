/*
 * Dynamic Client Registration — RFC 7591.
 *
 * MCP clients (Claude Code) call this to register before the OAuth flow. No
 * user session required — the endpoint is the entry point of the flow. Returns
 * the RFC 6749 OAuth error shape { error, error_description } on failure (the
 * MCP SDK requires a string `error`), NOT TokenScope's RFC-9457 problem+json.
 *
 * NOTE: no assertSameOrigin here — this is a programmatic (non-browser) OAuth
 * endpoint hit by a CLI, so the cookie-CSRF threat model doesn't apply.
 *
 * NO RLS LANE, by design ruling (docs/design/rls-enforcement.md §5; tracked as
 * an explicit residue in scripts/check-handler-rls-context.mjs). Registration is
 * the FIRST call of the OAuth flow — it runs before any consent, so no teammate
 * exists to scope by, and `oauth_client` (which it writes) has no RLS at all.
 * The audit row it writes is `audit_event`, which DOES have RLS enabled and whose
 * policy admits only platform-admin — so this write is possible
 * solely because `audit_event` is in server/db/rls-bootstrap.ts::RLS_BOOTSTRAP_TABLES and is DISABLEd before the role switch.
 * Deferring its FORCE phase would not have helped: ENABLE alone filters a
 * non-owner, and this insert would have failed the moment the role changed.
 */
import { defineEventHandler, readValidatedBody, getHeader, getRequestIP, setResponseHeaders, setResponseStatus } from 'h3'
import { consola } from 'consola'
import { registerClient, OAuthError } from '../../../auth/oauth'
import { recordAuditEvent } from '../../../db/audit'
import { getDb } from '../../../db'
import { registrationRequestSchema } from '../../../../shared/schemas/oauth'

export default defineEventHandler(async (event) => {
  setResponseHeaders(event, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' })

  let body
  try {
    body = await readValidatedBody(event, (d) => registrationRequestSchema.parse(d))
  } catch {
    setResponseStatus(event, 400)
    return { error: 'invalid_client_metadata', error_description: 'Invalid registration request' }
  }

  const db = getDb()
  // Source key for the per-source registration ceiling (S6 Ceiling fix); never
  // crashes registration. With AZURE_FRONT_DOOR_ID set, key on X-Azure-SocketIP
  // (the TCP peer Front Door saw; X-Azure-ClientIP follows a caller's
  // X-Forwarded-For); otherwise the same best-effort capture as
  // setup/enroll.post.ts. Both are caller-controlled on a publicly reachable
  // origin, because require-front-door trusts X-Azure-FDID, which is not a
  // secret. HARD_MAX_OAUTH_CLIENTS is the bound that holds regardless.
  let ip: string | null
  try {
    const frontDoorSocketIp = process.env.AZURE_FRONT_DOOR_ID
      ? getHeader(event, 'x-azure-socketip')?.trim()
      : undefined
    ip = frontDoorSocketIp || getRequestIP(event, { xForwardedFor: true }) || null
  } catch {
    ip = null
  }
  try {
    const client = await registerClient(db, {
      clientName: body.client_name,
      redirectUris: body.redirect_uris,
      source: ip ?? 'unknown',
    })

    await recordAuditEvent(db, {
      eventType: 'oauth_client_register',
      actorSystem: 'oauth',
      subjectKind: 'oauth_client',
      payload: {
        client_id: client.clientId,
        client_name: client.clientName,
        redirect_uris: client.redirectUris,
      },
    })

    setResponseStatus(event, 201)
    return {
      client_id: client.clientId,
      client_secret: client.clientSecret,
      client_name: client.clientName,
      redirect_uris: client.redirectUris,
      grant_types: ['authorization_code', 'refresh_token'],
      token_endpoint_auth_method: 'client_secret_post',
      client_id_issued_at: Math.floor(Date.now() / 1000),
      // Bounded (S6) — see MAX_CLIENT_SECRET_AGE_MS; enforced in
      // validateClientCredentials against the client row's own created_at.
      client_secret_expires_at: client.clientSecretExpiresAt,
    }
  } catch (err) {
    if (err instanceof OAuthError) {
      // The registration cap surfaces as a 429 (Too Many Requests) — a coarse
      // DoS backstop, distinct from a 400 client-metadata error.
      const status = err.code === 'temporarily_unavailable' ? 429 : 400
      setResponseStatus(event, status)
      return { error: err.code, error_description: err.message }
    }
    consola.error('[oauth:register] failed', err instanceof Error ? err.message : err)
    setResponseStatus(event, 500)
    return { error: 'server_error', error_description: 'Registration failed. Please try again.' }
  }
})
