/** Dot-separated paths to the non-object (leaf) fields of `T`. */
export type LeafPath<T> = {
  [K in keyof T & string]: T[K] extends object
    ? `${K}.${LeafPath<T[K]>}`
    : K;
}[keyof T & string];

/** Dot-separated paths to every field of `T`, objects included. */
export type DeepPath<T> = {
  [K in keyof T & string]: T[K] extends object ? K | `${K}.${DeepPath<T[K]>}` : K;
}[keyof T & string];

/** A path as a dot string, or already split into its segments (so a walk never splits it again). */
export type PathSegments = string | readonly string[];

const unsafeKeys = new Set(["__proto__", "constructor", "prototype"]);

/**
 * Segments that lead into an object's prototype. A path through one is
 * never written or deleted (a no-op): `__proto__.x` would otherwise write
 * into `Object.prototype` in a mutable store.
 */
export const isUnsafeKey = (key: string) => unsafeKeys.has(key);

export const hasUnsafeSegment = (path: PathSegments) => toSegments(path).some(isUnsafeKey);

export const toSegments = (path: PathSegments): readonly string[] =>
  typeof path === "string" ? path.split(".") : path;

const isObjectLike = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null;

/** A missing step on the way down, which a write may create (`undefined`, or `null` as before). */
const isMissing = (value: unknown) => value === undefined || value === null;

/** `undefined` when any segment is missing, instead of throwing. */
export const getValueByPath = (target: object, path: PathSegments): unknown =>
  toSegments(path).reduce<unknown>(
    (current, part) => (current as Record<string, unknown> | undefined)?.[part],
    target,
  );

/**
 * Mutating set; creates intermediate objects if missing. A write under a
 * leaf (a step that holds a string, number, …) or through a prototype key
 * is ignored.
 */
export const setValueByPath = (
  target: object,
  path: string,
  value: unknown,
): void => {
  const parts = path.split(".");
  if (hasUnsafeSegment(parts)) return;
  const lastKey = parts.pop() as string;
  let parent = target as Record<string, unknown>;
  for (const part of parts) {
    const current = parent[part];
    if (isMissing(current)) parent[part] = {};
    else if (!isObjectLike(current)) return; // under a leaf
    // read back: a proxy store hands out its own wrapper of what was assigned
    parent = parent[part] as Record<string, unknown>;
  }
  parent[lastKey] = value;
};

const setInSegments = (target: object, segments: readonly string[], index: number, value: unknown): object => {
  const head = segments[index];
  const record = target as Record<string, unknown>;
  const current = record[head];
  let next = value;
  if (index < segments.length - 1) {
    if (!isMissing(current) && !isObjectLike(current)) return target; // under a leaf
    next = setInSegments(isMissing(current) ? {} : (current as object), segments, index + 1, value);
  }
  if (Object.is(current, next)) return target;
  return { ...record, [head]: next };
};

/**
 * Immutable set: returns a copy with `value` at `path`, copying only the
 * objects along the path (structural sharing). Writing the value a field
 * already has returns `target` itself, so stores see no change; so does a
 * write under a leaf, or through a prototype key.
 */
export const setIn = <T extends object>(
  target: T,
  path: PathSegments,
  value: unknown,
): T => {
  const segments = toSegments(path);
  return hasUnsafeSegment(segments) ? target : (setInSegments(target, segments, 0, value) as T);
};

const removeInSegments = (target: unknown, segments: readonly string[], index: number): unknown => {
  if (!isObjectLike(target)) return target; // under a leaf: nothing to remove
  const head = segments[index];
  if (!(head in target)) return target;
  if (index === segments.length - 1) {
    const { [head]: _, ...copy } = target;
    return copy;
  }
  const current = target[head];
  const next = removeInSegments(current, segments, index + 1);
  return next === current ? target : { ...target, [head]: next };
};

/**
 * Immutable delete: returns a copy without the leaf at `path`, copying only
 * the objects along the path. Without such a leaf, returns `target` itself.
 */
export const removeIn = <T extends object>(target: T, path: PathSegments): T => {
  const segments = toSegments(path);
  return hasUnsafeSegment(segments) ? target : (removeInSegments(target, segments, 0) as T);
};

/**
 * Splits a path into the object that owns the leaf and the leaf key, so a
 * subscription can target that (nested) object instead of the whole store.
 */
export const resolveParent = (target: object, path: string) => {
  const parts = path.split(".");
  const key = parts.pop() as string;
  const parent = (
    parts.length ? getValueByPath(target, parts) : target
  ) as Record<string, unknown> | undefined;
  return { parent, key };
};

/** Mutating delete; does nothing (and notifies nothing) without such a leaf, or through a prototype key. */
export const deleteValueByPath = (target: object, path: string): void => {
  if (hasUnsafeSegment(path)) return;
  const { parent, key } = resolveParent(target, path);
  if (isObjectLike(parent) && key in parent) delete parent[key];
};
