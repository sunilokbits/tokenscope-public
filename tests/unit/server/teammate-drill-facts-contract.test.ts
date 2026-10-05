// @vitest-environment node
/*
 * TEAMMATE-DRILL-FACTS CONTRACT — a STATIC test, in the spirit of
 * `tests/unit/server/reports-lane-firewall.test.ts` (which greps the same
 * `server/reporting/**` roots for banned tables).
 *
 * ── WHAT DEFECT THIS EXISTS TO STOP ─────────────────────────────────────────
 * `teammateDrillAdmission` (shared/auth/report-visibility.ts) needs two facts
 * about the TEAMMATE ROW that no client can infer from a figure: `is_active` and
 * `provisional`. Every server producer of a teammate-named row must carry them,
 * and every client renderer of a teammate name must pass them.
 *
 * Three review rounds each found ANOTHER producer that did not:
 *
 *   r3-H2  the drivers axes            (engine/drivers.ts, cost-centres.ts)
 *   r4-H2  the project reports depth   (project-depth.ts)
 *   r5-H1  the regional signals strip  (regional.ts fetchRegionalExceptions)
 *          + the cost-centre soft-cap card (engine/over-soft-cap.ts)
 *          + the finance overage drivers (finance.ts fetchOverageDrivers)
 *
 * The omission is SILENT and it fails OPEN. A missing fact reaches the client as
 * `undefined`; `undefined === 'true'` is `false`; `isProvisional: false` ADMITS
 * the drill. So an unauthenticated SHADOW identity (mig 0057 — an email claim
 * nobody has verified) rendered as a live link on an audited governance surface,
 * onto a page that 403s.
 *
 * Fixing the instances did not stop the class, because "did this producer
 * remember?" was a per-query judgement nothing could check. This test makes it
 * checkable.
 *
 * ── HOW IT IS CHECKED, AND WHY IT IS AN ENUMERATION ─────────────────────────
 * A fully general grep is NOT reliable here — a producer is a SQL template
 * literal inside a function, and "does this SELECT name a person" is not
 * decidable by regex. So the known-good sites are ENUMERATED with a declared
 * disposition and a PINNED COUNT of the two markers each file carries. That
 * buys the property that matters:
 *
 *   - a NEW FILE that names a teammate fails (it is not in the map);
 *   - a NEW QUERY in an enumerated file fails (the name count moves while the
 *     facts count does not);
 *   - a HAND-ROLLED fact column fails anywhere (rule 2 below).
 *
 * The cost is that reformatting an existing query also fails. That is
 * deliberate: the failure message below tells you which case you are in and
 * exactly what to do, and these queries change rarely.
 *
 * ── WHAT A FAILURE MEANS AND HOW TO FIX IT ──────────────────────────────────
 *   "unenumerated producer"  → you added a file that names a teammate in SQL.
 *       Carry the facts with `TEAMMATE_DRILL_FACTS` / `TEAMMATE_DRILL_FACTS_AGG`
 *       from `server/reporting/teammate-drill-facts.ts`, read them back with
 *       `teammateDrillFacts` / `foldTeammateDrillFacts`, put them on the wire
 *       (`teammateDrillDims` for a `DriverRow`, explicit fields otherwise), and
 *       add the file here with `disposition: 'shared-facts'`.
 *   "marker count moved"     → if you only reformatted, update the count. If you
 *       ADDED a teammate-naming query, do the above FIRST, then update both.
 *   "hand-rolled fact"       → replace `bool_or(COALESCE(t.is_active, ...))` and
 *       friends with the shared fragment. That per-query column list is the exact
 *       mechanism by which three rounds of this defect shipped.
 *   "client call site"       → every `teammateDrillTarget(...)` must pass BOTH
 *       `isActive` and `isProvisional`, and (unless the SERVER already made the
 *       whole admission decision) neither may be a hard-coded literal.
 *
 * Comments are stripped before scanning, so a doc-comment MENTIONING a marker
 * (like this file's own, or a query module's header) is never a false positive.
 */
import { describe, it, expect } from 'vitest'
import { readdirSync, readFileSync, statSync } from 'node:fs'
import { join, dirname, relative, sep } from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..', '..')

/* ── scanning primitives ───────────────────────────────────────────────────── */

interface ScannedFile {
  /** Repo-relative, POSIX-separated — the key the maps below are written in. */
  path: string
  /** Source with comments stripped. */
  code: string
}

