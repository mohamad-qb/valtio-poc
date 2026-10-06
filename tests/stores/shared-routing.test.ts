import { describe, expect, it } from "vitest";
import { initialDealFields, isBroadcastField } from "@shared/dealFields.ts";
import { type DealReducer, runDealLogic } from "@shared/dealLogic/changes.ts";
import { initialDealSettings, withSetting } from "@shared/dealSettings.ts";
import { type DealProduct, routeWrites } from "@shared/dealWrites.ts";
import type { ProductFieldId } from "@shared/fields.ts";
import { dateInDays } from "@shared/lib/date.ts";
import { reconcileOption } from "@shared/options/optionsSource.ts";
import { type PathWrite, productPath } from "@shared/paths.ts";
import { definitionOf, readField } from "@shared/products/productRegistry.ts";
import { planProductWrites } from "@shared/products/productWrites.ts";

/**
 * The shared router and the rules beside it: settings order (REVIEW §2.8), the
 * ccy pair rule (§2.12), write and write back (§4), the deal column's Expiry
 * Days (§2.11), label-aware reconcile (§2.7), container writes (§2.6) and the
 * router's cost (§7.5).
 */

const productsOf = (count: number, productType: "VanillaProduct" | "AverageProduct" = "VanillaProduct"): DealProduct[] =>
  Array.from({ length: count }, (_, i) => ({
    groupId: `g${i}`,
    productId: `p${i}`,
    data: definitionOf(productType).createData(initialDealFields),
  }));
const dealOf = (products: DealProduct[] = productsOf(2)) => ({ dealFields: initialDealFields, settings: initialDealSettings, products });
const fieldPath = ({ groupId, productId, data }: DealProduct, fieldId: ProductFieldId) =>
  productPath(groupId, productId, definitionOf(data.productType).fieldPaths[fieldId]);

/** Each product's data after the routed writes. */
const applied = (deal: ReturnType<typeof dealOf>, writes: readonly PathWrite[]) => {
  const routed = routeWrites(deal, writes);
  const data = deal.products.map((product) => {
    const own = routed.products.get(product.productId);
    return own ? planProductWrites(product.data, own.writes).data : product.data;
  });
  return { routed, data };
};

describe("reconcileOption: a value, or an option's label", () => {
  const options = [{ value: "4", label: "C4" }, { value: "3", label: "Shared" }];

  it("resolves a pasted label to its option's value", () => {
    expect(reconcileOption("Shared", options)).toBe("3");
    expect(reconcileOption("C4", options)).toBe("4");
  });

  it("prefers a value over another option's label, and falls back to the first option", () => {
    expect(reconcileOption("b", [{ value: "a", label: "b" }, { value: "b", label: "x" }])).toBe("b");
    expect(reconcileOption("3", options)).toBe("3");
    expect(reconcileOption("nope", options)).toBe("4");
    expect(reconcileOption(undefined, [])).toBe("");
  });
});

describe("deal settings", () => {
  it("Internal takes only true/false, 'true'/'false' or Yes/No; anything else is ignored", () => {
    for (const value of ["yes", "", undefined, null, 1, 0, "TRUE", "maybe"]) {
      expect(withSetting(initialDealSettings, "isInternal", value)).toBe(initialDealSettings);
    }
    for (const value of [false, "false", "No"]) {
      expect(withSetting(initialDealSettings, "isInternal", value)).toEqual({ isInternal: false, hedgeType: "d" });
    }
    const external = { isInternal: false, hedgeType: "e" };
    for (const value of [true, "true", "Yes"]) {
      expect(withSetting(external, "isInternal", value)).toEqual({ isInternal: true, hedgeType: "a" });
    }
  });

  it("a setting written with the values it has returns the same object", () => {
    expect(withSetting(initialDealSettings, "isInternal", true)).toBe(initialDealSettings);
    expect(withSetting(initialDealSettings, "isInternal", "Yes")).toBe(initialDealSettings);
    expect(withSetting(initialDealSettings, "hedgeType", "a")).toBe(initialDealSettings);
    expect(withSetting(initialDealSettings, "hedgeType", "e")).toBe(initialDealSettings); // not offered: ignored
  });

  it("in a batch, Internal lands before Hedge Type: the settings column pasted in display order keeps its hedge type", () => {
    const pasted = routeWrites(dealOf(), [{ path: "hedgeType", value: "e" }, { path: "isInternal", value: "No" }]);
    expect(pasted.settings).toEqual({ isInternal: false, hedgeType: "e" });
    const inOrder = routeWrites(dealOf(), [{ path: "isInternal", value: "false" }, { path: "hedgeType", value: "f" }]);
    expect(inOrder.settings).toEqual({ isInternal: false, hedgeType: "f" });
    const notOffered = routeWrites(dealOf(), [{ path: "hedgeType", value: "b" }, { path: "isInternal", value: false }]);
    expect(notOffered.settings).toEqual({ isInternal: false, hedgeType: "d" });
  });

  it("settings written and written back are the same object", () => {
    const routed = routeWrites(dealOf(), [{ path: "isInternal", value: false }, { path: "isInternal", value: true }]);
    expect(routed.settings).toBe(initialDealSettings);
  });
});

describe("deal fields: write and write back", () => {
  it("leaves the deal fields the same object and every product's data unchanged", () => {
    const deal = dealOf();
    for (const writes of [
      [{ path: "notionalAmount", value: 5 }, { path: "notionalAmount", value: NaN }],
      [{ path: fieldPath(deal.products[1], "premiumCcy"), value: "EUR" }, { path: "premiumCcy", value: "2" }],
      [{ path: "notionalCcy", value: initialDealFields.notionalCcy }],
    ]) {
      const { routed, data } = applied(deal, writes);
      expect(routed.dealFields).toBe(initialDealFields);
      data.forEach((next, i) => expect(next).toBe(deal.products[i].data));
    }
  });
});

