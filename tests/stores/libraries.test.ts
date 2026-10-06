import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { getValueByPath } from "@shared/lib/path.ts";
import { productPath } from "@shared/paths.ts";
import { definitionOf, productTypeOf, readField } from "@shared/products/productRegistry.ts";
import { installFakeApi, sleep } from "./support/fakeApi.ts";

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
      void watched.fields.strike.value;
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

  const createDeal = async () => {
    const { createStore } = await import("effector");
    const { createDealStore } = await import("../../src-effector-nested/stores/dealStore.ts");
    return createDealStore({ $isSpotPriceStreamEnabled: createStore(false), $isAutocalcEnabled: createStore(false) });
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
});

describe("effector-model", () => {
  beforeEach(() => {
    installFakeApi();
    vi.resetModules();
  });

  const createDeal = async () => {
    const { createStore } = await import("effector");
    const { createDealStore } = await import("../../src-effector-model/stores/dealStore.ts");
    return createDealStore({ $isSpotPriceStreamEnabled: createStore(false), $isAutocalcEnabled: createStore(false) });
  };

  it("a write reaches only its own product's stores", async () => {
    const deal = await createDeal();
    deal.actions.addGroupAction("Strategy");
    deal.actions.addGroupAction("Average");
    const groups = deal.$groups.getState();
    const [strategy, average] = groups;
    const [edited, sibling] = strategy.products;
    const write = () => deal.actions.writePathsAction([{ path: fieldPath(strategy.id, edited as never, "expiryCut"), value: "TK15" }]);
    const validation = deal.$validation.getState();

    write();
    const [nextStrategy, nextAverage] = deal.$groups.getState();
    expect(nextStrategy.products[0]).not.toBe(edited); // the edited product's item …
    expect(nextStrategy.products[1]).toBe(sibling); // … nothing else
    expect(deal.$validation.getState()[sibling.id]).toBe(validation[sibling.id]); // not re-validated
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
});

describe.each(["effector-nested", "effector-model"] as const)("%s: leaf changes", (app) => {
  beforeEach(() => {
    installFakeApi({ Cash: [{ id: 4, name: "C4" }] });
    vi.resetModules();
  });

  it("each batch reports exactly the leaves it changed, by full path (what DevTools shows)", async () => {
    const { createStore } = await import("effector");
    const { createDealStore } = await import(`../../src-${app}/stores/dealStore.ts`);
    const deal = createDealStore({ $isSpotPriceStreamEnabled: createStore(false), $isAutocalcEnabled: createStore(false) });
    deal.actions.addGroupAction("VanillaGroup");
    deal.actions.addGroupAction("Strategy");
    await sleep(20);
    const batches: { path: string; value?: unknown; removed?: true }[][] = [];
    const stop = deal.productLeavesChanged.watch((changes: never) => batches.push(changes));

    deal.actions.writePathsAction([{ path: "notionalAmount", value: 1000 }]); // synced: every product
    expect(batches).toHaveLength(1);
    expect(batches[0].map(({ path }) => path.replace(/^groups\.[^.]+\.products\.[^.]+\./, "…"))).toEqual([
      "…data.optionsCommon.base.notional.amount",
      "…data.optionsCommon.base.notional.amount",
      "…data.optionsCommon.base.notional.amount",
    ]);
    expect(batches[0].every(({ value }) => value === 1000)).toBe(true);

    deal.actions.writePathsAction([{ path: "notionalAmount", value: 1000 }]); // same value: no batch
    expect(batches).toHaveLength(1);

    const [first] = batches[0];
    const productRoot = first.path.slice(0, first.path.indexOf(".data.") + ".data.".length);
    deal.actions.writePathsAction([{ path: `${productRoot}settlementStyle`, value: "Cash" }]);
    expect(batches[1]).toEqual([{ path: `${productRoot}settlementStyle`, value: "Cash" }]);
    await sleep(20); // Cash's options arrive: the fixing source it adds is a batch of its own
    expect(batches[2]).toEqual([{ path: `${productRoot}cashSettlement.settlementFixingSource`, value: "4" }]);
    stop();
    deal.dispose();
  });
});
