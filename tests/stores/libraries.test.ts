import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { getValueByPath } from "@shared/lib/path.ts";
import { productPath } from "@shared/paths.ts";
import { definitionOf, productTypeOf, readField } from "@shared/products/productRegistry.ts";
import { installFakeApi } from "./support/fakeApi.ts";

// guarantees that are specific to how each library updates

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

/** A product field's dot path. */
const fieldPath = (groupId: string, product: { id: string; data: { productType: string } }, fieldId: string) =>
  productPath(groupId, product.id, (definitionOf(productTypeOf(product.data)).fieldPaths as Record<string, string>)[fieldId]);

describe("mobx", () => {
  beforeEach(() => {
    installFakeApi();
    vi.resetModules();
  });

  it("re-runs a reaction only for the field it reads", async () => {
    const { autorun, configure, observable } = await import("mobx");
    configure({ enforceActions: "always" });
    const { createDealStore } = await import("../../src-mobx/stores/dealStore.ts");
    const deal = createDealStore(observable({ isSpotPriceStreamEnabled: false, isAutocalcEnabled: false }));
    deal.addNewGroup("Strategy");
    deal.addNewGroup("Average");
    const [strategyId, averageId] = deal.groupIds;
    const [watched, sibling, other] = deal.products;
    const write = (groupId: string, product: typeof watched, fieldId: string, value: unknown) =>
      deal.writePaths([{ path: fieldPath(groupId, product, fieldId), value }]);
    let runs = 0;
    const stop = autorun(() => {
      void readField(watched.data, "strike");
      void watched.fields.strike.issues;
      runs++;
    });
    write(strategyId, sibling, "strike", "5");
    write(averageId, other, "ccyPair", "GBPUSD");
    expect(runs).toBe(1); // unrelated edits
    write(strategyId, watched, "strike", "7");
    expect(runs).toBe(2); // its own edit, once
    write(strategyId, watched, "deliveryDate", "2999-03-02");
    const before = runs;
    const rule = autorun(() => void watched.fields.deliveryDate.issues);
    write(strategyId, watched, "expiryDate", "2999-03-05"); // the rule's dependency
    expect(watched.fields.deliveryDate.issues).toHaveLength(1);
    rule();
    stop();
    expect(runs).toBe(before);
    deal.dispose();
  });
});

describe("mobx-state-tree", () => {
  beforeEach(() => {
    installFakeApi();
    vi.resetModules();
  });

  it("a write replaces only its own product's data, and only when a value changes", async () => {
    const { observable } = await import("mobx");
    const { destroy } = await import("mobx-state-tree");
    const { Deal } = await import("../../src-mobx-state-tree/stores/dealModel.ts");
    const deal = Deal.create({}, { devtools: observable({ isSpotPriceStreamEnabled: false, isAutocalcEnabled: false }) });
    deal.addNewGroup("Strategy");
    deal.addNewGroup("Average");
    const [strategy, average] = deal.groups;
    const [edited, sibling] = strategy.products;
    const before = { edited: edited.data, sibling: sibling.data, average: average.products[0].data };
    const write = () => deal.writePaths([{ path: fieldPath(strategy.id, edited, "expiryCut"), value: "TK15" }]);

    write();
    expect(edited.data).not.toBe(before.edited);
    expect(getValueByPath(edited.data, "optionsCommon")).not.toBe(getValueByPath(before.edited, "optionsCommon")); // the path to the field is copied …
    expect(edited.data.cashSettlement).toBe(before.edited.cashSettlement); // … nothing else
    expect(sibling.data).toBe(before.sibling);
    expect(average.products[0].data).toBe(before.average);

    const written = edited.data;
    write();
    expect(edited.data).toBe(written); // same value: nothing replaced
    destroy(deal);
  });
});

describe("mobx-keystone", () => {
  beforeEach(() => {
    installFakeApi();
    vi.resetModules();
  });

  it("a clone gets new ids and its own copy of the data", async () => {
    const { setGlobalConfig } = await import("mobx-keystone");
    setGlobalConfig({ showDuplicateModelNameWarnings: false });
    const { Deal } = await import("../../src-mobx-keystone/stores/dealModel.ts");
    const deal = new Deal({});
    deal.addNewGroup("VanillaGroup");
    deal.addNewGroup("Average");
    deal.cloneGroup(deal.groups[0].id);
    const [source, copy] = deal.groups;
    expect(deal.groups.map((group) => group.title)).toEqual(["Vanilla Group #1", "Vanilla Group #2", "Average #3"]);
    expect(copy.id).not.toBe(source.id);
    expect(copy.products[0].id).not.toBe(source.products[0].id);

    deal.writePaths([{ path: fieldPath(copy.id, copy.products[0], "expiryCut"), value: "TK15" }]);
    expect(readField(copy.products[0].data, "expiryCut")).toBe("TK15");
    expect(readField(source.products[0].data, "expiryCut")).toBe("");

    deal.removeGroup(source.id);
    expect(deal.groups.map((group) => group.title)).toEqual(["Vanilla Group #1", "Average #2"]); // renumbered
  });
});

