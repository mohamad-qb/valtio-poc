import type { $ZodIssue } from "zod/v4/core";
import { boolLogicPaths } from "./boolLogic.ts";
import type { DealKey, ReadDeal } from "./dealKeys.ts";
import { type ProductFieldId, existenceDependencies, fieldExists } from "./fields.ts";
import type { GroupType } from "./groups.ts";
import { getValueByPath } from "./lib/path.ts";
import type { CompiledRule, RuleContext } from "./products/productDefinition.ts";
import { type GenericProductDefinition, type ProductData, isFieldVisible } from "./products/productRegistry.ts";
import { definitionOfData } from "./products/productWrites.ts";

export type FieldIssues = Partial<Record<ProductFieldId, readonly $ZodIssue[]>>;

export const noIssues: readonly $ZodIssue[] = [];

/** A product's group as its rules see it: its type, and every product's data in display order (its own included). */
export type GroupScope = { groupType: GroupType; products: readonly ProductData[] };

/**
 * What a product's rules can read beyond its own data: its deal and its
 * group. Each is read only when a rule reads it, so stores that track reads
 * (MobX, Legend-State, Jotai) follow exactly those.
 */
export type RuleScope = { readDeal: ReadDeal; readGroup: () => GroupScope };

/** A rule's view of a product, its group and its deal: only the paths it listens to. */
const ruleContext = (rule: CompiledRule, data: ProductData, scope: RuleScope): RuleContext => ({
  read: (path) => {
    const input = rule.inputs.find((candidate) => candidate.path === path);
    if (!input) {
      throw new Error(`A validation rule read "${path}" without listening to it: add it to the rule's \`listen\``);
    }
    if ("dataPath" in input) return getValueByPath(data, input.dataPath);
    if ("dealKey" in input) return scope.readDeal(input.dealKey);
    const group = scope.readGroup();
    if ("groupType" in input) return group.groupType;
    return group.products.map((product) => getValueByPath(product, input.groupDataPath));
  },
});

/**
 * One field's issues: its schema, then its rules (which can read the group
 * and the deal, through `scope`); none for a field the product doesn't have,
 * or that is hidden (its visibility condition doesn't hold). Pure, so each
 * app decides when to run it (a subscription, a computed, a derived store).
 */
export const fieldIssues = (
  definition: GenericProductDefinition,
  fieldId: ProductFieldId,
  data: ProductData,
  scope: RuleScope,
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
    const context = ruleContext(rule, data, scope);
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
  scope: RuleScope,
): FieldIssues => {
  const issues: FieldIssues = {};
  for (const fieldId of Object.keys(definition.fieldPaths) as ProductFieldId[]) {
    const found = fieldIssues(definition, fieldId, data, scope);
    if (found.length) issues[fieldId] = found;
  }
  return issues;
};

/**
 * What a field's validation reads: paths in the product's data; its group's
 * type, and paths read across every product of the group; deal keys.
 */
export type ValidationInputs = {
  dataPaths: readonly string[];
  readsGroupType: boolean;
  groupDataPaths: readonly string[];
  dealKeys: readonly DealKey[];
};

const inputsByDefinition = new Map<GenericProductDefinition, Map<ProductFieldId, ValidationInputs>>();

/**
 * Everything a field's validation reads, so a store knows when to re-check
 * it: the field itself, the field its existence depends on, the paths its
 * visibility condition and schema read, and everything its rules listen to.
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
    readsGroupType: ruleInputs.some((input) => "groupType" in input),
    groupDataPaths: [...new Set(ruleInputs.flatMap((input) => ("groupDataPath" in input ? [input.groupDataPath] : [])))],
    dealKeys: [...new Set(ruleInputs.flatMap((input) => ("dealKey" in input ? [input.dealKey] : [])))],
  };
  byField.set(fieldId, inputs);
  return inputs;
};

const fieldIdsOf = (definition: GenericProductDefinition) => Object.keys(definition.fieldPaths) as ProductFieldId[];

/** The fields whose validation reads the deal: a deal change re-checks (and repaints) only these. */
export const fieldsReadingDeal = (definition: GenericProductDefinition): ProductFieldId[] =>
  fieldIdsOf(definition).filter((fieldId) => validationInputs(definition, fieldId).dealKeys.length > 0);

/** The fields whose validation reads the group: a change to a product re-checks (and repaints) these in its group mates. */
export const fieldsReadingGroup = (definition: GenericProductDefinition): ProductFieldId[] =>
  fieldIdsOf(definition).filter((fieldId) => {
    const inputs = validationInputs(definition, fieldId);
    return inputs.readsGroupType || inputs.groupDataPaths.length > 0;
  });

/** The values a field's validation reads from outside its product, flat, to compare one run with the next. */
const outsideValues = (definition: GenericProductDefinition, fieldId: ProductFieldId, scope: RuleScope) => {
  const { readsGroupType, groupDataPaths, dealKeys } = validationInputs(definition, fieldId);
  const values: unknown[] = dealKeys.map(scope.readDeal);
  if (!readsGroupType && !groupDataPaths.length) return values;
  const group = scope.readGroup();
  if (readsGroupType) values.push(group.groupType);
  for (const path of groupDataPaths) {
    values.push(group.products.length, ...group.products.map((product) => getValueByPath(product, path)));
  }
  return values;
};

const sameValues = (a: readonly unknown[], b: readonly unknown[]) =>
  a.length === b.length && a.every((value, i) => Object.is(value, b[i]));

/**
 * Validation for stores whose product data is immutable (a new object is a
 * new version): a product's issues are cached by its data object and the
 * values its rules read from outside it (its group, its deal). When one of
 * those changes, only the fields that read it are checked again; when
 * nothing a product reads changed, the same issues object comes back. Each
 * store creates its own.
 */
export const createIssuesMemo = () => {
  type Entry = { outside: Map<ProductFieldId, readonly unknown[]>; issues: FieldIssues };
  const cache = new WeakMap<ProductData, Entry>();
  return (data: ProductData, scope: RuleScope): FieldIssues => {
    const definition = definitionOfData(data);
    const outside = new Map(
      [...new Set([...fieldsReadingDeal(definition), ...fieldsReadingGroup(definition)])].map((fieldId) => [
        fieldId,
        outsideValues(definition, fieldId, scope),
      ]),
    );
    const cached = cache.get(data);
    let issues: FieldIssues;
    if (cached) {
      const stale = [...outside].filter(([fieldId, values]) => !sameValues(values, cached.outside.get(fieldId)!));
      if (!stale.length) return cached.issues;
      issues = { ...cached.issues };
      for (const [fieldId] of stale) {
        const found = fieldIssues(definition, fieldId, data, scope);
        if (found.length) issues[fieldId] = found;
        else delete issues[fieldId];
      }
    } else {
      issues = productIssues(definition, data, scope);
    }
    cache.set(data, { outside, issues });
    return issues;
  };
};
