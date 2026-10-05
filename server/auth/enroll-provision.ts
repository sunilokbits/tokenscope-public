/*
 * Emit-on-install enroll orchestration (slice 3 — the no-login enroll path).
 *
 * docs/design/emit-on-install-provisional-attribution.md §Flows 1. The Insight
 * plugin is distributed privately; on install it calls POST /api/v1/setup/enroll
 * with a BUNDLED enrollment secret, a CLAIMED email, and a device-binding hint.
 * The distribution channel + the bundled secret ARE the gate — there is no login.
 *
 * This module is the server-side machinery the endpoint reuses:
 *
 *   - verifyEnrollmentSecret — hash the presented secret and accept iff it
 *     matches the env bootstrap secret OR a live, non-revoked enrollment_secret
 *     row. This is the ONLY externally-distinguishable outcome of the endpoint
 *     (a failure here is the endpoint's only 401).
 *   - locateOrCreateProvisionalInstance — create a PROVISIONAL shadow teammate +
 *     a SERVER-CHOSEN instance_attestation on every call. It never returns or
 *     touches an existing instance, NEVER touches a real (provisional=false)
 *     teammate, and NEVER looks one up by email (that would be an existence
 *     oracle + a laundering bridge — forbidden by the threat model).
 *
 * The durable emit credential itself is minted by the endpoint via
 * issueInstanceEmitCredentialTx(issueEmitCredential) — scope tokenscope.emit ONLY,
 * exactly the redeem path; this module never issues credentials or threads scope.
 */
import { randomUUID } from 'node:crypto'
import { sql } from 'drizzle-orm'
import type { PostgresJsDatabase } from 'drizzle-orm/postgres-js'
import { hashSessionToken, constantTimeEqualHex } from './hmac'
import { checkEnvKeyStrength } from './key-strength'
import { advisoryGlobalCapLock, advisoryXactLock } from '../db/advisory-lock'
import { deviceIdleWindowEnd } from './oauth'
import type { EmitTool } from './emit-provision'
import { resolveDefaultRegionId, unplacedOrgUnitIdForRegion } from './placement-home'

type Db = PostgresJsDatabase<Record<string, unknown>>

/**
 * Global cap on LIVE provisional instance_attestation rows — a coarse DoS
 * backstop on the (gated but login-less) enroll endpoint, mirroring
 * MAX_OAUTH_CLIENTS on the unauthenticated /oauth/register. Generous: real
 * enrolments number in the low thousands. Env-overridable via
 * MAX_PROVISIONAL_INSTANCES.
 */
export const DEFAULT_MAX_PROVISIONAL_INSTANCES = 100_000
/**
 * Per-claimed_email cap — bounds how many LIVE provisional instances any single
 * claimed identity can accrue (an insider can't fabricate unbounded shadow
 * devices against one coworker). Env-overridable via MAX_PROVISIONAL_INSTANCES_PER_EMAIL.
 */
export const DEFAULT_MAX_PROVISIONAL_INSTANCES_PER_EMAIL = 50

export function maxProvisionalInstances(): number {
  const raw = Number(process.env.MAX_PROVISIONAL_INSTANCES)
  return Number.isFinite(raw) && raw > 0 ? raw : DEFAULT_MAX_PROVISIONAL_INSTANCES
}
export function maxProvisionalInstancesPerEmail(): number {
  const raw = Number(process.env.MAX_PROVISIONAL_INSTANCES_PER_EMAIL)
  return Number.isFinite(raw) && raw > 0 ? raw : DEFAULT_MAX_PROVISIONAL_INSTANCES_PER_EMAIL
}

/**
 * Validate a presented bundled secret. Accept iff it matches the env bootstrap
 * secret OR a LIVE (now within [not_before, not_after), not revoked)
 * enrollment_secret row. Both comparisons are over the HMAC hash; the bootstrap
 * comparison is constant-time, and the table lookup is an indexed exact-hash
 * match. Returns false for everything else — the endpoint maps that to its only
 * 401, the sole externally-distinguishable outcome.
 */
