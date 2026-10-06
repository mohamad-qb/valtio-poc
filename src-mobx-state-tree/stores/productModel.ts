import { type Instance, type SnapshotIn, types } from "mobx-state-tree";
import type { DealFieldsState } from "@shared/dealFields.ts";
import { productUi } from "@shared/groups.ts";
import { uuid } from "@shared/lib/uuid.ts";
import { type ProductData, type ProductType, definitionOf } from "@shared/products/productRegistry.ts";
import { type ProductWrite, definitionOfData, planProductWrites, withNumbersRevived } from "@shared/products/productWrites.ts";
import { type FieldIssues, productIssues } from "@shared/validation.ts";

/**
 * A product. Its data is one immutable value (`frozen`): a write replaces it
 * with the shared planner's copy, which copies only the objects along the
 * changed paths, and keeps the same object when nothing changed.
 */
export const Product = types
  .model("Product", {
    id: types.optional(types.identifier, uuid),
    title: types.string,
    data: types.snapshotProcessor(types.frozen<ProductData>(), {
      preProcessor: (snapshot: ProductData) => withNumbersRevived(snapshot),
    }),
  })
  .views((self) => ({
    /** Every field's issues; validated again only when this product's data changes. */
    get issues(): FieldIssues {
      return productIssues(definitionOfData(self.data), self.data);
    },
    get hasValidationErrors() {
      return Object.keys(this.issues).length > 0;
    },
  }))
  .actions((self) => ({
    /** Applies writes by the shared rules (derived fields included); whether anything changed. */
    write(writes: readonly ProductWrite[]) {
      const { data } = planProductWrites(self.data, writes);
      if (data === self.data) return false;
      self.data = data;
      return true;
    },
  }));

export type Product = Instance<typeof Product>;

/** A new product, the `index`-th of its group, starting from the deal's values. */
export const newProduct = (productType: ProductType, index: number, deal: DealFieldsState): SnapshotIn<typeof Product> => ({
  title: productUi(productType, index).title,
  data: definitionOf(productType).createData(deal),
});
