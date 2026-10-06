import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { dateInDays } from "@shared/lib/date.ts";
import type { PathDeal } from "@shared/pathDeal.ts";
import { type DealAdapter, appNames, createAdapter } from "./support/adapters.ts";
import { installFakeApi, sleep } from "./support/fakeApi.ts";

/**
 * The path contract every app keeps, through its `PathDeal` only: what the
 * app being migrated relies on (`groups.<id>.products.<id>.data.<path>`,
 * and the deal's own fields and settings at the root).
 */
describe.each(appNames)("%s: reading and writing by path", (app) => {
  let adapter: DealAdapter;
  let deal: PathDeal;

  beforeEach(async () => {
    installFakeApi({ Cash: [{ id: 4, name: "C4" }, { id: 3, name: "Shared" }] });
    adapter = await createAdapter(app);
    deal = adapter.deal();
    deal.addGroup("Strategy"); // two vanilla products
    deal.addGroup("Average");
  });
  afterEach(() => {
    adapter.dispose();
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  /** The data path of a product, by group and product position. */
  const path = (group: number, product: number, dataPath: string) => {
    const { id, productIds } = deal.getGroups()[group];
    return `groups.${id}.products.${productIds[product]}.data.${dataPath}`;
  };
  const strike = (group: number, product: number) =>
    path(group, product, group === 1 ? "avroCommon.strike" : "optionsCommon.strike");

  it("reads any path: product data, the deal's synced fields and its settings", () => {
    expect(deal.readPath(path(0, 0, "productType"))).toBe("VanillaProduct");
    expect(deal.readPath(path(1, 0, "avroCommon.base.notional.notionalCcy"))).toBe("1xxxxxx");
    expect(deal.readPath("notionalCcy")).toBe("1xxxxxx");
    expect(deal.readPath("hedgeType")).toBe("a");
    expect(deal.readPath("strike")).toBeUndefined(); // a broadcast holds nothing
    expect(deal.readPath("groups.nope.products.nope.data.x")).toBeUndefined();
  });

  it("writes a batch of paths, each product getting only its own writes", () => {
    deal.writePaths([
      { path: strike(0, 0), value: "1" },
      { path: path(0, 0, "optionsCommon.callPut"), value: "Call" },
      { path: strike(1, 0), value: "2" },
    ]);
    expect([deal.readPath(strike(0, 0)), deal.readPath(strike(0, 1)), deal.readPath(strike(1, 0))]).toEqual(["1", "", "2"]);
    expect(deal.readPath(path(0, 0, "optionsCommon.callPut"))).toBe("Call");
  });

  it("keeps each field's rules: syncs, broadcasts, derived and read-only fields, settings", () => {
    // a product's synced field is the two-way sync
    deal.writePaths([{ path: path(1, 0, "avroCommon.base.notional.amount"), value: 500 }]);
    expect(deal.readPath("notionalAmount")).toBe(500);
    expect(deal.readPath(path(0, 1, "optionsCommon.base.notional.amount"))).toBe(500);
    // a deal broadcast reaches every product, whatever its own path
    deal.writePaths([{ path: "strike", value: "9" }]);
    expect([deal.readPath(strike(0, 0)), deal.readPath(strike(1, 0))]).toEqual(["9", "9"]);
    // derived: computed from the expiry date; writing it moves the date
    deal.writePaths([{ path: path(0, 0, "optionsCommon.base.expiryDate"), value: "2999-01-01" }]);
    expect(deal.readPath(path(0, 0, "optionsCommon.base.expiryDays"))).toBeGreaterThan(0);
    deal.writePaths([{ path: path(0, 0, "optionsCommon.base.expiryDays"), value: 1 }]);
    expect(deal.readPath(path(0, 0, "optionsCommon.base.expiryDays"))).toBe(1);
    expect(deal.readPath(path(0, 0, "optionsCommon.base.expiryDate"))).toBe(dateInDays(1));
    // settings: a hedge type stays one of its options
    deal.writePaths([{ path: "isInternal", value: false }]);
    expect(deal.readPath("hedgeType")).toBe("d");
  });

  it("a path that isn't a declared field is written as is; a path the deal doesn't have is ignored", () => {
    deal.writePaths([
      { path: path(0, 0, "legacy.note"), value: "kept" },
      { path: "groups.nope.products.nope.data.x", value: 1 },
      { path: "no.such.root", value: 1 },
    ]);
    expect(deal.readPath(path(0, 0, "legacy.note"))).toBe("kept");
  });

  it("a fixing source exists only for Cash: written in order after the style, in one batch", async () => {
    const fixing = path(0, 0, "cashSettlement.settlementFixingSource");
    deal.writePaths([{ path: fixing, value: "3" }]); // not Cash: no such field
    expect(deal.readPath(fixing)).toBeUndefined();
    deal.writePaths([
      { path: path(0, 0, "settlementStyle"), value: "Cash" },
      { path: fixing, value: "3" },
    ]);
    expect(deal.readPath(fixing)).toBe("3");
    await sleep(20); // Cash's options reloaded: 3 is one of them, so it stays
    expect(deal.readPath(fixing)).toBe("3");
  });
});
