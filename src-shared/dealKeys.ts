import { type DealFieldsState, type SyncedFieldId, isSyncedField } from "./dealFields.ts";
import { type DealSettingId, type DealSettingsState, isDealSetting } from "./dealSettings.ts";

/**
 * The deal's own values, by the keys its root paths use: the synced fields
 * (`notionalCcy`, …) and the settings (`isInternal`, `hedgeType`). What a
 * product's validation rules can read from the deal (`listen`).
 */
export type DealKey = SyncedFieldId | DealSettingId;

export const isDealKey = (key: string): key is DealKey => isSyncedField(key) || isDealSetting(key);

/**
 * Reads a deal value by key. Each store passes its own: reading through its
 * observables (MobX, Legend-State) tracks exactly the keys a rule reads.
 */
export type ReadDeal = (key: DealKey) => unknown;

/** A reader over the deal's fields and settings (one object holding both: pass it twice). */
export const dealReader =
  (dealFields: DealFieldsState, settings: DealSettingsState): ReadDeal =>
  (key) =>
    isDealSetting(key) ? settings[key] : dealFields[key];
