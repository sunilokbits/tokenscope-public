/*
 * OAuth 2.1 Authorization Server core (ADR-0005 — the credential pathway).
 *
 * Ported from a sibling project's lib/oauth/* (Redis) to TokenScope's Postgres/Drizzle.
 * Provides: client register/validate (RFC 7591), PKCE S256 validate (RFC 7636),
 * auth-code issue/consume (single-use, atomic), and token issue/refresh/revoke.
 *
 * Hashing: client secrets, auth codes, and access/refresh tokens are stored
 * only as HMAC-SHA-256 hashes (hashSessionToken). The raw value is returned to
 * the client once and never persisted — same discipline as
 * instance_attestation.session_token_hash.
 *
 * Errors: throws OAuthError with an RFC 6749 string `error` code. The endpoint
 * handlers translate that into the RFC-6749 JSON body { error, error_description }
 * the MCP SDK requires (NOT the RFC-9457 problem+json our own APIs use).
 */
import { createHash, randomBytes, timingSafeEqual } from 'node:crypto'
import { and, eq, isNull, sql } from 'drizzle-orm'
import type { PostgresJsDatabase } from 'drizzle-orm/postgres-js'
import { hashSessionToken, constantTimeEqualHex } from './hmac'
import { oauthClient, oauthAuthCode, oauthToken } from '../../drizzle/schema'
import { clientNameSchema, MAX_REDIRECT_URIS, REDIRECT_URI_MAX_LEN } from '../../shared/schemas/oauth'

// ── Scopes ────────────────────────────────────────────────────────────────
//
// A deliberately small set for the MVP: read (authenticated dashboard-style
// reads — "my projects / tags / budget"), tag (the agentic self-tag write — the
// MCP `tag_session` tool; granted ALONGSIDE read on the read credential, never on
// emit), and emit (the ingest-refresh scope ADR-0005 E1 keeps separate from read).
// Mirrors a sibling project's VALID_SCOPES but TokenScope-shaped.
export const OAUTH_SCOPES = ['tokenscope.read', 'tokenscope.tag', 'tokenscope.emit'] as const
export type OAuthScope = (typeof OAUTH_SCOPES)[number]

export function isValidScope(s: string): s is OAuthScope {
  return (OAUTH_SCOPES as readonly string[]).includes(s)
}

// Scopes a PUBLIC client may obtain via the interactive authorization_code flow.
// `tokenscope.emit` is DELIBERATELY excluded: the broadly-readable durable emit
// credential must NEVER be issued over the LLM-adjacent client channel — it is
// minted ONLY via the internal emit-credential path (setup exchange) and the
// provision_emit→redeem handoff (process→server). Restricting the consent flow
// here closes the second, un-isolated route to an emit credential (adversarial R1
// F1; mcp-client-backbone §"Emit-credential isolation").
export const INTERACTIVE_GRANTABLE_SCOPES: readonly string[] = ['tokenscope.read', 'tokenscope.tag']

/**
 * The INTERACTIVE-grantable subset of a requested scope string, defaulting to
 * `tokenscope.read` when no scope was requested. Single source of truth for
 * "what will actually be granted" — authorize.get.ts's consent-page info fetch
 * uses this to RENDER the permission list and authorize.post.ts uses the SAME
 * function to ISSUE the grant, so the two can never drift (S6 Consent (b)). An
 * unknown/unrecognised scope in the request is silently dropped, never echoed.
 */
export function computeGrantedScopes(scopeParam: string | undefined): OAuthScope[] {
  if (!scopeParam) return ['tokenscope.read']
  return scopeParam
    .split(' ')
    .filter((s): s is OAuthScope => Boolean(s) && (INTERACTIVE_GRANTABLE_SCOPES as readonly string[]).includes(s))
}

// ── Lifetimes ───────────────────────────────────────────────────────────────
/** Auth code: 5 min, single-use (RFC 6749 recommends ≤10 min). */
export const AUTH_CODE_TTL_MS = 5 * 60 * 1000
/** Access token: 30 days (matches a sibling project's PAT-as-access-token lifetime). */
export const ACCESS_TOKEN_TTL_MS = 30 * 24 * 60 * 60 * 1000
/**
 * Refresh token: 90 days. For a credential bound to a LIVE device this is an
 * IDLE window, renewed on every use (`deviceIdleWindowEnd`); every other
 * credential keeps it as a fixed lifetime from issuance.
 */
