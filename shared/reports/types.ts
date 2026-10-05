/*
 * reports/types — the shared contract the reporting API and the Reporting UI
 * agree on (reporting-consolidation Wave 1, docs/design/reporting-consolidation/
 * 00-build-design.md §3/§5). Lives in `shared/` so the server builds it and the
 * app imports it via `#shared/reports/types`. Pure types + small const arrays —
 * no runtime deps, safe on both sides of the wire.
 */
import type { UsageProvenance } from '../usage/provenance'
import type { ArmMeasure, BilledMeasure } from './provider-measure'

export type { ArmMeasure, BilledMeasure }

// ── Scopes ───────────────────────────────────────────────────────────────────
/*
 * The Region scope's whole-company WIDTH, spelled as a `?region=` value.
 *
 * A sentinel rather than "region absent" because absent already means something
 * else and has to keep meaning it: a bare `?scope=region` lands on the caller's
 * DEFAULT region, resolved server-side. If unclamped were the empty case, every
 * caller whose selector does not offer "All regions" would land on the one width
 * they are not granted, and the resolver could never tell "I want the whole
 * company" from "I did not say". Not a UUID, so it can never collide with a region
 * id — `region.id` is a uuid column.
 */
export const ALL_REGIONS = 'all'

/**
 * The two widths the Region scope answers at. `all-regions` routes to the engine's
 * `wholeCompanyUsage` scope, `region` to `clampedUsage` — the discriminator every
 * `/reports/region*` response carries so a reader never has to infer which one it got.
 */
export type RegionWidth = 'all-regions' | 'region'

/*
 * The three role-gated reporting scopes (build-design §1). URL-synced via `?scope=`,
 * and the ORDER is the default-scope preference: region → cost-centre → finance.
 *
 * There were four. `across` and `regional` merged into `region`
 * (04-prototype-delta.md §6): the whole-company answer is not a second scope, it is
 * the Region scope's UNCLAMPED width — the "All regions" first option of its region
 * selector. `ReportScope` is the type the shell and every endpoint switch on, which
 * is why the merge is one edit here and a compiler error everywhere it mattered.
 */
export const REPORT_SCOPES = ['region', 'cost-centre', 'finance'] as const
export type ReportScope = (typeof REPORT_SCOPES)[number]

export function isReportScope(v: string): v is ReportScope {
  return (REPORT_SCOPES as readonly string[]).includes(v)
}

/**
 * The `?scope=` values retired by the Region merge, mapped to their replacement.
 * Honoured for ONE RELEASE so a bookmarked or shared URL keeps working.
 *
 * `region` is an OVERRIDE, and `null` means "no override":
 *   - `across`   → `region: 'all'`. That scope only ever meant the whole company, so
 *                  the width is part of the mapping, not something the URL supplied.
 *   - `regional` → `null`. It maps straight across and keeps whatever region it
 *                  carried (including none, which still means the caller's default).
 *
 * One table, consumed by the URL state, the shell and the CSV export, so the three
 * cannot map the same legacy value to different places.
 */
export const LEGACY_REPORT_SCOPES = {
  across: { scope: 'region', region: ALL_REGIONS },
  /*
   * THREE keys for TWO retired scopes, because the two surfaces spelled the
   * whole-company one differently and both spellings are out there in saved URLs.
   *
   * `04-prototype-delta.md` §6 lists the export's old values as `across | regional`.
   * That is wrong about the shipped code: `/reports/export` validated
   * `z.enum(['regional', 'across-regions'])` — the ROUTE's name — while the UI's
   * `?scope=` used `across`. So an export link in a runbook says `across-regions`
   * and a reporting link in Slack says `across`, and dropping either would break
   * exactly the artefacts the compatibility window exists for.
   *
   * They are in ONE table rather than a per-surface table each, so a spelling cannot
   * resolve to one width in the URL state and another in the export.
   */
  'across-regions': { scope: 'region', region: ALL_REGIONS },
  regional: { scope: 'region', region: null },
} as const satisfies Record<string, { scope: ReportScope; region: string | null }>

export type LegacyReportScope = keyof typeof LEGACY_REPORT_SCOPES

export function isLegacyReportScope(v: string): v is LegacyReportScope {
  return Object.prototype.hasOwnProperty.call(LEGACY_REPORT_SCOPES, v)
}

// ── Spend class ──────────────────────────────────────────────────────────────
// How a money figure should be READ (build-design §5, D-Q6 §A/§B separation):
//  - 'estimated'    — inference/run-rate; "emitted, not the billed P&L figure".
//  - 'indicative'   — a usage-lane $ for spend the bill has not (yet) confirmed.
//  - 'pooled-usage' — per-teammate Copilot USD: informational only, billing is
//                     POOLED per cost-centre — NEVER a per-user charge.
//  - 'billed'       — the provider's OWN money, read from the BILLED lane
//                     (`provider_usage_fact`; target-state-data-architecture.md
//                     §2 "only the provider API writes it — this is the money").
//
// 'billed' EXISTS BECAUSE THE CONTRACT HAD TO BE VERSIONED, not for symmetry.
// Driver rows were hard-coded 'indicative', and the UI renders every
// informational class muted with the title "informational — not a charge"
// (app/components/reporting/DriversTable.vue). Repointing those rows at the
// billed lane WITHOUT a new class would have labelled real invoiced money
// not-a-charge — the worst direction for that error to run. It is the only
// SpendClass that is NOT informational, and the only one sourced from a lane
// the rate card can never reach. Do not widen it to a usage-lane figure to make
// a display tidier.
//
// IT IS ALSO PROVIDER-SCOPED. `provider_usage_fact.cost_usd` means BILLED money
// on an Anthropic row and gross CONSUMPTION on a GitHub one (mig 0120's table
// comment). Only rows whose provider bills at this grain carry 'billed';
// consumption rows keep 'pooled-usage', which already says exactly the right
// thing ("informational — billing is POOLED per cost-centre"). See
// `shared/reports/provider-measure.ts`, the single authority for that split.
export type SpendClass = 'estimated' | 'indicative' | 'pooled-usage' | 'billed'

// ── Measure lanes (target-state-data-architecture.md §2) ─────────────────────
/**
 * WHICH LANE a money measure was computed on. The two lanes are meant to differ
 * and the display selects one; the hazard this type exists to close is a
 * consumer ADDING a figure from one to a figure from the other.
 *
 *  - 'attributed' — *"show me"*. `v_complete_usage`: OTel + the API−OTel shadow
 *    fill + the ingest-only arm. Carries the session, project and activity.
 *    Everything contributes, and it is deliberately not the bill.
 *  - 'billed'     — *"charge me"*. `provider_usage_fact`, written by a provider
 *    API adapter alone. Carries the model on 100% of what it covers.
 *
 * They do not reconcile to each other and are not meant to: attributed
 * legitimately EXCEEDS billed where a personal subscription emits through an
 * enrolled machine (design §7), and billed legitimately exceeds attributed
 * wherever OTel never saw the spend.
 */
export type MeasureLane = 'attributed' | 'billed'

/**
 * Per-measure lane labels for a reporting response: the response FIELD PATH →
 * the lane that field was computed on.
 *
 * A response is allowed to carry more than one lane — the drivers endpoint
 * returns billed rows beside §A concentration, and both are wanted — but it must
 * then SAY so per measure, so no consumer can add across them. A response whose
 * measures are all one lane still declares it: "one lane" is a claim, and an
 * undeclared response is indistinguishable from one nobody checked.
 *
 * A key is a top-level field name, OR a dotted path into a composite that is
 * NOT single-lane.
 *
 * THE BUDGET AXIS IS WHY THIS IS NOT DECORATION. Selecting the chargeback lane
 * moves teammate / cost-centre / surface / model onto `provider_usage_fact`, but
 * the budget axis does not: `provider_usage_fact` has no project column, and the
 * project chargeback split (`v_finance_project_overlay`) is served on the
 * project page, not on this axis. So in the chargeback lane the budget axis
 * still answers `attributed`, and this map is where it says so rather than
 * letting the reader assume the lane from the toggle.
 */
