/*
 * The project page's chargeback-lens payload (docs/design/project-chargeback-lens.md).
 *
 * `GET me/projects/[code]` and `GET reports/project/[code]` return this shape
 * when `?lane=chargeback`; with `?lane=usage` (the default) they return their
 * attributed payload plus `lane: 'usage'`. Every money field is bill dollars
 * from `v_finance_project_overlay`, as a 2-dp string.
 */
import type { SpendLens } from '../usage/lens'
import type { ProviderState } from './types'
import type { ReportScopeGrants } from '../auth/report-visibility'

export interface ProjectChargebackDay {
  /** UTC day, `YYYY-MM-DD`. Days with no charge are absent. */
  date: string
  cost_usd: string
}

/** Member depth: named rows only for a member viewer; a cou-owner gets `[]`. */
export interface ProjectChargebackMemberContributors {
  members: {
    teammate_id: string
    display_name: string | null
    email: string
    cost_usd: string
  }[]
  /** Teammates with a non-zero charge in the window, named or not. */
  member_count: number
}

/** Reports depth: in-scope contributors named, the rest folded into ONE remainder. */
export interface ProjectChargebackScopedContributors {
  named: {
    teammate_id: string
    display_name: string
    cost_usd: string
    is_active: boolean
    can_drill: boolean
  }[]
  remainder: { members: number; label: string; cost_usd: string }
  /** Σ(named) + remainder; equals `total_usd`. */
  rows_total_usd: string
}

export interface ProjectChargeback<C> {
  total_usd: string
  series: ProjectChargebackDay[]
  contributors: C
  /** Anthropic settling state for the window: the current month's bill is provisional. */
  settling: ProviderState
}

export interface ProjectChargebackWindow {
  from: string
  to: string
  is_month: boolean
  month: string | null
  days_elapsed: number
  days_in_window: number
}

/** `GET /api/v1/me/projects/[code]?lane=chargeback`. */
export interface MeProjectChargebackResponse {
  viewer: { role: string; access: 'member' | 'cou-owner'; budget_allocation_id: string | null }
  project: {
    id: string
    code: string
    display_name: string | null
    type: string
    wbs_code: string | null
    end_date: string | null
    ended: boolean
  }
  window: ProjectChargebackWindow
  lane: Extract<SpendLens, 'chargeback'>
  chargeback: ProjectChargeback<ProjectChargebackMemberContributors>
}

/** `GET /api/v1/reports/project/[code]?lane=chargeback`. */
export interface ReportsProjectChargebackResponse {
  project: { id: string; code: string; display_name: string | null }
  admitted_by: ReportScopeGrants['project']
  scope: { src: string | null }
  window: ProjectChargebackWindow
  lane: Extract<SpendLens, 'chargeback'>
  chargeback: ProjectChargeback<ProjectChargebackScopedContributors>
}
