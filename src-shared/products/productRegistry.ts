import { type BoolLogic, evaluateBoolLogic } from "../boolLogic.ts";
import type { DealFieldsState } from "../dealFields.ts";
import type { ProductFieldId } from "../fields.ts";
import { getValueByPath } from "../lib/path.ts";
import { type AverageProductStore, averageProduct } from "./averageProduct.ts";
import type { CompiledRule, DerivedField, FieldValidation, ProductUi } from "./productDefinition.ts";
import { type VanillaProductStore, vanillaProduct } from "./vanillaProduct.ts";

/**
 * Every product type a group can hold. Adding a product type: declare it
 * (`defineProduct`) and list it here; every app builds it generically.
 */
export const productDefinitions = {
  VanillaProduct: vanillaProduct,
  AverageProduct: averageProduct,
};

export type ProductType = keyof typeof productDefinitions;
export type AnyProductStore = VanillaProductStore | AverageProductStore;
export type ProductData = AnyProductStore["data"];
export type { ProductUi };

/**
 * A compiled definition as generic code sees it: string paths, relative to
 * the product's data, and functions over any product's data.
 */
export type GenericProductDefinition = {
  label: string;
  fieldPaths: Record<ProductFieldId, string>;
  validation: Partial<Record<ProductFieldId, FieldValidation>>;
  visibility: Partial<Record<ProductFieldId, BoolLogic>>;
  rules: Partial<Record<ProductFieldId, readonly CompiledRule[]>>;
  derived?: Partial<Record<ProductFieldId, DerivedField<ProductData>>>;
  createData: (deal: DealFieldsState) => ProductData;
};

export const definitionOf = (productType: ProductType) =>
  productDefinitions[productType] as unknown as GenericProductDefinition;

/** Works on any product data (proxy, observable or plain). */
export const productTypeOf = (data: { productType: string }) =>
  data.productType as ProductType;

export const readField = (data: ProductData, fieldId: ProductFieldId) =>
  getValueByPath(data, definitionOf(data.productType).fieldPaths[fieldId]);

/** Derived fields are read-only, unless they say how a write to them is made (`write`). */
export const isReadOnly = (definition: GenericProductDefinition, fieldId: ProductFieldId) => {
  const derived = definition.derived?.[fieldId];
  return Boolean(derived && !derived.write);
};

/**
 * Whether a field shows in the grid, and is validated: its visibility
 * condition, if it has one, holds. `read` reads the product's data by path.
 */
export const isFieldVisible = (
  definition: GenericProductDefinition,
  fieldId: ProductFieldId,
  read: (dataPath: string) => unknown,
) => {
  const condition = definition.visibility[fieldId];
  return !condition || evaluateBoolLogic(condition, read);
};

/** Whether a row can be hidden in some product: a cell that may appear once another write lands. */
export const canBeHidden = (fieldId: string) =>
  Object.values(productDefinitions).some(
    (definition) => fieldId in (definition as unknown as GenericProductDefinition).visibility,
  );

/** The derived fields that depend on a field: recompute them when it changes. */
export const derivedFieldsOf = (
  definition: GenericProductDefinition,
  changed: ProductFieldId,
) =>
  (Object.entries(definition.derived ?? {}) as [ProductFieldId, DerivedField<ProductData>][])
    .filter(([, derived]) => derived.dependsOn.includes(changed));