export type MeasureLanes = Record<string, MeasureLane>

/**
 * How to read a billed-lane figure of $0 — the distinction between "nothing was
 * spent" and "nothing has been DERIVED yet".
 *
 * `provider_usage_fact` is populated by an hourly worker, so on a fresh
 * environment (and for any window the transform has not reached) it is empty.
 * Rendering that as "$0 across all drivers" states a fact about the estate that
 * the data does not support. These three states are disjoint and exhaustive.
 */
export type BilledLaneAvailability =
  /** Billed cost rows exist for this scope AND window — the figures are the money. */
  | 'present'
  /**
   * NO cost row exists anywhere in this window for this provider, in any scope.
   * The transform has not covered it. A $0 here is "not derived yet", NEVER
   * "nothing was spent" — say so rather than rendering a zero.
   */
  | 'no-data-yet'
  /**
   * The window HAS rows for this provider, but none in this scope. A genuine
   * measured zero: this region / cost centre has no billed spend in the window.
   */
  | 'none-in-scope'

/**
 * One PROVIDER's answer to a billed axis, kept whole and never merged with
 * another provider's.
 *
 * THIS SHAPE IS THE POINT OF THE TYPE. `provider_usage_fact.cost_usd` does not
 * mean the same thing on every row: Anthropic rows carry what the provider
 * CHARGED, GitHub rows carry gross AI-credit CONSUMPTION before the pooled
 * allowance (mig 0120). A single `SUM(cost_usd)` over the table adds billed
 * dollars to consumption dollars and calls the result billed — "not a figure
 * anyone is owed" (0120's own words). Arms make that sum unspellable: there is
 * no field anywhere on this contract that holds both.
 *
 * It is the same discipline `fetchTierExposure` already applies with its
 * provider union (`creditsUsd` held separate from `spendUsd`) — one shape, so
 * the two cards cannot disagree about what Copilot money is.
 */
export interface BilledAxisArm {
  /**
   * Stable identity of the arm: `${provider}:${measure}`.
   *
   * NOT `provider`, because one provider can contribute TWO arms to the same
   * axis and they mean opposite things: at the cost-centre axis GitHub sends a
   * `consumption` arm (gross AI credits, `provider_usage_fact`) AND a
   * `pooled-chargeback` arm (the net invoice, `v_finance_copilot_pool_chargeback`).
   * Keying a render loop or an export row on `provider` alone collapses them.
   */
  id: string
  /** `provider_usage_fact.provider` — 'anthropic' | 'github' | a future arm. */
  provider: string
  /** What this arm's money MEANS — see {@link ArmMeasure}. */
  measure: ArmMeasure
  /**
   * The RELATION this arm was read from, named because the chargeback lane has
   * more than one and they sit at different grains. A reader comparing two arms
   * must be able to see that one is per-teammate provider truth and the other is
   * a pooled monthly invoice line.
   */
  source: 'provider_usage_fact' | 'v_finance_copilot_pool_chargeback'
  /** How to read a $0 for THIS arm — see {@link BilledLaneAvailability}. */
  availability: BilledLaneAvailability
  /** Σ of this arm's `rows`. NEVER add this across arms of different measures. */
  totalUsd: number
  /** Ranked rows for this arm alone. Σ `rows[].usd` === `totalUsd`. */
  rows: DriverRow[]
}

// ── Chargeback coverage (WHOSE charge a chargeback figure actually is) ───────
/**
 * A provider whose chargeback is NOT in the headline, and why.
 *
 * WHY THIS IS A FIRST-CLASS FIELD AND NOT A UI CONSTANT. Left unstated, the axis
 * renders an Anthropic subtotal under a company-wide label — a figure that is
 * not wrong so much as answering a different question than the one the label
 * asks. The `reason` is written server-side, beside the code that decided it.
 *
 * TWO KINDS OF ABSENCE ARRIVE THROUGH THIS ONE SHAPE, and a reader acts on them
 * differently, so the sentences must not converge:
 *
 *  - STRUCTURAL — a fact about the PROVIDER'S BILLING MODEL. Copilot raises one
 *    pooled invoice per cost-owning unit, so a per-teammate or per-model Copilot
 *    charge does not exist and never will. (Per-SURFACE does exist: the pooled
 *    view's own `tool` column is the bill's chargeback lane, so that axis carries
 *    the charge rather than gapping it — `engine/pooled-chargeback-axis.ts`.)
 *    Nothing the reader does will produce the number; changing axis will show it.
 *  - AVAILABILITY — the arm exists and nothing has been derived for this window.
 *    A missing worker run, not a property of the bill, and it resolves itself.
 */
export interface ChargebackGap {
  /**
   * The provider whose charge is absent from the headline; `null` when NO
   * provider can answer this axis at all (the budget axis — no provider bills at
   * project grain).
   */
  provider: string | null
  /** Reader-facing sentence: what is missing and why. Rendered verbatim. */
  reason: string
}

/**
 * WHOSE chargeback a chargeback-lane answer actually is. Present only on a
 * `lens: 'chargeback'` response; absent entirely in the usage lane, where the
 * question does not arise.
 *
 * `providers` and `gaps` are both published because neither implies the other:
 * an empty `gaps` is the claim "this figure is every provider that bills this
 * scope", and that claim has to be made explicitly rather than inferred from a
 * missing field.
 */
export interface ChargebackCoverage {
  /**
   * The providers whose chargeback IS folded into the headline at this axis.
   * Empty when the axis carries no chargeback at all (the budget axis).
   */
  providers: string[]
  /** Providers whose chargeback this axis cannot represent — see {@link ChargebackGap}. */
  gaps: ChargebackGap[]
}

/**
 * The clause a label needs so a partial chargeback figure names its own scope —
 * `'Anthropic only'` — or `null` when every provider that bills the scope is in
 * the figure and no qualifier is owed.
 *
 * ONE function, shared by both scopes' driver cards and both scopes' model
 * cards, because four hand-written qualifiers is four chances for one to keep
 * saying "company billed spend" after the coverage changed underneath it.
 */
export function chargebackScopeClause(coverage: ChargebackCoverage | undefined): string | null {
  if (!coverage || coverage.gaps.length === 0) return null
  if (coverage.providers.length === 0) return null
  return `${coverage.providers.map(vendorLabel).join(' + ')} only`
}

/**
 * The billed lane's state for one scope + window, published beside any measure
 * computed on it.
 *
 * WHY A READER NEEDS THIS AND CANNOT DERIVE IT. A billed-lane axis answers a
 * NARROWER question than the attributed axes beside it, and its headline is
 * legitimately smaller. Without this block a reader sees a shrunken total with
 * nothing on the page explaining it, which is the same defect class as
 * labelling billed money "not a charge".
 */
export interface BilledLaneMeta {
  /**
   * The lane's state rolled up across arms: `present` if any arm has rows in
   * scope; otherwise `none-in-scope` if some arm has rows in the window
   * somewhere; otherwise `no-data-yet`.
   */
  availability: BilledLaneAvailability
  /**
   * Σ of the arms whose {@link ArmMeasure} is a CHARGE (`'billed'` or
   * `'pooled-chargeback'` — `isChargeMeasure`) — the denominator of the
   * response's top-level `rows`, and the ONLY figure on this contract that may
   * be labelled billed.
   *
   * Both terms are money a provider charged; they differ in GRAIN, not in kind,
   * and `BilledAxisArm.source` says which relation each came from. A consumption
   * arm is never a term here — that is the sum this whole block exists to
   * prevent.
   */
  billedUsd: number
  /**
   * Σ of the arms whose measure is `'consumption'`. Carried BESIDE
   * {@link billedUsd} and never inside it: adding the two would be exactly the
   * cross-meaning sum this whole block exists to prevent. There is deliberately
   * no `totalUsd` field for a consumer to reach for.
   */
  consumptionUsd: number
  /** Every known provider, present even when its adapter has written nothing. */
  arms: BilledAxisArm[]
}