let weakBootstrapWarned = false

export async function verifyEnrollmentSecret(db: Db, rawSecret: string): Promise<boolean> {
  const hash = hashSessionToken(rawSecret)

  // 1. Bootstrap env secret (dev / pre-seed). Compared constant-time over hashes.
  // Below the shared key-strength floor the arm is ignored (fail closed); the
  // plugin's inert placeholder also scores below it.
  const bootstrap = process.env.NUXT_ENROLLMENT_SECRET
  if (bootstrap) {
    const strength = checkEnvKeyStrength('NUXT_ENROLLMENT_SECRET')
    if (!strength.ok) {
      if (!weakBootstrapWarned) {
        weakBootstrapWarned = true
        console.warn(`[enroll] bootstrap secret ignored: ${strength.message}`)
      }
    } else if (constantTimeEqualHex(hash, hashSessionToken(bootstrap))) {
      return true
    }
  }

  // 2. Durable accept-list: a live, non-revoked row whose rotation window is open.
  const rows = await db.execute<{ ok: number }>(sql`
    SELECT 1 AS ok
      FROM enrollment_secret
     WHERE secret_hash = ${hash}
       AND revoked_at IS NULL
       AND (not_before IS NULL OR not_before <= now())
       AND (not_after  IS NULL OR not_after  > now())
     LIMIT 1
  `)
  return [...rows].length > 0
}

export interface EnrolledInstance {
  instanceId: string
  teammateId: string
}

/** Returned (instead of an EnrolledInstance) when a provisional cap is hit → 429. */
export interface CapExceeded {
  capExceeded: true
}

/**
 * Default region + org_unit placement for a provisional teammate. There is no
 * authenticated identity at enroll time, so we resolve the SAME
 * lexicographic-first region jit-teammate.ts does (server/auth/placement-home.ts's
 * resolveDefaultRegionId — one shared implementation so the two lanes can never
 * pick a DIFFERENT default region), then home on that region's `__UNPLACED__`
 * holding node — a real, least-privilege RLS scope that grants nothing even
 * though the human hasn't been explicitly placed. A confirm-on-auth merge
 * re-points later.
 *
 * S3: this used to pick "the first org_unit ORDER BY path" for the SAME region
 * in one combined query — ltree sorts a region's root before its children, so it
 * landed every enrolled instance on the region ROOT, whose subtree is the whole
 * region. unplacedOrgUnitIdForRegion needs a region passed in and never invents
 * one itself (a helper that defaults the region internally would be the next
 * silent cross-region placement) — so the region is resolved FIRST, explicitly.
 */
async function defaultPlacement(db: Db): Promise<{ regionId: string; orgUnitId: string }> {
  const regionId = await resolveDefaultRegionId(db)
  if (!regionId) {
    throw new Error(
      'enroll: no region rows — seed the DB (npm run db:seed) before emit-on-install enroll',
    )
  }
  const orgUnitId = await unplacedOrgUnitIdForRegion(db, regionId)
  return { regionId, orgUnitId }
}

/**
 * Create the provisional teammate + instance for an enroll request.
 *
 * Every call mints a NEW instance, even when a live provisional instance already
 * exists for the same (claimed_email, device_binding, tool). The caller is
 * unauthenticated and both inputs are client-chosen, so an existing instance's
 * id or credential must never be returned to it, revoked or rotated
 * (TS-EDGE-01, docs/security-audit-output/security-audit-report.md).
 * device_binding is stored HMAC-hashed as a display hint only and is NEVER an
 * authentication factor.
 *
 * A global + per-email cap returns CapExceeded (→ 429). The provisional teammate
 * uses the reserved entra_oid='provisional:'||uuid namespace (excluded from the
 * real-email partial-unique index, mig 0057), provisional=true,
 * email=claimed_email — it NEVER links to or looks up a real (provisional=false)
 * teammate. The instance id is SERVER-CHOSEN (randomUUID), identity_state
 * 'provisional', claimed_email set, attestation_state 'unassigned' (untagged).
 *
 * `tool` stamps which emitting client this enrolment is for
 * (instance_attestation.tool). Defaults to 'claude-code' for callers that don't
 * pass one.
 *
 * MUST be called inside the endpoint's transaction (the caller mints the emit
 * credential + audits in the same tx so a mid-sequence failure rolls back cleanly).
 */
