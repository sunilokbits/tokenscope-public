/*
 * POST /api/v1/setup/enroll { enrollment_secret, claimed_email, device_binding }
 * — the NO-LOGIN emit-on-install enroll path (slice 3).
 *
 * docs/design/emit-on-install-provisional-attribution.md §Flows 1. The Insight
 * plugin is distributed privately and bundles a rotatable enrollment secret; on
 * install it calls THIS endpoint (no OAuth, no human) to obtain a durable
 * emit-only credential + the OTel bundle, bound to a SERVER-CHOSEN instance and a
 * PROVISIONAL shadow teammate keyed on the claimed email. Usage then emits
 * immediately, attributed `identity_state=provisional` until the human signs in
 * and explicitly confirms (slice 5).
 *
 * Threat-model invariants enforced here:
 *   - GATE: the bundled secret is the ONLY externally-distinguishable outcome —
 *     a bad/expired/revoked secret is the endpoint's sole 401, returned before any
 *     teammate/instance work.
 *   - PROVISIONAL ONLY: locate-or-create a provisional shadow teammate; NEVER link
 *     to / look up a real teammate (no existence oracle, no laundering bridge).
 *   - SERVER-CHOSEN id: the instance id is minted server-side (randomUUID), never
 *     from client input.
 *   - EMIT-ONLY: the credential is minted via issueInstanceEmitCredentialTx(
 *     issueEmitCredential) — scope tokenscope.emit ONLY; no scope param is read,
 *     no internal client is registered.
 *   - CONSTANT-SHAPE: the response is byte-shape identical regardless of whether
 *     the claimed email already exists anywhere — only server-minted material is
 *     returned, never a canonicalised email or any teammate field.
 *   - FRESH + CAPPED: every enroll mints a NEW provisional instance and
 *     credential, even for a (claimed_email, device_binding) seen before; an
 *     existing instance's id or credential is never returned, revoked or
 *     rotated. A global + per-email provisional cap returns 429.
 *
 * The response carries one-time credential material → Cache-Control: no-store
 * (mirrors /setup/redeem + the OAuth token endpoint). Shape mirrors
 * /setup/redeem so the local write helper is reused verbatim.
 *
 * NO RLS LANE, and this is a DESIGN question rather than an oversight
 * (docs/design/rls-enforcement.md; tracked as an explicit residue in
 * scripts/check-handler-rls-context.mjs). Its sibling /setup/redeem DOES adopt a
 * context mid-transaction, and the difference between them is the whole reason:
 *
 *   - redeem's `teammate_id` comes from a handoff the server minted behind a
 *     completed OAuth consent. It is a fact.
 *   - enroll's identity is `claimed_email` — a string in the request body, by
 *     design never verified (that is what "provisional until confirmed" means).
 *     The shadow teammate this handler may CREATE is downstream of that claim.
 *
 * Adopting it would let the caller pick its own RLS identity by picking an
 * email, which is the laundering vector the confirm-on-auth gate
 * (server/auth/confirm-instance.ts) exists to close. The honest options are a
 * dedicated bounded enrolment identity, or the RLS-DISABLE of every table this
 * path touches — both design decisions, not handler decisions. It writes
 * `teammate`, `instance_attestation`, `oauth_token` and `audit_event`, ALL of
 * which are RLS-enabled, so it works only because all four are in server/db/rls-bootstrap.ts::RLS_BOOTSTRAP_TABLES and are
 * DISABLEd before the app becomes a non-owner. An earlier version of this header
 * said phase 1 left it "unaffected" because its tables were policy-free or out of
 * the FORCE set: both halves were false, and the audit write in particular would
 * have 500'd every enrolment at the role switch.
 */
import {
  createError,
  defineEventHandler,
  getHeader,
  getRequestIP,
  readValidatedBody,
  setResponseHeaders,
} from 'h3'
import { assertTrustedPublicOrigin } from '../../../utils/public-url'
import { z } from 'zod'
import { getDb } from '../../../db'
import { issueEmitCredential } from '../../../auth/emit-credential'
import { issueInstanceEmitCredentialTx, buildOtelBundle } from '../../../auth/emit-provision'
import {
  verifyEnrollmentSecret,
  locateOrCreateProvisionalInstance,
} from '../../../auth/enroll-provision'
import { recordAuditEvent } from '../../../db/audit'

