import { afterEach, describe, expect, it, vi } from "vitest";
import type { ProductFieldId } from "@shared/fields.ts";
import { readField } from "@shared/products/productRegistry.ts";
import type { RootState } from "../../src-redux/stores/store.ts";
import { installFakeApi, sleep } from "./support/fakeApi.ts";

/**
 * Redux: what the DevTools (time travel, skip, commit, import) can do to the
 * state, and what must survive it. A stand-in for the extension, installed
 * before Redux Toolkit loads (it reads `window.__REDUX_DEVTOOLS_EXTENSION_COMPOSE__`
 * at import). Like the extension's in-page instrument it sits innermost
 * (middleware wraps it) and keeps every state:
 * - `jumpTo` changes the viewed state and notifies subscribers; no action
 *   goes through the middleware;
 * - while a past state is viewed, new actions are computed on the head and
 *   the view stays put (`getState()` returns the view);
 * - `commit` makes the viewed state the new starting point.
 */
type Action = { type: string; payload?: unknown };
type Reducer = (state: unknown, action: Action) => unknown;
type Instrumented = { states: unknown[]; actions: Action[]; index: number; jumpTo(index: number): void; live(): void; commit(): void };
const instances: Instrumented[] = [];

const instrument = () => (reducer: Reducer, preloaded: unknown) => {
  const listeners = new Set<() => void>();
  const notify = () => [...listeners].forEach((listener) => listener());
  const init = { type: "@@fake-devtools/INIT" };
  const self: Instrumented = {
    states: [reducer(preloaded, init)],
    actions: [init],
    index: 0,
    jumpTo(index) {
      self.index = index;
      notify();
    },
    live() {
      self.jumpTo(self.states.length - 1);
    },
    commit() {
      self.states = [self.states[self.index]];
      self.actions = [{ type: "@@fake-devtools/COMMIT" }];
      self.index = 0;
      notify();
    },
  };
  instances.push(self);
  return {
    getState: () => self.states[self.index],
    dispatch: (action: Action) => {
      const wasLive = self.index === self.states.length - 1;
      self.states.push(reducer(self.states[self.states.length - 1], action));
      self.actions.push(action);
      if (wasLive) self.index = self.states.length - 1;
      notify();
      return action;
    },
    subscribe: (listener: () => void) => {
      listeners.add(listener);
      return () => void listeners.delete(listener);
    },
    replaceReducer: () => {},
  };
};

type Enhancer = (createStore: unknown) => unknown;
(globalThis as Record<string, unknown>).window = {
  __REDUX_DEVTOOLS_EXTENSION_COMPOSE__:
    () =>
    (...enhancers: Enhancer[]) =>
    () =>
      enhancers.reduceRight<unknown>((composed, enhancer) => enhancer(composed), instrument()),
};

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

const loadRedux = async (autocalc = false) => {
  vi.resetModules();
  const { combineReducers } = await import("@reduxjs/toolkit");
  const { createApp } = await import("../../src-redux/stores/store.ts");
  const thunks = await import("../../src-redux/stores/thunks.ts");
  const { dealsReducer } = await import("../../src-redux/stores/dealsReducer.ts");
  const { optionsReducer } = await import("../../src-redux/stores/optionsReducer.ts");
  const { tabsReducer } = await import("../../src-redux/stores/tabsSlice.ts");
  const { devtoolsReducer } = await import("../../src-redux/stores/devtoolsSlice.ts");
  const { createPathDeal } = await import("../../src-redux/stores/pathDeal.ts");
  const devtools = { isSpotPriceStreamEnabled: false, isAutocalcEnabled: autocalc };
  const app = createApp(devtools);
  // the store's own reducers (store.ts doesn't export its root reducer), to replay a log as the monitor does
  const rootReducer = combineReducers({ tabs: tabsReducer, deals: dealsReducer, options: optionsReducer, devtools: devtoolsReducer });
  const replay = (actions: readonly Action[]) =>
    actions.reduce<unknown>((state, action) => rootReducer(state as never, action as never), { devtools }) as RootState;
  const dealId = app.store.dispatch(thunks.addDeal());
  app.store.dispatch(thunks.addGroup(dealId, "VanillaGroup"));
  const deal = createPathDeal(app.store, dealId);
  return { ...app, ...thunks, createPathDeal, devtools: instances.at(-1)!, replay, dealId, deal };
};

/** Every product's value of a field, in a given state. */
const productValues = (state: RootState, dealId: string, fieldId: ProductFieldId) => {
  const deal = state.deals[dealId];
  return deal.groupIds.flatMap((groupId) =>
    deal.groups[groupId].productIds.map((id) => readField(deal.groups[groupId].products[id].data, fieldId)),
  );
};