/**
 * De-overloads the single `'indicative'` {@link SpendClass} value with a precise,
 * REPORTING-DISPLAY-ONLY reason (Workstream E requirement 4). Purely additive —
 * `spendClass` itself keeps its exact 3 values (the `pooled-usage` distinction is
 * untouched) — so a row that omits this field carries the pre-existing blanket
 * meaning. This is NOT `server/reconciliation/types.ts`'s frozen platform-agnostic
 * `IndicativeReason` (a different domain: that one classifies a raw reconciliation
 * line before it ever becomes `actual_spend`; this one annotates an already-
 * computed reporting row). The two are deliberately never imported into each other.
 */
export type DriverIndicativeReason =
  /** The default/blanket meaning: an ordinary usage-lane $, not yet the billed
   *  figure (build-design's original 'indicative' semantics). */
  | 'usage-not-yet-billed'
  /** A structural placeholder — real paid money (e.g. a pooled Copilot overage)
   *  with no §A usage weight to attribute it to; informational, never a per-row
   *  charge, and absent for a DIFFERENT reason than ordinary settling timing. */
  | 'no-attributable-usage'

/**
 * One vendor-lane amount — the per-surface breakdown operand shared by
 * {@link DriverRow.surfaceBreakdown} and any other per-lane display (registry
 * lane id + label, never a hand-typed tool literal; see `shared/usage/vendor.ts`
 * `VENDOR_LANES`/`VENDOR_LABELS`).
 */
export interface DriverSurfaceAmount {
  /** Registry lane id (`Vendor` — `shared/usage/vendor.ts`). */
  lane: string
  /** Registry display label (`VENDOR_LABELS[lane]`) — never hand-typed. */
  label: string
  /** Σ cost for this row's key on this lane, over the SAME window as the row. */
  usd: number
}

/**
 * One usage-provenance amount (Axis 1, `shared/usage/provenance.ts`) — the
 * per-provenance breakdown operand for {@link DriverRow.provenanceBreakdown}.
 */
export interface DriverProvenanceAmount {
  provenance: UsageProvenance
  usd: number
}

/**
 * The COST bands a model falls into — `model_catalog.tier` verbatim, plus the
 * explicit `'unclassified'` bucket for a model the catalog does not know.
 *
 * These are the CATALOG's values, not a second banding invented for reporting:
 * the frontier-share detector already consumes the same column, so a card banded
 * here and that detector can never disagree
 * (`docs/design/reporting-consolidation/04-prototype-delta.md` §5 —
 * "Bands come from `model_catalog.tier`").
 *
 * `'unclassified'` is a BAND, not a default: a model the catalog does not know is
 * reported as unclassified rather than folded into the cheapest band, the same
 * discipline migration 0046's detectors apply.
 */
export const MODEL_TIER_BANDS = [
  'frontier',
  'workhorse',
  'lightweight',
  'specialised',
  'unclassified',
] as const
export type ModelTierBand = (typeof MODEL_TIER_BANDS)[number]

/**
 * The reader-facing word for each band. The catalog's vocabulary is capability-
 * shaped (`workhorse`, `lightweight`); a cost-centre owner reads cost, so the
 * three seeded bands render Frontier / Mid / Economy
 * (04-prototype-delta.md §5's table). One map, so a legend and a tooltip can
 * never label the same band differently.
 */
export const MODEL_TIER_LABELS: Readonly<Record<ModelTierBand, string>> = {
  frontier: 'Frontier',
  workhorse: 'Mid',
  lightweight: 'Economy',
  specialised: 'Specialised',
  unclassified: 'Unclassified',
}

/**
 * One model-tier amount — the per-band breakdown operand for
 * {@link DriverRow.tierBreakdown}.
 *
 * ── THIS IS A SEAM, NOT A COMPUTATION ────────────────────────────────────────
 * The BANDING is owned by `fetchTierExposure`
 * (04-prototype-delta.md §5), which resolves a model to its catalog tier through
 * `resolveTier` — a SUBSTRING match ordered by `sort_order`, never a direct
 * equijoin, because `gpt-5-mini` matches both `gpt-5-mini` and `gpt-5` and an
 * equijoin fans out and overstates money. Nothing that renders this shape may
 * re-derive a band: two bandings beside each other produce two frontier-share
 * numbers that drift, which is the failure the single catalog authority exists
 * to prevent.
 */
export interface DriverTierAmount {
  band: ModelTierBand
  /** `MODEL_TIER_LABELS[band]` — never hand-typed at the call site. */
  label: string
  /** Σ cost for this row's key in this band, over the SAME window as the row. */
  usd: number
}

/**
 * One ranked driver row (region / practice / teammate / model / project /
 * surface / …). Every DriversTable's rows sum back to its headline in the SAME
 * lane (the sum-back invariant, build-design §7(4)); `dims` carries the drill
 * keys (e.g. `{ region_id, org_unit_id }`) and a NULL value renders as the
 * explicit "unattributed" bucket (e.g. NULL model) so the sum-back holds.
 */
export interface DriverRow {
  key: string
  label: string
  usd: number
  /**
   * Share of the scope denominator as a FRACTION in [0,1] (e.g. 0.42 → "42%") —
   * the codebase-wide `pct()`/`signedPct` convention. Format with `fmtPct`/
   * `signedPct` from `useFormat`; do NOT pre-multiply by 100.
   */
  sharePct: number
  spendClass: SpendClass
  /** WHY this row is `'indicative'` (requirement 4) — omitted for other spendClasses. */
  indicativeReason?: DriverIndicativeReason
  /**
   * Model-axis only: WHY this row carries no model
   * (`v_complete_usage.model_gap_reason`, mig 0124 — 07-model-axis-subtraction-
   * build.md D3 step 4 / D5). Present only on NULL-model remainder rows:
   * 'provider-day-grain' | 'awaiting-provider-detail' | 'unmodelled-provider-cost'
   * | 'surface-remainder' | 'provider-revision-drift'. Readers MUST treat an
   * unrecognised or absent reason as a plain remainder (never a category) —
   * shared/reports/model-attribution.ts is the single classifier.
   */
  gap_reason?: string | null
  dims?: Record<string, string | null>
  /**
   * Per-surface (vendor-lane) breakdown of THIS row's `usd` (requirement 3 —
   * "teammate drivers discard client/tool"). Σ(surfaceBreakdown[].usd) === usd
   * exactly (sum-back, within float tolerance). Populated for axes where a
   * single row can genuinely blend more than one surface (teammate today);
   * absent where it would be a trivial single-entry restatement (e.g. the
   * `surface` axis's own rows, region/practice/project/model axes).
   */
  surfaceBreakdown?: DriverSurfaceAmount[]
  /**
   * Per-usage-provenance breakdown of THIS row's `usd` (requirement 4 — "a
   * blended row may carry per-provenance breakdown"). Σ(provenanceBreakdown[].usd)
   * === usd exactly (sum-back, within float tolerance).
   */
  provenanceBreakdown?: DriverProvenanceAmount[]
  /**
   * The current-effective budget THIS row's spend is consuming, in USD — present
   * only on the budget (`project`) axis at a scope where a row IS one budget.
   *
   * Three distinct states, and they must not collapse:
   *   `undefined` — this axis has no budget concept (teammate / model / surface),
   *                 so the column is absent entirely.
   *   `null`      — a real budget row with NO allocation set. Renders "no budget
   *                 set", never 0% and never $0: an unset budget is a missing
   *                 decision, not a spent-out one.
   *   a number    — the allocation. Consumption is `usd / budgetUsd`, computed at
   *                 render so the two figures can never be shown out of step.
   *
   * WHY consumption and not share-of-total: a project owner cannot act on "3% of
   * the company", and that number only shrinks as the estate grows. "87% of
   * $6,024" is the question they actually hold.
   */
  budgetUsd?: number | null
  /**
   * Per-model-tier breakdown of THIS row's `usd`, banded by
   * `model_catalog.tier`. Σ(tierBreakdown[].usd) === usd exactly.
   *
   * ── THE SEAM ─────────────────────────────────────────────────────────────
   * POPULATED BY `fetchTierExposure`, which owns the banding
   * (04-prototype-delta.md §5). No renderer and no other producer may compute a
   * band — see {@link DriverTierAmount}. Absent until that primitive is wired in,
   * and a renderer must therefore treat absence as "not available yet", never as
   * "no frontier usage".
   */
  tierBreakdown?: DriverTierAmount[]
  /**
   * THE SECOND OPERAND (F5 D25) — how much of this row's `usd` the READING
   * SCOPE itself carries, when the row's own total is measured on a wider
   * population than the scope.
   *
   * The cost-centre project axis is the case it exists for. Its rows are
   * clamped on the PROJECT's cost-owning unit, so `usd` is the project's OWN
   * total across every centre whose people worked on it — the right operand to
   * put against its budget, and the wrong one for "what did MY centre spend".
   * Both questions are legitimate and they have different answers, so the row
   * carries both rather than the axis picking one (03-snag-plan §8c).
   *
   * ABSENT means the row's total and the scope's share are the same number by
   * construction; a renderer must not synthesise one. `scopeShareUsd <= usd`
   * always — it is a PART of the row, never a second, wider figure.
   */
  scopeShareUsd?: number
  /** What `scopeShareUsd` is the share OF, in the server's words (e.g. "this cost centre"). */
  scopeShareLabel?: string
}

