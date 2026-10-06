import { fileURLToPath } from "node:url";
import v8 from "node:v8";
import vm from "node:vm";
import { vi } from "vitest";
import type { PathDeal } from "@shared/pathDeal.ts";
import { productPath } from "@shared/paths.ts";
import { definitionOf, productTypeOf } from "@shared/products/productRegistry.ts";
import { type FakeApi, sleep } from "./fakeApi.ts";

/**
 * Helpers for the per-app regression tests (`<app>-review.test.ts`): what a
 * browser gives an app (localStorage, the Redux DevTools extension), a real
 * GC, and scenarios run through any app's `PathDeal`.
 */

/** An absolute path from the repo root (for `vi.doMock`). */
export const at = (relative: string) => fileURLToPath(new URL(`../../../${relative}`, import.meta.url));

/** A Map-backed localStorage, on `globalThis` (and on `window`, when one is stubbed first). */
export const installLocalStorage = (initial: Record<string, string> = {}) => {
  const data = new Map(Object.entries(initial));
  const storage = {
    get length() {
      return data.size;
    },
    key: (i: number) => [...data.keys()][i] ?? null,
    getItem: (key: string) => (data.has(key) ? data.get(key)! : null),
    setItem: (key: string, value: string) => void data.set(key, String(value)),
    removeItem: (key: string) => void data.delete(key),
    clear: () => data.clear(),
  };
  vi.stubGlobal("localStorage", storage);
  const window = (globalThis as unknown as { window?: Record<string, unknown> }).window;
  if (window) window.localStorage = storage;
  return data;
};

export type DevtoolsMessage = { type: string; state?: string; payload?: { type: string } };

/** One instance an app opened in the fake extension. */
export type FakeConnection = {
  name: string;
  /** Each `init` state and each `send` (action and state after it), as the extension serializes them. */
  inits: string[];
  sends: { action: { type: string }; state: string }[];
  /** While set, `send` throws (an extension that fails to serialize). */
  failing: boolean;
  /** A message from the extension's monitor (e.g. JUMP_TO_STATE with a recorded state). */
  dispatch(type: string, state?: string): void;
};

/**
 * A fake `window.__REDUX_DEVTOOLS_EXTENSION__` that records what each
 * connection is sent (serialized with its `serialize.replacer`, as the real
 * one does), with `location.search` as given (`?debug`).
 */
export const installFakeExtension = (search = "") => {
  const connections: FakeConnection[] = [];
  const extension = {
    connect(options: { name?: string; serialize?: { replacer?: (key: string, value: unknown) => unknown } }) {
      const serialize = (state: unknown) => JSON.stringify(state, options.serialize?.replacer as never) ?? "null";
      const listeners: ((message: DevtoolsMessage) => void)[] = [];
      const connection: FakeConnection = {
        name: String(options.name ?? ""),
        inits: [],
        sends: [],
        failing: false,
        dispatch: (type, state) => listeners.forEach((listener) => listener({ type: "DISPATCH", state, payload: { type } })),
      };
      connections.push(connection);
      return {
        init: (state: unknown) => connection.inits.push(serialize(state)),
        send: (action: { type: string }, state: unknown) => {
          if (connection.failing) throw new Error("the extension failed");
          connection.sends.push({ action, state: serialize(state) });
        },
        subscribe: (listener: (message: DevtoolsMessage) => void) => listeners.push(listener),
        unsubscribe: () => {},
      };
    },
  };
  const location = { search };
  vi.stubGlobal("window", { __REDUX_DEVTOOLS_EXTENSION__: extension, location });
  vi.stubGlobal("location", location);
  return { connections, byName: (name: string) => connections.find((connection) => connection.name === name) };
};

let gc: (() => void) | undefined;
/** A real garbage collection (V8's `gc`, exposed at runtime), after pending timers. */
export const forceGc = async () => {
  if (!gc) {
    v8.setFlagsFromString("--expose-gc");
    gc = vm.runInNewContext("gc") as () => void;
  }
  for (let i = 0; i < 4; i++) {
    await sleep(0);
    gc();
  }
};

/** A product field's dot path: the `productIndex`-th product of the `groupIndex`-th group. */
export const fieldPathIn = (deal: PathDeal, groupIndex: number, fieldId: string, productIndex = 0) => {
  const group = deal.getGroups()[groupIndex];
  const productId = group.productIds[productIndex];
  const { data } = deal.getProduct(productId)!;
  return productPath(group.id, productId, (definitionOf(productTypeOf(data)).fieldPaths as Record<string, string>)[fieldId]);
};

