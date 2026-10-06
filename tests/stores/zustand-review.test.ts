import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { installFakeApi, sleep } from "./support/fakeApi.ts";
import {
  cashLists,
  crossDealReconcile,
  fieldPathIn,
  forceGc,
  groupsVisitedByLookup,
  installFakeExtension,
  installLocalStorage,
  storedSwitchCases,
} from "./support/reviewHelpers.ts";

// Zustand regressions from the review (review/REVIEW.md §2.1, §3 Zustand, §4)

const OFF = { isSpotPriceStreamEnabled: false, isAutocalcEnabled: false };

beforeEach(() => {
  vi.resetModules();
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

/** A deal on its own, with a plain switches store. */
const importDeal = async (switches = OFF) => {
  const { createStore } = await import("zustand/vanilla");
  const { createDealStore } = await import("../../src-zustand/stores/dealStore.ts");
  const { createPathDeal } = await import("../../src-zustand/stores/pathDeal.ts");
  const devtools = createStore(() => switches);
  return { devtools, createDeal: () => createDealStore(devtools), createPathDeal };
};

/** The real tab store, over the given localStorage. */
const importTabs = async (stored: Record<string, string> = { "zustand-devtools": JSON.stringify(OFF) }) => {
  const data = installLocalStorage(stored);
  const { multiTabStore, devtoolsStore } = await import("../../src-zustand/stores/multiTabStore.ts");
  return { data, multiTabStore, devtoolsStore };
};

describe("zustand", () => {
  it("a new deal starts with its first group (not added by the grid's mount)", async () => {
    installFakeApi();
    const { multiTabStore } = await importTabs();
    multiTabStore.getState().actions.addNewDeal();
    const { deals, activeDealId } = multiTabStore.getState();
    const { groupIds, groups, actions } = deals[activeDealId].getState();
    expect(groupIds.map((id) => groups[id].ui.title)).toEqual(["Vanilla Group #1"]);
    actions.dispose();
  });

  it("options arriving reconcile every deal on that parameter, not just the deal that asked", async () => {
    const api = installFakeApi(cashLists());
    const { createDeal, createPathDeal } = await importDeal();
    const deals: ReturnType<typeof createDeal>[] = [];
    const result = await crossDealReconcile(api, () => {
      const deal = createDeal();
      deals.push(deal);
      return createPathDeal(deal);
    });
    expect(result).toEqual({ before: "3", after: "4" });
    deals.forEach((deal) => deal.getState().actions.dispose());
  });

  it("a listener that throws while a calculation starts doesn't leave it 'calculating': the request is already out", async () => {
    installFakeApi(cashLists());
    const { devtools, createDeal, createPathDeal } = await importDeal();
    const store = createDeal();
    store.getState().actions.addNewGroup("VanillaGroup");
    const deal = createPathDeal(store);
    deal.writePaths([
      { path: "notionalCcy", value: "USD" },
      { path: fieldPathIn(deal, 0, "settlementStyle"), value: "Cash" },
    ]);
    await sleep(60);
    const stop = store.subscribe(({ calc }) => {
      if (calc.status === "calculating") throw new Error("listener failed");
    });

    expect(() => devtools.setState({ isAutocalcEnabled: true })).toThrow("listener failed"); // autocalc starts
    stop();
    await sleep(60);
    expect(store.getState().calc.status).toBe("done");
    store.getState().actions.dispose();
  });

  it("dispose lets a deal go: the shared stores keep nothing of it", async () => {
    installFakeApi();
    const { createDeal } = await importDeal();
    // in a sync function, so no async frame keeps the deal alive
    const make = () => {
      const deal = createDeal();
      deal.getState().actions.addNewGroup("VanillaGroup");
      deal.getState().actions.dispose();
      return new WeakRef(deal);
    };
    const ref = make();
    const control = new WeakRef({});
    await sleep(30); // the options loads settle
    await forceGc();
    expect(control.deref()).toBeUndefined();
    expect(ref.deref()).toBeUndefined();
  });

  it("product lookups go straight to the product's group (an index), not through every group", async () => {
    installFakeApi();
    const { createDeal, createPathDeal } = await importDeal();
    const store = createDeal();
    for (let i = 0; i < 8; i++) store.getState().actions.addNewGroup("Strategy");
    const deal = createPathDeal(store);
    deal.getProduct(deal.getGroups()[0].productIds[0]);
    expect(groupsVisitedByLookup(deal, () => store.getState().groups)).toBeLessThanOrEqual(1);
    store.getState().actions.dispose();
  });

  it("time travel leaves the calculation alone: a jump never sticks on 'Calculating…' or starts a request", async () => {
    installFakeApi();
    const extension = installFakeExtension();
    const { multiTabStore, devtoolsStore } = await importTabs();
    const { createPathDeal } = await import("../../src-zustand/stores/pathDeal.ts");
    multiTabStore.getState().actions.addNewDeal();
    const { deals, activeDealId } = multiTabStore.getState();
    const store = deals[activeDealId];
    const deal = createPathDeal(store);
    if (!deal.getGroups().length) deal.addGroup("VanillaGroup");
    deal.writePaths([
      { path: "notionalCcy", value: "USD" },
      { path: "notionalAmount", value: 1000 },
      { path: "expiryDate", value: "2999-01-01" },
    ]);
    store.getState().actions.calculate();
    await sleep(60);
    deal.writePaths([{ path: fieldPathIn(deal, 0, "strike"), value: "1" }]); // outdated
    store.getState().actions.calculate();
    await sleep(60);
    const connection = extension.byName("Deal 1 (Zustand)")!;
    const calculating = connection.sends.findIndex(({ action }) => action.type === "calculate");
    const outdated = connection.sends.findLastIndex(({ action }) => action.type === "writePaths");
    devtoolsStore.setState({ isAutocalcEnabled: true });
    expect(store.getState().calc.status).toBe("done");
    const started = new Set<number>();
    const stop = store.subscribe(({ calc }) => {
      if (calc.status === "calculating") started.add(calc.requestId);
    });

    connection.dispatch("JUMP_TO_STATE", connection.sends[calculating].state);
    await sleep(60);
    expect(store.getState().calc.status).toBe("done");
    connection.dispatch("JUMP_TO_STATE", connection.sends[outdated].state);
    await sleep(60);
    expect(store.getState().calc.status).toBe("done");
    expect(started.size).toBe(0);
    stop();
    store.getState().actions.dispose();
  });

  it("the switches are loaded before the DevTools start: their first state is the stored one", async () => {
    installFakeApi();
    const extension = installFakeExtension();
    const { devtoolsStore } = await importTabs({
      "zustand-devtools": JSON.stringify({ isSpotPriceStreamEnabled: false, isAutocalcEnabled: false }),
    });
    expect(devtoolsStore.getState()).toEqual({ isSpotPriceStreamEnabled: false, isAutocalcEnabled: false });
    expect(JSON.parse(extension.byName("Devtools (Zustand)")!.inits[0])).toEqual({
      isSpotPriceStreamEnabled: false,
      isAutocalcEnabled: false,
    });
  });

  it("saves the switches at once; a bad stored value falls back to the defaults key by key", async () => {
    for (const [stored, expected] of storedSwitchCases) {
      vi.resetModules();
      const { devtoolsStore } = await importTabs({ "zustand-devtools": stored });
      expect({ stored, switches: devtoolsStore.getState() }).toEqual({ stored, switches: expected });
    }
    vi.resetModules();
    const { data, multiTabStore } = await importTabs({});
    multiTabStore.getState().actions.toggleAutocalcEnabled();
    expect(JSON.parse(data.get("zustand-devtools")!)).toEqual({ isSpotPriceStreamEnabled: true, isAutocalcEnabled: false });
  });
});