export async function locateOrCreateProvisionalInstance(
  db: Db,
  claimedEmail: string,
  deviceBinding: string,
  tool: EmitTool = 'claude-code',
): Promise<EnrolledInstance | CapExceeded> {
  const deviceHash = hashSessionToken(deviceBinding)

  // The caps are per-EMAIL and GLOBAL, so both are serialised before counting:
  // concurrent enrols would otherwise read the same pre-insert counts and all
  // insert past the cap. Lock order is ascending by namespace everywhere
  // (principal, globalCap); the email key alone cannot bound the global count,
  // since the caller chooses the email.
  await db.execute(advisoryXactLock('principal', claimedEmail.toLowerCase()))
  await db.execute(advisoryGlobalCapLock('provisional'))

  // Global DoS backstop first, then the per-claimed_email bound. Both count LIVE
  // rows only (ts_actual_end IS NULL AND ts_purged IS NULL), as the authenticated
  // sibling does (emit-provision.ts locateOrCreateInstance): an ended or purged
  // instance must not consume quota.
  const globalRows = await db.execute<{ count: string }>(sql`
    SELECT COUNT(*)::text AS count FROM instance_attestation
     WHERE identity_state = 'provisional' AND ts_actual_end IS NULL AND ts_purged IS NULL
  `)
  if (Number([...globalRows][0]?.count ?? 0) >= maxProvisionalInstances()) {
    return { capExceeded: true }
  }
  const emailRows = await db.execute<{ count: string }>(sql`
    SELECT COUNT(*)::text AS count FROM instance_attestation
     WHERE identity_state = 'provisional' AND claimed_email = ${claimedEmail}
       AND ts_actual_end IS NULL AND ts_purged IS NULL
  `)
  if (Number([...emailRows][0]?.count ?? 0) >= maxProvisionalInstancesPerEmail()) {
    return { capExceeded: true }
  }

  const { regionId, orgUnitId } = await defaultPlacement(db)

  // Provisional shadow teammate — reserved namespace, NEVER a real teammate. One
  // shadow per instance: confirm-instance.ts retires it on that instance's confirm.
  const provisionalOid = `provisional:${randomUUID()}`
  const teammateRows = await db.execute<{ id: string }>(sql`
    INSERT INTO teammate (entra_oid, email, display_name, role, region_id, org_unit_id, provisional)
    VALUES (${provisionalOid}, ${claimedEmail}, ${claimedEmail}, 'developer',
            ${regionId}::uuid, ${orgUnitId}::uuid, true)
    RETURNING id::text AS id
  `)
  const teammateId = [...teammateRows][0]!.id

  // Server-chosen instance id (randomUUID) — NEVER created on a client-supplied id.
  // principal_email is NULL (claimed_email carries the unverified email for
  // provisional rows, per the instance_attestation schema note). notes holds the
  // hashed device binding, read only as a display hint
  // (server/api/v1/me/provisional-instances.get.ts).
  const instanceId = randomUUID()
  await db.execute(sql`
    INSERT INTO instance_attestation
      (instance_id, principal_oid, principal_email, teammate_id, tool,
       ts_expected_end, region_id, org_unit_id, attestation_state,
       identity_state, claimed_email, notes)
    VALUES (${instanceId}::uuid, ${provisionalOid}, NULL, ${teammateId}::uuid, ${tool},
            ${deviceIdleWindowEnd()}, ${regionId}::uuid, ${orgUnitId}::uuid,
            'unassigned', 'provisional', ${claimedEmail},
            ${JSON.stringify({ device_binding_hash: deviceHash })}::jsonb)
  `)
  return { instanceId, teammateId }
}
