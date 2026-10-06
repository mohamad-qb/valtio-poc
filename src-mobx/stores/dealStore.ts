import { action, autorun, observable, observableRef } from "mobx";
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
import { type GroupType, groupTitle } from "@shared/groups.ts";
import {
  type SpotPriceStream,
  createSpotPriceStream,
} from "@shared/spotPriceStream.ts";
import { type GroupStore, createGroupStore } from "./groupStore.ts";
import { optionsStore } from "./optionsStore.ts";
import type { Product } from "./productStore.ts";

/** What a deal needs from the app-wide developer settings. */
type DealDevtools = {
  readonly isSpotPriceStreamEnabled: boolean;
  readonly isAutocalcEnabled: boolean;
};

export type DealStore = DealFieldsState & DealSettingsState & {
  groups: Record<string, GroupStore>;
  groupIds: string[]; // display order; each group's `ui.index` mirrors it
  /** Kept outside MobX: ticks never notify observers; the grid repaints just that cell. */
  readonly spotPriceStream: SpotPriceStream;
  readonly hedgeTypes: readonly string[];
  /** Every product of every group, in display order. */
  readonly products: Product[];
  readonly hasValidationErrors: boolean;
  calc: CalcState;
  /** No validation errors and no request pending: ready to calculate. */
  readonly isReady: boolean;
  /** A product and its group, by the product's id: an index, not a scan of the groups. */
  findProduct(productId: string): { groupId: string; product: Product } | undefined;
  addNewGroup(groupType: GroupType): void;
  cloneGroup(groupId: string): void;
  removeGroup(groupId: string): void;
  /** Writes values at dot paths, in order, as one action: an edit, a paste, anything. */
  writePaths(writes: readonly PathWrite[]): void;
  /** Options arrived (whichever deal asked): every product still on that parameter keeps a valid value. */
  reconcileOptions(request: OptionsRequest, options: readonly Option[]): void;
  /** Calculates now, if ready (the manual Calculate). */
  calculate(): void;
  /** A calculation's result (applied only for the latest request: see `calcSucceeded`). */
  setCalc(calc: CalcState): void;
  dispose(): void;
};

/**
 * Deal factory. Every write is a batch of dot paths, routed by the shared
 * rules and applied in one action, so every reaction (autocalc, the grid)
 * runs once, after the last write. Derived values (expiry days, validation)
 * are computeds: nothing to wire up, order, or dispose.
 */
