/**
 * Development-only tooling, loaded by `main.tsx` in dev builds only, so none
 * of it reaches the production bundle.
 *
 * - Redux DevTools (browser extension, when installed): Legend-State has no
 *   actions, so each batch of changes is reported, named by the paths it
 *   changed, with the app's state after it. The state is plain data already
 *   (`peek()`). No time travel: each deal's computeds live beside its state.
 * - `?debug` in the URL: the same changes, logged to the console.
 */
import type { ListenerParams } from "@legendapp/state";
import { createActionLog } from "@shared/reduxDevtools.ts";
import { isolated } from "./stores/listeners.ts";
import { devtools$, multiTab$ } from "./stores/multiTabStore.ts";
import { options$ } from "./stores/optionsStore.ts";

const stateOf = () => ({ ...multiTab$.peek(), devtools: devtools$.peek(), options: options$.peek() });

const report = createActionLog({ name: "Deal editor (Legend-State)", getState: stateOf });

/** Reports one batch: its first changed path (and how many more), each change as an argument. Never throws into the batch (an extension that fails). */
const reportChanges = (prefix: string[]) =>
  isolated(({ changes }: ListenerParams) => {
    const paths = changes.map(({ path }) => [...prefix, ...path].join("."));
    report(
      paths.length === 1 ? paths[0] : `${paths[0]} (+${paths.length - 1})`,
      changes.map(({ valueAtPath }, i) => ({ path: paths[i], value: valueAtPath })),
    );
  });

multiTab$.onChange(reportChanges([]));
devtools$.onChange(reportChanges(["devtools"]));
options$.onChange(reportChanges(["options"]));
