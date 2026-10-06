import type { DealFieldsState } from "@shared/dealFields.ts";
import type { ReadDeal } from "@shared/dealKeys.ts";
import { uuid } from "@shared/lib/uuid.ts";
import {
  type AnyProductStore,
  type ProductType,
  type ProductUi,
  definitionOf,
} from "@shared/products/productRegistry.ts";
import { type ProductWrite, planProductWrites } from "@shared/products/productWrites.ts";
import { type FieldIssues, type RuleScope, createIssuesMemo } from "@shared/validation.ts";
import type { GroupsState } from "./groupStore.ts";

/**
 * Products as plain, immutable data, driven by their declarations
 * (`@shared/products`): nothing here is specific to a product type.
 */

/** A product in its group: its declared shape, plus an id. */
export type ProductState = AnyProductStore & { id: string };

/**
 * A new product of `productType`, or a copy of `source` (same type). Called
 * when a group is built; the id is new either way.
 */
export const createProduct = (
  productType: ProductType,
  defaults: DealFieldsState,
  ui: ProductUi,
  source?: ProductState,
) =>
  ({
    id: uuid(),
    ui,
    // plain data, so a clone is a deep copy (NaN and all)
    data: source ? structuredClone(source.data) : definitionOf(productType).createData(defaults),
  }) as ProductState;

/**
 * The product with writes applied, by the shared rules: only the objects
 * along the changed paths are copied, and the same product comes back if
 * nothing changed, so nothing bound to it re-renders.
 */
export const withProductWrites = (product: ProductState, writes: readonly ProductWrite[]): ProductState => {
  const { data } = planProductWrites(product.data, writes);
  return data === product.data ? product : ({ ...product, data } as ProductState);
};

const validate = createIssuesMemo();

/**
 * Issues of every product, by id. Product data is immutable, so results are
 * cached by data identity and what the rules read outside it (the group, the
 * deal): only products that changed are re-validated, and anything else
 * re-checks only the fields that read it.
 */
export const validateProducts = (groups: GroupsState, readDeal: ReadDeal): Record<string, FieldIssues> =>
  Object.fromEntries(
    Object.values(groups).flatMap((group) => {
      const products = Object.values(group.products);
      const scope: RuleScope = {
        readDeal,
        readGroup: () => ({ groupType: group.groupType, products: products.map((product) => product.data) }),
      };
      return products.map((product) => [product.id, validate(product.data, scope)]);
    }),
  );
