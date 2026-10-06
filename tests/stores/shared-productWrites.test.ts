import { describe, expect, it } from "vitest";
import { initialDealFields } from "@shared/dealFields.ts";
import type { ProductFieldId } from "@shared/fields.ts";
import { daysUntil } from "@shared/lib/date.ts";
import { getValueByPath } from "@shared/lib/path.ts";
import { type ProductData, definitionOf, readField } from "@shared/products/productRegistry.ts";
import { planProductWrite, planProductWrites } from "@shared/products/productWrites.ts";
import { fieldIssues, productIssues } from "@shared/validation.ts";

/** Product writes past the declared fields (REVIEW §2.6), write and write back (§4), a failed options load (§2.10). */

const vanilla = () => definitionOf("VanillaProduct").createData(initialDealFields);
const average = () => definitionOf("AverageProduct").createData(initialDealFields);
const read = (data: ProductData, path: string) => getValueByPath(data, path);
const write = (data: ProductData, fieldId: ProductFieldId, value: unknown) => planProductWrite(data, { fieldId, value }).data;
const cash = (data: ProductData) => write(data, "settlementStyle", "Cash");

describe("a write past the declared fields", () => {
  it("under a leaf is ignored", () => {
    const data = vanilla();
    expect(planProductWrite(data, { path: "optionsCommon.strike.length", value: 1 })).toEqual({ data, changes: [] });
    expect(planProductWrite(data, { path: "optionsCommon.strike.length", value: 1 }).data).toBe(data);
    expect(planProductWrite(data, { path: "optionsCommon.base.notional.amount.x", value: 1 }).data).toBe(data);
    // a Cash product's absent Fixing Source is still a declared leaf: nothing is made under it
    const onCash = cash(data);
    expect(planProductWrite(onCash, { path: "cashSettlement.settlementFixingSource.x", value: 1 }).data).toBe(onCash);
  });

  it("to productType is ignored", () => {
    const data = vanilla();
    expect(planProductWrite(data, { path: "productType", value: "AverageProduct" }).data).toBe(data);
    expect(planProductWrite(data, { path: "productType", value: "Nope" }).data).toBe(data);
  });

  it("to a container is written field by field, through each field's rules", () => {
    const data = vanilla();
    const next = planProductWrite(data, {
      path: "optionsCommon.base",
      value: { expiryDate: "2999-01-01", buySell: "Buy", legacy: "kept" },
    }).data;
    expect(read(next, "optionsCommon.base.expiryDate")).toBe("2999-01-01");
    expect(read(next, "optionsCommon.base.expiryDays")).toBe(daysUntil("2999-01-01")); // derived, recomputed
    expect(read(next, "optionsCommon.base.buySell")).toBe("Buy");
    expect(read(next, "optionsCommon.base.legacy")).toBe("kept"); // not a declared field: as is
    expect(read(next, "optionsCommon.base.ccyPair")).toBe(""); // left out: kept
    expect(read(next, "optionsCommon.base.notional")).toBe(read(data, "optionsCommon.base.notional")); // untouched: shared

    const deep = planProductWrite(data, { path: "optionsCommon", value: { base: { notional: { amount: 5 } }, strike: "1" } }).data;
    expect([read(deep, "optionsCommon.base.notional.amount"), read(deep, "optionsCommon.strike")]).toEqual([5, "1"]);
    expect(read(deep, "optionsCommon.base.notional.notionalCcy")).toBe(initialDealFields.notionalCcy);
  });

  it("to a container can't create a Fixing Source on a Delivery product, but writes it on a Cash one", () => {
    const value = { settlementCcy: "EUR", settlementFixingSource: "4" };
    const delivery = planProductWrite(vanilla(), { path: "cashSettlement", value }).data;
    expect(read(delivery, "cashSettlement")).toEqual({ settlementCcy: "EUR" });
    const onCash = planProductWrite(cash(average()), { path: "cashSettlement", value }).data;
    expect(read(onCash, "cashSettlement")).toEqual({ settlementCcy: "EUR", settlementFixingSource: "4" });
  });

  it("of anything but an object to a container is ignored", () => {
    for (const value of [null, undefined, "x", 5, true, ["a"]]) {
      for (const path of ["optionsCommon", "optionsCommon.base", "optionsCommon.base.notional", "cashSettlement"]) {
        const data = vanilla();
        expect(planProductWrite(data, { path, value }).data).toBe(data);
      }
    }
  });

  it("can't make validation throw, even on data whose container is gone", () => {
    const data = planProductWrite(vanilla(), { path: "optionsCommon", value: null }).data;
    expect(() => productIssues(definitionOf("VanillaProduct"), data)).not.toThrow();
    for (const broken of [{ ...vanilla(), optionsCommon: null }, { ...average(), avroCommon: undefined }]) {
      const product = broken as unknown as ProductData;
      expect(() => productIssues(definitionOf(product.productType), product)).not.toThrow();
      expect(() => planProductWrite(product, { fieldId: "expiryDate", value: "2999-01-01" })).not.toThrow();
    }
  });
});

describe("write and write back in one batch", () => {
  it("reports no changes and returns the same data", () => {
    const data = vanilla();
    const writes = [
      [{ fieldId: "strike", value: "5" }, { fieldId: "strike", value: "" }],
      [{ fieldId: "expiryDate", value: "2999-01-01" }, { fieldId: "expiryDate", value: "" }], // with its derived field
      [{ path: "optionsCommon.callPut", value: "Call" }, { path: "optionsCommon.callPut", value: "" }],
      [{ fieldId: "settlementStyle", value: "Cash" }, { fieldId: "settlementStyle", value: "Delivery" }],
      [{ fieldId: "notionalAmount", value: 5 }, { fieldId: "notionalAmount", value: NaN }],
    ] as const;
    for (const batch of writes) {
      const planned = planProductWrites(data, batch);
      expect(planned.data).toBe(data);
      expect(planned.changes).toEqual([]);
    }
  });

  it("still reports what did change, in order", () => {
    const data = vanilla();
    const planned = planProductWrites(data, [
      { fieldId: "strike", value: "5" },
      { fieldId: "buySell", value: "Buy" },
      { fieldId: "strike", value: "" },
    ]);
    expect(planned.data).not.toBe(data);
    expect(read(planned.data, "optionsCommon.base.buySell")).toBe("Buy");
    expect(planned.changes.map(({ path }) => path)).toEqual(["optionsCommon.strike", "optionsCommon.base.buySell", "optionsCommon.strike"]);
  });
});

describe("a Cash product whose options haven't arrived (O8)", () => {
  it("has no Fixing Source issue while it has none: it's missing only while loading (not ready anyway) or after a failed load", () => {
    for (const data of [cash(vanilla()), cash(average())]) {
      const definition = definitionOf(data.productType);
      expect(readField(data, "settlementFixingSource")).toBeUndefined();
      expect(fieldIssues(definition, "settlementFixingSource", data)).toEqual([]);
      // once there, it is checked as before
      const odd = write(data, "settlementFixingSource", 5);
      expect(fieldIssues(definition, "settlementFixingSource", odd)).not.toEqual([]);
    }
  });
});
