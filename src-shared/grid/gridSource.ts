import { isBroadcastField, isSyncedField } from "../dealFields.ts";
import {
  type DealSettingId,
  type DealSettingsState,
  dealSettings,
  isDealSetting,
  settingOptions,
} from "../dealSettings.ts";
import {
  type FieldId,
  type InputType,
  type ProductFieldId,
  type SelectFieldId,
  asyncOptionFields,
  fieldExists,
  fields,
  fieldInputTypes,
  fieldLabels,
  fieldOptions,
  isAsyncOptions,
} from "../fields.ts";
import { type Option, type OptionsState, optionsKey } from "../options/optionsSource.ts";
import { type GenericProductDefinition, isFieldVisible, isReadOnly } from "../products/productRegistry.ts";
import type { SpotPriceStream } from "../spotPriceStream.ts";

/**
 * What the deal grid needs from a deal, whatever the state library. Each app
 * implements it over its own store: how it reads cells, how it reports which
 * cells changed, and above all how it applies a batch of writes (a paste) is
 * where the libraries differ.
 */

/** The deal column: synced and broadcast fields, and the spot price. */
export const DEAL_COLUMN_ID = "deal";

/** The deal settings subgrid's value column (hedge type, internal); its keys are setting ids. */
export const SETTINGS_COLUMN_ID = "settings";

/** What a cell holds: a field, or in the settings column, a deal setting. */
export type CellKey = FieldId | DealSettingId;

export const inputTypeOf = (key: CellKey): InputType =>
  isDealSetting(key) ? "select" : fieldInputTypes[key];

export const labelOf = (key: CellKey) =>
  isDealSetting(key) ? dealSettings.find((setting) => setting.id === key)!.label : fieldLabels[key];

export type GridColumn = {
  /** A product id, or `DEAL_COLUMN_ID`. */
  id: string;
  title: string;
  /** The product's group; the deal column has none. */
  group?: { id: string; title: string };
};

/** A cell as the grid shows it; `null` where the column has no such field. */
export type CellView = {
  value: unknown;
  hasError: boolean;
  readOnly: boolean;
  /** Dropdowns: the options to show (async ones may still be loading). */
  options?: { status: OptionsState["status"]; options: readonly Option[] };
};

export type CellRef = { columnId: string; fieldId: CellKey };
export type CellWrite = CellRef & { value: unknown };

export type GridSource = {
  getColumns(): readonly GridColumn[];
  /** Groups or products added, removed or renamed. */
  subscribeColumns(onChange: () => void): () => void;
  /** A field's cell, or in `SETTINGS_COLUMN_ID`, a deal setting's. */
  getCell(columnId: string, fieldId: CellKey): CellView | null;
  /** The cells whose value, issues or options changed. */
  subscribeCells(onChange: (cells: readonly CellRef[]) => void): () => void;
  /** Applies writes in order, as one batch; a single edit is a batch of one. */
  write(writes: readonly CellWrite[]): void;
  cloneGroup(groupId: string): void;
  removeGroup(groupId: string): void;
  /** Ticks outside the stores: the grid repaints just that cell. */
  spotPriceStream: SpotPriceStream;
};

// the same objects every time, so a cell's options compare by identity
const notLoadedYet: OptionsState = { status: "loading", options: [] };
const fixedOptions = new Map<FieldId, OptionsState>();

/** A dropdown's options for a parameter (the field it depends on), from an app's loaded lists. */
export const cellOptions = (
  fieldId: FieldId,
  param: unknown,
  byKey: Readonly<Record<string, OptionsState>>,
): CellView["options"] => {
  if (fieldInputTypes[fieldId] !== "select") return undefined;
  const options = fieldOptions[fieldId as SelectFieldId];
  if (!isAsyncOptions(options)) {
    if (!fixedOptions.has(fieldId)) fixedOptions.set(fieldId, { status: "loaded", options });
    return fixedOptions.get(fieldId);
  }
  const key = optionsKey(options.source, param ? String(param) : options.defaultParam);
  return byKey[key] ?? notLoadedYet;
};

/**
 * A product's cell, reading the product's data by path through `readData`;
 * `null` for a field it doesn't have, or that is hidden.
 */
export const productCell = (
  definition: GenericProductDefinition,
  readData: (dataPath: string) => unknown,
  fieldId: FieldId,
  hasError: boolean,
  byKey: Readonly<Record<string, OptionsState>>,
): CellView | null => {
  if (!(fieldId in definition.fieldPaths)) return null; // e.g. the deal-only spot stream
  const id = fieldId as ProductFieldId;
  const read = (field: ProductFieldId) => readData(definition.fieldPaths[field]);
  if (!fieldExists(id, read) || !isFieldVisible(definition, id, readData)) return null;
  const asyncField = asyncOptionFields.find((field) => field.fieldId === id);
  return {
    value: read(id),
    hasError,
    readOnly: isReadOnly(definition, id),
    options: cellOptions(id, asyncField && read(asyncField.options.dependsOn), byKey),
  };
};

