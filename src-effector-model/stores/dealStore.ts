import {
  type Store,
  clearNode,
  combine,
  createEffect,
  createEvent,
  createNode,
  createStore,
  merge,
  sample as connect,
  withRegion,
} from "effector";
import { keyval } from "@effector/model";
import { calculatePrice } from "@shared/api/calculate.ts";
import {
  type CalcState,
  calcFailed,
  calcInputsChanged,
  calcStarted,
  calcSucceeded,
  initialCalcState,
  isCalcReady,
  needsAutocalc,
} from "@shared/calc.ts";
import { type DealFieldsState, initialDealFields } from "@shared/dealFields.ts";
import { type DealSettingsState, hedgeTypesFor, initialDealSettings } from "@shared/dealSettings.ts";
import { type DealProduct, routeWrites } from "@shared/dealWrites.ts";
import { dealOptionsRequests } from "@shared/fields.ts";
import { type GroupType, groupDefinitions, groupTitle, productUi } from "@shared/groups.ts";
import { uuid } from "@shared/lib/uuid.ts";
import type { Option } from "@shared/options/optionsSource.ts";
import type { PathWrite } from "@shared/paths.ts";
import { type ProductData, type ProductUi, definitionOf } from "@shared/products/productRegistry.ts";
import {
  type OptionsRequest,
  type ProductWrite,
  optionsRequestsOf,
  uniqueRequests,
} from "@shared/products/productWrites.ts";
import { createSpotPriceStream } from "@shared/spotPriceStream.ts";
import type { FieldIssues } from "@shared/validation.ts";
import { loadAllOptionsEffect, loadOptionsEffect } from "./optionsStore.ts";
import { productsModel } from "./productModel.ts";

/** What a deal needs from the app-wide developer settings. */
type DealDevtools = {
  $isSpotPriceStreamEnabled: Store<boolean>;
  $isAutocalcEnabled: Store<boolean>;
};

/** A product as the collections show it: its own stores' values. */
export type ProductItem = { id: string; ui: ProductUi; data: ProductData | null; issues: FieldIssues };
export type GroupItem = {
  id: string;
  groupType: GroupType;
  ui: { title: string; index: number };
  products: ProductItem[];
};

/** Each product's writes from one batch, in order. */
type ProductWrites = { productId: string; writes: ProductWrite[] };

/**
 * A group, as one item of an `@effector/model` collection: its own stores,
 * and its products as a nested collection. Its api passes writes on to the
 * products they address.
 *
 * Each deal builds its collection from this function (`keyval(createGroup)`),
 * not by cloning a collection: a cloned model's `create` runs once more to
 * read its shape, with nested collections as placeholders that have no api.
 */
const createGroup = () => {
  const $id = createStore("");
  const $groupType = createStore<GroupType>("VanillaGroup");
  const $ui = createStore({ title: "", index: 0 });
  const products = keyval(productsModel);

  /** Each addressed product's writes: one api call for all of them. */
  const writeProducts = createEvent<readonly ProductWrites[]>();
  connect({
    clock: writeProducts,
    fn: (lists) => ({ key: lists.map(({ productId }) => productId), data: lists.map(({ writes }) => writes) }),
    target: products.api.write,
  });
  /** Options arrived: every product reconciles the fields that use them. */
  const reconcileOptions = createEvent<{ request: OptionsRequest; options: readonly Option[] }>();
  connect({
    clock: reconcileOptions,
    source: products.$keys,
    fn: (keys, payload) => ({ key: keys, data: keys.map(() => payload) }),
    target: products.api.reconcileOptions,
  });

  return {
    key: "id" as const,
    state: { id: $id, groupType: $groupType, ui: $ui, products },
    api: { writeProducts, reconcileOptions },
  };
};

const productsOf = (groups: readonly GroupItem[]) => groups.flatMap((group) => group.products);

/** Every product with where it lives: what the write router needs. */
const dealProducts = (groups: readonly GroupItem[]): DealProduct[] =>
  groups.flatMap((group) =>
    group.products.flatMap((product) =>
      product.data ? [{ groupId: group.id, productId: product.id, data: product.data }] : [],
    ),
  );

/**
 * One deal's model, on `@effector/model`: the groups are a collection whose
 * items each hold their products as a nested collection, so every group and
 * product has its own stores and api. `$order` keeps the display order.
 *
 * Every write is a batch of dot paths (`writePathsAction`), routed by the
 * shared rules: the deal's own stores take theirs, and the products get
 * theirs in one api call addressed to their groups.
 *
 * Its units live in their own region: `dispose` clears them all, with their
 * links to the shared options effects.
 */
