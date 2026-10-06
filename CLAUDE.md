- Do not run prettier, eslint, or any lint/format scripts unless I ask.
- Plan the complete change before editing. Prefer one complete write per file
  over many small incremental edits. Don't edit, run, and re-edit in loops
  unless I ask.
- Never write logical assignment (`||=`, `&&=`, `??=`); use a plain `if`.

## What this repo is

One deal-editor app (an FX deal: groups of products in a SlickGrid), built
again with several state-management libraries to compare them. Each version
is its own folder and HTML entry; everything library-independent lives in
`src-shared/` (imported as `@shared/...`).

| App | Folder | Entry |
| --- | --- | --- |
| Valtio | `src-valtio/` | `valtio.html` |
| MobX | `src-mobx/` | `mobx.html` |
| MobX-State-Tree | `src-mobx-state-tree/` | `mobx-state-tree.html` |
| mobx-keystone | `src-mobx-keystone/` | `mobx-keystone.html` |
| Legend-State (v3 beta) | `src-legend-state/` | `legend-state.html` |
| Redux Toolkit | `src-redux/` | `redux.html` |
| Zustand | `src-zustand/` | `zustand.html` |
| Jotai | `src-jotai/` | `jotai.html` |
| Effector, nested state | `src-effector-nested/` | `effector-nested.html` |
| @effector/model | `src-effector-model/` | `effector-model.html` |

`original-app/` holds excerpts of the app being migrated, for reference.

## How the apps fit together

- Every app exposes its deal as a `PathDeal` (`src-shared/pathDeal.ts`): read
  and written by dot path (`groups.<groupId>.products.<productId>.data.<field>`
  or a deal key), the way the original app works. The grid
  (`src-shared/grid/`) and the tests talk to a deal only through it.
- The rules are shared and pure: write routing and deal logic
  (`dealWrites.ts`, `dealLogic/`), product writes and derived fields
  (`products/productWrites.ts`), validation (`validation.ts`), calculation
  state (`calc.ts`), async options (`options/optionsSource.ts`). An app only
  decides how to store the result and how to notice changes.
- Validation rules (`rules` in a product config) read only through
  `read(path)`, by the paths in their `listen`: the product's own data
  (`groups.$GROUP_ID.products.$PRODUCT_ID.data.…`) or a deal key
  (`isInternal`, `notionalCcy`, …). Reading anything else throws. Every app
  re-checks a field when its `validationInputs` change, deal keys included:
  tracked reads (MobX, Legend-State, Jotai), subscriptions (Valtio), or
  `createIssuesMemo` for immutable data (Redux, Zustand, Effector). Group
  paths and `*` wildcards aren't supported yet.
- Each app has the same layout: `stores/` (deal, options, tabs, `pathDeal.ts`),
  `components/layout/` (`MultiDeal`, `Deal`, `DealHeader`), a provider, and
  `devtools.ts` (dev only: Redux DevTools extension, `?debug` logging).
- Shared modules are imported by every app: a change there affects all of them.

## Adding an app

Copy the closest existing app, then register it in all of these:
`vite.config.ts` (build input, plus a babel plugin if it needs one),
`tsconfig.app.json` (`include`), `index.html` (landing-page link), and the
test lists: `tests/stores/support/adapters.ts` (`AppName`, `appNames`, an
adapter), `tests/e2e/support/fixtures.ts` (`apps`), `tests/e2e/layout.spec.ts`
(landing-page links). Library-specific guarantees go in
`tests/stores/libraries.test.ts`.

## Checking a change

- Types: `npx tsc -b`
- Store tests (every scenario, every app): `pnpm test` (vitest, Node)
- Browser tests: `pnpm test:e2e` (Playwright, installed Chrome, port 5173).
  Narrow with `-g "<app>"`.
- I usually have my own `vite` dev server running on 5173, and Playwright
  reuses it. Don't start other Vite servers in this repo: they share
  `node_modules/.vite` and break mine ("504 Outdated Optimize Dep"). If e2e
  fails for apps you didn't touch, suspect a stale server first and ask before
  restarting mine. Kill any server you started by PID.

## Requirements and current work

- `REQUIREMENTS.md`: what every version must do, each requirement linked to
  the test that checks it. Keep it in step when behaviour or tests change.
- `HANDOFF.md`: where things stand and what's next.
