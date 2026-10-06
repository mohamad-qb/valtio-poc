import {
  type DealFieldsState,
  type SyncedFieldId,
  asSyncedValue,
  isBroadcastField,
  isEmptyBroadcast,
  isSyncedField,
  syncedFieldIds,
} from "./dealFields.ts";
import { type DealReducer, dealStateOf, runDealLogic } from "./dealLogic/changes.ts";
import { onStoreChanges } from "./dealLogic/dealLogic.ts";
import { type DealSettingId, type DealSettingsState, isDealSetting, settingWriteOrder, withSetting } from "./dealSettings.ts";
import type { ProductFieldId } from "./fields.ts";
import { type PathWrite, parsePath } from "./paths.ts";
import type { ProductData } from "./products/productRegistry.ts";
import {
  type OptionsRequest,
  type ProductWrite,
  definitionOfData,
  expandProductWrite,
  fieldAtPath,
  optionsRequestsFor,
  uniqueRequests,
} from "./products/productWrites.ts";

/** A product as the router sees it: where it lives, and its data now. */
export type DealProduct = { groupId: string; productId: string; data: ProductData };

/** A batch of path writes, sorted out: what each part of the deal gets. */
export type RoutedWrites = {
  dealFields: DealFieldsState;
  settings: DealSettingsState;
  /** Each addressed product's writes, in order, by product id. */
  products: Map<string, { groupId: string; writes: ProductWrite[] }>;
  /** The options to (re)load after it. */
  requests: OptionsRequest[];
};

const withDealField = (deal: DealFieldsState, fieldId: SyncedFieldId, value: unknown) =>
  Object.is(deal[fieldId], value) ? deal : { ...deal, [fieldId]: value };

const sameDealFields = (a: DealFieldsState, b: DealFieldsState) => syncedFieldIds.every((id) => Object.is(a[id], b[id]));

const sameSettings = (a: DealSettingsState, b: DealSettingsState) => a.isInternal === b.isInternal && a.hedgeType === b.hedgeType;

/**
 * Routes a batch of path writes (see `paths.ts`), in order, for any store.
 * The deal logic (`onStoreChanges`) runs first, and the changes it adds are
 * routed with the batch, after the writes that caused them:
 * - a deal setting: the new settings (a hedge type stays one of its options).
 *   Internal lands before Hedge Type, whatever their order in the batch;
 * - a synced field, from the deal or any product: the deal's value, and
 *   every product (two-way sync);
 * - a deal broadcast: every product (an empty one goes nowhere);
 * - any other product path: that product. An object written over declared
 *   fields counts as a write to each field in it, so the fields inside keep
 *   their rules (a synced one syncs).
 * Paths the deal doesn't have are ignored. Each store then applies the
 * result its own way — that, and how it notices, is all that differs.
 *
 * A batch that ends where the deal started (a value written, then written
 * back) returns the deal's own `dealFields` and `settings` objects.
 *
 * Cost: a synced field is fanned out once per batch, with its last value
 * (nothing reads a synced field, so where it lands among a product's writes
 * doesn't matter), and not at all when the deal ends up holding the value it
 * held. A paste of a synced field over N products plans N writes, not N².
 */
export const routeWrites = (
  state: { dealFields: DealFieldsState; settings: DealSettingsState; products: readonly DealProduct[] },
  writes: readonly PathWrite[],
  reducers: readonly DealReducer[] = onStoreChanges,
): RoutedWrites => {
  let { dealFields } = state;
  const settingWrites: { id: DealSettingId; value: unknown }[] = [];
  const products = new Map<string, { groupId: string; writes: ProductWrite[] }>();
  const requests: OptionsRequest[] = [];
  const productsById = new Map(state.products.map((product) => [product.productId, product]));
  /** The synced fields the batch wrote, each with its last value. */
  const synced = new Map<SyncedFieldId, unknown>();

  const writesOf = ({ groupId, productId }: DealProduct) => {
    let own = products.get(productId);
    if (!own) {
      own = { groupId, writes: [] };
      products.set(productId, own);
    }
    return own.writes;
  };
  // every product's writes, in the deal's order, from the first write that may reach them all
  // (so products are listed in the same order however a synced field is fanned out)
  let everyProduct: ProductWrite[][] | null = null;
  const reachEvery = () => {
    if (!everyProduct) everyProduct = state.products.map(writesOf);
    return everyProduct;
  };
  const toEvery = (write: ProductWrite) => {
    for (const own of reachEvery()) own.push(write);
  };
  const toSynced = (fieldId: SyncedFieldId, written: unknown) => {
    const value = asSyncedValue(fieldId, written);
    dealFields = withDealField(dealFields, fieldId, value);
    synced.set(fieldId, value);
    reachEvery();
  };

  for (const { path, value } of runDealLogic(dealStateOf(state), writes, reducers)) {
    const target = parsePath(path);
    if (!target) continue;
    if (target.kind === "deal") {
      const { key } = target;
      if (isDealSetting(key)) settingWrites.push({ id: key, value });
      else if (isSyncedField(key)) toSynced(key, value);
      else if (isBroadcastField(key) && !isEmptyBroadcast(value)) {
        toEvery({ fieldId: key, value });
        requests.push(...optionsRequestsFor(key, value));
      }
      continue;
    }
    const product = productsById.get(target.productId);
    if (!product || product.groupId !== target.groupId) continue;
    const definition = definitionOfData(product.data);
    for (const write of expandProductWrite(definition, target.dataPath, value)) {
      const fieldId: ProductFieldId | undefined = fieldAtPath(definition, write.path);
      // a product's synced field is the two-way sync: the deal and every product
      if (fieldId && isSyncedField(fieldId)) toSynced(fieldId, write.value);
      else {
        writesOf(product).push(write);
        if (fieldId) requests.push(...optionsRequestsFor(fieldId, write.value));
      }
    }
  }

  for (const [fieldId, value] of synced) {
    requests.push(...optionsRequestsFor(fieldId, value));
    // the deal holds what it held: so does every product
    if (!Object.is(value, state.dealFields[fieldId])) toEvery({ fieldId, value });
  }
  // a synced value fanned out to nobody leaves its reserved entries empty
  for (const [productId, own] of products) if (!own.writes.length) products.delete(productId);

  // Internal first: it decides which hedge types are on offer
  let { settings } = state;
  for (const id of settingWriteOrder) {
    for (const write of settingWrites) if (write.id === id) settings = withSetting(settings, id, write.value);
  }

  return {
    dealFields: sameDealFields(dealFields, state.dealFields) ? state.dealFields : dealFields,
    settings: sameSettings(settings, state.settings) ? state.settings : settings,
    products,
    requests: uniqueRequests(requests),
  };
};

/** A deal path's value, from the deal's own state (`undefined` for a broadcast: the deal holds nothing). */
export const readDealKey = (key: string, dealFields: DealFieldsState, settings: DealSettingsState): unknown => {
  if (isDealSetting(key)) return settings[key];
  return isSyncedField(key) ? dealFields[key] : undefined;
};