export const REFRESH_TOKEN_TTL_MS = 90 * 24 * 60 * 60 * 1000

/**
 * `now() + REFRESH_TOKEN_TTL_MS` as SQL — the horizon a live emitting device and
 * its bound credential renew to on use. The device (`ts_expected_end`, renewed by
 * /bearer and re-provisioning) and the credential (`refresh_expires_at`, renewed
 * by refresh) share it so neither outlives the other by more than a refresh
 * cycle. Always applied through GREATEST: renewal never shortens.
 */
export function deviceIdleWindowEnd() {
  return sql`now() + make_interval(secs => ${REFRESH_TOKEN_TTL_MS / 1000})`
}
/**
 * Grace window for the access token a refresh supersedes (AUTH-3): the old
 * hash stays valid this long after the refresh so concurrent refreshers
 * sharing one refresh token don't invalidate each other's access tokens.
 */
export const ACCESS_TOKEN_GRACE_MS = 60 * 1000

/** OAuth error with an RFC 6749 string error code. */
export class OAuthError extends Error {
  constructor(
    public readonly code: string,
    message: string,
  ) {
    super(message)
    this.name = 'OAuthError'
  }
}

type Db = PostgresJsDatabase<Record<string, unknown>>

// ── Redirect URI validation (RFC 8252 — loopback only) ──────────────────────
const LOOPBACK_HOSTS = ['localhost', '127.0.0.1', '[::1]']
export function isValidRedirectUri(uri: string): boolean {
  try {
    const parsed = new URL(uri)
    if (parsed.protocol === 'http:' && LOOPBACK_HOSTS.includes(parsed.hostname)) return true
    // Also accept 127.0.0.0/8 (RFC 8252 §7.3 allows the whole loopback range).
    if (parsed.protocol === 'http:' && /^127\.\d+\.\d+\.\d+$/.test(parsed.hostname)) return true
    return false
  } catch {
    return false
  }
}

// ── PKCE ────────────────────────────────────────────────────────────────────
/**
 * Validate a code_verifier against a stored code_challenge. S256 only.
 * Constant-time comparison on the computed challenge.
 */
export function validatePkce(codeVerifier: string, codeChallenge: string, method: string): boolean {
  if (method !== 'S256') return false
  // S256: BASE64URL(SHA256(code_verifier)) === code_challenge.
  const computed = createHash('sha256').update(codeVerifier).digest('base64url')
  if (computed.length !== codeChallenge.length) return false
  return timingSafeEqual(Buffer.from(computed), Buffer.from(codeChallenge))
}

// ── Clients (RFC 7591) ──────────────────────────────────────────────────────
export interface RegisteredClient {
  clientId: string
  clientSecret: string
  clientName: string
  redirectUris: string[]
  /** RFC 7591 `client_secret_expires_at` — unix seconds. See MAX_CLIENT_SECRET_AGE_MS. */
  clientSecretExpiresAt: number
}

/**
 * Reserved client_name no public registrant may claim — it belongs to the
 * internal emit client. Trust rides on the `internal` column, not this name;
 * the reservation is defence-in-depth so the name can't be squatted.
 */
export const RESERVED_EMIT_CLIENT_NAME = 'tokenscope-emit'

/**
 * Coarse DoS backstop: the public registration endpoint is unauthenticated, so
 * cap the TOTAL number of oauth_client rows. A generous ceiling — real MCP
 * clients number in the low dozens; this only stops a registration-flood. No
 * Redis; a COUNT(*) per registration is cheap.
 */
export const MAX_OAUTH_CLIENTS = 1000

/**
 * Absolute ceiling on oauth_client rows: at or above it EVERY registration is
 * refused, whatever the source. Separate from the per-source + global rule
 * below, which never denies a fresh source.
 */
export const HARD_MAX_OAUTH_CLIENTS = 10 * MAX_OAUTH_CLIENTS

/**
 * Client secrets are bounded, not eternal (S6 — a never-expiring secret was
 * part of the original registration root cause). A year is generous for the
 * MVP's low-dozens client scale (mirrors MAX_OAUTH_CLIENTS' "generous
 * ceiling" posture) — enforced against the client row's OWN created_at in
 * validateClientCredentials, so no schema/migration is needed to carry it.
 */
export const MAX_CLIENT_SECRET_AGE_MS = 365 * 24 * 60 * 60 * 1000

