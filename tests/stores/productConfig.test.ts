import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { z } from "zod";
import { type DealReducer, type DealState, runDealLogic } from "@shared/dealLogic/changes.ts";
import { initialDealFields } from "@shared/dealFields.ts";
import { dealReader } from "@shared/dealKeys.ts";
import { initialDealSettings } from "@shared/dealSettings.ts";
import { type RuleContext, defineProduct } from "@shared/products/productDefinition.ts";
import type { GenericProductDefinition } from "@shared/products/productRegistry.ts";
import { vanillaProduct } from "@shared/products/vanillaProduct.ts";
import { fieldIssues } from "@shared/validation.ts";
import { type DealAdapter, appNames, createAdapter } from "./support/adapters.ts";
import { installFakeApi } from "./support/fakeApi.ts";

/**
 * The original app's ways, kept by every app: products declared as field
 * configs (visibility, validation by path), and the deal logic as piped
 * reducers (`onStoreChanges`).
 */
describe.each(appNames)("%s: field configs and deal logic", (app) => {
  let adapter: DealAdapter;

  beforeEach(async () => {
    installFakeApi();
    adapter = await createAdapter(app);
    adapter.addGroup("Strategy"); // two vanilla products
    adapter.addGroup("Average");
  });
  afterEach(() => {
    adapter.dispose();
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  it("shows and validates a field only while its visibility condition holds", () => {
    const grid = adapter.grid();
    const firstProduct = grid.getColumns()[1].id;
    // Settlement Ccy shows only for Cash; Delivery by default
    expect(grid.getCell(firstProduct, "settlementCcy")).toBeNull();
    adapter.commit(0, "settlementCcy", "TOOLONG1"); // its data is kept, but it isn't validated
    expect(adapter.read(0, "settlementCcy")).toBe("TOOLONG1");
    expect(adapter.issues(0, "settlementCcy")).toEqual([]);

    adapter.commit(0, "settlementStyle", "Cash");
    expect(grid.getCell(firstProduct, "settlementCcy")?.value).toBe("TOOLONG1");
    expect(adapter.issues(0, "settlementCcy")).toEqual(["Must be at most 6 characters"]);

    adapter.commit(0, "settlementStyle", "Delivery"); // hidden again: no issues
    expect(adapter.issues(0, "settlementCcy")).toEqual([]);
  });

  it("runs the deal logic with every write: a ccy pair sets the deal's notional ccy", () => {
    adapter.commit(1, "ccyPair", "EURUSD");
    expect(adapter.dealValue("notionalCcy")).toBe("EUR");
    expect([0, 1, 2].map((i) => adapter.read(i, "notionalCcy"))).toEqual(["EUR", "EUR", "EUR"]);
    adapter.broadcast("ccyPair", "GBPJPY");
    expect(adapter.dealValue("notionalCcy")).toBe("GBP");
    adapter.commit(0, "ccyPair", "nope"); // not a pair: the reducer adds nothing
    expect(adapter.dealValue("notionalCcy")).toBe("GBP");
  });
});

describe("deal logic: reducers, piped", () => {
  const prevState: DealState = { ...initialDealFields, ...initialDealSettings, groups: {} };

  it("gives each reducer the changes so far, and marks what reducers add as not the user's", () => {
    const seen: string[][] = [];
    const record: DealReducer = (_, changes) => {
      seen.push(changes.map(([path, value, meta]) => `${path}=${String(value)}:${meta.isUserChange ? "user" : "logic"}`));
    };
    const writes = runDealLogic(prevState, [{ path: "strike", value: "1" }], [
      record,
      () => [["premiumCcy", "EUR"]], // a single change
      record,
      () => [["callPut", "Call"], ["buySell", "Buy", { isUserChange: true }]], // an array of them
      record,
    ]);
    expect(writes.map(({ path }) => path)).toEqual(["strike", "premiumCcy", "callPut", "buySell"]);
    expect(seen).toEqual([
      ["strike=1:user"],
      ["strike=1:user", "premiumCcy=EUR:logic"],
      ["strike=1:user", "premiumCcy=EUR:logic", "callPut=Call:logic", "buySell=Buy:user"],
    ]);
  });
});

describe("field configs: defineProduct", () => {
  const config = vanillaProduct as unknown as Parameters<typeof defineProduct>[0];
  const vanillaFields = () =>
    // the original configs, rebuilt from the compiled vanilla product
    Object.entries(vanillaProduct.fieldPaths).map(([field, path]) => ({
      props: { path: `groups.$GROUP_ID.products.$PRODUCT_ID.data.${path}` },
      position: { field },
    }));

  it("compiles paths relative to the product's data", () => {
    expect(vanillaProduct.fieldPaths.strike).toBe("optionsCommon.strike");
    expect(vanillaProduct.validation.strike?.path).toBe("optionsCommon.strike");
    expect(vanillaProduct.visibility.settlementCcy).toEqual(["settlementStyle", "Cash"]);
  });

  it("fails on load for a config that can't work", () => {
    const define = (fields: unknown[]) => () => defineProduct({ ...config, label: "Test", fields } as never);
    expect(define(vanillaFields().slice(1))).toThrow("Test: no field for notionalCcy");
    expect(define([...vanillaFields(), vanillaFields()[0]])).toThrow('Test: row "notionalCcy" is listed twice');
    expect(
      define([
        ...vanillaFields().slice(1),
        { props: { path: "optionsCommon.strike" }, position: { field: "notionalCcy" }, validation: { schema: ["x", z.string()] } },
      ]),
    ).toThrow(`"optionsCommon.strike" isn't in a product's data`);
  });

  it("a rule listens to its product's data, its group or the deal, and reads only what it listens to", () => {
    const withRule = (rule: unknown) => () =>
      defineProduct({ ...config, label: "Test", fields: vanillaFields(), rules: { strike: [rule] } } as never) as unknown as GenericProductDefinition;
    expect(withRule({ listen: ["groups.$GROUP_ID.ui.title"], message: "x", isValid: () => true })).toThrow(
      `Test: a rule on strike listens to "groups.$GROUP_ID.ui.title", which is neither in its product's data, its group, nor a deal key`,
    );
    const groupPaths = ["groups.$GROUP_ID.groupType", "groups.$GROUP_ID.products.*.data.optionsCommon.callPut", "isInternal"];
    expect(withRule({ listen: groupPaths, message: "x", isValid: () => true })).not.toThrow();

    // listens to Internal, reads the hedge type: fails the first time it runs, in every app
    const sneaky = withRule({ listen: ["isInternal"], message: "x", isValid: ({ read }: RuleContext) => read("hedgeType") === "a" })();
    const data = sneaky.createData(initialDealFields);
    const scope = { readDeal: dealReader(initialDealFields, initialDealSettings), readGroup: () => ({ groupType: "VanillaGroup" as const, products: [data] }) };
    expect(() => fieldIssues(sneaky, "strike", data, scope)).toThrow(
      'A validation rule read "hedgeType" without listening to it',
    );
  });
});
