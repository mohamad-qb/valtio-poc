import { isCalcReady, needsAutocalc } from "@shared/calc.ts";
import type { DealProduct } from "@shared/dealWrites.ts";
import { dealReader } from "@shared/dealKeys.ts";
import type { ProductData } from "@shared/products/productRegistry.ts";
import { type FieldIssues, createIssuesMemo } from "@shared/validation.ts";
import type { DealState } from "./state.ts";
import type { RootState } from "./store.ts";

/** Every product of a deal with where it lives, in display order. */
export const productsOf = (deal: DealState): DealProduct[] =>
  deal.groupIds.flatMap((groupId) => {
    const group = deal.groups[groupId];
    return group.productIds.map((productId) => ({ groupId, productId, data: group.products[productId].data }));
  });

const validate = createIssuesMemo();

/**
 * A product's issues, per field (fields without any left out). Data is
 * immutable, so they're cached by the data object and the deal values the
 * rules read in its group and deal: an edit is a new object, and only the
 * edited product is validated again; anything else re-checks only the
 * fields that read it.
 */
export const issuesOf = (deal: DealState, groupId: string, data: ProductData): FieldIssues =>
  validate(data, {
    readDeal: dealReader(deal.dealFields, deal.settings),
    readGroup: () => {
      const group = deal.groups[groupId];
      return { groupType: group.groupType, products: group.productIds.map((id) => group.products[id].data) };
    },
  });

export const selectHasValidationErrors = (state: RootState, dealId: string) => {
  const deal = state.deals[dealId];
  return Boolean(deal) && productsOf(deal).some(({ groupId, data }) => Object.keys(issuesOf(deal, groupId, data)).length > 0);
};

/** No validation errors and no request pending: ready to calculate. */
export const selectIsReady = (state: RootState, dealId: string) =>
  isCalcReady(selectHasValidationErrors(state, dealId), state.options.pending);

/** Autocalc has something to do: switched on, the deal ready, its price missing or outdated. */
export const selectShouldAutocalc = (state: RootState, dealId: string) => {
  const deal = state.deals[dealId];
  return Boolean(deal) && state.devtools.isAutocalcEnabled && needsAutocalc(deal.calc) && selectIsReady(state, dealId);
};
