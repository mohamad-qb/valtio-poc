import { type Getter, type PrimitiveAtom, atom } from "jotai/vanilla";
import { type GroupType, groupDefinitions, productUi } from "@shared/groups.ts";
import { uuid } from "@shared/lib/uuid.ts";
import { type DealAtoms, type ProductStore, createProductStore } from "./productStore.ts";

export type GroupStore = {
  id: string;
  uiAtom: PrimitiveAtom<{ title: string; index: number }>; // set by the deal on insert
  groupType: GroupType;
  products: Record<string, ProductStore>;
  productIds: string[]; // display order; each product's `ui.index` mirrors it
};

/**
 * Group factory. `source` (a group to clone) seeds each product with the
 * data of the product at the same position. Products are numbered within
 * the group, once, since a group's products never change.
 */
export const createGroupStore = (
  get: Getter,
  deal: DealAtoms,
  groupType: GroupType,
  source?: GroupStore,
): GroupStore => {
  const groupStore: GroupStore = {
    id: uuid(),
    uiAtom: atom({ title: "", index: 0 }),
    groupType,
    products: {},
    productIds: [],
  };

  const dealFields = get(deal.dealFieldsAtom);
  groupDefinitions[groupType].productTypes.forEach((productType, index) => {
    const productId = uuid();
    const sourceProduct = source?.products[source.productIds[index]];
    groupStore.products[productId] = createProductStore(
      deal,
      () => groupStore,
      dealFields,
      productType,
      productUi(productType, index),
      sourceProduct && get(sourceProduct.dataAtom),
    );
    groupStore.productIds.push(productId);
  });

  return groupStore;
};