// ── Provider settling state ──────────────────────────────────────────────────
// The settling axes surfaced per report (build-design §5). 'anthropic' + 'github'
// are the BILL lanes; 'usage' is the API-vs-OTel usage lane, which settles on its
// own (longer) reconciliation horizon.
export type ProviderVendor = 'anthropic' | 'github' | 'usage'

// A clock state, NOT a finalisation state (build-design §5, warning 1; owner
// gate-warning fold-in). "finalised" is grep-banned. 'settled' means "past every
// settling horizon" — still provisional, and PERMANENTLY so: `reporting_snapshot`
// records what a month read, it does not finalise it. There is no close machinery
// to wait for (mig 0128), because the bill lands after we report and the product's
// job is to show the movement rather than refuse the correction.
export type SettlingState = 'estimated' | 'settling' | 'settled'

export interface ProviderState {
  vendor: ProviderVendor
  state: SettlingState
  /** ISO instant the vendor's settling horizon ends. Absent while `estimated`. */
  settlesAt?: string
  /** Point-in-time the figures were computed (ISO date), when surfaced. */
  asOfDate?: string
  /**
   * GitHub bill lane stays `false` until a real invoice reconciles (owner-decisions
   * gate fold-in — settling honesty). Absent when not applicable to the vendor.
   */
  invoiceReconciled?: boolean
  /**
   * ALWAYS false — no recompute-and-replace close has run (build-design §7(6)).
   * A literal-false field, not a boolean, so any "settled ⇒ finalised" reading is
   * a type error, not a silent copy bug.
   */
  closeRun: false
}

// ── Coverage (Workstream D, design §6) ──────────────────────────────────────
/**
 * A GitHub enterprise-org coverage marker for a report response, mirroring
 * `ProviderState`'s settlement marker: reads-only, persisted-only
 * (server/reports/coverage-meta.ts / coverage-store.ts), never a live probe.
 * `denominator` is `null` whenever an honest "N of M" cannot be claimed across
 * every enterprise the report spans — the aggregate is suppressed the same way
 * a single enterprise's own denominator is (coverage.ts summariseEnterpriseCoverage).
 */
export interface ReportCoverageMeta {
  /** False when there is no GitHub provider_enterprise registered at all. */
  applicable: boolean
  /** Null whenever the completeness claim cannot be made honestly for the WHOLE
   *  report scope — any one enterprise being unavailable/capped/stale suppresses it. */
  denominator: number | null
  /** Orgs currently classified `connected`, summed across every GitHub enterprise. */
  connected: number
  /** Orgs currently classified anything but `connected`, summed the same way. */
  nonConnected: number
  /** True when at least one relevant enterprise's observation has expired. */
  stale: boolean
}

// ── Forecast ─────────────────────────────────────────────────────────────────
// The run-rate projection for the IN-PROGRESS month (build-design §5). Closed
// months carry `forecast: null` at the response level (never a stale forecast).
export interface CopilotPoolProjection {
  /** Month-final Copilot seat license (lands day 1; NOT extrapolated). */
  seatFinalUsd: number
  /** Copilot credit usage MTD (the run-rate operand for overage). */
  creditsMtdUsd: number
  /** creditsMtdUsd × factor — the projected month-end credit usage. */
  projectedCreditsUsd: number
  /** The included pool allowance (0 ⇒ overage projection disabled). */
  poolUsd: number
  /**
   * max(0, projectedCredits − pool) when pool > 0, else 0. ESTIMATE-CLASS ONLY —
   * a forecast-banner projection, NEVER a charge (build-design §5, violation 1;
   * the chargeable overage is the bill's net line, from `copilot_pool_bill`).
   */
  projectedOverageUsd: number
  spendClass: 'estimated'
}

export interface Forecast {
  /** MAX(event_date) in the month as `YYYY-MM-DD`; null when the month has no data. */
  asOfDate: string | null
  /**
   * utcDayOfMonth(asOf), floored at 1 — the RUN-RATE anchor. Data-anchored on
   * purpose (build-design §5), so it is NOT how far through the month we are.
   * For that, read `dayOfMonth`.
   */
  daysElapsed: number
  /**
   * How far through the month the CLOCK is — `utcDayOfMonth(now)`.
   *
   * Split from `daysElapsed` because one field was serving two questions with
   * different right answers. `daysElapsed` falls back to the month START when a
   * scope has no data yet (harmless for the projection: MTD is 0, so the factor
   * cannot matter), and the hero reused it for its "day N of M" caption — so a
   * Business Unit with no usage rendered "day 1 of 31" on the 10th. The caption
   * is a CLOCK statement and the server owns the clock
   * (`docs/design/clock-and-day-boundary.md`); it must never be inferred from
   * the data.
   */
  dayOfMonth: number
  /** Days in the forecast month (28-31). */
  daysInMonth: number
  /** daysInMonth / daysElapsed. */
  factor: number
  /** Σ metered (run-rate-eligible) spend MTD — excludes Copilot seat + overage sources. */
  meteredMtdUsd: number
  /** meteredMtdUsd × factor. */
  meteredProjectedUsd: number
  /** Present only when the scope has Copilot pool spend. */
  copilot?: CopilotPoolProjection
  /**
   * The "on track for $X" headline = metered projection + Copilot seat-final +
   * Copilot overage projection (build-design §5, "Scope total").
   */
  projectedUsd: number
}

// ── Provider split (per-vendor breakdown over a window) ──────────────────────
/**
 * One vendor's aggregate over a reporting window (`v_complete_usage`, §A usage
 * lane): usage-lane spend + distinct active users.
 */
export interface ProviderSplitEntry {
  spendUsd: number
  /**
   * `COUNT(DISTINCT teammate_id) FILTER (WHERE tool = …)`. A teammate active in TWO
   * vendors is counted in BOTH buckets, so the per-vendor `activeUsers` may exceed
   * the whole-window distinct `activeUsers` KPI — they are not additive.
   */
  activeUsers: number
}

/**
 * The per-provider §A usage split (whole company or region-scoped,
 * `v_complete_usage`). The three-lane §A ceiling (lane-visuals V1): the THREE
 * named §A usage lanes — `claude-code` → `claudeCode`, `copilot-cli` →
 * `copilotCli`, `copilot-agent` → `copilotAgent` — PLUS the standing live
 * `other` catch-all (unknown tools, NULL from reconciliation deltas). The four
 * `spendUsd` values SUM BACK to the genuine headline (every record's `tool`
 * lands in exactly one bucket). `copilot-agent` is now a LIVE `v_complete_usage`
 * lane (migration 0101's ingest-only completeness arm, Workstream A) — the
 * `copilotAgent` bucket carries real spend once the coding agent is used,
 * instead of silently folding into `other` (the old 2+catch-all shape's data
 * loss).
 */
