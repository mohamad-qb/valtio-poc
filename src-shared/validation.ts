import type { $ZodIssue } from "zod/v4/core";
import { boolLogicPaths } from "./boolLogic.ts";
import type { DealKey, ReadDeal } from "./dealKeys.ts";
import { type ProductFieldId, existenceDependencies, fieldExists } from "./fields.ts";
import { getValueByPath } from "./lib/path.ts";
import type { CompiledRule, RuleContext } from "./products/productDefinition.ts";
import { type GenericProductDefinition, type ProductData, isFieldVisible } from "./products/productRegistry.ts";
import { definitionOfData } from "./products/productWrites.ts";

export type FieldIssues = Partial<Record<ProductFieldId, readonly $ZodIssue[]>>;

export const noIssues: readonly $ZodIssue[] = [];

/** A rule's view of a product and its deal: only the paths it listens to. */
const ruleContext = (rule: CompiledRule, data: ProductData, readDeal: ReadDeal): RuleContext => ({
  read: (path) => {
    const input = rule.inputs.find((candidate) => candidate.path === path);
    if (!input) {
      throw new Error(`A validation rule read "${path}" without listening to it: add it to the rule's \`listen\``);
    }
    return "dealKey" in input ? readDeal(input.dealKey) : getValueByPath(data, input.dataPath);
  },
});

/**
 * One field's issues: its schema, then its rules (which can read the deal,
 * through `readDeal`); none for a field the product doesn't have, or that is
 * hidden (its visibility condition doesn't hold). Pure, so each app decides
 * when to run it (a subscription, a computed, a derived store).
 */
export const fieldIssues = (
  definition: GenericProductDefinition,
  fieldId: ProductFieldId,
  data: ProductData,
  readDeal: ReadDeal,
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
  for (const rule of definition.rules[fieldId] ?? []) {
    const context = ruleContext(rule, data, readDeal);
    if (!rule.isValid(context)) {
      const message = typeof rule.message === "string" ? rule.message : rule.message(context);
      issues.push({ code: "custom", path: [], message, input: value });
    }
  }
  return issues.length ? issues : noIssues;
};

/** Every field's issues for one product (fields without issues are left out). */
export const productIssues = (
  definition: GenericProductDefinition,
  data: ProductData,
  readDeal: ReadDeal,
): FieldIssues => {
  const issues: FieldIssues = {};
  for (const fieldId of Object.keys(definition.fieldPaths) as ProductFieldId[]) {
    const found = fieldIssues(definition, fieldId, data, readDeal);
    if (found.length) issues[fieldId] = found;
  }
  return issues;
};

/** What a field's validation reads: paths in the product's data, and deal keys. */
export type ValidationInputs = { dataPaths: readonly string[]; dealKeys: readonly DealKey[] };

const inputsByDefinition = new Map<GenericProductDefinition, Map<ProductFieldId, ValidationInputs>>();

/**
 * Everything a field's validation reads, so a store knows when to re-check
 * it: the field itself, the field its existence depends on, the paths its
 * visibility condition and schema read, and every path and deal key its
 * rules listen to.
 */
export const validationInputs = (definition: GenericProductDefinition, fieldId: ProductFieldId): ValidationInputs => {
  if (!inputsByDefinition.has(definition)) inputsByDefinition.set(definition, new Map());
  const byField = inputsByDefinition.get(definition)!;
  const cached = byField.get(fieldId);
  if (cached) return cached;
  const condition = definition.visibility[fieldId];
  const check = definition.validation[fieldId];
  const ruleInputs = (definition.rules[fieldId] ?? []).flatMap((rule) => rule.inputs);
  const inputs: ValidationInputs = {
    dataPaths: [
      ...new Set([
        definition.fieldPaths[fieldId],
        ...existenceDependencies(fieldId).map((id) => definition.fieldPaths[id]),
        ...(condition ? boolLogicPaths(condition) : []),
        ...(check ? [check.path] : []),
        ...ruleInputs.flatMap((input) => ("dataPath" in input ? [input.dataPath] : [])),
      ]),
    ],
    dealKeys: [...new Set(ruleInputs.flatMap((input) => ("dealKey" in input ? [input.dealKey] : [])))],
  };
  byField.set(fieldId, inputs);
  return inputs;
};

/** The fields whose validation reads the deal: a deal change re-checks (and repaints) only these. */
export const fieldsReadingDeal = (definition: GenericProductDefinition): ProductFieldId[] =>
  (Object.keys(definition.fieldPaths) as ProductFieldId[]).filter(
    (fieldId) => validationInputs(definition, fieldId).dealKeys.length > 0,
  );

/** Every deal key a product type's validation reads. */
const dealKeysOf = (definition: GenericProductDefinition): DealKey[] => [
  ...new Set(fieldsReadingDeal(definition).flatMap((fieldId) => validationInputs(definition, fieldId).dealKeys)),
];

/**
 * Validation for stores whose product data is immutable (a new object is a
 * new version): a product's issues are cached by its data object and the
 * deal values its rules read. A deal change re-checks only the fields that
 * read the keys that changed; when nothing a product reads changed, the same
 * issues object comes back. Each store creates its own.
 */
export const createIssuesMemo = () => {
  const cache = new WeakMap<ProductData, { dealValues: readonly unknown[]; issues: FieldIssues }>();
  return (data: ProductData, readDeal: ReadDeal): FieldIssues => {
    const definition = definitionOfData(data);
    const keys = dealKeysOf(definition);
    const dealValues = keys.map(readDeal);
    const cached = cache.get(data);
    if (cached && dealValues.every((value, i) => Object.is(value, cached.dealValues[i]))) return cached.issues;
    let issues: FieldIssues;
    if (cached) {
      const changed = keys.filter((_, i) => !Object.is(dealValues[i], cached.dealValues[i]));
      issues = { ...cached.issues };
      for (const fieldId of fieldsReadingDeal(definition)) {
        if (!validationInputs(definition, fieldId).dealKeys.some((key) => changed.includes(key))) continue;
        const found = fieldIssues(definition, fieldId, data, readDeal);
        if (found.length) issues[fieldId] = found;
        else delete issues[fieldId];
      }
    } else {
      issues = productIssues(definition, data, readDeal);
    }
    cache.set(data, { dealValues, issues });
    return issues;
  };
};