describe("legend-state", () => {
  beforeEach(() => {
    installFakeApi();
    vi.resetModules();
  });

  it("a write sets only its own leaf, and only when its value changes", async () => {
    const { observable } = await import("@legendapp/state");
    const { createDealStore } = await import("../../src-legend-state/stores/dealStore.ts");
    const deal = createDealStore(observable({ isSpotPriceStreamEnabled: false, isAutocalcEnabled: false }));
    deal.addNewGroup("Strategy");
    deal.addNewGroup("Average");
    const { groupIds, groups } = deal.deal$.peek();
    const strategy = groups[groupIds[0]];
    const edited = strategy.products[strategy.productIds[0]];
    const changed: string[] = [];
    const stop = deal.deal$.groups.onChange(({ changes }) => changed.push(...changes.map(({ path }) => path.join("."))));
    const path = fieldPath(strategy.id, edited, "expiryCut");

    deal.writePaths([{ path, value: "TK15" }]);
    expect(changed).toEqual([path.slice("groups.".length)]); // one leaf: no sibling, no other group
    expect(readField(edited.data, "expiryCut")).toBe("TK15"); // the plain data, written in place

    deal.writePaths([{ path, value: "TK15" }]);
    expect(changed).toHaveLength(1); // same value: nothing set
    stop();
    deal.dispose();
  });
});

describe("redux", () => {
  beforeEach(() => {
    installFakeApi();
    vi.resetModules();
  });

  const loadRedux = async (autocalc = false) => {
    const { createApp } = await import("../../src-redux/stores/store.ts");
    const thunks = await import("../../src-redux/stores/thunks.ts");
    const { calculationStarted } = await import("../../src-redux/stores/actions.ts");
    const { createPathDeal } = await import("../../src-redux/stores/pathDeal.ts");
    const app = createApp({ isSpotPriceStreamEnabled: false, isAutocalcEnabled: autocalc });
    let started = 0;
    app.listener.startListening({
      actionCreator: calculationStarted,
      effect: () => {
        started += 1;
      },
    });
    /** A deal with one Vanilla group: its first product's Fixing Source path, and that value now. */
    const vanillaDeal = () => {
      const dealId = app.store.dispatch(thunks.addDeal());
      app.store.dispatch(thunks.addGroup(dealId, "VanillaGroup"));
      const groupOf = () => {
        const deal = app.store.getState().deals[dealId];
        return deal.groups[deal.groupIds[0]];
      };
      const product = () => groupOf().products[groupOf().productIds[0]];
      const path = (fieldId: string) => fieldPath(groupOf().id, product(), fieldId);
      return { dealId, path, fixing: () => readField(product().data, "settlementFixingSource") };
    };
    return { ...app, ...thunks, createPathDeal, vanillaDeal, started: () => started };
  };

  it("a write copies only the path to its product, and only when a value changes", async () => {
    const { createApp } = await import("../../src-redux/stores/store.ts");
    const { addDeal, addGroup, cloneGroup, writePaths } = await import("../../src-redux/stores/thunks.ts");
    const { store, dispose } = createApp({ isSpotPriceStreamEnabled: false, isAutocalcEnabled: false });
    const dealId = store.dispatch(addDeal());
    store.dispatch(addGroup(dealId, "Strategy"));
    store.dispatch(addGroup(dealId, "Average"));
    const before = store.getState().deals[dealId];
    const [strategy, average] = before.groupIds.map((id) => before.groups[id]);
    const [edited, sibling] = strategy.productIds.map((id) => strategy.products[id]);
    const write = () =>
      store.dispatch(writePaths(dealId, [{ path: fieldPath(strategy.id, edited, "expiryCut"), value: "TK15" }]));

    write();
    const after = store.getState().deals[dealId];
    expect(after.groups[strategy.id].products[edited.id].data).not.toBe(edited.data);
    expect(after.groups[strategy.id].products[edited.id].data.cashSettlement).toBe(edited.data.cashSettlement); // shared
    expect(after.groups[strategy.id].products[sibling.id]).toBe(sibling);
    expect(after.groups[average.id]).toBe(average);
    expect(after.dealFields).toBe(before.dealFields);

    const { deals } = store.getState();
    write();
    expect(store.getState().deals).toBe(deals); // same value: the same state

    store.dispatch(cloneGroup(dealId, average.id)); // immutable: the clone shares its source's data
    const cloned = store.getState().deals[dealId];
    const copy = cloned.groups[cloned.groupIds[2]];
    expect(copy.id).not.toBe(average.id);
    expect(copy.products[copy.productIds[0]].data).toBe(average.products[average.productIds[0]].data);
    dispose();
  });

  it("a new tab's deal is created with its first group; a deal on its own has none", async () => {
    const { store, dispose, addDeal, addNewDeal } = await loadRedux();
    const tab = store.dispatch(addNewDeal());
    const bare = store.dispatch(addDeal());
    expect(store.getState().deals[tab].groupIds).toHaveLength(1);
    expect(store.getState().deals[bare].groupIds).toHaveLength(0);
    dispose();
  });

  it("options arriving reconcile every deal still on that parameter, not only the deal that asked", async () => {
    const api = installFakeApi({ Cash: [{ id: 3, name: "Shared" }, { id: 4, name: "C4" }] });
    const { sleep } = await import("./support/fakeApi.ts");
    const { store, dispose, addDeal, writePaths, vanillaDeal } = await loadRedux();
    const a = vanillaDeal();
    store.dispatch(writePaths(a.dealId, [{ path: a.path("settlementStyle"), value: "Cash" }]));
    await sleep(40);
    expect(a.fixing()).toBe("3");

    api.lists.Cash = [{ id: 4, name: "C4" }]; // 3 is no longer offered
    store.dispatch(addDeal()); // a second deal loads its deal column's Cash options: nothing in the first asked
    await sleep(40);
    expect(a.fixing()).toBe("4");
    dispose();
  });

  it("options arriving start one calculation, not two: products reconcile before the load counts as done", async () => {
    const api = installFakeApi({ Cash: [{ id: 3, name: "Shared" }, { id: 4, name: "C4" }] });
    const { sleep } = await import("./support/fakeApi.ts");
    const { store, dispose, cloneGroup, writePaths, vanillaDeal, started } = await loadRedux(true);
    const { dealId, path } = vanillaDeal();
    store.dispatch(writePaths(dealId, [{ path: "notionalCcy", value: "USD" }, { path: path("settlementStyle"), value: "Cash" }]));
    await sleep(60); // Cash's first option taken (3), and the deal priced
    expect(store.getState().deals[dealId].calc.status).toBe("done");
    api.lists.Cash = [{ id: 4, name: "C4" }]; // 3 is no longer offered
    const before = started();

    const deal = store.getState().deals[dealId];
    store.dispatch(cloneGroup(dealId, deal.groupIds[0])); // the copy, still valid on 3, reloads Cash's options
    await sleep(60);
    const fixings = store.getState().deals[dealId].groupIds.map((id) => {
      const { products, productIds } = store.getState().deals[dealId].groups[id];
      return readField(products[productIds[0]].data, "settlementFixingSource");
    });
    expect(fixings).toEqual(["4", "4"]); // both reconciled
    expect(store.getState().deals[dealId].calc.status).toBe("done");
    expect(started() - before).toBe(1); // priced once, on the reconciled data: not on 3 first
    dispose();
  });

  it("a deal listener that throws doesn't keep autocalc from running", async () => {
    const { sleep } = await import("./support/fakeApi.ts");
    const reported = vi.fn();
    vi.stubGlobal("reportError", reported); // where the shared change hub reports a listener's error
    vi.spyOn(console, "error").mockImplementation(() => {});
    const { store, dispose, createPathDeal, vanillaDeal, started } = await loadRedux(true);
    const { dealId } = vanillaDeal();
    const deal = createPathDeal(store, dealId);
    deal.writePaths([{ path: "notionalCcy", value: "USD" }]);
    await sleep(60);
    expect(store.getState().deals[dealId].calc.status).toBe("done");
    const before = started();

    const stop = deal.subscribe(() => {
      throw new Error("listener failed");
    });
    expect(() => deal.writePaths([{ path: "notionalAmount", value: 1000 }])).not.toThrow();
    expect(started() - before).toBe(1); // in the same dispatch, after the listeners
    stop();
    dispose();
  });
});

