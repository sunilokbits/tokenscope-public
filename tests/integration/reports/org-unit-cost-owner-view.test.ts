// @vitest-environment node
/*
 * Migrations 0114/0115/0147 — v_org_unit_cost_owner, and the §B bill views
 * reading it.
 *
 * The same "nearest live cost-owning ancestor" resolution was copied into five
 * places as a correlated LATERAL that fired once per USAGE ROW to answer a
 * question about a 132-row table. 0114 makes it one view; 0115 moves
 * v_finance_bill_chargeback onto it; 0147 clamps the ancestor to the unit's
 * own region and moves v_finance_bill_showback onto it too.
 *
 * The §B views feed every chargeback and showback figure in the product, so a
 * homing change here silently moves money between cost centres. These tests
 * therefore assert EQUIVALENCE against the LATERAL evaluated in-place (with the
 * 0147 clamp), rather than asserting the view agrees with itself.
 *
 * The tree is adversarial by construction: a reflexively cost-owning unit, a
 * NESTED cost-owning unit (the nearer one must win), a RETIRED cost-owning unit
 * (descendants must fall up to the next live ancestor, not strand), a branch
 * with no cost-owning ancestor at all (whose spend must stay visible as
 * unallocated rather than leave the bill) — and a SECOND region whose units
 * COLLIDE on those paths (idor-data-drizzle-001). Paths are unique only per
 * region, so without the clamp the foreign units would capture region co's
 * spend: deepest wins, and each collider is deeper than co's real owner.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import { sql } from 'drizzle-orm'
import { startTestDb, stopTestDb, type TestDb } from '../helpers/db'
import { teammateDimensionSnapshotSql } from '../../../server/reconciliation/dimension-snapshot'

let t: TestDb
let regionId = ''
let otherRegionId = ''
const unit: Record<string, string> = {}
const mate: Record<string, string> = {}

/*
 * The pre-0114 resolution, with the 0147 same-region clamp. Every equivalence
 * assertion below compares against this, so if the view's rule ever drifts the
 * test fails rather than re-blessing it.
 */
const CLAMPED_LATERAL = `
  SELECT home.id AS org_unit_id, cc.id AS cost_owning_unit_id, cc.region_id
  FROM org_unit home
  LEFT JOIN LATERAL (
    SELECT anc.id, anc.region_id
    FROM org_unit h2 JOIN org_unit anc ON h2.path <@ anc.path AND anc.region_id = h2.region_id
    WHERE h2.id = home.id AND anc.is_cost_owning_unit = TRUE AND anc.retired_at IS NULL
    ORDER BY nlevel(anc.path) DESC LIMIT 1
  ) cc ON TRUE`

/** The same LATERAL WITHOUT the clamp: what shipped before 0147. */
const UNCLAMPED_LATERAL = CLAMPED_LATERAL.replace(' AND anc.region_id = h2.region_id', '')

