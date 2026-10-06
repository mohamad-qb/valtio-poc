import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { PathDeal } from "@shared/pathDeal.ts";
import { productPath } from "@shared/paths.ts";
import { type ProductData, definitionOf, productTypeOf, readField } from "@shared/products/productRegistry.ts";
import { createAdapter } from "./support/adapters.ts";
import { installFakeApi, sleep } from "./support/fakeApi.ts";

/**
 * Guarantees of the MobX family (MobX, MobX-State-Tree, mobx-keystone) that
 * the shared scenarios can't see: several deals over one options store, the
 * first group, the persisted switches, how far a lookup reads, how often a
 * deal is priced, and Redux DevTools time travel (against a fake extension).
 */
type MobxApp = "mobx" | "mobx-state-tree" | "mobx-keystone";
const mobxApps: MobxApp[] = ["mobx", "mobx-state-tree", "mobx-keystone"];

type Switches = { isSpotPriceStreamEnabled: boolean; isAutocalcEnabled: boolean };
const switchesOff: Switches = { isSpotPriceStreamEnabled: false, isAutocalcEnabled: false };
const storageKeys: Record<MobxApp, string> = {
  mobx: "mobx-devtools",
  "mobx-state-tree": "mobx-state-tree-devtools",
  "mobx-keystone": "mobx-keystone-devtools",
};

