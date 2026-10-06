import {
  type Observable,
  type ObservableParam,
  batch,
  computed,
  internal,
  observable,
  observe,
} from "@legendapp/state";
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
import {
  type DealSettingsState,
  initialDealSettings,
} from "@shared/dealSettings.ts";
import { type DealProduct, routeWrites } from "@shared/dealWrites.ts";
import { dealOptionsRequests } from "@shared/fields.ts";
import { type GroupType, groupDefinitions, productUi } from "@shared/groups.ts";
import { uuid } from "@shared/lib/uuid.ts";
import type { Option } from "@shared/options/optionsSource.ts";
import type { PathWrite } from "@shared/paths.ts";
import {
  type ProductData,
  type ProductUi,
  definitionOf,
  productTypeOf,
} from "@shared/products/productRegistry.ts";
import {
  type OptionsRequest,
  type ProductWrite,
  optionsRequestsOf,
  planProductWrites,
  reconcileWrites,
  uniqueRequests,
} from "@shared/products/productWrites.ts";
import {
  type SpotPriceStream,
  createSpotPriceStream,
} from "@shared/spotPriceStream.ts";
import { type FieldIssues, productIssues } from "@shared/validation.ts";
import { isolated } from "./listeners.ts";
import { loadOptions, onOptionsLoaded, options$ } from "./optionsStore.ts";

/**
 * A deal's state: plain data only, so `peek()` is the deal as JSON. Group
 * titles aren't kept: they follow from `groupIds` (see `pathDeal.ts`).
 * Legend-State writes into this data in place: never share an object of it.
 */
export type ProductState = { id: string; ui: ProductUi; data: ProductData };
export type GroupState = {
  id: string;
  groupType: GroupType;
  productIds: string[]; // display order
  products: Record<string, ProductState>;
};
export type DealState = {
  dealFields: DealFieldsState;
  settings: DealSettingsState;
  groupIds: string[]; // display order
  groups: Record<string, GroupState>;
  calc: CalcState;
};

/** A new deal's state, with its own copies of the shared defaults. */
export const initialDealState = (): DealState => ({
  dealFields: { ...initialDealFields },
  settings: { ...initialDealSettings },
  groupIds: [],
  groups: {},
  calc: { ...initialCalcState },
});

/** What a deal needs from the app-wide developer settings. */
export type DealDevtools = Observable<{
  isSpotPriceStreamEnabled: boolean;
  isAutocalcEnabled: boolean;
}>;

export type DealStore = {
  readonly deal$: Observable<DealState>;
  /** Kept outside Legend-State: ticks never notify observers; the grid repaints just that cell. */
  readonly spotPriceStream: SpotPriceStream;
  readonly hasValidationErrors$: Observable<boolean>;
  /** No validation errors and no request pending: ready to calculate. */
  readonly isReady$: Observable<boolean>;
  /** A product's issues, per field (fields without any left out), from its data. */
  issuesOf(productId: string, data: ProductData): FieldIssues;
  addNewGroup(groupType: GroupType): void;
  cloneGroup(groupId: string): void;
  removeGroup(groupId: string): void;
  /** Writes values at dot paths, in order, as one batch: an edit, a paste, anything. */
  writePaths(writes: readonly PathWrite[]): void;
  /** Calculates now, if ready (the manual Calculate). */
  calculate(): void;
  /** Drops everything the deal subscribed to, and stops its stream. */
  dispose(): void;
};

/** The observable at a dot path under `root$` (it needn't exist yet). */
const nodeAt = (root$: ObservableParam, path: string): ObservableParam =>
  path
    .split(".")
    .reduce(
      (node$, key) =>
        (node$ as unknown as Record<string, ObservableParam>)[key],
      root$,
    );

/**
 * Deal factory, over a deal's observable state (its own, unless given one:
 * the tabs keep every deal in one tree). Every write is a batch of dot paths,
 * routed by the shared rules and set leaf by leaf in one `batch`, with the
 * price it outdates, so every listener (autocalc, the grid) runs once, after
 * the last write, and only for the leaves that changed.
 */
