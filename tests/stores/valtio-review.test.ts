import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { installFakeApi, sleep } from "./support/fakeApi.ts";
import {
  at,
  cashLists,
  crossDealReconcile,
  fieldPathIn,
  forceGc,
  groupsVisitedByLookup,
  installFakeExtension,
  installLocalStorage,
  oneCalculationOnArrival,
  storedSwitchCases,
} from "./support/reviewHelpers.ts";

// Valtio regressions from the review (review/REVIEW.md §2.1, §3 Valtio, §4)

const MULTI_TAB_STORE = at("src-valtio/stores/multiTabStore.ts");

beforeEach(() => {
  vi.resetModules();
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
  vi.doUnmock(MULTI_TAB_STORE);
  vi.doUnmock("valtio-reactive");
});

/** The deal on its own, as the store tests build it: a plain switches proxy instead of the tab store. */
const importDeal = async (isAutocalcEnabled = false) => {
  vi.doMock(MULTI_TAB_STORE, async () => {
    const { proxy } = await import("valtio");
    return { multiTabStore: proxy({ devtools: { isSpotPriceStreamEnabled: false, isAutocalcEnabled } }) };
  });
  const { createDealStore } = await import("../../src-valtio/stores/dealStore.ts");
  const { createPathDeal } = await import("../../src-valtio/stores/pathDeal.ts");
  return { createDealStore, createPathDeal };
};

/** The real tab store, over the given localStorage. */
const importTabs = async (stored: Record<string, string> = {}) => {
  const data = installLocalStorage(stored);
  const { multiTabStore } = await import("../../src-valtio/stores/multiTabStore.ts");
  return { data, multiTabStore };
};