export interface ProviderSplit {
  claudeCode: ProviderSplitEntry
  copilotCli: ProviderSplitEntry
  copilotAgent: ProviderSplitEntry
  other: ProviderSplitEntry
}

// ── §B chargeback provider split (bill lane — the §B analogue of ProviderSplit) ─
/**
 * The two §B CHARGEBACK buckets for the chargeback-lane provider split card:
 * Anthropic per-teammate chargeback (`v_finance_bill_chargeback`, month-rolled) vs
 * the Copilot per-org POOLED net (`v_finance_copilot_pool_chargeback`). NEVER the
 * §A usage `spendUsd` — the two lanes are never summed. `copilotUsd` is `null` when
 * the pooled Copilot chargeback is held back (pending validation, `copilotChargeback`
 * off); the two present values SUM BACK to the chargeable headline.
 */
export interface ChargebackProviderSplit {
  /** Anthropic per-teammate chargeback for the window (bill lane). */
  anthropicUsd: number
  /** Copilot per-org pooled net — `null` while pending validation (pooled, not per-user). */
  copilotUsd: number | null
  /**
   * True when copilot chargeback is ON but the active window is NOT month-aligned, so the
   * pooled (monthly) Copilot net is withheld for this partial-month range (`copilotUsd` is
   * `null` for a DIFFERENT reason than pending). The card renders "not shown for
   * partial-month ranges" rather than "Pending validation" or a silent $0.
   */
  partialMonthUnavailable?: boolean
}

// ── §B chargeback daily series (bill lane — the §B analogue of DailyMetric) ────
/**
 * One UTC day's §B ANTHROPIC chargeback over the active window
 * (`v_finance_bill_chargeback`, the per-teammate DAILY bill lane). Feeds the
 * chargeback-mode spend-trend card + the Chargeable KPI-tile sparkline. Copilot is
 * ABSENT here by construction (its chargeback is pooled per cost-centre, MONTH-grained
 * — see `ChargebackProviderSplit.copilotUsd`), so this is a single Anthropic series.
 */
export interface ChargeDailyPoint {
  /** `YYYY-MM-DD` (UTC day). */
  day: string
  /** Σ Anthropic chargeback `bill_usd` that day. */
  chargeUsd: number
}

// ── §B chargeback lane series (bill lane, per-lane — lane-visuals V2) ─────────
/**
 * One `(day, lane)` point of the §B ANTHROPIC chargeback over the window
 * (`v_finance_bill_chargeback` GROUP BY tool, mapped to registry lane ids via
 * `chargeToVendor`). The per-lane widening of {@link ChargeDailyPoint}: carried
 * ALONGSIDE the total `chargeSeries` (which stays zero-filled and authoritative),
 * and cent-exactly conserving — Σ lanes per day == that day's `chargeUsd`
 * (pinned by the reports integration suite). Copilot lanes are structurally
 * ABSENT (the mig-0085 firewall: pooled, MONTH-grained, never in this view).
 */
export interface ChargeLanePoint {
  /** `YYYY-MM-DD` (UTC day). */
  day: string
  /** Registry lane id (`claude`, `claude-ai`, … — never a raw tool literal). */
  lane: string
  /** Σ chargeback `bill_usd` for that (day, lane). */
  chargeUsd: number
}

// ── §A per-surface weekly usage lanes (the usage-view composition hero) ──────
/**
 * One `(ISO week, lane)` cell of canonical §A USAGE over the active window
 * (`v_complete_usage` GROUP BY `date_trunc('week', ts_event)` × tool, tools
 * mapped to registry lane ids via `toolToVendor`). Feeds the usage-view "Where
 * the AI spend goes" hero + its pinned "Spend by surface" donut.
 *
 * REPLACES the old billed-showback-basis `ShowbackWeeklyLaneCell` (lane-visuals
 * iter-2 I1) — that contract fed a §A-labelled usage-mode hero from
 * `v_finance_bill_showback` (a §B billed-basis view), the exact "Surface Hero
 * uses billed showback" mixed-lens defect this replaces. EVERY surface — every
 * Anthropic lane AND `copilot`/`copilot-agent` — rides this cell natively; there
 * is no GitHub firewall exclusion here (that firewall existed only because the
 * old contract's SOURCE was a billed view GitHub usage rows had to be kept out
 * of). Σ cells over a window == the SAME window's `v_complete_usage` genuine
 * total (the usage headline), cent-exact (test-pinned) — the sum-back invariant
 * this requirement exists to restore. NEVER summed with any §B chargeback figure.
 */
export interface UsageSurfaceWeeklyCell {
  /** `YYYY-MM-DD` — the ISO week's Monday (UTC `date_trunc('week')`). */
  weekStart: string
  /** Registry lane id (`claude`, `claude-ai`, `copilot`, … — never a raw tool literal). */
  lane: string
  /** Σ genuine `cost_usd` for that (week, lane). */
  usd: number
}

/**
 * One lane's §B chargeback total over the active window — the ChargebackSplitCard
 * donut operand (lane-visuals V2). Anthropic lanes come day-grained from
 * `v_finance_bill_chargeback` (Σ == `anthropicChargeableUsd`, cent-exact); the
 * three Copilot §B lanes come pooled-monthly from `v_finance_copilot_pool_chargeback`
 * and are present ONLY when copilot chargeback is validated AND the window is
 * month-aligned (the same gate as the KPI fold — never a partial-month slice).
 * `copilot-unclassified` rides along VISIBLE but is excluded from every
 * chargeable sum (the FinanceCouTable badge convention).
 */
export interface ChargebackLaneRow {
  /** Registry lane id. */
  lane: string
  /** Σ chargeback USD for the lane over the window. */
  chargeUsd: number
}

// ── §B chargeback day-of-week (bill lane — the §B analogue of the seasonality heatmap) ─
/**
 * One day-of-week bucket of §B ANTHROPIC chargeback over the active window
 * (`v_finance_bill_chargeback`, `EXTRACT(ISODOW)`). Seven buckets (Mon..Sun) feed the
 * chargeback-mode "when spend happens" card. Copilot is absent (pooled, monthly).
 */
export interface ChargeDowBucket {
  /** ISO day-of-week, ZERO-BASED: 0 = Monday … 6 = Sunday (matches {@link SeasonalityCell.dow}). */
  dow: number
  /** Σ Anthropic chargeback `bill_usd` on that day-of-week. */
  chargeUsd: number
}

// ── Across trend (day-grain, vendor-stacked) ─────────────────────────────────
/**
 * One point in the Across trend: a `(day, vendor)` cost. `key` is the `tool` id —
 * the three named §A usage lanes + the `other` catch-all (the three-lane §A
 * ceiling, lane-visuals V1). `copilot-agent` is emitted only on a day it carries
 * spend (a real, live `v_complete_usage` lane since migration 0101 — see
 * ProviderSplit — sparse like any other lane, not structurally absent).
 */
export interface AcrossTrendPoint {
  day: string
  key: 'claude-code' | 'copilot-cli' | 'copilot-agent' | 'other'
  value: number
}

/**
 * The Across-Regions day-grain, vendor-stacked usage trend over the active window
 * (a calendar month by default, or a custom `from`/`to` range). Mirrors the shape
 * of the Regional trend one tier up.
 */