beforeAll(async () => {
  t = await startTestDb()

  await t.client`INSERT INTO region (code, display_name) VALUES ('co', 'Cost-Owner Region')`
  ;[{ id: regionId }] = await t.client<{ id: string }[]>`SELECT id::text AS id FROM region WHERE code='co'`
  await t.client`INSERT INTO region (code, display_name) VALUES ('co2', 'Colliding Region')`
  ;[{ id: otherRegionId }] = await t.client<{ id: string }[]>`SELECT id::text AS id FROM region WHERE code='co2'`

  const mkUnit = async (path: string, code: string, owning: boolean, retired: boolean, region = regionId) => {
    await t.client`INSERT INTO org_unit (region_id, path, code, display_name, unit_type, is_cost_owning_unit, retired_at)
      VALUES (${region}::uuid, ${path}::ltree, ${code}, ${'U ' + code}, 'practice', ${owning},
              ${retired ? '2026-01-01T00:00:00Z' : null})`
    const [row] = await t.client<{ id: string }[]>`SELECT id::text AS id FROM org_unit WHERE code=${code}`
    unit[code] = row!.id
  }

  await mkUnit('co', 'co-root', false, false)
  await mkUnit('co.cto', 'co-cto', true, false) // cost-owning
  await mkUnit('co.cto.eng', 'co-eng', false, false) // → co-cto
  await mkUnit('co.cto.eng.data', 'co-data', true, false) // nested cost-owning unit
  await mkUnit('co.cto.eng.data.ml', 'co-ml', false, false) // → co-data (NEAREST wins)
  await mkUnit('co.cto.ops', 'co-ops', true, true) // RETIRED cost-owning
  await mkUnit('co.cto.ops.sre', 'co-sre', false, false) // → co-cto (skips retired)
  await mkUnit('co.orphan', 'co-orphan', false, false) // → NULL (no owner)

  /*
   * THE COLLISION. Region co2 has live cost-owning units at exactly the paths of
   * co-eng and co-orphan. Unclamped, co-eng (and everything under it but above
   * co-data) resolves to co2-eng, and co-orphan to co2-orphan, carrying region
   * co2 onto co's bill rows.
   */
  await mkUnit('co.cto.eng', 'co2-eng', true, false, otherRegionId)
  await mkUnit('co.orphan', 'co2-orphan', true, false, otherRegionId)

  /*
   * A SAME-DEPTH tie within one region. Two live cost-owning units can sit at
   * equal nlevel above one home. Without a total ORDER BY, both DISTINCT ON and
   * the LIMIT 1 it replaced pick an arbitrary winner that can differ between
   * plans. `anc.id` is the tiebreak.
   */
  await mkUnit('co.tie', 'co-tie-a', true, false)
  await mkUnit('co.tie', 'co-tie-b', true, false)
  await mkUnit('co.tie.leaf', 'co-tie-leaf', false, false)

  const mkMate = async (code: string, unitCode: string) => {
    await t.client`INSERT INTO teammate (entra_oid, email, display_name, region_id, org_unit_id)
      VALUES (${'oid-' + code}, ${code + '@x.test'}, ${code}, ${regionId}::uuid, ${unit[unitCode]}::uuid)`
    const [row] = await t.client<{ id: string }[]>`SELECT id::text AS id FROM teammate WHERE email=${code + '@x.test'}`
    mate[code] = row!.id
  }
  await mkMate('m-ml', 'co-ml') // homes to co-data
  await mkMate('m-sre', 'co-sre') // homes to co-cto (retired skipped)
  await mkMate('m-orphan', 'co-orphan') // homes to NULL — NOT the co2 collider
  await mkMate('m-eng', 'co-eng') // homes to co-cto — NOT the co2 collider

  // Chargeable §B spend for each, at distinct amounts so a mis-home is a wrong
  // NUMBER rather than merely a wrong shape.
  const spend = async (code: string, usd: number) => {
    await t.client`INSERT INTO actual_spend (teammate_id, date, tool, cost_usd, input_tokens, output_tokens, chargeback_exempt)
      VALUES (${mate[code]}::uuid, DATE '2026-06-15', 'claude-code', ${usd}, 100, 50, false)`
  }
  await spend('m-ml', 11.11)
  await spend('m-sre', 22.22)
  await spend('m-orphan', 33.33)
  await spend('m-eng', 44.44)
})

afterAll(async () => {
  await stopTestDb(t)
})

const MATES = () => [mate['m-ml']!, mate['m-sre']!, mate['m-orphan']!, mate['m-eng']!]

