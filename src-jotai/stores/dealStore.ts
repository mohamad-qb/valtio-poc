import {
  type Atom,
  type Getter,
  type PrimitiveAtom,
  type Setter,
  atom,
  getDefaultStore,
} from "jotai/vanilla";
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
import { type DealFieldsState, initialDealFields, syncedFieldIds } from "@shared/dealFields.ts";
import { type DealSettingsState, dealSettings, initialDealSettings } from "@shared/dealSettings.ts";
import { routeWrites } from "@shared/dealWrites.ts";
import { dealOptionsRequests } from "@shared/fields.ts";
import { type GroupType, groupTitle } from "@shared/groups.ts";
import type { Option } from "@shared/options/optionsSource.ts";
import type { PathWrite } from "@shared/paths.ts";
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
import { optionsStore } from "./optionsStore.ts";
import type { ProductStore } from "./productStore.ts";

const store = getDefaultStore();

/** What a deal needs from the app-wide developer settings. */
type DealDevtools = {
  isSpotPriceStreamEnabled: boolean;
  isAutocalcEnabled: boolean;
};

export type DealStore = {
  dealFieldsAtom: PrimitiveAtom<DealFieldsState>;
  settingsAtom: PrimitiveAtom<DealSettingsState>;
  groupsAtom: PrimitiveAtom<Record<string, GroupStore>>;
  groupIdsAtom: PrimitiveAtom<string[]>; // display order; each group's `ui.index` mirrors it
  spotPriceStream: SpotPriceStream;
  hasValidationErrorsAtom: Atom<boolean>;
  /** No validation errors and no request pending: ready to calculate. */
  isReadyAtom: Atom<boolean>;
  calcAtom: PrimitiveAtom<CalcState>;
  actions: {
    addNewGroup(groupType: GroupType): void;
    cloneGroup(groupId: string): void;
    removeGroup(groupId: string): void;
    /** Writes values at dot paths, in order: an edit, a paste, anything. */
    writePaths(writes: readonly PathWrite[]): void;
    /** Calculates now, if ready (the manual Calculate). */
    calculate(): void;
  };
  /** Unsubscribes the deal from the store and the options, and stops its stream. */
  dispose(): void;
};

/**
 * Deal factory: a plain object of atoms, in jotai's default store. Groups
 * and products hold atoms of their own (atoms in atoms), so a write sets
 * only what it changes. Every write is a batch of dot paths, routed by the
 * shared rules; product data is immutable, replaced with only the changed
 * path copied. Each action is a write atom: whatever it sets, listeners
 * (autocalc, the grid, components) run once, after the last set, with
 * derived atoms (validation, readiness) already recomputed.
 */
