/**
 * Development-only tooling, loaded by `main.tsx` in dev builds only, so none
 * of it reaches the production bundle.
 *
 * - Redux DevTools (browser extension, when installed): jotai's own devtools
 *   are React-only, so the store's `set` is wrapped here. Every top-level set
 *   is reported, with the app's state after it: an action (a write atom) by
 *   its `debugLabel`, any other atom by its key. So is whatever is set outside
 *   them (an async action's sets after its `await`: a response arriving). No
 *   time travel: each deal's atoms are created with it, so a past state can't
 *   simply be set back.
 * - `?debug` in the URL: the same actions, logged to the console.
 */
import { atom, getDefaultStore } from "jotai/vanilla";
import { createActionLog, isDebugEnabled } from "@shared/reduxDevtools.ts";
import { multiTabStore } from "./stores/multiTabStore.ts";
import { optionsStore } from "./stores/optionsStore.ts";

const store = getDefaultStore();

/**
 * The app as plain data: each deal's own state and its products' data, in
 * display order. Derived atoms (validation, readiness) and the spot stream
 * are left out: they follow from it.
 */
const stateAtom = atom((get) => ({
  activeDealId: get(multiTabStore.activeDealIdAtom),
  devtools: get(multiTabStore.devtoolsAtom),
  deals: Object.fromEntries(
    Object.entries(get(multiTabStore.dealsAtom)).map(([dealId, deal]) => {
      const groups = get(deal.groupIdsAtom).map((groupId) => {
        const { groupType, uiAtom, productIds, products } = get(deal.groupsAtom)[groupId];
        return {
          id: groupId,
          groupType,
          title: get(uiAtom).title,
          products: productIds.map((id) => ({ id, title: products[id].ui.title, data: get(products[id].dataAtom) })),
        };
      });
      return [dealId, { ...get(deal.dealFieldsAtom), ...get(deal.settingsAtom), calc: get(deal.calcAtom), groups }];
    }),
  ),
  options: { byKey: get(optionsStore.byKeyAtom), pending: get(optionsStore.pendingAtom) },
}));

const report = createActionLog({ name: "Deal editor (Jotai)", getState: () => store.get(stateAtom) });

// every action goes through `store.set` (`actions.*`): report each outermost
// one once all it set off is done (autocalc's calculation included)
const { set } = store;
let depth = 0;
store.set = (target, ...args) => {
  depth += 1;
  try {
    return set(target, ...args);
  } finally {
    depth -= 1;
    if (depth === 0) report(target.debugLabel ?? String(target), args);
  }
};

// a change outside any action (set after an `await`) shows as a new state of
// the whole app: watched only when something takes the reports, since that
// mounts every atom and rebuilds the state on every change
if (isDebugEnabled || "__REDUX_DEVTOOLS_EXTENSION__" in window) {
  store.sub(stateAtom, () => {
    if (depth === 0) report("(outside an action)", []);
  });
}
