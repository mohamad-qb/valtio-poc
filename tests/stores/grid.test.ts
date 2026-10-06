import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { CellWrite, GridSource } from "@shared/grid/gridSource.ts";
import { type DealAdapter, appNames, createAdapter } from "./support/adapters.ts";
import { installFakeApi, sleep } from "./support/fakeApi.ts";

/**
 * Each app's grid source: what the grid reads, which cells it is told to
 * repaint, and how a batch of writes (a paste) lands in the store.
 */
describe.each(appNames)("%s grid source", (app) => {
  let deal: DealAdapter;
  let grid: GridSource;

  beforeEach(async () => {
    installFakeApi({ Cash: [{ id: 4, name: "C4" }, { id: 3, name: "Shared" }] });
    deal = await createAdapter(app);
    deal.addGroup("Strategy"); // two products
    grid = deal.grid();
    await sleep(20); // the deal's fixing sources loaded
  });
  afterEach(() => {
    deal.dispose();
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  const productIds = () => grid.getColumns().slice(1).map(({ id }) => id);
  /** Every cell reported changed, as `column:field`, in a sorted list. */
  const watch = () => {
    const seen: string[] = [];
    const stop = grid.subscribeCells((cells) => seen.push(...cells.map((c) => `${c.columnId}:${c.fieldId}`)));
    return { seen: () => [...seen].sort(), stop };
  };

  it("lists the deal, then every product under its group", () => {
    const columns = grid.getColumns();
    expect(columns.map(({ title }) => title)).toEqual(["Deal", "Vanilla Product #1", "Vanilla Product #2"]);
    expect(columns[1].group?.title).toBe("Strategy #1");
    expect(columns[2].group?.id).toBe(columns[1].group?.id);
  });

  it("reads cells: the deal's synced values, empty broadcasts, missing and read-only fields", () => {
    const [first] = productIds();
    expect(grid.getCell("deal", "notionalCcy")?.value).toBe("1xxxxxx");
    expect(grid.getCell("deal", "strike")?.value).toBeUndefined();
    expect(grid.getCell("deal", "spotStream")?.readOnly).toBe(true);
    expect(grid.getCell(first, "spotStream")).toBeNull(); // deal-only
    expect(grid.getCell(first, "settlementFixingSource")).toBeNull(); // not Cash
    expect(grid.getCell(first, "expiryDays")?.readOnly).toBe(false); // derived, but writing it moves the expiry date
    expect(grid.getCell(first, "notionalCcy")?.hasError).toBe(true); // 7 characters
    expect(grid.getCell(first, "settlementStyle")?.options?.options.map(({ value }) => value)).toEqual(["Cash", "Delivery"]);
  });

  it("a paste is one batch: each changed cell is reported once, and nothing else", async () => {
    const [first, second] = productIds();
    const { seen, stop } = watch();
    grid.write([
      { columnId: first, fieldId: "strike", value: "1" },
      { columnId: second, fieldId: "strike", value: "2" },
      { columnId: first, fieldId: "callPut", value: "Call" },
      { columnId: second, fieldId: "callPut", value: "Nope" }, // invalid: one report, value and error together
    ]);
    await sleep(5);
    expect(seen()).toEqual([`${first}:callPut`, `${first}:strike`, `${second}:callPut`, `${second}:strike`].sort());
    expect(grid.getCell(second, "callPut")).toMatchObject({ value: "Nope", hasError: true });
    stop();
  });

  it("a synced write reaches the deal and every product, reported once each", async () => {
    const [first, second] = productIds();
    const { seen, stop } = watch();
    grid.write([{ columnId: first, fieldId: "notionalAmount", value: 1000 }]);
    await sleep(5);
    expect([grid.getCell("deal", "notionalAmount")?.value, grid.getCell(second, "notionalAmount")?.value]).toEqual([1000, 1000]);
    expect(seen()).toEqual(["deal:notionalAmount", `${first}:notionalAmount`, `${second}:notionalAmount`].sort());
    stop();
  });

  it("broadcasts from the deal column; missing cells are never written", async () => {
    const [first, second] = productIds();
    const writes: CellWrite[] = [
      { columnId: "deal", fieldId: "strike", value: "9" },
      { columnId: first, fieldId: "settlementFixingSource", value: "4" }, // not Cash: no such field
    ];
    grid.write(writes);
    expect([grid.getCell(first, "strike")?.value, grid.getCell(second, "strike")?.value]).toEqual(["9", "9"]);
    expect(grid.getCell("deal", "strike")?.value).toBeUndefined();
    expect(grid.getCell(first, "settlementFixingSource")).toBeNull();
  });

  it("the deal settings: hedge type options follow Internal, and a hedge type stays one of them", async () => {
    const setting = (id: "hedgeType" | "isInternal") => grid.getCell("settings", id);
    const options = () => setting("hedgeType")?.options?.options.map(({ value }) => value);
    expect([setting("hedgeType")?.value, setting("isInternal")?.value]).toEqual(["a", true]);
    expect(options()).toEqual(["a", "b", "c"]);
    expect(grid.getCell("settings", "strike")).toBeNull(); // the subgrid has only its settings
    expect(grid.getCell("deal", "hedgeType")).toBeNull();

    const { seen, stop } = watch();
    grid.write([{ columnId: "settings", fieldId: "isInternal", value: "false" }]); // as the dropdown sends it
    expect([setting("hedgeType")?.value, setting("isInternal")?.value]).toEqual(["d", false]);
    expect(options()).toEqual(["d", "e", "f"]);
    await sleep(5);
    expect(seen()).toEqual(["settings:hedgeType", "settings:isInternal"]);
    stop();

    grid.write([{ columnId: "settings", fieldId: "hedgeType", value: "a" }]); // not offered: ignored
    expect(setting("hedgeType")?.value).toBe("d");
    grid.write([{ columnId: "settings", fieldId: "hedgeType", value: "f" }]);
    expect(setting("hedgeType")?.value).toBe("f");
  });

  it("a style and the fixing source it creates land in one paste, in order", async () => {
    const [first] = productIds();
    grid.write([
      { columnId: first, fieldId: "settlementStyle", value: "Cash" },
      { columnId: first, fieldId: "settlementFixingSource", value: "3" },
    ]);
    expect(grid.getCell(first, "settlementFixingSource")?.value).toBe("3");
    await sleep(30); // Cash's options reloaded: 3 is one of them, so it stays
    expect(grid.getCell(first, "settlementFixingSource")?.value).toBe("3");
  });

  it("a deal setting a rule reads repaints the cells it validates, and only those", async () => {
    const [first] = productIds();
    grid.write([{ columnId: first, fieldId: "strike", value: "12345" }]);
    await sleep(5);
    expect(grid.getCell(first, "strike")?.hasError).toBe(true); // internal: 3 characters at most
    const { seen, stop } = watch();
    grid.write([{ columnId: "settings", fieldId: "isInternal", value: "false" }]);
    await sleep(5);
    expect(grid.getCell(first, "strike")?.hasError).toBe(false); // external: 6
    expect(seen()).toEqual([`${first}:strike`, "settings:hedgeType", "settings:isInternal"].sort());
    stop();
  });
});
