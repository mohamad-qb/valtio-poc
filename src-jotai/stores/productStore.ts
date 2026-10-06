import { type Atom, type PrimitiveAtom, atom } from "jotai/vanilla";
import type { DealFieldsState } from "@shared/dealFields.ts";
import type { ReadDeal } from "@shared/dealKeys.ts";
import { type DealSettingsState, isDealSetting } from "@shared/dealSettings.ts";
import {
  type ProductData,
  type ProductType,
  type ProductUi,
  definitionOf,
} from "@shared/products/productRegistry.ts";
import { type FieldIssues, createIssuesMemo } from "@shared/validation.ts";

/** The deal's atoms a product's validation can read. */
export type DealAtoms = {
  dealFieldsAtom: Atom<DealFieldsState>;
  settingsAtom: Atom<DealSettingsState>;
};

// product data is never changed in place: issues are cached by it, and by the deal values rules read
const validate = createIssuesMemo();

export type ProductStore = {
  ui: ProductUi;
  /** Never changed in place: a write replaces it, copying only the changed path. */
  dataAtom: PrimitiveAtom<ProductData>;
  /** Every field's issues (fields without any left out). */
  issuesAtom: Atom<FieldIssues>;
};

/**
 * Product factory: a product's atoms from its declaration
 * (`@shared/products`). Writes don't happen here: the deal routes every
 * write by path and sets the new data (`writePaths`). Validation is a
 * derived atom: it re-runs when this product's data, or a deal atom its
 * rules read, changes.
 *
 * `initialData`: another product's data, to clone. Shared, not copied:
 * nothing changes it in place.
 */
export const createProductStore = (
  deal: DealAtoms,
  dealFields: DealFieldsState,
  productType: ProductType,
  ui: ProductUi,
  initialData?: ProductData,
): ProductStore => {
  const dataAtom = atom(initialData ?? definitionOf(productType).createData(dealFields));
  return {
    ui,
    dataAtom,
    issuesAtom: atom((get) => {
      // `get` per key read: the atom depends only on the deal atoms its rules read
      const readDeal: ReadDeal = (key) => (isDealSetting(key) ? get(deal.settingsAtom)[key] : get(deal.dealFieldsAtom)[key]);
      return validate(get(dataAtom), readDeal);
    }),
  };
};