export const readFieldIn = (deal: PathDeal, groupIndex: number, fieldId: string) =>
  deal.readPath(fieldPathIn(deal, groupIndex, fieldId));

/** The lists the scenarios below start from: Cash offers 3, then 4. */
export const cashLists = () => ({ Cash: [{ id: 3, name: "Shared" }, { id: 4, name: "C4" }] });

/** Deal A on Cash, its fixing source the first option (3), with a valid deal. */
const onCash = async (deal: PathDeal) => {
  deal.addGroup("VanillaGroup");
  deal.writePaths([
    { path: "notionalCcy", value: "USD" },
    { path: fieldPathIn(deal, 0, "settlementStyle"), value: "Cash" },
  ]);
  await sleep(60);
};

/**
 * Options arriving reconcile every deal still on that parameter, not just
 * the deal that asked: deal B's own load (its deal column's Cash options)
 * brings a list without A's value. Returns A's fixing source before and after.
 */
export const crossDealReconcile = async (api: FakeApi, newDeal: () => PathDeal) => {
  const a = newDeal();
  await onCash(a);
  const before = readFieldIn(a, 0, "settlementFixingSource");
  api.lists.Cash = [{ id: 4, name: "C4" }]; // 3 is no longer offered
  newDeal(); // B loads Cash's options: nothing in A asked
  await sleep(60);
  return { before, after: readFieldIn(a, 0, "settlementFixingSource") };
};

/**
 * Options arriving start one calculation, not two: a clone, still on 3,
 * reloads Cash's options, which no longer offer 3. `started` counts the
 * calculations started (by request id) since the call. Autocalc must be on.
 */
export const oneCalculationOnArrival = async (api: FakeApi, deal: PathDeal, started: () => number) => {
  await onCash(deal);
  api.lists.Cash = [{ id: 4, name: "C4" }];
  const before = started();
  deal.cloneGroup(deal.getGroups()[0].id);
  await sleep(60);
  return {
    fixings: [readFieldIn(deal, 0, "settlementFixingSource"), readFieldIn(deal, 1, "settlementFixingSource")],
    started: started() - before,
  };
};

/**
 * How many groups a product lookup visits: counts reads of each group's
 * `products` (the raw group objects as the app keeps them) while every
 * product of the last group is looked up, by `getProduct` and `fieldIssues`.
 */
export const groupsVisitedByLookup = (deal: PathDeal, rawGroups: () => Record<string, object>) => {
  const groups = rawGroups();
  let reads = 0;
  for (const group of Object.values(groups)) {
    const products = (group as { products: unknown }).products;
    Object.defineProperty(group, "products", {
      configurable: true,
      enumerable: true,
      get: () => {
        reads += 1;
        return products;
      },
    });
  }
  const last = deal.getGroups().at(-1)!;
  for (const productId of last.productIds) {
    deal.getProduct(productId);
    deal.fieldIssues(productId, "strike");
  }
  return reads / (last.productIds.length * 2);
};

/** The two switches, as an app holds them. */
export type Switches = { isSpotPriceStreamEnabled: boolean; isAutocalcEnabled: boolean };

/** Stored values, and the switches each must give: bad ones fall back to the defaults key by key. */
export const storedSwitchCases: [string, Switches][] = [
  ["not json", { isSpotPriceStreamEnabled: true, isAutocalcEnabled: true }],
  ["null", { isSpotPriceStreamEnabled: true, isAutocalcEnabled: true }],
  ["[]", { isSpotPriceStreamEnabled: true, isAutocalcEnabled: true }],
  ["42", { isSpotPriceStreamEnabled: true, isAutocalcEnabled: true }],
  [JSON.stringify({ isAutocalcEnabled: "no" }), { isSpotPriceStreamEnabled: true, isAutocalcEnabled: true }],
  [JSON.stringify({ isAutocalcEnabled: false }), { isSpotPriceStreamEnabled: true, isAutocalcEnabled: false }],
  [JSON.stringify({ isSpotPriceStreamEnabled: false, isAutocalcEnabled: null }), { isSpotPriceStreamEnabled: false, isAutocalcEnabled: true }],
];
