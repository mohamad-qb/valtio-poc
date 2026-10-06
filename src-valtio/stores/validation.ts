import { subscribeKey } from "valtio/utils";
import type { $ZodIssue } from "zod/v4/core";
import { dealReader } from "@shared/dealKeys.ts";
import type { ProductFieldId } from "@shared/fields.ts";
import type {
  GenericProductDefinition,
  ProductData,
} from "@shared/products/productRegistry.ts";
import { fieldIssues, validationInputs } from "@shared/validation.ts";
import type { DealStore } from "./dealStore.ts";
import { subscribePath } from "./subscribe.ts";

/** `validationErrors` key for a field path relative to the deal. */
export const toValidationKey = (path: string) => path.replaceAll(".", "_");

const isSameIssues = (a: readonly $ZodIssue[] | undefined, b: readonly $ZodIssue[]) =>
  (a?.length ?? 0) === b.length &&
  b.every((issue, i) => issue.message === a?.[i].message);

/**
 * Validates one product field into the deal's `validationErrors`: now, and
 * whenever the field — or anything its rules read, in the product or the
 * deal — changes; never on unrelated changes. Returns the unsubscribe.
 */
export const watchFieldValidation = (
  $dealStore: DealStore,
  definition: GenericProductDefinition,
  data: ProductData,
  productPath: string, // the product's path from the deal
  fieldId: ProductFieldId,
) => {
  const key = toValidationKey(`${productPath}.data.${definition.fieldPaths[fieldId]}`);

  const readDeal = dealReader($dealStore, $dealStore);
  const validate = () => {
    const issues = fieldIssues(definition, fieldId, data, readDeal);
    // only write when the issues changed: no new identities, no notifications
    if (isSameIssues($dealStore.validationErrors[key], issues)) return;
    $dealStore.validationErrors[key] = [...issues];
  };

  validate();
  const { dataPaths, dealKeys } = validationInputs(definition, fieldId);
  const unsubscribes = [
    ...dataPaths.map((path) => subscribePath(data, path, validate)),
    // a rule that reads the deal: re-checked when that deal value changes
    ...dealKeys.map((dealKey) => subscribeKey($dealStore, dealKey, validate, true)),
  ];
  return () => unsubscribes.forEach((unsubscribe) => unsubscribe());
};

/** Drops every validation entry under `path` (e.g. a removed group). */
export const clearValidationErrors = ($dealStore: DealStore, path: string) => {
  const prefix = toValidationKey(`${path}.`);
  for (const key of Object.keys($dealStore.validationErrors)) {
    if (key.startsWith(prefix)) delete $dealStore.validationErrors[key];
  }
};