describe('v_org_unit_cost_owner — the resolution', () => {
  it('resolves each unit to its nearest LIVE cost-owning ancestor in its OWN region', async () => {
    const rows = await t.client<{ code: string; owner: string | null }[]>`
      SELECT h.code AS code, c.cost_owning_unit_code AS owner
      FROM org_unit h JOIN v_org_unit_cost_owner c ON c.org_unit_id = h.id
      WHERE h.code LIKE 'co%' ORDER BY h.code`
    const map = Object.fromEntries(rows.map((r) => [r.code, r.owner]))
    expect(map['co-cto']).toBe('co-cto') // reflexive: a cost-owning unit owns itself
    expect(map['co-eng']).toBe('co-cto') // NOT the deeper co2-eng at the same path
    expect(map['co-data']).toBe('co-data')
    expect(map['co-ml']).toBe('co-data') // NEAREST, not the co-cto grandparent
    expect(map['co-sre']).toBe('co-cto') // retired co-ops is skipped
    expect(map['co-ops']).toBe('co-cto') // a retired unit does not own itself
    expect(map['co-orphan']).toBeNull() // NOT co2-orphan — the row still exists
    expect(map['co-root']).toBeNull()
    expect(map['co2-eng']).toBe('co2-eng') // the colliders still own themselves
    expect(map['co2-orphan']).toBe('co2-orphan')
  })

  it('the collision is real: without the clamp, co units resolve into region co2', async () => {
    // Guards every collision assertion here: if the fixture stopped colliding,
    // they would pass without the clamp too.
    const rows = await t.client<{ code: string; owner_region: string | null }[]>`
      WITH legacy AS (${t.client.unsafe(UNCLAMPED_LATERAL)})
      SELECT h.code, l.region_id::text AS owner_region
      FROM legacy l JOIN org_unit h ON h.id = l.org_unit_id
      WHERE h.code IN ('co-eng', 'co-orphan')`
    expect(rows).toHaveLength(2)
    for (const r of rows) expect(r.owner_region).toBe(otherRegionId)
  })

  it('breaks a same-depth tie deterministically, by the lowest ancestor id', async () => {
    const [row] = await t.client<{ owner: string | null }[]>`
      SELECT c.cost_owning_unit_id::text AS owner
      FROM org_unit h JOIN v_org_unit_cost_owner c ON c.org_unit_id = h.id
      WHERE h.code = 'co-tie-leaf'`
    const [expected] = await t.client<{ id: string }[]>`
      SELECT MIN(id::text) AS id FROM org_unit WHERE code IN ('co-tie-a', 'co-tie-b')`
    expect(row!.owner).toBe(expected!.id)
  })

  it('carries the tiebreak and the region clamp in the view definition itself', async () => {
    /*
     * Determinism cannot be established by running the query and comparing
     * results: an ARBITRARY choice is free to be a stable one, so a repetition
     * test passes with the tiebreak removed and proves nothing. What is
     * decidable is whether the total order is actually there.
     */
    const [row] = await t.client<{ def: string }[]>`
      SELECT pg_get_viewdef('v_org_unit_cost_owner'::regclass, true) AS def`
    const orderBy = row!.def.slice(row!.def.toUpperCase().lastIndexOf('ORDER BY'))
    expect(orderBy).toMatch(/nlevel\(anc\.path\)\)? DESC/)
    expect(orderBy).toMatch(/DESC,\s*anc\.id/)
    // The clamp lives in the LEFT JOIN's ON clause: in WHERE it would drop
    // units that have no same-region owner.
    const on = row!.def.slice(row!.def.toUpperCase().indexOf(' ON '), row!.def.toUpperCase().lastIndexOf('ORDER BY'))
    expect(on).toMatch(/anc\.region_id = home\.region_id/)
    expect(row!.def.toUpperCase()).not.toContain('WHERE')
  })

  it('pins BOTH §B bill views to the shared map, so the LATERAL cannot creep back', async () => {
    for (const view of ['v_finance_bill_chargeback', 'v_finance_bill_showback']) {
      const [row] = await t.client<{ def: string }[]>`
        SELECT pg_get_viewdef(${view}::regclass, true) AS def`
      expect(row!.def, view).toContain('v_org_unit_cost_owner')
      expect(row!.def.toUpperCase(), view).not.toContain('LATERAL')
    }
  })

  it('emits exactly one row per org_unit, so a join can never fan out spend', async () => {
    const [row] = await t.client<{ units: string; mapped: string; distinct: string }[]>`
      SELECT (SELECT count(*) FROM org_unit)::text AS units,
             (SELECT count(*) FROM v_org_unit_cost_owner)::text AS mapped,
             (SELECT count(DISTINCT org_unit_id) FROM v_org_unit_cost_owner)::text AS distinct`
    expect(row!.mapped).toBe(row!.units)
    expect(row!.distinct).toBe(row!.units)
  })

  it('is identical to the clamped LATERAL wherever that had defined behaviour', async () => {
    /*
     * On a same-depth tie the LATERAL's `ORDER BY nlevel DESC LIMIT 1` has no
     * tiebreak and returns an arbitrary winner; the view breaks the tie on
     * anc.id. Equivalence is therefore asserted over the unambiguous units.
     */
    const [diff] = await t.client<{ only_old: string; only_new: string }[]>`
      WITH ambiguous AS (
        SELECT home.id
        FROM org_unit home
        JOIN org_unit anc
          ON home.path <@ anc.path AND anc.region_id = home.region_id
         AND anc.is_cost_owning_unit AND anc.retired_at IS NULL
        GROUP BY home.id
        HAVING count(*) FILTER (
          WHERE nlevel(anc.path) = (
            SELECT max(nlevel(a2.path)) FROM org_unit a2
            WHERE home.path <@ a2.path AND a2.region_id = home.region_id
              AND a2.is_cost_owning_unit AND a2.retired_at IS NULL)
        ) > 1
      ),
      legacy AS (${t.client.unsafe(CLAMPED_LATERAL)}),
      current AS (SELECT org_unit_id, cost_owning_unit_id, cost_owning_unit_region_id AS region_id
                    FROM v_org_unit_cost_owner)
      SELECT (SELECT count(*) FROM (
                SELECT * FROM legacy WHERE org_unit_id NOT IN (SELECT id FROM ambiguous)
                EXCEPT SELECT * FROM current) a)::text AS only_old,
             (SELECT count(*) FROM (
                SELECT * FROM current WHERE org_unit_id NOT IN (SELECT id FROM ambiguous)
                EXCEPT SELECT * FROM legacy) b)::text AS only_new`
    expect(diff!.only_old).toBe('0')
    expect(diff!.only_new).toBe('0')
  })

  it('the equivalence check is not vacuous — the tree really does contain ties', async () => {
    const [row] = await t.client<{ ties: string; total: string }[]>`
      SELECT (SELECT count(*)::text FROM org_unit WHERE code IN ('co-tie-a','co-tie-b')) AS ties,
             (SELECT count(*)::text FROM org_unit) AS total`
    expect(Number(row!.ties)).toBe(2)
    expect(Number(row!.total)).toBeGreaterThan(5)
  })
})

