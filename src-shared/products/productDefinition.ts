import type { ZodType } from "zod";
import { type BoolLogic, mapBoolLogicPaths } from "../boolLogic.ts";
import type { DealFieldsState } from "../dealFields.ts";
import { type DealKey, isDealKey } from "../dealKeys.ts";
import { type ProductFieldId, fields as gridRows } from "../fields.ts";
import type { DeepPath, LeafPath } from "../lib/path.ts";
import { DATA, GROUPS, PRODUCTS } from "../paths.ts";

export type ProductUi = { title: string; index: number };

/**
 * A field computed from others. Read-only, unless it has `write`: a write to
 * it then writes the field it returns instead, and it is recomputed from that.
 */
export type DerivedField<Data> = {
  dependsOn: readonly ProductFieldId[];
  compute: (data: Data) => unknown;
  write?: (value: unknown) => { fieldId: ProductFieldId; value: unknown };
};

/** Where any product's data lives in the deal: `$GROUP_ID` and `$PRODUCT_ID` stand for its own ids. */
export const PRODUCT_DATA_PREFIX = `${GROUPS}.$GROUP_ID.${PRODUCTS}.$PRODUCT_ID.${DATA}.`;

/** A path into a product's data, written from the deal's root as the original app's configs write it. */
export type ProductPath<Path extends string> = `groups.$GROUP_ID.products.$PRODUCT_ID.data.${Path}`;

/** Where a product's group is, from the deal's root. */
const GROUP_PREFIX = `${GROUPS}.$GROUP_ID.` as const;

/** The group's type. A group's type and products are fixed at creation. */
export const GROUP_TYPE_PATH = `${GROUP_PREFIX}groupType` as const;

/** A value across every product of the group (`*`), its own included, in display order: read as a list. */
export const GROUP_PRODUCTS_PREFIX = `${GROUP_PREFIX}${PRODUCTS}.*.${DATA}.`;

/** What a rule can read of its group: its type, or a value across all its products. */
export type GroupPath<Data> = typeof GROUP_TYPE_PATH | `groups.$GROUP_ID.products.*.data.${DeepPath<Data>}`;

/**
 * What a rule can listen to: a path in its own product's data, its group
 * (`GroupPath`), or a deal key (`isInternal`, `notionalCcy`, …).
 */
export type RulePath<Data> = ProductPath<DeepPath<Data>> | GroupPath<Data> | DealKey;

/** A rule's view of its product and deal: values by the paths it listens to, and only those. */
export type RuleContext<Path extends string = string> = { read: (path: Path) => unknown };

/**
 * A validation rule, reported on the field it is listed under. It reads
 * values only through `read`, by the paths in `listen` (its product, its
 * group, the deal): every store re-checks it exactly when one of them changes. Reading a path it doesn't listen to
 * throws, so a missing one fails the first test that runs the rule.
 */
export type ValidationRule<Data> = {
  listen: readonly RulePath<Data>[];
  message: string | ((context: RuleContext<RulePath<Data>>) => string);
  isValid: (context: RuleContext<RulePath<Data>>) => boolean;
};

/** Where a listened path's value comes from: the product's data, its group, or the deal. */
export type RuleInput =
  | { path: string; dataPath: string }
  | { path: string; groupType: true }
  | { path: string; groupDataPath: string }
  | { path: string; dealKey: DealKey };

/** A rule as the stores run it: each path it listens to, resolved. */
export type CompiledRule = {
  listen: readonly string[];
  inputs: readonly RuleInput[];
  message: string | ((context: RuleContext) => string);
  isValid: (context: RuleContext) => boolean;
};

/**
 * One grid row of a product, in the original app's config shape
 * (`FxVanilla.ts`). Every path is checked against the product's data type.
 */
export type ProductFieldConfig<Data> = {
  /** The original app's cell component; unused here: the grid picks the editor per row (`fields.ts`). */
  type?: string;
  /** The value the cell shows and edits. */
  props: { path: ProductPath<LeafPath<Data>> };
  /** The grid row it fills. */
  position: { field: ProductFieldId };
  /** Shown, and validated, only while the condition holds; its data is kept either way. */
  visibility?: { if: BoolLogic<ProductPath<DeepPath<Data>>> };
  /** The schema the value at the path must pass, checked only while the field is visible. */
  validation?: { schema: readonly [path: ProductPath<DeepPath<Data>>, schema: ZodType] };
};