export const createDealStore = (devtoolsAtom: Atom<DealDevtools>): DealStore => {
  const spotPriceStream = createSpotPriceStream();

  /** Every product with where it lives, in display order. */
  const dealProducts = (get: Getter) =>
    get(dealStore.groupIdsAtom).flatMap((groupId) => {
      const group = get(dealStore.groupsAtom)[groupId];
      return group.productIds.map((productId) => {
        const product = group.products[productId];
        return { groupId, productId, product, data: get(product.dataAtom) };
      });
    });

  /** Replaces a product's data by the shared rules; whether it changed (nothing is set if not). */
  const applyProductWrites = (get: Getter, set: Setter, product: ProductStore, writes: readonly ProductWrite[]) => {
    const { data, changes } = planProductWrites(get(product.dataAtom), writes);
    if (changes.length) set(product.dataAtom, data);
    return changes.length > 0;
  };

  /** Options arrived (for any deal: the options store sets every deal's): each product still on that parameter reconciles. */
  const reconcileOptionsAtom = atom(null, (get, set, request: OptionsRequest, options: readonly Option[]) => {
    let changed = false;
    for (const { product, data } of dealProducts(get)) {
      if (applyProductWrites(get, set, product, reconcileWrites(data, request, options))) changed = true;
    }
    if (changed) set(dealStore.calcAtom, calcInputsChanged);
  });

  /**
   * Loads options; when they arrive, every deal's products reconcile in the
   * batch that stores them and ends the load. `set` is the calling action's:
   * the load is counted in that action's batch. So autocalc never sees the
   * edit without its load, or the load done without the products it changes.
   */
  const loadOptions = (set: Setter, requests: readonly OptionsRequest[]) => {
    for (const { source, param } of requests) void set(optionsStore.loadAtom, source, param);
  };

  /** Re-derives every group's index and title from its position. */
  const reindexGroups = (get: Getter, set: Setter) => {
    get(dealStore.groupIdsAtom).forEach((groupId, index) => {
      const group = get(dealStore.groupsAtom)[groupId];
      const title = groupTitle(group.groupType, index);
      // unmoved groups keep their ui: they don't notify
      if (get(group.uiAtom).title !== title) set(group.uiAtom, { title, index });
    });
  };

  const insertGroup = (get: Getter, set: Setter, groupType: GroupType, position: number, source?: GroupStore) => {
    const groupStore = createGroupStore(get, get(dealStore.dealFieldsAtom), groupType, source);
    set(dealStore.groupsAtom, (groups) => ({ ...groups, [groupStore.id]: groupStore }));
    set(dealStore.groupIdsAtom, (groupIds) => groupIds.toSpliced(position, 0, groupStore.id));
    reindexGroups(get, set);
    set(dealStore.calcAtom, calcInputsChanged); // new products outdate the price too
    const products = groupStore.productIds.map((productId) => get(groupStore.products[productId].dataAtom));
    loadOptions(set, uniqueRequests(products.flatMap(optionsRequestsOf)));
  };

  // the actions: one write atom each, so each is one batch
  const addNewGroupAtom = atom(null, (get, set, groupType: GroupType) => {
    insertGroup(get, set, groupType, get(dealStore.groupIdsAtom).length);
  });
  /** Inserts a copy of the group (and its products) right after it. */
  const cloneGroupAtom = atom(null, (get, set, groupId: string) => {
    const position = get(dealStore.groupIdsAtom).indexOf(groupId);
    if (position === -1) return;
    const source = get(dealStore.groupsAtom)[groupId];
    insertGroup(get, set, source.groupType, position + 1, source);
  });
  /** Nothing to dispose: once nothing reads the group's atoms, they go with it. */
  const removeGroupAtom = atom(null, (get, set, groupId: string) => {
    const position = get(dealStore.groupIdsAtom).indexOf(groupId);
    if (position === -1) return;
    set(dealStore.groupIdsAtom, (groupIds) => groupIds.toSpliced(position, 1));
    set(dealStore.groupsAtom, ({ [groupId]: _removed, ...groups }) => groups);
    reindexGroups(get, set);
    set(dealStore.calcAtom, calcInputsChanged); // so do removed ones
  });
  const writePathsAtom = atom(null, (get, set, writes: readonly PathWrite[]) => {
    const dealFields = get(dealStore.dealFieldsAtom);
    const settings = get(dealStore.settingsAtom);
    const routed = routeWrites({ dealFields, settings, products: dealProducts(get) }, writes);
    // the router can hand back new objects with the same values (a field
    // written back, any settings write): set only what changed
    if (syncedFieldIds.some((id) => !Object.is(routed.dealFields[id], dealFields[id]))) {
      set(dealStore.dealFieldsAtom, routed.dealFields);
    }
    if (dealSettings.some(({ id }) => !Object.is(routed.settings[id], settings[id]))) {
      set(dealStore.settingsAtom, routed.settings);
    }
    let changed = false;
    for (const [productId, { groupId, writes: productWrites }] of routed.products) {
      const product = get(dealStore.groupsAtom)[groupId].products[productId];
      if (applyProductWrites(get, set, product, productWrites)) changed = true;
    }
    // any product edit outdates the price (and supersedes a calculation in flight), once
    if (changed) set(dealStore.calcAtom, calcInputsChanged);
    loadOptions(set, routed.requests);
  });
  const calculateAtom = atom(null, (get, set) => {
    if (!get(dealStore.isReadyAtom)) return;
    const requestId = get(dealStore.calcAtom).requestId + 1;
    set(dealStore.calcAtom, (calc) => calcStarted(calc, requestId));
    calculatePrice(dealProducts(get).map(({ data }) => data)).then(
      (price) => set(dealStore.calcAtom, (calc) => calcSucceeded(calc, requestId, price)),
      () => set(dealStore.calcAtom, (calc) => calcFailed(calc, requestId)),
    );
  });

  // named for the devtools (`devtools.ts`), which report each action by its label
  addNewGroupAtom.debugLabel = "addNewGroup";
  cloneGroupAtom.debugLabel = "cloneGroup";
  removeGroupAtom.debugLabel = "removeGroup";
  writePathsAtom.debugLabel = "writePaths";
  calculateAtom.debugLabel = "calculate";

  const dealStore: DealStore = {
    dealFieldsAtom: atom(initialDealFields),
    settingsAtom: atom(initialDealSettings),
    groupsAtom: atom<Record<string, GroupStore>>({}),
    groupIdsAtom: atom<string[]>([]),
    spotPriceStream, // outside jotai: ticks never set an atom
    // the products' issues only: their data is read by the issues, not here
    hasValidationErrorsAtom: atom((get) => {
      const groups = get(dealStore.groupsAtom);
      return get(dealStore.groupIdsAtom).some((groupId) => {
        const { products, productIds } = groups[groupId];
        return productIds.some((productId) => Object.keys(get(products[productId].issuesAtom)).length > 0);
      });
    }),
    isReadyAtom: atom((get) => isCalcReady(get(dealStore.hasValidationErrorsAtom), get(optionsStore.pendingAtom))),
    calcAtom: atom(initialCalcState),
    actions: {
      addNewGroup: (groupType) => store.set(addNewGroupAtom, groupType),
      cloneGroup: (groupId) => store.set(cloneGroupAtom, groupId),
      removeGroup: (groupId) => store.set(removeGroupAtom, groupId),
      writePaths: (writes) => store.set(writePathsAtom, writes),
      calculate: () => store.set(calculateAtom),
    },
    dispose: () => {
      stops.forEach((stop) => stop());
      spotPriceStream.stop();
    },
  };

  const followSpotPriceStream = () =>
    store.get(devtoolsAtom).isSpotPriceStreamEnabled ? spotPriceStream.start() : spotPriceStream.stop();
  followSpotPriceStream();

  // the deal column's own options (its default parameters), loaded with the deal
  loadOptions(store.set, dealOptionsRequests);

  // autocalc: whenever the deal is ready and its price missing or outdated,
  // checked whenever one of those changes. Listeners run once a batch is
  // done, its derived atoms recomputed: an edit's validation counts by the
  // time this checks.
  const autocalc = () => {
    if (
      store.get(devtoolsAtom).isAutocalcEnabled &&
      store.get(dealStore.isReadyAtom) &&
      needsAutocalc(store.get(dealStore.calcAtom))
    ) {
      dealStore.actions.calculate();
    }
  };

  const stops = [
    optionsStore.onLoaded(reconcileOptionsAtom),
    store.sub(devtoolsAtom, followSpotPriceStream),
    store.sub(dealStore.calcAtom, autocalc),
    store.sub(dealStore.isReadyAtom, autocalc),
    store.sub(devtoolsAtom, autocalc),
  ];

  return dealStore;
};