describe("zustand", () => {
  beforeEach(() => {
    installFakeApi();
    vi.resetModules();
  });

  it("a write copies only the path to its product, notifies once per batch, and nothing when no value changes", async () => {
    const { createStore } = await import("zustand/vanilla");
    const { createDealStore } = await import("../../src-zustand/stores/dealStore.ts");
    const deal = createDealStore(createStore(() => ({ isSpotPriceStreamEnabled: false, isAutocalcEnabled: false })));
    const { actions } = deal.getState();
    actions.addNewGroup("Strategy");
    actions.addNewGroup("Average");
    const before = deal.getState();
    const [strategy, average] = before.groupIds.map((id) => before.groups[id]);
    const [edited, sibling] = strategy.productIds.map((id) => ({ id, ...strategy.products[id] }));
    let notified = 0;
    const stop = deal.subscribe(() => notified++);
    const write = () =>
      actions.writePaths([
        { path: fieldPath(strategy.id, edited, "expiryCut"), value: "TK15" },
        { path: fieldPath(strategy.id, edited, "strike"), value: "1" },
      ]);

    write();
    expect(notified).toBe(1); // two writes, one `set`
    const after = deal.getState();
    const data = after.groups[strategy.id].products[edited.id].data;
    expect(data).not.toBe(edited.data);
    expect(getValueByPath(data, "optionsCommon")).not.toBe(getValueByPath(edited.data, "optionsCommon")); // the path to the fields is copied …
    expect(data.cashSettlement).toBe(edited.data.cashSettlement); // … nothing else
    expect(after.groups[strategy.id].products[sibling.id]).toBe(strategy.products[sibling.id]);
    expect(after.groups[average.id]).toBe(average);
    expect(after.calc).not.toBe(before.calc); // the price outdated in the same `set`

    write();
    expect(notified).toBe(1); // same values: no `set` at all
    expect(deal.getState()).toBe(after);
    stop();
  });

  it("options arriving start one calculation, not two: products reconcile before the load counts as done", async () => {
    const api = installFakeApi({ Cash: [{ id: 3, name: "Shared" }, { id: 4, name: "C4" }] });
    const { sleep } = await import("./support/fakeApi.ts");
    const { createStore } = await import("zustand/vanilla");
    const { createDealStore } = await import("../../src-zustand/stores/dealStore.ts");
    const deal = createDealStore(createStore(() => ({ isSpotPriceStreamEnabled: false, isAutocalcEnabled: true })));
    const { actions } = deal.getState();
    actions.addNewGroup("VanillaGroup");
    const { groupIds, groups } = deal.getState();
    const group = groups[groupIds[0]];
    const product = { id: group.productIds[0], ...group.products[group.productIds[0]] };
    actions.writePaths([
      { path: "notionalCcy", value: "USD" },
      { path: fieldPath(group.id, product, "settlementStyle"), value: "Cash" },
    ]);
    await sleep(60); // Cash's first option taken (3), and the deal priced
    api.lists.Cash = [{ id: 4, name: "C4" }]; // 3 is no longer offered
    const started = new Set<number>(); // by request id: a listener can see one state twice
    const stop = deal.subscribe(({ calc }) => {
      if (calc.status === "calculating") started.add(calc.requestId);
    });

    actions.cloneGroup(group.id); // the copy, still valid on 3, reloads Cash's options
    await sleep(60);
    const fixings = deal.getState().groupIds.map((id) => {
      const { products, productIds } = deal.getState().groups[id];
      return readField(products[productIds[0]].data, "settlementFixingSource");
    });
    expect(fixings).toEqual(["4", "4"]); // both reconciled
    expect(deal.getState().calc.status).toBe("done");
    expect(started.size).toBe(1); // priced once, on the reconciled data: not on 3 first
    stop();
  });
});

