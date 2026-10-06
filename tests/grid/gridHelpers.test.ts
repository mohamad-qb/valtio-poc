import { describe, expect, it } from "vitest";
import { settingOptions } from "@shared/dealSettings.ts";
import { fields, navigationOrder } from "@shared/fields.ts";
import { cellText, parseCellText, parseNumberText } from "@shared/grid/cellValues.ts";
import { parseTsv, toTsv } from "@shared/grid/clipboard.ts";
import type { CellView } from "@shared/grid/gridSource.ts";
import { fieldRowsInOrder, nextInOrder } from "@shared/grid/navigation.ts";
import { pasteStatus, pasteWrites } from "@shared/grid/paste.ts";

const row = (id: string) => fields.findIndex((field) => field.id === id);
const cash: CellView = {
  value: "4",
  hasError: false,
  readOnly: false,
  options: { status: "loaded", options: [{ value: "4", label: "Cash D" }, { value: "3", label: "Shared C" }] },
};

describe("tab-separated text", () => {
  it("round-trips cells holding tabs, newlines and quotes, as spreadsheets quote them", () => {
    const rows = [["a", "b\tc"], ['say "hi"', "two\nlines"]];
    expect(toTsv(rows)).toBe('a\t"b\tc"\n"say ""hi"""\t"two\nlines"\n');
    expect(parseTsv(toTsv(rows))).toEqual(rows);
  });

  it("drops the trailing newline spreadsheets add, and Windows line endings", () => {
    expect(parseTsv("1\t2\r\n3\t4\r\n")).toEqual([["1", "2"], ["3", "4"]]);
    expect(parseTsv("1\t2\n3\t4")).toEqual([["1", "2"], ["3", "4"]]); // or none at all
  });

  it("keeps a last row that is one empty cell (a copied column ending in an empty cell)", () => {
    for (const rows of [[["EUR"], [""]], [[""]], [["a"], [""], [""]], [["", ""]]]) {
      expect(parseTsv(toTsv(rows))).toEqual(rows);
    }
  });
});

describe("cell values", () => {
  it("shows a dropdown's label and an empty number as nothing", () => {
    expect(cellText(cash)).toBe("Cash D");
    expect(cellText({ value: NaN, hasError: false, readOnly: false })).toBe("");
  });

  it("reads a number: digits, a fraction, thousands separators in their places, a leading minus", () => {
    const parsed = Object.fromEntries(
      ["42", " 42 ", "-7", "1,000", "1,000.5", "-1,234,567.25", "0.5", ".5", "5.", "", "  "].map((text) => [text, parseNumberText(text)]),
    );
    expect(parsed).toEqual({
      "42": 42, " 42 ": 42, "-7": -7, "1,000": 1000, "1,000.5": 1000.5, "-1,234,567.25": -1234567.25,
      "0.5": 0.5, ".5": 0.5, "5.": 5, "": NaN, "  ": NaN, // empty: cleared
    });
  });

  it("refuses text that isn't a plain number", () => {
    for (const text of ["1,5", "1,00", "1,0000", ",5", "1,,000", "0x10", "0b101", "1e3", "Infinity", "-Infinity", "NaN", "abc", "1 000", "$5", "+5", "--5", "1.2.3", "1".repeat(400)]) {
      expect(parseNumberText(text), text).toBeNull();
    }
  });

  it("parses pasted text by the field's input type", () => {
    expect(parseCellText("notionalAmount", "1,500", null)).toEqual({ value: 1500 });
    expect(parseCellText("notionalAmount", "1,5", null)).toBeNull(); // not 15
    expect(parseCellText("notionalAmount", "0x10", null)).toBeNull(); // not 16
    expect(parseCellText("expiryDays", "1e3", null)).toBeNull();
    expect(parseCellText("notionalAmount", "", null)).toEqual({ value: NaN });
    expect(parseCellText("notionalAmount", "abc", null)).toBeNull();
    expect(parseCellText("expiryDate", "2999-01-01", null)).toEqual({ value: "2999-01-01" });
    expect(parseCellText("expiryDate", "01/01/2999", null)).toBeNull();
    // a dropdown takes a value or a label
    expect(parseCellText("settlementFixingSource", "Shared C", cash)).toEqual({ value: "3" });
    expect(parseCellText("settlementFixingSource", "4", cash)).toEqual({ value: "4" });
    expect(parseCellText("settlementFixingSource", "Nope", cash)).toBeNull();
  });
});