/**
 * Per-source registration ceiling (S6 Ceiling fix), alongside the global one.
 * Root cause: a single global COUNT(*) ceiling turned ANY one anonymous
 * caller's write volume into a durable denial of every first-time MCP
 * onboarding. The global cap alone is therefore too blunt — once it's
 * saturated, EVERY registrant is refused regardless of who caused it.
 *
 * The fix reserves headroom: the global ceiling only ever denies a caller
 * whose OWN recent registration volume is non-trivial. A low-volume new
 * registrant is never blocked by someone else's flood (below the separate
 * HARD_MAX_OAUTH_CLIENTS, which refuses everyone). This in-memory sliding
 * window (no Redis in MVP, consistent with the global cap's "no Redis; a
 * COUNT(*) is cheap" posture) is per-process — it blunts a single-replica
 * flood rather than providing airtight cross-replica limiting, and the
 * session-gc.ts abandonment sweep reclaims a flood's rows within the hour
 * regardless of which replica served it.
 */
const SOURCE_WINDOW_MS = 60 * 60 * 1000
export const SOURCE_REGISTRATION_LIMIT = 20
const recentRegistrationsBySource = new Map<string, number[]>()

function recentSourceRegistrationCount(source: string, now: number): number {
  const timestamps = recentRegistrationsBySource.get(source)
  if (!timestamps) return 0
  const cutoff = now - SOURCE_WINDOW_MS
  const live = timestamps.filter((ts) => ts > cutoff)
  if (live.length > 0) recentRegistrationsBySource.set(source, live)
  else recentRegistrationsBySource.delete(source)
  return live.length
}

function recordSourceRegistration(source: string, now: number): void {
  const timestamps = recentRegistrationsBySource.get(source) ?? []
  timestamps.push(now)
  recentRegistrationsBySource.set(source, timestamps)
}

/**
 * Register a new dynamic PUBLIC client; returns the raw secret ONCE.
 *
 * Always writes `internal = false` — the internal emit client is created ONLY
 * by ensureEmitClient (no public path can set the flag). Rejects the reserved
 * emit client_name and enforces the registration ceilings (DoS backstop).
 *
 * `source` (typically the caller IP) drives the per-source ceiling — optional
 * so a non-HTTP caller of this helper degrades to the global cap only, same
 * as before this fix.
 */
