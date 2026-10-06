import { syncedFieldIds } from "../dealFields.ts";
import { isDealSetting } from "../dealSettings.ts";
import { type ProductFieldId, asyncOptionFields, fields } from "../fields.ts";
import { getValueByPath } from "../lib/path.ts";
import type { PathDeal, PathDealGroup } from "../pathDeal.ts";
import { type PathWrite, productPath } from "../paths.ts";
import { definitionOfData } from "../products/productWrites.ts";
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
 * A group may carry its products' titles (in `productIds` order): then the
 * columns are listed without looking up each product.
 */
export type TitledPathDealGroup = PathDealGroup & { productTitles?: readonly string[] };

/**
 * The grid over any deal, through its paths only: every cell is a dot path
 * (`notionalCcy`, `hedgeType`, `groups.<id>.products.<id>.data.optionsCommon.strike`),
 * read with `readPath`, written with `writePaths` (a paste: one call with
 * every path). What changed comes from the deal's own `subscribe`.
 *
 * A product cell looks its product up once and reads the product's data
 * directly (the same value `readPath` would give, without resolving the
 * product again for every field the cell depends on).
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
    ...(deal.getGroups() as readonly TitledPathDealGroup[]).flatMap((group) => {
      const groupRef = { id: group.id, title: group.title };
      return group.productIds.map((productId, index) => ({
        id: productId,
        title: group.productTitles?.[index] ?? deal.getProduct(productId)?.title ?? "",
        group: groupRef,
      }));
    }),
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
    const { data } = product;
    const definition = definitionOfData(data);
    return productCell(
      definition,
      (dataPath) => getValueByPath(data, dataPath),
      key,
      key in definition.fieldPaths && deal.fieldIssues(columnId, key as ProductFieldId).length > 0,
      options,
    );
  };

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
            return notify(syncedFieldIds.map((fieldId) => ({ columnId: DEAL_COLUMN_ID, fieldId })));
          case "settings":
            return notify(settingCells);
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
