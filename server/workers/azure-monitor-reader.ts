/*
 * Azure Monitor reader worker — the read joiner.
 *
 * Per docs/build/mvp-lite-epic.md §Epic 6: "Read joiner — joins
 * instance_attestation.session_id against emitted spans, writes
 * attribution_record". Per ADR-0002 cost is derived from a rate_card
 * at write time; rate_card_id + version pinned on each row (COST-7).
 *
 * Idempotency: skip writes when an attribution_record already exists
 * for the (session_id, ts_event, token_type, model) tuple.
 *
 * Atomicity: a Claude SPAN's rows are written as one unit (transaction), and a
 * provider-costed span is reconciled against what the ledger already holds for
 * it before the remainder is sliced. Both exist so that Σ(cost_usd) over a span
 * is EXACTLY the provider's figure no matter how many passes it took to get
 * there — see the "WRITE UNITS" comment on the write loop.
 *
 * Defaults to a 24-hour scan window (R1 sweep F2 — production-scale DB
 * would otherwise scan the full instance_attestation table per tick).
 * Override via opts.sinceMs or opts.sessionIds.
 *
 * Cost computation (docs/design/provider-cost-precedence.md): the PROVIDER's
 * reported cost for the span is the number. The rate card is a fallback for
 * when the provider reported nothing, and the thing that decides how one span
 * total is SLICED across our per-token-type rows. Arithmetic lives in the pure
 * server/usage/span-costing.ts; the ladder is provider -> rate card -> skip,
 * and a span skips only when neither can price it (under-reporting beats a
 * silently-zero row — R1 sweep F1 + F3).
 *
 * Pure function; BullMQ scheduling at Epic 10.
 */
import type { PostgresJsDatabase } from 'drizzle-orm/postgres-js'
import { sql } from 'drizzle-orm'
import { consola } from 'consola'
import type * as schema from '../../drizzle/schema'
import * as schemaImport from '../../drizzle/schema'
import {
  type TelemetryReader,
  type UsageRecord,
  type ParseCounters,
  emptyParseCounters,
} from '../azure/reader'
import type { SourceCoverage } from '../azure/dcr-metrics'
import { recordAuditEvent } from '../db/audit'
import { dispatchInbox, type InboxCategory } from '../notifications/dispatch'
import { canonicaliseEmail } from '../../shared/identity/email'
import { sweepStaleDismissals } from '../utils/stale-dismissals'
import { loadLifecyclePolicyResolver } from '../db/project-lifecycle-policy'
import { notifyProjectEndedRetag } from '../notifications/project-lifecycle'
import {
  tokenTypePriority,
  planSpanCosting,
  replanAgainstBooked,
  tallySpanPlan,
  emptyCostingRungCounts,
  microsToUsd,
  usdToMicros,
  type BookedSpan,
  type CostingRungCounts,
  type SpanCostPlan,
  type SpanRow,
} from '../usage/span-costing'

/**
 * One (region, day) bucket of NEWLY-WRITTEN telemetry-only spend this tick —
 * see JoinResult.telemetryOnlySpend for why this exists and what it does not
 * do (it MEASURES; it does not alarm).
 */
export interface TelemetryOnlyRegionDay {
  regionId: string
  /** UTC calendar date of ts_event, 'YYYY-MM-DD'. */
  day: string
  /** 6dp decimal string, matching attribution_record.cost_usd's format. */
  totalUsd: string
}

export interface JoinResult {
  /*
   * How many instances this run SELECTED and handed to processSession — the size
   * of the selection query's result, NOT how many had usage. The selection
   * deliberately includes every open instance with a fresh bearer mint, and
   * Claude Code mints one at startup and every ~29 min for as long as the editor
   * is open, so an idle laptop is `sessionsProcessed: 1` every tick. It is
   * evidence the reader RAN a selection, never that there was work to attribute.
   */
  sessionsProcessed: number
  attributionRowsWritten: number
  /*
   * Usage records the reader RETURNED this run, summed over every session,
   * before pricing/dedup. DIAGNOSTIC only: a healthy tick re-fetches
   * already-attributed rows (the reader re-reads from watermark −
   * WATERMARK_LOOKBACK_MS and onConflictDoNothing drops them), so "fetched > 0,
   * written 0" is the NORMAL quiet shape, not a fault.
   */
  usageRowsFetched: number
  /*
   * DIAGNOSTIC (folded from PR #316): usage records whose ts_event is STRICTLY
   * NEWER than the instance watermark — MAX(attribution_record.ts_event) already
   * written for that instance — summed over every session. It is NOT the stall
   * gate (that is `sourceCoverage`, an ingest-side signal independent of this
   * reader's output); it is the middle term of the operator's narrative "source
   * received N · reader saw M new · wrote R", which names WHICH stage lost the
   * rows. Counted at fetch time, before pricing, so a session that throws
   * mid-write still reports what it saw. Under-counts by design (out-of-order
   * events below the watermark, parse-rejects), only ever smaller.
   */
  newEventsSeen: number
  /*
   * INGEST-SIDE COVERAGE (PR #319): the DCR platform-metric verdict for this
   * tick's window — did the pipeline physically receive rows (RowsReceived_Count)
   * the joiner did not land? THE work-evidence signal the two stall alerts gate
   * on, independent of everything above (selection, watermark, parser, the LA
   * query path). Stamped by the registry entry (server/azure/dcr-metrics.ts),
   * threaded in via JoinOptions.sourceCoverage — runReadJoiner only echoes it.
   * Optional/null: a run recorded before this shipped, or a caller (recovery)
   * that ran no probe, reads as "not measured" = unknown, never as 0.
   */
  sourceCoverage?: SourceCoverage | null
  /*
   * Dismissed conversations handed BACK to the needs-tagging queue because this
   * tick's spend pushed them materially past what was dismissed (mig 0094 /
   * sweepStaleDismissals). A dismissal is a decision about an amount, so a
   * conversation that keeps emitting after being waved through has to be asked
   * about again — this counter is how that is visible in worker_run.result.
   */
  staleDismissalsReturned: number
  /*
   * Records dropped because NOTHING could price them (rung 3): no provider cost
   * AND no rate line. Kept under its historic name — it is an established
   * worker_run.result field — but note the meaning narrowed with
   * docs/design/provider-cost-precedence.md: "no rate card" alone no longer
   * drops a span, because the card no longer decides the amount. Counted per
   * RECORD, unlike costingRungs below, which counts per SPAN.
   */
  spansSkippedNoRateCard: number
  /*
   * ── Ingest-boundary rejects (S10) ──────────────────────────────────────
   * Counts of rows/fields the READER's parse boundary rejected (over-length,
   * or a control character — reader.ts's ParseCounters) before a record ever
   * reached the pricing/write logic above. Sits BESIDE spansSkippedNoRateCard
   * because the two count DIFFERENT failures: that field counts a record
   * nothing could PRICE; this one counts a record whose STRINGS were
   * rejected as unsafe before pricing was ever attempted. This is the
   * counter half of the story's non-negotiable: bounds without it are
   * strictly worse than no bounds — a too-strict regex would otherwise drop
   * real spend with nothing anywhere to show it happened.
   */
  parseCounters: ParseCounters
  /*
   * (C) — the measurement half of the audit's "count telemetry-only spend as
   * a first-class unreconcilable-spend metric per (region, day)" fix. Per
   * (region_id, day) totals of NEWLY-WRITTEN rows this tick whose cost_basis
   * = 'telemetry-only' (an unclassified/indicative provider_org, or a
   * /tokenscope:backfill re-emit) — spend that IS on the ledger but is
   * structurally excluded from reconciliation (server/reconciliation/
   * engine.ts:240 and its siblings). Alarming on its GROWTH is the audit's
   * own suggested fix, but wiring an alarm needs a decision about WHICH
   * surface pages an operator (a Diagnostics card, worker_run.result, or an
   * audit_event consumer) — a product call OUT OF SCOPE for this story
   * (UF-11). This field only makes the number visible; nothing reads it yet.
   */
  telemetryOnlySpend: TelemetryOnlyRegionDay[]
  // Membership gate (client-attribution-auth-spec §2): a project tag from a
  // teammate who is NOT assigned to that project is rejected — the project
  // attribution is withheld (it surfaces as untagged spend at reconciliation)
  // and the rejection is audited. "Tag proposes, membership disposes."
  spansSpilledUnauthorized: number
  // Project-lifecycle spill (D2): events whose ts_event is past the project's
  // end_date + grace are written UNALLOCATED (project/cou nulled, activity kept)
  // — the re-tag signal. Per-event, so a boundary-spanning conversation splits.
  spansSpilledEnded: number
  // Per-session fault isolation (ING-6): sessions whose read/join threw. One bad
  // session (reader HTTP error, malformed value, FK violation) must not abort
  // the whole tick and starve every remaining instance — the documented "silent
  // attribution stop" outage class. Errored sessions retry next tick.
  errors: number
  // Whether this run ignored the per-instance watermark and re-read the full
  // window (ING-1 daily deep-rescan). Persisted via worker_run.result so
  // shouldDeepRescan can find the last deep pass.
  deepRescan: boolean
  // Behavioural usage-signal lane (mig 0065, Copilot tool/MCP/context/turn). The
  // signal read+land runs in its OWN per-session try/catch AFTER token attribution,
  // so a signal-path fault never disturbs billing — it surfaces here, not in `errors`.
  signalRowsWritten: number
  signalErrors: number
  // Instance-cap hit on this tick's pre-query (the cap value), or null. Non-null
  // means joinable instances were NOT scanned; if the shed rows are live, their
  // spend stops attributing silently. Persisted via worker_run.result so it is a
  // queryable signal rather than a log line nobody reads.
  selectionCapHit?: number | null
  // EVIDENCE OF WHAT ACTUALLY RAN, for the recovery path. A malformed signed
  // body is dropped fail-soft, so a run intended as "90-day scoped recovery" can
  // silently execute as "7-day full-fleet tick" and still return HTTP 200 with
  // rows written. These make the two distinguishable after the fact, from
  // worker_run.result alone — never infer a recovery succeeded from row counts.
  lookbackDaysApplied?: number | null
  // True when the caller supplied explicit instance ids instead of the scheduled
  // selection. shouldDeepRescan EXCLUDES scoped runs: a scoped pass covers only
  // its own instances, so letting it satisfy the fleet-wide ING-1 deep-rescan
  // cadence would silently disarm that safety net for 24h — during exactly the
  // recovery campaign that runs many scoped batches back to back.
  scoped?: boolean
  /*
   * Which rung of the cost-precedence ladder priced each SPAN this tick
   * (docs/design/provider-cost-precedence.md §Making it visible). CLAUDE LANE
   * ONLY — Copilot is priced from AI credits and never touched a rate card, so
   * it has no ladder to report. The four counts are mutually exclusive and sum
   * to the Claude spans considered; see CostingRungCounts for what each means.
   *
   * A healthy fleet is ENTIRELY `provider`. `rateCard > 0` means our own price
   * list priced real spend, which is the unexpected case the design exists to
   * make loud — it rides worker_run.result so it is queryable, not just a log
   * line nobody reads.
   */
  costingRungs: CostingRungCounts
}

/**
 * How many of `usage` are STRICTLY newer than `watermark` — the per-instance
 * contribution to JoinResult.newEventsSeen (a diagnostic). No watermark (an
 * instance with no attribution yet) = every record is new. Strict: the watermark
 * IS the ts_event of an already-written row, so a record AT it is attributed.
 * Compared at millisecond precision on both sides. A record with an unparseable
 * ts_event (NaN) is not counted: it cannot be shown newer than anything.
 */
export function countNewerThanWatermark(
  usage: ReadonlyArray<{ tsEvent: string }>,
  watermark: Date | undefined,
): number {
  if (!watermark) return usage.length
  const wm = watermark.getTime()
  let n = 0
  for (const u of usage) {
    if (new Date(u.tsEvent).getTime() > wm) n += 1
  }
  return n
}

export interface JoinOptions {
  sessionIds?: string[]
  sinceMs?: number
  now?: Date
  /*
   * ING-1: ignore the per-instance high-water-mark and re-read each instance's
   * FULL reader window. The watermark cursors on EVENT time with a 5-minute
   * lookback, but OTLP batching/retry, laptop suspends, and Azure ingestion
   * latency routinely deliver events later than that — anything older than
   * (watermark − 5min) at read time was permanently dropped. A periodic
   * deep-rescan re-reads the window; onConflictDoNothing makes it free.
   */
  deepRescan?: boolean
  /**
   * Cap hit from the selection that produced `sessionIds`, echoed into the
   * result so it lands in worker_run.result. Only the caller that ran BOTH the
   * selection and the join can honestly correlate them, so it is passed in
   * rather than read from shared state.
   */
  selectionCapHit?: number | null
  /** True when `sessionIds` came from an operator override, not the selection. */
  scoped?: boolean
  /*
   * The ingest-side coverage verdict for this tick, measured by the caller
   * (the registry entry) BEFORE selection so it covers the selection-dead-zone
   * shape too, and echoed into JoinResult.sourceCoverage. Passed in rather than
   * probed here so runReadJoiner stays a pure joiner and telemetry-recovery /
   * the tests need no Azure metrics client.
   */
  sourceCoverage?: SourceCoverage | null
}

const DEFAULT_WINDOW_MS = 24 * 60 * 60 * 1000

// ING-1: how often the scheduled tick swaps the watermark for a full-window
// deep-rescan (recovers telemetry that arrived later than the 5-min lookback).
const DEEP_RESCAN_INTERVAL_HOURS = 24

// Liveness window on last_bearer_at for the joiner pre-query (see
// selectRecentJoinableSessionIds). The floor is what makes the knob safe: below
// one tick interval plus the emit cadence, a live instance can fall between two
// ticks and stop attributing silently — the dead-zone outage class. Widening is
// always safe (a wasted read); narrowing is not.
const DEFAULT_LIVE_BEARER_HOURS = 24 * 14
const MIN_LIVE_BEARER_HOURS = 1
// Ceiling as well as floor: Postgres throws `interval out of range` past ~1.5e12
// hours, which would fail the WHOLE tick — the same silent attribution stop the
// floor guards against, just from the other direction. 90d covers the longest
// instance lifetime (the 90d credential TTL); beyond it the extra range can only
// match rows that no longer exist.
const MAX_LIVE_BEARER_HOURS = 24 * 90

