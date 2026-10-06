import { proxy, ref, subscribe } from "valtio";
import { subscribeKey } from "valtio/utils";
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
import { type DealSettingsState, initialDealSettings } from "@shared/dealSettings.ts";
import { type DealProduct, routeWrites } from "@shared/dealWrites.ts";
import { dealOptionsRequests } from "@shared/fields.ts";
import { type GroupType, groupTitle } from "@shared/groups.ts";
import { deleteValueByPath, setValueByPath } from "@shared/lib/path.ts";
import type { Option } from "@shared/options/optionsSource.ts";
import type { PathWrite } from "@shared/paths.ts";
import type { ProductData } from "@shared/products/productRegistry.ts";
import {
  type OptionsRequest,
  type ProductWrite,
  optionsRequestsOf,
  planProductWrites,
  reconcileWrites,
  uniqueRequests,
} from "@shared/products/productWrites.ts";
import { type SpotPriceStream, createSpotPriceStream } from "@shared/spotPriceStream.ts";
import { type GroupStore, createGroupStore } from "./groupStore.ts";
import { multiTabStore } from "./multiTabStore.ts";
import { optionsStore } from "./optionsStore.ts";
import { hasValidationErrors } from "./validation.ts";

export type DealStore = DealFieldsState &
  DealSettingsState & {
    groups: Record<string, GroupStore>;
    groupIds: string[]; // display order; each group's `ui.index` mirrors it
    spotPriceStream: SpotPriceStream;
    /** Whether any product has issues: derived from the data (`validation.ts`), not state. */
    readonly hasValidationErrors: boolean;
    /** No validation errors and no request pending: ready to calculate. */
    readonly isReady: boolean;
    calc: CalcState;
    actions: {
      addNewGroup(groupType: GroupType): void;
      cloneGroup(groupId: string): void;
      removeGroup(groupId: string): void;
      /** Writes values at dot paths, in order: an edit, a paste, anything. */
      writePaths(writes: readonly PathWrite[]): void;
      /** Calculates now, if ready (the manual Calculate). */
      calculate(): void;
      /** Drops everything the deal subscribed to, and stops its stream. */
      dispose(): void;
    };
  };

/**
 * Deal factory. Every write is a batch of dot paths, routed by the shared
 * rules and applied as plain proxy assignments, leaf by leaf; valtio has no
 * transactions, but subscribers (the grid, autocalc) are notified a tick
 * later, so they see the whole batch, and the price it outdated.
 */
