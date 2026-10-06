import { snapshot } from "valtio";
import { type ProductData, definitionOf, productTypeOf } from "@shared/products/productRegistry.ts";
import { type FieldIssues, productIssues } from "@shared/validation.ts";
import type { GroupStore } from "./groupStore.ts";

/**
 * Validation isn't state: a product's issues follow from its data. A valtio
 * snapshot is immutable and stays the same object until the data changes,
 * so issues are cached per snapshot: an edit re-validates only the product
 * it touched, and nothing is subscribed to the nested objects a write may
 * replace.
 */

const issuesBySnapshot = new WeakMap<object, FieldIssues>();

/** A live product's issues, per field (fields without any left out). */
export const issuesOf = (data: ProductData): FieldIssues => {
  const current = snapshot(data) as ProductData;
  let issues = issuesBySnapshot.get(current);
  if (!issues) {
    issues = productIssues(definitionOf(productTypeOf(current)), current);
    issuesBySnapshot.set(current, issues);
  }
  return issues;
};

/** Whether any of the deal's products has issues. */
export const hasValidationErrors = ({ groupIds, groups }: { groupIds: readonly string[]; groups: Record<string, GroupStore> }) =>
  groupIds.some((groupId) => {
    const group = groups[groupId];
    return group.productIds.some((productId) => Object.keys(issuesOf(group.products[productId].data)).length > 0);
  });
