import { computed } from "mobx";
import { Model, idProp, model, modelAction, prop } from "mobx-keystone";
import type { DealFieldsState } from "@shared/dealFields.ts";
import { productUi } from "@shared/groups.ts";
import { deleteValueByPath, setValueByPath } from "@shared/lib/path.ts";
import {
  type ProductData,
  type ProductType,
  definitionOf,
} from "@shared/products/productRegistry.ts";
import {
  type ProductWrite,
  definitionOfData,
  planProductWrites,
  withNumbersRevived,
} from "@shared/products/productWrites.ts";
import { type FieldIssues, productIssues } from "@shared/validation.ts";

/**
 * A product: its data is a plain nested object, as the app being migrated
 * keeps it, and keystone makes every leaf of it observable. Only actions
 * (`@modelAction`) can change it.
 */
@model("dealEditor/Product")
export class Product extends Model({
  id: idProp,
  title: prop<string>(),
  data: prop<ProductData>().withSnapshotProcessor({
    fromSnapshot: (snapshot: ProductData) => withNumbersRevived(snapshot),
  }),
}) {
  /** Every field's issues; validated again only when this product's data changes. */
  @computed get issues(): FieldIssues {
    return productIssues(definitionOfData(this.data), this.data);
  }

  @computed get hasValidationErrors() {
    return Object.keys(this.issues).length > 0;
  }

  /** Applies writes leaf by leaf, by the shared rules (derived fields included); whether anything changed. */
  @modelAction write(writes: readonly ProductWrite[]) {
    const { changes } = planProductWrites(this.data, writes);
    for (const change of changes) {
      if ("remove" in change) deleteValueByPath(this.data, change.path);
      else setValueByPath(this.data, change.path, change.value);
    }
    return changes.length > 0;
  }
}

/** A new product, the `index`-th of its group, starting from the deal's values. */
export const newProduct = (
  productType: ProductType,
  index: number,
  deal: DealFieldsState,
) => {
  return new Product({
    title: productUi(productType, index).title,
    data: definitionOf(productType).createData(deal),
  });
};