export const createDealStore = (): DealStore => {
  const spotPriceStream = createSpotPriceStream();
  const { devtools } = multiTabStore;

  /** Every product with where it lives, in display order. */
  const dealProducts = (): DealProduct[] =>
    dealStore.groupIds.flatMap((groupId) => {
      const group = dealStore.groups[groupId];
      return group.productIds.map((productId) => ({ groupId, productId, data: group.products[productId].data }));
    });

  /** Writes into a live product's data, leaf by leaf, by the shared rules; whether anything changed. */
  const applyProductWrites = (data: ProductData, writes: readonly ProductWrite[]) => {
    const { changes } = planProductWrites(data, writes);
    for (const change of changes) {
      if ("remove" in change) deleteValueByPath(data, change.path);
      else setValueByPath(data, change.path, change.value);
    }
    return changes.length > 0;
  };

  /** Any product change (an edit, a group added or removed) outdates the price and supersedes a calculation in flight: once per action. */
  const inputsChanged = () => {
    dealStore.calc = calcInputsChanged(dealStore.calc);
  };

  /** Options arrived (for any deal: the options store calls every deal): each product still on that parameter reconciles. */
  const reconcileOptions = (request: OptionsRequest, options: readonly Option[]) => {
    let changed = false;
    for (const { data } of dealProducts()) {
      if (applyProductWrites(data, reconcileWrites(data, request, options))) changed = true;
    }
    if (changed) inputsChanged();
  };

  const loadOptions = (requests: readonly OptionsRequest[]) => {
    for (const { source, param } of requests) void optionsStore.actions.load(source, param);
  };

  /** Re-derives the index and title of every group from `from` on (the ones before it haven't moved). */
  const reindexGroups = (from: number) => {
    for (let index = from; index < dealStore.groupIds.length; index++) {
      const group = dealStore.groups[dealStore.groupIds[index]];
      // same-value writes are ignored, so unmoved groups don't notify
      group.ui.index = index;
      group.ui.title = groupTitle(group.groupType, index);
    }
  };

  const insertGroup = (groupType: GroupType, position: number, source?: GroupStore) => {
    const groupStore = createGroupStore(dealStore, groupType, source);
    // record first, so the id never appears in the order without its group
    dealStore.groups[groupStore.id] = groupStore;
    dealStore.groupIds.splice(position, 0, groupStore.id);
    reindexGroups(position);
    inputsChanged();
    const products = groupStore.productIds.map((productId) => groupStore.products[productId].data);
    loadOptions(uniqueRequests(products.flatMap(optionsRequestsOf)));
  };

  const dealStore: DealStore = proxy<DealStore>({
    ...initialDealFields,
    groups: {},
    groupIds: [],
    ...initialDealSettings,
    spotPriceStream: ref(spotPriceStream), // ref(): ticks never notify the deal proxy
    get hasValidationErrors() {
      return hasValidationErrors(dealStore);
    },
    get isReady() {
      return isCalcReady(dealStore.hasValidationErrors, optionsStore.pending);
    },
    calc: initialCalcState,
    actions: {
      addNewGroup(groupType: GroupType) {
        insertGroup(groupType, dealStore.groupIds.length);
      },
      /** Inserts a copy of the group (and its products) right after it. */
      cloneGroup(groupId: string) {
        const position = dealStore.groupIds.indexOf(groupId);
        if (position === -1) return;
        const source = dealStore.groups[groupId];
        insertGroup(source.groupType, position + 1, source);
      },
      /** Nothing to dispose: the group's issues go with its data. */
      removeGroup(groupId: string) {
        const position = dealStore.groupIds.indexOf(groupId);
        if (position === -1) return;
        // order first, so the id never appears without its group
        dealStore.groupIds.splice(position, 1);
        delete dealStore.groups[groupId];
        reindexGroups(position);
        inputsChanged();
      },
      writePaths(writes: readonly PathWrite[]) {
        const { notionalCcy, premiumCcy, notionalAmount, isInternal, hedgeType } = dealStore;
        const routed = routeWrites(
          {
            dealFields: { notionalCcy, premiumCcy, notionalAmount },
            settings: { isInternal, hedgeType },
            products: dealProducts(),
          },
          writes,
        );
        // same-value writes are ignored: only what changed notifies
        Object.assign(dealStore, routed.dealFields, routed.settings);
        let changed = false;
        for (const [productId, { groupId, writes: productWrites }] of routed.products) {
          if (applyProductWrites(dealStore.groups[groupId].products[productId].data, productWrites)) changed = true;
        }
        if (changed) inputsChanged();
        loadOptions(routed.requests);
      },
      calculate() {
        if (!dealStore.isReady) return;
        const requestId = dealStore.calc.requestId + 1;
        dealStore.calc = calcStarted(dealStore.calc, requestId);
        calculatePrice(dealProducts().map(({ data }) => data)).then(
          (price) => (dealStore.calc = calcSucceeded(dealStore.calc, requestId, price)),
          () => (dealStore.calc = calcFailed(dealStore.calc, requestId)),
        );
      },
      dispose() {
        stops.forEach((stop) => stop());
        spotPriceStream.stop();
      },
    },
  });

  const followSpotPriceStream = () => (devtools.isSpotPriceStreamEnabled ? spotPriceStream.start() : spotPriceStream.stop());
  followSpotPriceStream();

  // autocalc: whenever the deal is ready and its price missing or outdated.
  // Notified a tick after a write, once the whole batch has landed; readiness
  // is derived from the data, so it is never behind it
  const autocalc = () => {
    if (devtools.isAutocalcEnabled && dealStore.isReady && needsAutocalc(dealStore.calc)) {
      dealStore.actions.calculate();
    }
  };

  const stops = [
    subscribeKey(devtools, "isSpotPriceStreamEnabled", followSpotPriceStream),
    optionsStore.actions.onLoaded(reconcileOptions),
    subscribeKey(dealStore, "calc", autocalc),
    subscribe(dealStore.groups, autocalc),
    subscribeKey(optionsStore, "pending", autocalc),
    subscribeKey(devtools, "isAutocalcEnabled", autocalc),
  ];

  // the deal column's own options (its default parameters), loaded with the deal
  loadOptions(dealOptionsRequests);

  return dealStore;
};