/*
 * Instance-cap hit reporting.
 *
 * A cap hit means joinable instances were NOT scanned this tick; once the shed
 * rows are live ones their spend silently stops attributing — the outage class.
 * console.warn alone is not a monitored signal (that is why read-path-health
 * exists), so it rides JoinResult → worker_run.result.
 *
 * It is threaded as a RETURN VALUE, not module state. An earlier revision parked
 * it in a module-scoped `let` that runReadJoiner consumed unconditionally — so
 * any caller passing explicit sessionIds (every test, every script, i.e. almost
 * everyone) reported whatever cap hit some unrelated earlier selection happened
 * to leave behind. Selection and join are separate calls; only the caller that
 * made both can honestly correlate them.
 */
export interface JoinableSelection {
  ids: string[]
  /** The cap value when the selection was truncated by it, else null. */
  capHit: number | null
}

/*
 * Decide whether the next scheduled joiner tick should deep-rescan (ING-1):
 * true when NO successful azure-monitor-read run in the last `intervalHours`
 * carried result.deepRescan=true. State lives in the existing worker_run
 * bookkeeping (run-health persists the result object verbatim) — no schema
 * change, and a crashed deep pass is retried on the very next tick.
 */
export async function shouldDeepRescan(
  db: PostgresJsDatabase<typeof schema>,
  opts: { intervalHours?: number } = {},
): Promise<boolean> {
  const intervalHours = opts.intervalHours ?? DEEP_RESCAN_INTERVAL_HOURS
  const rows = await db.execute<{ ok: number }>(sql`
    SELECT 1 AS ok FROM worker_run
    WHERE worker_name = 'azure-monitor-read'
      AND status = 'success'
      AND (result->>'deepRescan') = 'true'
      -- A SCOPED run (operator-supplied instance ids) deep-rescanned only its own
      -- batch, so it must not satisfy the FLEET-wide cadence. Without this, a
      -- recovery campaign of scoped batches silently suppresses the daily deep
      -- pass for 24h per batch — disarming the mechanism that recovers
      -- late-arriving telemetry for everyone else.
      AND (result->>'scoped') IS DISTINCT FROM 'true'
      AND started_at > NOW() - (${intervalHours} * INTERVAL '1 hour')
    LIMIT 1
  `)
  return rows.length === 0
}

/*
 * Fail-soft audit on the joiner hot path (ING-6): recordAuditEvent throws on
 * insert failure, which would abort the whole tick over an observability write.
 * Attribution is the product promise; the audit trail must never starve it.
 */
async function auditFailSoft(
  db: PostgresJsDatabase<typeof schema>,
  input: Parameters<typeof recordAuditEvent>[1],
): Promise<void> {
  try {
    await recordAuditEvent(db, input)
  } catch (err) {
    console.warn(`[azure-monitor-read] audit write failed (${input.eventType}); continuing: ${String(err)}`)
  }
}

// ── Copilot AI-credit pricing constant ────────────────────────────────────────
// 1 GitHub AI credit = $0.01 USD (one cent) — GitHub usage-based billing, 2026-06-01.
// GUARD THE 100× TRAP: this is $0.01 (one cent), NOT 0.01¢ (one hundredth of a cent).
// Source: official GitHub models-and-pricing docs; every plan ratio is $0.01/credit
// (Pro 1000cr/$10, Pro+ 3900/$39, Business 1900/$19, Enterprise 3900/$39);
// overage $0.01/cr. Cross-check: nano_aiu=9111525000 ⇒ 9.11 credits ⇒ $0.0911
// ≈ same call priced at Sonnet 4.6 token rates. This is INDICATIVE (no billing-API
// reconciliation in v1 — deferred to F2). Do NOT use a token rate_line for Copilot.
const COPILOT_AI_CREDIT_USD = 0.01 // $0.01 per AI credit — VERIFIED 2026-06-01

/**
 * Compute Copilot cost from nano_aiu: cost_usd = nano_aiu × 1e-11.
 * Equivalent to: (nano_aiu / 1e9) × COPILOT_AI_CREDIT_USD.
 * Only valid for tool='copilot-cli'; token rate cards are NOT used for Copilot.
 * Returns a 6-decimal string (matches computeCost format), or null if nano_aiu
 * is missing/non-finite/non-positive, rounds to zero, OR is OUT OF RANGE — the
 * caller (skippedNoCard) treats every null identically ("could not price this
 * record"), which is exactly right: an out-of-range nano_aiu is no more usable
 * than an absent one.
 *
 * (B) — bounds the Copilot lane the way the Claude lane is bounded by
 * MAX_COST_MICROS: an untrusted emit credential could stamp an absurd nano_aiu
 * (github.copilot.nano_aiu is client-asserted, same threat model as every
 * other emitter-controlled value this sprint bounds), and unlike the Claude
 * lane there is no rate card here to fall back to — so the guard is a
 * STORABILITY check, not a plausibility judgement (same framing as
 * span-costing.ts's MAX_COST_MICROS doc). Reuses usdToMicros rather than
 * re-deriving the ceiling, so the two lanes cannot drift apart.
 */
// Exported ONLY for the unit test that pins the (B) storability bound —
// every production call stays internal to this module.
export function computeCopilotCost(nanoAiu: number | undefined): string | null {
  if (nanoAiu == null || !Number.isFinite(nanoAiu) || nanoAiu <= 0) return null
  // cost_usd = (nano_aiu / 1e9) * $0.01 = nano_aiu * 1e-11
  const cost = (nanoAiu / 1e9) * COPILOT_AI_CREDIT_USD
  // L10 fix: nano_aiu values 1–99 produce costs < 1e-9, which round to "0.000000"
  // at 6dp. Compare against the toFixed(6) rounding threshold (0.0000005) rather
  // than exact zero — IEEE 754 never represents nano_aiu*1e-11 as exactly 0.0.
  // Real Copilot spans have nano_aiu in the billions; pathological tiny values
  // are skipped cleanly rather than attributed as zero cost.
  if (cost < 0.0000005) return null
  // Ceiling: reject a figure the NUMERIC(14,6) column cannot physically store
  // (or that only "fits" by being an absurd, non-credible amount well past
  // it — usdToMicros's bound is the same one MAX_COST_MICROS documents).
  if (usdToMicros(cost) === null) return null
  return cost.toFixed(6)
}

/*
 * ING-5's fixed cost-carrier order (TOKEN_TYPE_PRIORITY / tokenTypePriority)
 * now lives in server/usage/span-costing.ts, where the Claude carrier and the
 * largest-remainder tie-break also need it — one order, one definition, so the
 * three cannot drift apart. Imported above; the Copilot lane below is unchanged.
 */

/**
 * Convert nano_aiu to the native AI-credit quantity: credit_qty = nano_aiu / 1e9.
 * This is the reconciliation operand the credit lane sums (engine ai-credits path),
 * verified 2026-06-08: GitHub billing `ai_credit/usage` reports `unitType:'ai-credits'`
 * at `pricePerUnit:$0.01`, matching nano_aiu/1e9 priced by COPILOT_AI_CREDIT_USD.
 * Persisted ONCE per span (alongside cost_usd) so summing credit_qty across the
 * four token_type rows of a span does not multiply the credits. Returns a 6-decimal
 * string, or null when nano_aiu is absent/non-positive (mirrors computeCopilotCost).
 */
function computeCopilotCreditQty(nanoAiu: number | undefined): string | null {
  if (nanoAiu == null || !Number.isFinite(nanoAiu) || nanoAiu <= 0) return null
  const credits = nanoAiu / 1e9
  if (credits < 0.0000005) return null
  return credits.toFixed(6)
}

/*
 * ── The billing lane (mig 0119) ──────────────────────────────────────────────
 * docs/design/emitting-identity-and-subscription-type.md §1, §2, §5.
 *
 *   canon(emitting_email) ∈ canon(enterprise address set)  →  provider-billed
 *   canon(emitting_email) ∉ that set                       →  self-billed
 *   emitting_email absent                                  →  unknown
 *
 * DECIDED ONCE, HERE, AND NEVER RE-EVALUATED. Three earlier drafts of this
 * design classified at READ time and each broke on temporal instability: the
 * comparison ran against a MUTABLE current value, so changing a teammate's
 * email silently rewrote every historic residual, project total and budget
 * figure. Stamping ends the class — an email change, a shadow confirmation, an
 * erasure or a subscription relabel all terminate at the stamp.
 *
 * WHAT THE LANE DOES NOT DO: it does not decide who the spend belongs to. Money
 * binds to the DEVICE (instance_attestation → teammate) and always has. A
 * record whose emitting_email belongs to somebody else still attributes to the
 * instance's teammate; the address only answers "is this dollar inside the bill
 * we reconcile against".
 */
export type BillingLane = 'provider-billed' | 'self-billed' | 'unknown'

/**
 * The teammate's enterprise address set, canonicalised (§2):
 *
 *     { teammate.email } ∪ { teammate_identity_map rows for this teammate,
 *                            system='claude-code', identifier_kind='email',
 *                            is_enterprise = true }
 *
 * `is_enterprise` is the ONE functional flag on an identity — everything else
 * there (subscription_type, monthly_cost_usd) is display. It is also the remedy
 * for the failure this design expects in the field: a vanity or acquired-company
 * domain that still routes SSO is legitimate enterprise mail which fails plain
 * equality against `teammate.email`, and fails it for everyone on that domain at
 * once. Link the alias, flag it, done — for FUTURE writes.
 *
 * Canonicalised on the way in, so the caller's `.has()` is a like-for-like test.
 */
async function loadEnterpriseAddressSet(
  db: PostgresJsDatabase<typeof schema>,
  teammateId: string,
): Promise<Set<string>> {
  const rows = await db.execute<{ addr: string | null }>(sql`
    SELECT t.email AS addr FROM teammate t WHERE t.id = ${teammateId}::uuid
    UNION ALL
    SELECT m.identifier AS addr FROM teammate_identity_map m
     WHERE m.teammate_id = ${teammateId}::uuid
       AND m.system = 'claude-code'
       AND m.identifier_kind = 'email'
       AND m.is_enterprise = true
  `)
  const set = new Set<string>()
  for (const r of rows) {
    const canon = canonicaliseEmail(r.addr)
    if (canon) set.add(canon)
  }
  return set
}

/**
 * Stamp one record's lane. `emittingEmail` is already canonicalised by the
 * parser (server/azure/reader.ts); canonicalising again here is idempotent and
 * is kept deliberately, so this function is correct for ANY caller rather than
 * only for the one that happens to pre-canonicalise today.
 */
export function classifyBillingLane(
  emittingEmail: string | undefined,
  enterpriseAddresses: ReadonlySet<string>,
): BillingLane {
  const canon = canonicaliseEmail(emittingEmail)
  if (!canon) return 'unknown'
  return enterpriseAddresses.has(canon) ? 'provider-billed' : 'self-billed'
}

interface SessionRow extends Record<string, unknown> {
  instance_id: string
  teammate_id: string
  region_id: string
  org_unit_id: string
  cost_owning_unit_id: string
  project_code_hash: string
  tool: string
  // Identity provenance (mig 0057): the emitting instance's identity_state,
  // stamped onto every attribution_record this session writes. NOT NULL with a
  // 'confirmed' default on the attestation row, so it is always present.
  identity_state: string
}

interface RateLine extends Record<string, unknown> {
  unit: string
  unit_qty: string
  unit_cost_usd: string
  model: string | null
}
interface RateCardWithLines {
  id: string
  version: number
  lines: RateLine[]
}

/*
 * ── Claude span identity ──────────────────────────────────────────────────────
 *
 * One api_request = one SPAN; the KQL mv-expand fans it out into up to four
 * token-type rows (server/azure/reader.ts:399), pruning the zero-token ones.
 * Costing is per span, so the joiner must reassemble them.
 *
 * The key deliberately MIRRORS v_cost_drift's GROUP BY (mig 0045:48) minus
 * instance_id — we are already inside one instance — so the joiner's idea of a
 * span and the drift diagnostic's idea of a span are the same thing. That is
 * what makes `SUM(cost_usd) - MAX(law_cost_usd)` land at exactly 0 for a
 * provider-costed span; a finer key here (adding `model`, say) would split one
 * span into two and hand each the FULL provider figure — double-counting the
 * span in the direction that overstates the bill.
 */
function claudeSpanKey(rec: UsageRecord): string {
  return `${rec.claudeSessionId ?? ''}\0${rec.tsEvent}\0${rec.sourceRunId ?? ''}`
}

/*
 * A row's identity WITHIN its span. Order-independent (the KQL has no ORDER BY,
 * so an array index would make the allocation depend on arrival order — the
 * exact class of bug ING-5 fixed for the Copilot carrier). model is included
 * because the span key deliberately omits it: on pathological data carrying two
 * models under one request_id this keeps the rows distinct, and the one provider
 * figure is then spread across all of them rather than counted twice.
 *
 * `claudeSpanKey` + `claudeRowKey` together are EXACTLY the attribution_record
 * unique index minus instance_id — (instance_id, COALESCE(claude_session_id,''),
 * ts_event, token_type, model, COALESCE(source_run_id,'')), migrations
 * 0011+0017+0035 — which is what lets the joiner match a plan row to a ledger
 * row and back (see readBookedSpan).
 *
 * UNIQUENESS IS NOT GUARANTEED BY THE READER, so do not assume it. The Claude
 * KQL emits one row per (OTelLogs record, token type), but nothing dedups the
 * records themselves: a retried OTLP export re-delivers the same LogRecord with
 * the same timestamp and request_id, LocalCollectorReader returns whatever the
 * store holds, and with NUXT_COPILOT_NATIVE_OTEL on the reader CONCATENATES the
 * results of two separate queries (reader.ts getSessionUsage). Two records with
 * the same claudeRowKey therefore describe ONE ledger row — the second insert
 * conflicts and does nothing — so the costing plan is built over DEDUPED keys
 * (see dedupeSpanRows) rather than over records, or the allocation would spread
 * the span total across rows that collapse back into one on the way in and the
 * booked total would come out SHORT of the provider's figure.
 */
function claudeRowKey(rec: UsageRecord): string {
  return `${rec.tokenType}\0${rec.model}`
}

/*
 * Anything that can run the joiner's writes: the pool handle, or a transaction
 * opened on it. Structural on purpose — the per-span transaction and the
 * single-statement fast path share one write routine, and a nominal type would
 * force a cast at exactly the seam where the two must stay interchangeable.
 */
type JoinerExec = Pick<PostgresJsDatabase<typeof schema>, 'execute' | 'insert'>