export interface AcrossTrend {
  /** Inclusive window bounds (`YYYY-MM-DD`). */
  window: { from: string; to: string }
  series: AcrossTrendPoint[]
  /**
   * §B ANTHROPIC chargeback per day over the SAME window (`v_finance_bill_chargeback`) —
   * the chargeback-lane series the spend-trend card renders in chargeback mode. Carried
   * alongside the §A `series` (like the index's `regionCards` + `chargebackByRegion`);
   * the two lanes are NEVER summed. Copilot is pooled/monthly, so it is absent here.
   */
  chargeSeries: ChargeDailyPoint[]
  /**
   * The per-LANE widening of `chargeSeries` (lane-visuals V2): the same §B window
   * GROUP BY tool, mapped to registry lane ids. Σ lanes per day == that day's
   * `chargeUsd` (cent-exact, test-pinned); `chargeSeries` remains the zero-filled
   * total the run-rate tail and sparklines bind on.
   */
  chargeLanes: ChargeLanePoint[]
  /**
   * The §A per-surface weekly usage cells over the SAME window (requirement 1) —
   * the usage-view composition hero's series (and, summed per lane, its pinned
   * donut). `window` above is the ONE shared window object hero + donut both
   * bind on. Canonical §A basis (`v_complete_usage`); never summed with any §B
   * chargeback figure. Σ cells == this SAME window's genuine usage total.
   */
  usageWeeklyLanes: UsageSurfaceWeeklyCell[]
}

// ── Seasonality (day-of-week × ISO-week heatmap) ─────────────────────────────
/**
 * One cell of the seasonality heatmap — the Σ cost for a single (ISO week, ISO
 * day-of-week) bucket over `v_complete_usage.ts_event`.
 */
export interface SeasonalityCell {
  /** ISO day-of-week, ZERO-BASED: 0 = Monday … 6 = Sunday. */
  dow: number
  /** Index into the enclosing {@link Seasonality.weeks} array (oldest→newest). */
  weekIdx: number
  /** Σ `cost_usd` in that (ISO week × ISO dow) bucket. */
  value: number
}

/**
 * The real day-of-week × ISO-week seasonality grid (the AEUF-exceed "cyclical"
 * visual — actual usage, not a synthesized weekday/weekend curve). Only buckets
 * with a usage row are emitted; the heatmap renders absent (dow, week) pairs as
 * empty. `weeks` is the ordered ISO-week axis; every cell's `weekIdx` indexes it.
 */
export interface Seasonality {
  /** Inclusive window bounds (`YYYY-MM-DD`). */
  window: { from: string; to: string }
  /** ISO week keys (`YYYY-Www`), oldest→newest — the heatmap's week axis. */
  weeks: string[]
  cells: SeasonalityCell[]
  /**
   * §B ANTHROPIC chargeback by day-of-week over the SAME window
   * (`v_finance_bill_chargeback`) — the chargeback-lane "when spend happens" the card
   * renders in chargeback mode. Always seven buckets (Mon..Sun). Carried alongside the
   * §A `cells` (the "response carries both lanes" pattern); the two are NEVER summed.
   */
  chargeDow: ChargeDowBucket[]
}

// ── Active-user trend (distinct active teammates per tool, per day) ──────────
/** One day's distinct-active-teammate counts, split by tool. */
export interface ActiveTrendPoint {
  /** `YYYY-MM-DD` (UTC day). */
  day: string
  /** `COUNT(DISTINCT teammate_id)` with a `claude-code` record that day. */
  claudeCode: number
  /** `COUNT(DISTINCT teammate_id)` with a `copilot-cli` record that day. */
  copilot: number
}

/**
 * The active-users-over-time trend (the AEUF-exceed "how many devs on each tool"
 * as a series, not a point KPI). One point per day with any usage; the per-tool
 * counts are NOT additive (a teammate active in both tools is counted in both).
 */
export interface ActiveTrend {
  /** Inclusive window bounds (`YYYY-MM-DD`). */
  window: { from: string; to: string }
  series: ActiveTrendPoint[]
}

// ── Cost-centre summary (KPI strip + RAG rollup) ─────────────────────────────
/**
 * The whole-scope Cost-Centre rollup, computed from the visible cards — the KPI
 * strip (totals) + a RAG count breakdown (over / near / on-track / no-allocation).
 * The four counts partition the visible cards exactly (Σ counts = card count).
 */
export interface CostCentreSummary {
  /** Σ burn across the visible cards (project-CoU usage axis). */
  totalBurnUsd: number
  /** Σ current-effective allocation across the visible cards. */
  totalAllocationUsd: number
  /** Cards at/over budget (utilisation ≥ 1). */
  countOverBudget: number
  /** Cards near budget (CC_NEAR_BUDGET_THRESHOLD ≤ utilisation < 1). */
  countNearBudget: number
  /** Cards on track (0 < utilisation < CC_NEAR_BUDGET_THRESHOLD). */
  countOnTrack: number
  /**
   * Cards with an allocation and NOTHING spent against it yet (F5 D26).
   *
   * Split out of `countOnTrack`, where it used to hide: "$0.00 of $500.00 ·
   * On track" is the reading a cost-centre owner has no way to challenge. The
   * word is `not-started` everywhere (`useRagState.ts`, both prototypes) — see
   * {@link costCentreBudgetState}.
   */
  countNotStarted: number
  /** Cards with no allocation (utilisation null). */
  countNoAllocation: number
  /** MAX(ts_event) across the visible cards (`YYYY-MM-DD`), or null. */
  asOfDate: string | null
}

// ── The Cost-centre scope block (F5 D23) ─────────────────────────────────────
/**
 * ONE cost centre the reader may look at — a SELECTOR OPTION, not a card.
 * Carries no money: which centre a reader is on and what that centre spent are
 * different questions, answered by different clamps over different windows.
 */
export interface CostCentreScopeOption {
  id: string
  displayName: string
  regionCode: string
  /** True when the reader holds an active `cou_owner` grant on this centre. */
  owned: boolean
}

/**
 * WHERE THE READER IS, resolved by the SAME resolver that built the report's
 * clamp (F5 D23, prototype note `scope` at `R:551-559`).
 *
 * *"The Cost-centre tab lands ON a cost centre. There is no unscoped state, and
 * never was. … The selector is grant-scoped: it offers only the centres you
 * hold, and a reader with exactly one gets no selector at all, just the name —
 * one option is not a selector, it is a label."*
 *
 * ── WHY THIS IS SERVER-DERIVED AND NOT ASSEMBLED IN THE VIEW ─────────────────
 * `scopeLabel` names the population every figure beside it was computed over.
 * A view that composed its own label from a route param would name a scope the
 * server may not have served — the failure `ScopeHero.vue:102-108` records for
 * the region hero. It comes from `fetchVisibleCostCentres`, which is also what
 * clamps the cards, so the two cannot disagree.
 *
 * ── AND WHY THE CLIENT MUST NOT INFER ANYTHING FROM AN ABSENT CENTRE ─────────
 * `fetchVisibleCostCentres` filters by VISIBILITY before returning
 * (`cost-centres.ts:143-161`), so "not in `options`" means "not visible to
 * you" and never "does not exist". Any client-side reasoning about centres
 * that are absent here is unsound.
 */
export interface CostCentreScope {
  /** Every centre this reader may look at, in the resolver's own order. */
  options: CostCentreScopeOption[]
  /**
   * Where a reader arriving with no `?cc=` LANDS: their own centre when they own
   * one (ownership is the grant this page is written for), else the first
   * visible. `null` only when they can see none — the genuinely empty scope.
   */
  defaultCcId: string | null
  /** The default centre's name — what the page says it is showing. */
  scopeLabel: string | null
}

/** The near-budget (amber) RAG threshold — a card ≥ this fraction of its allocation is "warn". */
export const CC_NEAR_BUDGET_THRESHOLD = 0.8