const Body = z.object({
  enrollment_secret: z.string().min(1).max(512),
  claimed_email: z.string().email().max(320),
  device_binding: z.string().min(1).max(512),
  // The emitting client. A SERVER-SIDE discriminator (mirrors provision_emit /
  // emit-provision.ts's `tool`) so a Copilot enroll returns the copilot-shaped
  // bundle (tool=copilot-cli + the copilot telemetry block) directly, instead of
  // the Copilot client regex-rewriting tool= in a claude bundle — that stopgap
  // silently mis-labels spend as claude-code if the attr-string format shifts.
  // Defaults to 'claude-code' so an existing Claude enroll (which omits the field)
  // is byte-for-byte unchanged.
  tool: z.enum(['claude-code', 'copilot-cli']).default('claude-code'),
})

export default defineEventHandler(async (event) => {
  setResponseHeaders(event, { 'Cache-Control': 'no-store', Pragma: 'no-cache' })
  // BEFORE anything is consumed. This request commits its transaction before the
  // bundle is built, and that transaction takes a PROVISIONAL-CAP SLOT (a new
  // instance_attestation row) and mints an emit credential. There is no one-time
  // code here -- the enrollment secret is reusable -- so the cost of a late
  // refusal is a cap slot burned and a credential minted for a device that is
  // then told no, for a purely server-side fault.
  assertTrustedPublicOrigin(event)
  const { enrollment_secret, claimed_email, device_binding, tool } = await readValidatedBody(
    event,
    (d) => Body.parse(d),
  )
  const db = getDb()

  // GATE. A bad/expired/revoked secret is the endpoint's ONLY 401 and the only
  // outcome an attacker can distinguish — checked before any teammate/instance work.
  if (!(await verifyEnrollmentSecret(db, enrollment_secret))) {
    throw createError({ statusCode: 401, statusMessage: 'Invalid enrollment secret' })
  }

  // Canonicalise for dedup + the cap counters only — NEVER echoed back (no oracle).
  const claimedEmail = claimed_email.trim().toLowerCase()
  // Audit IP/UA are best-effort and must NEVER crash the enroll (audit.ts already
  // normalises junk; getRequestIP itself throws when there's no socket).
  let ip: string | null = null
  try {
    ip = getRequestIP(event, { xForwardedFor: true }) ?? null
  } catch {
    ip = null
  }
  const ua = getHeader(event, 'user-agent') ?? null

  // ONE transaction for create → mint → audit, mirroring /setup/redeem: a
  // mid-sequence failure (incl. a throwing audit) rolls everything back. The emit
  // mint's per-instance advisory xact lock lives inside it.
  const result = await db.transaction(async (tx) => {
    const located = await locateOrCreateProvisionalInstance(
      tx as never,
      claimedEmail,
      device_binding,
      tool,
    )
    if ('capExceeded' in located) {
      throw createError({ statusCode: 429, statusMessage: 'Enrollment capacity reached' })
    }

    // EMIT-ONLY. issueEmitCredential hard-literals scope 'tokenscope.emit'; the
    // Tx wrapper binds it to the instance created above, which has no prior
    // credential to rotate.
    const emit = await issueInstanceEmitCredentialTx(
      tx as never,
      located.teammateId,
      located.instanceId,
      issueEmitCredential,
    )

    await recordAuditEvent(tx as never, {
      eventType: 'instance-enrolled-provisional',
      actorTeammateId: located.teammateId,
      actorSystem: 'setup-enroll',
      subjectKind: 'instance',
      subjectId: located.instanceId,
      payload: { identity_state: 'provisional', tool },
      ipAddress: ip,
      userAgent: ua,
    })

    return { instanceId: located.instanceId, emit }
  })

  // Provisional enroll mints UNASSIGNED (untagged): no project. buildOtelBundle
  // owns the public-origin derivation and its trust check (durable endpoints).
  const { bearerEndpoint, oauthTokenEndpoint, bundle } = buildOtelBundle(
    event,
    result.instanceId,
    null,
    tool,
  )

  // CONSTANT-SHAPE: every field is either server-minted THIS request or derived
  // ONLY from the request's own `tool` — identical regardless of whether
  // claimed_email exists anywhere. No canonicalised email, no teammate field. The
  // bundle/telemetry key vary by the CLIENT's chosen tool, never by email
  // existence, so this is no oracle. Shape
  // mirrors /setup/redeem (telemetry.copilot for copilot-cli, telemetry.claude else)
  // so the matching client write helper is reused verbatim.
  const telemetry = tool === 'copilot-cli' ? { copilot: bundle } : { claude: bundle }
  return {
    instance_id: result.instanceId,
    session_id: result.instanceId, // legacy alias (redeem/exchange parity)
    bearer_endpoint: bearerEndpoint,
    oauth_refresh_token: result.emit.refreshToken,
    oauth_token_endpoint: oauthTokenEndpoint,
    oauth_client_id: result.emit.clientId,
    project_code: null, // provisional enroll is untagged; tagged per-repo/session later
    unassigned: true,
    tool,
    telemetry,
  }
})
