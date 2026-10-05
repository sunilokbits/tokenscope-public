/*
 * The spend LENS — one vocabulary for "which quantity is this dollar?".
 *
 * ADR 0012 (docs/decisions/0012-one-usage-quantity-selectable-lens-labelled-
 * everywhere.md): the product measures several quantities that are all
 * colloquially "spend", and every figure must say which lens it is answered
 * through. The lens is the SAME two-valued choice everywhere it appears — the
 * reporting area's `ReportLane` is this type (app/composables/useReportState.ts
 * re-exports it), so a third spelling of `'usage' | 'chargeback'` cannot appear.
 *
 * The two lenses are DIFFERENT AXES, never summed and never substituted for one
 * another (docs/design/provider-billing-attribution-model.md §A vs §B):
 *
 *   usage      §A — what was consumed.
 *   chargeback §B — what cross-charges to a cost-owning unit.
 *
 * The COPY below is per-surface, because the same lens is answered from
 * different sources on different surfaces: the personal surfaces answer `usage`
 * from attributed telemetry (the developer's own emissions at our rate card),
 * while the reporting area answers it from provider usage truth. Each surface
 * therefore owns its own caption set; only the lens vocabulary is shared.
 */

export const SPEND_LENSES = ['usage', 'chargeback'] as const

/** The primary lens a figure is answered through. */
export type SpendLens = (typeof SPEND_LENSES)[number]

/**
 * Coerce an untrusted value (a URL query param, a request query) to a lens.
 * Anything unrecognised falls back rather than throwing: a hand-typed `?lane=`
 * must never 500 a dashboard, and `usage` is the ADR's default (decision 1).
 */
export function parseSpendLens(raw: unknown, fallback: SpendLens = 'usage'): SpendLens {
  const v = Array.isArray(raw) ? raw[0] : raw
  return typeof v === 'string' && (SPEND_LENSES as readonly string[]).includes(v)
    ? (v as SpendLens)
    : fallback
}

export interface SpendLensCopy {
  /** The control's own label. */
  label: string
  /** The one-word qualifier beside the label on the control. */
  qualifier: string
  /**
   * The clause rendered DIRECTLY UNDER the figure (ADR 0012 decision 3 — the
   * lens is named in the copy the user reads, not in a tooltip).
   */
  basis: string
  /** The one-line explanation under the lens control. */
  caption: string
}

/**
 * Personal-surface lens copy (`/` and `/consumption`).
 *
 * `usage` is attributed telemetry — the developer's own emissions valued at our
 * rate card, plus the reconciled provider gap they tagged (the §A seam,
 * `v_complete_usage`). It is deliberately NOT hedged as notional (ADR 0012
 * decision 6): the tokens were consumed, and the product exists to change
 * behaviour before the invoice catches up.
 *
 * `chargeback` is the cost of record — `v_finance_bill_chargeback`, which is
 * Anthropic-only BY CONSTRUCTION: GitHub Copilot is billed pooled per cost
 * centre and has no per-person charge to show (migration 0085's GitHub
 * firewall). The caption says so rather than letting a per-person Copilot
 * charge look like zero.
 */
export const PERSONAL_LENS_COPY: Readonly<Record<SpendLens, SpendLensCopy>> = {
  usage: {
    label: 'Usage',
    qualifier: 'attributed',
    /*
     * "across all your AI surfaces", NOT "your own sessions". §A arm 3 (mig
     * 0101) is provider-reported usage with no session behind it at all —
     * Claude Chat, the Copilot coding agent — and it IS inside this figure.
     * Naming sessions excluded, in the label, the very spend the ADR added.
     *
     * "all your AI surfaces" was the first correction and it overclaimed the
     * other way: `v_complete_usage` covers what TokenScope can SEE — connected
     * tools plus provider-reported lanes. An unconnected ChatGPT or Gemini is
     * absent, so "all" was a universal the data cannot support.
     */
    basis: 'attributed usage · connected and provider-reported surfaces, at our rate card · month to date',
    /*
     * NO INVOICE QUALIFICATION HERE. ADR 0012 decision 6: the primary figure is
     * presented as real spend, present tense, unhedged — "what is actually
     * invoiced" is a real question with a real answer and it lives behind the
     * lens selector, not in a disclaimer stapled to the number. The previous
     * caption ("some of it has no Insight invoice behind it yet") told a
     * developer to discount the figure, which defeats the mechanism the product
     * is built on: the teaching has to land while it is still free to learn.
     */
    caption: 'Every token you spent this month, across all your AI surfaces, valued at our rate card.',
  },
  chargeback: {
    label: 'Chargeback',
    qualifier: 'billed',
    basis: 'chargeback · what cross-charges to your Business Unit · month to date',
    caption:
      'What your usage cross-charges to your Business Unit. Anthropic bills per person, so this is your Anthropic chargeable spend. Copilot is billed pooled per Business Unit and has no per-person charge.',
  },
} as const

/**
 * Project-page lens copy (`/projects/[code]`), both depths.
 *
 * `chargeback` is the Anthropic bill split across projects by tagged share
 * (`docs/design/project-chargeback-lens.md`); untagged bill cost is on no
 * project, and Copilot (billed per Business Unit) is on none.
 */
export const PROJECT_LENS_COPY: Readonly<Record<SpendLens, SpendLensCopy>> = {
  usage: {
    label: PERSONAL_LENS_COPY.usage.label,
    qualifier: PERSONAL_LENS_COPY.usage.qualifier,
    basis: 'attributed usage · this project',
    caption: "What this project used: its members' attributed usage, valued at our rate card.",
  },
  chargeback: {
    label: PERSONAL_LENS_COPY.chargeback.label,
    qualifier: PERSONAL_LENS_COPY.chargeback.qualifier,
    basis: 'bill chargeback · this project',
    caption: 'Bill dollars split by what was tagged; untagged spend is on no project.',
  },
} as const
