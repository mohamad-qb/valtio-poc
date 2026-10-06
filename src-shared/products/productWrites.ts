import {
  type ProductFieldId,
  asyncOptionFields,
  existsForParam,
  fieldExists,
  fieldsAbsentFor,
} from "../fields.ts";
import { getValueByPath, removeIn, setIn } from "../lib/path.ts";
import { productPath } from "../paths.ts";
import {
  type Option,
  type OptionsSource,
  optionsKey,
  reconcileOption,
} from "../options/optionsSource.ts";
import {
  type GenericProductDefinition,
  type ProductData,
  definitionOf,
  derivedFieldsOf,
  isReadOnly,
  productTypeOf,
} from "./productRegistry.ts";

/**
 * Every rule of a write into a product, in one place for every store:
 * which fields can be written, what is recomputed with them, and what
 * appears or disappears. Pure: a store applies the result its own way.
 */

/** A write into a product: by path in its data (as the app being migrated writes), or by field. */
export type ProductWrite =
  | { path: string; value: unknown }
  | { fieldId: ProductFieldId; value: unknown };

/**
 * One leaf a write changes. `derived`: a computed field's new value, for
 * stores that keep it as data (a store that computes it itself skips it).
 */
export type LeafChange =
  | { path: string; value: unknown; derived?: boolean }
  | { path: string; remove: true };

/** A product's leaf change by its full path in the deal (`groups.<g>.products.<p>.data.<path>`). */
export type DealLeafChange = { path: string; value: unknown } | { path: string; removed: true };

/** A product's leaf changes, addressed from the deal's root. */
export const toDealLeafChanges = (
  groupId: string,
  productId: string,
  changes: readonly LeafChange[],
): DealLeafChange[] =>
  changes.map((change) => {
    const path = productPath(groupId, productId, change.path);
    return "remove" in change ? { path, removed: true } : { path, value: change.value };
  });

/** One list of options: a source, for one parameter. */
export type OptionsRequest = { source: OptionsSource; param: string };

export const definitionOfData = (data: ProductData) => definitionOf(productTypeOf(data));

const fieldsByPath = new Map<GenericProductDefinition, Map<string, ProductFieldId>>();
/** The field a path in a product's data belongs to, if it is a declared field. */
export const fieldAtPath = (definition: GenericProductDefinition, path: string) => {
  if (!fieldsByPath.has(definition)) {
    const byPath = new Map<string, ProductFieldId>();
    for (const [fieldId, fieldPath] of Object.entries(definition.fieldPaths)) {
      byPath.set(fieldPath, fieldId as ProductFieldId);
    }
    fieldsByPath.set(definition, byPath);
  }
  return fieldsByPath.get(definition)!.get(path);
};

const unchanged = (data: ProductData) => ({ data, changes: [] as LeafChange[] });

/**
 * A write planned: the product's data after it (only the objects along the
 * changed paths are copied; nothing changed: the same object), and the leaf
 * changes that get there, in order.
 *
 * A path that is a declared field gets the field's rules: derived fields are
 * recomputed from what they depend on, and a write to one writes the field
 * it says (`write`) or nothing; a field the product doesn't have (a fixing
 * source without Cash) isn't written, and fields that stop existing are
 * removed. Any other path is written as is.
 */
export const planProductWrite = (data: ProductData, write: ProductWrite): { data: ProductData; changes: LeafChange[] } => {
  const definition = definitionOfData(data);
  const fieldId = "fieldId" in write ? write.fieldId : fieldAtPath(definition, write.path);
  if (!fieldId) {
    // only a path can miss a field: written as is
    const { path, value } = write as { path: string; value: unknown };
    const next = setIn(data, path, value);
    return next === data ? unchanged(data) : { data: next, changes: [{ path, value }] };
  }
  const read = (id: ProductFieldId) => getValueByPath(data, definition.fieldPaths[id]);
  if (isReadOnly(definition, fieldId) || !fieldExists(fieldId, read)) return unchanged(data);
  // a writable derived field (Expiry Days): the field it derives from is written, and it follows
  const derived = definition.derived?.[fieldId];
  if (derived?.write) return planProductWrite(data, derived.write(write.value));
  const path = definition.fieldPaths[fieldId];
  let next = setIn(data, path, write.value);
  if (next === data) return unchanged(data);
  const changes: LeafChange[] = [{ path, value: write.value }];
  for (const [derivedId, derived] of derivedFieldsOf(definition, fieldId)) {
    const value = derived.compute(next);
    next = setIn(next, definition.fieldPaths[derivedId], value);
    changes.push({ path: definition.fieldPaths[derivedId], value, derived: true });
  }
  for (const absentId of fieldsAbsentFor(fieldId, write.value)) {
    const removed = removeIn(next, definition.fieldPaths[absentId]);
    if (removed === next) continue;
    next = removed;
    changes.push({ path: definition.fieldPaths[absentId], remove: true });
  }
  return { data: next, changes };
};

/** Writes planned in order: the final data, and every leaf change on the way. */
export const planProductWrites = (data: ProductData, writes: readonly ProductWrite[]) =>
  writes.reduce(
    (planned, write) => {
      const next = planProductWrite(planned.data, write);
      return { data: next.data, changes: [...planned.changes, ...next.changes] };
    },
    unchanged(data),
  );

// --- async options: each depends on another field of the same product

/** The options to (re)load when `fieldId` takes `value` (none if nothing depends on it). */
export const optionsRequestsFor = (fieldId: ProductFieldId, value: unknown): OptionsRequest[] =>
  asyncOptionFields
    .filter(({ options }) => options.dependsOn === fieldId && existsForParam(options, value))
    .map(({ options }) => ({ source: options.source, param: String(value) }));

/** The options a product needs now (a new or cloned product). */
export const optionsRequestsOf = (data: ProductData): OptionsRequest[] => {
  const definition = definitionOfData(data);
  return asyncOptionFields.flatMap(({ options }) =>
    optionsRequestsFor(options.dependsOn, getValueByPath(data, definition.fieldPaths[options.dependsOn])),
  );
};

/** One request per source and parameter. */
export const uniqueRequests = (requests: readonly OptionsRequest[]) => [
  ...new Map(requests.map((request) => [optionsKey(request.source, request.param), request])).values(),
];

/**
 * Options arrived: the writes that keep a product's fields valid — its value
 * if still an option, else the first. A product that has since moved to
 * another parameter gets none (a stale response).
 */
export const reconcileWrites = (
  data: ProductData,
  { source, param }: OptionsRequest,
  options: readonly Option[],
): ProductWrite[] => {
  const definition = definitionOfData(data);
  const read = (id: ProductFieldId) => getValueByPath(data, definition.fieldPaths[id]);
  return asyncOptionFields.flatMap(({ fieldId, options: field }) =>
    field.source === source && read(field.dependsOn) === param
      ? [{ fieldId, value: reconcileOption(read(fieldId), options) }]
      : [],
  );
};