describe("valtio", () => {
  it("a new deal starts with its first group (not added by the grid's mount)", async () => {
    installFakeApi();
    const { multiTabStore } = await importTabs(
      { "valtio-devtools": JSON.stringify({ isSpotPriceStreamEnabled: false, isAutocalcEnabled: false }) },
    );
    multiTabStore.actions.addNewDeal();
    const deal = multiTabStore.deals[multiTabStore.activeDealId];
    expect(deal.groupIds.map((id) => deal.groups[id].ui.title)).toEqual(["Vanilla Group #1"]);
    deal.actions.dispose();
  });

  it("options arriving reconcile every deal on that parameter, not just the deal that asked", async () => {
    const api = installFakeApi(cashLists());
    const { createDealStore, createPathDeal } = await importDeal();
    const deals: ReturnType<typeof createDealStore>[] = [];
    const result = await crossDealReconcile(api, () => {
      const deal = createDealStore();
      deals.push(deal);
      return createPathDeal(deal);
    });
    expect(result).toEqual({ before: "3", after: "4" });
    deals.forEach((deal) => deal.actions.dispose());
  });

  it("options arriving start one calculation, not two: products reconcile before the load counts as done", async () => {
    const api = installFakeApi(cashLists());
    const { createDealStore, createPathDeal } = await importDeal(true);
    const { subscribeKey } = await import("valtio/utils");
    const deal = createDealStore();
    const started = new Set<number>();
    subscribeKey(deal, "calc", (calc) => {
      if (calc.status === "calculating") started.add(calc.requestId);
    }, true);
    const result = await oneCalculationOnArrival(api, createPathDeal(deal), () => started.size);
    expect(result).toEqual({ fixings: ["4", "4"], started: 1 });
    expect(deal.calc.status).toBe("done");
    deal.actions.dispose();
  });

  it("after a nested object is replaced (a container written as a whole), its fields are still validated and repainted", async () => {
    installFakeApi();
    const { createDealStore, createPathDeal } = await importDeal();
    const { getValueByPath, setValueByPath } = await import("@shared/lib/path.ts");
    const store = createDealStore();
    store.actions.addNewGroup("Strategy");
    const deal = createPathDeal(store);
    deal.writePaths([{ path: "notionalCcy", value: "USD" }]);
    const [productId] = deal.getGroups()[0].productIds;
    const { data } = deal.getProduct(productId)!; // the live proxy
    const notional = fieldPathIn(deal, 0, "notionalCcy").replace(/^.*\.data\./, "").replace(/\.notionalCcy$/, "");
    setValueByPath(data, notional, { ...(getValueByPath(data, notional) as object) }); // a new nested proxy
    await sleep(0);
    const repainted = new Set<string>();
    const stop = deal.subscribe((change) => {
      if (change.kind === "products") change.ids.forEach((id) => repainted.add(id));
    });

    deal.writePaths([{ path: fieldPathIn(deal, 0, "notionalAmount"), value: -1 }]); // synced: every product
    await sleep(0);
    const ids = deal.getGroups()[0].productIds;
    expect(ids.map((id) => deal.fieldIssues(id, "notionalAmount").map(({ message }) => message))).toEqual(
      ids.map(() => ["Must be greater than 0"]),
    );
    expect(store.hasValidationErrors).toBe(true);
    expect([...repainted].sort()).toEqual([...ids].sort());
    stop();
    store.actions.dispose();
  });

  it("dispose lets a deal go: nothing global keeps it", async () => {
    installFakeApi();
    const { createDealStore } = await importDeal();
    // in a sync function, so no async frame keeps the deal alive
    const make = () => {
      const deal = createDealStore();
      deal.actions.addNewGroup("VanillaGroup");
      deal.actions.dispose();
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
    const { createDealStore, createPathDeal } = await importDeal();
    const store = createDealStore();
    for (let i = 0; i < 8; i++) store.actions.addNewGroup("Strategy");
    const deal = createPathDeal(store);
    deal.getProduct(deal.getGroups()[0].productIds[0]);
    expect(groupsVisitedByLookup(deal, () => store.groups)).toBeLessThanOrEqual(1);
    store.actions.dispose();
  });

  it("removing a group from a big deal costs little more than from a small one (it scanned every product's validation)", async () => {
    installFakeApi();
    const { createDealStore, createPathDeal } = await importDeal();
    /** The median time to remove the last group of a deal of `count` groups, the grid watching. */
    const removalCost = (count: number) => {
      const store = createDealStore();
      const deal = createPathDeal(store);
      const stop = deal.subscribe(() => {});
      for (let i = 0; i < count; i++) deal.addGroup("Strategy");
      const samples: number[] = [];
      for (let i = 0; i < 31; i++) {
        const { id } = deal.getGroups().at(-1)!;
        const started = performance.now();
        deal.removeGroup(id);
        samples.push(performance.now() - started);
        deal.addGroup("Strategy");
      }
      stop();
      store.actions.dispose();
      return samples.sort((a, b) => a - b)[15];
    };
    removalCost(25); // warm up
    const [small, big] = [removalCost(25), removalCost(400)];
    console.log(`[remove] last of 25: ${(small * 1000).toFixed(0)} µs, last of 400: ${(big * 1000).toFixed(0)} µs`);
    expect(big / small).toBeLessThan(6); // 16× the groups: about 4× the time (it was about 9×)
  });

  it("doesn't load valtio-reactive (it slows every proxy read)", async () => {
    let loaded = false;
    vi.doMock("valtio-reactive", () => {
      loaded = true;
      return { effect: () => () => {} };
    });
    installFakeApi();
    await importDeal();
    await import("../../src-valtio/stores/multiTabStore.ts");
    expect(loaded).toBe(false);
  });

  it("saves the switches at once under its own key; a bad stored value falls back to the defaults key by key", async () => {
    for (const [stored, expected] of storedSwitchCases) {
      vi.resetModules();
      const { multiTabStore } = await importTabs({ "valtio-devtools": stored });
      expect({ stored, switches: { ...multiTabStore.devtools } }).toEqual({ stored, switches: expected });
    }
    vi.resetModules();
    const { data, multiTabStore } = await importTabs();
    multiTabStore.actions.toggleAutocalcEnabled();
    expect(JSON.parse(data.get("valtio-devtools")!)).toEqual({ isSpotPriceStreamEnabled: true, isAutocalcEnabled: false });
  });

  it("DevTools only report: each batch once (and with ?debug, to the console); a jump leaves the app working", async () => {
    installFakeApi();
    const extension = installFakeExtension("?debug");
    const log = vi.spyOn(console, "log").mockImplementation(() => {});
    const { multiTabStore } = await importTabs(
      { "valtio-devtools": JSON.stringify({ isSpotPriceStreamEnabled: false, isAutocalcEnabled: false }) },
    );
    const { createPathDeal } = await import("../../src-valtio/stores/pathDeal.ts");
    await import("../../src-valtio/devtools.ts");
    multiTabStore.actions.addNewDeal();
    const deal = multiTabStore.deals[multiTabStore.activeDealId];
    await sleep(20);
    const connection = extension.byName("Deal editor (Valtio)")!;
    const before = connection.sends.length;

    const strike = fieldPathIn(createPathDeal(deal), 0, "strike");
    deal.actions.writePaths([{ path: strike, value: "1" }]);
    await sleep(0);
    const sent = connection.sends.slice(before);
    expect(sent).toHaveLength(1); // the edit and the price it outdates: one batch
    expect(sent[0].action.type, sent[0].action.type).toContain(strike);
    expect(JSON.parse(sent[0].state).deals[multiTabStore.activeDealId]).toBeDefined();
    expect(log.mock.calls.some(([first]) => String(first).startsWith(`[Deal editor (Valtio)] deals.`))).toBe(true);

    connection.dispatch("JUMP_TO_STATE", connection.sends[0].state);
    await sleep(0);
    expect(typeof multiTabStore.actions.addNewDeal).toBe("function");
    expect(typeof deal.actions.writePaths).toBe("function");
    multiTabStore.actions.addNewDeal();
    expect(Object.keys(multiTabStore.deals)).toHaveLength(2);
    Object.values(multiTabStore.deals).forEach((open) => open.actions.dispose());
  });
});
