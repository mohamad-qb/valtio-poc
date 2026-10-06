# Handoff

State as of 2026-10-06. All ten apps are complete and passing.

Last verified: `npx tsc -b` clean; `pnpm test` 729/729; Playwright 292/292
(every app).

## Review fixes (branch `review-fixes`)

A review and battletest of all ten apps found bugs that every app shared
(they lived in `src-shared` or in the shared layout), and some that were
library-specific. The fixes, each with a test that failed before it:

- **Every app:**
  - The first group is created with the deal, in the tab store's add-deal
    action, and no longer in `Deal`'s mount effect. Switching tabs used to
    add a Vanilla Group each time (an inactive tab's `Deal` unmounts).
  - Options are shared, so when a list arrives, **every** deal still on that
    parameter reconciles (REQUIREMENTS O9), and does so before the load
    counts as done. Each options store keeps a registry of the deals'
    reconciles (`onLoaded(reconcile)` / `onOptionsLoaded`); a deal's
    `dispose` unregisters it.
  - `PathDeal` lookups use a productId → groupId index instead of scanning
    every group.
  - Every deal has a `dispose`, and the test adapters call it.
  - The two switches are loaded key by key: a corrupt or wrong-typed stored
    value falls back to that switch's default.
- **Shared rules** (`src-shared`):
  - Paths through `__proto__`/`constructor`/`prototype`, paths under a
    leaf, and `productType` are never written.
  - An object written over declared fields is expanded into field writes.
  - Synced values take the field's type (`asSyncedValue`).
  - Null or blank broadcasts go nowhere.
  - Expiry Days is bounded to ±100,000 days.
  - Option labels reconcile to their values.
  - Internal is applied before Hedge Type.
  - A write that ends where it started changes nothing.
  - The deal column's Expiry Days is a broadcast.
  - A failed options load no longer leaves the product invalid.
  - `createChangeHub` isolates listeners.
  - The router fans a synced field out once per batch.
- **Grid** (`src-shared/grid`):
  - One number parser for typing and paste.
  - An open editor is closed before columns change.
  - Tab leaves the grid.
  - Honest paste counts.
  - Copy keeps a trailing empty cell.
  - The cell notifier and SlickGrid headers no longer leak.
  - One product lookup per cell, and column rebuilds coalesced.
  - A phone-width layout.

### Gotchas from the fixes (keep these)

- **The SlickGrid header-leak fix reaches into SlickGrid's private
  `_bindingEventService`** (`releaseDetachedHeaders` in `dealGrid.ts`).
  Check it after any SlickGrid upgrade.
- Legend-State's node pruning uses `internal.getNode`, and Valtio's devtools
  use `unstable_enableOp`. Both are unstable APIs.
- `useOnMount` now honours a returned cleanup: with one, a remount runs the
  callback again.

## Valtio: design

- One proxy per deal; writes are plain assignments of the shared rules'
  leaf changes.
- **Validation is derived, not stored:** `issuesOf` caches each product's
  issues by its `snapshot` in a WeakMap, and `pathDeal` has one deep
  `subscribe` per product's data. So nothing binds to nested proxies, and an
  object written over a container keeps validating and repainting.
- `valtio-reactive` is gone (it slowed every proxy read). The two effects
  are `subscribeKey`s.
- Devtools report through the shared `createActionLog`, with no time travel:
  valtio's own `devtools()` jumps wiped every `actions` object.
- The switches persist with a plain localStorage load and save
  (`valtio-auto-persist` saved 100 ms late, under a key derived from the
  state's shape).

## Legend-State: design

- The whole app is one observable tree of plain data: every deal sits under
  `multiTab$.deals[dealId]`. Each deal's actions and computeds live beside the
  tree in `dealStores` (a `Map`), because computeds aren't data.
- Group titles aren't stored: they follow from `groupIds`.
- Writes: the shared rules plan each product write; the store sets the changed
  leaves one by one inside a `batch`, together with the "price outdated"
  write (one notification per keystroke). Listeners get the changed paths, so
  one `onChange` on `groups` tells the grid which products changed (path
  segment 2).
- Validation: one cache of issues per product id, cleared on that product's
  writes, and one `hasValidationErrors$` computed over the groups. (Per-field
  computeds leaked about 386 KB per add/remove cycle.)
- The two switches persist with a plain localStorage load and save.
- Devtools: Legend-State has no actions, so each batch of changes is reported,
  named by its paths. No time travel.

### Gotchas (keep these)

- **Legend-State writes into the stored objects in place.** Never put a shared
  object (e.g. `initialCalcState`) into the tree; `initialDealState()` copies
  them.
- **A listener that throws inside a Legend batch stops every notification on
  the page for good.** In 3.0.0-beta.48, `endBatch` has no try/finally. Every
  listener the app registers is wrapped in `isolated` (`stores/listeners.ts`).
- **Computed values can be stale while a batch is still notifying listeners.**
  Autocalc therefore only schedules a microtask and checks again once
  everything has settled (`queueMicrotask(autocalc)` in `dealStore.ts`).
- **Deleting an object key doesn't prune Legend's nodes.** `removeGroup` drops
  the group's node itself.
- Setting `NaN` over `NaN` counts as a change in Legend-State, so writes are
  applied only where the shared rules report a change.

## Redux: design

- One store: `tabs`, `deals`, `options`, `devtools`, all plain immutable data.
  Titles, validation issues and readiness are derived (`selectors.ts`).
- Actions are events (`actions.ts`: `pathsWritten`, `groupInserted`,
  `optionsReceived`, ...). Every slice that cares handles the same action in
  one dispatch, so e.g. an edit and its pending options load land together.
- **Actions carry intents, not results:** `pathsWritten` is
  `{dealId, writes, requests, pending}`, and the reducer routes the writes
  itself. Skipping an action in DevTools keeps the deal and its products in
  step. The thunk's routing is reused per (deal, writes) in `routedWrites`.
- **The in-flight load count lives outside the state** (`ThunkExtra.loads`).
  Every action that starts or settles a load carries the count, so a state
  committed mid-load corrects itself on the next action.
- Spot price streams live outside the store (thunk `extraArgument`). They are
  created on first use, so a deal restored from the action log has one.
- Autocalc: one listener-middleware listener in `store.ts`.
- Validation: `issuesOf(data)` is cached per data object in a `WeakMap`; an
  edit is a new object, so only the edited product is re-validated.
- Switches persist to localStorage in `stores/app.ts`, on the toggle actions
  only, so a DevTools jump never saves.

## Zustand: design

- One vanilla store per deal of plain immutable data, with `actions` inside.
  Global stores for tabs, options and the two switches.
- `writePaths` routes the batch with the shared rules and applies it in one
  `set`. Product data comes from `planProductWrites(...).data`, so only the
  path to a change is copied. When nothing changes there is no `set`.
- Validation and readiness are selectors (`validation.ts`): `issuesOf(data)`
  is cached per data object, as in Redux.
- `pathDeal.ts`: one subscription; changes are found by identity.
- Devtools: zustand's own `devtools` middleware (one instance per store,
  `Deal <n> (Zustand)`). Time travel works through a `serialize.replacer` that
  leaves the actions, the stream, the deal stores and `calc` out. Empty
  numbers come back `null` after a jump, because the middleware has no
  reviver.

### Gotchas (keep these)

- **A `set` with a partial always notifies, even if nothing changed.** Skip
  the `set` instead (`isUnchanged`, `settle`).
- **Listeners run synchronously in subscription order, and one can `set`
  again** (autocalc). A later listener is then called for the newer state
  first, and again with an older `prev`. Compare with what you saw last
  (`pathDeal.ts`).
- **Send the price request before the `set` that marks it started.** A
  listener that throws would otherwise leave the deal "Calculating…" forever.

## Jotai: design

- Atoms in atoms, in the default store (no Provider). A deal is a plain
  object of atoms: deal fields, settings, group ids, groups and calc. Each
  group has a `uiAtom`; each product has a `dataAtom` and a derived
  `issuesAtom`. Readiness and the error flag are derived from the issues
  atoms only.
- Every action is a write atom, exposed as
  `actions.x = (...) => store.set(xAtom, ...)`. Jotai flushes listeners once
  at the end of the outermost write, so a paste is one update.
- `pathDeal.ts`: `store.sub` on each product's `dataAtom`, plus the group
  order, deal fields, settings and options. Issues follow the data.
- The switches persist through `atomWithStorage` with a storage that has no
  `subscribe` (otherwise they would follow other browser tabs), and merges
  the defaults.
- Devtools: jotai's own are React-only, so `devtools.ts` wraps `store.set` and
  reports each outermost write through `createActionLog`. No time travel.

### Gotchas (keep these)

- **Never call `store.set` inside a write atom:** it flushes the outer batch
  midway. Use the write's `set`.
- **After an `await`, each `set` is its own batch.** Arriving options set
  their state, every deal's reconcile and the end of the load in one write
  atom (`loadDoneAtom`).
- **In vitest the default store outlives `vi.resetModules()`.** Isolation
  relies on atoms being new per test, and on `dispose`.

## MobX family: notes from the fixes

- **MobX:**
  - Inputs are marked changed inside the actions that write products.
  - `pathDeal` compares `toJS` snapshots structurally, replacing the old
    `JSON.stringify`, which couldn't see NaN ↔ Infinity.
  - Stores and async steps are named for the devtools.
- **MobX-State-Tree and mobx-keystone:**
  - Time travel revives `null` → NaN at number fields
    (`withNumbersRevived`, shared).
  - A jump never re-prices the deal (a restoring flag).
  - `hasValidationErrors` keeps every product's issues observed, so they
    stay cached.
- **mobx-keystone:** one DevTools instance; `calc` and the options states are
  `frozen()`.

## Effector: notes from the fixes

- **Both apps:**
  - Each deal is built inside `withRegion`, and `dispose` calls `clearNode`.
  - Each deal is created with its own sids (`withFactory`).
  - The deal's own options load through `loadDealOptionsAction`, inside the
    caller's scope.
- **Effector Model:**
  - `@effector/model` 0.0.8 updates each group separately, so a batch over N
    groups is still N `$groups` updates. Pricing waits for the whole batch
    (`settleFx`), so it outdates the price and calculates once.
  - The switches don't sync across browser tabs (`sync: false`; D3 is
    Effector Nested only).
  - `pathStore` was removed.
- **DevTools:** the adapter's batch size is raised, so a paste isn't
  truncated.

## Open items

- **Redux time travel still reads the clock:** derived Expiry Days uses
  today's date in the reducers, so replaying on another day gives other
  dates. Fixing it needs a `today` threaded through the shared write
  planner.
- **A jump to a state recorded mid-calculation** shows "Calculating…" until
  that request answers. This affects MobX-State-Tree and mobx-keystone.
- **Expiry Days doesn't move at midnight on its own:** it's computed when the
  date is written.
- **The options `pending` count is global:** one deal's load disables
  Calculate in every tab.
- **Legend-State is on a beta (`3.0.0-beta.48`).** Check for a stable v3,
  and whether `endBatch` gets a try/finally.
- **Shared helpers would cut repeated code:** each app repeats the switch
  load/save (about 18 lines), the product index (about 12) and the reconcile
  registry.
