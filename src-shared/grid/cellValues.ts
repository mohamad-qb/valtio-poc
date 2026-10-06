import { type CellKey, type CellView, inputTypeOf } from "./gridSource.ts";

/** A cell's text, as shown and copied: a dropdown shows its option's label. */
export const cellText = (view: CellView | null): string => {
  const value = view?.value;
  if (value === undefined || value === null) return "";
  if (typeof value === "number") return Number.isNaN(value) ? "" : String(value);
  const option = view?.options?.options.find((candidate) => candidate.value === String(value));
  return option?.label ?? String(value);
};

/**
 * A plain number: digits with an optional fraction, an optional leading
 * minus, and optionally thousands separators in their places (`1,000`,
 * `-1,000.5`). Not `1,5`, `0x10`, `1e3` or `Infinity`.
 */
const numberPattern = /^-?(?:(?:\d{1,3}(?:,\d{3})+|\d+)(?:\.\d*)?|\.\d+)$/;

/**
 * Typed or pasted text as a number cell's value: `NaN` when empty (the
 * store's "cleared"), `null` when the text isn't a number. The editor and
 * paste both read numbers through this.
 */
export const parseNumberText = (text: string): number | null => {
  const trimmed = text.trim();
  if (trimmed === "") return NaN;
  if (!numberPattern.test(trimmed)) return null;
  const value = Number(trimmed.replaceAll(",", ""));
  return Number.isFinite(value) ? value : null;
};

/** A number cell's value: `NaN` when empty, as the store expects, and for text that isn't a number. */
export const parseNumber = (text: string) => parseNumberText(text) ?? NaN;

/**
 * Pasted text as a cell's value, or `null` when it doesn't fit the cell.
 * Dropdowns take an option's value or its label. A cell without known
 * options (absent until another pasted value creates it, e.g. a fixing
 * source after a Cash style) takes the text: the store reconciles it.
 */
export const parseCellText = (
  key: CellKey,
  text: string,
  view: CellView | null,
): { value: unknown } | null => {
  const trimmed = text.trim();
  switch (inputTypeOf(key)) {
    case "number": {
      const value = parseNumberText(trimmed);
      return value === null ? null : { value };
    }
    case "date":
      return trimmed === "" || /^\d{4}-\d{2}-\d{2}$/.test(trimmed) ? { value: trimmed } : null;
    case "select": {
      if (trimmed === "") return null;
      if (!view?.options) return { value: trimmed };
      const match = view.options.options.find(
        (option) => option.value === trimmed || option.label === trimmed,
      );
      return match ? { value: match.value } : null;
    }
    default:
      return { value: text };
  }
};
