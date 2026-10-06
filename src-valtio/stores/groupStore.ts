import { proxy } from "valtio";
import { deepClone } from "valtio/utils";
import { type GroupType, groupDefinitions, productUi } from "@shared/groups.ts";
import { uuid } from "@shared/lib/uuid.ts";
import type { AnyProductStore } from "@shared/products/productRegistry.ts";
import type { DealStore } from "./dealStore.ts";
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
  $dealStore: DealStore,
  groupType: GroupType,
  source?: GroupStore,
) => {
  const groupId = uuid();
  const groupStore = proxy<GroupStore>({
    id: groupId,
    ui: { title: "", index: 0 },
    groupType,
    products: {},
    productIds: [],
  });

  const watchers: Array<(group: GroupStore) => () => void> = [];

  groupDefinitions[groupType].productTypes.forEach((productType, index) => {
    const productId = uuid();
    const sourceProduct = source?.products[source.productIds[index]];
    const { productStore, watchValidation } = createProductStore(
      $dealStore,
      productType,
      `groups.${groupId}.products.${productId}`,
      productUi(productType, index),
      sourceProduct && deepClone(sourceProduct.data),
    );
    groupStore.products[productId] = productStore;
    groupStore.productIds.push(productId);
    watchers.push(watchValidation);
  });
  // every product is in: their rules can read the group now
  const disposers = watchers.map((watch) => watch(groupStore));

  return {
    groupStore,
    /** Drops every product's subscriptions; call when the group is removed. */
    dispose: () => disposers.forEach((dispose) => dispose()),
  };
};
