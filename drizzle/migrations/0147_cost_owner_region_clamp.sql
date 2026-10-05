-- 0147 — v_org_unit_cost_owner resolves ancestors within the unit's OWN region.
--
-- org_unit.path is unique only per region, so `home.path <@ anc.path` alone
-- matches a colliding path in another region (idor-data-drizzle-001,
-- docs/security-audit-output/security-audit-report.md). The region predicate
-- sits INSIDE the LEFT JOIN's ON clause: in WHERE it would drop units with no
-- same-region owner and break the one-row-per-org_unit totality callers rely on.
--
-- v_finance_bill_showback still inlined the unclamped LATERAL (0073); it now
-- reads the shared map, as 0115 did for v_finance_bill_chargeback. Same column
-- signature, so CREATE OR REPLACE keeps dependents valid.
--
-- Moves money between cost centres wherever a collision exists: the number of
-- units whose owner changes is raised as a NOTICE.

CREATE TEMP TABLE mig0147_owner_before AS
SELECT org_unit_id, cost_owning_unit_id FROM v_org_unit_cost_owner;

CREATE OR REPLACE VIEW v_org_unit_cost_owner WITH (security_invoker = true) AS
SELECT DISTINCT ON (home.id)
       home.id                AS org_unit_id,
       anc.id                 AS cost_owning_unit_id,
       anc.display_name       AS cost_owning_unit_name,
       anc.code               AS cost_owning_unit_code,
       anc.region_id          AS cost_owning_unit_region_id
FROM org_unit home
LEFT JOIN org_unit anc
       ON home.path <@ anc.path
      AND anc.region_id = home.region_id
      AND anc.is_cost_owning_unit = TRUE
      AND anc.retired_at IS NULL
ORDER BY home.id, nlevel(anc.path) DESC, anc.id;

COMMENT ON VIEW v_org_unit_cost_owner IS
  'Nearest live cost-owning ancestor of each org_unit IN THE SAME REGION (reflexive: a cost-owning unit maps to itself), one row per org_unit, cost_owning_unit_id NULL when there is none. THE single implementation of that resolution; do not re-inline it. Join as `LEFT JOIN v_org_unit_cost_owner c ON c.org_unit_id = <row>.org_unit_id`; a LEFT join is required, since an INNER one drops unhomed spend out of totals.';

DO $$
DECLARE
  moved integer;
BEGIN
  SELECT COUNT(*) INTO moved
  FROM mig0147_owner_before b
  JOIN v_org_unit_cost_owner a ON a.org_unit_id = b.org_unit_id
  WHERE a.cost_owning_unit_id IS DISTINCT FROM b.cost_owning_unit_id;
  RAISE NOTICE 'mig 0147: % org unit(s) change cost owner under the same-region clamp', moved;
END $$;

DROP TABLE mig0147_owner_before;

CREATE OR REPLACE VIEW v_finance_bill_showback WITH (security_invoker = true) AS
SELECT a.teammate_id, a.date AS period_date, a.tool,
       c.cost_owning_unit_id,
       c.cost_owning_unit_region_id AS region_id,
       SUM(a.cost_usd) AS bill_usd, SUM(a.input_tokens + a.output_tokens) AS bill_tokens
FROM actual_spend a JOIN teammate t ON t.id = a.teammate_id
LEFT JOIN v_org_unit_cost_owner c ON c.org_unit_id = t.org_unit_id
GROUP BY a.teammate_id, a.date, a.tool, c.cost_owning_unit_id, c.cost_owning_unit_region_id;
