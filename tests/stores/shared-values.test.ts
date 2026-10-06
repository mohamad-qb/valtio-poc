import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { initialDealFields } from "@shared/dealFields.ts";
import { getValueByPath, setIn } from "@shared/lib/path.ts";
import { definitionOf } from "@shared/products/productRegistry.ts";
import { withNumbersRevived } from "@shared/products/productWrites.ts";
import { type DealAdapter, appNames, createAdapter } from "./support/adapters.ts";
import { installFakeApi, sleep } from "./support/fakeApi.ts";

/**
 * Values written by path that don't match a field's type: every app stores
 * the same thing, because the shared rules decide it (REVIEW §4, P3, F3).
 */
describe.each(appNames)("%s: values written by path", (app) => {
  let deal: DealAdapter;

  beforeEach(async () => {
    installFakeApi();
    deal = await createAdapter(app);
    deal.addGroup("Strategy");
    await sleep(20);
  });
  afterEach(() => {
    deal.dispose();
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  it("a synced field takes its own type: a numeric string is a number, null is empty", () => {
    deal.sync("notionalAmount", "1000");
    expect([deal.dealValue("notionalAmount"), deal.read(0, "notionalAmount"), deal.read(1, "notionalAmount")]).toEqual([1000, 1000, 1000]);
    deal.sync("notionalCcy", 123);
    expect([deal.dealValue("notionalCcy"), deal.read(1, "notionalCcy")]).toEqual(["123", "123"]);
    deal.sync("premiumCcy", null);
    expect([deal.dealValue("premiumCcy"), deal.read(0, "premiumCcy"), deal.read(1, "premiumCcy")]).toEqual(["", "", ""]);
    deal.commit(1, "notionalAmount", undefined); // from a product: the same rule, the same sync
    expect([deal.dealValue("notionalAmount"), deal.read(0, "notionalAmount")]).toEqual([NaN, NaN]);
  });

  it("a null or blank broadcast goes nowhere, like an empty one", () => {
    deal.commit(0, "callPut", "Put");
    const before = [deal.read(0, "callPut"), deal.read(1, "callPut")];
    deal.broadcast("callPut", null);
    deal.broadcast("callPut", "   ");
    expect([deal.read(0, "callPut"), deal.read(1, "callPut")]).toEqual(before);
    expect(before[0]).toBe("Put");
  });
});

describe("withNumbersRevived (product data back from JSON)", () => {
  it("puts NaN back at number fields only, and keeps data without such a null as it is", () => {
    const { fieldPaths, createData } = definitionOf("VanillaProduct");
    const data = createData(initialDealFields);
    expect(withNumbersRevived(data)).toBe(data);
    const fromJson = setIn(setIn(data, fieldPaths.notionalAmount, null), fieldPaths.callPut, null);
    const revived = withNumbersRevived(fromJson);
    expect(getValueByPath(revived, fieldPaths.notionalAmount)).toBeNaN();
    expect(getValueByPath(revived, fieldPaths.callPut)).toBeNull();
  });
});
