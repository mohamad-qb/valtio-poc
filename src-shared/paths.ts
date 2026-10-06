import { hasUnsafeSegment } from "./lib/path.ts";

/**
 * The deal's dot paths: the same addresses the app being migrated uses, so
 * its reads and writes carry over unchanged.
 *
 * - A deal field or setting: its id at the root (`notionalCcy`, `strike`,
 *   `hedgeType`). Synced fields hold the deal's value; broadcasts hold
 *   nothing (a write goes to every product).
 * - A product's data: `groups.<groupId>.products.<productId>.data.<path>`,
 *   where `<path>` is the product type's own (`optionsCommon.base.expiryDate`).
 *
 * The segment names live here only: renaming `products` (e.g. to `p`) is a
 * one-line change.
 */
export const GROUPS = "groups";
export const PRODUCTS = "products";
export const DATA = "data";

export type PathWrite = { path: string; value: unknown };

export type ParsedPath =
  | { kind: "deal"; key: string }
  | { kind: "product"; groupId: string; productId: string; dataPath: string };

export const productPath = (groupId: string, productId: string, dataPath: string) =>
  `${GROUPS}.${groupId}.${PRODUCTS}.${productId}.${DATA}.${dataPath}`;

/**
 * A path's target, or `null` for a path the deal doesn't have — including
 * any path through `__proto__`, `constructor` or `prototype`.
 */
export const parsePath = (path: string): ParsedPath | null => {
  const parts = path.split(".");
  if (hasUnsafeSegment(parts)) return null;
  if (parts[0] !== GROUPS) return parts.length === 1 && parts[0] ? { kind: "deal", key: parts[0] } : null;
  const [, groupId, products, productId, data, ...rest] = parts;
  if (products !== PRODUCTS || data !== DATA || !groupId || !productId || !rest.length) return null;
  return { kind: "product", groupId, productId, dataPath: rest.join(".") };
};
