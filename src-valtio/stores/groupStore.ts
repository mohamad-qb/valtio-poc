import { proxy } from "valtio";
import { deepClone } from "valtio/utils";
import type { DealFieldsState } from "@shared/dealFields.ts";
import { type GroupType, groupDefinitions, productUi } from "@shared/groups.ts";
import { uuid } from "@shared/lib/uuid.ts";
import type { AnyProductStore } from "@shared/products/productRegistry.ts";
import { createProductStore } from "./productStore.ts";

export type GroupStore = {
  id: string;
  ui: { title: string; index: number }; // set by the deal on insert
  groupType: GroupType;
  products: Record<string, AnyProductStore>;
  productIds: string[]; // display order; each product's `ui.index` mirrors it
};

/**
 * Group factory. `source` (a group to clone) seeds each product with a plain
 * copy of the product at the same position. Products are numbered within
 * the group, once, since a group's products never change.
 */
export const createGroupStore = (
  dealFields: DealFieldsState,
  groupType: GroupType,
  source?: GroupStore,
): GroupStore => {
  const groupStore = proxy<GroupStore>({
    id: uuid(),
    ui: { title: "", index: 0 },
    groupType,
    products: {},
    productIds: [],
  });

  groupDefinitions[groupType].productTypes.forEach((productType, index) => {
    const productId = uuid();
    const sourceProduct = source?.products[source.productIds[index]];
    groupStore.products[productId] = createProductStore(
      dealFields,
      productType,
      productUi(productType, index),
      sourceProduct && deepClone(sourceProduct.data),
    );
    groupStore.productIds.push(productId);
  });

  return groupStore;
};
