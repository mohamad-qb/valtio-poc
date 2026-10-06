import { autorun } from "mobx";
import {
  type Instance,
  type SnapshotIn,
  addDisposer,
  getEnv,
  getParent,
  isAlive,
  resolveIdentifier,
  types,
} from "mobx-state-tree";
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
import { asSyncedValue, initialDealFields, isSyncedField, syncedFieldIds } from "@shared/dealFields.ts";
import { initialDealSettings } from "@shared/dealSettings.ts";
import { routeWrites } from "@shared/dealWrites.ts";
import { dealOptionsRequests } from "@shared/fields.ts";
import type { GroupType } from "@shared/groups.ts";
import { uuid } from "@shared/lib/uuid.ts";
import type { Option } from "@shared/options/optionsSource.ts";
import type { PathWrite } from "@shared/paths.ts";
import {
  type OptionsRequest,
  type ProductWrite,
  optionsRequestsOf,
  reconcileWrites,
  uniqueRequests,
} from "@shared/products/productWrites.ts";
import { createSpotPriceStream } from "@shared/spotPriceStream.ts";
import { Group, copyOfGroup, newGroup } from "./groupModel.ts";
import { onOptionsLoaded, optionsStore } from "./optionsStore.ts";
import { Product } from "./productModel.ts";

/** What a deal needs from the app-wide developer settings. */
export type DealDevtools = {
  readonly isSpotPriceStreamEnabled: boolean;
  readonly isAutocalcEnabled: boolean;
};

/** The deal's environment, given to the tree that holds it: `Deal.create({}, { devtools })`. */
export type DealEnv = { devtools: DealDevtools };

let isRestoring = false;

/**
 * Applies a past state (DevTools time travel): it comes back as recorded, so
 * autocalc leaves it alone (nothing outdated or re-priced by the jump itself).
 */
export const restoring = (restore: () => void) => {
  isRestoring = true;
  try {
    restore();
  } finally {
    isRestoring = false;
  }
};

/** A number that is NaN while empty: JSON (a state from DevTools) brings it back as `null`. */
const emptyableNumber = types.snapshotProcessor(types.number, {
  preProcessor: (snapshot: number | null) => (snapshot === null ? NaN : snapshot),
});

const withSyncedValues = (writes: readonly ProductWrite[]) =>
  writes.map((write) =>
    "fieldId" in write && isSyncedField(write.fieldId) ? { ...write, value: asSyncedValue(write.fieldId, write.value) } : write,
  );

/**
 * A deal. Every write is a batch of dot paths, routed by the shared rules
 * and applied in one action, so every reaction (autocalc, the grid) runs
 * once, after the last write.
 */