describe("jotai", () => {
  beforeEach(() => {
    installFakeApi();
    vi.resetModules();
  });

  it("a write sets only its own product's atom, once per batch, and nothing when no value changes", async () => {
    const { atom, getDefaultStore } = await import("jotai/vanilla");
    const { createDealStore } = await import("../../src-jotai/stores/dealStore.ts");
    const store = getDefaultStore();
    const deal = createDealStore(atom({ isSpotPriceStreamEnabled: false, isAutocalcEnabled: false }));
    deal.actions.addNewGroup("Strategy");
    deal.actions.addNewGroup("Average");
    const [strategy, average] = store.get(deal.groupIdsAtom).map((id) => store.get(deal.groupsAtom)[id]);
    const [edited, sibling] = strategy.productIds.map((id) => ({
      id,
      ...strategy.products[id],
      data: store.get(strategy.products[id].dataAtom),
    }));
    const other = average.products[average.productIds[0]];
    const notified: string[] = [];
    const stops = [
      store.sub(edited.dataAtom, () => notified.push("edited")),
      store.sub(sibling.dataAtom, () => notified.push("sibling")),
      store.sub(other.dataAtom, () => notified.push("other")),
      store.sub(deal.calcAtom, () => notified.push("calc")),
    ];
    const siblingIssues = store.get(sibling.issuesAtom);
    const write = () =>
      deal.actions.writePaths([
        { path: fieldPath(strategy.id, edited, "expiryCut"), value: "TK15" },
        { path: fieldPath(strategy.id, edited, "strike"), value: "1" },
      ]);

    write();
    expect([...notified].sort()).toEqual(["calc", "edited"]); // two writes, one batch: its own product once, the price outdated
    const data = store.get(edited.dataAtom);
    expect(getValueByPath(data, "optionsCommon")).not.toBe(getValueByPath(edited.data, "optionsCommon")); // the path to the fields is copied …
    expect(data.cashSettlement).toBe(edited.data.cashSettlement); // … nothing else
    expect(store.get(sibling.issuesAtom)).toBe(siblingIssues); // not re-validated

    write();
    expect(notified).toHaveLength(2); // same values: nothing set
    expect(store.get(edited.dataAtom)).toBe(data);
    stops.forEach((stop) => stop());
    deal.dispose();
  });

  it("options arriving start one calculation, not two: products reconcile before the load counts as done", async () => {
    const api = installFakeApi({ Cash: [{ id: 3, name: "Shared" }, { id: 4, name: "C4" }] });
    const { sleep } = await import("./support/fakeApi.ts");
    const { atom, getDefaultStore } = await import("jotai/vanilla");
    const { createDealStore } = await import("../../src-jotai/stores/dealStore.ts");
    const store = getDefaultStore();
    const deal = createDealStore(atom({ isSpotPriceStreamEnabled: false, isAutocalcEnabled: true }));
    deal.actions.addNewGroup("VanillaGroup");
    const group = store.get(deal.groupsAtom)[store.get(deal.groupIdsAtom)[0]];
    const product = { id: group.productIds[0], data: store.get(group.products[group.productIds[0]].dataAtom) };
    deal.actions.writePaths([
      { path: "notionalCcy", value: "USD" },
      { path: fieldPath(group.id, product, "settlementStyle"), value: "Cash" },
    ]);
    await sleep(60); // Cash's first option taken (3), and the deal priced
    api.lists.Cash = [{ id: 4, name: "C4" }]; // 3 is no longer offered
    const started = new Set<number>(); // by request id: a listener reads the latest value, so can see one twice
    const stop = store.sub(deal.calcAtom, () => {
      const { status, requestId } = store.get(deal.calcAtom);
      if (status === "calculating") started.add(requestId);
    });

    deal.actions.cloneGroup(group.id); // the copy, still valid on 3, reloads Cash's options
    await sleep(60);
    const fixings = store.get(deal.groupIdsAtom).map((id) => {
      const { products, productIds } = store.get(deal.groupsAtom)[id];
      return readField(store.get(products[productIds[0]].dataAtom), "settlementFixingSource");
    });
    expect(fixings).toEqual(["4", "4"]); // both reconciled
    expect(store.get(deal.calcAtom).status).toBe("done");
    expect(started.size).toBe(1); // priced once, on the reconciled data: not on 3 first
    stop();
    deal.dispose();
  });
});

