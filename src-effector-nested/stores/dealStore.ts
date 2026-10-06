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
import type { GroupType } from "@shared/groups.ts";
import { setIn } from "@shared/lib/path.ts";
import type { PathWrite } from "@shared/paths.ts";
import type { ProductData } from "@shared/products/productRegistry.ts";
import { optionsRequestsOf, reconcileWrites, uniqueRequests } from "@shared/products/productWrites.ts";
import { createSpotPriceStream } from "@shared/spotPriceStream.ts";
import {
  type GroupsState,
  addGroupReducer,
  cloneGroupReducer,
  groupCreatedReducer,
  groupRemovedReducer,
  mapProducts,
  productsOf,
} from "./groupStore.ts";
import { loadAllOptionsEffect, loadOptionsEffect } from "./optionsStore.ts";
import { validateProducts, withProductWrites } from "./productStore.ts";

/** What a deal needs from the app-wide developer settings. */
type DealDevtools = {
  $isSpotPriceStreamEnabled: Store<boolean>;
  $isAutocalcEnabled: Store<boolean>;
};

/** Every product with where it lives, in display order: what the write router needs. */
const dealProducts = (groups: GroupsState): DealProduct[] =>
  Object.values(groups).flatMap((group) =>
    Object.values(group.products).map((product) => ({ groupId: group.id, productId: product.id, data: product.data })),
  );

/**
 * One deal's model, with nested state: one `$groups` store holds the groups
 * by id, and each group holds its products by id — no id lists to keep in
 * step. Key order is display order. Every change is an event handled by
 * pure reducers that copy only the path to what changed, so an untouched
 * group or product keeps its identity and nothing bound to it re-renders.
 *
 * Every write is a batch of dot paths (`writePathsAction`), routed by the
 * shared rules and folded into one new `$groups`: each written product is
 * reached by its path (`<groupId>.products.<productId>`), which is the same
 * address as the path itself.
 *
 * Its units live in their own region: `dispose` clears them all, with their
 * links to the shared options effects.
 */
