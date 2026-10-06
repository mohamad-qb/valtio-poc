# Requirements

What every version of the deal editor must do, whatever its state library.
Reconstructed on 2026-10-06 from the shared rules (`src-shared/`) and the
test suites, which act as the executable spec: each requirement names the
test that checks it. If this file and a test disagree, the test wins; fix
this file.

Test references: `deal ›` = `tests/stores/deal.test.ts`, `paths ›`,
`grid ›`, `autocalc ›`, `fixingSources ›`, `productConfig ›`,
`libraries ›` = `tests/stores/*.test.ts` (run for every app);
`e2e/<file> ›` = `tests/e2e/<file>.spec.ts` (browser, every app);
`gridHelpers ›` = `tests/grid/gridHelpers.test.ts`.

## 0. Purpose and constraints

- One app, built once per state library, to compare the libraries for
  migrating an existing app (excerpts in `original-app/`).
- **Every version must behave identically.** All business rules live in
  `src-shared/` as pure functions; a version only chooses how to store state
  and how to notice changes.
- **The original app reads and writes by dot path**
  (`groups.<groupId>.products.<productId>.data.optionsCommon.strike`, or a
  deal key like `notionalCcy`). Every version exposes its deal that way
  (`PathDeal`, `src-shared/pathDeal.ts`); the grid and tests use nothing else.
- Product types are declared in the original app's config format
  (`defineProduct`: `fields` with `props.path`, `position.field`,
  `validation`, `visibility`; plus `rules` and `derived`) and every version
  builds them generically.

> **To be completed by the project owner:** why the migration, the criteria
> the libraries are judged on (e.g. performance, re-render scope, devtools,
> ergonomics, bundle size, team familiarity), what has been decided or ruled
> out, and who decides. None of this is in the code.

## 1. Model

- A **deal** holds **groups**; a group holds **products**. A group's type
  and products are fixed when it's created:

  | Group | Products |
  | --- | --- |
  | Vanilla Group | 1 Vanilla Product |
  | Strategy | 2 Vanilla Products |
  | Average | 1 Average Product |

- Vanilla and Average products have the same fields at different paths
  (`optionsCommon.*` vs `avroCommon.*`).
- The deal also has its own **synced fields** and **settings** (below), a
  **calculation**, and a **spot price stream**.
- Several deals can be open at once, one per **tab**.

## 2. Layout and tabs

| # | Requirement | Checked by |
| --- | --- | --- |
| L1 | One grid per deal. Columns, left to right: the settings subgrid (labels, values), the deal column ("Deal"), the field labels, then one column per product, grouped under its group's header. The settings, deal and labels stay in view while products scroll. | e2e/layout › "the deal, then the labels…"; grid › "lists the deal, then every product under its group" |
| L2 | One row per field, 16 in all, in display order starting Notional Ccy, Notional Amount, Premium Ccy. | e2e/layout |
| L3 | A group header spans exactly its products. Groups are titled "<Type> #n" by position, products "<Product> #n" within their group. | e2e/layout; deal › "builds groups with typed, numbered products" |
| L4 | A new deal starts with one Vanilla Group. Buttons add a Vanilla Group, Strategy or Average. | e2e/layout; deal › "builds groups…" |
| L5 | Tabs: "Add New Deal" opens a fresh deal in a new tab; each tab keeps its own deal. | e2e/devtools › "tabs hold independent deals" |
| L6 | A landing page (`index.html`) links to every version. | e2e/layout › "the landing page links to every app" |

## 3. Groups

| # | Requirement | Checked by |
| --- | --- | --- |
| G1 | Clone inserts a copy right after the original, with new ids. Editing either afterwards doesn't affect the other. Titles renumber. | deal › "clones a group right after the original, as an independent copy"; libraries (keystone, effector) |
| G2 | Remove deletes a group and its products for good; the rest renumber. | deal › "removes a group: renumbered…" |
| G3 | Every group can be removed, and groups added again. | deal › "can remove every group and start again" |

## 4. Fields

Empty is allowed for every field and is never an error: `""` for text and
dates, `NaN` for numbers (shown as an empty cell, never 0).

