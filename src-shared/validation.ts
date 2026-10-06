import type { $ZodIssue } from "zod/v4/core";
import { boolLogicPaths } from "./boolLogic.ts";
import { type ProductFieldId, existenceDependencies, fieldExists } from "./fields.ts";
import { getValueByPath } from "./lib/path.ts";
import { type GenericProductDefinition, type ProductData, isFieldVisible } from "./products/productRegistry.ts";
import { fieldAtPath } from "./products/productWrites.ts";

export type FieldIssues = Partial<Record<ProductFieldId, readonly $ZodIssue[]>>;

export const noIssues: readonly $ZodIssue[] = [];

/**
 * One field's issues: its schema, then its cross-field rules; none for a
 * field the product doesn't have, or that is hidden (its visibility
 * condition doesn't hold). Pure, so each app decides when to run it (a
 * subscription, a computed, a derived store).
 */
export const fieldIssues = (
  definition: GenericProductDefinition,
  fieldId: ProductFieldId,
  data: ProductData,
): readonly $ZodIssue[] => {
  const readPath = (path: string) => getValueByPath(data, path);
  if (
    !fieldExists(fieldId, (id) => readPath(definition.fieldPaths[id])) ||
    !isFieldVisible(definition, fieldId, readPath)
  ) {
    return noIssues;
  }
  const value = readPath(definition.fieldPaths[fieldId]);
  const issues: $ZodIssue[] = [];
  const check = definition.validation[fieldId];
  if (check) {
    const result = check.schema.safeParse(readPath(check.path));
    if (!result.success) issues.push(...result.error.issues);
  }
  for (const rule of definition.rules?.[fieldId] ?? []) {
    if (!holds(rule.isValid, data)) {
      issues.push({ code: "custom", path: [], message: rule.message, input: value });
    }
  }
  return issues.length ? issues : noIssues;
};

/** A rule over data that may be malformed (written by path): one that throws doesn't hold, and never crashes validation. */
const holds = (isValid: (data: ProductData) => boolean, data: ProductData) => {
  try {
    return isValid(data);
  } catch {
    return false;
  }
};

/** Every field's issues for one product (fields without issues are left out). */
export const productIssues = (
  definition: GenericProductDefinition,
  data: ProductData,
): FieldIssues => {
  const issues: FieldIssues = {};
  for (const fieldId of Object.keys(definition.fieldPaths) as ProductFieldId[]) {
    const found = fieldIssues(definition, fieldId, data);
    if (found.length) issues[fieldId] = found;
  }
  return issues;
};

/**
 * The fields a field's validation reads besides itself: its rules'
 * dependencies, the field its existence depends on, the fields its
 * visibility condition reads, and the field its schema checks (when the
 * schema's path is another field's).
 */
export const validationDependencies = (
  definition: GenericProductDefinition,
  fieldId: ProductFieldId,
): readonly ProductFieldId[] => {
  const condition = definition.visibility[fieldId];
  const check = definition.validation[fieldId];
  const fieldsAt = (paths: readonly string[]) =>
    paths.flatMap((path) => fieldAtPath(definition, path) ?? []).filter((id) => id !== fieldId);
  return [
    ...(definition.rules?.[fieldId] ?? []).flatMap((rule) => rule.dependsOn),
    ...existenceDependencies(fieldId),
    ...fieldsAt(condition ? boolLogicPaths(condition) : []),
    ...fieldsAt(check ? [check.path] : []),
  ];
};
