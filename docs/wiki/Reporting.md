# Reporting — showback, chargeback, and what every number means

> **Status:** as-built reference + the bar new reporting work is audited
> against. Canonical model: §A / §B (see [Data Flow](Data-Flow.md)). Governing
> decisions: ADR-0010 (showback vs chargeback) and ADR-0011 (governance is data,
> not config).
>
> **Not everything here is built yet.** Workstream B (2026-07-29) built the
> governance-is-data mechanism — `billing` is now the read authority, gated
> behind an activation cutover (§6b) — and the teammate personal-subscription
> declaration (Axis 2). Workstream C (2026-07-29) built the effective-dated
> Copilot rate plans (ADR-0011 D9) and the persisted, configurable pooled-
> overage allocation (D10) — see §5. Workstream D (2026-07-29) built GitHub
> enterprise-org coverage detection (the seven-state precedence table, the
> denominator-suppression rule, and a `meta.coverage` marker on the
> across/regional/cost-centre/finance report routes) — see §6a. Workstream E
> (2026-07-29) built the reporting-semantics fixes a screenshot review found:
> the usage-mode composition hero/donut now read canonical §A
> (`v_complete_usage`), never billed showback (§2 Axis 3); a `surface` driver
> axis and a per-surface + per-provenance breakdown on driver rows (§2 Axis
> 1/3); a de-overloaded `indicative` reason; settlement + coverage markers
> wherever §A/§B figures sit adjacent (§4/§6a); and one reusable Unallocated
> constant across every report that retains it. The reporting-consolidation
> engine (PRs #220–#231: `server/reporting/engine/`, the one-route Region
> scope, the billed lane) and the model-axis subtraction (migs 0118–0124)
> post-date that snapshot — where a **[BUILT — Workstream E]** tag and
> §1/§2 disagree, §1/§2 describe the current state. Anything STILL not in the
> database is tagged inline as **[DESIGNED — not built]** with the
> workstream that lands it. Treat a tagged row as the contract to build
> against, not as behaviour you can rely on today.

This page exists because the distinctions below were understood by the people
who built the views but were never written down. Views drifted from intent, and
the drift was invisible because there was nothing to audit against. **If you are
adding or changing a report, this is the contract.**

## 1. The two lenses

Every figure in TokenScope belongs to exactly one of two lenses. They answer
different questions for different audiences and **must never be summed
together**.

|           | **§A — Usage / attributed / showback**                                                                                                                                | **§B — Chargeback / billed**                                                                                                                  |
| --------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------- |
| Question  | "What did we consume?"                                                                                                                                                | "What do we cross-charge?"                                                                                                                    |
| Audience  | Practice managers, region leaders, developers                                                                                                                         | Finance                                                                                                                                       |
| Includes  | **Everything genuine** — NFR, demo, exempt, personal subscriptions, every vendor and surface (mig 0101, Workstream A: every metered surface is now covered — see §6). Personal declarations add self-reported §A context without changing §B. | Only spend the organisation pays _and_ cross-charges                                                                                                   |
| Excludes  | Only quarantined telemetry (ADR-0010 rule 2)                                                                                                                          | NFR / tracked provider spend; self-declared personal costs never enter the provider ledger                                                     |
| Source    | `v_complete_usage`                                                                                                                                                    | `v_finance_bill_chargeback` (Anthropic, per-teammate, daily) + `v_finance_copilot_pool_chargeback` (Copilot, pooled per cost-centre, monthly) |
| UI toggle | `Usage · attributed`                                                                                                                                                  | `Chargeback · billed`                                                                                                                         |

### The invariant

> **§A(metered) ≥ §B(metered), per lane.**

Within a **metered** lane, §A is provider usage truth and §B is a filtered
subset of money actually charged for that same consumption, so it is
arithmetically impossible for chargeable to exceed attributed usage. **If a
screen ever shows chargeable > attributed within a metered lane, that is a bug
in the views, not a data quirk** — it means §B is counting something §A cannot
see.

**The global form of this invariant is false, and must not be tested.** §B also
carries _fixed_ charges — `copilot-license` most importantly — which have no §A
consumption counterpart at all. An idle licensed seat legitimately yields §A = 0
and §B > 0. A global `§A ≥ §B` assertion therefore either fails permanently on
healthy data or, far worse, gets "fixed" by suppressing genuine licence cost,
which is real money disappearing from the books to satisfy a bad test.

So: compare **metered against metered**, excluding licence lanes, and guard it
with a test rather than with vigilance.

### What the `Chargeback · billed` toggle now moves — including Top drivers

The toggle used to re-lens the KPI hero and the §B cards and leave **Top
drivers** on §A, so the headline changed and attributed rows stayed underneath
it. `/reports/region/drivers?lane=chargeback` now answers the selected lane, and
every response declares the lane of every money measure in `measureLanes` (the
CSV export stamps `lane=` in its header for the same reason — a spreadsheet
outlives the page).

| Drivers axis | `lane=usage` reads | `lane=chargeback` reads |
| --- | --- | --- |
| teammate · cost centre (practice) · surface · model | `v_complete_usage` | `provider_usage_fact`, **per provider** |
| **budget** (`axis=project`) | `usage_rollup_daily` (mig 0138 — same seam SQL, rollup-sourced; ≤ one cadence behind the live view, item 13) | **`usage_rollup_daily` — same source both lanes, declared `attributed`** |

