import { describe, expect, it } from "vitest";
import { initialDealFields, isBroadcastField, isSyncedField } from "@shared/dealFields.ts";
import { type ProductFieldId, fields } from "@shared/fields.ts";
import { type CellRef, type CellView, type GridColumn, createCellNotifier, dealCell } from "@shared/grid/gridSource.ts";
import { createPathGridSource } from "@shared/grid/pathGridSource.ts";
import type { PathDeal, PathDealGroup } from "@shared/pathDeal.ts";
import { productPath } from "@shared/paths.ts";
import { definitionOf } from "@shared/products/productRegistry.ts";
import { createSpotPriceStream } from "@shared/spotPriceStream.ts";

const flush = () => new Promise<void>((resolve) => queueMicrotask(resolve));

describe("the cell notifier", () => {
  /** A source whose columns and cell values the test sets. */
  const fakeSource = () => {
    let columns: GridColumn[] = [{ id: "deal", title: "Deal" }];
    const values = new Map<string, string>();
    const listeners = new Set<() => void>();
    return {
      setColumns(next: GridColumn[]) {
        columns = next;
        listeners.forEach((listener) => listener());
      },
      setValue: (columnId: string, value: string) => values.set(columnId, value),
      getColumns: () => columns,
      subscribeColumns(listener: () => void) {
        listeners.add(listener);
        return () => listeners.delete(listener);
      },
      getCell: (columnId: string): CellView => ({ value: values.get(columnId) ?? "", hasError: false, readOnly: false }),
    };
  };
  const product = (id: string): GridColumn => ({ id, title: id, group: { id: "g", title: "G" } });

  it("forgets a column that goes away: if it comes back, it is drawn whole, and nothing is reported for it", async () => {
    const source = fakeSource();
    const reported: CellRef[] = [];
    const { notify, stop } = createCellNotifier(source, (cells) => reported.push(...cells));
    source.setValue("p", "A");
    source.setColumns([{ id: "deal", title: "Deal" }, product("p")]);
    source.setColumns([{ id: "deal", title: "Deal" }]); // removed
    source.setValue("p", "B");
    source.setColumns([{ id: "deal", title: "Deal" }, product("p")]); // back, drawn with B
    notify([{ columnId: "p", fieldId: "strike" }]);
    await flush();
    expect(reported).toEqual([]); // the grid already shows B: a stale A would report it
    stop();
  });

  it("reports nothing for a column that is gone, and keeps no record of it", async () => {
    const source = fakeSource();
    const reported: CellRef[] = [];
    const { notify, stop } = createCellNotifier(source, (cells) => reported.push(...cells));
    source.setColumns([{ id: "deal", title: "Deal" }, product("p")]);
    source.setValue("p", "changed");
    source.setColumns([{ id: "deal", title: "Deal" }]);
    notify([{ columnId: "p", fieldId: "strike" }]);
    await flush();
    expect(reported).toEqual([]);
    // a later column of the same id starts fresh: its first change is reported against what it was drawn with
    source.setColumns([{ id: "deal", title: "Deal" }, product("p")]);
    source.setValue("p", "again");
    notify([{ columnId: "p", fieldId: "strike" }]);
    await flush();
    expect(reported).toEqual([{ columnId: "p", fieldId: "strike" }]);
    stop();
  });
});

describe("the deal column", () => {
  const spot = createSpotPriceStream();

  it("has a cell for synced and broadcast fields and the spot price, and none for a field a write there can't reach", () => {
    expect(dealCell("notionalAmount", 5, {}, spot)?.value).toBe(5);
    expect(dealCell("strike", undefined, {}, spot)).toMatchObject({ value: undefined, readOnly: false });
    expect(dealCell("spotStream", undefined, {}, spot)?.readOnly).toBe(true);
    for (const { id } of fields) {
      const writable = isSyncedField(id) || isBroadcastField(id) || id === "spotStream";
      expect(dealCell(id, undefined, {}, spot) !== null, id).toBe(writable);
    }
  });
});

describe("the path grid source", () => {
  /** A deal of one group of two products, counting the lookups the grid makes. */
  const countingDeal = (productTitles?: readonly string[]) => {
    const data = definitionOf("VanillaProduct").createData(initialDealFields);
    const products = new Map([
      ["p1", { groupId: "g1", title: "Vanilla Product #1", data }],
      ["p2", { groupId: "g1", title: "Vanilla Product #2", data: { ...data } }],
    ]);
    const calls = { getProduct: 0, readPath: 0 };
    const group: PathDealGroup & { productTitles?: readonly string[] } = { id: "g1", title: "Vanilla Group #1", productIds: ["p1", "p2"], productTitles };
    const deal: PathDeal = {
      getGroups: () => [group],
      getProduct: (id) => {
        calls.getProduct++;
        return products.get(id);
      },
      readPath: (path) => {
        calls.readPath++;
        const [, groupId, , productId, , ...rest] = path.split(".");
        const product = products.get(productId);
        if (!product || product.groupId !== groupId) return undefined;
        return rest.reduce<unknown>((value, key) => (value as Record<string, unknown> | undefined)?.[key], product.data);
      },
      writePaths: () => {},
      fieldIssues: () => [],
      getSettings: () => ({ isInternal: true, hedgeType: "a" }),
      getOptions: () => ({}),
      subscribe: () => () => {},
      addGroup: () => {},
      cloneGroup: () => {},
      removeGroup: () => {},
      spotPriceStream: createSpotPriceStream(),
    };
    return { deal, calls };
  };

  it("reads a product's cell with one product lookup, straight from its data", () => {
    const { deal, calls } = countingDeal();
    const grid = createPathGridSource(deal);
    for (const { id } of fields) {
      calls.getProduct = 0;
      calls.readPath = 0;
      const view = grid.getCell("p1", id);
      expect(calls, id).toEqual({ getProduct: 1, readPath: 0 });
      // the same as reading its path
      if (view) {
        const path = productPath("g1", "p1", definitionOf("VanillaProduct").fieldPaths[id as ProductFieldId]);
        expect(view.value, id).toEqual(deal.readPath(path));
      }
    }
  });

  it("titles the product columns from the groups when they carry the titles, without looking products up", () => {
    const titled = countingDeal(["First", "Second"]);
    expect(createPathGridSource(titled.deal).getColumns().map(({ title }) => title)).toEqual(["Deal", "First", "Second"]);
    expect(titled.calls.getProduct).toBe(0);

    const plain = countingDeal();
    expect(createPathGridSource(plain.deal).getColumns().map(({ title }) => title)).toEqual(["Deal", "Vanilla Product #1", "Vanilla Product #2"]);
  });
});