/*
 * ── Fill-only-when-missing enrichment (mig 0119, design §5) ──────────────────
 *
 * The insert above is ON CONFLICT DO NOTHING, so a REPLAY enriches nothing: a
 * row already on the ledger keeps whatever it was first written with. That is
 * correct for amounts and dimensions, and wrong for the emitting identity —
 * without a fill path, a later backfill (design step 3, replaying Log Analytics
 * within the 90-day reach) could never turn an 'unknown' row into a real lane.
 *
 * §5's clause, reproduced EXACTLY in the SET/WHERE below:
 *
 *   emitting_email  = COALESCE(existing, excluded)
 *   emitting_org_id = COALESCE(existing, excluded)
 *   billing_lane    = CASE WHEN existing = 'unknown' THEN excluded ELSE existing END
 *
 * so an 'unknown' fills exactly once and a DECIDED lane is NEVER overwritten.
 * That asymmetry is the whole design: a present-day action must not be able to
 * re-stamp history, because a re-stamp moves historic residuals, project totals
 * and budget consumption. Amounts and dimensions are not in the SET at all.
 *
 * The SET carries ONE column beyond §5's three: `ts_recorded`, bumped so the
 * incremental aggregate-rollup re-keys the enriched day. See the statement's own
 * comment — it is a consequence of enriching, not a fourth thing being stamped.
 *
 * WHY THIS IS A SEPARATE STATEMENT AND NOT AN `ON CONFLICT … DO UPDATE`:
 * Postgres requires a conflict TARGET for DO UPDATE (unlike DO NOTHING), and the
 * only unique index on attribution_record is an EXPRESSION index —
 * (instance_id, COALESCE(claude_session_id,''), ts_event, token_type, model,
 * COALESCE(source_run_id,'')) — which drizzle cannot render: its
 * `onConflictDoUpdate({ target })` takes `IndexColumn = PgColumn`, columns only.
 * The alternative was hand-writing the whole 25-column insert as raw SQL on the
 * money write path, which is a far worse trade than a second statement.
 *
 * WHAT THE SPLIT COSTS, stated plainly: insert-then-fill is two statements, so
 * it is not atomic with the insert outside the per-span transaction. It is
 * still safe, because the fill is idempotent and MONOTONE (NULL→value,
 * 'unknown'→lane, and nothing else), so two concurrent joiners converge on the
 * same result in either order, serialised by the row lock.
 *
 * Skipped entirely when there is nothing to offer — an all-'unknown' row with no
 * address cannot enrich anything, and the watermark's 5-minute overlap re-reads
 * mostly-already-written rows on every tick.
 */
async function fillEmittingIdentity(
  exec: JoinerExec,
  values: typeof schemaImport.attributionRecord.$inferInsert,
): Promise<void> {
  const email = values.emittingEmail ?? null
  const orgId = values.emittingOrgId ?? null
  const lane = values.billingLane ?? 'unknown'
  if (email === null && orgId === null && lane === 'unknown') return
  await exec.execute(sql`
    UPDATE attribution_record SET
      emitting_email  = COALESCE(attribution_record.emitting_email, ${email}),
      emitting_org_id = COALESCE(attribution_record.emitting_org_id, ${orgId}),
      billing_lane    = CASE WHEN attribution_record.billing_lane = 'unknown'
                             THEN ${lane} ELSE attribution_record.billing_lane END,
      /*
       * THE RE-KEYING BUMP. aggregate-rollup.ts:127-132 discovers its
       * incremental day-set from ts_recorded, so a historical replay that
       * flipped a row from 'unknown' to a decided lane WITHOUT touching
       * ts_recorded moved live residuals while the persisted rollups stayed
       * stale indefinitely. Same defect class as confirm-instance.ts:278-279
       * (docs/wiki/Data-Flow.md §8 gap 6) and the same signal tagSessionTx
       * already uses for a re-tag.
       *
       * It is UNCONDITIONAL here only because the WHERE below is: that clause
       * now matches a row ONLY when this statement will actually change one of
       * the three columns, so the bump and the change are the same event. A
       * bump on a no-op replay would re-key the whole overlap window on every
       * 5-minute tick, which is a rollup recompute storm, not a fix.
       */
      ts_recorded     = now()
    WHERE instance_id = ${values.instanceId}::uuid
      AND COALESCE(claude_session_id, '') = COALESCE(${values.claudeSessionId ?? null}, '')
      AND ts_event = ${(values.tsEvent as Date).toISOString()}::timestamptz
      AND token_type = ${values.tokenType}
      AND model = ${values.model}
      AND COALESCE(source_run_id, '') = COALESCE(${values.sourceRunId ?? null}, '')
      /*
       * WILL-ACTUALLY-CHANGE guard. Stronger than the plain
       * "(email IS NULL OR org IS NULL OR lane = 'unknown')" no-op guard it
       * replaces, and it has to be: that one matches a row with a NULL
       * emitting_org_id on EVERY tick, because most emitters never report
       * organization.id at all. It still never takes a row lock on a row it
       * cannot enrich (the original guard's purpose) — it just also declines
       * rows it could lock but would write identically.
       */
      AND (
        (emitting_email  IS NULL AND ${email}::text IS NOT NULL)
        OR (emitting_org_id IS NULL AND ${orgId}::text IS NOT NULL)
        OR (billing_lane = 'unknown' AND ${lane}::text <> 'unknown')
      )
  `)
}

/*
 * Advisory-lock class for "one Claude span's ledger rows".
 *
 * The TWO-INT form is deliberate. Every other advisory lock in this codebase
 * (enroll-provision, emit-provision, tag-session, dispatch-lock) uses the
 * single-bigint form with a bare `hashtext(...)`, whose 64-bit key always has an
 * all-zero (or, for a negative hash, all-one) high word. Taking our lock in a
 * distinct class puts span locks in a key range those can never reach, so a
 * hashtext collision cannot make a span wait on the SESSION-level worker
 * dispatch lock — which is held for the entire length of a worker run and would
 * hang the joiner rather than briefly serialise it. 0x7370616E is 'span'.
 */
const SPAN_LOCK_CLASS = 0x7370616e

/*
 * What the ledger already holds for ONE Claude span, read inside the span's
 * write transaction so replanAgainstBooked can land the span exactly on the
 * provider's figure whatever an earlier partial pass left behind.
 *
 * The predicate is the attribution_record unique index minus (token_type,
 * model) — the same decomposition claudeSpanKey/claudeRowKey encode — so it is
 * an index-prefix scan, not a table scan, and it sees every row of the span
 * whether or not this tick's reader returned it.
 *
 * THE ADVISORY LOCK IS LOAD-BEARING: this is a read followed by a write, and
 * two joiner passes on one span (a scheduled tick plus an inline assign-join,
 * or an operator re-run) must not both read "nothing booked" and then both
 * contribute rows. Held for the transaction, released on commit or rollback.
 * The value is read as exact micros (numeric x 1e6, cast in Postgres) rather
 * than as a float — the whole point of the reconciliation is exactness.
 */
async function readBookedSpan(
  exec: JoinerExec,
  instanceId: string,
  rec: UsageRecord,
): Promise<BookedSpan> {
  const claudeSessionId = rec.claudeSessionId ?? ''
  const sourceRunId = rec.sourceRunId ?? ''
  await exec.execute(sql`
    SELECT pg_advisory_xact_lock(
      ${SPAN_LOCK_CLASS}::int,
      hashtext(${instanceId} || '|' || ${claudeSessionId} || '|' || ${rec.tsEvent} || '|' || ${sourceRunId})
    )
  `)
  const rows = await exec.execute<{ token_type: string; model: string; micros: string }>(sql`
    SELECT token_type, model, (cost_usd * 1000000)::bigint::text AS micros
    FROM attribution_record
    WHERE instance_id = ${instanceId}::uuid
      AND COALESCE(claude_session_id, '') = ${claudeSessionId}
      AND ts_event = ${rec.tsEvent}::timestamptz
      AND COALESCE(source_run_id, '') = ${sourceRunId}
  `)
  let bookedMicros = 0n
  const writtenKeys = new Set<string>()
  for (const r of rows) {
    bookedMicros += BigInt(r.micros)
    writtenKeys.add(`${r.token_type}\0${r.model}`)
  }
  return { bookedMicros, writtenKeys }
}

/*
 * Collapse a span's records onto their DISTINCT ledger rows (see claudeRowKey).
 *
 * Duplicates carry the same (token_type, model) and so the same rate-line
 * lookup: computeCost's null-ness depends only on that pair, never on the token
 * count, so duplicates agree about WHETHER the card can price the row and differ
 * only in HOW MUCH. The larger estimate wins — order-independent (invariant 3),
 * and it is the conservative choice for a slice weight, which is an estimate of
 * a share and not money in its own right.
 */
function dedupeSpanRows(rows: readonly SpanRow[]): SpanRow[] {
  const byKey = new Map<string, SpanRow>()
  for (const r of rows) {
    const seen = byKey.get(r.key)
    if (!seen) {
      byKey.set(r.key, r)
      continue
    }
    if (
      seen.rateCardMicros !== null &&
      r.rateCardMicros !== null &&
      r.rateCardMicros > seen.rateCardMicros
    ) {
      byKey.set(r.key, r)
    }
  }
  return [...byKey.values()]
}

/*
 * Scheduler pre-query (registry 'azure-monitor-read' tick): instance_attestation
 * rows that still need a (re)join. A session is joinable when it is EITHER:
 *
 *   - ACTIVE (ts_actual_end IS NULL), with ts_start within `activeMaxAgeHours`
 *     — re-scanned EVERY tick regardless of age so spend on a long-lived
 *     session (Claude sessions can run for days/weeks) keeps attributing in
 *     near-real-time, including a session tagged retroactively mid-flight via
 *     the untagged-spend UI: once an attestation exists, ongoing spend on the
 *     still-open session keeps flowing to that budget. runReadJoiner is
 *     idempotent-additive (keyed on session_id + ts_event + token_type +
 *     model), so re-scanning only adds events that landed since the last tick.
 *     The age cap is a backstop against sessions that died without an /end
 *     call; OR
 *
 *   - ACTIVE AND DEMONSTRABLY LIVE — `last_bearer_at` within `liveBearerHours`,
 *     regardless of enrolment age. An instance cannot emit without minting an
 *     ingest bearer first (/bearer stamps last_bearer_at on every mint), so a
 *     recent mint is direct evidence that records are still arriving and this
 *     instance MUST be scanned. This clause exists because enrolment age is not
 *     liveness: the 2026-07-24 dead-zone outage was an instance enrolled ~30d
 *     earlier that aged out of `activeMaxAgeHours` while still emitting, and
 *     from that moment its spend was accepted by the DCE (HTTP 204) and never
 *     joined — silently, for as long as the enrolment lived. The age cap's
 *     stated backstop ("session-gc closes inactive ones well inside it") was
 *     false: session-gc closes on ts_expected_end, which enroll/emit-provision
 *     set to REFRESH_TOKEN_TTL_MS = 90d — 3x the 30d cap — so days 30..90 were
 *     a window in which a live instance was joinable by NO clause. Liveness,
 *     not age, is the correct predicate. The two clauses OVERLAP by design: the
 *     age clause still fires for ANY open instance under the cap, whatever its
 *     last_bearer_at — the SQL encodes no "never minted" condition, so do not
 *     read one here. What it uniquely still covers is an instance that has never
 *     minted a bearer at all (last_bearer_at IS NULL, so liveness cannot match
 *     it) — a fresh enrolment that has not yet emitted; OR
 *
 *   - RECENTLY CLOSED (ts_actual_end within `windowHours`) — keep re-scanning for
 *     trailing emit so a close (session-gc / /end) does NOT instantly freeze an
 *     instance that is still emitting. This is defense-in-depth for the 2026-06-06
 *     outage: a 12h-TTL gc-close froze a live instance's attribution because a
 *     closed+already-attributed instance matched none of the clauses; OR
 *
 *   - ended/unknown but UNATTRIBUTED, with ts_start within `windowHours` — a
 *     one-shot catch-up join (e.g. a session that ended between ticks).
 *
 * A long-closed session with attribution and no recent emit naturally ages out of
 * all clauses. Purged sessions are excluded, matching runReadJoiner's window query.
 *
 * NOTE (perf): active sessions are re-SELECTED each tick (which instances to
 * scan), but runReadJoiner now bounds the per-instance READ with a per-instance
 * high-water-mark (MAX already-attributed ts_event), so the reader only pulls
 * events newer than the last-attributed one — bounded by new emission, not the
 * instance's lifetime history. This narrows the READ only; WHICH instances are
 * scanned (incl. the E2 revocation exclusions) is unchanged.
 *
 * Extracted + exported so the column/window/active contract is regression-tested
 * — the registry wrapper has no DI seam, so a stale column here fails SILENTLY
 * on every scheduled tick (exactly how `sa.created_at` slipped past the suite,
 * which only ever calls runReadJoiner directly with explicit sessionIds).
 */
