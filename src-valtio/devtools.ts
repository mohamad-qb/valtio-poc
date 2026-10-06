/**
 * Development-only tooling, loaded by `main.tsx` in dev builds only, so none
 * of it reaches the production bundle.
 *
 * - Redux DevTools (browser extension, when installed): valtio has no
 *   actions, so each batch of changes (a tick's worth) is reported, named by
 *   the paths it changed, with the app's state after it. No time travel: the
 *   stores hold their actions and streams, which a jump's JSON would wipe.
 * - `?debug` in the URL: the same changes, logged to the console.
 */
import { type INTERNAL_Op, snapshot, subscribe, unstable_enableOp } from "valtio";
import { createActionLog } from "@shared/reduxDevtools.ts";
import { multiTabStore } from "./stores/multiTabStore.ts";
import { optionsStore } from "./stores/optionsStore.ts";

// the changed paths are only handed to subscribers once enabled (as valtio's own devtools do)
unstable_enableOp();

/** The app as plain data: each deal without its actions and stream. */
const stateOf = () => {
  const { activeDealId, devtools, deals } = snapshot(multiTabStore);
  return {
    activeDealId,
    devtools,
    deals: Object.fromEntries(
      Object.entries(deals).map(([dealId, { actions: _actions, spotPriceStream: _stream, ...deal }]) => [dealId, deal]),
    ),
    options: { byKey: snapshot(optionsStore.byKey), pending: optionsStore.pending },
  };
};

const report = createActionLog({ name: "Deal editor (Valtio)", getState: stateOf });

/** Reports one batch: its first changed path (and how many more), each change as an argument. */
const reportChanges = (prefix: readonly string[]) => (ops: INTERNAL_Op[]) => {
  const paths = ops.map(([, path]) => [...prefix, ...path.map(String)].join("."));
  report(
    paths.length === 1 ? paths[0] : `${paths[0]} (+${paths.length - 1})`,
    ops.map((op, i) => ({ path: paths[i], value: op[0] === "set" ? op[2] : undefined })),
  );
};

subscribe(multiTabStore, reportChanges([]));
subscribe(optionsStore, reportChanges(["options"]));