| Field | Kind | Validation (message) |
| --- | --- | --- |
| Notional Ccy | synced | at most 6 characters. The default `1xxxxxx` is deliberately invalid |
| Notional Amount | synced, number | greater than 0 |
| Premium Ccy | synced | at most 6 characters (default `2`) |
| Expiry Date | broadcast, date | a valid ISO date |
| Expiry Days | derived, number | whole number ≥ 0 ("Expiry date is in the past") |
| Delivery Date | broadcast, date | a valid ISO date; not before Expiry Date (rule) |
| Settlement Style | broadcast, dropdown | Cash or Delivery (default Delivery) |
| Settlement Ccy | broadcast | at most 6 characters; shown and validated only for Cash |
| Fixing Source | broadcast, async dropdown | exists only for Cash (§7) |
| Strike | broadcast | at most 3 characters on an internal deal, 6 on an external one (a rule on deal data, F8) |
| Call / Put | broadcast | Call or Put; a Strategy's legs are one of each (a rule on the group, F9) |
| Buy / Sell | broadcast | Buy or Sell |
| Ccy Pair | broadcast | 6 uppercase letters, e.g. EURUSD |
| Expiry Cut | broadcast | at most 10 characters |
| Premium Date | broadcast, date | a valid ISO date |
| Spot Stream | deal only, read-only | (§9) |

| # | Requirement | Checked by |
| --- | --- | --- |
| F1 | Every field is validated for both product types; a cell with issues is marked as an error. | deal › "validates fields, for both product kinds"; e2e/fields |
| F2 | **Synced fields** (Notional Ccy, Notional Amount, Premium Ccy) move together, both ways: the deal and every product, whichever is edited. New products start from the deal's values. | deal › "syncs Notional Amount both ways…", "syncs Notional/Premium Ccy both ways, Average included"; grid › "a synced write reaches the deal and every product…" |
| F3 | **Broadcast fields**: a value entered in the deal column is written into every product. The deal keeps nothing (its cell stays empty), and an empty value goes nowhere. | deal › "broadcasts every field to every product and keeps nothing on the deal"; grid › "broadcasts from the deal column…" |
| F4 | **Expiry Days** is the number of days until Expiry Date. It is writable: typing N sets Expiry Date to today + N. | deal › "derives Expiry Days…"; e2e/fields › "Expiry Days follows Expiry Date…" |
| F5 | **Delivery Date can't be before Expiry Date.** The check reruns when either changes, including from a deal broadcast. | deal › "checks Delivery Date against Expiry Date", "re-checks the date rule when the deal broadcasts a date"; e2e/fields |
| F6 | **Visibility:** Settlement Ccy shows only while the style is Cash. Hidden, its data is kept but not validated. | productConfig › "shows and validates a field only while its visibility condition holds" |
| F7 | A product config that can't work fails at load: a missing field, a field listed twice, a path not in the data, a rule listening to something that's not its product's data, its group, or a deal key. | productConfig › "fails on load for a config that can't work", "a rule listens to its product's data or the deal…" |
| F8 | **Rules can read their group and their deal.** A product's validation rule declares what it reads (`listen`): paths in its own product's data; its group's type (`groups.$GROUP_ID.groupType`) and a value across every product of its group (`groups.$GROUP_ID.products.*.data.<path>`, read as a list in display order, its own included); deal keys (Notional Ccy/Amount, Premium Ccy, Internal, Hedge Type). It is re-checked exactly when one of them changes, a group mate's edit or a deal change included, and its cells repaint. Reading a path it doesn't listen to throws. First use on the deal: Strike's length depends on Internal. | deal › "checks Strike against the deal…"; grid › "a deal setting a rule reads repaints the cells it validates…", "an edit repaints its group mates' cells…"; productConfig › "a rule listens to its product's data, its group or the deal…"; e2e/fields › "Strike takes 3 characters on an internal deal…" |
| F9 | **A Strategy's legs are one Call and one Put** (an example of a rule on the group: drop it if it isn't a real requirement). Judged once both legs hold Call or Put; both legs are flagged; other groups, and a clone's legs, are judged on their own. | deal › "checks a Strategy's legs against each other…"; grid › "an edit repaints its group mates' cells…"; e2e/fields › "a Strategy's legs are one Call and one Put" |

