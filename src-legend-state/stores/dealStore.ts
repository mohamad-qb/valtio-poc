import {
  type Observable,
  type ObservableParam,
  batch,
  computed,
  observable,
  observe,
} from "@legendapp/state";
import type { $ZodIssue } from "zod/v4/core";
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
import type { DealKey, ReadDeal } from "@shared/dealKeys.ts";
import {
  type DealSettingsState,
  initialDealSettings,
  isDealSetting,
} from "@shared/dealSettings.ts";
import { type DealProduct, routeWrites } from "@shared/dealWrites.ts";
import { type ProductFieldId, dealOptionsRequests } from "@shared/fields.ts";
import { type GroupType, groupDefinitions, productUi } from "@shared/groups.ts";
import { uuid } from "@shared/lib/uuid.ts";
import type { PathWrite } from "@shared/paths.ts";
import {
  type GenericProductDefinition,
  type ProductData,
  type ProductUi,
  definitionOf,
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
import {
  fieldIssues,
  noIssues,
  validationInputs,
} from "@shared/validation.ts";
import { loadOptions, options$ } from "./optionsStore.ts";

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
  /** A product field's issues; read in an observer or computed, it tracks just them. */
  fieldIssues(productId: string, fieldId: ProductFieldId): readonly $ZodIssue[];
  addNewGroup(groupType: GroupType): void;
  cloneGroup(groupId: string): void;
  removeGroup(groupId: string): void;
  /** Writes values at dot paths, in order, as one batch: an edit, a paste, anything. */
  writePaths(writes: readonly PathWrite[]): void;
  /** Calculates now, if ready (the manual Calculate). */
  calculate(): void;
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

/** A product's validation, kept beside its state: computeds aren't data. */
type ProductValidation = {
  issues: Record<ProductFieldId, Observable<readonly $ZodIssue[]>>;
  hasErrors$: Observable<boolean>;
};

/** A deal value's observable, by key: `settings.isInternal`, `dealFields.notionalCcy`, … */
const dealNodeAt = (deal$: Observable<DealState>, key: DealKey) =>
  nodeAt(deal$, `${isDealSetting(key) ? "settings" : "dealFields"}.${key}`);

/**
 * One computed per field. Each reads (so tracks) only the leaves its rules
 * read, in the product and in the deal, then validates the plain data: an
 * edit re-validates only the fields that depend on it, and only when one of
 * them is observed.
 */
const createValidation = (
  definition: GenericProductDefinition,
  data$: Observable<ProductData>,
  deal$: Observable<DealState>,
): ProductValidation => {
  const readDeal: ReadDeal = (key) => dealNodeAt(deal$, key).peek();
  const fieldIds = Object.keys(definition.fieldPaths) as ProductFieldId[];
  const issues = Object.fromEntries(
    fieldIds.map((fieldId) => [
      fieldId,
      computed(() => {
        const { dataPaths, dealKeys } = validationInputs(definition, fieldId);
        for (const path of dataPaths) nodeAt(data$, path).get();
        for (const key of dealKeys) dealNodeAt(deal$, key).get();
        // a removed product's computeds still hear its leaves go: nothing left to validate
        const data = data$.peek();
        return data ? fieldIssues(definition, fieldId, data, readDeal) : noIssues;
      }),
    ]),
  ) as Record<ProductFieldId, Observable<readonly $ZodIssue[]>>;
  return {
    issues,
    hasErrors$: computed(() =>
      fieldIds.some((fieldId) => issues[fieldId].get().length > 0),
    ),
  };
};

/**
 * Deal factory, over a deal's observable state (its own, unless given one:
 * the tabs keep every deal in one tree). Every write is a batch of dot paths,
 * routed by the shared rules and set leaf by leaf in one `batch`, so every
 * listener (autocalc, inputs changed, the grid) runs once, after the last
 * write, and only for the leaves that changed.
 */
export const createDealStore = (
  devtools$: DealDevtools,
  deal$: Observable<DealState> = observable<DealState>(initialDealState()),
): DealStore => {
  const spotPriceStream = createSpotPriceStream();
  const validations = new Map<string, ProductValidation>();

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

  /** Sets a product's changed leaves, by the shared rules (derived fields are kept as data). */
  const applyProductWrites = (
    data$: Observable<ProductData>,
    writes: readonly ProductWrite[],
  ) => {
    for (const change of planProductWrites(data$.peek(), writes).changes) {
      const leaf$ = nodeAt(data$, change.path);
      if ("remove" in change) leaf$.delete();
      else leaf$.set(change.value);
    }
  };

  /**
   * Loads options; when they arrive, every product still on that parameter
   * reconciles. Call it inside the batch that needs them: the pending count
   * goes up before any listener sees the batch (no early autocalc).
   */
  const requestOptions = (requests: readonly OptionsRequest[]) => {
    for (const request of requests) {
      void loadOptions(request.source, request.param).then((options) => {
        if (!options) return;
        batch(() => {
          for (const { groupId, productId, data } of productsOf(deal$.peek())) {
            applyProductWrites(
              data$Of(groupId, productId),
              reconcileWrites(data, request, options),
            );
          }
        });
      });
    }
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
      const definition = definitionOf(productType);
      const sourceData = source?.products[source.productIds[index]].data;
      const product: ProductState = {
        id: uuid(),
        ui: productUi(productType, index),
        // a plain deep copy: the clone never shares an object with its source
        data: sourceData
          ? structuredClone(sourceData)
          : definition.createData(dealFields),
      };
      group.products[product.id] = product;
      group.productIds.push(product.id);
      // ready before the deal lists the product: its computeds are read from then on
      validations.set(
        product.id,
        createValidation(definition, data$Of(group.id, product.id), deal$),
      );
    });
    batch(() => {
      // record first, so the id never appears in the order without its group
      deal$.groups[group.id].set(group);
      deal$.groupIds.set((ids) => ids.toSpliced(position, 0, group.id));
      requestOptions(
        uniqueRequests(
          group.productIds.flatMap((id) =>
            optionsRequestsOf(group.products[id].data),
          ),
        ),
      );
    });
  };

  // the calculation is replaced, never written into: unchanged comes back as the same object
  const setCalc = (next: CalcState) => {
    if (next !== deal$.calc.peek()) deal$.calc.set(next);
  };

  const hasValidationErrors$ = computed(() =>
    deal$.groupIds
      .get()
      .some((groupId) =>
        deal$.groups[groupId].productIds
          .get()
          .some((productId) => validations.get(productId)!.hasErrors$.get()),
      ),
  );
  const isReady$ = computed(() =>
    isCalcReady(hasValidationErrors$.get(), options$.pending.get()),
  );

  const store: DealStore = {
    deal$,
    spotPriceStream,
    hasValidationErrors$,
    isReady$,
    fieldIssues: (productId, fieldId) =>
      (validations.get(productId)?.issues[fieldId]?.get() as
        readonly $ZodIssue[] | undefined) ?? noIssues,
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
      });
      for (const productId of group.productIds) validations.delete(productId);
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
        for (const [
          productId,
          { groupId, writes: productWrites },
        ] of routed.products) {
          applyProductWrites(data$Of(groupId, productId), productWrites);
        }
        requestOptions(routed.requests);
      });
    },
    calculate: () => {
      if (!isReady$.peek()) return;
      const requestId = deal$.calc.requestId.peek() + 1;
      setCalc(calcStarted(deal$.calc.peek(), requestId));
      // the products are read now, like a request body
      calculatePrice(productsOf(deal$.peek()).map(({ data }) => data)).then(
        (price) => setCalc(calcSucceeded(deal$.calc.peek(), requestId, price)),
        () => setCalc(calcFailed(deal$.calc.peek(), requestId)),
      );
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

  // the deal column's own options (its default parameters), loaded with the deal
  requestOptions(dealOptionsRequests);

  const stops = [
    // any change under the groups (a product edit, a group added or removed)
    // outdates the price and supersedes a calculation in flight
    deal$.groups.onChange(() => setCalc(calcInputsChanged(deal$.calc.peek()))),
    // autocalc: whenever the deal is ready and its price missing or outdated.
    // It re-runs on every change to what it read, even when the condition
    // stays true (a calculation superseded in the batch that started it).
    // Computeds are pushed in listener order, so while a batch notifies,
    // `isReady$` may not have caught up with an edit yet (an invalid one):
    // it only schedules, and checks again once everything has settled
    observe(() => {
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
    observe(() =>
      devtools$.isSpotPriceStreamEnabled.get()
        ? spotPriceStream.start()
        : spotPriceStream.stop(),
    ),
  ];

  return store;
};