export async function selectJoinableInstances(
  db: PostgresJsDatabase<typeof schema>,
  opts: { windowHours?: number; activeMaxAgeHours?: number; liveBearerHours?: number; limit?: number } = {},
): Promise<JoinableSelection> {
  const windowHours = opts.windowHours ?? 24
  // Age window for open instances. It is NOT the liveness signal (see
  // liveBearerHours below) and carries no "never minted" condition — it fires for
  // any open instance under the cap. What it UNIQUELY covers is an instance that
  // has never minted a bearer, which liveness cannot match.
  const activeMaxAgeHours = opts.activeMaxAgeHours ?? 24 * 30
  // Liveness window on last_bearer_at (14d default).
  //
  // What a mint actually proves — stated precisely, because the bug this clause
  // fixes was caused by a comment asserting an unverified fact: a mint proves the
  // CLI RAN, not that it emitted. /bearer stamps last_bearer_at for every caller,
  // and two of them emit nothing — the SessionStart health probe (plugin/hooks/
  // session-start.mjs → runEmitHelper, every `claude` launch) and
  // /tokenscope:status (plugin/scripts/status.mjs). So the selected population is
  // "every device someone launched Claude Code on within the window", a deliberate
  // SUPERSET of "every device emitting". That superset is the safe direction: an
  // extra watermark-bounded read for an idle-but-launched device costs one query,
  // whereas the miss costs a SILENT total attribution stop (the dead-zone outage).
  // Sizing therefore tracks launched-in-14d devices, NOT emitting devices — see
  // the instance-cap warning below, which is the signal if that population grows.
  //
  // Guarded like `limit` below: 0/negative/NaN would make the predicate
  // `last_bearer_at >= NOW()` (never true), silently re-opening the dead zone this
  // clause exists to close, so a fat-fingered override must not reach the SQL.
  // A declared-but-blank env var (routine in Container Apps / .env) is UNSET, not
  // zero — Number('') is 0, which would otherwise warn about an override nobody
  // made. Trim first, then treat empty as absent.
  const envRaw = process.env.NUXT_JOINER_LIVE_BEARER_HOURS?.trim()
  const envLive = envRaw ? Number(envRaw) : Number.NaN
  // A non-empty but UNPARSEABLE env value ("abc", "14d") is a typo, not an unset
  // knob, and must not be swallowed: CONFIGURATION.md promises out-of-range
  // values warn, and an operator who mistyped the dead-zone guard's own window
  // deserves to hear about it rather than silently get the default.
  if (envRaw && Number.isNaN(envLive) && opts.liveBearerHours === undefined) {
    console.warn(
      `[azure-monitor-read] NUXT_JOINER_LIVE_BEARER_HOURS="${envRaw}" is not a number; using the default ${DEFAULT_LIVE_BEARER_HOURS}h.`,
    )
  }
  const requestedLive = opts.liveBearerHours ?? envLive
  // Asymmetric on purpose. A value BELOW the floor (0, negative, NaN, unset env)
  // is nonsense, and honouring it literally would silently narrow the window —
  // 0 makes the predicate `>= NOW()`, and even clamping to the 1h floor would
  // quietly shrink a 14-day window to an hour and start missing instances. So
  // nonsense falls back to the safe DEFAULT. A value ABOVE the ceiling expresses
  // a real intent ("scan as wide as possible") that is merely unrepresentable —
  // Postgres throws `interval out of range` past ~1.5e12 hours and would fail the
  // whole tick — so it clamps to the widest meaningful window instead.
  // Infinity is classified with the ABOVE-ceiling case, not with NaN: it is the
  // canonical spelling of "as wide as possible", which is a real intent that is
  // merely unrepresentable — clamping it to MAX is what the contract above says.
  // Only NaN (unset / unparseable) takes the default-on-nonsense path.
  const liveBearerHours = Number.isNaN(requestedLive)
    ? DEFAULT_LIVE_BEARER_HOURS
    : requestedLive < MIN_LIVE_BEARER_HOURS
      ? DEFAULT_LIVE_BEARER_HOURS
      : Math.min(requestedLive, MAX_LIVE_BEARER_HOURS)
  // Warn on any override we did not honour verbatim. NaN here means "no override
  // was made" (unset env), which is not worth a line; every other mismatch is a
  // value someone typed and did not get.
  if (!Number.isNaN(requestedLive) && requestedLive !== liveBearerHours) {
    console.warn(
      `[azure-monitor-read] liveBearerHours ${requestedLive} out of range; using ${liveBearerHours} (min ${MIN_LIVE_BEARER_HOURS}, max ${MAX_LIVE_BEARER_HOURS}, default ${DEFAULT_LIVE_BEARER_HOURS}).`,
    )
  }
  // Positive-integer guard: NaN/0/empty/garbage AND negatives all fall back to 500.
  // A negative LIMIT throws in Postgres → would fail the whole tick (silent
  // attribution stop, the outage class), so a fat-fingered env var must not reach it.
  const envCap = Number(process.env.NUXT_JOINER_INSTANCE_CAP)
  const limit = opts.limit ?? (Number.isInteger(envCap) && envCap > 0 ? envCap : 500)
  const rows = await db.execute<{ id: string }>(sql`
    SELECT sa.instance_id::text AS id
    FROM instance_attestation sa
    WHERE sa.ts_purged IS NULL
      AND sa.attestation_state IN ('attested', 'unassigned')  -- B′ (ADR-0004): device-enrol rows are 'unassigned' (project NULL); project comes from the emitted attr, not the row
      -- E2 (ADR-0005): never attribute records from an instance whose teammate was
      -- revoked AFTER enrolment (offboarding / force-revoke). Mirrors /bearer.
      AND NOT EXISTS (
        SELECT 1 FROM teammate t
         WHERE t.id = sa.teammate_id AND t.revoked_at IS NOT NULL AND t.revoked_at > sa.ts_start
      )
      AND (
        -- ACTIVE (open) within the active-age cap: re-scanned every tick.
        (sa.ts_actual_end IS NULL
         AND sa.ts_start >= NOW() - (${activeMaxAgeHours} * INTERVAL '1 hour'))
        -- ACTIVE (open) and DEMONSTRABLY LIVE: a bearer mint within the liveness
        -- window proves records are still arriving, whatever the enrolment age.
        -- Closes the days-30..90 dead zone in which a still-emitting instance
        -- matched no clause and its spend was accepted but never joined.
        OR (sa.ts_actual_end IS NULL
            AND sa.last_bearer_at >= NOW() - (${liveBearerHours} * INTERVAL '1 hour'))
        -- RECENTLY CLOSED within the window: keep re-scanning for trailing emit so a
        -- close (session-gc / /end) does NOT instantly freeze a still-emitting
        -- instance (defense-in-depth for the 2026-06-06 outage). The per-instance
        -- watermark bounds the read to events newer than the last attributed one.
        OR (sa.ts_actual_end >= NOW() - (${windowHours} * INTERVAL '1 hour'))
        -- ended/unknown but NEVER attributed, start within window: one-shot catch-up.
        OR (sa.ts_start >= NOW() - (${windowHours} * INTERVAL '1 hour')
            AND NOT EXISTS (
              SELECT 1 FROM attribution_record ar
               WHERE ar.instance_id = sa.instance_id
            ))
      )
    -- R1 HIGH: a burst of recently-closed instances must never evict live/active
    -- instances under the 500-row cap. Order active (ts_actual_end IS NULL) first,
    -- then by most-recent ACTIVITY, so the LIMIT sheds the oldest dormant rows — not a
    -- still-emitting active session whose spend would then silently stop attributing.
    -- Activity (COALESCE(last_bearer_at, ts_start)) rather than ts_start alone: under
    -- the cap a long-enrolled instance that is emitting RIGHT NOW must outrank a
    -- newer one that has been dormant for weeks — ranking by enrolment date is the
    -- same age-is-not-liveness mistake the dead zone came from.
    -- Confirmed before provisional, within each open/closed group: a provisional
    -- row is minted by the unauthenticated enrol door, so a flood of them must
    -- never displace a confirmed device under the cap (CS-EDGE-01).
    ORDER BY (sa.ts_actual_end IS NULL) DESC,
             (sa.identity_state <> 'provisional') DESC,
             COALESCE(sa.last_bearer_at, sa.ts_start) DESC
    -- Over-fetch by ONE to tell "exactly at the cap" from "truncated by the cap".
    -- rows.length === limit alone cannot: a population of exactly the cap is fully
    -- scanned yet would report a cap hit, paging an operator and sending them to
    -- raise a cap that is not actually biting. (Copilot review, PR #185.)
    LIMIT ${limit + 1}
  `)
  // Observability (R2 L1): hitting the cap means some joinable instances are NOT
  // scanned this tick. The ORDER BY sheds closed-first, but >limit ACTIVE instances
  // would still drop live ones → silent attribution stop (the outage class). Surface
  // it so the cap is visible before it bites; raise NUXT_JOINER_INSTANCE_CAP / page.
  const all = [...rows]
  const capHit = all.length > limit ? limit : null
  const kept = capHit === null ? all : all.slice(0, limit)
  if (capHit !== null) {
    console.warn(
      `[azure-monitor-read] joinable-instance cap hit (${limit}); some instances skipped this tick. Raise NUXT_JOINER_INSTANCE_CAP or page the query.`,
    )
  }
  return { ids: kept.map((r) => r.id), capHit }
}

/**
 * inbox_item.category for the selection-cap signal. `satisfies` (not a cast) so
 * adding it here without registering it in the dispatcher's union — which is
 * what decides severity and routing — fails the build rather than dispatching an
 * unrouted category to nobody.
 */
export const JOINER_SELECTION_CAP = 'joiner-selection-cap' satisfies InboxCategory
/**
 * The read path is a GLOBAL singleton, not one entity per row — so the signal
 * hangs off the same synthetic kind read-path-health uses, with no id.
 * dispatchInbox drops a non-UUID related_entity_id to null, so omitting it is
 * safe and routing stays category-driven.
 */
const JOINER_SELECTION_CAP_KIND = 'read-path'

export interface JoinerSelectionCapResult {
  /** 1 when this call opened a new signal, else 0. */
  raised: number
  /** 1 when a signal was already open (the 5-minute tick, deduped), else 0. */
  skippedExisting: number
  /** Open signals closed because this run's selection fit under the cap. */
  autoResolved: number
}

/**
 * Make a selection-cap hit OBSERVABLE — the thing `selectionCapHit` was not.
 *
 * The cap has always been detected (selectJoinableInstances over-fetches by one
 * to tell "exactly at the cap" from "truncated by it"), logged, and threaded
 * into worker_run.result. Nothing READ it: no query, no panel, no alert — five
 * write sites and no reader. So the only symptom of the joiner scanning a
 * fraction of the fleet was spend quietly not appearing, which is the outage
 * class this whole file is scarred by.
 *
 * It is a real reach, not a theoretical one: the platform admits
 * DEFAULT_MAX_LIVE_EMIT_INSTANCES (50,000) live emit devices while this
 * selection scans 500 per tick, so ORGANIC GROWTH alone crosses it.
 *
 * OBSERVABILITY ONLY. It does not widen the scan: each instance costs 2-3 SERIAL
 * Log Analytics queries behind a ~120s gateway (see telemetry-recovery.ts, where
 * a 187s slice 504'd while holding the single-flight lock), so draining an
 * unbounded selection in one tick would trade a partial read for an outage. A
 * resumable cursor is an owner decision, not a side effect of an alert.
 *
 * Idempotent per EPISODE, modelled on read-path-health: one open item until the
 * selection fits again, then auto-resolved. `capHit === null` is the recovery
 * signal, so callers must only pass the result of a REAL scheduled selection —
 * an operator's scoped override ran no selection and would falsely clear a live
 * signal (the same trap read-path-health documents for scoped runs).
 *
 * CONCURRENCY: the check-then-insert below is non-atomic and is safe only under
 * the per-worker dispatch lock the run-worker endpoint holds (dispatch-lock.ts)
 * — the same contract read-path-health, went-silent and budget-alert rely on.
 */
export async function recordJoinerSelectionCap(
  db: PostgresJsDatabase<typeof schema>,
  capHit: number | null,
  opts: { now?: Date } = {},
): Promise<JoinerSelectionCapResult> {
  const now = opts.now ?? new Date()

  if (capHit === null) {
    const resolved = await db.execute<{ id: string }>(sql`
      UPDATE inbox_item
         SET ack_state = 'resolved', ack_at = ${now.toISOString()}::timestamptz
       WHERE category = ${JOINER_SELECTION_CAP}
         AND related_entity_kind = ${JOINER_SELECTION_CAP_KIND}
         AND ack_state IN ('unread', 'read', 'acknowledged')
      RETURNING id::text AS id
    `)
    return { raised: 0, skippedExisting: 0, autoResolved: [...resolved].length }
  }

  const existing = await db.execute<{ id: string }>(sql`
    SELECT id::text AS id FROM inbox_item
     WHERE category = ${JOINER_SELECTION_CAP}
       AND related_entity_kind = ${JOINER_SELECTION_CAP_KIND}
       AND ack_state IN ('unread', 'read', 'acknowledged')
     LIMIT 1
  `)
  if ([...existing].length > 0) {
    return { raised: 0, skippedExisting: 1, autoResolved: 0 }
  }

  // Severity is the dispatcher's default for this category ('attention'), set
  // there rather than here so there is ONE place that decides how loud a
  // category is. Deliberately not 'urgent' like read-path-stale: the selection
  // sheds least-recently-active FIRST, so a cap hit does not prove spend is
  // being lost, and a device that IS starved by it surfaces separately (and
  // urgently) as attribution-gap once it falls 72h behind — provided it had
  // attributed before. This is the early capacity warning, not the outage.
  const dispatched = await dispatchInbox(db, {
    category: JOINER_SELECTION_CAP,
    subject: `Attribution joiner is capped at ${capHit} devices per run — the surplus is skipped`,
    body: {
      worker: 'azure-monitor-read',
      cap: capHit,
      summary:
        `The scheduled selection matched more joinable devices than its per-run cap (${capHit}), so the surplus was not scanned on this run. ` +
        'Candidates are ordered active-first, then by most recent activity, so what gets shed is the least recently active: dormant devices while the active population stays under the cap, and live ones once it does not. A device skipped on every run stops attributing spend silently.',
      hint:
        'Raise NUXT_JOINER_INSTANCE_CAP (default 500) above the joinable-device count and redeploy the reader; this clears itself on the first run whose selection fits. Raise it deliberately — each device costs 2-3 serial Log Analytics queries inside one run, so a much larger cap makes the run proportionally longer.',
      detectedAt: now.toISOString(),
    },
    relatedEntityKind: JOINER_SELECTION_CAP_KIND,
  })
  return { raised: dispatched.length > 0 ? 1 : 0, skippedExisting: 0, autoResolved: 0 }
}

/**
 * Ids-only convenience over selectJoinableInstances, for callers that do not
 * report the cap (tests, scripts). The scheduled tick uses the full form so the
 * cap hit reaches worker_run.result.
 */
export async function selectRecentJoinableSessionIds(
  db: PostgresJsDatabase<typeof schema>,
  opts: { windowHours?: number; activeMaxAgeHours?: number; liveBearerHours?: number; limit?: number } = {},
): Promise<string[]> {
  return (await selectJoinableInstances(db, opts)).ids
}