function walk(dir: string, exts: readonly string[]): string[] {
  const out: string[] = []
  for (const name of readdirSync(dir)) {
    const full = join(dir, name)
    if (statSync(full).isDirectory()) out.push(...walk(full, exts))
    else if (exts.some((e) => full.endsWith(e))) out.push(full)
  }
  return out
}

/** Strip block + line comments (line-comment strip skips `https://` URLs). */
function stripComments(src: string): string {
  return src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:])\/\/.*$/gm, '$1')
}

/**
 * `--` SQL comments too: the fact fragments are referenced from inside `sql`
 * template literals whose comments are SQL-style, and a `-- see t.provisional`
 * note must not read as a hand-rolled column.
 */
function stripSqlComments(src: string): string {
  return src.replace(/^\s*--.*$/gm, '')
}

function scan(roots: readonly string[], exts: readonly string[]): ScannedFile[] {
  return roots
    .flatMap((r) => walk(join(ROOT, r), exts))
    .map((full) => ({
      path: relative(ROOT, full).split(sep).join('/'),
      code: stripSqlComments(stripComments(readFileSync(full, 'utf8'))),
    }))
    .sort((a, b) => a.path.localeCompare(b.path))
}

const countOf = (code: string, re: RegExp): number => (code.match(re) ?? []).length

/* ── SERVER: the producers ─────────────────────────────────────────────────── */

/** A SQL SELECT naming a person off the `teammate` relation (aliased `t`, always). */
const TEAMMATE_NAME_RE = /\bt\.display_name\b/g
/** An interpolation of one of the two shared fact fragments. */
const SHARED_FACTS_RE = /\$\{TEAMMATE_DRILL_FACTS(?:_AGG)?\}/g
/** A HAND-ROLLED fact column — the thing this contract exists to abolish. */
const HAND_ROLLED_FACT_RE = /\bt\.(?:is_active|provisional)\b/g

type Disposition =
  /** Produces teammate-named rows that a drill renderer consumes; carries the shared facts. */
  | 'shared-facts'
  /** Not a row producer — this IS the drill destination's own identity header. */
  | 'drill-target'
  /** Produces teammate-named rows that carry NO facts, and is therefore plain text ALWAYS. */
  | 'plain-text-only'

interface ProducerSpec {
  disposition: Disposition
  /** Occurrences of `t.display_name` (SELECT list + GROUP BY + ORDER BY alike). */
  names: number
  /** Interpolations of a shared fact fragment. */
  facts: number
  /** Direct `t.is_active` / `t.provisional` references that are NOT drill facts. */
  handRolled?: number
  why: string
}

/**
 * EVERY file under `server/reporting/**` + `server/api/v1/reports/**` that names
 * a teammate in SQL. A file absent from this map fails the first test.
 */
const SERVER_PRODUCERS: Record<string, ProducerSpec> = {
  'server/reporting/engine/drivers.ts': {
    disposition: 'shared-facts',
    names: 2,
    facts: 1,
    why: 'The §A teammate driver axis. Rows STAY (the axis foots to the scope KPI) and the DOOR closes via dims.',
  },
  'server/reporting/cost-centres.ts': {
    disposition: 'shared-facts',
    names: 2,
    facts: 1,
    why: "The cost-centre teammate axis. Same decomposition argument: foots to burnUsd, so the row stays and the name stops being a door.",
  },
  'server/reporting/project-depth.ts': {
    disposition: 'shared-facts',
    names: 3,
    facts: 1,
    why: 'The project reports depth. It goes further than the others — an unconfirmed identity is never NAMED here, it folds into the remainder, so the rows still foot.',
  },
  'server/reporting/project-chargeback.ts': {
    disposition: 'shared-facts',
    names: 4,
    facts: 1,
    why: "The project depth's chargeback lens. Its contributor rows go through the same splitProjectContribution as project-depth.ts, so an unconfirmed identity folds into the remainder and can_drill is the server's verdict.",
  },
  'server/reporting/regional.ts': {
    disposition: 'shared-facts',
    names: 1,
    facts: 1,
    why: 'fetchRegionalExceptions — the velocity signals strip (r5-H1). A top-N callout that foots to nothing, so the row stays and only the link closes.',
  },
  'server/reporting/engine/over-soft-cap.ts': {
    disposition: 'shared-facts',
    names: 1,
    facts: 1,
    handRolled: 1,
    why: "The cost-centre soft-cap card (r5-H1). The one permitted direct `t.is_active` is the roster POPULATION filter (WHERE t.is_active = TRUE), which is not a drill fact — the drill facts still come from the shared fragment beside it.",
  },
  'server/reporting/finance.ts': {
    disposition: 'shared-facts',
    names: 4,
    facts: 1,
    why: 'fetchOverageDrivers carries the shared facts (r5-H1). fetchAnthropicCharges names people too but FinanceDrill.vue renders that table as plain text — it has no DrillName and no target; if that ever becomes a link it must carry facts, and this count is what forces the conversation.',
  },
  'server/reporting/teammate.ts': {
    disposition: 'drill-target',
    names: 1,
    facts: 0,
    handRolled: 2,
    why: 'fetchTeammateIdentity is the DESTINATION page\'s own identity header, not a row in a list. It reads t.is_active / t.provisional directly and returns them as isActive / isProvisional for the endpoint\'s OWN 403 — there is no link to close here.',
  },
  'server/reporting/engine/billed-axis.ts': {
    disposition: 'plain-text-only',
    names: 2,
    facts: 0,
    why: 'The §B billed teammate axis emits NO dims at all, so every consumer reads teammate_active as undefined and renders plain text. Fail-CLOSED, and pinned here so a future dims addition cannot quietly open the door without carrying the facts.',
  },
}