/**
 * Classify a cost-centre's utilisation (burn ÷ allocation) into a RAG state the
 * card grid + summary rollup both key on (one definition, no drift): `none` (no
 * allocation) · `not-started` (an allocation, nothing spent against it yet) ·
 * `ok` (< threshold) · `warn` (near) · `over` (≥ 100%).
 *
 * ── WHY `not-started` IS ITS OWN STATE (F5 D26) ──────────────────────────────
 * A budgeted cost centre that spent nothing used to classify `ok` and render
 * "On track" — "$0.00 of $500.00 · 0% · On track" reads as a data failure to
 * the one person who could act on it, when the truth is "nothing has burned
 * against this allocation yet". It is a fifth outcome, not a shade of the
 * fourth.
 *
 * It does NOT mean "nobody homed here has emitted". Utilisation is burn ÷
 * allocation, i.e. a DOLLAR fact: activity that is non-chargeable (NFR, in-pool
 * Copilot, `copilot-unclassified`) or simply unpriced contributes real usage at
 * $0, so a centre can be busy all month and still read `not-started`. Read this
 * state as "no spend against the budget", never as "no usage".
 *
 * THE NAME IS `not-started`, NOT `idle`. `app/composables/useRagState.ts:121`
 * already returns `'not-started'` for exactly this fact and both prototypes
 * label it "Not started". Minting a second name for one fact is the defect
 * prototype note `fix 4a` is written about.
 */
export type CostCentreBudgetState = 'over' | 'warn' | 'ok' | 'not-started' | 'none'

export function costCentreBudgetState(utilisation: number | null): CostCentreBudgetState {
  if (utilisation == null) return 'none'
  if (utilisation >= 1) return 'over'
  if (utilisation >= CC_NEAR_BUDGET_THRESHOLD) return 'warn'
  // A REAL zero, tested before the `ok` fall-through: `> 0` rather than
  // `=== 0` so a float-noise sliver still reads as started.
  if (!(utilisation > 0)) return 'not-started'
  return 'ok'
}

// ── Daily metrics (§A usage sparkline series) ────────────────────────────────
/**
 * One UTC day's §A usage aggregate over the active window (`v_complete_usage`) —
 * the per-tile KPI sparkline series (Attributed usage / Tokens / Active users /
 * Avg usage). PURE usage lane: never a chargeback figure. `activeUsers` is
 * `COUNT(DISTINCT teammate_id)` for that day (not additive across days).
 */
export interface DailyMetric {
  /** `YYYY-MM-DD` (UTC day). */
  day: string
  /** Σ `cost_usd` that day (the §A attributed-usage sparkline operand). */
  genuineUsd: number
  /** Σ `tokens` that day. */
  tokens: number
  /** `COUNT(DISTINCT teammate_id)` active that day. */
  activeUsers: number
}

// ── Budget coverage (the denominator published beside a §A total) ────────────
/**
 * How much of a scope's §A usage total sits inside the BUDGET lens, and how much
 * sits outside it — the coverage qualifier a reporting surface renders beside the
 * total it qualifies.
 *
 * WHY THIS EXISTS. Under 5% of enterprise consumption is on a budgeted project
 * today, so every budget-shaped figure in the product is a small fraction of real
 * consumption and nothing on screen said so. A reader who sees a total reasonably
 * assumes it is the whole. The all-consumption view is the honest artefact at this
 * adoption level and the budget view is the destination; neither may imply the
 * other's coverage (design/reporting-stakeholder-visibility/00-decisions.md §5b
 * "Four", principle P6).
 *
 * PURE §A. Every term comes from ONE scan of `v_complete_usage` over the SAME
 * scope + window as the total it qualifies, so `totalUsd` IS that surface's own
 * headline and the four parts foot to it exactly. No §B bill-lane figure is an
 * operand of any term here — consistency contract C2, one lane per axis.
 *
 * The four parts PARTITION `totalUsd` (disjoint and exhaustive):
 *   project_id NOT NULL → {@link budgetedUsd} | {@link taggedNoBudgetUsd}
 *   project_id IS NULL  → {@link untaggableUsd} (arm 3) | {@link untaggedUsd}
 */
export interface UsageBudgetCoverage {
  /**
   * WHOSE money the five figures below are — the scope the clamp ACTUALLY resolved
   * to, named as a reader names it ("APAC", "Platform Engineering", "the whole
   * company"). Consistency contract C11: a node names its own scope, never a wider
   * one.
   *
   * IT TRAVELS WITH THE FIGURES, and that is the point. It was previously chosen in
   * the component from `drill ?? region`, which is right for an admin (region-clamped)
   * and WRONG for a manager or developer: both hold `regional: 'own-region'`
   * (shared/auth/report-visibility.ts) but their §A clamp is the `app.user_org_path`
   * SUBTREE (server/auth/org-subtree-scope.ts), so the note named the region above a
   * subtree's numbers — an over-wide denominator on the one surface whose purpose is
   * honesty about coverage. Only the resolver that built the predicate can name it, so
   * the name is now produced there and carried here, beside the numbers it belongs to.
   *
   * `null` ONLY when the caller's subtree clamp resolves to NO org unit — their own
   * placement is the region root / a holding node, so `placedBelowRegionRootPredicate`
   * deliberately degrades the clamp to zero rows. The five figures are then
   * structurally zero rather than measured-and-empty, and the copy must say THAT
   * rather than name a scope these figures were never computed over.
   */
  scopeLabel: string | null
  /**
   * THE DENOMINATOR: Σ `cost_usd` on the §A lane over this scope and window —
   * all three arms, every tag state. Identical to the scope's own attributed-usage
   * headline, which is what makes this a qualifier rather than a second figure.
   *
   * It is the scope's OWN total and nothing wider (contract C11): consumption by
   * someone outside this scope is not in it, and a provider identity that has never
   * matched a teammate reaches no §A row at all, so it is in neither this figure
   * nor the headline. The copy names the scope for exactly that reason.
   */
  totalUsd: number
  /**
   * INSIDE the budget lens: tagged to a project carrying a baseline or top-up
   * allocation of MORE THAN $0 whose effective range OVERLAPS this window. Overlap
   * (not point-containment) so a budget that starts or is topped up mid-window
   * counts — the same rule `budget-alert` applies to top-ups. A $0 allocation is
   * deliberately not a budget (server/reporting/engine/usage-coverage.ts): the copy
   * beside this figure reads "on a project that had a budget for it", and counting
   * $0 would overstate the very share the note exists to keep honest.
   */
  budgetedUsd: number
  /**
   * Tagged to a project, but that project has no allocation of more than $0 over
   * this window — including one whose only allocation is $0.
   */
  taggedNoBudgetUsd: number
  /**
   * No project claim, on an arm that COULD carry one (arms 1-2: `otel-emitted`
   * and `api-reconciled`). *Untagged* in the one-vocabulary sense (contract C6) —
   * a bookkeeping gap somebody can still close.
   */
  untaggedUsd: number
  /**
   * Arm 3 (`provider-usage`): `project_id` is NULL BY CONSTRUCTION (mig 0101), so
   * this money can never be an operand of any project budget. A structural absence,
   * NEVER labelled untagged — that would libel it as a gap somebody failed to close.
   */
  untaggableUsd: number
}

// ── Over the soft cap (the cost-centre lead's conversation list) ─────────────
/**
 * WHICH conversation the reader is being handed, and it is the ONLY thing that
 * splits the list. Both groups are over the cap; they differ in what the reader
 * can do next, which is the only distinction a cost-centre owner can act on.
 *
 *   `on-projects`    — at least one ACTIVE project membership, so a budget already
 *                      exists to put this spend on. Reads as *nudge them*.
 *   `on-no-project`  — no active membership, so there is nothing to tag to and a
 *                      nudge would be an instruction they cannot follow. Reads as
 *                      *allocate to projects* — a PM action, not theirs.
 *
 * "Active" is `project_assignment.effective @> now()` AND the project has not
 * ENDED (`endedProjectExpr`, server/db/project-predicates.ts) — the SAME two gates
 * the tag write path applies (server/utils/tag-unaccounted.ts), so a row in
 * `on-projects` is a row whose owner would actually be permitted to tag.
 */
export type OverSoftCapGroup = 'on-projects' | 'on-no-project'

