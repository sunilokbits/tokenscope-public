// @vitest-environment node
/*
 * Unhomed CAUSE-SPLIT test — the named acceptance test for the diagnostics
 * probe that answers "why does 63% of this month reach no cost-owning unit?".
 *
 * THE TRUST TEST is `reconciles to the authoritative total…` below: four
 * positively-defined buckets, each at its independently hand-computed amount,
 * summing back to the SAME figure the card's unhomed line renders, with a
 * residual of exactly zero, compared as exact decimal strings at numeric(14,6)
 * — never a float and never a rounded display value. A split that does not add
 * back to the figure it decomposes is worse than no split: it invites an
 * operator to size a remediation against a bucket that is quietly missing
 * money.
 *
 * FIXTURE ARITHMETIC lives in `seedUnhomedCausePlantings`
 * (tests/integration/helpers/known-outcome-fixture.ts) and is canonical there,
 * deliberately not restated here — the sibling fixture's comment already went
 * stale twice by keeping two copies. The four planted amounts are $46 / $34 /
 * $26 / $37 = $143, each distinct so a swapped or double-counted bucket cannot
 * pass, and the estate also carries plenty of NORMALLY-HOMED spend so the total
 * is not trivially the whole estate.
 *
 * ── THE THREE TRAPS THIS SUITE EXISTS TO KILL ─────────────────────────────
 *
 * 1. THE SENTINEL. "No region" is NOT a NULL column: placement mints a REAL
 *    region row (`__unassigned__`) and REAL per-region holding units
 *    (`__UNPLACED__`). A bucket written as `region_id IS NULL` reads $0.00
 *    forever — a term that cannot fail. The fixture therefore mints its holding
 *    nodes through the PRODUCT's own writers (`unplacedOrgUnitId()`,
 *    `unplacedOrgUnitIdForRegion()`), and `the sentinel is a real row…` asserts
 *    directly that the naive predicate would have measured nothing.
 *
 * 2. TWO DEFINITIONS. The split needs teammate grain, which
 *    `v_finance_chargeback_month` GROUP BYs away. Recomputing the total one
 *    level down is the obvious shape and the wrong one: the total and its split
 *    then drift apart in silence. `computeUnhomedCauses` carries the month-view
 *    expression VERBATIM into the same statement as the buckets, and this suite
 *    pins the result against `computeAbDecomposition`'s
 *    `diagnostics.unhomedChargeUsd` for the same window — one DEFINITION, and
 *    an equality this suite can actually check.
 *
 *    It is not one STATEMENT, and this header used to imply it was. The two
 *    figures are computed by two queries over two READ COMMITTED snapshots, so
 *    what the equality below proves is that they define the quantity the same
 *    way — not that they can never differ on a live estate where a placement
 *    lands between the reads. Nothing in a test database can produce that
 *    difference, so nothing here claims to rule it out (see the module's ONE
 *    DEFINITION, TWO STATEMENTS header).
 *
 * 3. TESTS THAT CANNOT FAIL. Every assertion below was proven to FAIL with its
 *    fix reverted. The procedure, so it can be repeated: apply the mutation, run
 *      CI=true NO_COLOR=1 npx vitest run tests/integration/usage/unhomed-causes.test.ts
 *    confirm it FAILS, restore, confirm green. KILLED this way:
 *      - the `__unassigned__` sentinel swapped for `region_id IS NULL`
 *        (no-region collapses to $0, region-no-unit swallows it — the exact
 *        failure mode trap 1 describes);
 *      - the holding-node predicate (`unit_type = 'holding'`) deleted, so
 *        region-no-unit money falls into no-cost-owning-ancestor;
 *      - the ancestor NOT EXISTS's `anc.retired_at IS NULL` deleted, so ivan —
 *        whose only cost-owning ancestor is RETIRED — matches no bucket and the
 *        residual fires (see `a teammate whose only cost-owning ancestor…`);
 *      - the ancestor `NOT EXISTS` inverted, so that bucket empties;
 *      - migration 0107's `NOT EXISTS (copilot_overage_allocation …)` mirror
 *        deleted, so the pooled bucket counts suppressed overage twice;
 *      - the authoritative total swapped for a second SUM at teammate grain
 *        (trap 2 made real: the split then still "reconciles" while the pooled
 *        money silently vanishes from the total);
 *      - the pooled bucket's `cost_owning_unit_id IS NULL` filter dropped;
 *      - the `copilot-unclassified` exclusion dropped from the total;
 *      - the worklist's `bucketUsd` disclosure zeroed;
 *      - the drill's dollar sort REVERSED (`ORDER BY … usd DESC` → `ASC`), and —
 *        the original defect — bound to the projected TEXT column instead of the
 *        numeric one, under which $99 outranks $115. Killed for ALL THREE lists,
 *        including the ORG-UNIT one, which had a single row in both months and
 *        was therefore unpinned until June grew a second and a third ($124 / $98
 *        / $13 — three orderings, no two alike);
 *      - `ou.path <@ anc.path` flipped to `@>`, so a cost-owning CHILD homes a
 *        team that nothing above it homes (nina, `reads ancestry upward…`);
 *      - the teammate arm's `b.cost_owning_unit_id IS NULL` dropped, so
 *        region-no-unit claims pia's $77 — money that already reached a cost
 *        centre (`never buckets money that already reached…`);
 *      - the pooled allocation arm's `coa.cost_owning_unit_id IS NULL` dropped,
 *        so a HOMED overage allocation reads as unhomed pooled money;
 *      - the history's `no-spend` state gated on chargeable ALONE, so a
 *        credit-netted March renders "No chargeable spend in this month" over $60
 *        of unhomed money, and its `sharePct` computed against a zero divisor;
 *      - the shared cause const REORDERED, so the panel's rows change order;
 *      - the worklist cap raised or removed, so a truncated list stops being
 *        truncated and `shown < total` no longer holds;
 *      - the teammate arm re-grained per (teammate, tool), so the worklist emits
 *        one row per tool instead of one per person;
 *      - `COUNT(DISTINCT region_id)` behind region-no-unit swapped for
 *        `COUNT(DISTINCT teammate_id)` (5 people across 2 regions in June);
 *      - the counters' `cost_centre_code IS NOT NULL` filter dropped (0-of-5
 *        reads as 5-of-5), their `bill:` / `provisional:` exclusion dropped,
 *        their `org_unit.retired_at IS NULL` dropped (a retired cost centre
 *        counts as active), and their `cou_owner.revoked_at IS NULL` dropped (a
 *        revoked owner counts as active);
 *      - `estateFirstMonth`'s `copilot_pool_bill` arm dropped, so an estate
 *        whose earliest billed data is a pooled invoice reads "not measured";
 *      - the history's `estateFirstMonth` guard dropped (a month before the
 *        estate had data renders as a real 0%), its close state hardcoded open,
 *        its `sharePct` left as a fraction (the ×100 removed), its `partial`
 *        flag hardcoded false, and its anchor pointed the wrong way;
 *      - `fallible()`'s savepoint reduced to a bare `try/catch`, so a failed
 *        counter read poisons the enclosing transaction and takes the money down
 *        with it (`contains a failed sub-read…`, which is the only test in this
 *        file that runs inside a transaction — with a pooled handle every
 *        statement is its own implicit transaction and the mutation survives).
 *
 * SURVIVORS — stated, not hidden, per the mutation-sweep discipline.
 *   `COUNT(DISTINCT teammate_id)` → `COUNT(*)` SURVIVES, in both the cause
 *   aggregate and the per-unit head count. It is an EQUIVALENT MUTANT: the
 *   teammate arm pre-aggregates to one row per teammate, so the two forms are
 *   identical by construction. The PROPERTY (counts are people, not view rows)
 *   is still pinned — re-graining that pre-aggregation per (teammate, tool) IS
 *   killed, and the `frankViewRows === 2` assertion below shows the fixture
 *   genuinely presents two view rows for the one person the count reads as 1.
 *   The DISTINCTs stay as defence in depth against exactly that re-graining.
 *
 *   Replacing the ancestor bucket's WHOLE `NOT EXISTS (…)` with TRUE also
 *   SURVIVES, and that is a fact about the design rather than a gap in this
 *   suite. The per-teammate arm only admits rows the chargeback view already
 *   resolved to a NULL cost_owning_unit_id, using the SAME rule, so for any row
 *   that reaches the third branch the sub-query cannot be false:
 *   `no-cost-owning-ancestor` IS the remainder of that arm. It is written out as
 *   a MIRROR of the view's LATERAL so that a future divergence lands in the
 *   residual instead of being silently reclassified — and the half of the mirror
 *   that data CAN falsify, `retired_at IS NULL`, is killed above. The module
 *   header says all of this in the same words; neither claims a catch-all-free
 *   partition it does not have.
 *
 *   The teammate arm's GITHUB FIREWALL filter (`b.tool NOT IN (…)`) SURVIVES
 *   deletion, and is the same kind of mirror. `v_finance_bill_chargeback` — the
 *   view this arm reads FROM — already excludes those tools itself (migration
 *   0085 §1b), so no row carrying one can reach the filter and removing it
 *   changes no number here (verified by running this suite with it deleted). It
 *   is kept as the arm's half of that pair: if the view's firewall ever moved
 *   without this one, the money would be in the authoritative total and out of
 *   every bucket, so the RESIDUAL reports it instead of a placement cause
 *   silently absorbing it.
 *
 *   What is pinned elsewhere is narrower than "the two lists are equal", and
 *   saying otherwise here would be the same kind of overclaim this suite exists
 *   to catch: tests/integration/finance/copilot-chargeback-lanes.test.ts proves
 *   the §A tool literals appear in the chargeback views ONLY inside exclusion
 *   predicates, and at least once. Element-for-element agreement between the
 *   SQL list and `GITHUB_FIREWALL_EXCLUSIONS` is not asserted anywhere, which is
 *   precisely why the mirror-plus-residual arrangement is worth its redundancy.
 *
 *   NOT DECLARED — DELETED. Two more mutants survived, and neither was a mirror:
 *   the history sub-select's `ORDER BY period_month DESC` (buildHistory re-keys
 *   those rows into a Map, so no consumer could observe the order) and the drill
 *   sub-selects' second copy of the sort key (the unit and organisation lists sit
 *   below the cap on every fixture, so their display ORDER BY could disagree with
 *   the ORDER BY the rows were CUT on and nothing would notice). A survivor with
 *   nothing behind it is dead code, not defence in depth: the first is gone, and
 *   the second is now `ORDER BY rn` — one sort decides both the cut and the page,
 *   which is what makes the org-unit sort mutants above killable at all.
 *
 * KNOWN SURVIVOR OF A DIFFERENT KIND. Over the per-teammate arm the three
 * placement causes are EXHAUSTIVE by construction (`teammate.org_unit_id` and
 * `org_unit.region_id` are NOT NULL and the chargeback view INNER JOINs
 * teammate, so every unhomed row has exactly one home node, which is either in
 * the holding region, or a holding node, or a real unit). No fixture ROW can
 * therefore escape all four buckets, so a data-only test cannot make the
 * residual fire from the teammate side. That is why the two negative tests
 * attack the OTHER two ways it can fire — a window whose two grains disagree,
 * and a new arm appearing in the §B month view — both real, and both exactly
 * what the residual is there to catch.
 *
 * TWO ESTATES, TWO MONTHS — AND A THIRD MONTH THAT IS NEITHER. May is one row
 * per cause, every figure hand-derivable ($46 / $34 / $26 / $37). June is the
 * second estate `seedUnhomedCausePlantings` plants for the properties one row per
 * cause cannot express: more people than the worklist cap, a dollar range whose
 * text order disagrees with its numeric order, two regions behind one cause, a
 * RETIRED cost-owning ancestor, a cost-owning CHILD under an unhomed unit, and
 * two shapes of money that must NOT be bucketed because they are already homed.
 * They are separate months on purpose — folding either into the other would make
 * both sets of arithmetic depend on the other's.
 *
 * MARCH is neither estate: it exists only for the TREND, which no window
 * measures directly. It nets to $0.00 chargeable over a real credit with $60 of
 * unhomed money inside it, and it is the only money in the history that is never
 * the anchor — so it pins both the trend's empty-month rule and the trend's
 * window.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import { startTestDb, stopTestDb, type TestDb } from '../helpers/db'
import {
  seedKnownOutcomeCompany,
  seedAbDecompositionPlantings,
  seedUnhomedCausePlantings,
  type KnownOutcomeIds,
  KO_MAY_WINDOW,
  KO_JUN_WINDOW,
} from '../helpers/known-outcome-fixture'
import { computeAbDecomposition } from '../../../server/usage/ab-decomposition'
import {
  computeUnhomedCauses,
  UNHOMED_WORKLIST_CAP,
  type UnhomedCause,
  type UnhomedProbeResult,
} from '../../../server/usage/unhomed-causes'

/** The one place the cap is restated, so a cap change breaks one line, not ten. */
const CAP = UNHOMED_WORKLIST_CAP

