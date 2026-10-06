import { computed } from "mobx";
import { Model, createContext, idProp, model, modelAction, prop } from "mobx-keystone";
import type { DealFieldsState } from "@shared/dealFields.ts";
import type { DealSettingsState } from "@shared/dealSettings.ts";
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
} from "@shared/products/productWrites.ts";
import { type FieldIssues, productIssues } from "@shared/validation.ts";

/** The deal a product is in, provided by the deal to everything under it: rules read the deal through it. */
export const dealContext = createContext<DealFieldsState & DealSettingsState>();

/**
 * A product: its data is a plain nested object, as the app being migrated
 * keeps it, and keystone makes every leaf of it observable. Only actions
 * (`@modelAction`) can change it.
 */
@model("dealEditor/Product")
export class Product extends Model({
  id: idProp,
  title: prop<string>(),
  data: prop<ProductData>(),
}) {
  /** Every field's issues; validated again when this product's data, or a deal value a rule reads, changes. */
  @computed get issues(): FieldIssues {
    const deal = dealContext.get(this);
    return productIssues(definitionOfData(this.data), this.data, (key) => deal?.[key]);
  }

  @computed get hasValidationErrors() {
    return Object.keys(this.issues).length > 0;
  }

  /** Applies writes leaf by leaf, by the shared rules (derived fields included). */
  @modelAction write(writes: readonly ProductWrite[]) {
    for (const change of planProductWrites(this.data, writes).changes) {
      if ("remove" in change) deleteValueByPath(this.data, change.path);
      else setValueByPath(this.data, change.path, change.value);
    }
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