## 5. Deal settings

| # | Requirement | Checked by |
| --- | --- | --- |
| S1 | Two settings in their own subgrid, beside the deal column from row 3: Hedge Type and Internal (Yes/No, default Yes). | e2e/grid › "the settings subgrid…" |
| S2 | Hedge Type's options depend on Internal: a/b/c when internal, d/e/f when not. When the options change, the current value is kept if still offered, otherwise the first option. A value not offered is ignored. | grid › "the deal settings: hedge type options follow Internal…"; e2e/grid |

## 6. Writing by path

| # | Requirement | Checked by |
| --- | --- | --- |
| P1 | Any path can be read: product data, the deal's synced fields, its settings. | paths › "reads any path…" |
| P2 | A batch of path writes is applied in order as **one** update; each product gets only its own writes. | paths › "writes a batch of paths…"; grid › "a paste is one batch…" |
| P3 | Writes by path keep every field's rules: sync, broadcast, derived, read-only, settings. | paths › "keeps each field's rules…" |
| P4 | A path that isn't a declared field is written as is; a path the deal doesn't have is ignored. | paths › "a path that isn't a declared field…" |
| P5 | **Deal logic** runs with every write, as reducers in order (the original app's `onStoreChanges`). Each reducer sees the changes so far; what reducers add is marked as not the user's. | productConfig › "gives each reducer the changes so far…" |
| P6 | The one reducer today: picking a valid ccy pair (deal or product) sets Notional Ccy to its base currency (EURUSD → EUR), which then syncs. An invalid pair does nothing. | productConfig › "runs the deal logic with every write…" |

## 7. Fixing Source (async options)

Options come from an API (`jsonplaceholder.typicode.com/users`, with
`settlementStyle` as a query parameter), one list per style.

| # | Requirement | Checked by |
| --- | --- | --- |
| O1 | A product has no Fixing Source (not even an empty one) unless its style is Cash; a Delivery product loads nothing. | fixingSources › "has no fixing source unless Cash…"; e2e/options › "against the real API…" |
| O2 | Switching to Cash adds the field with the first option once loaded; leaving Cash removes it. | fixingSources › "adds the fixing source on Cash…"; e2e/options |
| O3 | Broadcasting a style makes one request; a value that is still an option is kept, otherwise the first option is taken. | fixingSources › "broadcasts a style with one request…" |
| O4 | A response for a style the product has since left is ignored. | fixingSources › "ignores a response for a style the product has already left" |
| O5 | A Fixing Source broadcast reaches only Cash products. | fixingSources › "broadcasts a fixing source only to Cash products" |
| O6 | A style and the fixing source it creates can arrive in one paste, in that order. | grid › "a style and the fixing source it creates land in one paste…"; paths › "a fixing source exists only for Cash…" |
| O7 | While loading, the cell shows "Loading…". The deal column offers Cash's options. | e2e/options |
| O8 | A failed request: the cell says "Failed to load", values are left alone, and the rest of the app keeps working. | fixingSources › "leaves values alone when a request fails"; e2e/options › "when the request fails…" |

## 8. Calculation

A fake pricing request (`src-shared/api/calculate.ts`): price = sum over
products of 1 + Notional Amount / 1000, rounded to 2 decimals, after about
2 s (20 ms in store tests).

| # | Requirement | Checked by |
| --- | --- | --- |
| C1 | The deal is **ready** when no field has an issue and no options request is pending. Calculate is disabled otherwise. | autocalc › "calculates nothing while the deal has validation errors"; e2e/autocalc |
| C2 | **Autocalc** (on by default): whenever the deal is ready and its price is missing or outdated, it calculates. It waits for pending options. | autocalc › "calculates once the deal is valid…", "waits for a slow fixing source…" |
| C3 | Any product edit outdates the price and supersedes a calculation in flight: only the latest request's price is shown. An invalid edit leaves the price outdated. | autocalc › "recalculates on every edit; an invalid edit leaves the price outdated" |
| C4 | With autocalc off, only Calculate calculates. Turning it back on catches up. | autocalc › "with autocalc off…" |
| C5 | Price display: "—", "Calculating…", the price, "<price> (outdated)", or "Calculation failed". | e2e/autocalc |

## 9. Spot stream and developer switches

| # | Requirement | Checked by |
| --- | --- | --- |
| D1 | Spot Stream (deal column, read-only) ticks every 500 ms. Ticks are kept outside the state library: they repaint only that cell and never notify the store. | e2e/devtools › "the spot stream follows its toggle…" |
| D2 | Two app-wide switches, Autocalc and Spot Price Stream, persist across a reload (localStorage). | e2e/devtools; e2e/autocalc |
| D3 | Effector Nested only: the switch stays in sync across browser tabs. | e2e/devtools › "effector-nested: the toggle is kept in sync…" |

## 10. Grid behaviour

| # | Requirement | Checked by |
| --- | --- | --- |
| E1 | Edits commit on Enter, never while typing; Escape cancels. Typing over a selected cell starts an edit that replaces it. | e2e/fields › "edits commit on Enter…", "typing over a cell…" |
| E2 | Tab order follows field priority: Notional Amount, Expiry Date, Strike, then display order. Read-only cells and missing fields are skipped, and Tab moves on to the next column. Enter after an edit moves on the same way. | gridHelpers › "keyboard order"; e2e/grid › "Tab follows the field priority…", "Enter after an edit…" |
| E3 | Arrows move to the neighbouring cell, passing over the labels column and across into the settings subgrid row for row. Tab goes through the settings top-down, then into the deal. | e2e/grid › "the settings subgrid…" |
| E4 | Copy: a range as tab-separated text, dropdowns as their labels. Cells holding tabs, newlines or quotes round-trip as spreadsheets quote them. | e2e/grid › "copies a range…"; gridHelpers › "tab-separated text" |
| E5 | Paste: a block from the active corner (over the labels column); a single value fills a selection. Text is parsed by field type, and a dropdown takes a label. Unknown values, read-only cells and missing fields are skipped, and the result is reported ("Pasted 2 cells, skipped 1"). | e2e/grid › "pastes a block…"; gridHelpers › "paste", "cell values" |
| E6 | A paste into the deal column broadcasts and syncs like an edit. | e2e/grid › "a paste into the deal column…" |
| E7 | **Only touched cells repaint:** an edit repaints its cell, a synced field its row, and a paste each pasted cell once. One batch means one update. | e2e/grid › "repaints only the cells a change touches"; grid › "a paste is one batch…" |

## 11. Per-library guarantees

How each version achieves "only what changed updates" is part of what's being
compared. Each has its own test in `tests/stores/libraries.test.ts`:

- MobX: a reaction reruns only for the field it reads.
- MobX-State-Tree, Redux, Effector Nested: a write copies only the path to its
  product, and nothing changes when the value doesn't.
- mobx-keystone: a clone gets new ids and its own copy of the data.
- Legend-State: a write sets only its own leaf, and only when its value changes.
- Zustand: a write copies only the path to its product, notifies once per
  batch, and doesn't notify at all when no value changes.
- Jotai: a write sets only its own product's data atom, once per batch,
  copying only the path to the field; nothing is set when no value changes,
  and other products aren't re-validated.
- Effector Model: a write reaches only its own product's stores; a store per
  path updates only when its own value changes.

## 12. Dev-only tooling

- Each version reports its updates to the Redux DevTools extension when
  installed (dev builds only), and logs them to the console with `?debug`.
  Time travel where the library allows it.

## Open questions

- §0: the goal, the evaluation criteria and the decision process (owner).
- Is the spot stream a real requirement or a stand-in for any high-frequency
  value?
- The pricing request and the fixing-source API are fakes: what do the real
  ones look like (latency, failure modes, what else depends on them)?
- `original-app/` has a second reducer (`onInverseCcyPairAlsoInverseNotionalCcy`)
  that isn't implemented: is it in scope?
