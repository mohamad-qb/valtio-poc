import { isCalcReady, needsAutocalc } from "@shared/calc.ts";
import { type DealProduct, type RoutedWrites, routeWrites } from "@shared/dealWrites.ts";
import type { PathWrite } from "@shared/paths.ts";
import { type ProductData, definitionOf, productTypeOf } from "@shared/products/productRegistry.ts";
import { type FieldIssues, productIssues } from "@shared/validation.ts";
import type { DealState } from "./state.ts";
import type { RootState } from "./store.ts";

/** Every product of a deal with where it lives, in display order. */
export const productsOf = (deal: DealState): DealProduct[] =>
  deal.groupIds.flatMap((groupId) => {
    const group = deal.groups[groupId];
    return group.productIds.map((productId) => ({ groupId, productId, data: group.products[productId].data }));
  });

const routedByWrites = new WeakMap<readonly PathWrite[], { deal: DealState; routed: RoutedWrites }>();

/**
 * A batch of path writes routed over a deal by the shared rules: what each
 * part of the deal gets. The thunk routes a batch for the options it
 * reloads, the reducer for what it writes; the same batch over the same deal
 * is routed once.
 */
export const routedWrites = (deal: DealState, writes: readonly PathWrite[]): RoutedWrites => {
  const cached = routedByWrites.get(writes);
  if (cached?.deal === deal) return cached.routed;
  const routed = routeWrites({ dealFields: deal.dealFields, settings: deal.settings, products: productsOf(deal) }, writes);
  routedByWrites.set(writes, { deal, routed });
  return routed;
};

const issuesByData = new WeakMap<ProductData, FieldIssues>();

/**
 * A product's issues, per field (fields without any left out). Data is
 * immutable, so each data object is validated once: an edit is a new object,
 * and only the edited product is validated again.
 */
export const issuesOf = (data: ProductData): FieldIssues => {
  let issues = issuesByData.get(data);
  if (!issues) {
    issues = productIssues(definitionOf(productTypeOf(data)), data);
    issuesByData.set(data, issues);
  }
  return issues;
};

export const selectHasValidationErrors = (state: RootState, dealId: string) => {
  const deal = state.deals[dealId];
  return Boolean(deal) && productsOf(deal).some(({ data }) => Object.keys(issuesOf(data)).length > 0);
};

/** No validation errors and no request pending: ready to calculate. */
export const selectIsReady = (state: RootState, dealId: string) =>
  isCalcReady(selectHasValidationErrors(state, dealId), state.options.pending);

/** Autocalc has something to do: switched on, the deal ready, its price missing or outdated. */
export const selectShouldAutocalc = (state: RootState, dealId: string) => {
  const deal = state.deals[dealId];
  return Boolean(deal) && state.devtools.isAutocalcEnabled && needsAutocalc(deal.calc) && selectIsReady(state, dealId);
};