export async function registerClient(
  db: Db,
  input: { clientName?: string; redirectUris: string[]; source?: string },
): Promise<RegisteredClient> {
  if (!input.redirectUris || input.redirectUris.length === 0) {
    throw new OAuthError('invalid_client_metadata', 'At least one redirect_uri is required')
  }
  // Bounds re-asserted here (not just at the HTTP schema) so a non-HTTP caller
  // of this helper is bounded too (S6 Bounds fix). Same schema the HTTP layer
  // uses (shared/schemas/oauth.ts) — one definition, two enforcement points.
  if (input.redirectUris.length > MAX_REDIRECT_URIS) {
    throw new OAuthError(
      'invalid_client_metadata',
      `At most ${MAX_REDIRECT_URIS} redirect_uris are allowed`,
    )
  }
  for (const uri of input.redirectUris) {
    if (uri.length > REDIRECT_URI_MAX_LEN) {
      throw new OAuthError(
        'invalid_redirect_uri',
        `redirect_uri must be at most ${REDIRECT_URI_MAX_LEN} characters`,
      )
    }
    if (!isValidRedirectUri(uri)) {
      throw new OAuthError(
        'invalid_redirect_uri',
        `Invalid redirect_uri: ${uri}. Must be loopback http:// (localhost / 127.0.0.0/8 / ::1).`,
      )
    }
  }

  const clientName = input.clientName || 'MCP Client'
  const nameCheck = clientNameSchema.safeParse(input.clientName)
  if (!nameCheck.success) {
    throw new OAuthError(
      'invalid_client_metadata',
      nameCheck.error.issues[0]?.message ?? 'Invalid client_name',
    )
  }
  // Reserved-name guard: the internal emit client's name is off-limits to public
  // registrants (even though identity is the `internal` flag, not the name).
  if (clientName === RESERVED_EMIT_CLIENT_NAME) {
    throw new OAuthError('invalid_client_metadata', 'client_name is reserved')
  }

  const now = Date.now()
  const source = input.source ?? 'unknown'

  // Registration ceilings (coarse DoS backstop on the unauthenticated endpoint).
  // At HARD_MAX_OAUTH_CLIENTS deny everyone; otherwise deny ONLY when the global
  // ceiling is saturated AND this source's own recent volume is non-trivial —
  // see the Ceiling doc comment above.
  // The ceiling checks, the insert and the per-source record hold one
  // transaction-scoped advisory lock, so concurrent registrations cannot all
  // read a count below a ceiling and then all insert.
  const clientSecret = randomBytes(32).toString('hex')
  const row = await db.transaction(async (tx) => {
    await tx.execute(sql`SELECT pg_advisory_xact_lock(hashtext('oauth_client_registration'))`)
    const countRows = await tx.execute<{ count: string }>(
      sql`SELECT COUNT(*)::text AS count FROM oauth_client`,
    )
    const globalCount = Number([...countRows][0]?.count ?? 0)
    const sourceCount = recentSourceRegistrationCount(source, now)
    if (globalCount >= HARD_MAX_OAUTH_CLIENTS) {
      throw new OAuthError('temporarily_unavailable', 'Client registration limit reached')
    }
    if (globalCount >= MAX_OAUTH_CLIENTS && sourceCount >= SOURCE_REGISTRATION_LIMIT) {
      throw new OAuthError('temporarily_unavailable', 'Client registration limit reached')
    }
    const [inserted] = await tx
      .insert(oauthClient)
      .values({
        clientSecretHash: hashSessionToken(clientSecret),
        clientName,
        redirectUris: input.redirectUris,
        internal: false,
      })
      .returning({ clientId: oauthClient.clientId, createdAt: oauthClient.createdAt })
    if (inserted) recordSourceRegistration(source, now)
    return inserted
  })

  if (!row) throw new OAuthError('server_error', 'Client registration failed')

  const clientSecretExpiresAt = Math.floor(
    (new Date(row.createdAt).getTime() + MAX_CLIENT_SECRET_AGE_MS) / 1000,
  )

  return {
    clientId: row.clientId,
    clientSecret,
    clientName,
    redirectUris: input.redirectUris,
    clientSecretExpiresAt,
  }
}

export interface ClientRow {
  clientId: string
  clientName: string
  redirectUris: string[]
  internal: boolean
}

export async function getClient(db: Db, clientId: string): Promise<ClientRow | null> {
  // clientId is a uuid PK; a malformed (non-uuid) value would throw at the DB
  // layer. Guard so a bad client_id yields a clean null (→ invalid_client).
  if (!isUuid(clientId)) return null
  const [row] = await db
    .select({
      clientId: oauthClient.clientId,
      clientName: oauthClient.clientName,
      redirectUris: oauthClient.redirectUris,
      internal: oauthClient.internal,
    })
    .from(oauthClient)
    .where(eq(oauthClient.clientId, clientId))
    .limit(1)
  return row ?? null
}

/** Validate client_id + client_secret. Returns the client if valid, else null. */
export async function validateClientCredentials(
  db: Db,
  clientId: string,
  clientSecret: string,
): Promise<ClientRow | null> {
  if (!isUuid(clientId)) return null
  const [row] = await db
    .select({
      clientId: oauthClient.clientId,
      clientName: oauthClient.clientName,
      redirectUris: oauthClient.redirectUris,
      internal: oauthClient.internal,
      clientSecretHash: oauthClient.clientSecretHash,
      createdAt: oauthClient.createdAt,
    })
    .from(oauthClient)
    .where(eq(oauthClient.clientId, clientId))
    .limit(1)
  if (!row) return null
  if (!constantTimeEqualHex(hashSessionToken(clientSecret), row.clientSecretHash)) return null
  // Bounded client secrets (S6): a secret past MAX_CLIENT_SECRET_AGE_MS
  // authenticates as invalid, same as a wrong one — RFC 6749 doesn't
  // distinguish "wrong" from "expired" client credentials, so there is no
  // separate error surface to leak which case applies. The internal emit
  // client never reaches this function (token.post.ts routes it through a
  // secretless public-client path), but `!row.internal` guards it anyway.
  if (!row.internal && Date.now() - new Date(row.createdAt).getTime() > MAX_CLIENT_SECRET_AGE_MS) {
    return null
  }
  return {
    clientId: row.clientId,
    clientName: row.clientName,
    redirectUris: row.redirectUris,
    internal: row.internal,
  }
}

