/**
 * Development-only tooling, loaded by `main.tsx` in dev builds only, so none
 * of it reaches the production bundle. Unit names and code locations come
 * from `effector/babel-plugin` (see vite.config.ts).
 *
 * - Redux DevTools (browser extension, when installed): every event and
 *   store update.
 * - `?debug` in the URL: patronum's `debug` logs each deal's actions (every
 *   batch of path writes) and its own stores, and the shared options, with
 *   the chain of updates that led to each one.
 */
import { attachReduxDevTools } from "@effector/redux-devtools-adapter";
import { type Unit, is } from "effector";
import { debug } from "patronum";
import { $deals } from "./stores/multiTabStore.ts";
import { $optionsByKey, loadOptionsEffect } from "./stores/optionsStore.ts";

/**
 * The state tab serializes every store's value on every update. Some values
 * are live effector graphs (the deal models kept in the tabs store, and
 * `@effector/model`'s item instances and keyvals): the extension would copy
 * them whole each time, megabytes per edit. Show them as a label instead.
 */
const isLiveGraph = (value: object) =>
  ("type" in value && (value.type === "instance" || value.type === "keyval")) ||
  ("seq" in value && "family" in value); // a graph node
const replacer = (_key: string, value: unknown) => {
  if (is.unit(value)) return `[${value.kind}]`;
  if (typeof value === "object" && value !== null && isLiveGraph(value)) return "[effector graph]";
  return value;
};

if ("__REDUX_DEVTOOLS_EXTENSION__" in window) {
  // stateTab: every store's value in the State/Diff tabs (off by default)
  attachReduxDevTools({
    name: "Deal editor (Effector Model)",
    trace: true,
    stateTab: true,
    // logs are queued for 500 ms and the oldest dropped past `size` (100 by
    // default): a paste logs hundreds, so keep enough for one whole
    batch: { size: 2000 },
    devToolsConfig: { serialize: { replacer } },
  });
} else {
  console.info(
    "[devtools] Redux DevTools extension not found on this page: install it, or allow it on this site, then reload.",
  );
}

if (new URLSearchParams(location.search).has("debug")) {
  debug({ trace: true }, { $optionsByKey, loadOptionsEffect });

  // every deal's units are named after their variables, the same in every
  // deal: prefix them with the deal's tab
  const debugged = new Set<string>();
  $deals.watch((deals) =>
    Object.entries(deals).forEach(([dealId, { actions, $dealFields, $settings, $order }], index) => {
      if (debugged.has(dealId)) return;
      debugged.add(dealId);
      const units: Record<string, Unit<unknown>> = { ...actions, $dealFields, $settings, $order };
      debug(
        { trace: true },
        Object.fromEntries(Object.entries(units).map(([name, unit]) => [`Tab ${index + 1} ${name}`, unit])),
      );
    }),
  );
}