describe("the ccy pair rule", () => {
  it("ignores a product path for a product the deal doesn't have", () => {
    const routed = routeWrites(dealOf(), [{ path: productPath("nope", "nope", "optionsCommon.base.ccyPair"), value: "EURUSD" }]);
    expect(routed.dealFields.notionalCcy).toBe(initialDealFields.notionalCcy);
    expect(routed.products.size).toBe(0);
  });

  it("still fires for a product the deal has, and for the deal column", () => {
    const deal = dealOf();
    expect(routeWrites(deal, [{ path: fieldPath(deal.products[1], "ccyPair"), value: "EURUSD" }]).dealFields.notionalCcy).toBe("EUR");
    expect(routeWrites(deal, [{ path: "ccyPair", value: "GBPUSD" }]).dealFields.notionalCcy).toBe("GBP");
  });

  it("reducers see no write to a product the deal doesn't have", () => {
    const seen: string[] = [];
    const record: DealReducer = (_, changes) => {
      seen.push(...changes.map(([path]) => path));
    };
    const state = { ...initialDealFields, ...initialDealSettings, groups: { g: { products: { p: { data: productsOf(1)[0].data } } } } };
    runDealLogic(
      state,
      [
        { path: productPath("g", "p", "optionsCommon.strike"), value: "1" },
        { path: productPath("g", "nope", "optionsCommon.strike"), value: "2" },
        { path: productPath("nope", "p", "optionsCommon.strike"), value: "3" },
        { path: "strike", value: "4" },
      ],
      [record],
    );
    expect(seen).toEqual([productPath("g", "p", "optionsCommon.strike"), "strike"]);
  });
});

describe("the deal column's Expiry Days", () => {
  it("is a broadcast: each product's Expiry Date moves, through the derived write", () => {
    expect(isBroadcastField("expiryDays")).toBe(true);
    const deal = dealOf([...productsOf(1), ...productsOf(1, "AverageProduct").map((p) => ({ ...p, groupId: "a", productId: "a1" }))]);
    const { data } = applied(deal, [{ path: "expiryDays", value: 5 }]);
    for (const next of data) {
      expect(readField(next, "expiryDate")).toBe(dateInDays(5));
      expect(readField(next, "expiryDays")).toBe(5);
    }
  });

  it("goes nowhere when empty, like every broadcast", () => {
    const { routed } = applied(dealOf(), [{ path: "expiryDays", value: NaN }]);
    expect(routed.products.size).toBe(0);
  });
});

describe("a container written by path, through the router", () => {
  it("syncs the synced fields inside it: the deal and every product", () => {
    const deal = dealOf();
    const notional = productPath("g0", "p0", "optionsCommon.base.notional");
    const { routed, data } = applied(deal, [{ path: notional, value: { notionalCcy: "EUR", amount: 5 } }]);
    expect(routed.dealFields).toEqual({ ...initialDealFields, notionalCcy: "EUR", notionalAmount: 5 });
    for (const next of data) expect([readField(next, "notionalCcy"), readField(next, "notionalAmount")]).toEqual(["EUR", 5]);
  });

  it("ignores productType and paths under a leaf", () => {
    const deal = dealOf();
    const { data } = applied(deal, [
      { path: productPath("g0", "p0", "productType"), value: "AverageProduct" },
      { path: `${fieldPath(deal.products[0], "strike")}.length`, value: 3 },
    ]);
    expect(data[0]).toBe(deal.products[0].data);
  });
});

describe("the router's cost (§7.5)", () => {
  const writesPlanned = (routed: ReturnType<typeof routeWrites>) =>
    [...routed.products.values()].reduce((count, { writes }) => count + writes.length, 0);

  it("a synced field pasted across N products plans one write per product, not N", () => {
    const deal = dealOf(productsOf(133));
    const writes = deal.products.map((product, i) => ({ path: fieldPath(product, "notionalAmount"), value: i + 1 }));
    const { routed, data } = applied(deal, writes);
    expect(writesPlanned(routed)).toBe(133);
    // last write wins, everywhere
    expect(routed.dealFields.notionalAmount).toBe(133);
    for (const next of data) expect(readField(next, "notionalAmount")).toBe(133);
  });

  it("the same synced value pasted across N products plans one write per product", () => {
    const deal = dealOf(productsOf(50));
    const routed = routeWrites(deal, deal.products.map((product) => ({ path: fieldPath(product, "notionalCcy"), value: "USD" })));
    expect(writesPlanned(routed)).toBe(50);
  });

  it("a synced value the deal already holds fans out to nobody", () => {
    const routed = routeWrites(dealOf(productsOf(50)), [{ path: "premiumCcy", value: initialDealFields.premiumCcy }]);
    expect(writesPlanned(routed)).toBe(0);
  });

  it("keeps each product's own writes in order around the synced ones", () => {
    const deal = dealOf();
    const [first] = deal.products;
    const fixing = productPath("g0", "p0", "cashSettlement.settlementFixingSource");
    const { data } = applied(deal, [
      { path: fixing, value: "3" }, // not Cash yet: no such field
      { path: fieldPath(first, "notionalAmount"), value: 1 },
      { path: fieldPath(first, "settlementStyle"), value: "Cash" },
      { path: "notionalAmount", value: 2 },
      { path: fixing, value: "4" },
    ]);
    expect([readField(data[0], "settlementFixingSource"), readField(data[0], "notionalAmount")]).toEqual(["4", 2]);
    expect(readField(data[1], "notionalAmount")).toBe(2);
  });
});
