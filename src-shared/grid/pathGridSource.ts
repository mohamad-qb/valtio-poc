import { syncedFieldIds } from "../dealFields.ts";
import { isDealSetting } from "../dealSettings.ts";
import { type ProductFieldId, asyncOptionFields, fields } from "../fields.ts";
import type { PathDeal } from "../pathDeal.ts";
import { type PathWrite, productPath } from "../paths.ts";
import { definitionOfData } from "../products/productWrites.ts";
import { fieldsReadingDeal } from "../validation.ts";
import {
  type CellKey,
  type CellRef,
  DEAL_COLUMN_ID,
  type GridColumn,
  type GridSource,
  SETTINGS_COLUMN_ID,
  createCellNotifier,
  dealCell,
  productCell,
  settingCell,
  settingCells,
} from "./gridSource.ts";

const productCells = (productId: string): CellRef[] =>
  fields.map(({ id }) => ({ columnId: productId, fieldId: id }));

/**
 * The grid over any deal, through its paths only: every cell is a dot path
 * (`notionalCcy`, `hedgeType`, `groups.<id>.products.<id>.data.optionsCommon.strike`),
 * read with `readPath`, written with `writePaths` (a paste: one call with
 * every path). What changed comes from the deal's own `subscribe`.
 */
export const createPathGridSource = (deal: PathDeal): GridSource => {
  /** The dot path a cell reads and writes; `null` for a cell that has none. */
  const pathOf = (columnId: string, key: CellKey): string | null => {
    if (columnId === SETTINGS_COLUMN_ID || columnId === DEAL_COLUMN_ID) return key;
    const product = deal.getProduct(columnId);
    if (!product || isDealSetting(key)) return null;
    const fieldPath = definitionOfData(product.data).fieldPaths[key as ProductFieldId];
    return fieldPath ? productPath(product.groupId, columnId, fieldPath) : null;
  };

  const getColumns = (): GridColumn[] => [
    { id: DEAL_COLUMN_ID, title: "Deal" },
    ...deal.getGroups().flatMap((group) =>
      group.productIds.map((productId) => ({
        id: productId,
        title: deal.getProduct(productId)?.title ?? "",
        group: { id: group.id, title: group.title },
      })),
    ),
  ];

  const getCell: GridSource["getCell"] = (columnId, key) => {
    if (columnId === SETTINGS_COLUMN_ID) {
      return isDealSetting(key) ? settingCell(key, deal.getSettings()) : null;
    }
    if (isDealSetting(key)) return null;
    const options = deal.getOptions();
    if (columnId === DEAL_COLUMN_ID) return dealCell(key, deal.readPath(key), options, deal.spotPriceStream);
    const product = deal.getProduct(columnId);
    if (!product) return null;
    const definition = definitionOfData(product.data);
    return productCell(
      definition,
      (dataPath) => deal.readPath(productPath(product.groupId, columnId, dataPath)),
      key,
      key in definition.fieldPaths && deal.fieldIssues(columnId, key as ProductFieldId).length > 0,
      options,
    );
  };

  /** Every product cell whose validation reads the deal: a deal value changed, so its error may have. */
  const cellsReadingDeal = (): CellRef[] =>
    deal.getGroups().flatMap((group) =>
      group.productIds.flatMap((productId) => {
        const product = deal.getProduct(productId);
        return product
          ? fieldsReadingDeal(definitionOfData(product.data)).map((fieldId) => ({ columnId: productId, fieldId }))
          : [];
      }),
    );

  const subscribeColumns: GridSource["subscribeColumns"] = (onChange) =>
    deal.subscribe((change) => {
      if (change.kind === "groups") onChange();
    });

  return {
    getColumns,
    subscribeColumns,
    getCell,

    subscribeCells(onChange) {
      const { notify, stop: stopNotifier } = createCellNotifier({ getCell, getColumns, subscribeColumns }, onChange);
      const stopDeal = deal.subscribe((change) => {
        switch (change.kind) {
          case "products":
            return notify(change.ids.flatMap(productCells));
          case "dealFields":
            return notify([
              ...syncedFieldIds.map((fieldId) => ({ columnId: DEAL_COLUMN_ID, fieldId })),
              ...cellsReadingDeal(),
            ]);
          case "settings":
            return notify([...settingCells, ...cellsReadingDeal()]);
          case "options":
            return notify(
              getColumns().flatMap(({ id }) => asyncOptionFields.map(({ fieldId }) => ({ columnId: id, fieldId }))),
            );
        }
      });
      return () => {
        stopNotifier();
        stopDeal();
      };
    },

    write(writes) {
      const pathWrites: PathWrite[] = writes.flatMap(({ columnId, fieldId, value }) => {
        const path = pathOf(columnId, fieldId);
        return path ? [{ path, value }] : [];
      });
      if (pathWrites.length) deal.writePaths(pathWrites);
    },

    cloneGroup: (groupId) => deal.cloneGroup(groupId),
    removeGroup: (groupId) => deal.removeGroup(groupId),
    spotPriceStream: deal.spotPriceStream,
  };
};