export const Deal = types
  .model("Deal", {
    id: types.optional(types.identifier, uuid),
    notionalCcy: initialDealFields.notionalCcy,
    premiumCcy: initialDealFields.premiumCcy,
    notionalAmount: types.optional(emptyableNumber, initialDealFields.notionalAmount),
    isInternal: initialDealSettings.isInternal,
    hedgeType: initialDealSettings.hedgeType,
    /** In display order. */
    groups: types.array(Group),
    calc: types.frozen<CalcState>(initialCalcState),
  })
  .volatile(() => ({
    /** Kept outside the tree: ticks never notify observers; the grid repaints just that cell. */
    spotPriceStream: createSpotPriceStream(),
  }))
  .views((self) => ({
    /** Every product of every group, in display order. */
    get products() {
      return self.groups.flatMap((group) => group.products.slice());
    },
    /** Reads every product's flag (no early exit), so every product's issues stay observed: cached. */
    get hasValidationErrors() {
      return this.products.filter((product) => product.hasValidationErrors).length > 0;
    },
    /** No validation errors and no request pending: ready to calculate. */
    get isReady() {
      return isCalcReady(this.hasValidationErrors, optionsStore.pending);
    },
    /** A product and its group, by the product's id: MST's identifier index, not a scan. */
    findProduct(productId: string) {
      const product = resolveIdentifier(Product, self, productId);
      const group = product && getParent<Group>(product, 2);
      return group && getParent(group, 2) === self ? { group, product: product! } : undefined;
    },
  }))
  // the steps that async results (a price, options) apply: MST only lets actions change the tree
  .actions((self) => ({
    setCalc(calc: CalcState) {
      self.calc = calc;
    },
    /**
     * Any change to the products outdates the price (and supersedes a
     * calculation in flight), in the action that made it: autocalc, which runs
     * after the action, never sees the change without it.
     */
    markInputsChanged() {
      self.calc = calcInputsChanged(self.calc);
    },
  }))
  .actions((self) => ({
    /** Options arrived (whichever deal asked): every product still on that parameter keeps a valid value. */
    reconcileOptions(request: OptionsRequest, options: readonly Option[]) {
      let changed = false;
      for (const product of self.products) {
        if (product.write(reconcileWrites(product.data, request, options))) changed = true;
      }
      if (changed) self.markInputsChanged();
    },
  }))
  .actions((self) => {
    /** What arrives reconciles every deal (`reconcileOptions`), this one included. */
    const loadOptions = (requests: readonly OptionsRequest[]) => {
      for (const { source, param } of requests) void optionsStore.load(source, param);
    };

    const insertGroup = (group: SnapshotIn<typeof Group>, position: number) => {
      self.groups.splice(position, 0, group);
      self.markInputsChanged();
      const { products } = self.groups[position];
      loadOptions(uniqueRequests(products.flatMap(({ data }) => optionsRequestsOf(data))));
    };

    return {
      loadOptions,
      addNewGroup(groupType: GroupType) {
        insertGroup(newGroup(groupType, self), self.groups.length);
      },
      /** Inserts a copy of the group (new ids, same data) right after it. */
      cloneGroup(groupId: string) {
        const position = self.groups.findIndex(({ id }) => id === groupId);
        if (position !== -1) insertGroup(copyOfGroup(self.groups[position]), position + 1);
      },
      removeGroup(groupId: string) {
        const position = self.groups.findIndex(({ id }) => id === groupId);
        if (position === -1) return;
        self.groups.splice(position, 1);
        self.markInputsChanged();
      },
      /** Writes values at dot paths, in order, as one action: an edit, a paste, anything. */
      writePaths(writes: readonly PathWrite[]) {
        const { notionalCcy, premiumCcy, notionalAmount, isInternal, hedgeType } = self;
        const routed = routeWrites(
          {
            dealFields: { notionalCcy, premiumCcy, notionalAmount },
            settings: { isInternal, hedgeType },
            products: self.groups.flatMap((group) =>
              group.products.map((product) => ({ groupId: group.id, productId: product.id, data: product.data })),
            ),
          },
          writes,
        );
        const current: Record<string, unknown> = { notionalCcy, premiumCcy, notionalAmount, isInternal, hedgeType };
        const next = {
          ...Object.fromEntries(syncedFieldIds.map((fieldId) => [fieldId, asSyncedValue(fieldId, routed.dealFields[fieldId])])),
          ...routed.settings,
        };
        // only what changed is written (not NaN over NaN): only that notifies
        for (const [key, value] of Object.entries(next)) {
          if (!Object.is(current[key], value)) Object.assign(self, { [key]: value });
        }
        let changed = false;
        for (const [productId, { writes: productWrites }] of routed.products) {
          if (self.findProduct(productId)?.product.write(withSyncedValues(productWrites))) changed = true;
        }
        if (changed) self.markInputsChanged();
        loadOptions(routed.requests);
      },
      /** Calculates now, if ready (the manual Calculate). Only the latest request's response is kept. */
      calculate() {
        if (!self.isReady) return;
        const requestId = self.calc.requestId + 1;
        self.calc = calcStarted(self.calc, requestId);
        // a deal destroyed meanwhile (a closed tab, a time-travel jump) has nothing to price
        calculatePrice(self.products.map((product) => product.data)).then(
          (price) => {
            if (isAlive(self)) self.setCalc(calcSucceeded(self.calc, requestId, price));
          },
          () => {
            if (isAlive(self)) self.setCalc(calcFailed(self.calc, requestId));
          },
        );
      },
    };
  })
  // lifecycle: what the deal subscribes to lives as long as the deal; `destroy(deal)` stops it
  .actions((self) => ({
    afterCreate() {
      const { devtools } = getEnv<DealEnv>(self);
      // the lists are shared: whichever deal asked, this deal's products reconcile too
      addDisposer(self, onOptionsLoaded((request, options) => self.reconcileOptions(request, options)));
      // the deal column's own options (its default parameters), loaded with the deal
      self.loadOptions(dealOptionsRequests);
      // autocalc: whenever the deal is ready and its price missing or outdated. An autorun,
      // not a reaction: a calculation can be superseded in the same batch that started it.
      // Readiness is read first, so validation stays observed (cached) whatever the switch.
      addDisposer(
        self,
        autorun(() => {
          if (self.isReady && devtools.isAutocalcEnabled && needsAutocalc(self.calc) && !isRestoring) self.calculate();
        }),
      );
      addDisposer(
        self,
        autorun(() => (devtools.isSpotPriceStreamEnabled ? self.spotPriceStream.start() : self.spotPriceStream.stop())),
      );
    },
    beforeDestroy() {
      self.spotPriceStream.stop();
    },
  }));

export type Deal = Instance<typeof Deal>;
