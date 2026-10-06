import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { installFakeApi, sleep } from "./support/fakeApi.ts";
import {
  cashLists,
  crossDealReconcile,
  fieldPathIn,
  forceGc,
  groupsVisitedByLookup,
  installLocalStorage,
  oneCalculationOnArrival,
  storedSwitchCases,
} from "./support/reviewHelpers.ts";

// Legend-State regressions from the review (review/REVIEW.md §2.1, §3 Legend-State, §4)

const OFF = { isSpotPriceStreamEnabled: false, isAutocalcEnabled: false };

beforeEach(() => {
  vi.resetModules();
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

/** A deal on its own, with plain switches. */
const importDeal = async (isAutocalcEnabled = false) => {
  const { observable } = await import("@legendapp/state");
  const { createDealStore } = await import("../../src-legend-state/stores/dealStore.ts");
  const { createPathDeal } = await import("../../src-legend-state/stores/pathDeal.ts");
  const devtools$ = observable({ isSpotPriceStreamEnabled: false, isAutocalcEnabled });
  return { devtools$, createDeal: () => createDealStore(devtools$), createPathDeal };
};

/** The real tab store, over the given localStorage. */
const importTabs = async (stored: Record<string, string> = { "legend-state-devtools": JSON.stringify(OFF) }) => {
  const data = installLocalStorage(stored);
  const tabs = await import("../../src-legend-state/stores/multiTabStore.ts");
  return { data, ...tabs };
};

describe("legend-state", () => {
  it("a new deal starts with its first group (not added by the grid's mount)", async () => {
    installFakeApi();
    const { addNewDeal, dealStores, multiTab$ } = await importTabs();
    addNewDeal();
    const deal = dealStores.get(multiTab$.activeDealId.peek())!;
    const { groupIds, groups } = deal.deal$.peek();
    expect(groupIds.map((id) => groups[id].groupType)).toEqual(["VanillaGroup"]);
    deal.dispose();
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
    deals.forEach((deal) => deal.dispose());
  });

  it("options arriving start one calculation, not two: products reconcile before the load counts as done", async () => {
    const api = installFakeApi(cashLists());
    const { createDeal, createPathDeal } = await importDeal(true);
    const deal = createDeal();
    const started = new Set<number>();
    deal.deal$.calc.onChange(({ value }) => {
      if (value.status === "calculating") started.add(value.requestId);
    });
    const result = await oneCalculationOnArrival(api, createPathDeal(deal), () => started.size);
    expect(result).toEqual({ fixings: ["4", "4"], started: 1 });
    expect(deal.deal$.calc.status.peek()).toBe("done");
    deal.dispose();
  });

  it("a keystroke is one notification: the edit and the price it outdates land in one batch", async () => {
    installFakeApi();
    const { createDeal, createPathDeal } = await importDeal();
    const deal = createDeal();
    deal.addNewGroup("VanillaGroup");
    const pathDeal = createPathDeal(deal);
    let batches = 0;
    const stop = deal.deal$.onChange(() => batches++);
    pathDeal.writePaths([{ path: fieldPathIn(pathDeal, 0, "strike"), value: "1" }]);
    expect(batches).toBe(1);
    expect(deal.deal$.calc.requestId.peek()).toBe(2); // outdated by the group, then by the edit
    stop();
    deal.dispose();
  });

  it("removed products are freed: the heap doesn't grow with add/edit/remove cycles", async () => {
    installFakeApi();
    const { createDeal, createPathDeal } = await importDeal();
    const deal = createDeal();
    const pathDeal = createPathDeal(deal);
    const stop = pathDeal.subscribe(() => {}); // watched, as the grid watches it
    pathDeal.writePaths([{ path: "notionalCcy", value: "USD" }]);
    const cycle = (i: number) => {
      pathDeal.addGroup("Strategy");
      const groups = pathDeal.getGroups();
      const added = groups[groups.length - 1];
      pathDeal.writePaths(
        added.productIds.map((_, index) => ({ path: fieldPathIn(pathDeal, groups.length - 1, "strike", index), value: String(i % 900) })),
      );
      deal.hasValidationErrors$.get(); // observed, as the header and autocalc observe it
      pathDeal.removeGroup(added.id);
    };
    const cycles = async (count: number) => {
      for (let i = 0; i < count; i++) cycle(i);
      await sleep(40); // the options loads settle
      await forceGc();
      return process.memoryUsage().heapUsed;
    };
    await cycles(100); // warm up
    const before = await cycles(1);
    const after = await cycles(400);
    const kbPerCycle = (after - before) / 400 / 1024;
    console.log(`[legend-state] heap growth per add/edit/remove cycle (2 products): ${kbPerCycle.toFixed(1)} KB`);
    expect(kbPerCycle).toBeLessThan(5); // it was about 190 KB; the other apps keep about 1 KB
    stop();
    deal.dispose();
  });

  it("dispose lets a deal go: the shared options keep nothing of it", async () => {
    installFakeApi();
    const { createDeal } = await importDeal();
    // in a sync function, so no async frame keeps the deal alive
    const make = () => {
      const deal = createDeal();
      deal.addNewGroup("VanillaGroup");
      deal.isReady$.get(); // observed, as the header observes it
      deal.dispose();
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
    const deal = createDeal();
    for (let i = 0; i < 8; i++) deal.addNewGroup("Strategy");
    const pathDeal = createPathDeal(deal);
    pathDeal.getProduct(pathDeal.getGroups()[0].productIds[0]);
    expect(groupsVisitedByLookup(pathDeal, () => deal.deal$.peek().groups)).toBeLessThanOrEqual(1);
    deal.dispose();
  });

  it("saves the switches at once; a bad stored value falls back to the defaults key by key", async () => {
    for (const [stored, expected] of storedSwitchCases) {
      vi.resetModules();
      const { devtools$ } = await importTabs({ "legend-state-devtools": stored });
      expect({ stored, switches: devtools$.peek() }).toEqual({ stored, switches: expected });
    }
    vi.resetModules();
    const { data, devtools$ } = await importTabs({});
    devtools$.isAutocalcEnabled.toggle();
    expect(JSON.parse(data.get("legend-state-devtools")!)).toEqual({ isSpotPriceStreamEnabled: true, isAutocalcEnabled: false });
  });
});