// ── Authorization codes (single-use) ────────────────────────────────────────
/** Issue an auth code bound to a teammate; returns the raw code for the redirect. */
export async function issueAuthCode(
  db: Db,
  params: {
    clientId: string
    teammateId: string
    redirectUri: string
    scope: string
    codeChallenge: string
    codeChallengeMethod: string
  },
): Promise<string> {
  const code = randomBytes(32).toString('hex')
  await db.insert(oauthAuthCode).values({
    codeHash: hashSessionToken(code),
    clientId: params.clientId,
    teammateId: params.teammateId,
    redirectUri: params.redirectUri,
    codeChallenge: params.codeChallenge,
    codeChallengeMethod: params.codeChallengeMethod,
    scope: params.scope,
    expiresAt: new Date(Date.now() + AUTH_CODE_TTL_MS),
  })
  return code
}

export interface ConsumedAuthCode {
  id: string
  clientId: string
  teammateId: string
  redirectUri: string
  scope: string
  codeChallenge: string
  codeChallengeMethod: string
}

/**
 * Consume an auth code: atomically mark it consumed iff it was unconsumed AND
 * not expired AND its teammate is still active. The
 * `consumed_at IS NULL AND expires_at > now()` predicate + RETURNING makes this
 * a single-statement compare-and-swap — concurrent exchanges of the same code
 * see at most one success (replay-safe).
 *
 * DEACTIVATION is in the CAS predicate, not a follow-up read, so a deactivation
 * landing concurrently with an exchange cannot be straddled. A code minted
 * BEFORE the teammate was deactivated must not be exchangeable AFTER it: the
 * cleanup worker inspects existing oauth_token rows before retiring an account
 * (privileged-identity-cleanup.ts's has_live_token gate) but an OUTSTANDING auth
 * code is invisible to it, so this is the one path by which a retired account
 * could re-arm itself with a fresh 30-day token pair.
 *
 * A refused code is left UNBURNED (the CAS simply matches no row) and the caller
 * reports the same opaque invalid_grant as for an unknown code — no
 * deactivation oracle. Unburned is deliberate and not a weakening: the code is
 * useless while the account is retired, its TTL is 5 minutes
 * (AUTH_CODE_TTL_MS), and holding it still requires the raw secret.
 */
export async function consumeAuthCode(db: Db, rawCode: string): Promise<ConsumedAuthCode | null> {
  const codeHash = hashSessionToken(rawCode)
  const rows = await db.execute<{
    id: string
    client_id: string
    teammate_id: string
    redirect_uri: string
    scope: string
    code_challenge: string
    code_challenge_method: string
  }>(sql`
    UPDATE oauth_auth_code
       SET consumed_at = now()
     WHERE code_hash = ${codeHash}
       AND consumed_at IS NULL
       AND expires_at > now()
       AND EXISTS (
             SELECT 1 FROM teammate tm
              WHERE tm.id = oauth_auth_code.teammate_id
                AND tm.is_active IS TRUE
           )
    RETURNING id::text AS id,
              client_id::text AS client_id,
              teammate_id::text AS teammate_id,
              redirect_uri,
              scope,
              code_challenge,
              code_challenge_method
  `)
  const row = [...rows][0]
  if (!row) return null
  return {
    id: row.id,
    clientId: row.client_id,
    teammateId: row.teammate_id,
    redirectUri: row.redirect_uri,
    scope: row.scope,
    codeChallenge: row.code_challenge,
    codeChallengeMethod: row.code_challenge_method,
  }
}

/** Call in the exchange transaction, after issueTokens succeeds. */
export async function markAuthCodeTokenIssued(db: Db, authCodeId: string): Promise<void> {
  await db.update(oauthAuthCode).set({ tokenIssuedAt: sql`now()` }).where(eq(oauthAuthCode.id, authCodeId))
}

/**
 * Did `teammateId`'s code yield a token? Not `consumed_at`: a failed exchange
 * sets that too. Unknown / another teammate's code → `false` (no oracle).
 */
export async function isAuthCodeRedeemed(db: Db, rawCode: string, teammateId: string): Promise<boolean> {
  const [row] = await db
    .select({ tokenIssuedAt: oauthAuthCode.tokenIssuedAt })
    .from(oauthAuthCode)
    .where(and(eq(oauthAuthCode.codeHash, hashSessionToken(rawCode)), eq(oauthAuthCode.teammateId, teammateId)))
    .limit(1)
  return !!row?.tokenIssuedAt
}