export async function runReadJoiner(
  db: PostgresJsDatabase<typeof schema>,
  reader: TelemetryReader,
  opts: JoinOptions = {},
): Promise<JoinResult> {
  const now = opts.now ?? new Date()
  const sinceMs = opts.sinceMs ?? DEFAULT_WINDOW_MS
  const since = new Date(now.getTime() - sinceMs).toISOString()
  const explicitSessions = opts.sessionIds

  const sessions = await db.execute<SessionRow>(
    explicitSessions
      ? sql`
          SELECT instance_id::text AS instance_id,
                 teammate_id::text AS teammate_id,
                 region_id::text   AS region_id,
                 org_unit_id::text AS org_unit_id,
                 cost_owning_unit_id::text AS cost_owning_unit_id,
                 project_code_hash, tool, identity_state
          FROM instance_attestation
          -- Every gate the scheduled selection applies must be re-applied here.
          -- This branch takes ids from its CALLER, and since the operator-scoped
          -- recovery override those ids no longer necessarily came from
          -- selectJoinableInstances — so its gates cannot be assumed upstream.
          WHERE ts_purged IS NULL
            AND attestation_state IN ('attested', 'unassigned')  -- B′: device-enrol rows are 'unassigned'; project from the emitted attr
            AND NOT EXISTS (  -- E2 (ADR-0005): skip revoked-teammate instances
              SELECT 1 FROM teammate t
               WHERE t.id = instance_attestation.teammate_id
                 AND t.revoked_at IS NOT NULL AND t.revoked_at > instance_attestation.ts_start
            )
            AND instance_id IN (${sql.join(
              explicitSessions.map((id) => sql`${id}::uuid`),
              sql`, `,
            )})
        `
      : sql`
          SELECT instance_id::text AS instance_id,
                 teammate_id::text AS teammate_id,
                 region_id::text   AS region_id,
                 org_unit_id::text AS org_unit_id,
                 cost_owning_unit_id::text AS cost_owning_unit_id,
                 project_code_hash, tool, identity_state
          FROM instance_attestation
          WHERE ts_purged IS NULL
            AND attestation_state IN ('attested', 'unassigned')  -- B′: include unassigned device-enrol rows
            AND NOT EXISTS (  -- E2 (ADR-0005): skip revoked-teammate instances
              SELECT 1 FROM teammate t
               WHERE t.id = instance_attestation.teammate_id
                 AND t.revoked_at IS NOT NULL AND t.revoked_at > instance_attestation.ts_start
            )
            AND (ts_actual_end >= ${since}::timestamptz
                 OR (ts_actual_end IS NULL AND ts_start >= ${since}::timestamptz)
                 -- Liveness: an OPEN instance that minted a bearer inside the
                 -- window is emitting NOW, whatever its enrolment age. Without it
                 -- this query carries the same age-is-not-liveness dead zone the
                 -- pre-query fixes. NOTE it is bounded by "since" (the caller's
                 -- window, 24h by default), NOT by the pre-query's much wider
                 -- liveBearerHours — this path has no LIMIT, so widening it here
                 -- would let one call fan out over every instance enrolled in the
                 -- last 90 days, serially, against the worker gateway ceiling.
                 -- Narrower is the safe asymmetry: the scheduled tick (which does
                 -- have the cap and the wide window) is what guarantees coverage.
                 OR (ts_actual_end IS NULL AND last_bearer_at >= ${since}::timestamptz))
        `,
  )

  // ── Per-instance high-water-mark (scalability fix) ──────────────────────
  // For each instance about to be processed, the watermark is the MAX(ts_event)
  // of ALREADY-WRITTEN attribution_record rows — the last event we've attributed.
  // The reader then pulls only events newer than (watermark - lookback), so the
  // per-tick read is bounded by new emission, not the instance's lifetime history
  // (this is the fix for the O(active-instances × lifetime-records) full-rescan
  // that caused live 504s once an instance reached ~4,300 records).
  //
  // CORRECTNESS: the watermark is MAX over already-WRITTEN rows, so no
  // un-attributed record is ever skipped — the lookback re-reads the boundary and
  // onConflictDoNothing dedups the overlap. An instance with NO attribution yet
  // has no watermark → undefined → the reader does a full-window read (unchanged).
  // Batched into ONE query (instance_id → max_ts_event) to avoid N round-trips.
  // A deep-rescan tick (ING-1) WITHHOLDS the watermark from the reader (full
  // re-read) but the watermarks are still LOADED, because newEventsSeen measures
  // every fetched record against them — without that, a daily deep pass on a
  // quiet estate would report its whole re-read history as new work.
  const watermarks = new Map<string, Date>()
  if (sessions.length > 0) {
    const wmRows = await db.execute<{ instance_id: string; max_ts: string | null }>(sql`
      SELECT instance_id::text AS instance_id, MAX(ts_event)::text AS max_ts
      FROM attribution_record
      WHERE instance_id IN (${sql.join(
        [...new Set(sessions.map((s) => s.instance_id))].map((id) => sql`${id}::uuid`),
        sql`, `,
      )})
      GROUP BY instance_id
    `)
    for (const r of wmRows) {
      if (r.max_ts) watermarks.set(r.instance_id, new Date(r.max_ts))
    }
  }

  // Behavioural usage-signal lane watermark (mig 0065) — its OWN high-water-mark
  // over usage_signal_record, independent of the token watermark (an invoke_agent
  // turn emits signals but no token row, so the two lanes' frontiers can diverge).
  // Same batched MAX(ts_event) shape; deep-rescan skips it for a full re-read.
  const signalWatermarks = new Map<string, Date>()
  if (sessions.length > 0 && !opts.deepRescan && typeof reader.getSignalUsage === 'function') {
    const swRows = await db.execute<{ instance_id: string; max_ts: string | null }>(sql`
      SELECT instance_id::text AS instance_id, MAX(ts_event)::text AS max_ts
      FROM usage_signal_record
      WHERE instance_id IN (${sql.join(
        [...new Set(sessions.map((s) => s.instance_id))].map((id) => sql`${id}::uuid`),
        sql`, `,
      )})
      GROUP BY instance_id
    `)
    for (const r of swRows) {
      if (r.max_ts) signalWatermarks.set(r.instance_id, new Date(r.max_ts))
    }
  }
  let signalRowsWritten = 0
  let signalErrors = 0

  // Per-run rate-card cache, keyed `${tool}|${region_id}|${UTC-day-of-event}`
  // (mig 0050: selection is scope-aware AND temporal, so the resolved card
  // varies by region and by event timestamp). Day granularity keeps DB hits at
  // ~1 per (tool, region, day) per run instead of 1 per record — the joiner
  // prices bursts of same-day events per instance. Caveat: a card whose
  // effective boundary falls MID-day buckets that day's events with whichever
  // card the day's first-resolved event matched; the admin flow writes
  // day-aligned ranges, so this stays theoretical.
  const rateCardCache = new Map<string, RateCardWithLines | null>()
  // Snapshot the (small) project-lifecycle policy table ONCE per tick → a pure
  // (regionId) => {graceHours, warnDays} resolver. Zero per-event/per-group
  // queries on the hot path (D9). grace is resolved by the PROJECT's region.
  const lifecyclePolicyFor = await loadLifecyclePolicyResolver(db)
  let written = 0
  // Diagnostics (see JoinResult.usageRowsFetched / newEventsSeen). Counted at
  // fetch time so a session that throws later (ING-6) still reports what it saw.
  let usageRowsFetched = 0
  let newEventsSeen = 0
  let skippedNoCard = 0
  let spilledUnauthorized = 0
  let spilledEnded = 0
  let errors = 0
  // Per-SPAN ladder tally for the Claude lane (see JoinResult.costingRungs).
  const costingRungs: CostingRungCounts = emptyCostingRungCounts()
  // Ingest-boundary rejects (S10) — ONE accumulator for the whole tick,
  // filled IN PLACE by every reader.getSessionUsage/getSignalUsage call below
  // (the caller-supplied-counters shape; see reader.ts's ParseCounters). See
  // JoinResult.parseCounters for why this is the non-negotiable counter half
  // of the ingest bounds.
  const parseCounters: ParseCounters = emptyParseCounters()
  // (C) — telemetry-only spend written THIS TICK, in micros, keyed
  // `${regionId}\0${day}`. BigInt so summing many small rows cannot drift
  // (span-costing.ts's discipline); rendered to JoinResult.telemetryOnlySpend
  // at the very end.
  const telemetryOnlyMicros = new Map<string, bigint>()
  /*
   * mig 0119 — the teammate's ENTERPRISE ADDRESS SET, canonicalised, cached for
   * this run. Keyed by teammate id, NOT by instance: one teammate can have
   * several enrolled devices in a single tick and the set is the same for all
   * of them. Run-scoped rather than module-scoped so an identity linked between
   * two ticks is picked up on the next tick without a restart.
   */
  const enterpriseAddressSets = new Map<string, Set<string>>()

  // ING-6: per-session fault isolation — invoked per session under try/catch
  // below (the reconciliation-sync per-scope pattern) so one bad session cannot
  // starve every remaining instance this tick.
  const processSession = async (session: SessionRow): Promise<void> => {
    // High-water-mark: pull only events newer than the last-attributed one
    // (minus the reader's lookback). undefined for a first-ever scan → full window.
    // `parseCounters` is passed so the reader's ingest-boundary rejects reach
    // JoinResult REGARDLESS of what usage.length turns out to be — merged
    // before the early-return below, so a session whose records were ALL
    // rejected still reports the reject instead of vanishing silently.
    const watermark = watermarks.get(session.instance_id)
    const usage = await reader.getSessionUsage(
      session.instance_id,
      // A deep-rescan tick re-reads the full window; the watermark is still
      // measured against below (JoinResult.newEventsSeen), so a re-read is not
      // mistaken for new work.
      opts.deepRescan ? undefined : watermark,
      parseCounters,
    )
    usageRowsFetched += usage.length
    newEventsSeen += countNewerThanWatermark(usage, watermark)
    if (usage.length === 0) return

    /*
     * mig 0119 — the enterprise address set for THIS session's teammate, read
     * once per teammate per run. Loaded unconditionally rather than lazily on
     * the first record carrying an address: a session where NO record reports
     * one is exactly the case that must stamp 'unknown', and a lazy load would
     * make the query count depend on emitter behaviour instead of on the number
     * of teammates in the tick.
     */
    let enterpriseAddresses = enterpriseAddressSets.get(session.teammate_id)
    if (!enterpriseAddresses) {
      enterpriseAddresses = await loadEnterpriseAddressSet(db, session.teammate_id)
      enterpriseAddressSets.set(session.teammate_id, enterpriseAddresses)
    }

    // ── ADR-0004 "B′": project from the EMITTED telemetry, not the row ──
    // Teammate (who) still comes from the unspoofable attestation row (by
    // session_id). Project (which) resolution ORDER, per record (§13):
    //   1. emitted project.code_hash (B′) — the per-event .tokenscope claim;
    //   2. ELSE a per-conversation assignment (session_assignment, keyed on
    //      the record's claude_session_id + this teammate) — the retroactive
    //      "assign this untagged conversation" mapping the assign endpoint writes;
    //   3. ELSE untagged (skip).
    // One DEVICE_SID is shared across a user's repos AND conversations, so
    // records under it may resolve to DIFFERENT project hashes; attribution is
    // decided PER project group, each membership-gated. The attestation row's own
    // project_code_hash is the DEVICE's (usually NULL) and is not used here.
    //
    // The session_assignment fallback is resolved to a project CODE HASH
    // (not directly to a project id) so both lanes converge on the same
    // membership-gated grouping below — keeping the gate the single decision
    // point and avoiding a second attribution path that could skip it.
    const convProjectHashCache = new Map<string, string | null>()
    // Orthogonal activity axis (mig 0020): the per-conversation activity label,
    // resolved from session_assignment by (claude_session_id, teammate) and
    // denormalised onto each attribution_record. Independent of the project
    // resolution — a B′-attributed record can still carry an activity.
    const convActivityCache = new Map<string, string | null>()
    // Untagged records group under this sentinel (instead of being skipped) so
    // they're itemised into the ledger as project-less (unallocated) rows.
    const UNTAGGED_KEY = '__untagged__'
    const groups = new Map<string, UsageRecord[]>()
    for (const rec of usage) {
      let codeHash = rec.projectCodeHash ?? null
      if (!codeHash && rec.claudeSessionId) {
        // Fallback: an explicit per-conversation assignment for THIS teammate.
        let resolved = convProjectHashCache.get(rec.claudeSessionId)
        if (resolved === undefined) {
          const [ca] = await db.execute<{ code_hash: string }>(sql`
            SELECT p.code_hash AS code_hash
            FROM session_assignment ca
            JOIN project p ON p.id = ca.project_id
            WHERE ca.claude_session_id = ${rec.claudeSessionId}
              AND ca.teammate_id = ${session.teammate_id}::uuid
            LIMIT 1
          `)
          resolved = ca?.code_hash ?? null
          convProjectHashCache.set(rec.claudeSessionId, resolved)
        }
        codeHash = resolved
      }
      // No skip: untagged records group under the sentinel so they're itemised
      // as project-less (unallocated) rows. attribution_record is the single ledger.
      const key = codeHash ?? UNTAGGED_KEY
      const list = groups.get(key) ?? []
      list.push(rec)
      groups.set(key, list)
    }

    for (const [key, groupUsage] of groups) {
      // Resolve the project (NULLABLE). Untagged, unknown-project, and non-member
      // spill all resolve to NULL = unallocated — but are STILL written to the
      // ledger (itemised), not dropped. cost_owning_unit follows the project.
      let projectId: string | null = null
      let cou: string | null = null
      // Per-group spill boundary in epoch-ms: events with ts_event strictly past
      // (end_date + grace) spill to unallocated. null = no end / not applicable.
      let spillAfterMs: number | null = null
      // ING-8: unknown-project / unauthorized-spill audits and counters are
      // DEFERRED until after the insert loop and gated on newly-written rows —
      // same gate as the ended-spill path. The lookback overlap re-reads these
      // groups every tick; un-gated, the append-only audit re-fired (~12 dup
      // rows/hour per active unauthorized tagger) even when every insert
      // deduped to zero.
      let unknownProject = false
      let unauthorizedProjectId: string | null = null
      if (key !== UNTAGGED_KEY) {
        const [proj] = await db.execute<{
          id: string
          cost_owning_unit_id: string
          region_id: string
          // end_date as epoch MILLISECONDS straight from Postgres — never parse
          // a timestamptz::text in JS (the space-separated form isn't in the
          // ECMAScript parse grammar; a NaN would fail-OPEN and mis-bill the
          // dead project). NULL when the project has no end_date.
          end_ms: string | null
        }>(
          sql`SELECT id::text AS id, cost_owning_unit_id::text AS cost_owning_unit_id,
                     region_id::text AS region_id,
                     (EXTRACT(EPOCH FROM end_date) * 1000)::bigint::text AS end_ms
              FROM project WHERE code_hash = ${key} LIMIT 1`,
        )
        if (!proj) {
          // Hash matches no registered project → leave UNALLOCATED + audit (after
          // the inserts, gated on new rows) so ops can spot an unregistered
          // .tokenscope without the audit re-firing on every overlap re-read.
          unknownProject = true
        } else {
          // ── Membership gate (spec §2) ── tag proposes, membership disposes.
          // A non-member's claim is NOT billed to the project; it's itemised as
          // unallocated (spill) and audited loudly. Don't silently bill an
          // unauthorized tag.
          const member = await db.execute<{ ok: number }>(
            sql`
              SELECT 1 AS ok FROM project_assignment
              WHERE project_id = ${proj.id}::uuid
                AND teammate_id = ${session.teammate_id}::uuid
                AND effective @> now()
              LIMIT 1
            `,
          )
          if (member.length === 0) {
            // Counter + audit deferred until after the inserts (ING-8 gate).
            unauthorizedProjectId = proj.id
            // projectId stays null → unallocated
          } else {
            projectId = proj.id
            cou = proj.cost_owning_unit_id
            // Project-lifecycle spill (D2). If the project has ended, events past
            // end_date + grace spill to unallocated. Resolve grace by the
            // PROJECT's region (region admins override their region). Decided
            // per-event below so a boundary-spanning conversation splits cleanly.
            if (proj.end_ms !== null) {
              const grace = lifecyclePolicyFor(proj.region_id).graceHours
              spillAfterMs = Number(proj.end_ms) + grace * 3_600_000
            }
          }
        }
      }

      // ── Org lane (spec §2.1) ───────────────────────────────────────
      // The Claude-stamped organization.id picks the reconciliation lane via the
      // provider_org registry: reconciled → tier-1/estimated (API is the ceiling);
      // indicative or unknown → tier-2/telemetry-only (excluded from reconciliation).
      // Unknown orgs are attributed best-effort AND flagged for classification.
      //
      // Copilot-specific: Copilot v1 spend is ALWAYS tier-2/telemetry-only
      // (no billing-API reconciliation in v1 — deferred to F2). The GitHub billing
      // reconciliation worker (F2) will promote Copilot rows to tier-1 when it lands.
      //
      // The operand is `organizationId` — the RAW, unbounded value — never the
      // bounded `emittingOrgId` that mig 0119 persists. The two were briefly one
      // field, which made a storage bound able to move an existing record's
      // lane (server/azure/reader.ts, the two-fields-from-one-value split).
      const isCopilot = session.tool === 'copilot-cli'
      const orgId = groupUsage.find((u) => u.organizationId)?.organizationId
      let fidelityTier = isCopilot ? 'tier-2' : 'tier-1'
      let costBasis = isCopilot ? 'telemetry-only' : 'estimated'
      if (!isCopilot && orgId) {
        const [orgRow] = await db.execute<{ mode: string }>(
          sql`SELECT reconciliation_mode AS mode FROM provider_org
              WHERE provider = 'anthropic' AND lower(external_org_id) = lower(${orgId}) LIMIT 1`,
        )
        if (!orgRow) {
          fidelityTier = 'tier-2'
          costBasis = 'telemetry-only'
          await auditFailSoft(db, {
            eventType: 'attribution-org-unclassified',
            actorTeammateId: session.teammate_id,
            actorSystem: 'read-joiner',
            subjectKind: 'session',
            subjectId: session.instance_id,
            payload: { organization_id: orgId, note: 'add this org to the provider_org registry' },
          })
        } else if (orgRow.mode === 'indicative') {
          fidelityTier = 'tier-2'
          costBasis = 'telemetry-only'
        }
      }

      // Copilot cost path: use AI-credit constant (NOT token rate cards).
      // Token rate cards (rate_line) are for Claude only. Copilot rows carry
      // nano_aiu; cost = nano_aiu × 1e-11 (i.e. credits × $0.01).
      // Copilot rows carry a null card (the INSERT uses rateCardId=null).
      // Deliberately UNCHANGED by the provider-cost-precedence design: Copilot
      // has no rate card to demote, and its credit figure IS the provider's.
      //
      // ── Claude cost path: the provider's number, sliced by the rate card ──
      // docs/design/provider-cost-precedence.md. Costing is decided PER SPAN,
      // ahead of the per-record write loop, because:
      //
      //   span total = MAX(law_cost_usd) per span — NEVER SUM.
      //
      // The KQL mv-expand (server/azure/reader.ts:399) copies Claude's own
      // per-request cost_usd onto EVERY surviving token-type row and then prunes
      // the zero-token ones (reader.ts:401). So the same figure appears 1-4
      // times per span, and how many times depends on how many token types the
      // request happened to use — summing multiplies the cost by 1-4x, worst for
      // the heaviest, most cache-optimised users. v_cost_drift already uses MAX
      // for exactly this reason (mig 0045:44).
      const claudeSpanPlans = new Map<
        string,
        {
          plan: SpanCostPlan
          card: RateCardWithLines | null
          /*
           * The PER-ROW rate-card estimate, keyed by claudeRowKey — i.e. exactly
           * the number that would have gone into cost_usd before this design.
           * It is persisted as metadata.rate_card_cost_usd on provider-priced
           * rows because rate_card_id is NULL on those, so NOTHING can re-derive
           * the estimate after the fact and the cost-drift diagnostic would
           * otherwise compare the provider against itself and print a
           * tautological ~0 forever (mig 0091 is the consuming view).
           *
           * MIND THE ASYMMETRY with metadata.law_cost_usd: the provider figure is
           * span-duplicated by the mv-expand and is read back with MAX; this
           * estimate is PER ROW and is read back with SUM. Writing a span total
           * here would silently 4x the estimate and manufacture drift.
           */
          estimates: Map<string, bigint>
          /**
           * The span's DEDUPED rows (one per distinct ledger row), kept so the
           * write path can re-run the allocation against what the ledger already
           * holds for this span — see replanAgainstBooked / readBookedSpan.
           */
          rows: SpanRow[]
        }
      >()
      if (!isCopilot) {
        const spanRecords = new Map<string, UsageRecord[]>()
        for (const rec of groupUsage) {
          const k = claudeSpanKey(rec)
          const list = spanRecords.get(k) ?? []
          list.push(rec)
          spanRecords.set(k, list)
        }
        for (const [spanKey, recs] of spanRecords) {
          // MAX, never SUM (see above). undefined lawCostUsd = legacy emission
          // or a client version that stopped reporting cost → no provider figure
          // → the ladder drops to the rate card and the counter alerts.
          let providerCostUsd: number | null = null
          for (const r of recs) {
            if (r.lawCostUsd === undefined || !Number.isFinite(r.lawCostUsd)) continue
            providerCostUsd = providerCostUsd === null ? r.lawCostUsd : Math.max(providerCostUsd, r.lawCostUsd)
          }

          // The rate card, resolved once per span (COST-4/COST-6, mig 0050) —
          // scope-aware (region tier > global) and temporal (only a card whose
          // effective range contains ts_event prices it). Cached per
          // (tool, region, UTC-day-of-event) for the run so per-event DB hits
          // don't explode (see rateCardCache above). Every row of a span shares
          // one ts_event, so one resolution covers the span.
          //
          // INVARIANT (regression-pinned in joiner-rate-card-scope.test.ts):
          // with only the seeded card (mig 0004 — global, region_id NULL,
          // effective [2026-01-01, 2099-01-01)) a span with NO provider cost
          // resolves and prices exactly as it did before this design.
          const eventDay = new Date(recs[0]!.tsEvent).toISOString().slice(0, 10)
          const cardKey = `${session.tool}|${session.region_id ?? ''}|${eventDay}`
          let card = rateCardCache.get(cardKey)
          if (card === undefined) {
            card = await resolveRateCard(db, session.tool, recs[0]!.tsEvent, session.region_id ?? null)
            rateCardCache.set(cardKey, card)
          }

          // The card's estimate per row is the SLICE RATIO, not the amount. A
          // null estimate is an UNKNOWN token type (no line for this unit/model
          // — a future reasoning token, a new cache tier): planSpanCosting sends
          // the whole span to the single-carrier pattern rather than mis-slotting
          // it, and counts it loudly.
          //
          // DEDUPED to distinct ledger rows first: two records with the same
          // (token_type, model) are one row on the way in (ON CONFLICT DO
          // NOTHING), so allocating to both would leave the span short of the
          // provider's figure by whatever the collapsed duplicate was given.
          const rows = dedupeSpanRows(
            recs.map((r) => ({
              key: claudeRowKey(r),
              tokenType: r.tokenType,
              rateCardMicros: card
                ? usdToMicros(computeCost(card, r.tokenType, r.model, r.tokens))
                : null,
            })),
          )
          const estimates = new Map<string, bigint>()
          for (const r of rows) {
            if (r.rateCardMicros !== null) estimates.set(r.key, r.rateCardMicros)
          }
          const plan = planSpanCosting({ providerCostUsd, rows })
          tallySpanPlan(costingRungs, plan)
          claudeSpanPlans.set(spanKey, { plan, card, estimates, rows })
        }
      }

      // Per-group tally of ended-spill events, for one summary audit below.
      // Count only NEWLY-WRITTEN spilled rows. The reader re-reads a 5-minute
      // overlap each tick (WATERMARK_LOOKBACK_MS) so onConflictDoNothing can
      // dedup the boundary — which means a boundary-spanning spill is re-seen
      // every tick. Tallying ALL spilled events would re-inflate the counter
      // and re-emit the append-only audit on every tick. Gate on `ins.length`.
      // The unknown-project / unauthorized paths use the same gate (ING-8).
      //
      // ING-5: the Copilot cost carrier is DETERMINISTIC — for each span, the
      // present token_type earliest in TOKEN_TYPE_PRIORITY carries the cost.
      // "First surviving record" was arrival-order dependent (the KQL has no
      // ORDER BY): a tick crashing mid-span, or a concurrent run, let the next
      // pass pick a DIFFERENT carrier → a second full-cost row that conflicts
      // with nothing. The carrier additionally checks the DB for an existing
      // >0-cost row per span before carrying cost again.
      const copilotPricedSpans = new Set<string>()
      const spanCarrier = new Map<string, string>()
      if (isCopilot) {
        for (const rec of groupUsage) {
          const spanKey = `${rec.tsEvent}:${rec.sourceRunId ?? ''}`
          const current = spanCarrier.get(spanKey)
          if (
            current === undefined ||
            tokenTypePriority(rec.tokenType) < tokenTypePriority(current)
          ) {
            spanCarrier.set(spanKey, rec.tokenType)
          }
        }
      }
      let groupEndedSpillNew = 0
      let groupNewRows = 0

      /*
       * ── WRITE UNITS: a Claude span's rows are ALL-OR-NOTHING ──────────────
       *
       * Every row used to be its own independent INSERT, so a fault part-way
       * through a span (an FK violation, a connection blip, the gateway ceiling)
       * left the span HALF WRITTEN and committed. The per-session try/catch
       * (ING-6) then retried that session on the next tick, where the joiner
       * re-planned the SAME provider total against the LIVE rate card. Rows
       * already on the ledger are frozen (COST-8) and re-inserted with ON
       * CONFLICT DO NOTHING, so they keep their old amounts while the rest take
       * the new weights — and if an admin edited a rate line in between (an
       * ordinary action) the two halves are sliced differently and the span's
       * booked total silently stops being the provider's figure. That total is
       * the invariant every project, budget, rollup and chargeback number in the
       * system inherits, so it must not depend on when a tick happened to die.
       *
       * A Claude span is 1-4 rows, so one transaction per span is a tiny lock
       * held for a few statements — cheap enough to be the default. Rows are
       * inserted in a DETERMINISTIC key order so two ticks racing on one span
       * take the same row locks in the same sequence and cannot deadlock; the
       * loser's inserts then all conflict and it writes nothing, which is what
       * makes the outcome all-or-nothing under concurrency too.
       *
       * The COPILOT LANE IS UNCHANGED: each of its records stays its own
       * independent insert (a single statement is already atomic), so the
       * nano_aiu carrier logic and its DB probe behave exactly as before.
       */
      const writeUnits: UsageRecord[][] = []
      if (isCopilot) {
        for (const rec of groupUsage) writeUnits.push([rec])
      } else {
        const bySpan = new Map<string, UsageRecord[]>()
        for (const rec of groupUsage) {
          const k = claudeSpanKey(rec)
          const list = bySpan.get(k)
          if (list) list.push(rec)
          else bySpan.set(k, [rec])
        }
        for (const recs of bySpan.values()) {
          writeUnits.push(
            /*
             * A TOTAL order, not just row-key order. Sorting by key alone leaves
             * genuine duplicates (same tokenType+model — see claudeRowKey's note
             * on why those occur) in whatever order the KQL happened to return,
             * and the KQL has no ORDER BY. The first insert wins the unique
             * index, so WHICH duplicate's `tokens`/`metadata` gets persisted
             * would vary between replays of the same span. The cost was already
             * deterministic (dedupeSpanRows picks the larger estimate); this
             * makes the persisted ROW deterministic too.
             *
             * Tie-break on tokens DESC because it is the SAME choice
             * dedupeSpanRows makes: within one (tokenType, model) the rate is
             * identical, so larger estimate and larger tokens are the same row.
             * Picking differently here would persist one duplicate's tokens
             * beside the other's cost.
             */
            [...recs].sort((a, b) => {
              const ka = claudeRowKey(a)
              const kb = claudeRowKey(b)
              if (ka !== kb) return ka < kb ? -1 : 1
              if (a.tokens !== b.tokens) return a.tokens > b.tokens ? -1 : 1
              // Fully-identical duplicates: order cannot matter, but pin it
              // anyway so a replay is byte-identical.
              const ra = a.sourceRunId ?? ''
              const rb = b.sourceRunId ?? ''
              return ra < rb ? -1 : ra > rb ? 1 : 0
            }),
          )
        }
      }

      for (const unit of writeUnits) {
        // Resolved OUTSIDE the transaction below: everything here reads
        // already-committed state (the project, the assignment, the activity
        // label) and none of it depends on what the ledger holds for this span,
        // so keeping it out keeps the transaction to a lock, a read and the
        // inserts. `pending` is what will actually be written, in row-key order.
        const pending: {
          rec: UsageRecord
          values: typeof schemaImport.attributionRecord.$inferInsert
          spilled: boolean
        }[] = []
        for (const rec of unit) {
          // Copilot: cost from AI credits (nano_aiu), NOT token rate card.
          // Claude: cost from token rate card (unchanged).
          let costUsd: string | null
          // Copilot reconciliation operand (native AI credits). Persisted ONCE per
          // span on the same surviving row as cost_usd; '0' on subsequent token_type
          // rows; null for Claude (token lane). See computeCopilotCreditQty.
          let creditQty: string | null = null
          // The rate card this row prices against, PINNED on the row (COST-7 /
          // mig 0036 semantics). Null for Copilot (AI-credit constant, no card)
          // AND null when the PROVIDER priced the row — see the Claude branch.
          let card: RateCardWithLines | null = null
          // True when this row's cost came from the provider's own figure (rung 1)
          // rather than our rate card. Drives cost_basis = 'provider-reported'.
          let providerPriced = false
          // The rate card's estimate for THIS row, carried into
          // metadata.rate_card_cost_usd on provider-priced rows so the cost-drift
          // diagnostic still has something to compare the provider against once
          // cost_usd holds the provider's own number (mig 0091). Null when the
          // card priced the row (cost_usd IS the estimate) or produced none.
          let rateCardRowUsd: string | null = null
          if (isCopilot) {
            // Cost = nano_aiu × 1e-11 (= credits × $0.01).
            // nano_aiu is the same value on all token_type rows for a given span.
            // To avoid 4× counting, price it once per span (keyed by tsEvent+sourceRunId)
            // on the DETERMINISTIC carrier token_type (ING-5) — fixed priority with
            // fallback, not specifically 'input', because if input_tokens==0 the
            // reader drops the input row and the cost would be lost.
            const spanKey = `${rec.tsEvent}:${rec.sourceRunId ?? ''}`
            if (spanCarrier.get(spanKey) === rec.tokenType && !copilotPricedSpans.has(spanKey)) {
              costUsd = computeCopilotCost(rec.nanoAiu)
              if (costUsd === null) {
                // nano_aiu absent, non-finite/non-positive, rounds to zero, OR
                // out-of-range (B — computeCopilotCost's storability bound) —
                // skip this record (under-report is safer than over). Reuses
                // the existing skippedNoCard counter deliberately: it already
                // means "could not price this record", which is exactly what
                // an out-of-range nano_aiu is too.
                skippedNoCard += 1
                continue
              }
              // ING-5: a prior partial tick (or the pre-deterministic code) may
              // already hold this span's cost on a DIFFERENT token_type row —
              // never write a second full-cost row for the same span.
              const [priced] = await db.execute<{ ok: number }>(sql`
                SELECT 1 AS ok FROM attribution_record
                WHERE instance_id = ${session.instance_id}::uuid
                  AND ts_event = ${rec.tsEvent}::timestamptz
                  AND COALESCE(source_run_id, '') = ${rec.sourceRunId ?? ''}
                  AND cost_usd > 0
                LIMIT 1
              `)
              if (priced) {
                costUsd = '0.000000'
                creditQty = '0.000000'
              } else {
                // credit_qty is the SAME nano_aiu, so it survives iff cost did.
                creditQty = computeCopilotCreditQty(rec.nanoAiu)
              }
              copilotPricedSpans.add(spanKey)
            } else {
              // Non-carrier token_type rows for the same span: tokens recorded for
              // reporting only, cost (and credits) attributed on the carrier row.
              costUsd = '0.000000'
              creditQty = '0.000000'
            }
          } else {
            // Claude: read this row's share out of the span plan computed above.
            const entry = claudeSpanPlans.get(claudeSpanKey(rec))!
            const micros = entry.plan.costs.get(claudeRowKey(rec))
            if (micros === undefined) {
              // Absent from the plan = nothing could price this row: either the
              // whole span skipped (rung 3 — no provider figure AND no card), or
              // the card priced other rows of the span but has no line for this
              // one. Both are the pre-existing per-record skip, unchanged:
              // under-reporting beats a silently-zero row.
              skippedNoCard += 1
              continue
            }
            costUsd = microsToUsd(micros)
            // Provenance (mig 0036 semantics, restated by the design): the card is
            // pinned ONLY when the card decided the AMOUNT. On a provider-priced
            // row the card decided only how the provider's total was SLICED, so
            // pinning it would claim a costing provenance that is not true —
            // rate_card_id / rate_card_version stay NULL, which is exactly what
            // 0036 made them nullable for. Verified: no reader joins on the pin.
            providerPriced = entry.plan.rung === 'provider'
            card = providerPriced ? null : entry.card
            if (providerPriced) {
              // Persist the estimate we are NO LONGER booking. Only meaningful on
              // provider-priced rows: on a rate-card-priced row cost_usd already
              // IS the estimate, so re-storing it would be dead weight on the
              // hottest write path in the system. Absent when the card had no line
              // for this row (an unknown token type) — mig 0091 then drops the
              // whole span from the drift view rather than SUMming a partial
              // estimate, which is the honest degradation.
              const est = entry.estimates.get(claudeRowKey(rec))
              if (est !== undefined) rateCardRowUsd = microsToUsd(est)
            }
          }

          // Project-lifecycle spill (D2), PER EVENT. A post-end event is written
          // UNALLOCATED — project_id/cou nulled — so it lands in the dev's
          // needs-tagging / tagged-spill lane as the re-tag signal (D2a). Activity
          // is PRESERVED (tagged spills stay categorised). Pre-end events in the
          // SAME conversation keep their attribution → the conversation splits.
          // Deterministic on the frozen ts_event, so active-session re-scans are stable.
          let recProjectId = projectId
          let recCou = cou
          const spilled = spillAfterMs !== null && new Date(rec.tsEvent).getTime() > spillAfterMs
          if (spilled) {
            recProjectId = null
            recCou = null
          }

          // Backfill provenance (ADR-0005 slice 3): a record re-emitted by
          // /tokenscope:backfill carries the tokenscope.backfill=true resource
          // attr. It is a CAPPED, NON-RECONCILED provenance class — dedup makes it
          // idempotent but does NOT make it tier-1 truth. Mark it advisory so it's
          // visibly distinguishable AND excluded from reconciliation (telemetry-only
          // already drops out of the reconciliation CTE, which compares against the
          // authoritative Anthropic actual). metadata.backfill is the explicit,
          // queryable provenance flag on top of the tier/basis.
          const recFidelityTier = rec.backfill ? 'tier-2' : fidelityTier
          /*
           * cost_basis is OVERLOADED — it carries two different questions on one
           * column — and the order below is load-bearing:
           *
           *   'telemetry-only' answers "is this row RECONCILABLE?" — no, because
           *      the org is unknown/indicative, or the record was re-emitted by
           *      /tokenscope:backfill. Every reconciliation query keys on it
           *      (`cost_basis <> 'telemetry-only'`), so it MUST WIN: promoting such
           *      a row just because the provider priced it would quietly walk
           *      unreconcilable spend into the reconcilable lane, and would lose
           *      the backfill provenance ADR-0005 slice 3 depends on.
           *   'provider-reported' vs 'estimated' answers "WHICH RUNG priced it?" —
           *      the provider's own figure, or our rate card. Both are reconcilable
           *      (mig 0039 maps anything that is not 'telemetry-only' to
           *      spend_class 'estimated'), so adding the literal changes no
           *      existing reader; it only makes the rung visible per row.
           *
           * CONSEQUENCE, and mig 0091 depends on it: because 'telemetry-only' wins,
           * cost_basis alone is NOT a reliable rung marker — a backfilled span the
           * provider priced reads 'telemetry-only'. For tool='claude-code' the
           * exact marker is `rate_card_id IS NULL`: a rate-card-priced row has
           * ALWAYS pinned its card, so a NULL pin can only mean something other
           * than the card priced it. Keep that invariant strict.
           */
          const recCostBasis =
            rec.backfill || costBasis === 'telemetry-only'
              ? 'telemetry-only'
              : providerPriced
                ? 'provider-reported'
                : costBasis
          // metadata keys MERGE (mig 0045): law_cost_usd (Claude's own per-event
          // cost, duplicated per token-type row by the KQL mv-expand; v_cost_drift
          // aggregates it MAX per span) coexists with the backfill flag.
          const metaObj: Record<string, unknown> = {}
          if (rec.backfill) metaObj.backfill = true
          if (rec.lawCostUsd !== undefined) metaObj.law_cost_usd = rec.lawCostUsd
          // The displaced rate-card estimate (see rateCardRowUsd above). Stored as
          // an exact 6-dp DECIMAL STRING, not a JSON number: mig 0091 reads it with
          // ->>'…'::numeric, which accepts either, and a string cannot pick up the
          // float re-rendering artefacts a JSON number round-trip can.
          if (rateCardRowUsd !== null) metaObj.rate_card_cost_usd = rateCardRowUsd
          const recMetadata = Object.keys(metaObj).length > 0 ? metaObj : null

          // Activity (mig 0020): denormalise the conversation's activity label from
          // session_assignment, if the teammate tagged one. Independent of project.
          // This stamps NEW rows only (onConflictDoNothing skips existing); the
          // assign endpoint backfills already-attributed rows, so both converge.
          // assign is the sole activity write path in MVP — keep it that way.
          let activity: string | null = null
          if (rec.claudeSessionId) {
            let a = convActivityCache.get(rec.claudeSessionId)
            if (a === undefined) {
              const [row] = await db.execute<{ activity: string | null }>(sql`
                SELECT activity FROM session_assignment
                WHERE claude_session_id = ${rec.claudeSessionId}
                  AND teammate_id = ${session.teammate_id}::uuid
                LIMIT 1
              `)
              a = row?.activity ?? null
              convActivityCache.set(rec.claudeSessionId, a)
            }
            activity = a
          }

          // R1 #5: atomic idempotency. The old SELECT-then-INSERT was non-atomic —
          // two concurrent joins (a scheduled tick + an inline assign-join, or a
          // replayed trigger) on the same session both saw "not present" and both
          // inserted, double-counting spend. ON CONFLICT DO NOTHING on the
          // (instance_id, COALESCE(claude_session_id,''), ts_event, token_type,
          // model, COALESCE(source_run_id,'')) unique index (migrations 0011+0017+0035)
          // makes it race-safe. source_run_id (0035) prevents parallel-subagent
          // same-ms collisions (Copilot fleet mode).
          pending.push({
            rec,
            spilled,
            values: {
              instanceId: session.instance_id,
              // Claude's per-conversation session.id (subagents share their parent's),
              // so the session views can group spend per conversation rather than
              // collapsing every conversation on a device into one instance row.
              claudeSessionId: rec.claudeSessionId ?? null,
              teammateId: session.teammate_id,
              // NULL = unallocated (untagged / unknown-project / unauthorized
              // spill / post-end lifecycle spill). Otherwise the membership-gated
              // project. recProjectId/recCou are the PER-EVENT values (D2 spill).
              projectId: recProjectId,
              regionId: session.region_id,
              orgUnitId: session.org_unit_id,
              // Cost-owning unit follows the ATTRIBUTED project (B′): the project's
              // COU, or NULL when unallocated / spilled. (region_id/org_unit_id
              // remain the emitting teammate's — they describe who incurred it.)
              costOwningUnitId: recCou,
              tool: session.tool,
              model: rec.model,
              tokenType: rec.tokenType,
              tokens: BigInt(rec.tokens),
              costUsd,
              // Copilot: native AI-credit operand (nano_aiu/1e9) for credit-lane
              // reconciliation; null for Claude (token lane). Priced once per span.
              creditQty,
              // Copilot: no rate_card row (priced by AI-credit constant, not token lines).
              // Claude: the matched rate card row.
              rateCardId: card?.id ?? null,
              rateCardVersion: card?.version ?? null,
              fidelityTier: recFidelityTier,
              costBasis: recCostBasis,
              tsEvent: new Date(rec.tsEvent),
              sourceRunId: rec.sourceRunId,
              isFrozen: true,
              activity,
              // Per-event lane (mig 0045). NULL = unknown (legacy emission /
              // attr absent) — never defaulted to 'main'.
              querySource: rec.querySource ?? null,
              // Identity provenance (mig 0057): propagate the emitting instance's
              // identity_state ('provisional' | 'confirmed') so downstream surfaces
              // can exclude/label provisional usage. Money is gated by reconciled,
              // not this — display + human-paging discipline only.
              identityState: session.identity_state,
              /*
               * ── Emitting identity + billing lane (mig 0119) ──────────────
               * The lane is decided HERE, per RECORD, and never again. Per
               * record and not per session on purpose: one claude_session_id
               * can carry two addresses (a developer switching accounts
               * mid-conversation), and collapsing that to a session-level
               * verdict would misclassify one of the two halves.
               *
               * emitting_email arrives already canonicalised from the parser.
               * emitting_org_id is the PER-RECORD organization.id — note it is
               * deliberately NOT the value that picked the reconciliation lane
               * above (that one is a single organization.id chosen for the
               * whole grouped session). Storing the per-record value is what
               * makes this column useful as the diagnostic §5 describes, and
               * it never decides the lane.
               *
               * It reads `rec.emittingOrgId`, the BOUNDED field, not
               * `rec.organizationId`, the raw lane operand (server/azure/
               * reader.ts's two-fields-from-one-value split). This is the only
               * write of the value, so the storage bound belongs here and
               * nowhere upstream of the lane decision.
               */
              // canonicaliseEmail again, even though the Log Analytics parser
              // already did: the column's contract is "canonicalised" and this
              // is the write that has to honour it, whatever produced the
              // record. Idempotent, so the double application costs nothing.
              emittingEmail: canonicaliseEmail(rec.emittingEmail) || null,
              emittingOrgId: rec.emittingOrgId ?? null,
              billingLane: classifyBillingLane(rec.emittingEmail, enterpriseAddresses),
              metadata: recMetadata,
            },
          })
        }

        if (pending.length === 0) continue

        /*
         * Does this unit need the ledger reconciled before it is written?
         *
         * Only a PROVIDER-costed Claude span does: it is the one case with a
         * span TOTAL to conserve. A rate-card span's rows each carry their own
         * independent per-row estimate, and the Copilot lane has its own
         * per-span carrier guard, so neither has anything to reconcile.
         */
        const unitEntry = isCopilot ? undefined : claudeSpanPlans.get(claudeSpanKey(unit[0]!))
        const needsReconcile = unitEntry !== undefined && unitEntry.plan.rung === 'provider'

        const writePending = async (exec: JoinerExec) => {
          const tally = { rows: 0, spills: 0 }
          for (const p of pending) {
            const ins = await exec
              .insert(schemaImport.attributionRecord)
              .values(p.values)
              // Dedup on the (instance_id, COALESCE(claude_session_id,''), ts_event,
              // token_type, model) unique index (migration 0017). No explicit target:
              // it's an EXPRESSION index (the COALESCE), which a drizzle column-list
              // target can't name; attribution_record has exactly one unique index, so
              // a bare DO NOTHING dedups on it without risk of swallowing another.
              .onConflictDoNothing()
              .returning({ id: schemaImport.attributionRecord.id })
            if (ins.length > 0) {
              tally.rows += 1
              if (p.spilled) tally.spills += 1
              // (C) — telemetry-only measurement, gated on NEWLY-WRITTEN rows
              // exactly like the spill/unknown-project counters above: the
              // watermark's 5-minute overlap re-reads the same rows every
              // tick, and un-gated this would re-inflate the total on every
              // pass instead of reporting what THIS tick actually wrote.
              if (p.values.costBasis === 'telemetry-only' && p.values.costUsd) {
                const day = (p.values.tsEvent as Date).toISOString().slice(0, 10)
                const key = `${p.values.regionId}\0${day}`
                const rowMicros = usdToMicros(p.values.costUsd) ?? 0n
                telemetryOnlyMicros.set(key, (telemetryOnlyMicros.get(key) ?? 0n) + rowMicros)
              }
            } else {
              await fillEmittingIdentity(exec, p.values)
            }
          }
          return tally
        }

        // Counters are folded in only AFTER the write resolves. A transaction
        // that throws rolls its rows back, so counting inside it would report
        // spend that is not on the ledger — and `written` is what the run result
        // and every recovery decision are read from.
        const tally =
          pending.length === 1 && !needsReconcile
            ? /*
               * A single INSERT is already atomic. This fast path is reached by
               * the COPILOT lane and by rate-card-costed Claude rows — NOT by a
               * one-row provider span, because needsReconcile is true for every
               * provider-costed span regardless of how many rows this tick sees.
               *
               * DO NOT "optimise" that by skipping the transaction when a
               * provider span has one pending row. It reads like free overhead
               * and it is a double-count bug: the row count is what THIS TICK
               * saw, not what the span has. If an earlier tick saw only {input}
               * and booked the full span total on it, a later tick seeing only
               * {output} would also have one pending row — and without the
               * reconcile it would write the full total a SECOND time. The
               * reconcile is what makes that later row allocate
               * total - booked = 0.
               */
              await writePending(db)
            : await db.transaction(async (tx) => {
                if (needsReconcile) {
                  const booked = await readBookedSpan(tx, session.instance_id, unit[0]!)
                  const replanned = replanAgainstBooked(unitEntry!.plan, unitEntry!.rows, booked)
                  // Only the AMOUNT can change here. The rung (and therefore
                  // cost_basis, the card pin and metadata.rate_card_cost_usd) is
                  // decided by the provider figure alone, which reconciliation
                  // does not touch — so the rest of each row stands as resolved.
                  for (const p of pending) {
                    const micros = replanned.costs.get(claudeRowKey(p.rec))
                    if (micros !== undefined) p.values.costUsd = microsToUsd(micros)
                  }
                }
                return writePending(tx)
              })
        written += tally.rows
        groupNewRows += tally.rows
        groupEndedSpillNew += tally.spills
      }

      // ING-8: unknown-project / unauthorized-spill counters + audits, gated on
      // newly-written rows exactly like the ended-spill path below — overlap
      // re-reads that dedup to zero must not re-fire the append-only audits.
      if (groupNewRows > 0 && unknownProject) {
        await auditFailSoft(db, {
          eventType: 'attribution-unknown-project',
          actorTeammateId: session.teammate_id,
          actorSystem: 'read-joiner',
          subjectKind: 'session',
          subjectId: session.instance_id,
          payload: {
            project_code_hash: key,
            spans: groupNewRows,
            reason: 'emitted project.code_hash matches no registered project — left unallocated',
          },
        })
      }
      if (groupNewRows > 0 && unauthorizedProjectId) {
        spilledUnauthorized += groupNewRows
        await auditFailSoft(db, {
          eventType: 'attribution-spill-unauthorized',
          actorTeammateId: session.teammate_id,
          actorSystem: 'read-joiner',
          subjectKind: 'session',
          subjectId: session.instance_id,
          payload: {
            project_code_hash: key,
            project_id: unauthorizedProjectId,
            spans: groupNewRows,
            reason: 'teammate not assigned to tagged project — billed as unallocated (spill)',
          },
        })
      }

      // Project-lifecycle spill (D2/D2a) — one summary audit + the re-tag inbox
      // signal (Step 8) per group that spilled NEW rows this tick. Gating on
      // newly-written rows (not all spilled events re-read in the overlap window)
      // keeps the counter honest and the append-only audit from re-emitting every
      // tick. `projectId` is the (now-ended) project the spend used to bill to.
      if (groupEndedSpillNew > 0 && projectId) {
        spilledEnded += groupEndedSpillNew
        await auditFailSoft(db, {
          eventType: 'attribution-spill-ended',
          actorTeammateId: session.teammate_id,
          actorSystem: 'read-joiner',
          subjectKind: 'project',
          subjectId: projectId,
          payload: {
            project_code_hash: key,
            project_id: projectId,
            spans: groupEndedSpillNew,
            reason: 'project ended — events past end_date + grace spilled to unallocated (re-tag signal)',
          },
        })
        await notifyProjectEndedRetag(db, { teammateId: session.teammate_id, projectId })
      }
    }
  }

  // Behavioural usage-signal landing (mig 0065). Teammate-grain: NO project
  // gating, rate card, or lifecycle resolution — resolve instance→teammate (already
  // on SessionRow) and dedup-insert one row per (span, signal). Dedup key
  // (instance, COALESCE(source_run_id,''), signal_name) makes the watermark's
  // overlapping re-reads idempotent via onConflictDoNothing.
  const landSignals = async (session: SessionRow): Promise<void> => {
    if (typeof reader.getSignalUsage !== 'function') return
    // Third lane folding into the SAME `parseCounters` accumulator (the "three
    // local counter objects merged into one" this story requires).
    const signals = await reader.getSignalUsage(
      session.instance_id,
      signalWatermarks.get(session.instance_id),
      parseCounters,
    )
    if (signals.length === 0) return
    for (const sig of signals) {
      const ins = await db
        .insert(schemaImport.usageSignalRecord)
        .values({
          instanceId: session.instance_id,
          teammateId: session.teammate_id,
          tool: session.tool,
          signalName: sig.signalName,
          value: String(sig.value), // numeric column — pass as string
          tsEvent: new Date(sig.tsEvent),
          sourceRunId: sig.sourceRunId ?? null,
        })
        .onConflictDoNothing()
        .returning({ id: schemaImport.usageSignalRecord.id })
      if (ins.length > 0) signalRowsWritten += 1
    }
  }

  for (const session of sessions) {
    try {
      await processSession(session)
    } catch (err) {
      // ING-6: isolate the bad session so it cannot starve the remaining
      // instances this tick (the documented silent-attribution-stop class);
      // it is retried on the next tick. Surfaced via JoinResult.errors.
      errors += 1
      console.warn(
        `[azure-monitor-read] instance ${session.instance_id} failed; continuing with remaining sessions: ${String(err)}`,
      )
    }
    // Signal lane in its OWN try/catch — a signal-path fault must never affect the
    // token attribution above (billing-sacred) nor the JoinResult.errors count.
    try {
      await landSignals(session)
    } catch (err) {
      signalErrors += 1
      console.warn(
        `[azure-monitor-read] signal landing failed for instance ${session.instance_id}; token attribution unaffected: ${String(err)}`,
      )
    }
  }

  /*
   * THE ALERT (docs/design/provider-cost-precedence.md §"When the provider gives
   * us nothing"). Rung 2 firing is the unexpected case — the rate card is not a
   * costing mechanism, so if it priced a real span something is wrong upstream
   * (a client version that stopped reporting cost, a renamed attribute, an
   * ingestion change) and the correct response is to tell somebody rather than
   * compute a better guess quietly. The count also rides worker_run.result so it
   * is queryable after the fact, not only a log line nobody reads.
   */
  if (costingRungs.rateCard > 0) {
    consola.warn(
      `[azure-monitor-read] ${costingRungs.rateCard} span(s) had NO usable provider cost and fell back to the rate card ` +
        `(provider=${costingRungs.provider}, carrier=${costingRungs.carrier}, skipped=${costingRungs.skipped}). ` +
        'The rate card is a fallback, not a costing mechanism — check that the client is still emitting cost_usd.',
    )
  }
  // The single-carrier fallback keeps the span's TOTAL exact but collapses its
  // per-token-type breakdown onto one row. Its most likely cause is a NEW
  // billable token type the rate card has no line for (a reasoning token,
  // another cache tier) — worth saying out loud so somebody adds the line,
  // rather than leaving it to be noticed as a lopsided chart.
  if (costingRungs.carrier > 0) {
    consola.warn(
      `[azure-monitor-read] ${costingRungs.carrier} provider-costed span(s) could not be sliced by the rate card ` +
        '— the full cost landed on a single carrier row. Usually an unknown token type with no rate line.',
    )
  }

  // The joiner is what MOVES a conversation's unallocated total, so it is where
  // a dismissal can go stale: an item waved through at $0.01 that has since
  // emitted real spend must come back for a fresh decision rather than stay
  // silently dismissed. One bounded statement over the (few) dismissed rows.
  let staleDismissals = { sessions: 0, unaccounted: 0, missingSnapshots: 0 }
  try {
    staleDismissals = await sweepStaleDismissals(db)
    if (staleDismissals.sessions > 0) {
      consola.info(
        `[azure-monitor-read] returned ${staleDismissals.sessions} dismissed conversation(s) to the needs-tagging queue — their spend outgrew the dismissal.`,
      )
    }
    if (staleDismissals.missingSnapshots > 0) {
      consola.warn(
        `[azure-monitor-read] ${staleDismissals.missingSnapshots} swept dismissal(s) carried no dismissed_cost_usd baseline — some writer set dismissed_at without it.`,
      )
    }
  } catch (e) {
    // Housekeeping, not the tick's job: the attribution rows above are already
    // written and correct. A failed sweep retries next tick; failing the whole
    // run here would be the "cron gives up on healthy work" pattern this repo
    // has already been bitten by once (#199).
    consola.error('[azure-monitor-read] stale-dismissal sweep failed; attribution is unaffected', e)
  }

  return {
    sessionsProcessed: sessions.length,
    attributionRowsWritten: written,
    usageRowsFetched,
    newEventsSeen,
    // Echoed from the caller's ingest-side probe (JoinOptions.sourceCoverage);
    // null when no probe ran (recovery / tests). runReadJoiner never probes.
    sourceCoverage: opts.sourceCoverage ?? null,
    staleDismissalsReturned: staleDismissals.sessions,
    spansSkippedNoRateCard: skippedNoCard,
    costingRungs,
    spansSpilledUnauthorized: spilledUnauthorized,
    spansSpilledEnded: spilledEnded,
    errors,
    deepRescan: opts.deepRescan ?? false,
    signalRowsWritten,
    signalErrors,
    // Echo the caller's selection cap hit into worker_run.result. Defaults to
    // null: a caller that supplied its own sessionIds ran no selection and must
    // never report someone else's cap hit.
    selectionCapHit: opts.selectionCapHit ?? null,
    // Evidence of what ran (see JoinResult): a dropped signed body silently
    // downgrades a recovery to a default tick, and only these fields tell them apart.
    // Read back from the READER, not recomputed from the request: a reader that
    // ignores the option (the local collector) reports undefined -> null rather
    // than a window it never applied.
    lookbackDaysApplied: reader.appliedLookbackDays ?? null,
    scoped: opts.scoped ?? false,
    // S10: the ingest-boundary reject counter (see JoinResult.parseCounters) —
    // always present, even on a run that rejected nothing, matching this
    // file's "never omit the object" convention for costingRungs above.
    parseCounters,
    // S10 (C): telemetry-only spend written this tick, per (region, day).
    // Deterministic order (region, then day) so a diff between two ticks is
    // legible and tests can assert without a sort step of their own.
    telemetryOnlySpend: [...telemetryOnlyMicros.entries()]
      .map(([key, micros]) => {
        const [regionId, day] = key.split('\0') as [string, string]
        return { regionId, day, totalUsd: microsToUsd(micros) }
      })
      .sort((a, b) =>
        a.regionId === b.regionId
          ? a.day < b.day
            ? -1
            : a.day > b.day
              ? 1
              : 0
          : a.regionId < b.regionId
            ? -1
            : 1,
      ),
  }
}

