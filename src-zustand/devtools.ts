/**
 * Development-only tooling, loaded by `main.tsx` in dev builds only, so none
 * of it reaches the production bundle.
 *
 * - Redux DevTools (browser extension, when installed): built into each store
 *   (zustand's `devtools` middleware), one instance per store: the tabs, the
 *   switches, the options and every deal. Each `set`, named by its action,
 *   with the store's state after it, and time travel: a jump sets the state
 *   back from the extension's JSON copy, all but the calculation (which it
 *   leaves as it is); an empty number comes back `null` (no reviver).
 * - `?debug` in the URL: each change, logged to the console.
 */
import type { StoreApi } from "zustand/vanilla";
import { isDebugEnabled } from "@shared/reduxDevtools.ts";
import { type MultiTabState, devtoolsStore, multiTabStore } from "./stores/multiTabStore.ts";
import { optionsStore } from "./stores/optionsStore.ts";

/** Logs a store's changes, as the values it replaced (a listener isn't told the action's name). */
const logChanges = <T extends object>(name: string, store: StoreApi<T>) =>
  store.subscribe((state, prev) =>
    console.log(
      `[Deal editor (Zustand)] ${name}`,
      Object.fromEntries(Object.entries(state).filter(([key, value]) => !Object.is(value, prev[key as keyof T]))),
    ),
  );

if (isDebugEnabled) {
  logChanges("tabs", multiTabStore);
  logChanges("devtools", devtoolsStore);
  logChanges("options", optionsStore);
  // every deal is a store of its own: logged from when it's added
  const logged = new Set<string>();
  const logNewDeals = ({ deals }: MultiTabState) => {
    for (const [dealId, dealStore] of Object.entries(deals)) {
      if (logged.has(dealId)) continue;
      logged.add(dealId);
      logChanges(`deal ${dealId}`, dealStore);
    }
  };
  logNewDeals(multiTabStore.getState());
  multiTabStore.subscribe(logNewDeals);
}