(`axis=model` is served but is not in the Top-drivers axis picker — it is the
dedicated Top models card's own fetch; see §2 Axis 1.)

**`region` is not a usage-lane drivers axis.** The whole-company view answers
"which region" once, in its own Regions cards; a saved `?axis=region` URL falls
back to `project` rather than 400-ing (`server/reporting/across-regions.ts`).
Only the billed lane carries a region axis — the billed engine (`BILLED_AXES`)
and the pooled-chargeback arm both group by `region_id`, which is what the
chargeback-by-region ranking is built on.

**The budget axis does not move.** It ranks projects on attributed usage in
both lanes. `provider_usage_fact` has no project column and the provider API has
no concept of a project (`target-state-data-architecture.md` §3 — only OTel
carries the session). The axis sums the tags the shipped attribution already
carries: OTel sessions **and** provider-recorded days (shadow fill, one row per
`(teammate, day, tool)` carrying one tagging decision). It names the unallocated
remainder, and an untagged teammate-day lands there **whole**.

**A project's bill-based figure lives on the project page.** Its
`Chargeback · billed` toggle reads `v_finance_project_overlay` (mig 0146). Per
`(teammate, UTC day, tool)`, the chargeable Anthropic bill `B` is split by
tagged share:

    charge(P) = B × weight(P) / Σ weights

- **Weights:** OTel tagged to P, untagged OTel, and worklist days tagged to P.
- **Weight population:** the same as the needs-tagging residual subtracts.
- **Untagged weight** stays untagged and is never charged to a project.

Every row is a bill dollar, and one cell's rows sum to `B`. Exempt bill and
Copilot (pooled per Business Unit) never reach a project.

**A billed figure is discriminated by provider before anything is summed.**
`provider_usage_fact.cost_usd` is BILLED money on an Anthropic row and gross AI
credit CONSUMPTION on a GitHub one (mig 0120's table comment). A billed axis
therefore returns one arm per provider, and the only cross-arm total published
is `billedLane.billedUsd`, which sums the billed-measure arms alone; consumption
rides `billedLane.consumptionUsd` beside it, never inside it, and renders muted.
`shared/reports/provider-measure.ts` is the single authority for which is which.

## 2. The three axes

A single dollar carries three independent properties. Every §A surface must
keep them distinguishable; conflating them is what produced the historical
defects listed in §6.

### Axis 1 — Provenance (how we learned of the spend)

| Value          | Meaning                                               | Example                                           |
| -------------- | ----------------------------------------------------- | ------------------------------------------------- |
| OTel-emitted   | A client emitted it to us directly                    | Claude Code from an enrolled instance             |
| API-reconciled | A provider API told us                                | GitHub Copilot `users-1-day`; Anthropic Analytics |
| Both           | Emitted _and_ corroborated — the healthy steady state | Claude Code under Claude Enterprise               |
| Provider-usage **[BUILT — mig 0101, Workstream A]** | Genuine provider usage truth for a tool that can **never** be OTel-emitted or reconciled into a taggable record — the non-Code Claude surfaces, `copilot-agent` | Claude Chat, Claude Cowork; the GitHub coding agent |

`v_complete_usage` is built from this axis, as three `UNION ALL` arms carrying an
explicit `usage_provenance` column (`otel-emitted` \| `api-reconciled` \|
`provider-usage`): `attribution_record` (OTel) `UNION ALL` `unaccounted_usage`
(the API-minus-OTel gap, `max(0, API − OTel)` per teammate/day/tool) `UNION ALL`
the **ingest-only completeness arm** (mig 0101, reading `v_teammate_usage_daily`
filtered to the tools that can never reach the first two arms). The union
recovers usage **for every lane a provider API meters per teammate/day/tool**,
so §A now reaches provider truth for all three provenances.

**The §A model split: every attributed dollar with a provider-reported model
wears it**, whatever its provenance. Arm 1 carries OTel's wire model per event.
Arm 2's residual carries the **stored subtraction split**: the reconciliation
writer computes `cap(max(0, API_model − OTel_model))` per model from
`provider_usage_fact` against the corroborated-OTel operand and stores it as
`unaccounted_usage_model` children (migs 0123/0124), which the view emits as
named-model rows. Arm 3 fans out against the provider's own
`provider_usage_fact` cost rows for the same (teammate, day, tool) key — a
whole-day observed read, no subtraction.

What cannot be named is a **reason-typed remainder**: one NULL-model row per
key, carrying `model_gap_reason` —

| reason | meaning |
|---|---|
| `provider-day-grain` | the key's money is Copilot's: the provider sends no per-model dollars (day-grain by mig 0120's CHECK) |
| `awaiting-provider-detail` | no cost-bearing provider facts have landed for the key yet — transient, heals on the next hourly fact refresh |
| `unmodelled-provider-cost` | provider cost the source reported without a model left `Σ children < parent` |
| `surface-remainder` | an ingest-only day's unfanned remainder after its models are named |
| `provider-revision-drift` | stale facts momentarily exceed the day's authoritative total; the key is emitted whole and unfanned until the next refresh — transient |

Remainders keep the sum-back invariant (Σ rows = the headline for every axis)
but are **never a category row**: the Top models card (`ModelSplitPanel`) ranks
real models only and renders remainder money as a one-line **coverage footer**
("Models named for $X · N% of attributed usage", plus the day-grain /
awaiting-detail figures when present), with the per-reason sentences from
`shared/reports/model-attribution.ts`. A reader must treat any unrecognised
reason as a plain remainder, never a category. Top drivers no longer offers a
`model` axis — the dedicated Top models card beside it is the single model
surface (the endpoint keeps accepting `axis=model`; that is the card's own
fetch, and a saved `?axis=model` drivers URL is normalised to the default
client-side).

**[BUILT — Workstream E, 2026-07-29]** The provenance axis is now fully
exposed, not just consumed internally to pick a model label: `DriverRow`
(`shared/reports/types.ts`) carries an optional `provenanceBreakdown` — a
blended row (e.g. a teammate with OTel-emitted Claude Code AND structurally
provider-usage Claude Chat) states the split rather than averaging it away,
with a native tooltip on the driver label in `DriversTable.vue`. The
`indicative` `SpendClass` is also de-overloaded via an additive-only
`DriverRow.indicativeReason` (`'usage-not-yet-billed' | 'no-attributable-usage'`)
— a REPORTING-DISPLAY-ONLY reason, distinct from `server/reconciliation/
types.ts`'s frozen `IndicativeReason` (never imported into it); `pooled-usage`
is unchanged.

**A source that is OTel-only and can never be corroborated is not automatically
suspicious** — a personal Claude Max subscription is structurally uncorroborable.
That case is declared via a teammate-level `personal_subscription_declaration`
row (ADR-0011 D3/D4, migration 0105), which is the only sanctioned exemption
from the rule-2 corroboration requirement (`server/usage/over-emission-detection.ts`'s
`material_no_bill` carve-out) — scoped precisely to the declared (teammate,
tool) contract. **[BUILT — Workstream B]** — self-service via
`PUT /api/v1/me/personal-subscription` (`app/pages/account.vue`). The
DETECTION/PROMPTING half (proactively nudging a teammate to declare) is
**[DESIGNED — not built]**; today declaration is entirely teammate-initiated.

### Axis 2 — Billing status (whose money)

Stored on `provider_org.billing` (Anthropic — the org is its own billing unit,
ADR-0011 D11) / `provider_enterprise.billing` (GitHub — the enterprise is the
billing unit; `provider_org.billing` is ignored/hidden for GitHub, see below).
**This field is authoritative** (ADR-0011 D1) — chargeability is never inferred
from an org's name, **once the governance cutover is activated** (§6b).

**[BUILT — Workstream B, gated behind activation]** `provider_org.billing` /
`provider_enterprise.billing` are constrained to `billed | tracked` (migration
`0009_provider_org.sql`) — `personal` is never a value here; it is the
teammate-level declaration above (ADR-0011 D3, amended). Until the governance
cutover is **activated** (§6b), GitHub money paths still read the legacy name/
env heuristic (the pre-activation rollback seam); Anthropic paths have always
been unconditionally chargeable (there was never a live Anthropic heuristic).
Once activated, every money path reads `billing` and the heuristic is never
consulted again — see `server/governance/verdict.ts`.

| Status                        | Whose money                                                                  | §A showback        | §B chargeback |
| ------------------------------ | ---------------------------------------------------------------------------- | ------------------ | ------------- |
| `billed`                      | The organisation pays and cross-charges                                      | included           | **included**  |
| `tracked`                     | The organisation pays or receives free; not cross-charged (NFR, demo, partner-funded) | included | excluded      |
| `personal` (teammate-level, not a `billing` value) | The individual pays; no organisation money             | included, labelled | excluded      |

A row whose governance key (`provider_org_id` / `provider_enterprise_id`,
migration 0103) cannot be resolved is **governance-unresolved**: always
showback-visible, never chargeable, surfaced on the platform-admin
`governance-unresolved` diagnostic with a recheck action — never silently
defaulted either way. See §6b.

### Axis 3 — Vendor / lane

The `tool` column. Adding a lane means updating the registry
(`shared/usage/`), **not** hand-editing predicates in individual views.

| Vendor    | §A usage lanes                                                                                                                                           | §B chargeback lanes                                                            |
| --------- | -------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------ |
| Anthropic | `claude-code`, and the non-Code surfaces `claude-ai`, `claude-cowork`, `claude-office`, `claude-chrome`, `claude-design`, `claude-slack`, `claude-other` | same, via `actual_spend`                                                       |
| GitHub    | `copilot-cli`, `copilot-agent`                                                                                                                           | `copilot`, `copilot-license`, `copilot-usage`, `copilot-unclassified` (pooled) |

**The billed lane returns one arm per provider, and the arms measure different
things.** `shared/reports/provider-measure.ts` is the single authority for which
is which; `server/reporting/engine/billed-axis.ts` applies it, so a billed axis
discriminates before it sums:

| Billed-lane arm | What its money is | Foots the chargeback headline? |
| --- | --- | --- |
| `anthropic` (`provider_usage_fact`) | what the provider **charged** for the (model, cost-type) — measure `billed` | yes — sums into `billedLane.billedUsd`, renders as a hard dollar |
| `github` (`provider_usage_fact`) | gross AI-credit **consumption** before the pooled allowance — measure `consumption` | no — rides `billedLane.consumptionUsd` **beside** the billed total, never inside it; renders muted (`pooled-usage`) |
| Copilot pooled invoice (`copilot_pool_bill`) | the actual **net Copilot charge**, pooled per (org, SKU, month) — measure `pooled-chargeback` | yes — at the axes that home it (cost-owning unit); it cannot be re-grouped onto per-teammate dimensions |

**Taggable ≠ reportable.** Only `claude-code` and `copilot-cli` are _taggable_
(a developer can assign them to a project — they have sessions). The non-Code
Claude surfaces and `copilot-agent` have no sessions and are **untaggable**, but
they are still **genuine consumption and must appear in §A**. Excluding a lane
from the taggable worklist must never exclude it from showback — that is
precisely the mistake described in §6.1.

**[BUILT — Workstream E, 2026-07-29]** This axis is now a first-class
**driver axis** too — `surface` — on Across (`ACROSS_DRIVER_AXES`), Regional
(`REGIONAL_DRIVER_AXES`) and Cost-Centre (`COST_CENTRE_DRILL_AXES`): one row
per registry lane, in canonical registry order (never magnitude-sorted — a
composition read, like the provider split), labels via `VENDOR_LABELS`. The
`teammate` axis also carries a per-surface `surfaceBreakdown` on each row (not
JSON in `dims`) so a teammate's spend is never discarded into one blended
total — see `ChartRankedBar`'s optional stacked-segment mode and
`DriversTable`'s "Surface mix" column.

**A driver row's NAME is now an affordance, and which one depends on the axis.**
`DriversTable` takes a `drillable(row)` decision function, supplied by each view
from `drill-contract.ts` — the Across top-drivers card, the Regional drivers
table, the cost-centre budgets + people tables, and the finance project and
teammate overlays. A **teammate** row opens `/reporting/teammate/{id}`, a
**project** row opens `/projects/{code}`, the **practice** row keeps its in-page
drill, and every other axis — surface, provenance, model, and any aggregate or
`__null` row naming no subject — is plain text, because there is nothing to
open. The card surfaces outside the table (cost-centre over-cap rows, regional
signals rows, cost-centre project rows) reach the same decision through the same
module. Whether a name renders as a link or as plain text is decided by grant,
never by axis alone: see rule 8.

## 3. Rules for any new report

1. **Declare the lens.** Every query reads §A sources or §B sources. Never both
   in one number.
2. **Never sum across lenses.** If a card shows both, they are separate figures
   with separate labels and a visible marker saying so.
3. **Lane filters come from the registry**, never from a literal list pasted
   into SQL. A new lane must appear automatically.
4. **Chargeability is read from `billing`**, at chargeback time, in the
   chargeback run only (ADR-0010 rule 5). Not at ingest, not from config, not
   from a name.
5. **The caption must be true.** If a figure omits a vendor, a lane, or a
   settlement state, the on-screen caption says so. "Attributed usage" that
   silently omits a vendor is a lie, not a simplification.
6. **Show the split.** Any §A total spanning more than one vendor exposes the
   vendor split; the user cannot interpret a blended number.

   A vendor slice covers **every surface that vendor ships**, not its flagship
   tool. The classifier binds the registry-composed tool sets
   (`CLAUDE_FAMILY_TOOLS`, `GITHUB_USAGE_TOOLS`), so a newly registered surface
   classifies from its first row, and the Anthropic slice is labelled
   *"Anthropic"* rather than after one of its tools. `other` stays a live
   catch-all (`NOT IN (…) OR IS NULL`) so nothing can vanish from the total.
   One shared fragment serves every surface that draws the split — two copies
   are how the region view and the cost-centre drill drifted into the same
   defect without a diff ever showing it.
7. **Pin the invariant.** New §A/§B pairs get a test asserting §A(metered) ≥
   §B(metered), scoped to the metered lanes only. Never assert the global form
   (see §1) — fixed licence charges have no §A counterpart and will break it on
   correct data.
8. **Every teammate/project name is a real link or plain text, BY GRANT.**
   Never a live-looking dead button. The decision is made in one place
   (`app/components/reporting/drill-contract.ts`) and delegates to two exported
   policy rules that are deliberately NOT one:
   - `namedContributionRow(viewer, subject, projectCtx)` — may this subject be
     NAMED in a row, or must they fold into the aggregate remainder?
   - `teammateDrillAdmission(viewer, subject, scopePredicate, window)` — may
     this viewer OPEN the subject's page? Its conjuncts are the `teammate`
     grant, a scope frame the viewer holds, ≥1 in-window row already inside
     that frame (**emit-time homing**, never current placement) and
     `teammate.is_active`.

   A name can be named by the first rule and plain text by the second — a named
   row is not automatically a door. A row that cannot name a target id (an
   aggregate remainder, a `__null` key) is plain text by construction.

   Both rules read the `teammate` and `project` grant columns, which sit in the
   same WHO-SEES-WHAT matrix as every other scope and reach the client through
   `/reports/meta`'s `drill` leg — see
   [Report access grants](Authentication-and-Security.md#report-access-grants).

   **Back restores the entry report exactly.** A drill link carries `?src=`
   (the entry scope token) plus the entry window in the report vocabulary
   (`month` XOR `from`/`to`); the target echoes both and reconstructs the entry
   URL for its breadcrumb from that state — never `history.back()`, which
   breaks on refresh and on a shared link.

   **A named-individual page is recorded and can refuse.** Opening
   `/reporting/teammate/{id}` writes a `report-teammate-viewed` audit row (ids
   and counts only) and the page discloses it; exporting its TokenSheet writes
   a separate `report-teammate-export` event. Past the provider-freshness
   threshold the endpoint WITHHOLDS the figures rather than caveating them —
   on a governance surface about a named individual that is the difference
   between a finding and a defamation.

10. **A ranked card ranks the constituents OF ITS OWN SCOPE, and states its
    denominator and its lane.** The ladder is company → **regions** → cost
    centres → **projects**; a cost centre has no child org node, so its
    children are its projects and its people. Two consequences that are easy to
    get wrong:
    - A card that ranks the dimension its page is already ABOUT is a category
      error, not a captioning bug — the cost-centre page ranking cost centres
      read as unscoped because it was not about one centre. Ranking cost
      centres belongs to the Region scope's children table, and it lives there
      once: two places rendering one fact eventually diverge, with the reader
      unable to tell which is wrong.
    - The rows rank on the figure in the page's OWN frame — same axis, lane and
      window as the KPI strip above them. A ranking whose figure cannot foot to
      the number above it is a second answer wearing the first one's heading.

    Where the list is sorted matters as much as what it ranks: the cost-centre
    endpoint sorts by §A burn only, so a card offering a chargeback lens re-sorts
    on the client. Dropping that sort would leave "ranked by chargeback" showing
    burn order.

11. **The cost-centre page is ALWAYS ONE COST CENTRE.** There is no unscoped
    state. A reader lands on their own centre (the server resolves it — their
    owned centre where they hold one, else the first visible), the crumb is the
    way back up, and the selector is grant-scoped: it offers only the centres
    they hold, and a reader with exactly one gets no selector at all, just the
    name. One option is not a selector, it is a label.

    The scope label is **server-derived**, from the same resolver that built the
    clamp — a view composing its own from the URL can name a scope the server
    did not serve.

    **The owner's two lists, side by side, neither truncated.** A cost-centre
    owner owns exactly two axes — what the money went to (**Projects**, called
    *Budgets* in the product's vocabulary) and who spent it (**People**) — and
    wants both on screen at once, so this scope offers no pivot selector. At one
    centre the list IS the population: a top-N would hide the budget or the
    person the owner opened the page to find.

    The two lists have DIFFERENT denominators by construction and each states
    its own. Projects is clamped on the project's own cost-owning unit and adds
    a second, disjoint arm for burn homed here with **no project on it** — the
    *"Not on a project"* row. People foots to the cost-centre burn. Neither is
    footed against the other's number.

    Each sum-back therefore **names its own base**, and neither may say
    "headline". `DriversTable` takes a `sumbackLabel` (default `'headline'`,
    correct on every scope whose rows do sum to the figure at the top): Projects
    passes *"these projects' own totals"* because its rows carry each project's
    total across **every** cost centre, and People passes its own denominator
    label, *"cost-centre burn"* — which is the headline under the usage lens and
    is **not** under chargeback, where the caveat above the tables already says
    the two do not add up to the charge. Both sums were always arithmetically
    right; the word above them was borrowed, and pointed at $1,726.20 and
    $302.82 on one screen whose headline was $302.82.

    What that row holds is worth stating exactly, because it is narrower than it
    sounds. It is the **ingest-only** arm: provider-reported usage, homed at a
    cost centre by its dimension snapshot and carrying no project because it is
    **untaggable**. It is not the taggable spend somebody simply has not put on a
    project yet — both §A writers derive the cost-owning unit FROM the project
    and leave it NULL when there is none, so that money has no project-derived
    home at all. Its only home is the **spender's** centre, and it is reported on
    its own dimension as `member_untagged_usd` (the cost-centre P&L card) and
    ranked per person by the over-the-soft-cap card. Folding a teammate-homed
    figure into a project-homed denominator is how two axes become one wrong
    number, so the page keeps them apart and names both.

    The lane toggle is **present** on this scope, and it moves a real figure. A
    cost-centre owner is accountable for a budget, so both halves of the job are
    on the page: *am I on track* is answered by what the centre is **charged**
    (§B), *what is driving it* by what its people **consumed** (§A).

    In the usage lane the headline is the §A **burn**, homed by emit-time
    `cost_owning_unit_id`, and it matches the tracker row. In the chargeback lane
    it is the §B **charge**, the same figure that centre's card carries in the
    list — one shared fetcher serves both, so the list and the drill cannot
    disagree. The two are never summed and never shown together (rule 1).

    The tables below the headline stay on attributed usage in both lanes: there
    is no chargeback breakdown of who drove a charge. The page says so rather
    than implying the rows foot to the §B figure.

    The Copilot pool is billed **monthly**, so on a window that is not
    month-aligned it cannot be sliced and is excluded from the charge. The drill
    states that as a property of the window — it does not know whether a given
    centre has a pool row at all.

12. **Report GETs are served through a short-TTL response cache** — except the
   named-individual family, which is `no-store` on the browser layer (rule 8:
   a browser-cache hit never reaches the handler, so it would neither audit nor
   re-check freshness). The region,
   cost-centre and finance report responses may be up to **60 seconds** stale
   (`server/reporting/report-cache.ts`; browser side, `Cache-Control: private,
   max-age=60` makes back-navigation instant). What this does and does not
   mean:
   - **Authorization is never cached server-side.** Every request that
     reaches the server re-resolves its grants and scope against live rows
     before the cache is consulted — a revoked grant 403s on its next server
     round-trip. The one bounded exception is the browser's own copy: a
     response fetched ≤60 s ago can be re-rendered from the local HTTP cache
     without a server round-trip — same user, same data they already held,
     never longer than the `max-age`. Only the computed figures can be ≤60 s
     stale, which sits far inside the settlement-state tolerances of §4.
   - **The cache key is per-caller.** It includes the caller's effective
     identity and resolved grants/scope (plus route params, query, UTC day and
     `copilot.mode`), so one caller's body can never be served to another —
     that would be a security defect, and the key is test-pinned against it.
   - A new report GET should wrap its computation in `withReportCache` with
     the same key discipline; `/reports/meta` (the live grant probe) and
     `/reports/export` stay uncached server-side by design.

13. **Region report figures are served from `usage_rollup_daily`**, the
   day-grain rollup of `v_complete_usage` written by the `usage-rollup` worker
   (mig 0136), not recomputed from the live lane per request. `/api/v1/me/usage`
   reads it too, but only for SETTLED days and only behind a gate that refuses
   unless the rollup is provably complete AND current for that caller and
   window; today is always live there, and a refusal puts the whole window back
   on the view. So the freshness below describes the region reports; the My
   usage page either matches the live lane or says which basis it used
   (`page_freshness.settled_source`). What the lag means for the reports:
   - A figure may lag the live §A lane by up to the worker cadence
     (**15 minutes**) — plus, for retroactive mutations that change history
     with no timestamp (a quarantine flip, a placement re-home), however many
     runs the `usage_rollup_refresh` queue takes to reach the request: the
     drain is capped per run, so a mass correction (a bulk re-home) clears in
     batches across successive 15-minute ticks rather than on the very next
     one. All of it sits far inside the settlement-state tolerances of §4,
     which are hours-grain.
   - A region report row and a drill that reads the live view can therefore
     disagree by ≤ one cadence on the still-filling day. Transient and
     self-healing — never a reconciliation finding.
   - **§B is never rollup-fed.** Chargeback and every billed figure read the
     bill lane directly; the rollup serves §A region reads only. (The one
     §A read the chargeback lens shares is the project/budget drivers axis
     above — attributed by declaration, rollup-sourced like the rest of §A.)
   - **The project (budget) drivers axis and the Business-Unit population
     read are rollup-sourced too** (mig 0138): `identity_state` joined the
     rollup grain so the seam's provisional-exclusion filter applies
     identically on either source, and the seam only accepts the rollup for
     exact UTC-midnight windows. The drivers DRILL still reads the live
     view, so a drill can disagree with the axis row that opened it by ≤ one
     cadence — same transient class as the region rows above.

## 3a. The clock — what "today" means on a report

**The day is UTC, everywhere.** Not a preference: all three sources bill and
report in UTC days. Anthropic's Analytics API is pulled at `bucket_width=1d`
over `[day 00:00:00Z, next day 00:00:00Z)`; GitHub Copilot's `ai_credit/usage`
reports per UTC day; OTel emits timezone-free instants, which we bucket
explicitly `AT TIME ZONE 'UTC'`.

A local-day product would make every one of our days straddle two provider
days, so `Σ(our days)` could never equal the provider's figures — which breaks
both reconciliation contracts the product rests on (§B's Σ = bill, and §A's
API-minus-OTel subtraction at `(teammate, day, tool)` grain). Re-bucketing
provider data to a local day is not possible anyway: providers only ever report
UTC-day totals, so we would have to fabricate a split the source never gave us.

Months and budget periods follow, for the same reason. **State this plainly to
finance before they read it off a screen:** a Sydney reader's "August" closes at
10:00 on 1 September local time.

**Instants convert; day buckets never do.** A session start, "last active",
"2h ago" or a settlement timestamp is a real moment — rendered in the viewer's
local time, and nothing reconciles against it. A chart day, a month total, a
budget frame is a *provider fact* — it stays UTC.

### The settled edge

Three quantities, and they are **not** the same:

| quantity | what it is | where it is used |
|---|---|---|
| `now` | the server instant | relative ages, "as at" stamps |
| `today` | the UTC day `now` falls in — **still filling** | drawn partial, never an axis edge |
| `settledThrough` | the **last complete UTC day** | the right edge of every day-grain chart |

A fourth, kept separate: `asOfDate` is `MAX(event_date)` — the last day we hold
*data* for. `settledThrough` is a *coverage* fact. A settled day with genuinely
no spend is a measured zero and belongs on the chart; a day we have not finished
observing is not a zero and must not be drawn as one.

The server resolves all three **once per request** and ships them
(`GET /api/v1/clock`; `ServerClock` in `shared/reports/clock.ts`). Clock-sensitive
controls — the period pickers, the rolling trend windows, the chart axes —
consume that answer. **No `new Date()` in any windowing or labelling path**, on
the server or in the browser, and no `CURRENT_DATE` in a series frontier. That
is an *ownership* rule rather than a timezone one: two clocks that both do
correct UTC arithmetic still disagree across a midnight, and the gap between
them is what used to draw as a dip.

*Deferred and disclosed:* provider lag as a **distinct** cause of a shorter edge.
`settledThrough` is today's last complete UTC day; it does not yet narrow
further for a provider whose pull is behind.

### The partial day

At 09:00 in Sydney the current UTC day is three hours old. That is neither a
data problem nor a timezone problem — it is a day still filling. So:

- charts run to `settledThrough`;
- `today` is drawn **beyond** that edge, faded, and **only when it actually
  carries data** — an empty partial day is silence, not a zero bar;
- the partial day is excluded from trend lines, 7-day trailing means and any
  peak/max label.

The morning gap is presentation, not arithmetic. A low final bar means "not
finished", never "spend collapsed".

## 4. Settlement state

§A and §B settle at different speeds — Anthropic's Analytics API lags, and
`unaccounted_usage` is only written once reconciliation runs. Two figures from
different settlement states shown side by side **must carry a marker**;
`meta.providerStates` exists for this.

An in-progress month is `Estimated`. A closed, fully-reconciled month is not.
The difference is material to finance and must never be implicit.

**[BUILT — Workstream E, 2026-07-29]** Across, Regional and Cost-Centre
headers render a `SettlingStateChip` **per vendor** in `meta.providerStates`
(usage/anthropic/github), not a single consolidated "usage" chip — the hero
on every one of these scopes shows the §A attributed figure ADJACENT to a §B
chargeable figure (e.g. "≈ $X will be charged"), so the header must carry
both clocks, not just usage's. Finance keeps its own deliberate single
"least-settled-of-the-three" consolidated chip (a different, still-honest
design — Finance is §B-native end to end).

## 5. Copilot's structural difference

Anthropic bills **per user**, so §B is per-teammate. GitHub Copilot bills a
**pooled** enterprise allowance per (org, sku) with **no user field**, so §B is
**per cost-centre** — the org's pooled net, homed via
`provider_org.cost_owning_unit_id`.

### The pooled credit model

Each Copilot seat carries a flat monthly licence (currently **$39**) and an
included AI-Credit allowance (currently **$70**). **Credits pool at org level:**

```
pooled allowance = Σ active seats × included allowance
overage          = max(0, Σ org AIC usage − pooled allowance)
```

An individual exceeding their $70 costs the organisation **nothing** while the
pool holds. For example, an org of 133 seats with several users past $70 can
still be under the pool, so the overage is **zero**. This is _why_ per-user overage is not a
charge: it is not money.

Per-user AIC consumption is still **displayed** — that is the point of
showback — and users above the per-seat average may be flagged, provided it is
never rendered as cost. _Showing ≠ charging._

**Rate terms are effective-dated** (ADR-0011 D9) **[BUILT — Workstream C,
migration 0106]**. The $39/$70 plan is time-bounded; every computation selects
the plan in force **for the period being computed** — `copilot_rate_plan`,
non-overlapping per enterprise, resolved by `server/governance/copilot-rate-
plan.ts`'s `resolveCopilotRatePlan(db, { providerEnterpriseId, periodMonth })`
— so a plan change never re-costs a closed month. The scalar
`provider_enterprise.flat_seat_price_usd` / `included_allowance_usd` columns
remain readable/writable for backward compatibility, but no longer drive any
period-aware computation once a rate-plan row covers the queried period; the
migration backfills an open-ended plan for every existing enterprise so the two
agree from day one. Admin API/UI: `GET`/`POST
.../enterprises/{id}/copilot-rate-plans`.

### Allocating pooled overage

**If the pool holds, nothing is charged beyond the seat** — the organisation
paid nothing extra, however many individuals went over. This is the common case.

When the pool _is_ exhausted, the overage `O` actually billed is distributed to
Business Units by a configurable per-enterprise policy (ADR-0011 D10). **The
default policy is `consumption-share`**: weight `usage`, normalised so
`Σ allocations == O` exactly.

The rationale is organisational, not mathematical. It suits an organisation
whose AI function is a **cost centre, not a profit centre** — when overage is paid, the bill is split
across everyone who consumed, in proportion to consumption. Each person's share
is then almost always _far less than they consumed_, because the pooled
allowance absorbs most of the total. That is the intended outcome: the pool is a
collective benefit and the residual is a collective cost.

A causal alternative (`excess-share`, weighting by `max(0, usage − allowance)`)
is supported for organisations that want overage borne by whoever triggered it —
`O = Σ excess − Σ unused headroom`, so excess is the causal driver. Both
conserve `O`; they differ only in who bears it. `excess-equal` and `seat-share`
are also available.

This is **not** the rejected per-user overage model: the money is real and taken
from the bill, and consumption is used only as a weight. When the pool holds,
the allocation is zero.

**[BUILT — Workstream C, migration 0106/0107].**
`provider_enterprise.overage_allocation_policy` is the per-enterprise switch
(default `consumption-share`); `copilot_overage_allocation` is the persisted
grain — `(provider_enterprise_id, month, cost_owning_unit_id)`, recipients are
the **seat-holder's own cost-owning unit** (not the org's mapped CoU), which is
the point of the mechanism: a single shared GitHub org's overage can now split
across every practice that actually consumed. `server/governance/copilot-
overage-allocation.ts`'s `persistCopilotOverageAllocation` is idempotent
delete-and-replace under the same enterprise/month advisory lock the
copilot-pool-bill worker's bill rewrite takes, and asserts cent-exact
conservation from a post-persistence read-back. A month that has been recorded
is NOT special: the provider is the record of truth, its corrected bill lands,
and the difference surfaces as a delta against that month's snapshot. `v_finance_copilot_pool_chargeback`'s `copilot-usage` lane reads this
allocation once it exists for an (enterprise, month) — replacing, never
alongside, the org-homed `overage_net_usd` fallback (structurally mutually
exclusive; same total either way). The existing informational per-teammate
Overage-Drivers panel (`fetchOverageDrivers`, §7) is a **separate, still-live**
display — it remains labelled "informational... never a charge" and is not
this persisted mechanism.

### Three per-user numbers — never conflate them

| Number                       | Example value | What it is                                                      |
| ---------------------------- | ------------- | --------------------------------------------------------------- |
| Seat licence                 | $39/mo        | **Real cost**, charged every month regardless of usage          |
| Included AI-Credit allowance | $70/user      | **Pool contribution** — exceeding it individually costs nothing |
| Budget cap                   | $200/user     | **Guardrail only** — a GitHub spend control, never money        |

A user at $717 against a $1,000 cap has incurred **no** overage cost while the
org pool holds. Never render a budget where a cost is expected.

**Budgets are not allowances.** GitHub-side budgets (a $200/user universal
budget, a $1,000 personal budget, "stop usage: yes") are **spend controls**.
They cap consumption and never appear as money in §A or §B. Do not display a
budget where a cost is expected.

### Three wrong models

Explicitly rejected and never to be reintroduced (ADR-0010 Correction):

1. Per-user Copilot overage (`usage − allowance`) booked as a per-teammate
   charge — the allowance **pools**, so this is not money.
2. Licence cost computed as `seats × $39` **as the cost of record** — the
   "Copilot Enterprise" SKU **net** must be read from the bill. (`seats × $39`
   is legitimate as a _forecast_ input only.)
3. "My usage" reflecting only OTel-emitted usage.

## 6. Known divergences

Recorded so they are not rediscovered as mysteries. Both were the same class:
**a lane excluded from tagging was also excluded from reporting** — and both
are now **[BUILT — migration 0101, Workstream A]**.

### 6.1 Non-Code Claude surfaces missing from §A — RESOLVED (mig 0101)

`drizzle/migrations/0084_teammate_usage_daily_exclude_noncode_surfaces.sql`
excluded the seven non-Code Claude surfaces from `v_teammate_usage_daily`, which
fed `unaccounted_usage`. Those surfaces also emit no OTel, so they landed in
**neither** arm of `v_complete_usage` — while `v_finance_bill_chargeback` read
`actual_spend` directly and **did** include them.

Result: **§B > §A**, breaking the invariant, and a violation of ADR-0010 rule 3
("showback shows ALL genuine usage… the only thing absent is quarantined
telemetry"). The exclusion's _intent_ was right — these surfaces must not become
taggable worklist items — but it was applied at a seam that also governed
reporting.

**Fix, built:** `drizzle/migrations/0101_usage_completeness_ingest_only_arm.sql`
reverts 0084's exclusion — `v_teammate_usage_daily` is the complete
per-(teammate, day, tool) usage truth again — and adds a third, non-taggable
union arm to `v_complete_usage`. An earlier revision of this page named
`actual_spend` as that arm's source; the design rejected that, because
`actual_spend` cannot cover `copilot-agent`, whose usage truth is
`reconciliation_record` rather than per-request spend. The mechanism is
provider-neutral instead: `shared/usage/surface.ts`'s
`INGEST_ONLY_USAGE_TOOLS` generalises "§A-visible, never taggable" to every
surface that needs it (both non-Code Claude AND `copilot-agent`), and
`server/usage/unaccounted-reconciliation.ts` is the one place that reads it to
keep the needs-tagging worklist clean. The
arm cannot become a worklist item because the worklist reads
`unaccounted_usage`, not `v_complete_usage` — pinned by
`tests/integration/reports/complete-usage-view.test.ts` and
`tests/integration/usage/unaccounted-reconciliation.test.ts`.

### 6.2 `copilot-agent` missing from §A — RESOLVED (mig 0101)

The same shape, already documented in the header of
`server/usage/unaccounted-reconciliation.ts` and knowingly accepted at the time:
the coding-agent lane is OTel-invisible, so excluding it from the taggable feed
also removed it from `v_complete_usage`. It read **0** in every §A rollup while
remaining visible in `v_teammate_usage_daily` readers (e.g. the Finance
Overage-Drivers weight).

The same third union arm (§6.1) closes both. These rows now carry real model
names wherever the provider reported one: the arm fans out against
`provider_usage_fact` for the same (teammate, day, tool) key (mig 0124), and
what remains is a reason-typed NULL-model remainder (`provider-day-grain` for
`copilot-agent` money, `surface-remainder` otherwise — §2 Axis 1) rendered as
the Top-models coverage footer, never as an "Unattributed" row.

## 6a. Coverage — the completeness we did not collect — **[BUILT — Workstream D, 2026-07-29]**

Every divergence in §6 is about usage we _collected_ and then dropped. This one
is about usage that never arrived, which is more dangerous because it is
invisible by construction: an org whose telemetry we cannot see looks exactly
like an org that spent nothing.

GitHub Apps install **per-org**, so an enterprise is only as observable as its
least-covered org. Each enterprise carries a **coverage set** classifying every
org (`server/reconciliation/coverage.ts` + `github-coverage.ts` +
`coverage-store.ts`).

The five-state form (`connected`, `not-installed`, `suspended`, `not-onboarded`,
`stale`) that ADR-0011 D13 introduced is **superseded**: those states are not
mutually exclusive (a suspended installation on an unhomed org satisfies two of
them) and some real configurations match none (a `provider_org` row pointing at
a different enterprise, an installation of a different App, a failed capability
probe). The classification is a **precedence-ordered truth table** of seven
states, adding `mislinked` and `coverage-unknown`, evaluated against a specific
target enterprise and the reconciliation App's own id.

**The reporting obligation:** any enterprise-scoped total must be presented with
its coverage denominator — _"covers 12 of 15 orgs"_ — and must not be described
as complete while any org is unconnected. A figure that silently omits three
orgs is not a smaller number; it is a **wrong** one, and the reader has no way
to tell. This is ADR-0010 rule 3 applied one stage earlier: rule 3 obliges us to
show all genuine usage, and where we could not acquire it, to say so. The
`across`/`regional`/`cost-centre`/`finance` report routes now carry a
`meta.coverage` marker (`applicable`/`denominator`/`connected`/`nonConnected`/
`stale`) built the same way: the denominator is `null` whenever **any** relevant
GitHub enterprise's own census is unavailable/capped/stale — the weakest link
governs the aggregate claim, exactly like a single enterprise's own denominator
(never a partial "N of M" that quietly excludes the enterprise it could not
classify). **[BUILT — Workstream E, 2026-07-29]** `CoverageMarker.vue` now
renders this marker on all four scope headers — an honest "covers N of M
GitHub orgs" when the denominator is known, an explicit amber "coverage
unknown"/"coverage stale" marker (never a fabricated ratio) otherwise. The
rest of Workstream E (vendor splits on Top drivers, the `indicative` badge
de-overload, settlement-state placement, Copilot billing UI copy) is also now
**[BUILT]** — see §7.

Coverage gaps are an **operator defect, not a reporting nuance** — they raise a
run warning (`run-warnings.ts`'s `nonConnectedOrgs`/`censusUnknownEnterprises`
probes), a Verify-ladder stage (a cheap, persisted-only read — never a live
re-probe, to respect the ladder's tight per-attempt deadline budget), and an
admin banner (the Reconciliation → Providers tab), because the remedy is an
action (run the bulk installer / Discover Copilot orgs, unsuspend in GitHub, home
the org to a cost-owning unit via the existing Edit dialog), not a footnote. A
scheduled `github-coverage-sweep` worker (hourly) detects gaps without an admin
visit, dispatching a deduplicated admin inbox alert exactly on a transition into
a non-connected state or a capability loss (the prior-vs-new observation
comparison IS the dedup key), and auto-resolving on recovery. An admin can also
force an immediate live recheck per enterprise
(`POST /api/v1/admin/reconciliation/github/coverage-recheck`) rather than wait
for the next scheduled sweep.

## 6b. Governance cutover and reporting snapshots (Workstream B) — [BUILT]

Two mechanisms close the "governance settings are decorative" defect (design
§1.2) and the arithmetic-safety gap in freezing a chargeback month.

**Governance cutover** (`governance_cutover_state`, singleton row) is a
one-way-until-rolled-back state machine: `not_started → preflight_verified →
activated (→ rolled_back)`. Before `preflight` runs, GitHub money paths read the
legacy name/env heuristic (`server/reconciliation/legacy-chargeback-heuristic.ts`
— quarantined there specifically as the pre-activation rollback seam; Anthropic
never had a live heuristic, so its "before" state is simply unconditionally
chargeable). `preflight` computes that legacy verdict for every registered
unit, detects **mixed GitHub enterprises** (orgs that disagree — a hard abort,
a human decision required, nothing written), writes **both sides explicitly**
(`billed`/`tracked` on every unit, never left at the implicit default), and
verifies the freshly-written data reproduces the exact same verdict before
recording success. `activate` re-verifies against current data (catching drift
since preflight) and then — and only then — every money path switches to
reading `billing` authoritatively; the heuristic is never consulted again
(`server/governance/verdict.ts`). `rollback` is allowed only before any recorded
month has used the new regime. Admin surface:
`/admin/policies/provider-governance` (platform-admin only); API:
`/api/v1/admin/governance-cutover/{preflight,activate,rollback}`.

**Reporting snapshots** (`reporting_snapshot`, one row per calendar month once
recorded) write down what a month READ when it was reported, and by whom:
`attributedUsd`, `chargeableUsd`, `exemptUsd`, the `basis` it was read on, and
the actor. Recording a month is refused a second time — silently replacing what
was reported the first time is the one thing a snapshot exists to prevent.

**A snapshot is not a lock, and this is deliberate** (mig 0128, replacing
`finance_period`). It writes nothing to `actual_spend`, holds no trigger and
refuses no later write. TokenScope is not the billing system of record: we
record a month at +2 days, the provider corrects its rows at +6, the invoice
lands at +10. A product that refuses the bill because of a state it set itself
does not protect the month — it guarantees the month stays wrong. Governance
recompute reaches a recorded month for the same reason: a rule change matters
most on the month somebody actually read.

What a snapshot buys is the DELTA. `reportingSnapshotDelta` reports the month
against what was recorded — chargeable movement, a verdict flip that moves
nothing on its own (`chargeable` down by exactly what `exempt` gains) — so a
finance reader is told when a reported month has moved instead of discovering
it. It **refuses to subtract across a `basis` change**: a month recorded
`project-homed` and read `person-placed` has not moved by the difference, the
difference is what changing the question costs. Both figures are returned and
only the arithmetic is withheld.

Recording serialises on the period via the `reportingSnapshot` advisory lock +
`SELECT ... FOR UPDATE`, so a concurrent governance recompute can never be
half-captured. `chargeback_exempt`'s provenance stays explicit on the row via
`governance_verdict_source` (`legacy-heuristic` | `governance:billed` |
`governance:tracked` | `unresolved`).

## 7. Where the numbers live

One page, three tabs: **Region · Cost centres · Finance**. The Region tab owns
both widths behind its own region selector — "All regions" is the whole-company
answer, one region is the regional answer — so no view is reachable from two
tabs.

| Surface                              | Scope                | Lens                           |
| ------------------------------------ | -------------------- | ------------------------------ |
| `/reporting` → Region, "All regions" | whole company        | both, via the lane toggle      |
| `/reporting` → Region, one region    | one region           | both                           |
| `/reporting` → Cost centres          | one cost-owning unit | both                           |
| `/reporting` → Finance               | finance              | §B, with `copilot.mode` gating |
| `/reporting/teammate/{id}`           | the entry `?src=` frame | §A — contribution against budgets only |
| `/projects/{code}` (reports depth)   | the viewer's project grant | §A — two figures + named rows + ONE remainder |

The last two are **drill targets**, reachable only from a row on one of the
three tabs (rule 8). The teammate drill has no scope tab of its own on purpose:
it always answers within the scope it was opened from, and a contribution figure
with no scope is not a smaller answer, it is a different one.

`server/reports/copilot-mode.ts` gates whether Finance renders Copilot pooled
chargeback as a **charge** (`NUXT_COPILOT_CHARGEBACK_ENABLED`, default off →
`pool-utilisation`, UI shows "Copilot pending"). This is a **rendering** gate
only — `copilot-pool-bill` writes `copilot_pool_bill` regardless.

Report access grants are layered on top by
`shared/auth/report-visibility.ts` — the
documented exception to the "every handler has `requireRole`" rule.


## The Business Unit

The reported unit is a **Business Unit (BU)**. "Cost centre" is a different
object in this product — an optional finance code tag carried on a BU, set in
admin config and unused today — so the two words are never interchangeable.

The user-facing term is per-region (`region.unit_term`: APAC and North America
"Business Unit", EMEA "Area of Expertise", Global IT "Team"). Until that column
has a reader, every surface renders `BU_LABEL` from
`shared/reports/vocabulary.ts`, which defaults to "Business Unit". Wire keys,
routes, columns and `data-testid`s still say `costCentre` / `cost-centre` and
are unaffected.

A BU owner is a member of the BU they own, and owns at most one.

### The BU drill's empty state

It names the BU and reports what was measured. It **never states a cause**: burn
is project-homed, so a BU with no-one placed in it still has usage if a tagged
project homes to it, and a fully staffed BU shows nothing when its people's
projects home elsewhere. Roster size does not determine the total in either
direction.

When the rolling band below carries spend over its own (different) window, the
empty state says so rather than being suppressed — the month figure is true, and
the two windows are reconciled instead of one being hidden.

### Spend keeps the BU it was recorded under

`attribution_record.cost_owning_unit_id` is stamped at write time. Re-homing a
project changes future usage only, so a project row can show a real total beside
`$0.00 from this Business Unit`; the row says so. An admin applies the change to
recorded usage with **Migrate** (`API-Reference.md`).

### "day N of M"

Read from the server clock (`Forecast.dayOfMonth`), not from the data.
`daysElapsed` anchors the RUN-RATE on the latest event and falls back to the
month start when a scope has no usage yet, which is correct for the projection
and wrong for the caption.