/*
 * Scope-aware + temporal rate-card selection (COST-4/COST-6, mig 0050).
 * Precedence ladder per the contract in 0050_rate_card_scope.sql:
 * (cou match) > (region match) > (global); within each tier only cards whose
 * `effective` range contains the EVENT timestamp and retired_at IS NULL,
 * tie-broken by highest version. Consistent with the estimates path
 * (server/usage/insights.ts fetchRateLines: `effective @> now()`), which this
 * previously diverged from — a card whose period had ENDED kept pricing new
 * events if it carried the highest version.
 *
 * regionId is the teammate's region from the attestation row. NULL (defensive
 * — the column is NOT NULL) degrades to global-tier cards only.
 *
 * CONTRACT (R1 F7, explicit): the pricing region is the ENROLMENT region —
 * the attestation row's region at provision time, not the teammate's current
 * row. A teammate who changes region keeps pricing against the old region's
 * cards until re-enrolment (instances carry a 90d TTL, so the staleness
 * window is bounded). Move-day repricing would make historic costing depend
 * on a MUTABLE column — the worse trade. Revisit with the recost design
 * (docs/design/recost-propagation.md).
 *
 * TODO(cou tier): cou_id selection is NOT implemented yet — `cou_id IS NULL`
 * below excludes CoU-scoped cards entirely, so a future cou-scoped card can
 * never leak into the wrong scope via version ordering. Landing the tier needs
 * (a) a write path that creates cou-scoped cards and (b) a decision on lineage
 * semantics (does a card scoped at an ancestor org_unit cover descendant
 * CoUs?) — which requires an ltree ancestor walk we must NOT bolt on per-event
 * here. When it lands, add the cou predicate + `(cou_id IS NOT NULL) DESC`
 * tier to the ORDER BY and key the joiner cache by cou as well.
 *
 * INVARIANT: with only the seeded card (mig 0004 — global, region_id NULL,
 * effective [2026-01-01, 2099-01-01)) every existing event resolves to it
 * exactly as before the 0050 change.
 */