export const createDealStore = (
  devtools$: DealDevtools,
  deal$: Observable<DealState> = observable<DealState>(initialDealState()),
): DealStore => {
  const spotPriceStream = createSpotPriceStream();

  /**
   * Each product's issues, from its plain data, kept until the data changes.
   * Legend-State writes in place (no new object to key a cache by), and every
   * write goes through `applyProductWrites`, which drops the entry. Nothing
   * reactive per product: Legend-State never prunes a deleted key's nodes,
   * so whatever listened on a removed product's leaves stayed for good.
   */
  const issues = new Map<string, FieldIssues>();
  const issuesOf = (productId: string, data: ProductData) => {
    let found = issues.get(productId);
    if (!found) {
      found = productIssues(definitionOf(productTypeOf(data)), data);
      issues.set(productId, found);
    }
    return found;
  };

  const productsOf = (state: DealState): DealProduct[] =>
    state.groupIds.flatMap((groupId) => {
      const group = state.groups[groupId];
      return group.productIds.map((productId) => ({
        groupId,
        productId,
        data: group.products[productId].data,
      }));
    });
  const data$Of = (groupId: string, productId: string) =>
    deal$.groups[groupId].products[productId].data;

  /** Sets a product's changed leaves, by the shared rules (derived fields are kept as data); whether any changed. */
  const applyProductWrites = (
    groupId: string,
    productId: string,
    writes: readonly ProductWrite[],
  ) => {
    const data$ = data$Of(groupId, productId);
    const { changes } = planProductWrites(data$.peek(), writes);
    if (changes.length) issues.delete(productId); // validated again when next read
    for (const change of changes) {
      const leaf$ = nodeAt(data$, change.path);
      if ("remove" in change) leaf$.delete();
      else leaf$.set(change.value);
    }
    return changes.length > 0;
  };

  // the calculation is replaced, never written into: unchanged comes back as the same object
  const setCalc = (next: CalcState) => {
    if (next !== deal$.calc.peek()) deal$.calc.set(next);
  };

  /** Any product change outdates the price and supersedes a calculation in flight, in the batch that made it. */
  const inputsChanged = () => setCalc(calcInputsChanged(deal$.calc.peek()));

  /** Options arrived (for any deal: the options store calls every deal, in its batch): each product still on that parameter reconciles. */
  const reconcileOptions = (request: OptionsRequest, options: readonly Option[]) => {
    let changed = false;
    for (const { groupId, productId, data } of productsOf(deal$.peek())) {
      if (applyProductWrites(groupId, productId, reconcileWrites(data, request, options))) changed = true;
    }
    if (changed) inputsChanged();
  };

  /** Loads options. Call it inside the batch that needs them: the pending count goes up before any listener sees the batch (no early autocalc). */
  const requestOptions = (requests: readonly OptionsRequest[]) => {
    for (const { source, param } of requests) void loadOptions(source, param);
  };

  /** `source`: a group to clone, each product seeded with a copy of the one at its position. */
  const insertGroup = (
    groupType: GroupType,
    position: number,
    source?: GroupState,
  ) => {
    const { dealFields } = deal$.peek();
    const group: GroupState = {
      id: uuid(),
      groupType,
      productIds: [],
      products: {},
    };
    groupDefinitions[groupType].productTypes.forEach((productType, index) => {
      const sourceData = source?.products[source.productIds[index]].data;
      const product: ProductState = {
        id: uuid(),
        ui: productUi(productType, index),
        // a plain deep copy: the clone never shares an object with its source
        data: sourceData
          ? structuredClone(sourceData)
          : definitionOf(productType).createData(dealFields),
      };
      group.products[product.id] = product;
      group.productIds.push(product.id);
    });
    batch(() => {
      // record first, so the id never appears in the order without its group
      deal$.groups[group.id].set(group);
      deal$.groupIds.set((ids) => ids.toSpliced(position, 0, group.id));
      inputsChanged(); // new products outdate the price too
      requestOptions(
        uniqueRequests(
          group.productIds.flatMap((id) =>
            optionsRequestsOf(group.products[id].data),
          ),
        ),
      );
    });
  };

  // the products' data, tracked through the groups (one listener): each re-checked from the cache
  const hasValidationErrors$ = computed(() => {
    const groups = deal$.groups.get();
    return deal$.groupIds.get().some((groupId) => {
      const { productIds, products } = groups[groupId];
      return productIds.some(
        (productId) => Object.keys(issuesOf(productId, products[productId].data)).length > 0,
      );
    });
  });
  // the shared count, mirrored into the deal by a listener `dispose` stops: a
  // computed over `options$` itself would stay subscribed to it for good
  const pending$ = observable(options$.pending.peek());
  const isReady$ = computed(() =>
    isCalcReady(hasValidationErrors$.get(), pending$.get()),
  );

  const store: DealStore = {
    deal$,
    spotPriceStream,
    hasValidationErrors$,
    isReady$,
    issuesOf,
    addNewGroup: (groupType) =>
      insertGroup(groupType, deal$.groupIds.peek().length),
    /** Inserts a copy of the group (and its products) right after it. */
    cloneGroup: (groupId) => {
      const position = deal$.groupIds.peek().indexOf(groupId);
      if (position === -1) return;
      const source = deal$.groups[groupId].peek();
      insertGroup(source.groupType, position + 1, source);
    },
    removeGroup: (groupId) => {
      const group = deal$.groups[groupId].peek();
      if (!group) return;
      batch(() => {
        // order first, so the id never appears without its group
        deal$.groupIds.set((ids) => ids.filter((id) => id !== groupId));
        deal$.groups[groupId].delete();
        inputsChanged(); // so do removed ones
      });
      for (const productId of group.productIds) issues.delete(productId);
      // Legend-State keeps a deleted key's nodes (its leaves written, its
      // listeners): drop them, or every removed group stays in memory
      internal.getNode(deal$.groups).children?.delete(groupId);
    },
    writePaths: (writes) => {
      const state = deal$.peek();
      const routed = routeWrites(
        {
          dealFields: state.dealFields,
          settings: state.settings,
          products: productsOf(state),
        },
        writes,
      );
      batch(() => {
        // the router hands back the same object when nothing changed in it;
        // `assign` sets key by key, so a same-value setting notifies nothing
        if (routed.dealFields !== state.dealFields)
          deal$.dealFields.assign(routed.dealFields);
        if (routed.settings !== state.settings)
          deal$.settings.assign(routed.settings);
        let changed = false;
        for (const [
          productId,
          { groupId, writes: productWrites },
        ] of routed.products) {
          if (applyProductWrites(groupId, productId, productWrites)) changed = true;
        }
        if (changed) inputsChanged();
        requestOptions(routed.requests);
      });
    },
    calculate: () => {
      if (!isReady$.peek()) return;
      const requestId = deal$.calc.requestId.peek() + 1;
      // the products are read now, like a request body, and sent before anyone
      // hears it started: a listener that throws can't leave it "calculating"
      calculatePrice(productsOf(deal$.peek()).map(({ data }) => data)).then(
        (price) => setCalc(calcSucceeded(deal$.calc.peek(), requestId, price)),
        () => setCalc(calcFailed(deal$.calc.peek(), requestId)),
      );
      setCalc(calcStarted(deal$.calc.peek(), requestId));
    },
    dispose: () => {
      stops.forEach((stop) => stop());
      spotPriceStream.stop();
    },
  };

  const shouldAutocalc = (
    isEnabled: boolean,
    isReady: boolean,
    calc: CalcState,
  ) => isEnabled && isReady && needsAutocalc(calc);
  const autocalc = () => {
    if (
      shouldAutocalc(
        devtools$.isAutocalcEnabled.peek(),
        isReady$.peek(),
        deal$.calc.peek(),
      )
    )
      store.calculate();
  };

  const stops = [
    onOptionsLoaded(reconcileOptions),
    options$.pending.onChange(isolated(({ value }) => pending$.set(value))),
    // autocalc: whenever the deal is ready and its price missing or outdated.
    // It re-runs on every change to what it read, even when the condition
    // stays true (a calculation superseded in the batch that started it).
    // Computeds are pushed in listener order, so while a batch notifies,
    // `isReady$` may not have caught up with an edit yet (an invalid one):
    // it only schedules, and checks again once everything has settled
    observe(
      isolated(() => {
        if (
          shouldAutocalc(
            devtools$.isAutocalcEnabled.get(),
            isReady$.get(),
            deal$.calc.get(),
          )
        ) {
          queueMicrotask(autocalc);
        }
      }),
    ),
    observe(
      isolated(() =>
        devtools$.isSpotPriceStreamEnabled.get()
          ? spotPriceStream.start()
          : spotPriceStream.stop(),
      ),
    ),
  ];

  // the deal column's own options (its default parameters), loaded with the deal
  requestOptions(dealOptionsRequests);

  return store;
};