/* ── CLIENT: the renderers ─────────────────────────────────────────────────── */

const DRILL_CALL_RE = /teammateDrillTarget\s*\(/g
/** The ONE module allowed to build the drill URL — everything else routes through it. */
const DRILL_CONTRACT_MODULE = 'app/components/reporting/drill-contract.ts'
const TEAMMATE_URL_RE = /\/reporting\/teammate\//g

interface CallSiteSpec {
  /**
   * `'row'`          — both facts are read off the server-carried row; a literal
   *                    is a bug, so literals are rejected.
   * `'server-ruled'` — the SERVER already ran the whole admission rule for this
   *                    frame and shipped the verdict, so a literal is a restated
   *                    fact. Must also carry `hasInScopeWindowRow`.
   */
  factsFrom: 'row' | 'server-ruled'
  calls: number
  why: string
}

/** EVERY call site of `teammateDrillTarget`, outside its own module. */
const CLIENT_CALL_SITES: Record<string, CallSiteSpec> = {
  'app/components/reporting/ScopeRegionalView.vue': {
    factsFrom: 'row',
    calls: 1,
    why: 'Regional drivers table — dims from engine/drivers.ts.',
  },
  'app/components/reporting/across/TopDriversCard.vue': {
    factsFrom: 'row',
    calls: 1,
    why: 'Whole-company drivers table — dims from engine/drivers.ts.',
  },
  'app/components/reporting/cost-centre/CcDrill.vue': {
    factsFrom: 'row',
    calls: 1,
    why: 'Cost-centre drivers table — dims from cost-centres.ts.',
  },
  'app/components/reporting/cost-centre/CcOverSoftCap.vue': {
    factsFrom: 'row',
    calls: 1,
    why: 'The soft-cap card (r5-H1). It used to hard-code isActive: true from the roster filter and ignore provisional entirely.',
  },
  'app/components/reporting/regional/RegionalSignals.vue': {
    factsFrom: 'row',
    calls: 1,
    why: 'The velocity signals strip (r5-H1). It used to read isActive only, so a provisional shadow rendered as a live link.',
  },
  'app/components/reporting/finance/FinanceDrill.vue': {
    factsFrom: 'row',
    calls: 1,
    why: 'Overage drivers — dims from finance.ts fetchOverageDrivers.',
  },
  'app/pages/projects/[code].vue': {
    factsFrom: 'server-ruled',
    calls: 1,
    why: 'The reports-depth contribution table. can_drill IS the server\'s whole admission verdict for the carried frame; the server also refuses to NAME a provisional row at all.',
  },
}

/**
 * Extract the SUBJECT argument text of each `teammateDrillTarget(` call — the
 * `{ ... }` literal between the grants argument and the frame argument. Brace
 * matching, not a regex, because the object spans lines and contains nested
 * expressions.
 */
export function drillSubjectArgs(code: string): string[] {
  const out: string[] = []
  const re = /teammateDrillTarget\s*\(/g
  let m: RegExpExecArray | null
  while ((m = re.exec(code))) {
    const open = code.indexOf('{', m.index + m[0].length)
    if (open === -1) continue
    let depth = 0
    let end = -1
    for (let i = open; i < code.length; i++) {
      if (code[i] === '{') depth++
      else if (code[i] === '}') {
        depth--
        if (depth === 0) {
          end = i
          break
        }
      }
    }
    if (end !== -1) out.push(code.slice(open, end + 1))
  }
  return out
}

/* ── the checkers, as PURE functions over {path, code} ─────────────────────── */

/**
 * Pure so the synthetic-new-producer test below can feed it a file that does not
 * exist on disk. That is the whole point of the last test in this suite: proving
 * the gate FIRES, not merely that it passes today.
 */
export function serverViolations(
  files: readonly ScannedFile[],
  map: Record<string, ProducerSpec>,
): string[] {
  const bad: string[] = []
  for (const f of files) {
    if (f.path.endsWith('teammate-drill-facts.ts')) continue // the fragments' own home
    const names = countOf(f.code, TEAMMATE_NAME_RE)
    const facts = countOf(f.code, SHARED_FACTS_RE)
    const handRolled = countOf(f.code, HAND_ROLLED_FACT_RE)
    const spec = map[f.path]

    if (names === 0 && facts === 0 && handRolled === 0) continue
    if (!spec) {
      bad.push(
        `${f.path}: UNENUMERATED teammate-name producer (names=${names}, facts=${facts}, handRolled=${handRolled}). ` +
          'Carry the drill facts via server/reporting/teammate-drill-facts.ts and add this file to SERVER_PRODUCERS.',
      )
      continue
    }
    if (names !== spec.names || facts !== spec.facts) {
      bad.push(
        `${f.path}: MARKER COUNT MOVED (names ${spec.names}→${names}, facts ${spec.facts}→${facts}). ` +
          'Reformat only? update the pinned counts. New teammate-naming query? give it the shared facts first.',
      )
    }
    if (handRolled !== (spec.handRolled ?? 0)) {
      bad.push(
        `${f.path}: HAND-ROLLED drill fact (t.is_active / t.provisional in SQL, ${handRolled} ≠ allowed ${spec.handRolled ?? 0}). ` +
          'Use TEAMMATE_DRILL_FACTS / TEAMMATE_DRILL_FACTS_AGG — a per-query column list is how this defect shipped three times.',
      )
    }
    if (spec.disposition === 'shared-facts' && facts === 0) {
      bad.push(`${f.path}: declared 'shared-facts' but interpolates neither fact fragment.`)
    }
  }
  for (const path of Object.keys(map)) {
    if (!files.some((f) => f.path === path)) {
      bad.push(`${path}: enumerated in SERVER_PRODUCERS but no longer scanned — stale entry, remove it.`)
    }
  }
  return bad
}

export function clientViolations(
  files: readonly ScannedFile[],
  map: Record<string, CallSiteSpec>,
): string[] {
  const bad: string[] = []
  for (const f of files) {
    if (f.path === DRILL_CONTRACT_MODULE) continue // the renderer's own definition
    const calls = countOf(f.code, DRILL_CALL_RE)
    const urls = countOf(f.code, TEAMMATE_URL_RE)
    if (urls > 0) {
      bad.push(
        `${f.path}: builds a /reporting/teammate/ URL directly. ONE module owns that route ` +
          `(${DRILL_CONTRACT_MODULE}); a hand-built link bypasses the whole admission rule.`,
      )
    }
    if (calls === 0) continue
    const spec = map[f.path]
    if (!spec) {
      bad.push(
        `${f.path}: UNENUMERATED teammate-name renderer (${calls} teammateDrillTarget call(s)). ` +
          'Pass the server-carried isActive + isProvisional and add this file to CLIENT_CALL_SITES.',
      )
      continue
    }
    if (calls !== spec.calls) {
      bad.push(`${f.path}: call count moved (${spec.calls}→${calls}) — declare the new call site.`)
    }
    for (const arg of drillSubjectArgs(f.code)) {
      if (!/\bisProvisional\s*:/.test(arg)) {
        bad.push(`${f.path}: a teammateDrillTarget subject omits isProvisional — it fails OPEN.`)
      }
      if (!/\bisActive\s*:/.test(arg)) {
        bad.push(`${f.path}: a teammateDrillTarget subject omits isActive.`)
      }
      if (spec.factsFrom === 'row') {
        for (const fact of ['isActive', 'isProvisional'] as const) {
          if (new RegExp(`\\b${fact}\\s*:\\s*(?:true|false)\\s*[,}]`).test(arg)) {
            bad.push(
              `${f.path}: ${fact} is a hard-coded literal on a 'row' call site. ` +
                'The fact must come off the server-carried row — inferring it from a server ' +
                'predicate nothing rechecks is exactly how CcOverSoftCap shipped a dead link.',
            )
          }
          /*
           * r8-H1 — and it must be read UNKNOWN-PRESERVINGLY. `dims?.x === 'true'`
           * turns an absent or null dim into `false`, which for `teammate_provisional`
           * asserts "confirmed" about a row that said nothing. Only `dimFact` keeps
           * the unknown, so only `dimFact` may source a fact read off `dims`.
           */
          const collapses = new RegExp(`\\b${fact}\\s*:\\s*[^,}]*dims\\??\\.[^,}]*===`).test(arg)
          if (collapses) {
            bad.push(
              `${f.path}: ${fact} collapses a dims value with ===, so an absent or null ` +
                'dim reads as a stated `false`. Use dimFact(row.dims, "<key>") — it returns ' +
                'undefined for an unknown, and the admission rule refuses an unknown.',
            )
          }
        }
      } else if (!/\bhasInScopeWindowRow\s*:/.test(arg)) {
        bad.push(
          `${f.path}: declared 'server-ruled' but does not carry the server's hasInScopeWindowRow verdict.`,
        )
      }
    }
  }
  for (const path of Object.keys(map)) {
    if (!files.some((f) => f.path === path)) {
      bad.push(`${path}: enumerated in CLIENT_CALL_SITES but no longer scanned — stale entry, remove it.`)
    }
  }
  return bad
}

/* ── the tests ─────────────────────────────────────────────────────────────── */

const SERVER_FILES = scan(['server/reporting', 'server/api/v1/reports'], ['.ts'])
const CLIENT_FILES = scan(
  ['app/components/reporting', 'app/pages/reporting', 'app/pages/projects'],
  ['.ts', '.vue'],
)

describe('teammate drill facts — the producers (server)', () => {
  it('scans the real reporting read path (sanity — the roots are non-empty)', () => {
    expect(SERVER_FILES.length).toBeGreaterThanOrEqual(6)
    expect(SERVER_FILES.some((f) => f.path.endsWith('server/reporting/regional.ts'))).toBe(true)
    expect(
      SERVER_FILES.some((f) => f.path.endsWith('server/reporting/engine/over-soft-cap.ts')),
    ).toBe(true)
  })

  it('every teammate-name producer is enumerated and carries the shared drill facts', () => {
    expect(serverViolations(SERVER_FILES, SERVER_PRODUCERS)).toEqual([])
  })

  it('the fact fragments live in exactly one module', () => {
    const homes = SERVER_FILES.filter((f) =>
      /export const TEAMMATE_DRILL_FACTS(?:_AGG)?\s*:/.test(f.code),
    ).map((f) => f.path)
    expect(homes).toEqual(['server/reporting/teammate-drill-facts.ts'])
  })
})

describe('teammate drill facts — the renderers (client)', () => {
  it('scans the real reporting client surfaces (sanity)', () => {
    expect(CLIENT_FILES.length).toBeGreaterThanOrEqual(10)
    expect(CLIENT_FILES.some((f) => f.path === DRILL_CONTRACT_MODULE)).toBe(true)
  })

  it('every teammate-name renderer is enumerated and passes both facts', () => {
    expect(clientViolations(CLIENT_FILES, CLIENT_CALL_SITES)).toEqual([])
  })
})

/* ── the gate must FIRE, not merely pass ───────────────────────────────────── */

describe('the gate fires on a NEW unguarded producer', () => {
  /*
   * A green static test proves nothing on its own — the lane firewall makes the
   * same point with its "the two patterns are independent" case. These feed the
   * SAME pure checkers a file that does not exist on disk and assert the
   * violation, so the enumeration cannot rot into a rubber stamp.
   *
   * Asserted as a DELTA against the real tree, not as an absolute count: when a
   * genuine violation is also present (which is exactly when this suite matters
   * most) an absolute count would fail for the wrong reason and hide which of
   * the two fired.
   */
  const serverBaseline = serverViolations(SERVER_FILES, SERVER_PRODUCERS).length
  const clientBaseline = clientViolations(CLIENT_FILES, CLIENT_CALL_SITES).length

  it('a new SERVER query that names a teammate without the facts is rejected', () => {
    const newProducer: ScannedFile = {
      path: 'server/reporting/engine/shiny-new-axis.ts',
      code: `
        const rows = await tx.execute(sql\`
          SELECT u.teammate_id::text AS key, COALESCE(t.display_name, t.email) AS label,
                 COALESCE(SUM(u.cost_usd), 0)::text AS value
          FROM v_complete_usage u JOIN teammate t ON t.id = u.teammate_id
          GROUP BY u.teammate_id, t.display_name, t.email\`)
      `,
    }
    const violations = serverViolations([...SERVER_FILES, newProducer], SERVER_PRODUCERS)
    expect(violations).toHaveLength(serverBaseline + 1)
    expect(violations.join('\n')).toContain('shiny-new-axis.ts')
    expect(violations.join('\n')).toContain('UNENUMERATED')
  })

  it('an EXISTING producer that grows a second unguarded query is rejected', () => {
    const grown = SERVER_FILES.map((f) =>
      f.path === 'server/reporting/regional.ts'
        ? { ...f, code: f.code + '\nSELECT COALESCE(t.display_name, t.email) AS name FROM teammate t\n' }
        : f,
    )
    const violations = serverViolations(grown, SERVER_PRODUCERS)
    expect(violations).toHaveLength(serverBaseline + 1)
    expect(violations.join('\n')).toContain('MARKER COUNT MOVED')
  })

  it('a hand-rolled bool_or fact column is rejected even inside an enumerated file', () => {
    const handRolled = SERVER_FILES.map((f) =>
      f.path === 'server/reporting/engine/drivers.ts'
        ? { ...f, code: f.code.replace('${TEAMMATE_DRILL_FACTS_AGG}', 'bool_or(t.provisional) AS is_provisional') }
        : f,
    )
    const violations = serverViolations(handRolled, SERVER_PRODUCERS)
    expect(violations.join('\n')).toContain('HAND-ROLLED drill fact')
  })

  it('a new CLIENT renderer that omits isProvisional is rejected', () => {
    const newRenderer: ScannedFile = {
      path: 'app/components/reporting/regional/ShinyNewCard.vue',
      code: `
        function targetFor(r) {
          return teammateDrillTarget(grants, { id: r.teammateId, isActive: r.isActive }, frame)
        }
      `,
    }
    const violations = clientViolations([...CLIENT_FILES, newRenderer], CLIENT_CALL_SITES)
    expect(violations).toHaveLength(clientBaseline + 1)
    expect(violations.join('\n')).toContain('UNENUMERATED teammate-name renderer')
  })

  it('an ENUMERATED client site that reverts to a hard-coded fact is rejected', () => {
    // The literal CcOverSoftCap.vue actually shipped (`isActive: true`, no
    // `isProvisional`) — the r5-H1 defect, replayed against the gate.
    const reverted = CLIENT_FILES.map((f) =>
      f.path === 'app/components/reporting/cost-centre/CcOverSoftCap.vue'
        ? {
            ...f,
            code: f.code.replace(
              /\{ id: r\.teammateId,[^}]*\}/,
              '{ id: r.teammateId, isActive: true, isProvisional: false }',
            ),
          }
        : f,
    )
    const violations = clientViolations(reverted, CLIENT_CALL_SITES)
    expect(violations.join('\n')).toContain('hard-coded literal')
  })

  it('a hand-built /reporting/teammate/ link anywhere but the contract module is rejected', () => {
    const bypass: ScannedFile = {
      path: 'app/components/reporting/regional/Bypass.vue',
      code: `<NuxtLink :to="\`/reporting/teammate/\${row.key}\`">{{ row.label }}</NuxtLink>`,
    }
    const violations = clientViolations([...CLIENT_FILES, bypass], CLIENT_CALL_SITES)
    expect(violations).toHaveLength(clientBaseline + 1)
    expect(violations.join('\n')).toContain('builds a /reporting/teammate/ URL directly')
  })
})
