import { proxy } from "valtio";
import type { DealFieldsState } from "@shared/dealFields.ts";
import {
  type AnyProductStore,
  type ProductData,
  type ProductType,
  type ProductUi,
  definitionOf,
} from "@shared/products/productRegistry.ts";

/**
 * Product factory: a live valtio product from its declaration
 * (`@shared/products`). Writes don't happen here: the deal routes every
 * write by path and applies it as plain proxy assignments (`writePaths`).
 * Nothing to watch either: its issues follow from its data (`issuesOf`,
 * `validation.ts`).
 *
 * `initialData`: a plain deep copy, to clone.
 */
export const createProductStore = (
  dealFields: DealFieldsState,
  productType: ProductType,
  ui: ProductUi,
  initialData?: ProductData,
) =>
  proxy<AnyProductStore>({
    ui,
    data: initialData ?? definitionOf(productType).createData(dealFields),
  } as AnyProductStore);