export const createDealStore = (devtools: DealDevtools): DealStore => {
  const spotPriceStream = createSpotPriceStream();
  /** Each product's group, by product id: kept with the groups, so a lookup never scans them. */
  const groupOfProduct = new Map<string, string>();

  /** Re-derives every group's index and title from its position. */
  const reindexGroups = () => {
    deal.groupIds.forEach((groupId, index) => {
      const group = deal.groups[groupId];
      group.ui.index = index;
      group.ui.title = groupTitle(group.groupType, index);
    });
  };

  /**
   * Any change to the products outdates the price (and supersedes a
   * calculation in flight), in the action that made it: autocalc, which runs
   * after the action, never sees the change without it.
   */
  const inputsChanged = () => {
    deal.calc = calcInputsChanged(deal.calc);
  };

  /** Writes into live products' data, leaf by leaf, by the shared rules (derived fields are computeds). */
  const applyProductWrites = (writes: readonly (readonly [ProductData, readonly ProductWrite[]])[]) => {
    let changed = false;
    for (const [data, productWrites] of writes) {
      for (const change of planProductWrites(data, productWrites).changes) {
        changed = true;
        if ("remove" in change) deleteValueByPath(data, change.path);
        else if (!change.derived) setValueByPath(data, change.path, change.value);
      }
    }
    if (changed) inputsChanged();
  };

  /** What arrives reconciles every deal (`reconcileOptions`), this one included. */
  const loadOptions = (requests: readonly OptionsRequest[]) => {
    for (const { source, param } of requests) void optionsStore.load(source, param);
  };

  const insertGroup = (
    groupType: GroupType,
    position: number,
    source?: GroupStore,
  ) => {
    const group = createGroupStore(groupType, deal, source);
    // record first, so the id never appears in the order without its group
    deal.groups[group.id] = group;
    deal.groupIds.splice(position, 0, group.id);
    for (const productId of group.productIds) groupOfProduct.set(productId, group.id);
    reindexGroups();
    inputsChanged();
    loadOptions(uniqueRequests(group.productList.flatMap(({ data }) => optionsRequestsOf(data))));
  };

  const deal: DealStore = observable<DealStore>(
    {
      ...initialDealFields,
      groups: {},
      groupIds: [],
      ...initialDealSettings,
      spotPriceStream,
      get hedgeTypes() {
        return hedgeTypesFor(deal.isInternal);
      },
      get products() {
        return deal.groupIds.flatMap(
          (groupId) => deal.groups[groupId].productList,
        );
      },
      /** Reads every product's flag (no early exit), so every field's issues stay observed: cached. */
      get hasValidationErrors() {
        return deal.products.filter((product) => product.hasValidationErrors).length > 0;
      },
      calc: initialCalcState,
      get isReady() {
        return isCalcReady(deal.hasValidationErrors, optionsStore.pending);
      },
      findProduct(productId) {
        const groupId = groupOfProduct.get(productId);
        return groupId === undefined ? undefined : { groupId, product: deal.groups[groupId].products[productId] };
      },
      addNewGroup(groupType) {
        insertGroup(groupType, deal.groupIds.length);
      },
      /** Inserts a copy of the group (and its products) right after it. */
      cloneGroup(groupId) {
        const position = deal.groupIds.indexOf(groupId);
        if (position === -1) return;
        const source = deal.groups[groupId];
        insertGroup(source.groupType, position + 1, source);
      },
      /** Nothing to dispose: the group's computeds go with it. */
      removeGroup(groupId) {
        const position = deal.groupIds.indexOf(groupId);
        if (position === -1) return;
        // order first, so the id never appears without its group
        deal.groupIds.splice(position, 1);
        for (const productId of deal.groups[groupId].productIds) groupOfProduct.delete(productId);
        delete deal.groups[groupId];
        reindexGroups();
        inputsChanged();
      },
      writePaths(writes) {
        const products: DealProduct[] = deal.groupIds.flatMap((groupId) =>
          deal.groups[groupId].productList.map((product) => ({ groupId, productId: product.id, data: product.data })),
        );
        const { notionalCcy, premiumCcy, notionalAmount, isInternal, hedgeType } = deal;
        const routed = routeWrites(
          { dealFields: { notionalCcy, premiumCcy, notionalAmount }, settings: { isInternal, hedgeType }, products },
          writes,
        );
        // same-value writes don't notify: only what changed does
        Object.assign(deal, routed.dealFields, routed.settings);
        applyProductWrites(
          [...routed.products].map(
            ([productId, { groupId, writes: productWrites }]) =>
              [deal.groups[groupId].products[productId].data, productWrites] as const,
          ),
        );
        loadOptions(routed.requests);
      },
      reconcileOptions(request, options) {
        applyProductWrites(deal.products.map(({ data }) => [data, reconcileWrites(data, request, options)] as const));
      },
      calculate() {
        if (!deal.isReady) return;
        const requestId = deal.calc.requestId + 1;
        deal.calc = calcStarted(deal.calc, requestId);
        calculatePrice(deal.products.map((product) => product.data)).then(
          (price) => deal.setCalc(calcSucceeded(deal.calc, requestId, price)),
          () => deal.setCalc(calcFailed(deal.calc, requestId)),
        );
      },
      setCalc(calc) {
        deal.calc = calc;
      },
      dispose() {
        stopReconciling();
        stopSpotPriceStream();
        stopAutocalc();
        spotPriceStream.stop();
      },
    },
    // `calculate` is an action wherever it's called (autocalc calls it from an autorun)
    { spotPriceStream: false, findProduct: false, dispose: false, calc: observableRef, calculate: action },
    { autoBind: true, name: "Deal" },
  );

  // the lists are shared: whichever deal asked, this deal's products reconcile too
  const stopReconciling = optionsStore.onLoaded(deal.reconcileOptions);

  // the deal column's own options (its default parameters), loaded with the deal
  loadOptions(dealOptionsRequests);

  // autocalc: whenever the deal is ready and its price missing or outdated.
  // An autorun, not a reaction: a calculation can be superseded in the same
  // batch that started it, leaving the condition true → true, which a
  // reaction would not fire for. Readiness is read first, so validation stays
  // observed (cached) whatever the switch.
  const stopAutocalc = autorun(() => {
    if (deal.isReady && devtools.isAutocalcEnabled && needsAutocalc(deal.calc)) deal.calculate();
  });

  const stopSpotPriceStream = autorun(() =>
    devtools.isSpotPriceStreamEnabled
      ? spotPriceStream.start()
      : spotPriceStream.stop(),
  );

  return deal;
};
