import { type Instance, type SnapshotIn, getParent, hasParent, types } from "mobx-state-tree";
import type { DealFieldsState } from "@shared/dealFields.ts";
import type { ReadDeal } from "@shared/dealKeys.ts";
import type { DealSettingsState } from "@shared/dealSettings.ts";
import { productUi } from "@shared/groups.ts";
import { uuid } from "@shared/lib/uuid.ts";
import { type ProductData, type ProductType, definitionOf } from "@shared/products/productRegistry.ts";
import { type ProductWrite, definitionOfData, planProductWrites } from "@shared/products/productWrites.ts";
import type { GroupType } from "@shared/groups.ts";
import { type FieldIssues, type RuleScope, productIssues } from "@shared/validation.ts";

/** Where a product's group and deal are, up its tree: product → products → group → groups → deal. */
const GROUP_DEPTH = 2;
const DEAL_DEPTH = 4;

/**
 * A product. Its data is one immutable value (`frozen`): a write replaces it
 * with the shared planner's copy, which copies only the objects along the
 * changed paths, and keeps the same object when nothing changed.
 */
export const Product = types
  .model("Product", {
    id: types.optional(types.identifier, uuid),
    title: types.string,
    data: types.frozen<ProductData>(),
  })
  .views((self) => {
    const readDeal: ReadDeal = (key) =>
      hasParent(self, DEAL_DEPTH) ? getParent<DealFieldsState & DealSettingsState>(self, DEAL_DEPTH)[key] : undefined;
    const scope: RuleScope = {
      readDeal,
      readGroup: () => {
        // a product outside a group is alone in it
        if (!hasParent(self, GROUP_DEPTH)) return { groupType: "VanillaGroup", products: [self.data] };
        const group = getParent<{ groupType: GroupType; products: readonly { data: ProductData }[] }>(self, GROUP_DEPTH);
        return { groupType: group.groupType, products: group.products.map((product) => product.data) };
      },
    };
    return {
      /** Every field's issues; validated again when this product's data, or what a rule reads of its group or deal, changes. */
      get issues(): FieldIssues {
        return productIssues(definitionOfData(self.data), self.data, scope);
      },
      get hasValidationErrors() {
        return Object.keys(this.issues).length > 0;
      },
    };
  })
  .actions((self) => ({
    /** Applies writes by the shared rules (derived fields included). */
    write(writes: readonly ProductWrite[]) {
      self.data = planProductWrites(self.data, writes).data;
    },
  }));

export type Product = Instance<typeof Product>;

/** A new product, the `index`-th of its group, starting from the deal's values. */
export const newProduct = (productType: ProductType, index: number, deal: DealFieldsState): SnapshotIn<typeof Product> => ({
  title: productUi(productType, index).title,
  data: definitionOf(productType).createData(deal),
});