describe("effector-nested", () => {
  beforeEach(() => {
    installFakeApi();
    vi.resetModules();
  });

  const createDeal = async (autocalc = false) => {
    const { createStore } = await import("effector");
    const { createDealStore } = await import("../../src-effector-nested/stores/dealStore.ts");
    return createDealStore({ $isSpotPriceStreamEnabled: createStore(false), $isAutocalcEnabled: createStore(autocalc) });
  };
  type Deal = Awaited<ReturnType<typeof createDeal>>;
  /** The deal's first product: its path to a field, and its Fixing Source now. */
  const firstProduct = (deal: Deal) => {
    const product = () => Object.values(Object.values(deal.$groups.getState())[0].products)[0];
    const groupId = () => Object.keys(deal.$groups.getState())[0];
    return {
      path: (fieldId: string) => fieldPath(groupId(), product(), fieldId),
      fixing: () => readField(product().data, "settlementFixingSource"),
    };
  };
  /** A `localStorage` stand-in, and `storage` events from "another tab". */
  const stubStorage = (items: Record<string, string>) => {
    const values = new Map(Object.entries(items));
    const events = new EventTarget();
    vi.stubGlobal("localStorage", {
      getItem: (key: string) => values.get(key) ?? null,
      setItem: (key: string, value: string) => void values.set(key, value),
      removeItem: (key: string) => void values.delete(key),
    });
    vi.stubGlobal("addEventListener", events.addEventListener.bind(events));
    vi.stubGlobal("removeEventListener", events.removeEventListener.bind(events));
    return (key: string, newValue: string) =>
      events.dispatchEvent(Object.assign(new Event("storage"), { storageArea: localStorage, key, newValue }));
  };

  it("copies only the path to an edited product", async () => {
    const deal = await createDeal();
    deal.actions.addGroupAction("Strategy");
    deal.actions.addGroupAction("Average");
    const groups = deal.$groups.getState();
    const [strategyId, averageId] = Object.keys(groups);
    const [edited, sibling] = Object.keys(groups[strategyId].products);
    const averageProductId = Object.keys(groups[averageId].products)[0];
    const validation = deal.$validation.getState();
    const write = () =>
      deal.actions.writePathsAction([
        { path: fieldPath(strategyId, groups[strategyId].products[edited], "expiryCut"), value: "TK15" },
      ]);

    write();
    const next = deal.$groups.getState();
    expect(next[strategyId]).not.toBe(groups[strategyId]); // the path to the product is copied …
    expect(next[strategyId].products[edited]).not.toBe(groups[strategyId].products[edited]);
    expect(next[strategyId].ui).toBe(groups[strategyId].ui); // … nothing else
    expect(next[strategyId].products[sibling]).toBe(groups[strategyId].products[sibling]);
    expect(next[averageId]).toBe(groups[averageId]);
    expect(Object.keys(next)).toEqual([strategyId, averageId]); // order kept
    expect(deal.$validation.getState()[sibling]).toBe(validation[sibling]); // not re-validated
    expect(deal.$validation.getState()[averageProductId]).toBe(validation[averageProductId]);

    write();
    expect(deal.$groups.getState()).toBe(next); // same value: no update at all
    deal.dispose();
  });

  it("inserts a clone right after its source, in key order", async () => {
    const deal = await createDeal();
    deal.actions.addGroupAction("VanillaGroup");
    deal.actions.addGroupAction("Average");
    const [first, last] = Object.keys(deal.$groups.getState());
    deal.actions.cloneGroupAction(first);
    const ids = Object.keys(deal.$groups.getState());
    expect(ids).toHaveLength(3);
    expect([ids[0], ids[2]]).toEqual([first, last]);
    expect(Object.values(deal.$groups.getState()).map((group) => group.ui.title)).toEqual([
      "Vanilla Group #1", "Vanilla Group #2", "Average #3",
    ]);
    deal.dispose();
  });

  it("tells its listeners about an edit once, and about a write that changes nothing not at all", async () => {
    const deal = await createDeal();
    const { createPathDeal } = await import("../../src-effector-nested/stores/pathDeal.ts");
    deal.actions.addGroupAction("VanillaGroup");
    const pathDeal = createPathDeal(deal);
    const heard: string[] = [];
    const stop = pathDeal.subscribe((change) => heard.push(change.kind));
    pathDeal.writePaths([{ path: firstProduct(deal).path("strike"), value: "7" }]);
    expect(heard).toEqual(["products"]); // its data and its issues: one report
    heard.length = 0;
    pathDeal.writePaths([{ path: "isInternal", value: true }]); // already internal
    expect(heard).toEqual([]);
    stop();
    deal.dispose();
  });

  it("dispose unlinks the deal from the shared options effects: it no longer reconciles", async () => {
    const api = installFakeApi({ Cash: [{ id: 3, name: "Shared" }, { id: 4, name: "C4" }] });
    const { sleep } = await import("./support/fakeApi.ts");
    const { loadOptionsEffect } = await import("../../src-effector-nested/stores/optionsStore.ts");
    const links = () => (loadOptionsEffect.done as unknown as { graphite: { next: unknown[] } }).graphite.next.length;
    const unlinked = links();
    const deal = await createDeal();
    expect(links()).toBeGreaterThan(unlinked);
    deal.actions.addGroupAction("VanillaGroup");
    const product = firstProduct(deal);
    deal.actions.writePathsAction([{ path: product.path("settlementStyle"), value: "Cash" }]);
    await sleep(40);
    expect(product.fixing()).toBe("3");

    deal.dispose();
    expect(links()).toBe(unlinked);
    api.lists.Cash = [{ id: 4, name: "C4" }];
    const other = await createDeal();
    other.actions.loadDealOptionsAction(); // Cash's options again, now without 3
    await sleep(40);
    expect(product.fixing()).toBe("3"); // the disposed deal didn't follow
    other.dispose();
  });

  it("options arriving reconcile every deal still on that parameter, not only the deal that asked", async () => {
    const api = installFakeApi({ Cash: [{ id: 3, name: "Shared" }, { id: 4, name: "C4" }] });
    const { sleep } = await import("./support/fakeApi.ts");
    const deal = await createDeal();
    deal.actions.addGroupAction("VanillaGroup");
    const product = firstProduct(deal);
    deal.actions.writePathsAction([{ path: product.path("settlementStyle"), value: "Cash" }]);
    await sleep(40);
    expect(product.fixing()).toBe("3");

    api.lists.Cash = [{ id: 4, name: "C4" }]; // 3 is no longer offered
    const other = await createDeal();
    other.actions.loadDealOptionsAction(); // another deal loads its deal column's Cash options
    await sleep(40);
    expect(product.fixing()).toBe("4");
    deal.dispose();
    other.dispose();
  });

  it("options arriving start one calculation, not two: products reconcile before the load counts as done", async () => {
    const api = installFakeApi({ Cash: [{ id: 3, name: "Shared" }, { id: 4, name: "C4" }] });
    const { sleep } = await import("./support/fakeApi.ts");
    const deal = await createDeal(true);
    deal.actions.addGroupAction("VanillaGroup");
    deal.actions.writePathsAction([
      { path: "notionalCcy", value: "USD" },
      { path: firstProduct(deal).path("settlementStyle"), value: "Cash" },
    ]);
    await sleep(60); // Cash's first option taken (3), and the deal priced
    expect(deal.$calc.getState().status).toBe("done");
    api.lists.Cash = [{ id: 4, name: "C4" }]; // 3 is no longer offered
    const started = new Set<number>();
    const stop = deal.$calc.watch(({ status, requestId }) => {
      if (status === "calculating") started.add(requestId);
    });

    deal.actions.cloneGroupAction(Object.keys(deal.$groups.getState())[0]); // the copy, still valid on 3, reloads Cash's options
    await sleep(60);
    const fixings = Object.values(deal.$groups.getState()).map((group) =>
      readField(Object.values(group.products)[0].data, "settlementFixingSource"),
    );
    expect(fixings).toEqual(["4", "4"]); // both reconciled
    expect(deal.$calc.getState().status).toBe("done");
    expect(started.size).toBe(1); // priced once, on the reconciled data: not on 3 first
    stop();
    deal.dispose();
  });

  it("a new tab's deal comes with its first group, its own sids, and its options loaded in the caller's scope", async () => {
    stubStorage({});
    const { allSettled, fork, serialize } = await import("effector");
    const tabs = await import("../../src-effector-nested/stores/multiTabStore.ts");
    const { $optionsByKey } = await import("../../src-effector-nested/stores/optionsStore.ts");
    const scope = fork();
    await allSettled(tabs.addNewDealAction, { scope });
    await allSettled(tabs.addNewDealAction, { scope });
    const deals = Object.values(scope.getState(tabs.$deals));
    const groupCounts = (read: (deal: Deal) => object) => deals.map((deal) => Object.keys(read(deal)).length);
    expect(groupCounts((deal) => scope.getState(deal.$groups))).toEqual([1, 1]);
    expect(deals[0].$groups.sid).not.toBe(deals[1].$groups.sid);
    expect(Object.keys(scope.getState($optionsByKey))).toEqual(["fixingSources:Cash"]);
    expect($optionsByKey.getState()).toEqual({}); // nothing outside the scope

    const restored = fork({ values: serialize(scope) });
    expect(groupCounts((deal) => restored.getState(deal.$groups))).toEqual([1, 1]); // each deal keeps its own
  });

  it("restores each stored switch on its own: a corrupt or wrong-typed one falls back to its default, quietly", async () => {
    const errors = vi.spyOn(console, "error");
    for (const stored of ["{not json", JSON.stringify("yes")]) {
      vi.resetModules();
      stubStorage({
        "effector-nested-devtools:isAutocalcEnabled": stored,
        "effector-nested-devtools:isSpotPriceStreamEnabled": "false",
      });
      const tabs = await import("../../src-effector-nested/stores/multiTabStore.ts");
      expect([tabs.$isAutocalcEnabled.getState(), tabs.$isSpotPriceStreamEnabled.getState()]).toEqual([true, false]);
    }
    expect(errors).not.toHaveBeenCalled();
  });
});

