# Deal editor: one app, ten state libraries

One FX deal editor (groups of products in a SlickGrid), built once per
state-management library to compare them for migrating an existing app.
Everything library-independent lives in `src-shared/`; each app only decides
how to store state and how to notice changes.

- **How the apps fit together, and how to add one:** [CLAUDE.md](CLAUDE.md)
- **What every version must do**, each requirement linked to its test:
  [REQUIREMENTS.md](REQUIREMENTS.md)
- **Design notes and gotchas per library, and open items:**
  [HANDOFF.md](HANDOFF.md)

| App | Folder | Page |
| --- | --- | --- |
| Valtio | [src-valtio](src-valtio) | `/valtio.html` |
| MobX | [src-mobx](src-mobx) | `/mobx.html` |
| MobX-State-Tree | [src-mobx-state-tree](src-mobx-state-tree) | `/mobx-state-tree.html` |
| mobx-keystone | [src-mobx-keystone](src-mobx-keystone) | `/mobx-keystone.html` |
| Legend-State | [src-legend-state](src-legend-state) | `/legend-state.html` |
| Redux Toolkit | [src-redux](src-redux) | `/redux.html` |
| Zustand | [src-zustand](src-zustand) | `/zustand.html` |
| Jotai | [src-jotai](src-jotai) | `/jotai.html` |
| Effector Nested | [src-effector-nested](src-effector-nested) | `/effector-nested.html` |
| Effector Model | [src-effector-model](src-effector-model) | `/effector-model.html` |

## Run

```sh
pnpm install
pnpm dev          # landing page links to every app
npx tsc -b        # types
pnpm test         # store tests: every scenario against every app
pnpm test:e2e     # browser tests (installed Chrome), narrow with -g "<app>"
```

## Code per app

Line counts per app folder, comments included. Shared code isn't counted.

| App | stores | components | devtools.ts | other | total | files |
| --- | ---: | ---: | ---: | ---: | ---: | ---: |
| Valtio | 583 | 197 | 44 | 73 | 897 | 15 |
| MobX | 679 | 154 | 61 | 26 | 920 | 14 |
| MobX-State-Tree | 541 | 153 | 29 | 24 | 747 | 13 |
| mobx-keystone | 552 | 154 | 35 | 24 | 765 | 13 |
| Legend-State | 617 | 168 | 33 | 22 | 840 | 12 |
| Redux Toolkit | 736 | 165 | 17 | 32 | 950 | 19 |
| Zustand | 695 | 197 | 42 | 21 | 955 | 14 |
| Jotai | 628 | 190 | 69 | 21 | 908 | 13 |
| Effector Nested | 656 | 180 | 80 | 58 | 974 | 14 |
| Effector Model | 627 | 180 | 67 | 58 | 932 | 13 |

Comment density differs a lot between apps (Effector Nested has the most), so
compare code lines too. Zustand and Jotai mirror Valtio file for file, so the
three can be diffed directly.