let t: TestDb
let ids: KnownOutcomeIds

/** The month the card's selector holds for KO_MAY_WINDOW. */
const MAY = '2026-05'
/** …and for KO_JUN_WINDOW — the second estate (cap, sort, two regions, retired ancestor). */
const JUN = '2026-06'

const usd = (r: UnhomedProbeResult, cause: UnhomedCause): string =>
  r.causes.find((c) => c.cause === cause)!.usd

beforeAll(async () => {
  t = await startTestDb()
  ids = await seedKnownOutcomeCompany(t)
  await seedAbDecompositionPlantings(t, ids)
  await seedUnhomedCausePlantings(t, ids)
}, 180_000)

afterAll(async () => {
  await stopTestDb(t)
}, 30_000)

describe('unhomed cause split', () => {
  it('reconciles to the authoritative total with a residual of exactly zero', async () => {
    const r = await computeUnhomedCauses(t.db, KO_MAY_WINDOW, MAY)

    /*
     * (0) THE ORDER, against a literal rather than against the shared const.
     * `causes` is built by mapping over UNHOMED_CAUSES, so comparing it back to
     * that const would move with any reorder and certify nothing — while the
     * panel renders the rows in exactly this order and the const's header
     * documents it (three placement failures, escalating, then the pooled
     * residual that is not a placement failure at all).
     */
    expect(r.causes.map((c) => c.cause)).toEqual([
      'no-region',
      'region-no-unit',
      'no-cost-owning-ancestor',
      'pooled-copilot',
    ])

    // (1) each bucket at its independently hand-computed amount. Distinct
    // values, so a bucket that swallowed another's money fails here rather than
    // hiding inside a correct-looking sum.
    expect(usd(r, 'no-region')).toBe('46.000000')
    expect(usd(r, 'region-no-unit')).toBe('34.000000')
    expect(usd(r, 'no-cost-owning-ancestor')).toBe('26.000000')
    expect(usd(r, 'pooled-copilot')).toBe('37.000000')

    // (2) Σ(four buckets) + residual == the unhomed total, to the cent, as EXACT
    // decimal strings — never a float, never a rounded display value. Compared
    // in integer micro-dollars for the same reason the card's verdict is.
    const micros = (v: string) => BigInt(Math.round(Number(v) * 1_000_000))
    const summed =
      micros(usd(r, 'no-region')) +
      micros(usd(r, 'region-no-unit')) +
      micros(usd(r, 'no-cost-owning-ancestor')) +
      micros(usd(r, 'pooled-copilot')) +
      micros(r.residualUsd)
    expect(summed).toBe(micros(r.unhomedUsd))
    expect(r.unhomedUsd).toBe('143.000000')

    // (3) the residual is EXACTLY zero and the split is usable.
    expect(r.residualUsd).toBe('0.000000')
    expect(r.reconciles).toBe(true)

    // (4) ONE DEFINITION. The figure the split decomposes must be byte-identical
    // to the figure the card's existing unhomed line renders for the same window
    // — two queries, but never two definitions. This is the assertion that kills
    // trap 2: swap the probe's authoritative total for its own SUM at teammate
    // grain and the pooled $37 drops out of it here while the split still
    // "reconciles" internally.
    const ab = await computeAbDecomposition(t.db, KO_MAY_WINDOW)
    expect(r.unhomedUsd).toBe(ab.diagnostics.unhomedChargeUsd)

    // …and the denominator the share is taken against is §B itself, computed by
    // a different expression in a different module. Equal ⇒ the probe is
    // measuring the same estate the card is.
    expect(r.chargeableUsd).toBe(ab.sectionB)
  })

  /*
   * TRAP 1, asserted rather than asserted-about. The naive predicate is not
   * "wrong in principle" — it is wrong because placement writes real rows, and
   * the only way to prove that is to show the naive predicate finds nothing
   * while the real one finds $46.
   */
  it('the sentinel is a real row, so a NULL-region bucket would read $0.00 forever', async () => {
    const [{ n: nullRegionTeammates }] = await t.client<{ n: string }[]>`
      SELECT COUNT(*)::text AS n FROM teammate WHERE region_id IS NULL`
    const [{ n: nullUnitTeammates }] = await t.client<{ n: string }[]>`
      SELECT COUNT(*)::text AS n FROM teammate WHERE org_unit_id IS NULL`
    // Nobody is NULL-homed. A bucket keyed on either column measures nothing.
    expect(Number(nullRegionTeammates)).toBe(0)
    expect(Number(nullUnitTeammates)).toBe(0)

    // The sentinels the PRODUCT's writers minted are what the classifier keys on.
    const [{ n: sentinelRegions }] = await t.client<{ n: string }[]>`
      SELECT COUNT(*)::text AS n FROM region WHERE code = '__unassigned__'`
    const [{ n: holdingNodes }] = await t.client<{ n: string }[]>`
      SELECT COUNT(*)::text AS n FROM org_unit WHERE code = '__UNPLACED__' AND unit_type = 'holding'`
    expect(Number(sentinelRegions)).toBe(1)
    // Three, all minted by the product's writers: the system-wide holding
    // region's node, APAC's own, and EMEA's (June's two-region planting).
    expect(Number(holdingNodes)).toBe(3)

    const r = await computeUnhomedCauses(t.db, KO_MAY_WINDOW, MAY)
    expect(Number(usd(r, 'no-region'))).toBeGreaterThan(0)
    expect(Number(usd(r, 'region-no-unit'))).toBeGreaterThan(0)
  })

  /*
   * PB-5: "$26 across 47" is only actionable if 47 is PEOPLE. The chargeback
   * view is aggregated per (unit, region, tool, month), so a count over its rows
   * inflates with every extra tool lane. Frank has TWO tool rows in this month
   * and must read as one person; the orphan BU holds ONE unit and TWO people.
   */
  it('counts people, units and organisations — never view rows', async () => {
    const r = await computeUnhomedCauses(t.db, KO_MAY_WINDOW, MAY)
    const row = (c: UnhomedCause) => r.causes.find((x) => x.cause === c)!

    // The trap, made explicit: the source view really does carry TWO rows for
    // this one person in this one month. Without this the "1" below could be
    // read as a fixture with nothing to trip over.
    const [{ n: frankViewRows }] = await t.client<{ n: string }[]>`
      SELECT COUNT(*)::text AS n FROM v_finance_bill_chargeback b
      JOIN teammate t ON t.id = b.teammate_id
      WHERE t.email = 'frank@ko.test'
        AND b.period_date >= '2026-05-01'::date AND b.period_date < '2026-06-01'::date`
    expect(Number(frankViewRows)).toBe(2)

    const noRegion = row('no-region')
    expect(noRegion.countKind).toBe('teammates')
    expect(noRegion.count).toBe(1) // frank, despite claude-code AND claude-ai rows

    const ancestor = row('no-cost-owning-ancestor')
    expect(ancestor.countKind).toBe('org-units')
    expect(ancestor.count).toBe(1) // the orphan BU
    expect(ancestor.secondaryKind).toBe('teammates')
    expect(ancestor.secondaryCount).toBe(2) // erin + heidi

    const pooled = row('pooled-copilot')
    expect(pooled.countKind).toBe('provider-organisations')
    // The unhomed org, plus the enterprise-level unallocated line as one entry
    // of its own rather than vanishing from the count.
    expect(pooled.count).toBe(2)

    // PB-3: the pooled cause is NOT a placement failure and must not be totalled
    // as a peer of the three that are — placing people cannot move a cent of it.
    expect(pooled.placementFailure).toBe(false)
    expect(row('no-region').placementFailure).toBe(true)
    expect(row('region-no-unit').placementFailure).toBe(true)
    expect(ancestor.placementFailure).toBe(true)
  })

  /*
   * AC-3: the worklist row TYPE follows the cause, because the thing you would
   * actually fix differs per cause — a unit-keyed row for the holding-node
   * causes would always name the same one or two nodes, which no admin surface
   * can act on. Each row must also NAME the thing: a person needs the node they
   * are stuck on, a unit needs its code and region, and a pooled line with no
   * organisation needs a name of its own rather than a blank cell.
   */
  it('drills to the thing you would actually fix, naming it', async () => {
    const r = await computeUnhomedCauses(t.db, KO_MAY_WINDOW, MAY)
    const wl = (c: UnhomedCause) => r.worklists.find((w) => w.cause === c)!

    const people = wl('no-region')
    expect(people.rows).toHaveLength(1)
    expect(people.rows[0]!.kind).toBe('teammate')
    expect(people.rows[0]!.label).toBe('Frank Unplaced')
    expect(people.rows[0]!.sublabel).toBe('frank@ko.test')
    expect(people.rows[0]!.usd).toBe('46.000000')
    // The HOLDING NODE, named. Without it the row says a person is unplaced and
    // not where they are parked, which is the fact that tells an admin whether
    // this is theirs to fix or the global fallback.
    expect(people.rows[0]!.region).toBe('Unassigned · Unplaced')
    // …and the region-known case names a REAL region beside the same node, which
    // is what separates the two holding-node causes on screen.
    expect(wl('region-no-unit').rows[0]!.region).toBe('APAC · Unplaced')

    const units = wl('no-cost-owning-ancestor')
    expect(units.rows).toHaveLength(1)
    expect(units.rows[0]!.kind).toBe('org-unit')
    expect(units.rows[0]!.label).toBe('Orphan BU (no cost-owning ancestor)')
    expect(units.rows[0]!.sublabel).toBe('orphan') // the unit CODE, the thing an admin looks up
    expect(units.rows[0]!.region).toBe('Orphan Region')
    expect(units.rows[0]!.headcount).toBe(2)
    expect(units.rows[0]!.usd).toBe('26.000000')

    const orgs = wl('pooled-copilot')
    expect(orgs.rows).toHaveLength(2)
    expect(orgs.rows.every((x) => x.kind === 'provider-organisation')).toBe(true)
    expect(orgs.rows[0]!.label).toBe('KO Org (unhomed)')
    expect(orgs.rows[0]!.usd).toBe('29.000000')
    expect(orgs.rows[0]!.sublabel).toBe('KO Enterprise')
    // THE ENTERPRISE RESIDUAL NAMES ITSELF. The pooled arm's second row has no
    // provider organisation at all, so `label` is NULL out of SQL; the comment
    // above this assertion used to claim it "names itself rather than rendering
    // a blank cell" while asserting only its amount, which is exactly the shape
    // of assertion that certifies nothing.
    expect(orgs.rows[1]!.label).toBe('Enterprise residual (no organisation on the invoice)')
    expect(orgs.rows[1]!.sublabel).toBe('KO Enterprise')
    expect(orgs.rows[1]!.usd).toBe('8.000000')

    // Every list states what it shows AND what the bucket holds. Nothing is
    // truncated in MAY, so the shown money IS the bucket here — the truncated
    // case is the June test below, where that equality must NOT hold.
    for (const c of ['no-region', 'region-no-unit', 'no-cost-owning-ancestor', 'pooled-copilot'] as const) {
      const w = wl(c)
      expect(w.shown).toBeLessThanOrEqual(CAP)
      expect(w.shown).toBe(w.total)
      expect(w.bucketUsd).toBe(usd(r, c))
      expect(w.shownUsd).toBe(w.bucketUsd)
    }
  })

  /*
   * AC-3, the half MAY cannot express: "largest dollars first" must be a DOLLAR
   * sort.
   *
   * The projected column is `usd::numeric(14,6)::text`, and SQL resolves a bare
   * name in ORDER BY to the OUTPUT column before the input one — so
   * `ORDER BY cause, usd DESC` sorted the page as TEXT, where '9.000000' beats
   * '10.000000' and '99.000000' beats '115.000000'. Both live teammate causes
   * fell into it. June plants both shapes: a 5-row list under the cap where $9
   * and $8 would jump the queue, and a 25-row list across the 99/100 boundary
   * where the largest amount in the estate would drop off the visible page
   * entirely.
   */
  it('orders the drill by dollars, not by the text of the dollars', async () => {
    const r = await computeUnhomedCauses(t.db, KO_JUN_WINDOW, JUN)
    const wl = (c: UnhomedCause) => r.worklists.find((w) => w.cause === c)!

    // ALL THREE drilled causes, not just the two teammate ones. The unit list
    // ranks in its own `unit_ranked` CTE with its own ORDER BY, and it had a
    // single row in both months — so the identical text-vs-numeric defect was
    // invisible there while the teammate lists were pinned against it.
    for (const c of ['no-region', 'region-no-unit', 'no-cost-owning-ancestor'] as const) {
      const amounts = wl(c).rows.map((x) => Number(x.usd))
      expect(amounts.length).toBeGreaterThan(1)
      // STRICTLY descending, so an already-sorted-ascending list cannot pass and
      // neither can a stable order that merely happens to group equal values.
      for (let i = 1; i < amounts.length; i++) {
        expect(amounts[i - 1]!, `${c} row ${i - 1} vs ${i}`).toBeGreaterThan(amounts[i]!)
      }
    }

    /*
     * The UNIT list, named. $124 / $98 / $13 order three different ways — as
     * numeric(14,6) TEXT it is ['98', '13', '124'] and reversed it is
     * [13, 98, 124] — so the page below can only be produced by a numeric
     * descending sort, and both mutants land on a different page.
     */
    expect(wl('no-cost-owning-ancestor').rows.map((x) => x.usd)).toEqual([
      '124.000000', '98.000000', '13.000000',
    ])
    expect(wl('no-cost-owning-ancestor').rows.map((x) => x.sublabel)).toEqual([
      'inverted-parent', 'orphan-b', 'retired-child',
    ])

    // The two amounts a TEXT sort puts at the top of each list. Asserting the
    // head explicitly means the mutation is named, not just implied by ordering.
    expect(wl('region-no-unit').rows.map((x) => x.usd)).toEqual([
      '12.000000', '11.000000', '10.000000', '9.000000', '8.000000',
    ])
    expect(wl('no-region').rows[0]!.usd).toBe('115.000000')
    // …and under a text sort $115 is not merely mis-ranked, it is not on the
    // page at all: '99' > '98' > … > '96' > '115' puts it 6th from last of 25,
    // outside the top 20 the cap admits.
    expect(wl('no-region').rows.map((x) => x.usd)).not.toContain('95.000000')
    expect(wl('no-region').rows.at(-1)!.usd).toBe('96.000000')
  })

  /*
   * AC-3's other half: a truncated list must never read as the whole bucket.
   * June's no-region cause plants 25 people against a cap of 20, so every
   * relationship is a real inequality rather than the identity a fixture with
   * nothing to truncate produces.
   */
  it('caps the drill and discloses exactly what it is not showing', async () => {
    const r = await computeUnhomedCauses(t.db, KO_JUN_WINDOW, JUN)
    const w = r.worklists.find((x) => x.cause === 'no-region')!

    // The fixture genuinely overflows the cap — otherwise everything below is an
    // assertion about a list that was never truncated.
    expect(w.total).toBeGreaterThan(CAP)
    expect(w.total).toBe(25)
    expect(w.shown).toBe(CAP)
    expect(w.rows).toHaveLength(CAP)

    // MONEY: what is shown is strictly less than what is in the bucket…
    expect(Number(w.shownUsd)).toBeLessThan(Number(w.bucketUsd))
    // …and shownUsd is the hand-computed sum of the top 20 ($96..$115), not a
    // re-render of the bucket total.
    expect(w.shownUsd).toBe('2110.000000')
    expect(w.bucketUsd).toBe('2575.000000')
    expect(w.bucketUsd).toBe(usd(r, 'no-region'))
    // Σ(rows) === shownUsd, so the disclosure describes THESE rows.
    const summed = w.rows.reduce((acc, x) => acc + Math.round(Number(x.usd) * 1e6), 0)
    expect(summed).toBe(Math.round(Number(w.shownUsd) * 1e6))

    // A cause that fits is NOT reported as truncated.
    const fits = r.worklists.find((x) => x.cause === 'region-no-unit')!
    expect(fits.shown).toBe(fits.total)
    expect(fits.shownUsd).toBe(fits.bucketUsd)
  })

  /*
   * PB-5's second population. "$50 across 5 people" and "across 2 regions" are
   * different facts, and a count that reads the wrong column can satisfy both
   * when they happen to be equal — which is what May's single-person, single-
   * region bucket allowed. June makes them 5 and 2.
   */
  it('counts the people and the regions behind region-no-unit separately', async () => {
    const r = await computeUnhomedCauses(t.db, KO_JUN_WINDOW, JUN)
    const row = r.causes.find((x) => x.cause === 'region-no-unit')!
    expect(row.countKind).toBe('teammates')
    expect(row.count).toBe(5)
    expect(row.secondaryKind).toBe('regions')
    expect(row.secondaryCount).toBe(2) // APAC and EMEA holding nodes
    expect(row.secondaryCount).not.toBe(row.count)
  })

  /*
   * The `retired_at IS NULL` half of the ancestor mirror, which is the half data
   * can falsify.
   *
   * `v_finance_bill_chargeback`'s LATERAL homes a teammate on the nearest
   * ancestor that is cost-owning AND NOT RETIRED, so a person whose only
   * cost-owning ancestor has been retired is unhomed. The probe's mirror must
   * agree: drop `anc.retired_at IS NULL` from it and the NOT EXISTS goes false
   * for ivan, the CASE yields NULL, he lands in no bucket at all, and the
   * residual reports it. Un-retiring the ancestor is the other direction — the
   * money stops being unhomed anywhere, which is what makes this a REMEDIATION
   * the panel can honestly recommend.
   */
  it('lands a teammate whose only cost-owning ancestor is RETIRED in that bucket', async () => {
    const before = await computeUnhomedCauses(t.db, KO_JUN_WINDOW, JUN)
    expect(usd(before, 'no-cost-owning-ancestor')).toBe('235.000000')
    expect(before.reconciles).toBe(true)
    const w = before.worklists.find((x) => x.cause === 'no-cost-owning-ancestor')!
    const ivanRow = w.rows.find((x) => x.sublabel === 'retired-child')!
    expect(ivanRow.usd).toBe('13.000000')
    expect(ivanRow.headcount).toBe(1)
    expect(before.unhomedUsd).toBe('2860.000000')

    // The fix the panel names: un-retire the unit that carried the flag.
    await t.client`UPDATE org_unit SET retired_at = NULL WHERE code = 'retired-root'`
    try {
      const after = await computeUnhomedCauses(t.db, KO_JUN_WINDOW, JUN)
      // Not moved to a different bucket — GONE from the unhomed set entirely.
      // The bucket and the authoritative total each fall by exactly ivan's $13,
      // and his unit leaves the worklist while the other two stay.
      expect(usd(after, 'no-cost-owning-ancestor')).toBe('222.000000')
      expect(after.unhomedUsd).toBe('2847.000000')
      const afterRows = after.worklists.find((x) => x.cause === 'no-cost-owning-ancestor')!.rows
      expect(afterRows.map((x) => x.sublabel)).toEqual(['inverted-parent', 'orphan-b'])
      // …and the split still adds up, so the money left rather than leaking.
      expect(after.residualUsd).toBe('0.000000')
      expect(after.reconciles).toBe(true)
      // Chargeable is unchanged: this is a HOMING change, not a billing one.
      expect(after.chargeableUsd).toBe(before.chargeableUsd)
    } finally {
      await t.client`UPDATE org_unit SET retired_at = now() WHERE code = 'retired-root'`
    }

    // Guard the guard: a leaked restore would silently change every June figure.
    const restored = await computeUnhomedCauses(t.db, KO_JUN_WINDOW, JUN)
    expect(restored.unhomedUsd).toBe('2860.000000')
  })

  /*
   * THE ANCESTRY OPERATOR'S DIRECTION. `ou.path <@ anc.path` asks whether the
   * home node is a DESCENDANT of a cost-owning unit — the same question
   * `v_finance_bill_chargeback`'s LATERAL asks. `@>` asks the opposite and, on
   * every other planting, gives the identical answer: a root has no descendants
   * and a leaf has no cost-owning ancestor, so both forms return "no match".
   *
   * Nina's unit is not cost-owning and its CHILD is, which is the one shape where
   * the two disagree. She is genuinely unhomed (nothing ABOVE her is cost-owning,
   * so the view homes her nowhere), and the flipped operator finds the cost-owning
   * child, yields a NULL cause, and drops her $124 out of every bucket.
   */
  it('a cost-owning unit in ANOTHER region at a colliding path does not home or reclassify anyone', async () => {
    // org_unit.path is unique only per region (idor-data-drizzle-001). EMEA gets
    // a live cost-owning unit at oscar's exact path; his own region still has no
    // cost-owning ancestor, so he must stay in no-cost-owning-ancestor.
    await t.client`INSERT INTO org_unit (region_id, path, code, display_name, unit_type, is_cost_owning_unit)
      SELECT id, 'orphanb'::ltree, 'collider-orphanb', 'EMEA Collider', 'bu', true FROM region WHERE code = 'emea'`
    try {
      const r = await computeUnhomedCauses(t.db, KO_JUN_WINDOW, JUN)
      expect(usd(r, 'no-cost-owning-ancestor')).toBe('235.000000')
      expect(r.unhomedUsd).toBe('2860.000000')
      expect(r.residualUsd).toBe('0.000000')
      expect(r.reconciles).toBe(true)
      const rows = r.worklists.find((x) => x.cause === 'no-cost-owning-ancestor')!.rows
      expect(rows.map((x) => x.sublabel)).toContain('orphan-b')
    } finally {
      await t.client`DELETE FROM org_unit WHERE code = 'collider-orphanb'`
    }
  })

  it('reads ancestry upward: a cost-owning CHILD does not home a team', async () => {
    const r = await computeUnhomedCauses(t.db, KO_JUN_WINDOW, JUN)

    // The shape really is there: a cost-owning, ACTIVE child under nina's unit.
    const [{ n: costOwningChildren }] = await t.client<{ n: string }[]>`
      SELECT COUNT(*)::text AS n FROM org_unit child
      JOIN org_unit parent ON parent.id = child.parent_id
      WHERE parent.code = 'inverted-parent'
        AND child.is_cost_owning_unit AND child.retired_at IS NULL`
    expect(Number(costOwningChildren)).toBe(1)

    // …and nina is unhomed DESPITE it, in the bucket, with her money accounted.
    const row = r.worklists
      .find((x) => x.cause === 'no-cost-owning-ancestor')!
      .rows.find((x) => x.sublabel === 'inverted-parent')!
    expect(row.usd).toBe('124.000000')
    expect(row.headcount).toBe(1)
    expect(r.residualUsd).toBe('0.000000')
  })

  /*
   * THE UNHOMED-ONLY FILTER, which nothing could falsify before.
   *
   * Drop `b.cost_owning_unit_id IS NULL` from the teammate arm and every HOMED
   * row joins it too. Almost all of them fall out as a NULL cause (a homed
   * teammate is in a real region on a real unit with a cost-owning ancestor), so
   * the mutation changed no number — until a homed teammate sits on a HOLDING
   * node. Pia does: her holding node hangs under APAC's cost-owning root, so her
   * $77 reaches a cost centre and `region-no-unit` must not claim a cent of it.
   */
  it('never buckets money that already reached a cost-owning unit', async () => {
    // Pia is on a holding node AND homed — both halves, from the database.
    const [{ unit_type: unitType, homed }] = await t.client<{ unit_type: string; homed: string }[]>`
      SELECT ou.unit_type,
             (SELECT COUNT(*)::text FROM v_finance_bill_chargeback b
               WHERE b.teammate_id = tm.id AND b.cost_owning_unit_id IS NOT NULL) AS homed
      FROM teammate tm JOIN org_unit ou ON ou.id = tm.org_unit_id
      WHERE tm.email = 'pia@ko.test'`
    expect(unitType).toBe('holding')
    expect(Number(homed)).toBe(1)

    const r = await computeUnhomedCauses(t.db, KO_JUN_WINDOW, JUN)
    // The holding-node bucket holds the FIVE genuinely-unhomed people only…
    expect(usd(r, 'region-no-unit')).toBe('50.000000')
    expect(r.causes.find((c) => c.cause === 'region-no-unit')!.count).toBe(5)
    // …and pia is nowhere in its worklist.
    expect(
      r.worklists.find((w) => w.cause === 'region-no-unit')!.rows.map((x) => x.sublabel),
    ).not.toContain('pia@ko.test')
    expect(r.residualUsd).toBe('0.000000')
  })

  /*
   * The POOLED arm's own homing filter. May's allocation is the UNALLOCATED
   * bucket (a NULL cost-owning unit), so `coa.cost_owning_unit_id IS NULL` was
   * true for every row the arm could see and dropping it changed nothing. June
   * carries the other kind: paid pooled overage that DID reach a cost-owning
   * unit. It is chargeable, it is homed, and the pooled bucket must stay empty.
   */
  it('keeps a HOMED overage allocation out of the pooled bucket', async () => {
    const [{ n: homedAllocations }] = await t.client<{ n: string }[]>`
      SELECT COUNT(*)::text AS n FROM copilot_overage_allocation
      WHERE month = '2026-06-01'::date AND cost_owning_unit_id IS NOT NULL`
    expect(Number(homedAllocations)).toBe(1)

    const r = await computeUnhomedCauses(t.db, KO_JUN_WINDOW, JUN)
    expect(usd(r, 'pooled-copilot')).toBe('0.000000')
    expect(r.worklists.find((w) => w.cause === 'pooled-copilot')!.rows).toHaveLength(0)
    // The $21 IS in the month's chargeable total — it is homed money, not money
    // the probe failed to see — so the residual stays closed.
    expect(r.residualUsd).toBe('0.000000')
    expect(r.reconciles).toBe(true)
  })

  /*
   * AC-4: 0-of-5 and 0-of-0 must not read alike, and neither may be confused
   * with "we could not look". This fixture is the LIVE INSTANCE'S condition —
   * cost-owning units exist and NONE carries a directory cost-centre code, which
   * is why automatic placement can never have fired.
   *
   * Each of these zeros is a MEASUREMENT over rows that exist, not the reading of
   * an empty table: the fixture carries a RETIRED cost-owning unit (so the
   * denominator's `retired_at IS NULL` has something to exclude), a REVOKED
   * cou_owner on a live unit, and a LIVE cou_owner on that retired unit. Drop any
   * one of the three filters and one of these counters reads 1 instead of 0.
   */
  it('counts the placement configuration, distinguishing 0-of-5 from 0-of-0', async () => {
    const r = await computeUnhomedCauses(t.db, KO_MAY_WINDOW, MAY)
    expect(r.placementConfig).not.toBeNull()

    // The rows the filters must exclude really are there.
    const [{ n: retiredCou }] = await t.client<{ n: string }[]>`
      SELECT COUNT(*)::text AS n FROM org_unit
      WHERE is_cost_owning_unit AND retired_at IS NOT NULL`
    const [{ n: revokedOwners }] = await t.client<{ n: string }[]>`
      SELECT COUNT(*)::text AS n FROM cou_owner WHERE revoked_at IS NOT NULL`
    const [{ n: ownersOnRetired }] = await t.client<{ n: string }[]>`
      SELECT COUNT(*)::text AS n FROM cou_owner co JOIN org_unit ou ON ou.id = co.org_unit_id
      WHERE co.revoked_at IS NULL AND ou.retired_at IS NOT NULL`
    expect(Number(retiredCou)).toBe(1)
    expect(Number(revokedOwners)).toBe(1)
    expect(Number(ownersOnRetired)).toBe(1)

    // 6 ACTIVE cost-owning units — the seventh is retired and must not be counted.
    expect(r.placementConfig!.activeCostOwningUnits).toBe(6)
    expect(r.placementConfig!.unitsWithCostCentreCode).toBe(0)
    // 0 ACTIVE owners, with two cou_owner rows in the table: one revoked, one on
    // the retired unit.
    expect(r.placementConfig!.activeOwners).toBe(0)
    expect(r.placementConfig!.unitsWithActiveOwner).toBe(0)
    expect(r.placementConfig!.ownersWithDirectoryIdentity).toBe(0)
  })

  /*
   * …and the counters are COMPUTED, not two constants that happen to match the
   * fixture. Configure placement and both must move; the directory-identity
   * sub-count must separate an owner who can drive the manager-chain path from a
   * placeholder who cannot — and there are TWO kinds of placeholder, `bill:` and
   * `provisional:`. Only the first was planted, so the `provisional:` half of
   * that exclusion could be deleted with every number unchanged.
   */
  it('moves both counters when placement is actually configured', async () => {
    await t.client`UPDATE org_unit SET cost_centre_code = 'CC-KO-1' WHERE code = 'apac-cto'`
    await t.client`INSERT INTO cou_owner (org_unit_id, teammate_id)
      SELECT (SELECT id FROM org_unit WHERE code='apac-cto'), ${ids.alice}::uuid`
    // A bill placeholder owning a DIFFERENT unit: counted for accountability,
    // but it can never appear in anyone's manager chain.
    await t.client`INSERT INTO teammate (entra_oid, email, display_name, region_id, org_unit_id, is_active)
      VALUES ('bill:00000000-0000-0000-0000-0000000000ff', 'placeholder@ko.test', 'Bill Placeholder',
              ${ids.regionApac}::uuid, ${ids.uApacDelivery}::uuid, true)`
    await t.client`INSERT INTO cou_owner (org_unit_id, teammate_id)
      SELECT ${ids.uApacDelivery}::uuid, id FROM teammate WHERE email='placeholder@ko.test'`
    // …and the OTHER placeholder shape, on the same unit. Same argument, same
    // consequence: no directory identity, so no manager chain can reach it.
    await t.client`INSERT INTO teammate (entra_oid, email, display_name, region_id, org_unit_id, is_active)
      VALUES ('provisional:00000000-0000-0000-0000-0000000000fe', 'provisional@ko.test',
              'Provisional Owner', ${ids.regionApac}::uuid, ${ids.uApacDelivery}::uuid, true)`
    await t.client`INSERT INTO cou_owner (org_unit_id, teammate_id)
      SELECT ${ids.uApacDelivery}::uuid, id FROM teammate WHERE email='provisional@ko.test'`
    try {
      const r = await computeUnhomedCauses(t.db, KO_MAY_WINDOW, MAY)
      expect(r.placementConfig!.activeCostOwningUnits).toBe(6)
      expect(r.placementConfig!.unitsWithCostCentreCode).toBe(1)
      // THREE active owners across two units — alice plus both placeholders…
      expect(r.placementConfig!.activeOwners).toBe(3)
      expect(r.placementConfig!.unitsWithActiveOwner).toBe(2)
      // …and exactly ONE of them carries a directory identity. Drop either
      // placeholder prefix from the exclusion and this reads 2.
      expect(r.placementConfig!.ownersWithDirectoryIdentity).toBe(1)
    } finally {
      // TARGETED cleanup. A bare `DELETE FROM cou_owner` also removed the seeded
      // revoked / retired-unit owners, which are what make the 0s above a
      // measurement — and it left every later test in this file reading a table
      // this one had emptied.
      await t.client`DELETE FROM cou_owner co
        USING teammate t WHERE t.id = co.teammate_id
          AND t.email IN ('alice@ko.test', 'placeholder@ko.test', 'provisional@ko.test')`
      await t.client`DELETE FROM teammate WHERE email IN ('placeholder@ko.test', 'provisional@ko.test')`
      await t.client`UPDATE org_unit SET cost_centre_code = NULL WHERE code = 'apac-cto'`
    }

    // Guard the guard: the seeded owners survived the cleanup, so the counters
    // are back to the measured zeros the previous test pins.
    const after = await computeUnhomedCauses(t.db, KO_MAY_WINDOW, MAY)
    expect(after.placementConfig!.activeOwners).toBe(0)
    expect(after.placementConfig!.unitsWithCostCentreCode).toBe(0)
    const [{ n: remaining }] = await t.client<{ n: string }[]>`SELECT COUNT(*)::text AS n FROM cou_owner`
    expect(Number(remaining)).toBe(2)
  })

  /*
   * `estateFirstMonth` reads the EARLIER of two billed sources, and both arms
   * must be live. `actual_spend` is the earlier one on this fixture (2026-01), so
   * that arm is pinned by the history test's `no-spend` months; the Copilot arm
   * was not pinned at all — delete it and every figure stayed identical, while a
   * COPILOT-ONLY estate (no actual_spend at all) would have reported every month
   * "Not measured — before this estate carried any billed data".
   */
  it('reads estateFirstMonth from the earlier of BOTH billed sources', async () => {
    const before = await computeUnhomedCauses(t.db, KO_MAY_WINDOW, MAY)
    expect(before.estateFirstMonth).toBe('2026-01') // the actual_spend arm wins today
    expect(before.history.find((h) => h.month === '2025-12')!.state).toBe('not-measured')

    // A pooled invoice EARLIER than any actual_spend row. Nothing else in this
    // window changes: the row is outside every asserted window and bills $0.
    await t.client`INSERT INTO copilot_pool_bill
        (month, provider_enterprise_id, provider_org_id, cost_owning_unit_id, seats,
         license_net_usd, overage_net_usd, included_allowance_usd, usage_gross_usd)
      VALUES ('2025-09-01'::date,
              (SELECT id FROM provider_enterprise WHERE external_id='ko-ent'),
              NULL, NULL, 0, 0, 0, 0, 0)`
    try {
      const after = await computeUnhomedCauses(t.db, KO_MAY_WINDOW, MAY)
      expect(after.estateFirstMonth).toBe('2025-09')
      // …and the consequence on screen: December stops reading "not measured"
      // and starts reading "billed nothing", which is a different fact.
      expect(after.history.find((h) => h.month === '2025-12')!.state).toBe('no-spend')
      // The May money is untouched — this changed what we know we measured, not
      // what was measured.
      expect(after.unhomedUsd).toBe(before.unhomedUsd)
    } finally {
      await t.client`DELETE FROM copilot_pool_bill WHERE month = '2025-09-01'::date`
    }

    const restored = await computeUnhomedCauses(t.db, KO_MAY_WINDOW, MAY)
    expect(restored.estateFirstMonth).toBe('2026-01')
  })

  /*
   * AC-6/AC-7/AC-8: the history answers "is this getting worse" on screen, and a
   * zero that means "none" and a zero that means "we were not measuring yet"
   * must not render alike. All three states appear in one series here.
   */
  it('renders six months with three distinguishable states and their close state', async () => {
    const r = await computeUnhomedCauses(t.db, KO_MAY_WINDOW, MAY)
    const h = r.history
    expect(h).toHaveLength(6)
    // Newest first, ending at the SELECTED month so the trend is anchored on
    // what the operator is looking at.
    expect(h.map((x) => x.month)).toEqual([
      '2026-05', '2026-04', '2026-03', '2026-02', '2026-01', '2025-12',
    ])
    expect(h.filter((x) => x.selected).map((x) => x.month)).toEqual([MAY])

    // May: real spend, so the ratio means something.
    expect(h[0]!.state).toBe('measured')
    expect(h[0]!.unhomedUsd).toBe(r.unhomedUsd)
    expect(h[0]!.chargeableUsd).toBe(r.chargeableUsd)
    /*
     * THE SHARE IS A PERCENTAGE. The whole trend is read from this number, and
     * `> 0` passes for a fraction (0.098), for a percentage (9.80) and for
     * anything a factor of 100 out in either direction — so it is pinned to the
     * value $143 of $1459 actually produces, at six decimals.
     */
    expect(h[0]!.sharePct).toBeCloseTo((143 / 1459) * 100, 6)
    expect(h[0]!.sharePct).toBeCloseTo(9.801234, 6)

    // The estate has data from January (an exempt row), so Jan/Feb/Apr billed
    // NOTHING — "no chargeable spend", never "$0.00 unhomed (0%)". March is a
    // different thing entirely and has its own test below.
    expect(r.estateFirstMonth).toBe('2026-01')
    for (const m of ['2026-04', '2026-02', '2026-01']) {
      const row = h.find((x) => x.month === m)!
      expect(row.state).toBe('no-spend')
      expect(row.sharePct).toBeNull()
      expect(row.unhomedUsd).toBeNull()
    }

    // December 2025 predates any billed data at all — a DIFFERENT zero.
    expect(h[5]!.state).toBe('not-measured')
    expect(h[5]!.sharePct).toBeNull()

    // Recorded: a stored snapshot says recorded; ABSENCE says not-recorded,
    // never an em-dash. There is no open/closed axis any more — recording a
    // month captures what it read, it does not lock it.
    expect(h.find((x) => x.month === '2026-04')!.recorded).toBe(true)
    expect(h.find((x) => x.month === '2026-05')!.recorded).toBe(false)
    expect(h.find((x) => x.month === '2026-03')!.recorded).toBe(false)
  })

  /*
   * A MONTH THAT NETS TO $0.00 CHARGEABLE IS NOT AN EMPTY MONTH.
   *
   * Chargeable spend is a signed sum, so a credit note nets March to exactly
   * $0.00 with $60 of unhomed money inside it. Gated on chargeable alone — which
   * is what this code did, while the identical defect was being fixed at the
   * panel — the trend renders "No chargeable spend in this month" directly
   * beneath a headline showing that money. The state must be `measured`, both
   * figures must be there, and the SHARE must be null: a divisor of zero makes it
   * undefined, which is a third thing from 0% and from Infinity%.
   */
  it('never calls a credit-netted month empty while it still holds unhomed money', async () => {
    const r = await computeUnhomedCauses(t.db, KO_MAY_WINDOW, MAY)
    const march = r.history.find((x) => x.month === '2026-03')!

    expect(march.state).not.toBe('no-spend')
    expect(march.state).toBe('measured')
    expect(march.unhomedUsd).toBe('60.000000')
    expect(march.chargeableUsd).toBe('0.000000')
    expect(march.sharePct).toBeNull()

    // The month really does net to zero over rows that exist, rather than being
    // an empty month the assertions above would read the same way.
    const [{ rows: marchRows, net }] = await t.client<{ rows: string; net: string }[]>`
      SELECT COUNT(*)::text AS rows, COALESCE(SUM(charge_usd), 0)::text AS net
      FROM v_finance_chargeback_month WHERE period_month = '2026-03-01'::date`
    expect(Number(marchRows)).toBe(2)
    expect(Number(net)).toBe(0)
  })

  /*
   * THE TREND'S WINDOW, which no assertion reached: every dollar in this estate
   * sat in an ANCHOR month, so a history recomputed over the probe's own window
   * — or anchored one month out — produced the same six rows.
   *
   * March is the only money that is never the anchor, and May's is real money in
   * a non-anchor month of the JUNE series. Both must appear, with their own
   * figures, in a series anchored somewhere else.
   */
  it('carries money from months other than the anchor', async () => {
    const jun = await computeUnhomedCauses(t.db, KO_JUN_WINDOW, JUN)
    expect(jun.history.map((x) => x.month)).toEqual([
      '2026-06', '2026-05', '2026-04', '2026-03', '2026-02', '2026-01',
    ])

    // MAY, seen from JUNE: the same figures the May window computes for itself,
    // with a real share — not the anchor, and not empty.
    const mayRow = jun.history.find((x) => x.month === '2026-05')!
    expect(mayRow.selected).toBe(false)
    expect(mayRow.state).toBe('measured')
    expect(mayRow.unhomedUsd).toBe('143.000000')
    expect(mayRow.chargeableUsd).toBe('1459.000000')
    expect(mayRow.sharePct).toBeCloseTo((143 / 1459) * 100, 6)

    // …and March's credit-netted $60 is in this series too, two months from the
    // anchor in one direction and three in the other.
    expect(jun.history.find((x) => x.month === '2026-03')!.unhomedUsd).toBe('60.000000')
  })

  /*
   * `partial` says "this month has not finished, so its figures are partial by
   * definition" — the caveat that stops an operator reading a half-month as a
   * fall. It is decided against the INJECTED clock, and every other test in this
   * file inherits the wall clock, under which 2026-05 is long past and the flag
   * is never true. Both branches are pinned from one series here.
   */
  it('marks only the months that have not finished as partial', async () => {
    const midMay = await computeUnhomedCauses(
      t.db, KO_MAY_WINDOW, MAY, new Date('2026-05-15T12:00:00.000Z'),
    )
    expect(midMay.history.find((x) => x.month === '2026-05')!.partial).toBe(true)
    // …and only that one: a completed month is not partial merely because the
    // series it sits in ends on an unfinished one.
    expect(midMay.history.filter((x) => x.partial).map((x) => x.month)).toEqual(['2026-05'])

    const afterMay = await computeUnhomedCauses(
      t.db, KO_MAY_WINDOW, MAY, new Date('2026-07-01T00:00:00.000Z'),
    )
    expect(afterMay.history.some((x) => x.partial)).toBe(false)
  })

  /*
   * CONTAINMENT, inside a TRANSACTION — the shape every caller actually runs in
   * (`withRequestRls` wraps the whole request in one).
   *
   * A failed statement ABORTS a PostgreSQL transaction: everything after it
   * returns "current transaction is aborted" until the transaction ends. So the
   * module's `catch { return null }` blocks read like contained failures and were
   * not — the catch swallowed the error and the NEXT read died anyway, taking the
   * money with it. The tests never saw it because they call this module with a
   * plain pooled handle, where each statement is its own implicit transaction and
   * nothing is ever poisoned. This one runs inside a real transaction so the
   * savepoints are load-bearing.
   *
   * `cou_owner` is read ONLY by the counters and `reporting_snapshot` ONLY by the
   * trend's close state — neither is touched by any view the money comes from —
   * so each failure has exactly one honest consequence.
   */
  it('contains a failed sub-read to its own section, inside a transaction', async () => {
    await t.client.unsafe('ALTER TABLE cou_owner RENAME TO cou_owner_hidden')
    await t.client.unsafe('ALTER TABLE reporting_snapshot RENAME TO reporting_snapshot_hidden')
    try {
      const r = await t.db.transaction(async (tx) =>
        computeUnhomedCauses(tx, KO_MAY_WINDOW, MAY),
      )

      // The two sections that could not be read say NOTHING, rather than 0.
      expect(r.placementConfig).toBeNull()
      expect(r.history.map((h) => h.recorded)).toEqual([null, null, null, null, null, null])

      // …and everything else is untouched: the money, the split, the drill and
      // the trend's own figures all still read exactly as they do above.
      expect(r.unhomedUsd).toBe('143.000000')
      expect(r.chargeableUsd).toBe('1459.000000')
      expect(r.residualUsd).toBe('0.000000')
      expect(r.reconciles).toBe(true)
      expect(usd(r, 'pooled-copilot')).toBe('37.000000')
      expect(r.worklists.find((w) => w.cause === 'no-region')!.rows).toHaveLength(1)
      expect(r.history).toHaveLength(6)
      expect(r.history[0]!.unhomedUsd).toBe('143.000000')
      // The estate-first-month read comes AFTER the counters, so it is the one a
      // poisoned transaction takes down first — its state proves the rollback
      // actually happened rather than the failure merely being swallowed.
      expect(r.estateFirstMonth).toBe('2026-01')
    } finally {
      await t.client.unsafe('ALTER TABLE cou_owner_hidden RENAME TO cou_owner')
      await t.client.unsafe('ALTER TABLE reporting_snapshot_hidden RENAME TO reporting_snapshot')
    }

    // Guard the guard: both renames were undone.
    const healed = await computeUnhomedCauses(t.db, KO_MAY_WINDOW, MAY)
    expect(healed.placementConfig).not.toBeNull()
    expect(healed.history.find((h) => h.month === '2026-04')!.recorded).toBe(true)
  })

  /*
   * ── NEGATIVE HALF 1 ───────────────────────────────────────────────────────
   * A window whose two grains disagree. The authoritative total is month-grained
   * (`period_month`) and the per-teammate arm is day-grained (`period_date`), so
   * a window that splits a month compares two different sets. The probe MUST
   * report that as a non-zero residual and refuse to present the split, rather
   * than returning four plausible numbers that do not add up. (The endpoint only
   * ever passes month-aligned windows — this proves what happens if that
   * constraint is ever lost, which is exactly the class of change the residual
   * exists to catch.)
   */
  it('refuses the split when the window makes the total and the buckets disagree', async () => {
    // The single day all three unhomed teammates' spend sits on. Deliberately
    // NOT the shared KO_MAY_PARTIAL_WINDOW: that window holds only HOMED days,
    // so every bucket AND the total are zero there and the residual closes —
    // the assertion would have passed without measuring anything.
    const oneDay = { startIso: '2026-05-21T00:00:00.000Z', endIso: '2026-05-22T00:00:00.000Z' }
    const r = await computeUnhomedCauses(t.db, oneDay, MAY)

    // The month-grained total sees nothing (2026-05-01 is outside the window)…
    expect(r.unhomedUsd).toBe('0.000000')
    // …while the day-grained buckets see frank $46 + grace $34 + heidi $9.
    expect(usd(r, 'no-region')).toBe('46.000000')
    expect(usd(r, 'region-no-unit')).toBe('34.000000')
    expect(usd(r, 'no-cost-owning-ancestor')).toBe('9.000000')
    // So the residual reports the disagreement instead of the split lying.
    expect(r.residualUsd).toBe('-89.000000')
    expect(r.reconciles).toBe(false)
  })

  /*
   * ── NEGATIVE HALF 2 ───────────────────────────────────────────────────────
   * The change the residual actually guards: a NEW ARM appears in the §B month
   * view (a second pooled provider, say). Its money is in the authoritative
   * total and in none of the four buckets, so it must land in the residual and
   * trip the suppression — NOT be absorbed by a bucket and NOT be silently
   * dropped from the total.
   *
   * This is a schema-level mutation rather than a code one, and it is the honest
   * one: no fixture ROW can escape all four buckets (see KNOWN SURVIVOR in the
   * header), so simulating the future shape is the only way to make this fire
   * from outside the module. The view definition is captured and restored, and
   * the final assertion proves the restore worked — a leaked mutation would
   * silently change every assertion above.
   */
  it('lands an unclassifiable §B arm in the residual and suppresses the split', async () => {
    const [{ def }] = await t.client<{ def: string }[]>`
      SELECT pg_get_viewdef('v_finance_chargeback_month'::regclass, true) AS def`
    const body = def.trim().replace(/;\s*$/, '')
    try {
      await t.client.unsafe(`
        CREATE OR REPLACE VIEW v_finance_chargeback_month AS
        ${body}
        UNION ALL
        SELECT NULL::uuid, NULL::uuid, 'claude-code'::text, '2026-05-01'::date, 61::numeric`)
      await t.client.unsafe(`ALTER VIEW v_finance_chargeback_month SET (security_invoker = true)`)

      const broken = await computeUnhomedCauses(t.db, KO_MAY_WINDOW, MAY)
      // The total grew by the unclassifiable arm…
      expect(broken.unhomedUsd).toBe('204.000000')
      // …no bucket claimed it (each is a positive predicate, not a remainder)…
      expect(usd(broken, 'no-region')).toBe('46.000000')
      expect(usd(broken, 'region-no-unit')).toBe('34.000000')
      expect(usd(broken, 'no-cost-owning-ancestor')).toBe('26.000000')
      expect(usd(broken, 'pooled-copilot')).toBe('37.000000')
      // …so it is the residual that reports it, and the split is suppressed.
      expect(broken.residualUsd).toBe('61.000000')
      expect(broken.reconciles).toBe(false)
    } finally {
      await t.client.unsafe(`CREATE OR REPLACE VIEW v_finance_chargeback_month AS ${body}`)
      await t.client.unsafe(`ALTER VIEW v_finance_chargeback_month SET (security_invoker = true)`)
    }

    // Guard the guard: if the restore had failed, this suite's other assertions
    // would be measuring a mutated view.
    const restored = await computeUnhomedCauses(t.db, KO_MAY_WINDOW, MAY)
    expect(restored.unhomedUsd).toBe('143.000000')
    expect(restored.residualUsd).toBe('0.000000')
    expect(restored.reconciles).toBe(true)
  })
})