export const createDealStore = (devtools: DealDevtools) => {
  const region = createNode();
  return withRegion(region, () => {
    const actions = {
      addGroupAction: createEvent<GroupType>(),
      cloneGroupAction: createEvent<string>(),
      removeGroupAction: createEvent<string>(),
      /** Writes values at dot paths, in order, as one batch: an edit, a paste, anything the old app wrote. */
      writePathsAction: createEvent<readonly PathWrite[]>(),
      /** Calculates now, if the deal is ready (the manual Calculate). */
      calculateAction: createEvent(),
      /** Loads the deal column's own options (its default parameters): its tab does, when it opens the deal. */
      loadDealOptionsAction: createEvent(),
    };

    // --- state
    const groups = keyval(createGroup);
    const $groupsById: Store<GroupItem[]> = groups.$items;
    const $order = createStore<string[]>([]);
    const $dealFields = createStore<DealFieldsState>(initialDealFields);
    const $settings = createStore<DealSettingsState>(initialDealSettings);

    // --- derived
    /** The groups in display order. */
    const $groups = combine($groupsById, $order, (items, order) => {
      const byId = new Map(items.map((group) => [group.id, group]));
      return order.flatMap((id) => byId.get(id) ?? []);
    });
    const $isInternal = $settings.map((settings) => settings.isInternal);
    const $hedgeTypes = $isInternal.map(hedgeTypesFor);
    /** Each product's issues are its own derived store, re-validated only when its data changes. */
    const $hasValidationErrors = $groups.map((items) =>
      productsOf(items).some((product) => Object.keys(product.issues).length > 0),
    );

    // --- groups: built (new ids) from the current deal values, inserted at a position
    const buildGroup = (groupType: GroupType, defaults: DealFieldsState, position: number, source?: GroupItem) => ({
      id: uuid(),
      groupType,
      ui: { index: position, title: groupTitle(groupType, position) },
      products: groupDefinitions[groupType].productTypes.map((productType, index) => {
        const sourceData = source?.products[index]?.data;
        return {
          id: uuid(),
          ui: productUi(productType, index),
          data: sourceData ? structuredClone(sourceData) : definitionOf(productType).createData(defaults),
        };
      }),
    });
    const groupCreated = merge([
      connect({
        clock: actions.addGroupAction,
        source: { defaults: $dealFields, order: $order },
        fn: ({ defaults, order }, groupType) => ({
          group: buildGroup(groupType, defaults, order.length),
          position: order.length,
        }),
      }),
      connect({
        clock: actions.cloneGroupAction,
        source: { defaults: $dealFields, order: $order, items: $groupsById },
        filter: ({ order }, groupId) => order.includes(groupId),
        fn: ({ defaults, order, items }, groupId) => {
          const source = items.find((group) => group.id === groupId)!;
          const position = order.indexOf(groupId) + 1;
          return { group: buildGroup(source.groupType, defaults, position, source), position };
        },
      }),
    ]);
    connect({ clock: groupCreated, fn: ({ group }) => group, target: groups.edit.add });
    $order.on(groupCreated, (order, { group, position }) => [
      ...order.slice(0, position),
      group.id,
      ...order.slice(position),
    ]);
    const groupRemoved = connect({
      clock: actions.removeGroupAction,
      source: $order,
      filter: (order, groupId) => order.includes(groupId),
      fn: (_, groupId) => groupId,
    });
    connect({ clock: groupRemoved, target: groups.edit.remove });
    $order.on(groupRemoved, (order, groupId) => order.filter((id) => id !== groupId));
    // titles follow positions: only groups whose position changed get a new `ui`
    const groupsReindexed = connect({
      clock: $order,
      source: $groupsById,
      fn: (items, order) =>
        items.flatMap((group) => {
          const index = order.indexOf(group.id);
          const title = groupTitle(group.groupType, index);
          return index < 0 || (group.ui.index === index && group.ui.title === title)
            ? []
            : [{ id: group.id, ui: { index, title } }];
        }),
    });
    connect({
      clock: groupsReindexed,
      filter: (updates) => updates.length > 0,
      target: groups.edit.update,
    });

    // --- writes by path: routed by the shared rules; the products' writes in one keyed api call
    const routed = connect({
      clock: actions.writePathsAction,
      source: { groups: $groups, dealFields: $dealFields, settings: $settings },
      fn: ({ groups: items, dealFields, settings }, writes) =>
        routeWrites({ dealFields, settings, products: dealProducts(items) }, writes),
    });
    $dealFields.on(routed, (_, { dealFields }) => dealFields);
    // unchanged settings come back as the same object: no update
    $settings.on(routed, (_, { settings }) => settings);
    connect({
      clock: routed,
      filter: ({ products }) => products.size > 0,
      fn: ({ products }) => {
        const byGroup = new Map<string, ProductWrites[]>();
        for (const [productId, { groupId, writes }] of products) {
          if (!byGroup.has(groupId)) byGroup.set(groupId, []);
          byGroup.get(groupId)!.push({ productId, writes });
        }
        return { key: [...byGroup.keys()], data: [...byGroup.values()] };
      },
      target: groups.api.writeProducts,
    });

    // --- async options (e.g. Fixing Source): loaded for a new group, reloaded on change
    connect({
      clock: actions.loadDealOptionsAction,
      fn: () => dealOptionsRequests,
      target: loadAllOptionsEffect,
    });
    connect({
      clock: groupCreated,
      fn: ({ group }) => uniqueRequests(group.products.flatMap(({ data }) => optionsRequestsOf(data))),
      target: loadAllOptionsEffect,
    });
    connect({
      clock: routed,
      filter: ({ requests }) => requests.length > 0,
      fn: ({ requests }) => requests,
      target: loadAllOptionsEffect,
    });
    // options arrived, for any deal: every product still on that parameter
    // reconciles (stale responses: ignored). A deal on that parameter would
    // otherwise keep a value the server no longer offers.
    connect({
      clock: loadOptionsEffect.done,
      source: $order,
      filter: (order) => order.length > 0,
      fn: (order, { params, result }) => ({ key: order, data: order.map(() => ({ request: params, options: result })) }),
      target: groups.api.reconcileOptions,
    });

    // --- calc: whenever the deal is ready, with autocalc; any edit outdates the price
    const $calc = createStore<CalcState>(initialCalcState);
    const $isReady = combine(
      $hasValidationErrors,
      loadOptionsEffect.inFlight,
      loadAllOptionsEffect.inFlight,
      (hasErrors, loading, loadingAll) => isCalcReady(hasErrors, loading + loadingAll),
    );
    const $shouldAutocalc = combine(
      devtools.$isAutocalcEnabled,
      $isReady,
      $calc,
      (enabled, isReady, calc) => enabled && isReady && needsAutocalc(calc),
    );
    /**
     * One batch, one change. `@effector/model` applies a batch to the
     * collection one group at a time (each item updates on its own), so the
     * price follows the groups only once the batch has settled: an effect
     * runs after every pure update of its launch. The first to finish
     * outdates the price, once, and autocalc then sees the whole batch.
     */
    const settleFx = createEffect(() => {});
    connect({ clock: $groupsById, target: settleFx });
    connect({ clock: $shouldAutocalc, target: settleFx });
    const $unsettled = createStore(false).on($groupsById, () => true);
    const groupsSettled = connect({ clock: settleFx.finally, source: $unsettled, filter: Boolean });
    $unsettled.reset(groupsSettled);

    const calculateEffect = createEffect(({ products }: { requestId: number; products: ProductData[] }) =>
      calculatePrice(products),
    );
    $calc
      .on(groupsSettled, (calc) => calcInputsChanged(calc))
      .on(calculateEffect, (calc, { requestId }) => calcStarted(calc, requestId))
      .on(calculateEffect.done, (calc, { params, result }) => calcSucceeded(calc, params.requestId, result))
      .on(calculateEffect.fail, (calc, { params }) => calcFailed(calc, params.requestId));
    const calcRequest = ({ calc, items }: { calc: CalcState; items: GroupItem[] }) => ({
      requestId: calc.requestId + 1,
      products: productsOf(items).flatMap(({ data }) => (data ? [data] : [])),
    });
    connect({
      clock: actions.calculateAction,
      source: { calc: $calc, items: $groups, isReady: $isReady },
      filter: ({ isReady }) => isReady,
      fn: calcRequest,
      target: calculateEffect,
    });
    connect({
      clock: settleFx.finally,
      source: { calc: $calc, items: $groups, should: $shouldAutocalc },
      filter: ({ should }) => should,
      fn: calcRequest,
      target: calculateEffect,
    });

    // --- spot price: kept outside the stores, ticks never notify subscribers
    // (the watcher is in the region: `dispose` clears it)
    const spotPriceStream = createSpotPriceStream();
    devtools.$isSpotPriceStreamEnabled.watch((enabled) => (enabled ? spotPriceStream.start() : spotPriceStream.stop()));

    return {
      actions,
      /** The groups collection (`@effector/model`), for its lenses and api. */
      groups,
      // stores
      $order,
      $groups,
      $dealFields,
      $settings,
      $isInternal,
      $hedgeTypes,
      $hasValidationErrors,
      $calc,
      $isReady,
      // outside the stores
      spotPriceStream,
      /** Drops everything the deal is subscribed to (its units, their links to shared units) and stops its stream. */
      dispose: () => {
        clearNode(region);
        spotPriceStream.stop();
      },
    };
  });
};

export type DealStore = ReturnType<typeof createDealStore>;