// ── Tokens ──────────────────────────────────────────────────────────────────
export interface IssuedTokens {
  access_token: string
  token_type: 'bearer'
  expires_in: number
  refresh_token: string
  scope: string
}

/**
 * Issue an access + refresh token pair for an authorized teammate.
 *
 * This is the ONLY place an oauth_token row is created — both the interactive
 * authorization_code exchange (api/v1/oauth/token.post.ts) and the durable emit
 * credential (auth/emit-credential.ts::issueEmitCredential, reached from
 * /setup/redeem and /setup/enroll) land here. The is_active gate therefore makes
 * "no OAuth credential is ever minted for a deactivated teammate" true at the
 * choke point rather than once per caller.
 *
 * For the authorization_code lane this is a BACKSTOP: consumeAuthCode already
 * refuses in its CAS, and the interactive /authorize that mints the code needs a
 * cookie session, which isRevoked() (server/utils/auth.ts) gates on the same
 * column. For the emit lane it is likewise defence in depth:
 *   - /setup/redeem requires a handoff minted by an authenticated caller;
 *   - /setup/enroll either creates a fresh provisional shadow (is_active
 *     defaults TRUE) or REUSES one, and a reusable shadow is necessarily still
 *     active — the only thing that retires a shadow is confirm-instance.ts,
 *     which flips the instance to identity_state='confirmed' in the same
 *     transaction, and enroll-provision.ts's reuse predicate matches only
 *     identity_state='provisional' rows.
 * So neither door is reachable with a deactivated teammate today. This gate is
 * here so that stays true for callers added later. A throw on the emit lane
 * surfaces as a 500 (redeem/enroll translate their own failures, not
 * OAuthError) — acceptable for a branch no traced path reaches, and strictly
 * better than minting.
 */
export async function issueTokens(
  db: Db,
  params: { teammateId: string; clientId: string; scope: string },
): Promise<IssuedTokens> {
  const scopeArray = params.scope ? params.scope.split(' ').filter(Boolean) : []
  if (scopeArray.length === 0) {
    throw new OAuthError('invalid_scope', 'At least one scope is required')
  }
  // Defence in depth — the scope string was validated at /authorize but
  // re-validate here in case the stored code was tampered with.
  const invalid = scopeArray.filter((s) => !isValidScope(s))
  if (invalid.length > 0) {
    throw new OAuthError('invalid_scope', `Invalid scope(s): ${invalid.join(', ')}`)
  }

  const accessToken = randomBytes(32).toString('base64url')
  const refreshToken = randomBytes(32).toString('base64url')
  const now = Date.now()

  /*
   * The deactivation gate is IN the INSERT, not a read before it.
   *
   * It was a `SELECT is_active` followed by `db.insert(...)`. Both statements
   * are correct in isolation, and between them is a window: a deactivation
   * landing there is straddled, and the mint proceeds on a teammate the check
   * just declared active. That window is exactly what the sibling gates on this
   * axis were written to avoid — `consumeAuthCode` puts the predicate in its
   * compare-and-swap and `refreshAccessToken` puts it in the UPDATE's join,
   * both with the reasoning spelled out — and this function's own docstring
   * calls itself the choke point where "no OAuth credential is ever minted for
   * a deactivated teammate" becomes true. A choke point with a read-then-write
   * race does not make that sentence true; it makes it nearly true.
   *
   * INSERT … SELECT … WHERE EXISTS is the single-statement form: the row is
   * written only if the teammate is active as of the INSERT's own snapshot.
   * Zero rows inserted ⇒ the gate refused, and we raise the same `invalid_grant`
   * the read-then-write form did — no new error surface for callers.
   *
   * WHAT THIS DOES NOT BUY. Under READ COMMITTED it removes the application-level
   * window, not every window: a deactivation that COMMITS just after this
   * statement's snapshot is taken is still not seen, so a token row can be
   * written moments before the account is retired. Closing that needs the
   * deactivation side to take a row lock and revoke tokens in the same
   * transaction, which is a change to the cleanup worker, not to this function.
   * The residual is inert in practice — every consumer re-checks `is_active` on
   * use (requireOAuthBearer, refreshAccessToken), so such a token authorises
   * nothing — but it would become live again if the account were ever
   * reactivated, and it should not be described as "no interval at all".
   *
   * FAIL CLOSED is unchanged and is now structural: a missing teammate row, or
   * a NULL/false `is_active` (mig 0001 declares the column NOT NULL DEFAULT
   * TRUE, so NULL is not expected), all fail `is_active IS TRUE` and insert
   * nothing. `IS TRUE`, not `= TRUE`, so a NULL yields false rather than NULL.
   *
   * Written as raw SQL because drizzle's `.insert().values()` builds INSERT …
   * VALUES, which has no room for a predicate. Column list mirrors the schema
   * (drizzle/schema/auth.ts) — the remaining columns take their defaults, as
   * they did before.
   */
  const inserted = await db.execute<{ id: string }>(sql`
    INSERT INTO oauth_token (
      access_token_hash, refresh_token_hash, client_id, teammate_id, scope,
      access_issued_at, access_expires_at, refresh_issued_at, refresh_expires_at
    )
    SELECT ${hashSessionToken(accessToken)},
           ${hashSessionToken(refreshToken)},
           ${params.clientId}::uuid,
           ${params.teammateId}::uuid,
           ${params.scope},
           ${new Date(now).toISOString()}::timestamptz,
           ${new Date(now + ACCESS_TOKEN_TTL_MS).toISOString()}::timestamptz,
           ${new Date(now).toISOString()}::timestamptz,
           ${new Date(now + REFRESH_TOKEN_TTL_MS).toISOString()}::timestamptz
     WHERE EXISTS (
             SELECT 1 FROM teammate tm
              WHERE tm.id = ${params.teammateId}::uuid
                AND tm.is_active IS TRUE
           )
    RETURNING id::text AS id
  `)
  if ([...inserted].length === 0) {
    throw new OAuthError('invalid_grant', 'The teammate is not active')
  }

  return {
    access_token: accessToken,
    token_type: 'bearer',
    expires_in: Math.floor(ACCESS_TOKEN_TTL_MS / 1000),
    refresh_token: refreshToken,
    scope: params.scope,
  }
}