export const createDealStore = (devtools: DealDevtools) => {
  const region = createNode();
  return withRegion(region, () => {
    const actions = {
      // --- actions: the requests the UI (or anything else) can make
      addGroupAction: createEvent<GroupType>(),
      cloneGroupAction: createEvent<string>(),
      removeGroupAction: createEvent<string>(),
      /** Writes values at dot paths, in order, as one batch: an edit, a paste, anything. */
      writePathsAction: createEvent<readonly PathWrite[]>(),
      /** Calculates now, if the deal is ready (the manual Calculate). */
      calculateAction: createEvent(),
      /** Loads the deal column's own options (its default parameters): its tab does, when it opens the deal. */
      loadDealOptionsAction: createEvent(),
    };

    // --- state
    const $dealFields = createStore<DealFieldsState>(initialDealFields);
    const $groups = createStore<GroupsState>({});
    const $settings = createStore<DealSettingsState>(initialDealSettings);

    // --- derived
    const $isInternal = $settings.map((settings) => settings.isInternal);
    const $hedgeTypes = $isInternal.map(hedgeTypesFor);
    /** Issues per product, per field — only changed products are re-validated. */
    const $validation = $groups.map((groups) => validateProducts(productsOf(groups)));
    const $hasValidationErrors = $validation.map((validation) =>
      Object.values(validation).some((issues) => Object.keys(issues).length > 0),
    );

    // --- groups: build (new ids) from the current deal values, then insert
    const groupCreated = merge([
      connect({
        clock: actions.addGroupAction,
        source: { defaults: $dealFields, groups: $groups },
        fn: addGroupReducer,
      }),
      connect({
        clock: actions.cloneGroupAction,
        source: { defaults: $dealFields, groups: $groups },
        filter: ({ groups }, groupId) => groupId in groups,
        fn: cloneGroupReducer,
      }),
    ]);
    $groups.on(groupCreated, groupCreatedReducer);
    // nothing to dispose: the group's products, and their issues, go with it
    $groups.on(actions.removeGroupAction, groupRemovedReducer);

    // --- writes by path: routed by the shared rules, folded into one new `$groups`
    const routed = connect({
      clock: actions.writePathsAction,
      source: { groups: $groups, dealFields: $dealFields, settings: $settings },
      fn: ({ groups, dealFields, settings }, writes) =>
        routeWrites({ dealFields, settings, products: dealProducts(groups) }, writes),
    });
    $dealFields.on(routed, (_, { dealFields }) => dealFields);
    // unchanged settings come back as the same object: no update
    $settings.on(routed, (_, { settings }) => settings);
    $groups.on(routed, (groups, { products }) => {
      let next = groups;
      for (const [productId, { groupId, writes }] of products) {
        const product = next[groupId].products[productId];
        // copies only the path to the product: the groups, its group, its products
        next = setIn(next, `${groupId}.products.${productId}`, withProductWrites(product, writes));
      }
      return next;
    });

    // --- async options (e.g. Fixing Source): loaded for a new group, reloaded on change
    connect({
      clock: actions.loadDealOptionsAction,
      fn: () => dealOptionsRequests,
      target: loadAllOptionsEffect,
    });
    connect({
      clock: groupCreated,
      fn: ({ group }) => uniqueRequests(Object.values(group.products).flatMap(({ data }) => optionsRequestsOf(data))),
      target: loadAllOptionsEffect,
    });
    connect({
      clock: routed,
      filter: ({ requests }) => requests.length > 0,
      fn: ({ requests }) => requests,
      target: loadAllOptionsEffect,
    });
    // options arrived, for any deal: products still on that parameter keep
    // their value if it's an option, else take the first (stale responses:
    // ignored). A deal on that parameter would otherwise keep a value the
    // server no longer offers.
    $groups.on(loadOptionsEffect.done, (groups, { params, result }) =>
      mapProducts(groups, (product) => withProductWrites(product, reconcileWrites(product.data, params, result))),
    );

    // --- calc: whenever the deal is ready, with autocalc; any edit outdates the price
    const $calc = createStore<CalcState>(initialCalcState);
    const $isReady = combine(
      $hasValidationErrors,
      loadOptionsEffect.inFlight,
      loadAllOptionsEffect.inFlight,
      (hasErrors, loading, loadingAll) => isCalcReady(hasErrors, loading + loadingAll),
    );
    const calculateEffect = createEffect(({ products }: { requestId: number; products: ProductData[] }) =>
      calculatePrice(products),
    );
    $calc
      .on($groups, (calc) => calcInputsChanged(calc))
      .on(calculateEffect, (calc, { requestId }) => calcStarted(calc, requestId))
      .on(calculateEffect.done, (calc, { params, result }) => calcSucceeded(calc, params.requestId, result))
      .on(calculateEffect.fail, (calc, { params }) => calcFailed(calc, params.requestId));

    const calcRequest = ({ calc, groups }: { calc: CalcState; groups: GroupsState }) => ({
      requestId: calc.requestId + 1,
      products: productsOf(groups).map((product) => product.data),
    });
    connect({
      clock: actions.calculateAction,
      source: { calc: $calc, groups: $groups, isReady: $isReady },
      filter: ({ isReady }) => isReady,
      fn: calcRequest,
      target: calculateEffect,
    });
    const $shouldAutocalc = combine(
      devtools.$isAutocalcEnabled,
      $isReady,
      $calc,
      (enabled, isReady, calc) => enabled && isReady && needsAutocalc(calc),
    );
    connect({
      clock: $shouldAutocalc,
      source: { calc: $calc, groups: $groups, should: $shouldAutocalc },
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
      // stores
      $dealFields,
      $groups,
      $settings,
      $isInternal,
      $hedgeTypes,
      $validation,
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
