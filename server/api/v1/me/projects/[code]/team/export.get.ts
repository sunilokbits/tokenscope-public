/*
 * GET /api/v1/me/projects/{code}/team/export — CSV of the project page's
 * Team-contribution table (developer-pages W3 D27.5, fix 10: "Export CSV on
 * the tables people take to meetings").
 *
 * ── SAME GATE, SAME ROWS, SAME WINDOW AS THE PAGE ────────────────────────────
 * Membership-gated exactly like the page (requireProjectMembership; a
 * non-member is indistinguishable from a missing project — 404). One tighter
 * conjunct: the export carries NAMED per-member rows, which a `cou-owner`
 * viewer never sees on screen (R2 F1) — so a cou-owner gets the SAME 404
 * shape rather than an empty file that confirms the project exists with rows
 * it withheld.
 *
 * Rows come from the SAME seam read as the table
 * (`completeProjectSpendByMember`, same window vocabulary, same provisional
 * option), so the file can never disagree with the screen it was exported
 * from. `csvEscape()` mitigates formula injection (security-audit sweep).
 *
 * `?lane=chargeback` exports the page's chargeback contributors instead, in
 * bill dollars (`v_finance_project_overlay`), under the same gate. The lane
 * is echoed in the `x-spend-lane` header.
 */
import { createError, defineEventHandler, getRouterParam, getValidatedQuery, setHeader } from 'h3'
import { z } from 'zod'
import { requireAuth } from '../../../../../../auth/rbac'
import { withRequestRls } from '../../../../../../db/request-rls'
import { requireProjectMembership } from '../../../../../../usage/consumption'
import {
  completeProjectSpendByMember,
  type SpendWindow,
} from '../../../../../../usage/complete-spend'
import { resolveReportWindow } from '../../../../../../reporting/params'
import { csvEscape } from '../../../../../../utils/csv-escape'
import { MONTH_REGEX } from '../../../../../../utils/period'
import { requestClock } from '../../../../../../utils/request-clock'
import { parseSpendLens } from '../../../../../../../shared/usage/lens'
import { fetchProjectChargebackContributors } from '../../../../../../reporting/project-chargeback'

const ExportWindowQuery = z.object({
  month: z.string().regex(MONTH_REGEX).optional(),
  from: z
    .string()
    .regex(/^\d{4}-\d{2}-\d{2}$/)
    .optional(),
  to: z
    .string()
    .regex(/^\d{4}-\d{2}-\d{2}$/)
    .optional(),
  lane: z.unknown().optional(),
})

const NOT_FOUND = {
  statusCode: 404,
  statusMessage: 'Project not found',
  data: {
    type: 'https://tokenscope.example.com/errors/not-found',
    title: 'Project not found',
    status: 404,
    detail: 'No project with this code among your current memberships.',
  },
} as const

export default defineEventHandler(async (event) => {
  const session = await requireAuth(event)
  const codeParsed = z
    .string()
    .min(1)
    .max(120)
    .safeParse(getRouterParam(event, 'code'))
  if (!codeParsed.success) {
    throw createError({ statusCode: 400, statusMessage: 'Invalid project code' })
  }
  const query = await getValidatedQuery(event, (d) => ExportWindowQuery.parse(d))
  const lane = parseSpendLens(query.lane)
  const win = resolveReportWindow(query, { now: new Date(requestClock(event).now) })
  const window: SpendWindow = { startIso: win.startIso, endIso: win.endIso }

  return await withRequestRls(event, async (tx) => {
    const project = await requireProjectMembership(tx, session.teammateId, codeParsed.data)
    // The page shows a cou-owner aggregates WITHOUT named rows (R2 F1); a CSV
    // of named rows has no aggregate rendering to fall back to, so the
    // observer path gets the member-indistinguishable 404, not an empty file.
    if (!project || project.access !== 'member') {
      throw createError(NOT_FOUND)
    }

    const windowStamp = win.monthStr ?? `${win.from}_${win.to}`
    setHeader(event, 'content-type', 'text/csv; charset=utf-8')
    setHeader(event, 'x-spend-lane', lane)

    // Chargeback lens: the same named rows the page shows, in bill dollars.
    if (lane === 'chargeback') {
      const rows = await fetchProjectChargebackContributors(tx, project.id, window)
      const cbTotal = rows.reduce((a, r) => a + Number(r.usd), 0)
      setHeader(
        event,
        'content-disposition',
        `attachment; filename="tokenscope-project-${project.code}-team-chargeback-${windowStamp}.csv"`,
      )
      return (
        [
          'member,email,charge_usd,share_pct',
          ...rows.map((r) =>
            [
              csvEscape(r.label),
              csvEscape(r.email),
              Number(r.usd).toFixed(2),
              cbTotal > 0 ? ((Number(r.usd) / cbTotal) * 100).toFixed(1) : '0.0',
            ].join(','),
          ),
        ].join('\n') + '\n'
      )
    }

    const members = await completeProjectSpendByMember(tx, project.id, window, {
      excludeProvisional: true,
    })
    const total = members.reduce((a, m) => a + m.costUsd, 0)

    const csvLines = [
      'member,email,cost_usd,tokens,active_days,cost_per_active_day,share_pct,last_activity',
      ...members.map((m) =>
        [
          csvEscape(m.displayName ?? m.email),
          csvEscape(m.email),
          m.costUsd.toFixed(2),
          String(m.tokens),
          String(m.activeDays),
          m.activeDays > 0 ? (m.costUsd / m.activeDays).toFixed(2) : '0.00',
          total > 0 ? ((m.costUsd / total) * 100).toFixed(1) : '0.0',
          csvEscape(m.lastEvent ?? ''),
        ].join(','),
      ),
    ]

    setHeader(
      event,
      'content-disposition',
      `attachment; filename="tokenscope-project-${project.code}-team-${windowStamp}.csv"`,
    )
    return csvLines.join('\n') + '\n'
  })
})