/**
 * Refresh: NON-ROTATING (ADR-0005). Re-mint a fresh ACCESS token IN PLACE on the
 * existing oauth_token row, keeping the SAME refresh token live and reusable
 * across cycles. Revocation — not rotation — is the control: the row's
 * revoked_at (explicit revoke, or the E2 teammate-revocation cascade), the
 * teammate's deactivation, or its bound device ending is what kills a refresh,
 * never the act of using it.
 *
 * This is the durable-emission fix: the headless emit helper re-presents the
 * same env refresh token every ~29min; a rotating scheme would invalidate it on
 * the first refresh and recreate the silent-death. The returned `refresh_token`
 * is the SAME one the caller presented (echoed for RFC-6749 conformance).
 *
 * SLIDING EXPIRY, DEVICE-BOUND ONLY. A bound credential that passes the gate has
 * `refresh_expires_at` renewed to `deviceIdleWindowEnd()`. Without it the
 * headless helper hit a hard wall 90 days after redeem with no interactive path
 * to recover. Unbound credentials keep the fixed lifetime, because a user
 * re-consents those interactively.
 *
 * Atomicity + checks in ONE UPDATE (compare-and-swap on the matched row):
 *   - refresh_token_hash matches, row live (revoked_at IS NULL), not expired,
 *     owned by this client_id;
 *   - E2 (ADR-0005): the bound teammate must NOT have been revoked at/after the
 *     refresh credential was granted (teammate.revoked_at > oauth_token.refresh_issued_at)
 *     — a revoked teammate can no longer mint fresh access tokens via refresh.
 *     refresh_issued_at (not the per-refresh-bumped access_issued_at) is the
 *     stable anchor. The join is in the UPDATE so the race is closed in-statement.
 *   - DEACTIVATION: `tm.is_active IS TRUE`. A separate, durable axis from E2 —
 *     no timestamp comparison, because a retired account has no "after" to be on
 *     the right side of. The privileged-identity-cleanup worker only ever sets
 *     is_active=FALSE (never revoked_at), so without this a cleaned account
 *     refreshes itself a fresh access token every ~29 minutes, indefinitely.
 *     `IS TRUE` (not `= TRUE`) so a NULL fails CLOSED rather than yielding NULL.
 *   - DEVICE LIVENESS: a credential bound to a device (`instance_id`) refreshes
 *     only while that device is live, unpurged and owned by the same teammate.
 *     Ending a device (revoke, re-provision, session-gc) therefore ends its
 *     credential's ability to refresh. Unbound credentials (read/tag, legacy
 *     emit) are not device-gated.
 * No match ⇒ invalid_grant (replayed/expired/revoked refresh, revoked teammate,
 * DEACTIVATED teammate, or an ended/foreign bound device).
 */