beforeEach(() => {
  vi.resetModules();
  vi.spyOn(console, "info").mockImplementation(() => {}); // "extension not found"
});
afterEach(() => {
  vi.doUnmock("@shared/api/calculate.ts");
  vi.doUnmock("@shared/validation.ts");
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

// --- helpers

/** The `index`-th product's field path, in display order. */
const fieldPathOf = (data: { productType: string }, fieldId: string) =>
  (definitionOf(productTypeOf(data)).fieldPaths as Record<string, string>)[fieldId];
/** A model product's field path. */
const pathOf = (groupId: string, product: { id: string; data: { productType: string } }, fieldId: string) =>
  productPath(groupId, product.id, fieldPathOf(product.data, fieldId));
const pathIn = (deal: PathDeal, index: number, fieldId: string) => {
  const [groupId, productId] = deal.getGroups().flatMap((group) => group.productIds.map((id) => [group.id, id]))[index];
  return productPath(groupId, productId, fieldPathOf(deal.getProduct(productId)!.data, fieldId));
};
const write = (deal: PathDeal, index: number, fieldId: string, value: unknown) =>
  deal.writePaths([{ path: pathIn(deal, index, fieldId), value }]);
const read = (deal: PathDeal, index: number, fieldId: string) => deal.readPath(pathIn(deal, index, fieldId));

/** An in-memory localStorage. */
const installLocalStorage = (initial: Record<string, string> = {}) => {
  const items = new Map(Object.entries(initial));
  const storage = {
    getItem: (key: string) => (items.has(key) ? items.get(key)! : null),
    setItem: (key: string, value: string) => void items.set(key, String(value)),
    removeItem: (key: string) => void items.delete(key),
  };
  vi.stubGlobal("localStorage", storage);
  return storage;
};

/** A fake Redux DevTools extension: records what each instance is sent; `jump` plays the monitor (state as JSON). */
const installFakeDevtools = () => {
  const sent: { name: string; type: string }[] = [];
  const listeners = new Map<string, (message: unknown) => void>();
  const extension = {
    connect: ({ name }: { name: string }) => ({
      init: () => {},
      send: (action: { type: string } | null) => {
        if (action) sent.push({ name, type: action.type });
      },
      subscribe: (listener: (message: unknown) => void) => {
        listeners.set(name, listener);
        return () => listeners.delete(name);
      },
    }),
  };
  vi.stubGlobal("window", { __REDUX_DEVTOOLS_EXTENSION__: extension });
  vi.stubGlobal("location", { search: "" });
  return {
    sent,
    names: () => [...listeners.keys()].sort(),
    jump: (name: string, state: unknown) =>
      listeners.get(name)!({ type: "DISPATCH", state: JSON.stringify(state), payload: { type: "JUMP_TO_STATE" } }),
  };
};

/** Counts the pricing requests (the shared fake, 20 ms in tests). Call before the app is imported. */
const countCalculations = () => {
  const calls = { count: 0 };
  vi.doMock("@shared/api/calculate.ts", async (importOriginal) => {
    const actual = await importOriginal<typeof import("@shared/api/calculate.ts")>();
    return {
      calculatePrice: (products: readonly ProductData[]) => {
        calls.count++;
        return actual.calculatePrice(products);
      },
    };
  });
  return calls;
};

/** Counts validations (a product's, or one field's). Call before the app is imported. */
const countValidations = () => {
  const calls = { count: 0 };
  vi.doMock("@shared/validation.ts", async (importOriginal) => {
    const actual = await importOriginal<typeof import("@shared/validation.ts")>();
    return {
      ...actual,
      fieldIssues: (...args: Parameters<typeof actual.fieldIssues>) => {
        calls.count++;
        return actual.fieldIssues(...args);
      },
      productIssues: (...args: Parameters<typeof actual.productIssues>) => {
        calls.count++;
        return actual.productIssues(...args);
      },
    };
  });
  return calls;
};

/** Several deals of one app, sharing its options store, as the tabs do. */
type World = {
  newDeal(): { deal: PathDeal; calc(): { status: string; price: number | null }; dispose(): void };
  setAutocalc(enabled: boolean): void;
  /** How many derivations observe a switch (each deal's spot stream reads it). */
  switchObservers(): number;
};

const worlds: Record<MobxApp, () => Promise<World>> = {
  mobx: async () => {
    const { configure, getObserverTree, observable, runInAction } = await import("mobx");
    configure({ enforceActions: "always" });
    const { createDealStore } = await import("../../src-mobx/stores/dealStore.ts");
    const { createPathDeal } = await import("../../src-mobx/stores/pathDeal.ts");
    const devtools = observable({ ...switchesOff });
    return {
      newDeal: () => {
        const store = createDealStore(devtools);
        return { deal: createPathDeal(store), calc: () => store.calc, dispose: () => store.dispose() };
      },
      setAutocalc: (enabled) => runInAction(() => (devtools.isAutocalcEnabled = enabled)),
      switchObservers: () => getObserverTree(devtools, "isSpotPriceStreamEnabled").observers?.length ?? 0,
    };
  },
  "mobx-state-tree": async () => {
    const { getObserverTree, observable, runInAction } = await import("mobx");
    const { destroy } = await import("mobx-state-tree");
    const { Deal } = await import("../../src-mobx-state-tree/stores/dealModel.ts");
    const { createPathDeal } = await import("../../src-mobx-state-tree/stores/pathDeal.ts");
    const devtools = observable({ ...switchesOff });
    return {
      newDeal: () => {
        const store = Deal.create({}, { devtools });
        return { deal: createPathDeal(store), calc: () => store.calc, dispose: () => destroy(store) };
      },
      setAutocalc: (enabled) => runInAction(() => (devtools.isAutocalcEnabled = enabled)),
      switchObservers: () => getObserverTree(devtools, "isSpotPriceStreamEnabled").observers?.length ?? 0,
    };
  },
  "mobx-keystone": async () => {
    const { getObserverTree, observable, runInAction } = await import("mobx");
    const { registerRootStore, setGlobalConfig, unregisterRootStore } = await import("mobx-keystone");
    setGlobalConfig({ showDuplicateModelNameWarnings: false });
    const { Deal, devtoolsContext } = await import("../../src-mobx-keystone/stores/dealModel.ts");
    const { createPathDeal } = await import("../../src-mobx-keystone/stores/pathDeal.ts");
    const devtools = observable({ ...switchesOff });
    return {
      newDeal: () => {
        const store = new Deal({});
        devtoolsContext.set(store, devtools);
        registerRootStore(store);
        return { deal: createPathDeal(store), calc: () => store.calc.data, dispose: () => unregisterRootStore(store) };
      },
      setAutocalc: (enabled) => runInAction(() => (devtools.isAutocalcEnabled = enabled)),
      switchObservers: () => getObserverTree(devtools, "isSpotPriceStreamEnabled").observers?.length ?? 0,
    };
  },
};

/** The app's switches, as its tab store loads them from storage. */
const loadSwitches: Record<MobxApp, () => Promise<Switches>> = {
  mobx: async () => (await import("../../src-mobx/stores/multiTabStore.ts")).multiTabStore.devtools,
  "mobx-state-tree": async () => (await import("../../src-mobx-state-tree/stores/multiTabStore.ts")).devtools,
  "mobx-keystone": async () => {
    const { setGlobalConfig } = await import("mobx-keystone");
    setGlobalConfig({ showDuplicateModelNameWarnings: false });
    return (await import("../../src-mobx-keystone/stores/multiTabStore.ts")).multiTabStore.devtools;
  },
};

/** The app's tab store: open a deal, count each deal's groups. */
const loadTabs: Record<MobxApp, () => Promise<{ addNewDeal(): void; groupCounts(): number[] }>> = {
  mobx: async () => {
    const { multiTabStore } = await import("../../src-mobx/stores/multiTabStore.ts");
    return {
      addNewDeal: () => multiTabStore.addNewDeal(),
      groupCounts: () => Object.values(multiTabStore.deals).map((deal) => deal.groupIds.length),
    };
  },
  "mobx-state-tree": async () => {
    const { multiTabStore } = await import("../../src-mobx-state-tree/stores/multiTabStore.ts");
    return {
      addNewDeal: () => multiTabStore.addNewDeal(),
      groupCounts: () => multiTabStore.deals.map((deal) => deal.groups.length),
    };
  },
  "mobx-keystone": async () => {
    const { setGlobalConfig } = await import("mobx-keystone");
    setGlobalConfig({ showDuplicateModelNameWarnings: false });
    const { multiTabStore } = await import("../../src-mobx-keystone/stores/multiTabStore.ts");
    return {
      addNewDeal: () => multiTabStore.addNewDeal(),
      groupCounts: () => multiTabStore.deals.map((deal) => deal.groups.length),
    };
  },
};

const cash = (...ids: number[]) => ids.map((id) => ({ id, name: `Source ${id}` }));

// --- every app of the family

describe.each(mobxApps)("%s", (app) => {
  it("a new deal starts with its first group, created with it (not by the view)", async () => {
    installFakeApi();
    installLocalStorage({ [storageKeys[app]]: JSON.stringify(switchesOff) });
    const tabs = await loadTabs[app]();
    tabs.addNewDeal();
    tabs.addNewDeal();
    expect(tabs.groupCounts()).toEqual([1, 1]);
  });

  it("options arriving: products reconcile before the load counts as done, so the deal is priced once", async () => {
    const api = installFakeApi({ Cash: cash(3, 4) });
    const calls = countCalculations();
    const adapter = await createAdapter(app);
    adapter.addGroup("VanillaGroup");
    adapter.sync("notionalCcy", "USD");
    adapter.commit(0, "settlementStyle", "Cash");
    await vi.waitFor(() => expect(adapter.read(0, "settlementFixingSource")).toBe("3"));
    adapter.setAutocalc(true);
    await vi.waitFor(() => expect(adapter.calc()).toEqual({ status: "done", price: 1 }));

    api.lists.Cash = cash(4); // 3 is no longer offered
    const before = calls.count;
    adapter.cloneGroup(0); // the clone loads Cash's options again
    await vi.waitFor(() => expect(adapter.calc()).toEqual({ status: "done", price: 2 }));
    await sleep(30); // nothing more starts
    expect([adapter.read(0, "settlementFixingSource"), adapter.read(1, "settlementFixingSource")]).toEqual(["4", "4"]);
    expect(calls.count - before).toBe(1); // not a superseded one first, priced before the reconcile
    adapter.dispose();
  });

  it("options arriving reconcile every deal still on that parameter, not just the deal that asked", async () => {
    const api = installFakeApi({ Cash: cash(3, 4) });
    const world = await worlds[app]();
    const [asking, other, delivery] = [world.newDeal(), world.newDeal(), world.newDeal()];
    for (const { deal } of [asking, other, delivery]) deal.addGroup("VanillaGroup");
    write(asking.deal, 0, "settlementStyle", "Cash");
    write(other.deal, 0, "settlementStyle", "Cash");
    await sleep(30);
    expect(read(other.deal, 0, "settlementFixingSource")).toBe("3");

    api.lists.Cash = cash(4);
    write(asking.deal, 0, "settlementStyle", "Cash"); // the same style: Cash's options reload
    await sleep(30);
    expect(read(asking.deal, 0, "settlementFixingSource")).toBe("4");
    expect(read(other.deal, 0, "settlementFixingSource")).toBe("4"); // the cache is shared: never a value it no longer offers
    expect(read(delivery.deal, 0, "settlementFixingSource")).toBeUndefined(); // not on Cash: nothing to reconcile
    for (const { dispose } of [asking, other, delivery]) dispose();
  });

  it("dispose drops everything the deal subscribed to: the switches, and the options that arrive later", async () => {
    const api = installFakeApi({ Cash: cash(3, 4) });
    const warnings = vi.spyOn(console, "warn");
    const errors = vi.spyOn(console, "error");
    const world = await worlds[app]();
    const [kept, disposed] = [world.newDeal(), world.newDeal()];
    for (const { deal } of [kept, disposed]) {
      deal.addGroup("VanillaGroup");
      write(deal, 0, "settlementStyle", "Cash");
    }
    await sleep(30);
    const disposedData = disposed.deal.getProduct(disposed.deal.getGroups()[0].productIds[0])!.data;
    expect(world.switchObservers()).toBe(2);
    disposed.dispose();
    expect(world.switchObservers()).toBe(1);

    api.lists.Cash = cash(4);
    write(kept.deal, 0, "settlementStyle", "Cash");
    await sleep(30);
    expect(read(kept.deal, 0, "settlementFixingSource")).toBe("4");
    expect(readField(disposedData, "settlementFixingSource")).toBe("3"); // heard nothing
    kept.dispose();
    expect(world.switchObservers()).toBe(0);
    expect([...warnings.mock.calls, ...errors.mock.calls]).toEqual([]);
  });

  it("a product lookup reads only that product, however many groups the deal has", async () => {
    installFakeApi();
    const { autorun, getDependencyTree } = await import("mobx");
    const world = await worlds[app]();
    const { deal, dispose } = world.newDeal();
    /** What a reaction that reads one cell of the last product depends on directly. */
    const readsOfOneCell = () => {
      const productIds = deal.getGroups().flatMap((group) => group.productIds);
      const productId = productIds.at(-1)!;
      const path = pathIn(deal, productIds.length - 1, "strike");
      const stop = autorun(() => {
        void deal.getProduct(productId);
        void deal.fieldIssues(productId, "strike");
        void deal.readPath(path);
      });
      const reads = getDependencyTree(stop).dependencies?.length ?? 0;
      stop();
      return reads;
    };
    deal.addGroup("Strategy");
    deal.addGroup("VanillaGroup");
    const few = readsOfOneCell();
    for (let i = 0; i < 30; i++) deal.addGroup("Strategy");
    deal.addGroup("VanillaGroup");
    expect(readsOfOneCell()).toBe(few);

    // and the lookup follows clones and removals
    const [first] = deal.getGroups();
    deal.cloneGroup(first.id);
    const clone = deal.getGroups()[1];
    expect(deal.getProduct(clone.productIds[0])?.groupId).toBe(clone.id);
    deal.removeGroup(first.id);
    expect(deal.getProduct(first.productIds[0])).toBeUndefined();
    expect(deal.fieldIssues(first.productIds[0], "notionalCcy")).toEqual([]);
    dispose();
  });

  it("validation stays cached while the deal is invalid: reading a cell's issues validates nothing", async () => {
    installFakeApi();
    const validations = countValidations();
    const adapter = await createAdapter(app); // autocalc off
    for (let i = 0; i < 3; i++) adapter.addGroup("VanillaGroup");
    expect(adapter.hasValidationErrors()).toBe(true); // the default ccy: every product is invalid
    validations.count = 0;
    for (let round = 0; round < 3; round++) {
      for (let i = 0; i < 3; i++) adapter.issues(i, "strike");
    }
    expect(validations.count).toBe(0);
    adapter.commit(0, "strike", "1");
    expect(validations.count).toBeGreaterThan(0); // an edit re-validates
    adapter.dispose();
  });

  it("a null or undefined synced value doesn't abort the batch, and the deal and its products agree", async () => {
    installFakeApi();
    const adapter = await createAdapter(app);
    adapter.addGroup("Strategy");
    const deal = adapter.deal();
    deal.writePaths([
      { path: "notionalAmount", value: null },
      { path: "premiumCcy", value: undefined },
      { path: pathIn(deal, 0, "strike"), value: "1" },
    ]);
    expect(adapter.read(0, "strike")).toBe("1");
    for (const fieldId of ["notionalAmount", "premiumCcy"]) {
      expect([adapter.read(0, fieldId), adapter.read(1, fieldId)]).toEqual([adapter.dealValue(fieldId), adapter.dealValue(fieldId)]);
    }
    adapter.dispose();
  });

  it.each([
    ["not JSON", "{not json"],
    ["null", "null"],
    ["an array", "[]"],
    ["a string", '"on"'],
    ["no keys", "{}"],
    ["wrong types", JSON.stringify({ isSpotPriceStreamEnabled: "false", isAutocalcEnabled: 0 })],
  ])("stored switches that are %s fall back to the defaults (on)", async (_, stored) => {
    installLocalStorage({ [storageKeys[app]]: stored });
    const switches = await loadSwitches[app]();
    expect([switches.isSpotPriceStreamEnabled, switches.isAutocalcEnabled]).toEqual([true, true]);
  });

  it("stored switches are read key by key: a valid one is kept, a missing or wrong one is the default", async () => {
    installLocalStorage({ [storageKeys[app]]: JSON.stringify({ isAutocalcEnabled: false, isSpotPriceStreamEnabled: "no" }) });
    const switches = await loadSwitches[app]();
    expect([switches.isSpotPriceStreamEnabled, switches.isAutocalcEnabled]).toEqual([true, false]);
  });
});

// --- MobX

describe("mobx", () => {
  it("empty → Infinity (a pasted 1e999), and 0 → -0, are changes: the price outdates and the product repaints", async () => {
    installFakeApi();
    const adapter = await createAdapter("mobx");
    adapter.addGroup("VanillaGroup");
    adapter.sync("notionalCcy", "USD");
    await sleep(20);
    adapter.calculate();
    await sleep(40);
    expect(adapter.calc().status).toBe("done");
    const changes: string[] = [];
    const stop = adapter.deal().subscribe((change) => changes.push(change.kind));

    adapter.sync("notionalAmount", Number("1e999"));
    expect(adapter.calc().status).toBe("outdated");
    expect(changes).toContain("products");

    adapter.sync("notionalAmount", 0);
    adapter.calculate(); // not ready (0 is invalid): nothing
    changes.length = 0;
    adapter.sync("notionalAmount", -0);
    expect(changes).toContain("products");
    stop();
    adapter.dispose();
  });

  it("an edit that makes the deal ready is priced once", async () => {
    installFakeApi();
    const calls = countCalculations();
    const adapter = await createAdapter("mobx");
    adapter.addGroup("VanillaGroup");
    adapter.setAutocalc(true);
    await sleep(30); // the deal column's options are in; the default ccy is invalid
    expect(adapter.calc().status).toBe("none");
    adapter.sync("notionalCcy", "USD");
    await vi.waitFor(() => expect(adapter.calc()).toEqual({ status: "done", price: 1 }));
    await sleep(30); // nothing more starts
    expect(calls.count).toBe(1);
    adapter.dispose();
  });

  it("an issues observer doesn't re-run when a field's issues come back equal", async () => {
    installFakeApi();
    const { autorun, configure, observable } = await import("mobx");
    configure({ enforceActions: "always" });
    const { createDealStore } = await import("../../src-mobx/stores/dealStore.ts");
    const deal = createDealStore(observable({ ...switchesOff }));
    deal.addNewGroup("VanillaGroup");
    const [groupId] = deal.groupIds;
    const [product] = deal.products;
    const path = (fieldId: string) => pathOf(groupId, product, fieldId);
    deal.writePaths([
      { path: path("expiryDate"), value: "2999-03-05" },
      { path: path("deliveryDate"), value: "2999-03-02" }, // before expiry: one issue
    ]);
    let runs = 0;
    const stop = autorun(() => {
      void product.fields.deliveryDate.issues;
      runs++;
    });
    deal.writePaths([{ path: path("expiryDate"), value: "2999-03-06" }]); // the same issue again
    deal.writePaths([{ path: path("expiryDate"), value: "2999-03-07" }]);
    expect(runs).toBe(1);
    deal.writePaths([{ path: path("deliveryDate"), value: "2999-03-08" }]); // fixed
    expect(runs).toBe(2);
    stop();
    deal.dispose();
  });

  it("DevTools: every entry is named after its store and action, async steps included", async () => {
    installFakeApi({ Cash: cash(4) });
    const devtools = installFakeDevtools();
    installLocalStorage({ "mobx-devtools": JSON.stringify({ isSpotPriceStreamEnabled: false, isAutocalcEnabled: true }) });
    const { configure } = await import("mobx");
    configure({ enforceActions: "always" });
    await import("../../src-mobx/devtools.ts");
    const { multiTabStore } = await import("../../src-mobx/stores/multiTabStore.ts");
    multiTabStore.addNewDeal();
    const deal = multiTabStore.deals[multiTabStore.activeDealId];
    deal.writePaths([{ path: "notionalCcy", value: "USD" }]);
    await sleep(80); // the deal column's options arrive, then autocalc prices the deal
    expect(deal.calc.status).toBe("done");
    const types = devtools.sent.map(({ type }) => type);
    expect(types).toEqual(expect.arrayContaining(["Tabs.addNewDeal", "Deal.writePaths", "Options.loaded", "Deal.setCalc"]));
    expect(types.filter((type) => !/^(Tabs|Switches|Deal|Options)\.\w+$/.test(type))).toEqual([]);
    for (const open of Object.values(multiTabStore.deals)) open.dispose();
  });
});

// --- MobX-State-Tree

describe("mobx-state-tree", () => {
  const instance = "Deal editor (MobX-State-Tree)";

  it("time travel to a state with empty numbers: applied whole, NaN back where it was, no new errors", async () => {
    installFakeApi();
    const devtools = installFakeDevtools();
    installLocalStorage({ "mobx-state-tree-devtools": JSON.stringify(switchesOff) });
    await import("../../src-mobx-state-tree/devtools.ts");
    const { getSnapshot } = await import("mobx-state-tree");
    const { multiTabStore } = await import("../../src-mobx-state-tree/stores/multiTabStore.ts");
    multiTabStore.addNewDeal();
    const deal = multiTabStore.deals[0];
    await sleep(30);
    const past = getSnapshot(multiTabStore); // the deal's amount and every empty product number: NaN
    deal.writePaths([{ path: "notionalCcy", value: "USD" }]);

    expect(() => devtools.jump(instance, past)).not.toThrow(); // the extension sends JSON: NaN arrives as null
    expect(deal.notionalCcy).toBe("1xxxxxx");
    expect(readField(deal.products[0].data, "notionalCcy")).toBe("1xxxxxx"); // all of it applied: still in sync
    expect(deal.notionalAmount).toBeNaN();
    expect(readField(deal.products[0].data, "notionalAmount")).toBeNaN();
    expect(readField(deal.products[0].data, "expiryDays")).toBeNaN();
    expect(Object.keys(deal.products[0].issues)).toEqual(["notionalCcy"]); // only the default ccy, as before
  });

  it("time travel doesn't re-price: the state comes back as recorded", async () => {
    installFakeApi();
    const devtools = installFakeDevtools();
    installLocalStorage({ "mobx-state-tree-devtools": JSON.stringify({ isSpotPriceStreamEnabled: false, isAutocalcEnabled: true }) });
    const calls = countCalculations();
    await import("../../src-mobx-state-tree/devtools.ts");
    const { getSnapshot } = await import("mobx-state-tree");
    const { multiTabStore } = await import("../../src-mobx-state-tree/stores/multiTabStore.ts");
    multiTabStore.addNewDeal();
    const deal = multiTabStore.deals[0];
    const [group] = deal.groups;
    deal.writePaths([
      { path: "notionalCcy", value: "USD" },
      { path: "notionalAmount", value: 1000 },
      { path: pathOf(group.id, group.products[0], "expiryDate"), value: "2999-01-01" },
    ]);
    await sleep(80);
    expect(deal.calc).toMatchObject({ status: "done", price: 2 });
    const past = getSnapshot(multiTabStore);
    deal.writePaths([{ path: "notionalAmount", value: 3000 }]);
    await sleep(80);
    expect(deal.calc).toMatchObject({ status: "done", price: 4 });

    const requests = calls.count;
    const entries = devtools.sent.length;
    devtools.jump(instance, past);
    await sleep(80);
    expect(deal.notionalAmount).toBe(1000);
    expect(deal.calc).toMatchObject({ status: "done", price: 2 });
    expect(calls.count).toBe(requests);
    expect(devtools.sent.length).toBe(entries); // and nothing new in the history
  });

  it("DevTools: the switches are an instance of their own", async () => {
    const devtools = installFakeDevtools();
    installLocalStorage({ "mobx-state-tree-devtools": JSON.stringify(switchesOff) });
    await import("../../src-mobx-state-tree/devtools.ts");
    const { devtools: switches } = await import("../../src-mobx-state-tree/stores/multiTabStore.ts");
    expect(devtools.names()).toContain("Switches (MobX-State-Tree)");
    switches.toggleAutocalcEnabled();
    expect(devtools.sent.map(({ name, type }) => `${name}: ${type}`)).toEqual([
      "Switches (MobX-State-Tree): [/] toggleAutocalcEnabled",
    ]);
  });

  it("a price arriving after the deal is destroyed touches nothing", async () => {
    installFakeApi();
    const warnings = vi.spyOn(console, "warn");
    const world = await worlds["mobx-state-tree"]();
    const { deal, calc, dispose } = world.newDeal();
    deal.addGroup("VanillaGroup");
    world.setAutocalc(true);
    deal.writePaths([{ path: "notionalCcy", value: "USD" }]);
    await sleep(15);
    expect(calc().status).toBe("calculating");
    dispose();
    await sleep(40);
    expect(warnings).not.toHaveBeenCalled();
  });

  it("a product edit leaves the deal's own (empty) fields alone: no patch for them", async () => {
    installFakeApi();
    const { observable } = await import("mobx");
    const { destroy, onPatch } = await import("mobx-state-tree");
    const { Deal } = await import("../../src-mobx-state-tree/stores/dealModel.ts");
    const deal = Deal.create({}, { devtools: observable({ ...switchesOff }) });
    deal.addNewGroup("VanillaGroup");
    const [group] = deal.groups;
    const patches: string[] = [];
    const stop = onPatch(deal, ({ op, path }) => patches.push(`${op} ${path}`));
    deal.writePaths([{ path: pathOf(group.id, group.products[0], "strike"), value: "1" }]);
    expect(patches).toContain("replace /groups/0/products/0/data");
    expect(patches.filter((patch) => /\/(notionalCcy|premiumCcy|notionalAmount|isInternal|hedgeType)$/.test(patch))).toEqual([]);
    stop();
    destroy(deal);
  });
});

// --- mobx-keystone

describe("mobx-keystone", () => {
  const instance = "Deal editor (MobX Keystone)";

  it("time travel to a state with empty numbers: NaN back in the product data, no new errors", async () => {
    installFakeApi();
    const devtools = installFakeDevtools();
    installLocalStorage({ "mobx-keystone-devtools": JSON.stringify(switchesOff) });
    const { getSnapshot, setGlobalConfig } = await import("mobx-keystone");
    setGlobalConfig({ showDuplicateModelNameWarnings: false });
    await import("../../src-mobx-keystone/devtools.ts");
    const { multiTabStore } = await import("../../src-mobx-keystone/stores/multiTabStore.ts");
    multiTabStore.addNewDeal();
    const deal = multiTabStore.deals[0];
    await sleep(30);
    const past = getSnapshot(multiTabStore);
    deal.writePaths([{ path: "notionalCcy", value: "USD" }]);
    devtools.jump(instance, past);
    expect(deal.notionalCcy).toBe("1xxxxxx");
    expect(deal.notionalAmount).toBeNaN();
    expect(readField(deal.products[0].data, "notionalAmount")).toBeNaN();
    expect(readField(deal.products[0].data, "expiryDays")).toBeNaN();
    expect(Object.keys(deal.products[0].issues)).toEqual(["notionalCcy"]);
  });

  it("time travel doesn't re-price: the state comes back as recorded", async () => {
    installFakeApi();
    const devtools = installFakeDevtools();
    installLocalStorage({ "mobx-keystone-devtools": JSON.stringify({ isSpotPriceStreamEnabled: false, isAutocalcEnabled: true }) });
    const calls = countCalculations();
    const { getSnapshot, setGlobalConfig } = await import("mobx-keystone");
    setGlobalConfig({ showDuplicateModelNameWarnings: false });
    await import("../../src-mobx-keystone/devtools.ts");
    const { multiTabStore } = await import("../../src-mobx-keystone/stores/multiTabStore.ts");
    multiTabStore.addNewDeal();
    const deal = multiTabStore.deals[0];
    const [group] = deal.groups;
    deal.writePaths([
      { path: "notionalCcy", value: "USD" },
      { path: "notionalAmount", value: 1000 },
      { path: pathOf(group.id, group.products[0], "expiryDate"), value: "2999-01-01" },
    ]);
    await sleep(80);
    expect(deal.calc.data).toMatchObject({ status: "done", price: 2 });
    const past = getSnapshot(multiTabStore);
    deal.writePaths([{ path: "notionalAmount", value: 3000 }]);
    await sleep(80);
    expect(deal.calc.data).toMatchObject({ status: "done", price: 4 });

    const requests = calls.count;
    devtools.jump(instance, past);
    await sleep(80);
    expect(deal.notionalAmount).toBe(1000);
    expect(deal.calc.data).toMatchObject({ status: "done", price: 2 });
    expect(calls.count).toBe(requests);
  });

  it("DevTools: one instance, the shared options included, so every action is labelled by its path in it", async () => {
    installFakeApi({ Cash: cash(4) });
    const devtools = installFakeDevtools();
    installLocalStorage({ "mobx-keystone-devtools": JSON.stringify(switchesOff) });
    const { setGlobalConfig } = await import("mobx-keystone");
    setGlobalConfig({ showDuplicateModelNameWarnings: false });
    await import("../../src-mobx-keystone/devtools.ts");
    const { multiTabStore } = await import("../../src-mobx-keystone/stores/multiTabStore.ts");
    multiTabStore.addNewDeal();
    const deal = multiTabStore.deals[0];
    const [group] = deal.groups;
    deal.writePaths([{ path: pathOf(group.id, group.products[0], "settlementStyle"), value: "Cash" }]);
    await sleep(40);
    expect(devtools.names()).toEqual([instance]);
    const types = devtools.sent.map(({ type }) => type);
    expect(types.some((type) => />>> \[\/options\] started\(/.test(type))).toBe(true);
    expect(types.some((type) => /\[\/options\] loaded\(.*>>> \[\/deals\/0\] reconcileOptions\(/.test(type))).toBe(true);
    expect(types.filter((type) => type.includes("(id ?"))).toEqual([]); // no parent from another instance
  });

  it("the calculation and the options states are frozen values, not tree nodes", async () => {
    installFakeApi();
    const { Frozen, setGlobalConfig } = await import("mobx-keystone");
    setGlobalConfig({ showDuplicateModelNameWarnings: false });
    const { Deal } = await import("../../src-mobx-keystone/stores/dealModel.ts");
    const { optionsStore } = await import("../../src-mobx-keystone/stores/optionsStore.ts");
    const deal = new Deal({});
    expect(deal.calc).toBeInstanceOf(Frozen);
    expect(optionsStore.byKey).toBeInstanceOf(Frozen);
  });
});
