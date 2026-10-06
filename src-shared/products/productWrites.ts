import {
  type ProductFieldId,
  asyncOptionFields,
  existsForParam,
  fieldExists,
  fields,
  fieldsAbsentFor,
} from "../fields.ts";
import { getValueByPath, hasUnsafeSegment, removeIn, setIn } from "../lib/path.ts";
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

/** One list of options: a source, for one parameter. */
export type OptionsRequest = { source: OptionsSource; param: string };

/** Where a product's type is kept: set when it is created, never written. */
const PRODUCT_TYPE_PATH = "productType";

export const definitionOfData = (data: ProductData) => definitionOf(productTypeOf(data));

/** A definition's paths, indexed once: each field's path, and every object path that holds fields. */
type DefinitionPaths = { fields: Map<string, ProductFieldId>; containers: Set<string> };

const pathsByDefinition = new Map<GenericProductDefinition, DefinitionPaths>();
const pathsOf = (definition: GenericProductDefinition): DefinitionPaths => {
  const known = pathsByDefinition.get(definition);
  if (known) return known;
  const paths: DefinitionPaths = { fields: new Map(), containers: new Set() };
  for (const [fieldId, fieldPath] of Object.entries(definition.fieldPaths)) {
    paths.fields.set(fieldPath, fieldId as ProductFieldId);
    const segments = fieldPath.split(".");
    for (let i = 1; i < segments.length; i++) paths.containers.add(segments.slice(0, i).join("."));
  }
  pathsByDefinition.set(definition, paths);
  return paths;
};

/** The field a path in a product's data belongs to, if it is a declared field. */
export const fieldAtPath = (definition: GenericProductDefinition, path: string) => pathsOf(definition).fields.get(path);

/** Whether a path in a product's data is an object that holds declared fields (`optionsCommon.base.notional`). */
export const isFieldContainer = (definition: GenericProductDefinition, path: string) =>
  pathsOf(definition).containers.has(path);

const isPlainObject = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

/**
 * A path write into a product's data, as the leaf writes it stands for:
 * - a declared field, or any other path: itself (written as is);
 * - an object that holds declared fields (a container): one write per key
 *   of the value, so each field inside gets its own rules; a value that
 *   isn't an object is no write at all;
 * - `productType`, a path under a declared field (`…strike.length`), or a
 *   path through a prototype key: no write.
 * Routing (sync) and planning both expand writes with it.
 */
export const expandProductWrite = (
  definition: GenericProductDefinition,
  path: string,
  value: unknown,
): { path: string; value: unknown }[] => {
  const { fields, containers } = pathsOf(definition);
  if (fields.has(path)) return [{ path, value }];
  const segments = path.split(".");
  if (path === PRODUCT_TYPE_PATH || hasUnsafeSegment(segments)) return [];
  for (let i = 1; i < segments.length; i++) {
    if (fields.has(segments.slice(0, i).join("."))) return []; // under a leaf
  }
  if (!containers.has(path)) return [{ path, value }];
  if (!isPlainObject(value)) return [];
  return Object.keys(value).flatMap((key) => expandProductWrite(definition, `${path}.${key}`, value[key]));
};

const unchanged = (data: ProductData) => ({ data, changes: [] as LeafChange[] });

/** One leaf (or undeclared) write planned onto `data`, its changes pushed onto `changes`. */
const planLeafWrite = (
  definition: GenericProductDefinition,
  data: ProductData,
  write: ProductWrite,
  changes: LeafChange[],
): ProductData => {
  const fieldId = "fieldId" in write ? write.fieldId : fieldAtPath(definition, write.path);
  if (!fieldId) {
    // only a path can miss a field: written as is
    const { path, value } = write as { path: string; value: unknown };
    const next = setIn(data, path, value);
    if (next !== data) changes.push({ path, value });
    return next;
  }
  const read = (id: ProductFieldId) => getValueByPath(data, definition.fieldPaths[id]);
  if (isReadOnly(definition, fieldId) || !fieldExists(fieldId, read)) return data;
  // a writable derived field (Expiry Days): the field it derives from is written, and it follows
  const derived = definition.derived?.[fieldId];
  if (derived?.write) return planLeafWrite(definition, data, derived.write(write.value), changes);
  const path = definition.fieldPaths[fieldId];
  let next = setIn(data, path, write.value);
  if (next === data) return data;
  changes.push({ path, value: write.value });
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
  return next;
};

/** A leaf as it stands in some data: whether it is there, and its value. */
const leafAt = (data: object, path: string) => {
  const segments = path.split(".");
  const key = segments.pop() as string;
  const parent = getValueByPath(data, segments);
  const present = typeof parent === "object" && parent !== null && key in parent;
  return { present, value: present ? (parent as Record<string, unknown>)[key] : undefined };
};

/** Whether every leaf the changes touched ends as it started: a batch that wrote and wrote back. */
const endsAsItStarted = (before: ProductData, after: ProductData, changes: readonly LeafChange[]) =>
  changes.every(({ path }) => {
    const [was, is] = [leafAt(before, path), leafAt(after, path)];
    return was.present === is.present && Object.is(was.value, is.value);
  });

/**
 * Writes planned in order: the product's data after them (only the objects
 * along the changed paths are copied; nothing changed: the same object), and
 * the leaf changes that get there, in order. A batch whose writes end where
 * the data started (a field written, then written back) changes nothing.
 *
 * A path that is a declared field gets the field's rules: derived fields are
 * recomputed from what they depend on, and a write to one writes the field
 * it says (`write`) or nothing; a field the product doesn't have (a fixing
 * source without Cash) isn't written, and fields that stop existing are
 * removed. An object written over declared fields is written field by field
 * (`expandProductWrite`). Any other path is written as is.
 */
export const planProductWrites = (
  data: ProductData,
  writes: readonly ProductWrite[],
): { data: ProductData; changes: LeafChange[] } => {
  // writes never change a product's type, so its definition holds for the whole batch
  const definition = definitionOfData(data);
  const changes: LeafChange[] = [];
  let next = data;
  for (const write of writes) {
    if ("fieldId" in write) next = planLeafWrite(definition, next, write, changes);
    else for (const leaf of expandProductWrite(definition, write.path, write.value)) next = planLeafWrite(definition, next, leaf, changes);
  }
  return next === data || endsAsItStarted(data, next, changes) ? unchanged(data) : { data: next, changes };
};

/** One write planned (see `planProductWrites`). */
export const planProductWrite = (data: ProductData, write: ProductWrite) => planProductWrites(data, [write]);

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
 * if still an option (or an option's label: a pasted label), else the first.
 * A product that has since moved to another parameter gets none (a stale
 * response).
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

/**
 * Product data back from JSON (a state from DevTools): an empty number field
 * is NaN in the app but `null` in JSON. Puts NaN back at the number fields'
 * paths only, so a `null` anywhere else stays as written. Data without such
 * a `null` is returned as is.
 */
export const withNumbersRevived = (data: ProductData): ProductData => {
  const definition = definitionOfData(data);
  let revived = data;
  for (const field of fields) {
    const path = field.input === "number" ? (definition.fieldPaths as Record<string, string>)[field.id] : undefined;
    if (path && getValueByPath(revived, path) === null) revived = setIn(revived, path, NaN);
  }
  return revived;
};