async function resolveRateCard(
  db: PostgresJsDatabase<typeof schema>,
  tool: string,
  eventTs: string,
  regionId: string | null,
): Promise<RateCardWithLines | null> {
  const provider =
    tool === 'claude-code' ? 'anthropic' : tool === 'copilot-cli' ? 'github' : null
  if (!provider) return null
  const scopeKey = `${provider}:${tool}`
  const cards = await db.execute<{ id: string; version: number }>(
    sql`SELECT id::text AS id, version FROM rate_card
        WHERE scope_key = ${scopeKey}
          AND retired_at IS NULL
          AND effective @> ${eventTs}::timestamptz
          AND (region_id IS NULL OR region_id = ${regionId}::uuid)
          AND cou_id IS NULL
        ORDER BY (region_id IS NOT NULL) DESC, version DESC
        LIMIT 1`,
  )
  const card = cards[0]
  if (!card) return null
  const lines = await db.execute<RateLine>(
    sql`SELECT unit, unit_qty::text AS unit_qty, unit_cost_usd::text AS unit_cost_usd, model
        FROM rate_line WHERE rate_card_id = ${card.id}::uuid`,
  )
  return { id: card.id, version: card.version, lines }
}

function computeCost(
  card: RateCardWithLines,
  tokenType: string,
  model: string,
  tokens: number,
): string | null {
  const candidates = card.lines.filter((l) => l.unit === tokenType)
  if (candidates.length === 0) return null
  const exact = candidates.find((l) => l.model === model)
  const line = exact ?? candidates.find((l) => l.model === null)
  if (!line) return null

  const unitQty = Number(line.unit_qty)
  const unitCost = Number(line.unit_cost_usd)
  if (!Number.isFinite(unitQty) || unitQty === 0) return null
  const cost = (tokens / unitQty) * unitCost
  return cost.toFixed(6)
}