describe('§B bill views — homing under a cross-region path collision', () => {
  for (const view of ['v_finance_bill_chargeback', 'v_finance_bill_showback']) {
    it(`${view}: bills each teammate to its own-region cost centre; the colliders capture nothing`, async () => {
      const rows = await t.client<{ owner: string | null; region_id: string | null; bill: string }[]>`
        SELECT o.code AS owner, b.region_id::text AS region_id, SUM(b.bill_usd)::text AS bill
        FROM ${t.client(view)} b
        LEFT JOIN org_unit o ON o.id = b.cost_owning_unit_id
        WHERE b.teammate_id IN ${t.client(MATES())}
        GROUP BY o.code, b.region_id ORDER BY o.code NULLS LAST`
      const map = Object.fromEntries(rows.map((r) => [r.owner ?? '__unallocated', Number(r.bill)]))
      expect(map['co-data']).toBeCloseTo(11.11, 2) // nested owner wins
      expect(map['co-cto']).toBeCloseTo(22.22 + 44.44, 2) // retired skipped; co-eng NOT captured by co2-eng
      expect(map['__unallocated']).toBeCloseTo(33.33, 2) // NOT captured by co2-orphan, NOT dropped
      expect(map['co2-eng']).toBeUndefined()
      expect(map['co2-orphan']).toBeUndefined()
      // No region co spend is reported under region co2.
      expect(rows.filter((r) => r.region_id === otherRegionId)).toEqual([])
    })
  }

  it('conserves the total: Σ chargeback == Σ chargeable actual_spend', async () => {
    const [row] = await t.client<{ billed: string; source: string }[]>`
      SELECT (SELECT COALESCE(SUM(bill_usd), 0) FROM v_finance_bill_chargeback
               WHERE teammate_id IN ${t.client(MATES())})::text AS billed,
             (SELECT COALESCE(SUM(cost_usd), 0) FROM actual_spend
               WHERE teammate_id IN ${t.client(MATES())} AND NOT chargeback_exempt)::text AS source`
    expect(Number(row!.billed)).toBeCloseTo(Number(row!.source), 2)
    expect(Number(row!.billed)).toBeCloseTo(111.1, 2)
  })

  it('keeps the §A Copilot lanes out of the chargeback view', async () => {
    await t.client`INSERT INTO actual_spend (teammate_id, date, tool, cost_usd, input_tokens, output_tokens, chargeback_exempt)
      VALUES (${mate['m-ml']}::uuid, DATE '2026-06-16', 'copilot-cli', 99, 1, 1, false)`
    const rows = await t.client<{ n: string }[]>`
      SELECT count(*)::text AS n FROM v_finance_bill_chargeback
      WHERE tool IN ('copilot', 'copilot-agent', 'copilot-license', 'copilot-usage', 'copilot-unclassified', 'copilot-cli')`
    expect(rows[0]!.n).toBe('0')
  })
})

describe('ingest-time dimension snapshot (server/reconciliation/dimension-snapshot.ts)', () => {
  it('persists the same own-region owner the view resolves; the colliders capture nothing', async () => {
    const owner = async (code: string) => {
      const snap = teammateDimensionSnapshotSql(sql`${mate[code]}::uuid`)
      const [row] = await t.db.execute<{ cou: string | null }>(sql`SELECT (${snap.costOwningUnitId})::text AS cou`)
      return row!.cou
    }
    expect(await owner('m-eng')).toBe(unit['co-cto'])
    expect(await owner('m-orphan')).toBeNull()
    expect(await owner('m-ml')).toBe(unit['co-data'])
  })
})
