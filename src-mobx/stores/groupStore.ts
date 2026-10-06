import { observable, toJS } from "mobx";
import { type GroupType, groupDefinitions, productUi } from "@shared/groups.ts";
import { uuid } from "@shared/lib/uuid.ts";
import type { DealFieldsState } from "@shared/dealFields.ts";
import type { DealSettingsState } from "@shared/dealSettings.ts";
import { type Product, createProduct } from "./productStore.ts";

export type GroupStore = {
  readonly id: string;
  readonly groupType: GroupType;
  ui: { title: string; index: number }; // set by the deal on insert
  products: Record<string, Product>;
  productIds: string[]; // display order; each product's `ui.index` mirrors it
  readonly productList: Product[];
};

/**
 * Group factory. `source` (a group to clone) seeds each product with a copy
 * of the product at the same position. Products are numbered within the
 * group, once, since a group's products never change.
 */
export const createGroupStore = (
  groupType: GroupType,
  deal: DealFieldsState & DealSettingsState,
  source?: GroupStore,
): GroupStore => {
  const products: Record<string, Product> = {};
  const productIds: string[] = [];

  groupDefinitions[groupType].productTypes.forEach((productType, index) => {
    const sourceProduct = source?.products[source.productIds[index]];
    const product = createProduct(
      productType,
      deal,
      productUi(productType, index),
      // plain deep copy: the clone gets its own observables and computeds
      sourceProduct && toJS(sourceProduct.data),
    );
    products[product.id] = product;
    productIds.push(product.id);
  });

  const group: GroupStore = observable<GroupStore>(
    {
      id: uuid(),
      groupType,
      ui: { title: "", index: 0 },
      products,
      productIds,
      get productList() {
        return group.productIds.map((productId) => group.products[productId]);
      },
    },
    { id: false, groupType: false },
  );

  return group;
};