/**
 * A deal column cell. Synced fields show the deal's value; broadcasts hold
 * nothing (a write goes to every product); the spot price is read-only. Any
 * other field (Expiry Days) has no cell: a write there would go nowhere.
 */
export const dealCell = (
  fieldId: FieldId,
  syncedValue: unknown,
  byKey: Readonly<Record<string, OptionsState>>,
  spotPriceStream: SpotPriceStream,
): CellView | null => {
  if (fieldId === "spotStream") {
    return { value: spotPriceStream.getValue(), hasError: false, readOnly: true };
  }
  const isSynced = isSyncedField(fieldId);
  if (!isSynced && !isBroadcastField(fieldId)) return null;
  return {
    value: isSynced ? syncedValue : undefined,
    hasError: false,
    readOnly: false,
    options: cellOptions(fieldId, undefined, byKey),
  };
};

const settingOptionStates = new Map<string, OptionsState>();

/** A deal setting's cell: a dropdown over its options (cached per list, to compare by identity). */
export const settingCell = (id: DealSettingId, settings: DealSettingsState): CellView => {
  const options = settingOptions(id, settings);
  const listKey = `${id}:${options.map(({ value }) => value).join(",")}`;
  if (!settingOptionStates.has(listKey)) settingOptionStates.set(listKey, { status: "loaded", options });
  return { value: settings[id], hasError: false, readOnly: false, options: settingOptionStates.get(listKey) };
};

/** Every settings cell: they change together (the internal flag decides the hedge types). */
export const settingCells: readonly CellRef[] = dealSettings.map(({ id }) => ({
  columnId: SETTINGS_COLUMN_ID,
  fieldId: id,
}));

/**
 * Collects changed cells and hands them to the grid once per tick, each
 * cell once, and only if what the grid shows of it really changed: value,
 * error, read-only, or options. Adapters report candidates (e.g. every field
 * of a product that changed); this narrows them to actual repaints.
 *
 * What the grid shows is recorded up front, and for a new column as the
 * columns change, when the grid draws it whole. A column that goes away is
 * forgotten (nothing is reported for it), so removed products leave nothing
 * behind. Returns the notifier and its unsubscribe.
 */
export const createCellNotifier = (
  source: Pick<GridSource, "getCell" | "getColumns" | "subscribeColumns">,
  onChange: (cells: readonly CellRef[]) => void,
) => {
  const keyOf = (cell: CellRef) => `${cell.columnId}:${cell.fieldId}`;
  const keysOf = (columnId: string) => (columnId === SETTINGS_COLUMN_ID ? dealSettings : fields);
  const shown = new Map<string, CellView | null>();
  const knownColumns = new Set<string>();
  const pending = new Map<string, CellRef>();

  const recordColumns = () => {
    const columnIds = new Set([SETTINGS_COLUMN_ID, ...source.getColumns().map(({ id }) => id)]);
    for (const columnId of knownColumns) {
      if (columnIds.has(columnId)) continue;
      knownColumns.delete(columnId);
      for (const { id: fieldId } of keysOf(columnId)) shown.delete(keyOf({ columnId, fieldId }));
    }
    for (const columnId of columnIds) {
      if (knownColumns.has(columnId)) continue;
      knownColumns.add(columnId);
      for (const { id: fieldId } of keysOf(columnId)) {
        shown.set(keyOf({ columnId, fieldId }), source.getCell(columnId, fieldId));
      }
    }
  };
  const isSame = (a: CellView | null | undefined, b: CellView | null) =>
    a === b ||
    (a !== null && a !== undefined && b !== null &&
      Object.is(a.value, b.value) &&
      a.hasError === b.hasError &&
      a.readOnly === b.readOnly &&
      a.options === b.options);

  const flush = () => {
    const changed: CellRef[] = [];
    for (const [key, cell] of pending) {
      if (!knownColumns.has(cell.columnId)) continue; // gone, or not drawn yet: drawn whole when it comes
      const view = source.getCell(cell.columnId, cell.fieldId);
      if (isSame(shown.get(key), view)) continue;
      shown.set(key, view);
      changed.push(cell);
    }
    pending.clear();
    if (changed.length) onChange(changed);
  };

  recordColumns();
  const stop = source.subscribeColumns(recordColumns);
  const notify = (cells: readonly CellRef[]) => {
    if (!pending.size) queueMicrotask(flush);
    for (const cell of cells) pending.set(keyOf(cell), cell);
  };
  return { notify, stop };
};