describe("paste", () => {
  // columns: 0 deal, 1 labels (no values), 2 and 3 products
  const dataCells = [0, 2, 3];
  const cellAt = (r: number, cell: number) => ({
    ref: { columnId: `c${cell}`, fieldId: fields[r].id },
    view: fields[r].id === "expiryDays"
      ? { value: NaN, hasError: false, readOnly: true }
      : { value: "", hasError: false, readOnly: false },
  });

  it("pastes a block from the corner, passing over the labels column", () => {
    const { writes, skipped } = pasteWrites({
      data: [["1", "2", "3"]],
      range: { fromRow: row("strike"), fromCell: 0, toRow: row("strike"), toCell: 0 },
      rowCount: fields.length,
      dataCells,
      cellAt,
    });
    expect(writes.map(({ columnId, value }) => [columnId, value])).toEqual([["c0", "1"], ["c2", "2"], ["c3", "3"]]);
    expect(skipped).toBe(0);
  });

  it("fills a selection with a single value and skips read-only cells", () => {
    const { writes, skipped } = pasteWrites({
      data: [["2999-01-01"]],
      range: { fromRow: row("expiryDate"), fromCell: 2, toRow: row("expiryDays"), toCell: 3 },
      rowCount: fields.length,
      dataCells,
      cellAt,
    });
    expect(writes.map(({ columnId, fieldId }) => `${columnId}:${fieldId}`)).toEqual(["c2:expiryDate", "c3:expiryDate"]);
    expect(skipped).toBe(2); // expiry days, twice
  });

  it("counts what falls past the grid's bottom and right edges as skipped", () => {
    const last = fields.length - 1;
    const { writes, skipped } = pasteWrites({
      data: [["1", "2", "3"], ["4", "5", "6"]],
      range: { fromRow: last, fromCell: 2, toRow: last, toCell: 2 },
      rowCount: fields.length,
      dataCells,
      cellAt,
    });
    // the last row takes 2 values (columns 2 and 3); its third and the whole second row fall off
    expect(writes.map(({ columnId, value }) => [columnId, value])).toEqual([["c2", 1], ["c3", 2]]); // Spot Stream: a number
    expect(skipped).toBe(4);
  });

  it("counts positions with no cell (the settings column outside its subgrid) as skipped", () => {
    const subgrid = (r: number, cell: number) =>
      r < 2 ? { ref: { columnId: `c${cell}`, fieldId: "strike" as const }, view: { value: "", hasError: false, readOnly: false } } : null;
    const block = pasteWrites({ data: [["a"], ["b"], ["c"], ["d"]], range: { fromRow: 0, fromCell: 0, toRow: 0, toCell: 0 }, rowCount: fields.length, dataCells, cellAt: subgrid });
    expect([block.writes.length, block.skipped]).toEqual([2, 2]);
    // a single value filling a selection that runs past the subgrid
    const fill = pasteWrites({ data: [["z"]], range: { fromRow: 0, fromCell: 0, toRow: 3, toCell: 0 }, rowCount: fields.length, dataCells, cellAt: subgrid });
    expect([fill.writes.length, fill.skipped]).toEqual([2, 2]);
  });
});

