import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Atom, Getter } from "jotai/vanilla";
import { installFakeApi, sleep } from "./support/fakeApi.ts";
import {
  cashLists,
  crossDealReconcile,
  forceGc,
  groupsVisitedByLookup,
  installFakeExtension,
  installLocalStorage,
  storedSwitchCases,
} from "./support/reviewHelpers.ts";

// Jotai regressions from the review (review/REVIEW.md §2.1, §3 Jotai, §4)

const OFF = { isSpotPriceStreamEnabled: false, isAutocalcEnabled: false };

beforeEach(() => {
  vi.resetModules();
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

/** A deal on its own, with a plain switches atom, in jotai's default store. */
const importDeal = async () => {
  const { atom, getDefaultStore } = await import("jotai/vanilla");
  const { createDealStore } = await import("../../src-jotai/stores/dealStore.ts");
  const { createPathDeal } = await import("../../src-jotai/stores/pathDeal.ts");
  const devtoolsAtom = atom(OFF);
  return { store: getDefaultStore(), createDeal: () => createDealStore(devtoolsAtom), createPathDeal };
};

/** The real tab store, over the given localStorage. */
const importTabs = async (stored: Record<string, string> = { "jotai-devtools": JSON.stringify(OFF) }) => {
  const data = installLocalStorage(stored);
  const { getDefaultStore } = await import("jotai/vanilla");
  const { multiTabStore } = await import("../../src-jotai/stores/multiTabStore.ts");
  return { data, store: getDefaultStore(), multiTabStore };
};

describe("jotai", () => {
  it("a new deal starts with its first group (not added by the grid's mount)", async () => {
    installFakeApi();
    const { store, multiTabStore } = await importTabs();
    multiTabStore.actions.addNewDeal();
    const deal = store.get(multiTabStore.dealsAtom)[store.get(multiTabStore.activeDealIdAtom)];
    const groups = store.get(deal.groupsAtom);
    expect(store.get(deal.groupIdsAtom).map((id) => store.get(groups[id].uiAtom).title)).toEqual(["Vanilla Group #1"]);
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

  it("the deal-wide error flag reads only the products' issues, not their data", async () => {
    installFakeApi();
    const { store, createDeal } = await importDeal();
    const deal = createDeal();
    deal.actions.addNewGroup("Strategy");
    deal.actions.addNewGroup("Average");
    const groups = store.get(deal.groupsAtom);
    const dataAtoms = new Set<Atom<unknown>>(
      Object.values(groups).flatMap((group) => Object.values(group.products).map((product) => product.dataAtom)),
    );
    const read: Atom<unknown>[] = [];
    const get = ((target: Atom<unknown>) => {
      read.push(target);
      return store.get(target);
    }) as Getter;
    deal.hasValidationErrorsAtom.read(get, { signal: new AbortController().signal, setSelf: () => {} } as never);
    expect(read.filter((target) => dataAtoms.has(target))).toEqual([]);
    deal.dispose();
  });

  it("product lookups go straight to the product's group (an index), reading the groups once", async () => {
    installFakeApi();
    const { store, createDeal, createPathDeal } = await importDeal();
    const deal = createDeal();
    for (let i = 0; i < 8; i++) deal.actions.addNewGroup("Strategy");
    const pathDeal = createPathDeal(deal);
    pathDeal.getProduct(pathDeal.getGroups()[0].productIds[0]);
    expect(groupsVisitedByLookup(pathDeal, () => store.get(deal.groupsAtom))).toBeLessThanOrEqual(1);
    const [last] = pathDeal.getGroups().at(-1)!.productIds;
    const get = vi.spyOn(store, "get");
    pathDeal.getProduct(last);
    expect(get.mock.calls.filter(([target]) => target === deal.groupsAtom)).toHaveLength(1);
    deal.dispose();
  });

  it("saves the switches at once; a bad stored value (even `null`) falls back to the defaults key by key", async () => {
    for (const [stored, expected] of storedSwitchCases) {
      vi.resetModules();
      const { store, multiTabStore } = await importTabs({ "jotai-devtools": stored });
      expect({ stored, switches: store.get(multiTabStore.devtoolsAtom) }).toEqual({ stored, switches: expected });
    }
    vi.resetModules();
    const { data, multiTabStore } = await importTabs({});
    multiTabStore.actions.toggleAutocalcEnabled();
    expect(JSON.parse(data.get("jotai-devtools")!)).toEqual({ isSpotPriceStreamEnabled: true, isAutocalcEnabled: false });
  });

  it("DevTools report a top-level set without a label too", async () => {
    installFakeApi();
    const extension = installFakeExtension();
    const { store, multiTabStore } = await importTabs();
    await import("../../src-jotai/devtools.ts");
    const connection = extension.byName("Deal editor (Jotai)")!;
    const before = connection.sends.length;
    store.set(multiTabStore.activeDealIdAtom, "some deal"); // no action: an unlabelled atom, set from outside
    const sent = connection.sends.slice(before);
    expect(sent).toHaveLength(1);
    expect(JSON.parse(sent[0].state).activeDealId).toBe("some deal");
  });

  it("dispose lets a deal go: the shared atoms keep nothing of it", async () => {
    installFakeApi();
    const { createDeal } = await importDeal();
    // in a sync function, so no async frame keeps the deal alive
    const make = () => {
      const deal = createDeal();
      deal.actions.addNewGroup("VanillaGroup");
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
});