describe("redux: the DevTools", () => {
  it("skipping a write on replay keeps the deal and its products in step: actions carry the writes, not their result", async () => {
    const { deal, dealId, devtools, replay, dispose } = await loadRedux();
    deal.addGroup("Strategy");
    deal.writePaths([{ path: "notionalAmount", value: 500 }]);
    deal.writePaths([{ path: "premiumCcy", value: "EUR" }]); // an unrelated, later write
    await sleep(30);
    const skipped = devtools.actions.findIndex(
      (action) =>
        action.type === "deals/pathsWritten" &&
        (action.payload as { writes: { path: string }[] }).writes.some(({ path }) => path === "notionalAmount"),
    );
    expect(skipped).toBeGreaterThan(0);

    // the monitor's "Skip": every other action, through the reducers
    const state = replay(devtools.actions.filter((_, index) => index !== skipped));
    expect(state.deals[dealId].dealFields.notionalAmount).toBeNaN();
    expect(productValues(state, dealId, "notionalAmount")).toEqual([NaN, NaN, NaN]); // the deal and every product agree
    expect(productValues(state, dealId, "premiumCcy")).toEqual(["EUR", "EUR", "EUR"]); // the later write still lands
    dispose();
  });

  it("an edit made while a past state is viewed is routed from the head it applies to", async () => {
    const { deal, dealId, devtools, store, dispose } = await loadRedux();
    await sleep(30);
    const beforeAmount = devtools.index;
    deal.writePaths([{ path: "notionalAmount", value: 500 }]);
    devtools.jumpTo(beforeAmount); // looking at the past
    deal.writePaths([{ path: "premiumCcy", value: "EUR" }]);
    devtools.live();
    const head = store.getState();
    expect(head.deals[dealId].dealFields).toMatchObject({ notionalAmount: 500, premiumCcy: "EUR" }); // nothing reverted
    expect(productValues(head, dealId, "notionalAmount")).toEqual([500]);
    dispose();
  });

  it("a state committed while options were loading is ready again with the next action", async () => {
    const api = installFakeApi({ Cash: [{ id: 3, name: "Shared" }] });
    api.delays.Cash = 30;
    const { deal, dealId, devtools, store, dispose } = await loadRedux(true); // the deal column's Cash options: in flight
    deal.writePaths([{ path: "notionalCcy", value: "USD" }]);
    const midLoad = devtools.index;
    expect(store.getState().options.pending).toBe(1);
    await sleep(80);
    expect(store.getState().deals[dealId].calc.status).toBe("done");

    devtools.jumpTo(midLoad);
    devtools.commit(); // the viewed state is the new start: it counts a load that finished long ago
    deal.writePaths([{ path: "notionalAmount", value: 1000 }]);
    await sleep(80);
    expect(store.getState().options.pending).toBe(0);
    expect(store.getState().deals[dealId].calc.status).toBe("done"); // autocalc ran again
    dispose();
  });

  it("a deal restored from the action log has its spot price stream", async () => {
    const first = await loadRedux();
    await sleep(30);
    first.dispose();

    // "Import": the same actions, dispatched into a new store
    const { createApp } = await import("../../src-redux/stores/store.ts");
    const second = createApp({ isSpotPriceStreamEnabled: true, isAutocalcEnabled: false });
    for (const action of first.devtools.actions.slice(1)) second.store.dispatch(action as never);
    const restored = first.createPathDeal(second.store, first.dealId);
    expect(restored.getGroups()).toHaveLength(1);
    const before = restored.spotPriceStream.getValue();
    await sleep(1100); // it ticks every 500 ms
    expect(restored.spotPriceStream.getValue()).toBeGreaterThan(before);
    second.dispose();
  });
});

describe("redux: the stored switches", () => {
  /** A `localStorage` stand-in. */
  const stubStorage = (items: Record<string, string>) => {
    const values = new Map(Object.entries(items));
    vi.stubGlobal("localStorage", {
      getItem: (key: string) => values.get(key) ?? null,
      setItem: (key: string, value: string) => void values.set(key, value),
    });
    return () => JSON.parse(values.get("redux-devtools-settings") ?? "null");
  };
  const loadApp = async () => {
    installFakeApi();
    vi.resetModules();
    const { app } = await import("../../src-redux/stores/app.ts");
    const slice = await import("../../src-redux/stores/devtoolsSlice.ts");
    return { app, ...slice, devtools: instances.at(-1)! };
  };

  it("each is restored on its own: one that isn't a boolean falls back to its default", async () => {
    for (const [stored, expected] of [
      [JSON.stringify({ isAutocalcEnabled: "false", isSpotPriceStreamEnabled: false }), { isAutocalcEnabled: true, isSpotPriceStreamEnabled: false }],
      [JSON.stringify(null), { isAutocalcEnabled: true, isSpotPriceStreamEnabled: true }],
      [JSON.stringify([false]), { isAutocalcEnabled: true, isSpotPriceStreamEnabled: true }],
      ["{not json", { isAutocalcEnabled: true, isSpotPriceStreamEnabled: true }],
    ] as const) {
      stubStorage({ "redux-devtools-settings": stored });
      const { app } = await loadApp();
      expect(app.store.getState().devtools).toEqual(expected);
      app.dispose();
    }
  });

  it("is saved when flipped, not when a past state is only viewed", async () => {
    const saved = stubStorage({});
    const { app, autocalcToggled, devtools } = await loadApp();
    app.store.dispatch(autocalcToggled());
    expect(saved().isAutocalcEnabled).toBe(false);
    devtools.jumpTo(0); // just looking at the past
    expect(saved().isAutocalcEnabled).toBe(false);
    devtools.live();
    app.dispose();
  });
});