describe("pasting the settings", () => {
  const settings = { isInternal: true, hedgeType: "a" };
  // the settings column: Hedge Type above Internal, as the grid shows them while Internal is Yes
  const settingAt = (r: number) => {
    const id = (["hedgeType", "isInternal"] as const)[r];
    if (!id) return null;
    const options = { status: "loaded" as const, options: settingOptions(id, settings) };
    return { ref: { columnId: "settings", fieldId: id }, view: { value: settings[id], hasError: false, readOnly: false, options } };
  };
  const pasteSettings = (data: string[][]) =>
    pasteWrites({ data, range: { fromRow: 0, fromCell: 0, toRow: 0, toCell: 0 }, rowCount: 2, dataCells: [0], cellAt: (r) => settingAt(r) });

  it("takes a hedge type offered by the Internal value pasted with it", () => {
    const { writes, skipped } = pasteSettings([["e"], ["No"]]); // a copied settings column of an external deal
    expect(writes.map(({ fieldId, value }) => [fieldId, value])).toEqual([["hedgeType", "e"], ["isInternal", "false"]]);
    expect(skipped).toBe(0);
  });

  it("still checks a hedge type against the options it will have", () => {
    expect(pasteSettings([["b"], ["No"]]).writes.map(({ fieldId }) => fieldId)).toEqual(["isInternal"]); // b isn't external
    expect(pasteSettings([["e"]]).writes).toEqual([]); // no Internal pasted: e isn't offered while internal
    expect(pasteSettings([["c"], ["Yes"]]).writes.map(({ value }) => value)).toEqual(["c", "true"]);
  });
});

describe("paste status", () => {
  const view = (readOnly = false) => ({ value: "", hasError: false, readOnly });
  const writes = [
    { columnId: "a", fieldId: "strike", value: "1" },
    { columnId: "b", fieldId: "settlementFixingSource", value: "Shared C" },
    { columnId: "c", fieldId: "strike", value: "2" },
  ] as const;

  it("reports the cells written and skipped", () => {
    expect(pasteStatus([writes[0]], 0, () => view())).toBe("Pasted 1 cell");
    expect(pasteStatus([...writes], 2, () => view())).toBe("Pasted 3 cells, skipped 2");
  });

  it("counts a write that didn't land as skipped: its cell is still missing, or read-only", () => {
    const after = (columnId: string) => (columnId === "b" ? null : view(columnId === "c"));
    expect(pasteStatus([...writes], 1, (ref) => after(ref.columnId))).toBe("Pasted 1 cell, skipped 3");
  });
});

describe("keyboard order", () => {
  it("starts with Notional Amount, Expiry Date, Strike, then display order", () => {
    expect(navigationOrder.slice(0, 4)).toEqual(["notionalAmount", "expiryDate", "strike", "notionalCcy"]);
    expect([...navigationOrder].sort()).toEqual(fields.map(({ id }) => id).sort());
  });

  it("goes through a column in its own order, skipping cells it can't stop at, then on to the next column", () => {
    // column 0: a two-row subgrid (rows 2 and 3), 1: labels (no cells), 2: a field column, by priority
    const rowsOf = (cell: number) => [[2, 3], [], fieldRowsInOrder][cell];
    const next = (r: number, cell: number, step: 1 | -1 = 1) =>
      nextInOrder(r, cell, step, { first: 0, count: 3 }, rowsOf, () => true);
    expect(next(2, 0)).toEqual({ row: 3, cell: 0 });
    expect(next(3, 0)).toEqual({ row: row("notionalAmount"), cell: 2 }); // labels passed over
    expect(next(row("notionalAmount"), 2)).toEqual({ row: row("expiryDate"), cell: 2 });
    expect(next(row("strike"), 2)).toEqual({ row: row("notionalCcy"), cell: 2 });
    expect(next(row(navigationOrder[navigationOrder.length - 1]), 2)).toBeNull(); // past the last cell
    expect(next(row("notionalAmount"), 2, -1)).toEqual({ row: 3, cell: 0 });
    // a cell it can't stop at is passed over
    const skipExpiry = (r: number) => r !== row("expiryDate");
    expect(nextInOrder(row("notionalAmount"), 2, 1, { first: 0, count: 3 }, rowsOf, skipExpiry)).toEqual({ row: row("strike"), cell: 2 });
  });
});
