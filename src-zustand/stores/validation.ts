import { isCalcReady } from "@shared/calc.ts";
import { dealReader } from "@shared/dealKeys.ts";
import type { ProductData } from "@shared/products/productRegistry.ts";
import { type FieldIssues, createIssuesMemo } from "@shared/validation.ts";
import type { DealState } from "./dealStore.ts";

/**
 * Validation isn't state: a zustand state holds no getters, so issues and
 * readiness are selectors over the deal's data, for components (`useStore`)
 * and for autocalc alike.
 */

const validate = createIssuesMemo();

/**
 * A product's issues, per field (fields without any left out). Data is
 * immutable, so they're cached by the data object and the deal values the
 * rules read: an edit is a new object, and only the edited product is
 * validated again; a deal change re-checks only the fields that read it.
 */
export const issuesOf = (state: DealState, data: ProductData): FieldIssues =>
  validate(data, dealReader(state, state));

export const selectHasValidationErrors = (state: DealState) =>
  state.groupIds.some((groupId) => {
    const group = state.groups[groupId];
    return group.productIds.some(
      (productId) => Object.keys(issuesOf(state, group.products[productId].data)).length > 0,
    );
  });

/** No validation errors and no request pending: ready to calculate. */
export const selectIsReady = (state: DealState, pending: number) =>
  isCalcReady(selectHasValidationErrors(state), pending);