/**
 * Everything specific to one product type: its fields as configs, plus the
 * rules, derived fields and initial data that sit beside them. Each app's
 * generic product factory turns it into a live product.
 */
export type ProductDefinition<Data extends { productType: string }> = {
  label: string;
  fields: readonly ProductFieldConfig<Data>[];
  rules?: Partial<Record<ProductFieldId, readonly ValidationRule<Data>[]>>;
  derived?: Partial<Record<ProductFieldId, DerivedField<Data>>>;
  /** A new product's data, starting from the deal's values. */
  createData: (deal: DealFieldsState) => Data;
};

/** A field's schema, and the path (in the product's data) of the value it checks. */
export type FieldValidation = { path: string; schema: ZodType };

const productFieldIds = gridRows.map(({ id }) => id).filter((id): id is ProductFieldId => id !== "spotStream");

/** A config path, relative to the product's data. */
const toDataPath = (path: string) => {
  if (!path.startsWith(PRODUCT_DATA_PREFIX)) {
    throw new Error(`"${path}" isn't in a product's data (${PRODUCT_DATA_PREFIX}…)`);
  }
  return path.slice(PRODUCT_DATA_PREFIX.length);
};

/** A rule with what it listens to resolved; a path that's not the product's, its group's or the deal's throws. */
const compileRule = (label: string, fieldId: string, rule: Omit<CompiledRule, "inputs">): CompiledRule => ({
  ...rule,
  inputs: rule.listen.map((path): RuleInput => {
    if (path.startsWith(PRODUCT_DATA_PREFIX)) return { path, dataPath: toDataPath(path) };
    if (path === GROUP_TYPE_PATH) return { path, groupType: true };
    if (path.startsWith(GROUP_PRODUCTS_PREFIX)) return { path, groupDataPath: path.slice(GROUP_PRODUCTS_PREFIX.length) };
    if (isDealKey(path)) return { path, dealKey: path };
    throw new Error(
      `${label}: a rule on ${fieldId} listens to "${path}", which is neither in its product's data, its group, nor a deal key`,
    );
  }),
});

/**
 * A product definition, compiled from its field configs into what the
 * stores and the grid read: each row's path, schema and visibility, and each
 * rule's inputs, relative to the product's data. A config that can't work (a
 * path outside the product, a row listed twice or missing, a rule listening
 * to something unknown) throws, so it fails on load.
 */
export const defineProduct = <Data extends { productType: string }>({
  fields,
  rules = {},
  ...definition
}: ProductDefinition<Data>) => {
  const fieldPaths = {} as Record<ProductFieldId, LeafPath<Data>>;
  const validation: Partial<Record<ProductFieldId, FieldValidation>> = {};
  const visibility: Partial<Record<ProductFieldId, BoolLogic>> = {};
  for (const field of fields) {
    const id = field.position.field;
    if (id in fieldPaths) throw new Error(`${definition.label}: row "${id}" is listed twice`);
    fieldPaths[id] = toDataPath(field.props.path) as LeafPath<Data>;
    if (field.validation) {
      const [path, schema] = field.validation.schema;
      validation[id] = { path: toDataPath(path), schema };
    }
    if (field.visibility) visibility[id] = mapBoolLogicPaths(field.visibility.if, toDataPath);
  }
  const missing = productFieldIds.filter((id) => !(id in fieldPaths));
  if (missing.length) throw new Error(`${definition.label}: no field for ${missing.join(", ")}`);
  const compiledRules = Object.fromEntries(
    Object.entries(rules).map(([fieldId, fieldRules]) => [
      fieldId,
      (fieldRules as readonly CompiledRule[]).map((rule) => compileRule(definition.label, fieldId, rule)),
    ]),
  ) as Partial<Record<ProductFieldId, readonly CompiledRule[]>>;
  return { ...definition, rules: compiledRules, fieldPaths, validation, visibility };
};
