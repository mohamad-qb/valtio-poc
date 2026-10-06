import type { ProductFieldId } from "./fields.ts";

/**
 * How the deal shares fields with its products.
 * - synced: the deal value and every product's copy move together (two-way).
 * - broadcast: the deal holds nothing; a commit pushes the value into every
 *   product of every group, through each product's rules (Expiry Days moves
 *   each product's Expiry Date, as typing it into the product would).
 * Each product maps these field ids to its own paths.
 */
export const syncedFieldIds = ["notionalCcy", "premiumCcy", "notionalAmount"] as const;
export type SyncedFieldId = (typeof syncedFieldIds)[number];

export const isSyncedField = (id: string): id is SyncedFieldId =>
  (syncedFieldIds as readonly string[]).includes(id);

export const broadcastFieldIds = [
  "strike",
  "callPut",
  "buySell",
  "ccyPair",
  "deliveryDate",
  "expiryCut",
  "expiryDate",
  "expiryDays",
  "premiumDate",
  "settlementStyle",
  "settlementCcy",
  "settlementFixingSource",
] as const satisfies readonly ProductFieldId[];
export type BroadcastFieldId = (typeof broadcastFieldIds)[number];

export const isBroadcastField = (id: string): id is BroadcastFieldId =>
  (broadcastFieldIds as readonly string[]).includes(id);

/** The deal's own values: the synced fields. New products start from them. */
export type DealFieldsState = {
  notionalCcy: string;
  premiumCcy: string;
  /** `NaN` while empty, like every number field. */
  notionalAmount: number;
};

export const initialDealFields: DealFieldsState = {
  notionalCcy: "1xxxxxx",
  premiumCcy: "2",
  notionalAmount: NaN,
};

/** A broadcast commit carries nothing when the input was left empty (or blank). */
export const isEmptyBroadcast = (value: unknown) =>
  value === undefined ||
  value === null ||
  Number.isNaN(value) ||
  (typeof value === "string" && value.trim() === "");

/**
 * A synced value as the deal and every product hold it, whatever was
 * written by path: empty (`""`, NaN) for null, undefined or `""`, else
 * converted to the field's type (`"1000"` → 1000, `123` → `"123"`).
 */
export const asSyncedValue = (fieldId: SyncedFieldId, value: unknown) => {
  const isEmpty = value === null || value === undefined || value === "";
  if (typeof initialDealFields[fieldId] === "number") return isEmpty ? NaN : Number(value);
  return isEmpty ? "" : String(value);
};