export async function refreshAccessToken(
  db: Db,
  refreshToken: string,
  clientId: string,
): Promise<IssuedTokens> {
  const refreshHash = hashSessionToken(refreshToken)
  const newAccessToken = randomBytes(32).toString('base64url')
  const now = Date.now()
  const accessExpiresAt = new Date(now + ACCESS_TOKEN_TTL_MS)
  const accessIssuedAt = new Date(now)

  // Re-issue ONLY the access token (hash + issued/expiry) on the existing row.
  // The refresh token row stays live; we do NOT revoke it and do NOT rotate it.
  // The OUTGOING hash is parked one-deep in prev_access_token_hash with a ~60 s
  // grace horizon (mig 0044, AUTH-3): concurrent refreshers sharing this refresh
  // token (one instance per host) would otherwise invalidate each other's access
  // tokens in a ping-pong. SET expressions read the OLD row values, so
  // `prev_access_token_hash = t.access_token_hash` captures the superseded hash.
  const rows = await db.execute<{ teammate_id: string; scope: string }>(sql`
    UPDATE oauth_token t
       SET prev_access_token_hash = t.access_token_hash,
           prev_valid_until  = now() + make_interval(secs => ${ACCESS_TOKEN_GRACE_MS / 1000}),
           access_token_hash = ${hashSessionToken(newAccessToken)},
           access_issued_at  = ${accessIssuedAt.toISOString()},
           access_expires_at = ${accessExpiresAt.toISOString()},
           last_used_at      = now(),
           refresh_expires_at = CASE
             WHEN t.instance_id IS NULL THEN t.refresh_expires_at
             ELSE GREATEST(t.refresh_expires_at, ${deviceIdleWindowEnd()})
           END
      FROM teammate tm
     WHERE t.teammate_id = tm.id
       AND t.refresh_token_hash = ${refreshHash}
       AND t.revoked_at IS NULL
       AND t.refresh_expires_at > now()
       AND t.client_id = ${clientId}::uuid
       AND NOT (tm.revoked_at IS NOT NULL AND tm.revoked_at > t.refresh_issued_at)
       AND tm.is_active IS TRUE
       AND (
         t.instance_id IS NULL
         OR EXISTS (
           SELECT 1 FROM instance_attestation ia
            WHERE ia.instance_id = t.instance_id
              AND ia.teammate_id = t.teammate_id
              AND ia.ts_actual_end IS NULL
              AND ia.ts_purged IS NULL
         )
       )
    RETURNING t.teammate_id::text AS teammate_id, t.scope AS scope
  `)
  const row = [...rows][0]
  if (!row) {
    throw new OAuthError('invalid_grant', 'Refresh token is invalid, expired, or revoked')
  }

  return {
    access_token: newAccessToken,
    token_type: 'bearer',
    expires_in: Math.floor(ACCESS_TOKEN_TTL_MS / 1000),
    refresh_token: refreshToken,
    scope: row.scope,
  }
}

/**
 * Revoke a refresh token (RFC 7009). Idempotent and silent — revokes the row if
 * one matches; otherwise no-op. The endpoint always returns 200 regardless.
 */
export async function revokeRefreshToken(db: Db, refreshToken: string, clientId: string): Promise<void> {
  const refreshHash = hashSessionToken(refreshToken)
  // RFC 7009 §2.1: a client may only revoke a token issued TO IT. Bind the
  // revoke to the authenticated client so a registered client can't revoke
  // another client's token even if it learns the raw value (R2 LOW).
  await db
    .update(oauthToken)
    .set({ revokedAt: new Date() })
    .where(
      and(
        eq(oauthToken.refreshTokenHash, refreshHash),
        eq(oauthToken.clientId, clientId),
        isNull(oauthToken.revokedAt),
      ),
    )
}

// ── helpers ──────────────────────────────────────────────────────────────────
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i
function isUuid(s: string): boolean {
  return UUID_RE.test(s)
}
