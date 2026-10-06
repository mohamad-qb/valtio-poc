import { observable } from "mobx";
import type { DealFieldsState } from "@shared/dealFields.ts";
import { dealReader } from "@shared/dealKeys.ts";
import type { DealSettingsState } from "@shared/dealSettings.ts";
import type { ProductFieldId } from "@shared/fields.ts";
import { getValueByPath, resolveParent } from "@shared/lib/path.ts";
import { uuid } from "@shared/lib/uuid.ts";
import {
  type GenericProductDefinition,
  type ProductData,
  type ProductType,
  type ProductUi,
  definitionOf,
  isReadOnly,
} from "@shared/products/productRegistry.ts";
import { fieldIssues } from "@shared/validation.ts";
import { type FieldModel, createFieldModel } from "./fieldModel.ts";

/** A live product: its declared state, plus what observers read. */
export type Product = {
  readonly id: string;
  ui: ProductUi;
  data: ProductData;
  /** One model per field: its value and issues, observed one by one. */
  readonly fields: Record<ProductFieldId, FieldModel>;
  readonly hasValidationErrors: boolean;
};

/**
 * Derived fields become getters, which `observable` turns into computeds:
 * always in step, nothing to subscribe to or dispose. (`toJS` leaves
 * computeds out, so a clone's plain data gets its getters back here.)
 */
const withDerivedFields = (
  definition: GenericProductDefinition,
  data: ProductData,
  product: () => Product,
) => {
  for (const [fieldId, derived] of Object.entries(definition.derived ?? {})) {
    const { parent, key } = resolveParent(data, definition.fieldPaths[fieldId as ProductFieldId]);
    Object.defineProperty(parent, key, {
      get: () => derived.compute(product().data),
      enumerable: true,
      configurable: true,
    });
  }
  return data;
};

/**
 * Product factory: turns a product's declaration (`@shared/products`) into a
 * live MobX product. Nothing here is specific to a product type, and nothing
 * writes: the deal routes every write by path (`writePaths`).
 * `sourceData`: plain data to copy (a clone); otherwise the deal's values.
 */
export const createProduct = (
  productType: ProductType,
  deal: DealFieldsState & DealSettingsState,
  ui: ProductUi,
  sourceData?: ProductData,
): Product => {
  const definition = definitionOf(productType);
  // read through the deal's observables: a rule's computed follows the deal keys it reads
  const readDeal = dealReader(deal, deal);
  const read = (fieldId: ProductFieldId) => getValueByPath(product.data, definition.fieldPaths[fieldId]);

  const fields = Object.fromEntries(
    (Object.keys(definition.fieldPaths) as ProductFieldId[]).map((fieldId) => [
      fieldId,
      createFieldModel({
        read: () => read(fieldId),
        issues: () => fieldIssues(definition, fieldId, product.data, readDeal),
        readOnly: isReadOnly(definition, fieldId),
      }),
    ]),
  ) as Record<ProductFieldId, FieldModel>;

  const product: Product = observable<Product>(
    {
      id: uuid(),
      ui,
      data: withDerivedFields(definition, sourceData ?? definition.createData(deal), () => product),
      fields,
      get hasValidationErrors() {
        return Object.values(fields).some((field) => field.issues.length > 0);
      },
    },
    { id: false, fields: false },
  );
  return product;
};
