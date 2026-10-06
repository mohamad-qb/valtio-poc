import { type StoreApi, createStore } from "zustand/vanilla";
import { devtools } from "zustand/middleware";
import { calculatePrice } from "@shared/api/calculate.ts";
import {
  type CalcState,
  calcFailed,
  calcInputsChanged,
  calcStarted,
  calcSucceeded,
  initialCalcState,
  needsAutocalc,
} from "@shared/calc.ts";
import { type DealFieldsState, initialDealFields } from "@shared/dealFields.ts";
import { type DealSettingsState, initialDealSettings } from "@shared/dealSettings.ts";
import { type DealProduct, routeWrites } from "@shared/dealWrites.ts";
import { dealOptionsRequests } from "@shared/fields.ts";
import { type GroupType, groupTitle } from "@shared/groups.ts";
import { setIn } from "@shared/lib/path.ts";
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
import type { DevToolsState, DevToolsStore } from "./multiTabStore.ts";
import { optionsStore } from "./optionsStore.ts";
import { selectIsReady } from "./validation.ts";

export type DealState = DealFieldsState &
  DealSettingsState & {
    groups: Record<string, GroupStore>;
    groupIds: string[]; // display order; each group's `ui.index` mirrors it
    /** Kept as is: ticks never call `set`, so they never notify the store. */
    spotPriceStream: SpotPriceStream;
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

export type DealStore = StoreApi<DealState>;

/** Whether every value in `next` is already the state's: nothing to set. */
const isUnchanged = (state: DealState, next: Partial<DealState>) =>
  (Object.keys(next) as (keyof DealState)[]).every((key) => Object.is(state[key], next[key]));

// deals are numbered in the order they're made, like their tabs (none is
// ever removed): each is its own instance in the Redux DevTools
let dealCount = 0;

/**
 * Deal factory: one zustand store per deal, its state plain, immutable data.
 * Every write is a batch of dot paths, routed by the shared rules and applied
 * in one `set`, so every listener (autocalc, the grid) is notified once, with
 * the whole batch. Writes copy only the path to what changed; derived values
 * (validation, readiness) are selectors over the data (`validation.ts`).
 */
export const createDealStore = (devtoolsStore: DevToolsStore): DealStore => {
  const spotPriceStream = createSpotPriceStream();
  dealCount += 1;

  /** Every product with where it lives, in display order. */
  const dealProducts = (): DealProduct[] => {
    const { groupIds, groups } = dealStore.getState();
    return groupIds.flatMap((groupId) => {
      const group = groups[groupId];
      return group.productIds.map((productId) => ({ groupId, productId, data: group.products[productId].data }));
    });
  };

  /**
   * `groups` with one product's writes applied by the shared rules, which copy
   * only the path to what changed; nothing changed: the same object.
   */
  const applyProductWrites = (
    groups: Record<string, GroupStore>,
    groupId: string,
    productId: string,
    writes: readonly ProductWrite[],
  ) =>
    setIn(
      groups,
      `${groupId}.products.${productId}.data`,
      planProductWrites(groups[groupId].products[productId].data, writes).data,
    );

  /**
   * New groups, and so a new price: any product change (an edit, a group
   * added or removed) outdates it and supersedes a calculation in flight, in
   * the same `set`.
   */
  const groupsChanged = (groups: Record<string, GroupStore>): Pick<DealState, "groups" | "calc"> => ({
    groups,
    calc: calcInputsChanged(dealStore.getState().calc),
  });

  /**
   * Options arrived (for any deal: the options store calls every deal, before
   * the load counts as done): each product still on that parameter reconciles.
   */
  const reconcileOptions = (request: OptionsRequest, options: readonly Option[]) => {
    const { groups } = dealStore.getState();
    let next = groups;
    for (const { groupId, productId, data } of dealProducts()) {
      next = applyProductWrites(next, groupId, productId, reconcileWrites(data, request, options));
    }
    if (next !== groups) dealStore.setState(groupsChanged(next), false, "reconcileOptions");
  };

  const loadOptions = (requests: readonly OptionsRequest[]) => {
    for (const { source, param } of requests) void optionsStore.getState().actions.load(source, param);
  };

  /**
   * Every group's index and title, from its position in `groupIds`: a group
   * not in it is left out, and one that hasn't moved keeps its object.
   */
  const reindexGroups = (groups: Record<string, GroupStore>, groupIds: readonly string[]) =>
    Object.fromEntries(
      groupIds.map((groupId, index) => {
        const group = groups[groupId];
        const title = groupTitle(group.groupType, index);
        return [groupId, group.ui.title === title ? group : { ...group, ui: { title, index } }];
      }),
    );

  const insertGroup = (groupType: GroupType, position: number, source?: GroupStore) => {
    const state = dealStore.getState();
    const groupStore = createGroupStore(state, groupType, source);
    const products = groupStore.productIds.map((productId) => groupStore.products[productId].data);
    // options first: counted pending before the deal is notified, so autocalc waits for them
    loadOptions(uniqueRequests(products.flatMap(optionsRequestsOf)));
    const nextIds = state.groupIds.toSpliced(position, 0, groupStore.id);
    dealStore.setState(
      { groupIds: nextIds, ...groupsChanged(reindexGroups({ ...state.groups, [groupStore.id]: groupStore }, nextIds)) },
      false,
      source ? "cloneGroup" : "addNewGroup",
    );
  };

  const dealStore = createStore<DealState>()(
    devtools(
      (set, get) => ({
        ...initialDealFields,
        groups: {},
        groupIds: [],
        ...initialDealSettings,
        spotPriceStream,
        calc: initialCalcState,
        actions: {
          addNewGroup(groupType: GroupType) {
            insertGroup(groupType, get().groupIds.length);
          },
          /** Inserts a copy of the group (and its products) right after it. */
          cloneGroup(groupId: string) {
            const { groupIds, groups } = get();
            const position = groupIds.indexOf(groupId);
            if (position === -1) return;
            const source = groups[groupId];
            insertGroup(source.groupType, position + 1, source);
          },
          /** Nothing to dispose: the group and its products are only data. */
          removeGroup(groupId: string) {
            const { groupIds, groups } = get();
            const position = groupIds.indexOf(groupId);
            if (position === -1) return;
            const nextIds = groupIds.toSpliced(position, 1);
            set({ groupIds: nextIds, ...groupsChanged(reindexGroups(groups, nextIds)) }, false, "removeGroup");
          },
          writePaths(writes: readonly PathWrite[]) {
            const state = get();
            const { notionalCcy, premiumCcy, notionalAmount, isInternal, hedgeType } = state;
            const routed = routeWrites(
              {
                dealFields: { notionalCcy, premiumCcy, notionalAmount },
                settings: { isInternal, hedgeType },
                products: dealProducts(),
              },
              writes,
            );
            let { groups } = state;
            for (const [productId, { groupId, writes: productWrites }] of routed.products) {
              groups = applyProductWrites(groups, groupId, productId, productWrites);
            }
            // options first: counted pending before the deal is notified, so autocalc waits for them
            loadOptions(routed.requests);
            const next = { ...routed.dealFields, ...routed.settings, groups };
            // the whole batch in one `set`: one notification, and none when nothing changed
            if (isUnchanged(state, next)) return;
            set(groups === state.groups ? next : { ...next, ...groupsChanged(groups) }, false, "writePaths");
          },
          calculate() {
            const state = get();
            if (!selectIsReady(state, optionsStore.getState().pending)) return;
            const requestId = state.calc.requestId + 1;
            // a superseded request's response leaves `calc` as it is: no `set`, nobody notified
            const settle = (calc: CalcState, action: string) => {
              if (calc !== get().calc) set({ calc }, false, action);
            };
            // sent before anyone hears it started: a listener that throws then can't
            // leave the deal "calculating" with nothing in flight
            calculatePrice(dealProducts().map(({ data }) => data)).then(
              (price) => settle(calcSucceeded(get().calc, requestId, price), "calculated"),
              () => settle(calcFailed(get().calc, requestId), "calculationFailed"),
            );
            set({ calc: calcStarted(state.calc, requestId) }, false, "calculate");
          },
          dispose() {
            stops.forEach((stop) => stop());
            spotPriceStream.stop();
            dealStore.devtools?.cleanup(); // the extension's connection holds the store
          },
        },
      }),
      {
        name: `Deal ${dealCount} (Zustand)`,
        enabled: import.meta.env.DEV,
        // time travel sets the state back from its JSON: leave out what isn't
        // data (the actions, the stream), so a jump keeps the live ones, and the
        // calculation, so a jump never leaves it "calculating" with nothing in
        // flight, or starts a request. The middleware takes no reviver: an
        // empty number (NaN) comes back `null`
        serialize: {
          replacer: (key: string, value: unknown) =>
            key === "actions" || key === "spotPriceStream" || key === "calc" ? undefined : value,
        },
      },
    ),
  );

  const followSpotPriceStream = ({ isSpotPriceStreamEnabled }: DevToolsState) => {
    if (isSpotPriceStreamEnabled) {
      spotPriceStream.start();
    } else {
      spotPriceStream.stop();
    }
  };
  followSpotPriceStream(devtoolsStore.getState());

  // autocalc: whenever the deal is ready and its price missing or outdated.
  // Listeners run right after each `set`, and validation is a selector over
  // the data, so this always checks a whole batch, never part of one
  const autocalc = () => {
    const state = dealStore.getState();
    if (
      devtoolsStore.getState().isAutocalcEnabled &&
      needsAutocalc(state.calc) &&
      selectIsReady(state, optionsStore.getState().pending)
    ) {
      state.actions.calculate();
    }
  };
  const stops = [
    devtoolsStore.subscribe(followSpotPriceStream),
    optionsStore.getState().actions.onLoaded(reconcileOptions),
    dealStore.subscribe(autocalc),
    optionsStore.subscribe(autocalc),
    devtoolsStore.subscribe(autocalc),
  ];

  // the deal column's own options (its default parameters), loaded with the deal
  loadOptions(dealOptionsRequests);

  return dealStore;
};
