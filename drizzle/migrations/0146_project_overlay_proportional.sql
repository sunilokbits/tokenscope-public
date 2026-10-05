-- 0146 — v_finance_project_overlay splits the bill PROPORTIONALLY by tagged share.
--
-- Rule (docs/design/project-chargeback-lens.md "The figure"; owner rulings D0/D0b
-- in docs/security-sprint/night-sprint-2026-10-02.md): per (teammate, UTC day,
-- tool) the chargeable bill B from v_finance_bill_chargeback is split
--   charge(P)   = B * weight(P) / SUM(weights)
--   untagged    = B * untagged weight / SUM(weights), or all of B when SUM = 0
-- so every row is a bill dollar and the rows of one cell sum exactly to B.
--
-- Weights:
--   * OTel spend, tagged (project) or untagged (NULL), over exactly the
--     population the needs-tagging residual subtracts
--     (server/usage/corroborated-otel.ts): open api-uncorroborated quarantines
--     excluded; self-billed excluded unless the cell still holds an unknown-lane
--     row. Weights and residual must describe the same dollars, or a tag on one
--     moves bill onto the other's project.
--     Archived days (below the ledger watermark) read the cold rollup, which has
--     neither lane nor quarantine, so self-billed and quarantined rows weigh there.
--   * unaccounted_usage rows: tagged rows weigh toward their project, untagged
--     and dismissed rows toward untagged (untagged spend is never charged to a
--     project).
--
-- The weights are a LATERAL keyed on each bill row, so a reader's window filter
-- on period_date bounds the work to that window's bill rows (index probes on
-- (teammate_id, ts_event)) instead of aggregating the whole ledger.
--
-- Column signature is unchanged, so CREATE OR REPLACE keeps the OID.
CREATE OR REPLACE VIEW v_finance_project_overlay WITH (security_invoker = true) AS
SELECT b.cost_owning_unit_id, b.region_id, b.teammate_id, b.period_date, b.tool, c.project_id,
       CASE WHEN c.total_weight_usd IS NULL THEN b.bill_usd
            ELSE b.bill_usd * c.weight_usd / c.total_weight_usd
       END AS charge_usd
  FROM v_finance_bill_chargeback b
  LEFT JOIN LATERAL (
    SELECT w.project_id, w.weight_usd, w.total_weight_usd
      FROM (
        SELECT x.project_id, SUM(x.weight_usd) AS weight_usd,
               SUM(SUM(x.weight_usd)) OVER () AS total_weight_usd
          FROM (
            -- The completeness gate is decided once for the whole cell and
            -- applied unchanged to every project row of it.
            SELECT o.project_id,
                   CASE WHEN bool_or(bool_or(o.unknown_row)) OVER ()
                        THEN SUM(o.cost_usd)
                        ELSE COALESCE(SUM(o.cost_usd) FILTER (WHERE o.billing_lane <> 'self-billed'), 0)
                   END AS weight_usd
              FROM (
                SELECT ar.project_id, ar.cost_usd, ar.billing_lane,
                       (ar.billing_lane IS NULL OR ar.billing_lane = 'unknown') AS unknown_row
                  FROM attribution_record ar
                 WHERE ar.teammate_id = b.teammate_id
                   AND ar.tool = b.tool
                   AND ar.ts_event >= (b.period_date::timestamp AT TIME ZONE 'UTC')
                   AND ar.ts_event <  ((b.period_date + 1)::timestamp AT TIME ZONE 'UTC')
                   AND ar.ts_event >= COALESCE((SELECT archived_through FROM ledger_archive_state WHERE id = 'singleton'), '-infinity'::timestamptz)
                   AND NOT EXISTS (
                     SELECT 1 FROM session_quarantine sq
                      WHERE sq.teammate_id = ar.teammate_id
                        AND sq.conversation_id = ar.claude_session_id
                        AND sq.resolved_at IS NULL
                        AND sq.reason = 'api-uncorroborated')
                UNION ALL
                SELECT srd.project_id, srd.total_cost_usd, 'unknown'::text, TRUE
                  FROM spend_rollup_daily srd
                 WHERE srd.teammate_id = b.teammate_id
                   AND srd.tool = b.tool
                   AND srd.period_start >= (b.period_date::timestamp AT TIME ZONE 'UTC')
                   AND srd.period_start <  ((b.period_date + 1)::timestamp AT TIME ZONE 'UTC')
                   AND srd.period_start < COALESCE((SELECT archived_through FROM ledger_archive_state WHERE id = 'singleton'), '-infinity'::timestamptz)
              ) o
             GROUP BY o.project_id
            UNION ALL
            SELECT u.project_id, u.cost_usd
              FROM unaccounted_usage u
             WHERE u.teammate_id = b.teammate_id AND u.day = b.period_date AND u.tool = b.tool
          ) x
         GROUP BY x.project_id
      ) w
     WHERE w.total_weight_usd > 0 AND w.weight_usd <> 0
  ) c ON TRUE;

COMMENT ON VIEW v_finance_project_overlay IS
  'Chargeable bill (v_finance_bill_chargeback) split per (teammate, day, tool) proportionally across project weights; project_id NULL = untagged. Rows of one cell sum to bill_usd. Weights: corroborated OTel (the population the residual subtracts: quarantine and self-billed excluded) plus unaccounted_usage (tagged -> project, untagged/dismissed -> NULL). docs/design/project-chargeback-lens.md.';
