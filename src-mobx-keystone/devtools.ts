/**
 * Development-only tooling, loaded by `main.tsx` in dev builds only, so none
 * of it reaches the production bundle.
 *
 * - Redux DevTools (browser extension, when installed): keystone's own
 *   adapter. Every action, nested ones as `parent >>> child`, with the tree's
 *   snapshot after it, and time travel (a jump comes back as recorded:
 *   nothing is re-priced). One instance: the shared options are in the tree.
 * - `?debug` in the URL: each outermost action, logged to the console.
 */
import { connectReduxDevTools, onActionMiddleware } from "mobx-keystone";
import { type DevtoolsConnection, type DevtoolsMessage, connectExtension, isDebugEnabled } from "@shared/reduxDevtools.ts";
import { restoring } from "./stores/dealModel.ts";
import { multiTabStore } from "./stores/multiTabStore.ts";

const name = "Deal editor (MobX Keystone)";

// the adapter takes the `remotedev` package only to read the state out of a
// monitor message; the extension's own connection does the rest
const remotedev = { extractState: (message: DevtoolsMessage) => JSON.parse(message.state ?? "null") };

/** The connection, with whatever the monitor applies (a jump, a reset) restored as recorded. */
const restoringFrom = (connection: DevtoolsConnection): DevtoolsConnection => ({
  init: (state) => connection.init(state),
  send: (action, state) => connection.send(action, state),
  subscribe: (listener) => connection.subscribe((message) => restoring(() => listener(message))),
});

const connection = connectExtension(name);
if (connection) connectReduxDevTools(remotedev, restoringFrom(connection), multiTabStore);
if (isDebugEnabled) {
  onActionMiddleware(multiTabStore, {
    onFinish: ({ actionName, targetPath, args }) => console.log(`[${name}] [/${targetPath.join("/")}] ${actionName}`, ...args),
  });
}