describe("effector-model", () => {
  beforeEach(() => {
    installFakeApi();
    vi.resetModules();
  });

  const createDeal = async (autocalc = false) => {
    const { createStore } = await import("effector");
    const { createDealStore } = await import("../../src-effector-model/stores/dealStore.ts");
    return createDealStore({ $isSpotPriceStreamEnabled: createStore(false), $isAutocalcEnabled: createStore(autocalc) });
  };
  type Deal = Awaited<ReturnType<typeof createDeal>>;
  /** The deal's first product: its path to a field, and its Fixing Source now. */
  const firstProduct = (deal: Deal) => {
    const group = () => deal.$groups.getState()[0];
    return {
      path: (fieldId: string) => fieldPath(group().id, group().products[0] as never, fieldId),
      fixing: () => readField(group().products[0].data!, "settlementFixingSource"),
    };
  };
  /** A `localStorage` stand-in, and `storage` events from "another tab". */
  const stubStorage = (items: Record<string, string>) => {
    const values = new Map(Object.entries(items));
    const events = new EventTarget();
    vi.stubGlobal("localStorage", {
      getItem: (key: string) => values.get(key) ?? null,
      setItem: (key: string, value: string) => void values.set(key, value),
      removeItem: (key: string) => void values.delete(key),
    });
    vi.stubGlobal("addEventListener", events.addEventListener.bind(events));
    vi.stubGlobal("removeEventListener", events.removeEventListener.bind(events));
    return (key: string, newValue: string) =>
      events.dispatchEvent(Object.assign(new Event("storage"), { storageArea: localStorage, key, newValue }));
  };

  it("a write reaches only its own product's stores", async () => {
    const deal = await createDeal();
    deal.actions.addGroupAction("Strategy");
    deal.actions.addGroupAction("Average");
    const groups = deal.$groups.getState();
    const [strategy, average] = groups;
    const [edited, sibling] = strategy.products;
    const write = () => deal.actions.writePathsAction([{ path: fieldPath(strategy.id, edited as never, "expiryCut"), value: "TK15" }]);

    write();
    const [nextStrategy, nextAverage] = deal.$groups.getState();
    expect(nextStrategy.products[0]).not.toBe(edited); // the edited product's item …
    expect(nextStrategy.products[1]).toBe(sibling); // … nothing else
    expect(nextStrategy.products[1].issues).toBe(sibling.issues); // not re-validated
    expect(nextStrategy.ui).toBe(strategy.ui);
    expect(nextAverage).toBe(average);

    const unchanged = deal.$groups.getState();
    write();
    expect(deal.$groups.getState()).toBe(unchanged); // same value: no update at all
    deal.dispose();
  });

  it("inserts a clone right after its source", async () => {
    const deal = await createDeal();
    deal.actions.addGroupAction("VanillaGroup");
    deal.actions.addGroupAction("Average");
    const [first, last] = deal.$order.getState();
    deal.actions.cloneGroupAction(first);
    const ids = deal.$order.getState();
    expect(ids).toHaveLength(3);
    expect([ids[0], ids[2]]).toEqual([first, last]);
    expect(deal.$groups.getState().map((group) => group.ui.title)).toEqual([
      "Vanilla Group #1", "Vanilla Group #2", "Average #3",
    ]);
    deal.dispose();
  });

  it("a batch over 10 groups outdates the price once, and autocalc prices it once, whole", async () => {
    const { sleep } = await import("./support/fakeApi.ts");
    const deal = await createDeal(true);
    for (let i = 0; i < 10; i += 1) deal.actions.addGroupAction("VanillaGroup");
    deal.actions.writePathsAction([{ path: "notionalCcy", value: "USD" }]);
    await sleep(60);
    expect(deal.$calc.getState()).toMatchObject({ status: "done", price: 10 });
    const started = new Set<number>();
    const stop = deal.$calc.watch(({ status, requestId }) => {
      if (status === "calculating") started.add(requestId);
    });
    const { requestId } = deal.$calc.getState();

    deal.actions.writePathsAction([{ path: "notionalAmount", value: 1000 }]); // synced: every product, in 10 groups
    expect(deal.$calc.getState().requestId - requestId).toBe(2); // outdated once, then the one request
    expect(started.size).toBe(1);
    await sleep(60);
    expect(deal.$calc.getState()).toMatchObject({ status: "done", price: 20 }); // (1 + 1000 / 1000) × 10
    stop();
    deal.dispose();
  });

  it("dispose unlinks the deal from the shared options effects: it no longer reconciles", async () => {
    const api = installFakeApi({ Cash: [{ id: 3, name: "Shared" }, { id: 4, name: "C4" }] });
    const { sleep } = await import("./support/fakeApi.ts");
    const { loadOptionsEffect } = await import("../../src-effector-model/stores/optionsStore.ts");
    const links = () => (loadOptionsEffect.done as unknown as { graphite: { next: unknown[] } }).graphite.next.length;
    const unlinked = links();
    const deal = await createDeal();
    expect(links()).toBeGreaterThan(unlinked);
    deal.actions.addGroupAction("VanillaGroup");
    const product = firstProduct(deal);
    deal.actions.writePathsAction([{ path: product.path("settlementStyle"), value: "Cash" }]);
    await sleep(40);
    expect(product.fixing()).toBe("3");

    deal.dispose();
    expect(links()).toBe(unlinked);
    api.lists.Cash = [{ id: 4, name: "C4" }];
    const other = await createDeal();
    other.actions.loadDealOptionsAction(); // Cash's options again, now without 3
    await sleep(40);
    expect(product.fixing()).toBe("3"); // the disposed deal didn't follow
    other.dispose();
  });

  it("options arriving reconcile every deal still on that parameter, not only the deal that asked", async () => {
    const api = installFakeApi({ Cash: [{ id: 3, name: "Shared" }, { id: 4, name: "C4" }] });
    const { sleep } = await import("./support/fakeApi.ts");
    const deal = await createDeal();
    deal.actions.addGroupAction("VanillaGroup");
    const product = firstProduct(deal);
    deal.actions.writePathsAction([{ path: product.path("settlementStyle"), value: "Cash" }]);
    await sleep(40);
    expect(product.fixing()).toBe("3");

    api.lists.Cash = [{ id: 4, name: "C4" }]; // 3 is no longer offered
    const other = await createDeal();
    other.actions.loadDealOptionsAction(); // another deal loads its deal column's Cash options
    await sleep(40);
    expect(product.fixing()).toBe("4");
    deal.dispose();
    other.dispose();
  });

  it("options arriving start one calculation, not two: products reconcile before the load counts as done", async () => {
    const api = installFakeApi({ Cash: [{ id: 3, name: "Shared" }, { id: 4, name: "C4" }] });
    const { sleep } = await import("./support/fakeApi.ts");
    const deal = await createDeal(true);
    deal.actions.addGroupAction("VanillaGroup");
    deal.actions.writePathsAction([
      { path: "notionalCcy", value: "USD" },
      { path: firstProduct(deal).path("settlementStyle"), value: "Cash" },
    ]);
    await sleep(60); // Cash's first option taken (3), and the deal priced
    expect(deal.$calc.getState().status).toBe("done");
    api.lists.Cash = [{ id: 4, name: "C4" }]; // 3 is no longer offered
    const started = new Set<number>();
    const stop = deal.$calc.watch(({ status, requestId }) => {
      if (status === "calculating") started.add(requestId);
    });

    deal.actions.cloneGroupAction(deal.$order.getState()[0]); // the copy, still valid on 3, reloads Cash's options
    await sleep(60);
    const fixings = deal.$groups.getState().map((group) => readField(group.products[0].data!, "settlementFixingSource"));
    expect(fixings).toEqual(["4", "4"]); // both reconciled
    expect(deal.$calc.getState().status).toBe("done");
    expect(started.size).toBe(1); // priced once, on the reconciled data: not on 3 first
    stop();
    deal.dispose();
  });

  it("a new tab's deal comes with its first group", async () => {
    stubStorage({});
    const tabs = await import("../../src-effector-model/stores/multiTabStore.ts");
    tabs.addNewDealAction();
    const [deal] = Object.values(tabs.$deals.getState());
    expect(deal.$groups.getState().map((group) => group.groupType)).toEqual(["VanillaGroup"]);
  });

  it("keeps its switches to itself: another browser tab's change isn't followed (D3: only Effector Nested syncs)", async () => {
    const fromOtherTab = stubStorage({});
    const tabs = await import("../../src-effector-model/stores/multiTabStore.ts");
    fromOtherTab("effector-model-devtools:isAutocalcEnabled", "false");
    expect(tabs.$isAutocalcEnabled.getState()).toBe(true);
    tabs.toggleAutocalcEnabledAction();
    expect(localStorage.getItem("effector-model-devtools:isAutocalcEnabled")).toBe("false"); // its own changes are saved
  });

  it("restores each stored switch on its own: a corrupt or wrong-typed one falls back to its default, quietly", async () => {
    const errors = vi.spyOn(console, "error");
    for (const stored of ["{not json", JSON.stringify("yes")]) {
      vi.resetModules();
      stubStorage({
        "effector-model-devtools:isAutocalcEnabled": stored,
        "effector-model-devtools:isSpotPriceStreamEnabled": "false",
      });
      const tabs = await import("../../src-effector-model/stores/multiTabStore.ts");
      expect([tabs.$isAutocalcEnabled.getState(), tabs.$isSpotPriceStreamEnabled.getState()]).toEqual([true, false]);
    }
    expect(errors).not.toHaveBeenCalled();
  });
});
