import { isDealSetting, settingOptions, withSetting } from "../dealSettings.ts";
import { existenceDependencies } from "../fields.ts";
import { canBeHidden } from "../products/productRegistry.ts";
import { parseCellText } from "./cellValues.ts";
import type { CellRef, CellView, CellWrite } from "./gridSource.ts";

export type CellRange = { fromRow: number; fromCell: number; toRow: number; toCell: number };

type PasteInput = {
  /** Parsed clipboard rows. */
  data: readonly (readonly string[])[];
  /** The selection (or the active cell) the paste starts at. */
  range: CellRange;
  rowCount: number;
  /** The grid cells that hold values, in order; any other column (the labels) is passed over. */
  dataCells: readonly number[];
  /** The cell at a position; `null` where a column has no cell (the settings column's other rows). */
  cellAt: (row: number, cell: number) => { ref: CellRef; view: CellView | null } | null;
};

/**
 * The writes a paste makes, top-down (field display order, so e.g. a
 * settlement style lands before the fixing source it decides), and how many
 * values it had to skip. One value over a selection fills the selection,
 * like a spreadsheet; anything else is pasted from the selection's corner,
 * one clipboard column per value column.
 *
 * Skipped: every value (or, filling, every selected cell) that isn't
 * written: one that doesn't parse, lands on a read-only cell or a field the
 * column can't have, on a position with no cell (outside the settings
 * subgrid), or past the grid's bottom or right edge.
 *
 * A hedge type pasted together with an Internal value is checked against
 * the hedge types that value offers: the deal applies Internal first
 * (`settingWriteOrder`), so a copied settings column pastes back whole.
 */
export const pasteWrites = ({ data, range, rowCount, dataCells, cellAt }: PasteInput) => {
  const fill = data.length === 1 && data[0].length === 1;
  const height = fill ? range.toRow - range.fromRow + 1 : data.length;
  const width = Math.max(...data.map((row) => row.length));
  const targets = fill
    ? dataCells.filter((cell) => cell >= range.fromCell && cell <= range.toCell)
    : dataCells.filter((cell) => cell >= range.fromCell).slice(0, width);
  // every value with the cell it lands on (`null`: none, or past the grid's edge), top-down
  const placed: { target: ReturnType<PasteInput["cellAt"]>; text: string }[] = [];
  const place = (row: number, cell: number | undefined, text: string) =>
    placed.push({ target: row < rowCount && cell !== undefined ? cellAt(row, cell) : null, text });
  for (let r = 0; r < height; r++) {
    if (fill) {
      for (const cell of targets) place(range.fromRow + r, cell, data[0][0]);
    } else {
      data[r].forEach((text, c) => place(range.fromRow + r, targets[c], text));
    }
  }

  const parse = ({ target, text }: (typeof placed)[number]) => {
    if (!target) return null;
    const { ref, view } = target;
    // a missing cell is only worth writing if an earlier write can create (or show) it
    const canExist =
      view !== null ||
      (!isDealSetting(ref.fieldId) && (existenceDependencies(ref.fieldId).length > 0 || canBeHidden(ref.fieldId)));
    return canExist && !view?.readOnly ? parseCellText(ref.fieldId, text, view) : null;
  };

  // the Internal value this paste sets, if any: it decides the hedge types a pasted hedge type is checked against
  let pastedInternal: boolean | undefined;
  for (const entry of placed) {
    if (entry.target?.ref.fieldId !== "isInternal") continue;
    const parsed = parse(entry);
    if (parsed) pastedInternal = withSetting({ isInternal: true, hedgeType: "" }, "isInternal", parsed.value).isInternal;
  }
  const withPastedSettings = (entry: (typeof placed)[number]): (typeof placed)[number] => {
    const { target } = entry;
    if (pastedInternal === undefined || target?.ref.fieldId !== "hedgeType" || !target.view) return entry;
    const options = settingOptions("hedgeType", { isInternal: pastedInternal, hedgeType: "" });
    return { ...entry, target: { ...target, view: { ...target.view, options: { status: "loaded", options } } } };
  };

  const writes: CellWrite[] = [];
  let skipped = 0;
  for (const entry of placed) {
    const parsed = parse(withPastedSettings(entry));
    if (parsed && entry.target) writes.push({ ...entry.target.ref, value: parsed.value });
    else skipped++;
  }
  return {
    writes,
    skipped,
    pasted: {
      fromRow: range.fromRow,
      fromCell: targets[0] ?? range.fromCell,
      toRow: Math.min(range.fromRow + height, rowCount) - 1,
      toCell: targets[targets.length - 1] ?? range.fromCell,
    },
  };
};

/**
 * The paste report, once its writes are applied: a write that didn't land
 * (its cell still missing, e.g. a fixing source on a product the paste
 * didn't make cash-settled, or read-only) counts as skipped too.
 */
export const pasteStatus = (
  writes: readonly CellWrite[],
  skipped: number,
  cellAfter: (ref: CellRef) => CellView | null,
) => {
  const landed = writes.filter((write) => {
    const view = cellAfter(write);
    return view !== null && !view.readOnly;
  }).length;
  const notLanded = skipped + writes.length - landed;
  return `Pasted ${landed} cell${landed === 1 ? "" : "s"}${notLanded ? `, skipped ${notLanded}` : ""}`;
};
