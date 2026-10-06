import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { dateInDays } from "@shared/lib/date.ts";
import type { DealChange, PathDeal } from "@shared/pathDeal.ts";
import { productPath } from "@shared/paths.ts";
import { definitionOf } from "@shared/products/productRegistry.ts";
import { type DealAdapter, appNames, createAdapter } from "./support/adapters.ts";
import { type FakeApi, installFakeApi, sleep } from "./support/fakeApi.ts";

/**
 * The shared rules' fixes as every app shows them, through its PathDeal:
 * REVIEW §2.4–2.8, §2.10–2.12 and §4.
 */
describe.each(appNames)("%s: shared rules", (app) => {
  let adapter: DealAdapter;
  let deal: PathDeal;
  let api: FakeApi;

  const proto = Object.prototype as Record<string, unknown>;
  /** The i-th product's data path, across groups. */
  const pathOf = (i: number, dataPath: string) => {
    const products = deal.getGroups().flatMap((group) => group.productIds.map((productId) => ({ groupId: group.id, productId })));
    return productPath(products[i].groupId, products[i].productId, dataPath);
  };
  const fieldPathOf = (i: number, fieldId: string) =>
    pathOf(i, (definitionOf("VanillaProduct").fieldPaths as Record<string, string>)[fieldId]);

  beforeEach(async () => {
    api = installFakeApi({ Cash: [{ id: 4, name: "C4" }, { id: 3, name: "Shared" }] });
    adapter = await createAdapter(app);
    deal = adapter.deal();
    deal.addGroup("Strategy"); // products 0 and 1, both Vanilla
    await sleep(20);
  });
  afterEach(() => {
    delete proto.polluted;
    adapter.dispose();
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  it("P4: a path through __proto__ or constructor.prototype writes nothing anywhere", () => {
    for (const dataPath of ["__proto__.polluted", "constructor.prototype.polluted"]) {
      expect(() => deal.writePaths([{ path: pathOf(0, dataPath), value: "yes" }])).not.toThrow();
      expect(({} as Record<string, unknown>).polluted).toBeUndefined();
    }
    expect(() => deal.writePaths([{ path: "__proto__", value: { polluted: "yes" } }])).not.toThrow();
    expect(({} as Record<string, unknown>).polluted).toBeUndefined();
  });

  it("P4: a path under a leaf neither throws nor changes the field", () => {
    adapter.commit(0, "strike", "12");
    expect(() => deal.writePaths([{ path: `${fieldPathOf(0, "strike")}.x`, value: 1 }])).not.toThrow();
    expect(adapter.read(0, "strike")).toBe("12");
  });

  it("P2: Expiry Days far out of range neither throws nor tears the batch", () => {
    adapter.commit(1, "expiryDate", "2999-01-01");
    expect(() =>
      deal.writePaths([
        { path: fieldPathOf(0, "strike"), value: "77" },
        { path: fieldPathOf(1, "expiryDays"), value: 1e9 },
      ]),
    ).not.toThrow();
    expect(adapter.read(0, "strike")).toBe("77");
    expect(adapter.read(1, "expiryDate")).toBe(""); // no such date
  });

  it("F2/P3: writing the notional object keeps the deal and every product in sync", () => {
    deal.writePaths([{ path: pathOf(0, "optionsCommon.base.notional"), value: { notionalCcy: "EUR", amount: 5 } }]);
    expect([adapter.dealValue("notionalAmount"), adapter.read(0, "notionalAmount"), adapter.read(1, "notionalAmount")]).toEqual([5, 5, 5]);
    expect([adapter.dealValue("notionalCcy"), adapter.read(1, "notionalCcy")]).toEqual(["EUR", "EUR"]);
  });

  it("O1/P3: writing the cashSettlement object can't create a Fixing Source on a Delivery product", () => {
    deal.writePaths([{ path: pathOf(0, "cashSettlement"), value: { settlementCcy: "EUR", settlementFixingSource: "4" } }]);
    expect(adapter.has(0, "settlementFixingSource")).toBe(false);
    expect(adapter.read(0, "settlementCcy")).toBe("EUR");
  });

  it("P4: productType can't be written, and the product keeps working", () => {
    deal.writePaths([{ path: pathOf(0, "productType"), value: "Nope" }]);
    expect(adapter.productType(0)).toBe("VanillaProduct");
    deal.writePaths([{ path: "strike", value: "1" }]);
    expect(adapter.read(0, "strike")).toBe("1");
    expect(adapter.issues(0, "strike")).toEqual([]);
  });

  it("P3: a non-object written to a container is ignored, and validation keeps working", () => {
    deal.writePaths([{ path: pathOf(0, "optionsCommon"), value: null }]);
    expect(adapter.read(0, "strike")).toBe("");
    expect(() => adapter.hasValidationErrors()).not.toThrow();
    expect(adapter.issues(0, "deliveryDate")).toEqual([]);
  });

  it("P4/P6: a ccy pair written to a product the deal doesn't have changes nothing", () => {
    deal.writePaths([{ path: productPath("nope", "nope", "optionsCommon.base.ccyPair"), value: "EURUSD" }]);
    expect(adapter.dealValue("notionalCcy")).toBe("1xxxxxx");
    expect(adapter.read(0, "notionalCcy")).toBe("1xxxxxx");
  });

  it("S2: the settings column pasted in display order (Hedge e, Internal No) gives hedge e", () => {
    deal.writePaths([{ path: "hedgeType", value: "e" }, { path: "isInternal", value: "false" }]);
    expect(deal.getSettings()).toEqual({ isInternal: false, hedgeType: "e" });
  });

  it("S2: an Internal value that isn't Yes/No is ignored", () => {
    deal.writePaths([{ path: "isInternal", value: "maybe" }]);
    expect(deal.getSettings()).toEqual({ isInternal: true, hedgeType: "a" });
  });

  it("F3/F4: the deal column's Expiry Days moves every product's Expiry Date", () => {
    deal.writePaths([{ path: "expiryDays", value: 5 }]);
    for (const i of [0, 1]) {
      expect(adapter.read(i, "expiryDate")).toBe(dateInDays(5));
      expect(adapter.read(i, "expiryDays")).toBe(5);
    }
    expect(adapter.dealValue("expiryDays")).toBeUndefined(); // a broadcast holds nothing
  });

  it("E4/E5: a Fixing Source pasted as its label settles on that option", async () => {
    deal.writePaths([
      { path: fieldPathOf(1, "settlementStyle"), value: "Cash" },
      { path: pathOf(1, "cashSettlement.settlementFixingSource"), value: "Shared" }, // the label of option 3
    ]);
    await sleep(30); // Cash's options reloaded and reconciled
    expect(adapter.read(1, "settlementFixingSource")).toBe("3");
  });

  it("§4: writing a field and writing it back in one batch outdates nothing and repaints nothing", async () => {
    adapter.sync("notionalCcy", "USD");
    adapter.setAutocalc(true);
    await sleep(60);
    expect(adapter.calc().status).toBe("done");
    const seen: DealChange["kind"][] = [];
    const stop = deal.subscribe((change) => seen.push(change.kind));
    deal.writePaths([
      { path: fieldPathOf(0, "strike"), value: "5" },
      { path: "notionalAmount", value: 5 },
      { path: fieldPathOf(0, "strike"), value: "" },
      { path: "notionalAmount", value: NaN },
    ]);
    await sleep(40);
    stop();
    expect(adapter.calc().status).toBe("done");
    expect(seen.filter((kind) => kind === "products" || kind === "dealFields")).toEqual([]);
  });

  it("O8: a product whose options failed to load isn't invalid for good, and the deal is priced", async () => {
    adapter.sync("notionalCcy", "USD");
    adapter.setAutocalc(true);
    await sleep(60);
    api.failing.add("Cash");
    api.delays.Cash = 60;
    adapter.commit(0, "settlementStyle", "Cash");
    await sleep(30);
    expect(adapter.calc().status).toBe("outdated"); // still loading: not ready
    await sleep(80);
    expect(adapter.has(0, "settlementFixingSource")).toBe(false);
    expect(adapter.issues(0, "settlementFixingSource")).toEqual([]);
    expect(adapter.hasValidationErrors()).toBe(false);
    expect(adapter.calc()).toEqual({ status: "done", price: 2 });
  });
});