/** One teammate over the soft cap. */
export interface OverSoftCapRow {
  teammateId: string
  /** Display name, falling back to email — never a bare uuid. */
  teammate: string
  /**
   * THE DRILL CONTRACT's two client-unknowable conjuncts (D34), carried on the
   * row by `server/reporting/teammate-drill-facts.ts`.
   *
   * REQUIRED, not optional (r5-H1). The card used to hard-code `isActive: true`
   * from the roster's `is_active = TRUE` filter and to say nothing at all about
   * `provisional` — so a provisional SHADOW identity (which is active) rendered
   * as a live link onto a page that 403s, under an email nobody has
   * authenticated. Optional fields reproduce exactly that: absent reads as
   * `undefined`, and `undefined !== 'true'` fails OPEN for `isProvisional`.
   */
  isActive: boolean
  isProvisional: boolean
  /**
   * Σ `cost_usd` with NO project claim, over this window — the teammate's OWN §A
   * total, wherever it was homed, NOT this cost centre's burn. Those are different
   * denominators (see {@link OverSoftCap.rosterUsd}).
   */
  unallocatedUsd: number
  /**
   * `unallocatedUsd ÷ softCapUsd` — what makes the row actionable ("8× the cap"
   * is a sentence; "$812" alone is not).
   *
   * `null` when the cap is configured to $0: there is no multiple of zero, and
   * reporting `Infinity` or a fabricated `0` would both be false.
   */
  capMultiple: number | null
  /**
   * Allocated ÷ total for this teammate over the window — CONTEXT, never a gate.
   * Answers "is this person trying and short, or not tagging at all?" once the
   * reader is already in the conversation. Filtering by it would drop exactly the
   * heavy user who most needs the nudge: 88% of a large total still leaves 8× the
   * cap unallocated.
   *
   * Always defined on a row in `over`: `unallocatedUsd >= softCapUsd` and
   * `unallocatedUsd > 0`, so the denominator is non-zero by construction.
   */
  taggedRate: number
  /** Count of DISTINCT active project memberships (see {@link OverSoftCapGroup}). */
  projects: number
  group: OverSoftCapGroup
}

/**
 * Unallocated spend over the soft cap, for one scope and window — the cost-centre
 * lead's card (docs/design/reporting-consolidation/04-prototype-delta.md §5).
 *
 * THE CLAIM: unallocated spend over the soft cap should be on a budget. The cap is
 * not a threshold invented for this card — it is `NUXT_BASE_ALLOWANCE_USD`
 * (server/utils/base-allowance.ts), the same global constant the developer's own
 * page already badges `over_soft_cap` against, applied to the manager's view.
 *
 * ROSTER-ANCHORED, NOT BURN-ANCHORED, and that distinction is the card. The §A
 * lane's `cost_owning_unit_id` is *project-homed burn* — it is the cost centre of
 * the TAGGED PROJECT — and the reconciled arm carries NULL there by construction
 * (mig 0101/0113). Scanning it would omit precisely the people this card exists to
 * surface: the ones with nothing tagged. So the population is teammate PLACEMENT,
 * and usage is left-joined onto it.
 *
 * NO ACTION BUTTONS anywhere this renders. `tagUnaccountedTx` permits only a
 * record's OWN teammate to tag it, so a cost-centre owner cannot action another
 * person's row. The card's job is that the owner knows who to contact and about
 * what; the copy carries no verb the reader cannot perform.
 */
export interface OverSoftCap {
  /** The global base allowance in force when this was computed. */
  softCapUsd: number
  /**
   * The DENOMINATOR, named separately from project burn because it is a different
   * one: ACTIVE teammates PLACED in this scope. Independent of whether any of them
   * burned anything — that is the point of anchoring on the roster.
   */
  rosterCount: number
  /**
   * Σ `cost_usd` over the roster for this window — every arm, every tag state.
   * NOT the cost centre's burn: a placed teammate's Copilot reconciliation rows
   * carry NULL `cost_owning_unit_id` and so are in this figure and not in the burn,
   * while a project this centre owns that was tagged by someone placed elsewhere is
   * in the burn and not in this.
   */
  rosterUsd: number
  /** Σ over the roster with a project claim. `allocatedUsd + unallocatedUsd = rosterUsd`. */
  allocatedUsd: number
  /** Σ over the roster with NO project claim. */
  unallocatedUsd: number
  /** Over the cap, sorted by `unallocatedUsd` descending. Empty ⇒ all within allowance. */
  over: OverSoftCapRow[]
  /**
   * Everyone else on the roster, collapsed to one line — the card names them but
   * does not list them, because there is no conversation to have.
   *
   * EXHAUSTIVE WITH `over`: `withinAllowance.teammates + over.length = rosterCount`.
   * A cost centre with nothing over the cap renders "all within allowance", never a
   * `$0` that reads as missing data.
   */
  withinAllowance: {
    teammates: number
    /** Σ unallocated across them — real money, just none of it over the cap. */
    unallocatedUsd: number
    /**
     * How many of them SPENT and have nothing unallocated — every dollar on a
     * budget. Someone with no spend at all is not counted: they allocated nothing,
     * and counting them would let an idle cost centre report its roster as a
     * tagging success.
     */
    fullyAllocated: number
  }
}

// ── Report meta (bootstraps every reporting response) ────────────────────────
export interface ReportMeta {
  /** The requested month (`YYYY-MM`); in custom-range mode, the window's start-month. */
  month: string
  /** Earliest month with data for this scope (`YYYY-MM`) — the picker floor. */
  monthFloor: string
  /** MAX(event_date) surfaced (`YYYY-MM-DD`); null when the month has no data. */
  asOfDate: string | null
  /**
   * The request clock's last SETTLED UTC day (`clock.settledThrough`, i.e.
   * `today − 1`) — the same operand the response's day series were cut on.
   *
   * It exists so a consumer can tell whether a series' LAST day is a finished
   * day or the still-filling one WITHOUT asking `/api/v1/clock`, which is a
   * second request with its own instant (`docs/design/clock-and-day-boundary.md`
   * — the server owns the clock, and it must ship the operand it used). The
   * frame cannot answer that question: `fetchDailyMetrics` stops at
   * `settledThrough` unless today carries rows, so "the month has days left"
   * says nothing about the last point drawn.
   *
   * Optional only because not every route that builds a `ReportMeta` serves a
   * day series; a consumer that has no value must make NO claim rather than
   * assume one.
   */
  settledThrough?: string
  /** Per-vendor settling states for the month. */
  providerStates: ProviderState[]
  /** GitHub enterprise-org coverage marker (Workstream D, design §6). Absent only for
   *  report shapes that predate this field in a cached client bundle; every current
   *  route populates it. */
  coverage?: ReportCoverageMeta
  scope: ReportScope
  /**
   * true when the response's org dims are point-in-time "as at emit" (usage lane,
   * historical months); false when re-homed to current org structure (build-design
   * §5 disclosure copy).
   */
  pointInTimeDims: boolean
  /**
   * Present ONLY when the active window is a custom `from`/`to` date range (both
   * `YYYY-MM-DD`, inclusive `to`). Absent in the default month mode. When present,
   * `month`/`monthFloor` are the window's start-month representative and the
   * month-anchored figures (forecast, momDeltaPct) are null.
   */
  range?: { from: string; to: string }
}

// ── Vendor vocabulary ────────────────────────────────────────────────────────
/**
 * Human vendor label for the reporting area (reporting-domain vocabulary, not a
 * generic formatter — kept here alongside the canonical types rather than in
 * `useFormat`). Pure: no runtime deps, safe on both sides of the wire.
 */
export function vendorLabel(vendor: string | null | undefined): string {
  const v = (vendor ?? '').toLowerCase()
  if (v.includes('anthropic') || v === 'claude') return 'Anthropic'
  if (v.includes('github') || v.includes('copilot')) return 'GitHub Copilot'
  return vendor ? vendor.charAt(0).toUpperCase() + vendor.slice(1) : 'Provider'
}
