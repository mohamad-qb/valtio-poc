import { autorun, computed } from "mobx";
import { type Frozen, Model, clone, createContext, frozen, idProp, model, modelAction, prop } from "mobx-keystone";
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
import type { PathWrite } from "@shared/paths.ts";
import {
  type OptionsRequest,
  type ProductWrite,
  optionsRequestsOf,
  reconcileWrites,
  uniqueRequests,
} from "@shared/products/productWrites.ts";
import type { Option } from "@shared/options/optionsSource.ts";
import { createSpotPriceStream } from "@shared/spotPriceStream.ts";
import { type Group, newGroup } from "./groupModel.ts";
import { onOptionsLoaded, optionsStore } from "./optionsStore.ts";
import type { Product } from "./productModel.ts";

/** What a deal needs from the app-wide developer settings. */
export type DealDevtools = {
  readonly isSpotPriceStreamEnabled: boolean;
  readonly isAutocalcEnabled: boolean;
};

/** Provided by the tab store (or a test) to every deal under it; off without one. */
export const devtoolsContext = createContext<DealDevtools>({
  isSpotPriceStreamEnabled: false,
  isAutocalcEnabled: false,
});

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

const withSyncedValues = (writes: readonly ProductWrite[]) =>
  writes.map((write) =>
    "fieldId" in write && isSyncedField(write.fieldId) ? { ...write, value: asSyncedValue(write.fieldId, write.value) } : write,
  );

/**
 * A deal. Every write is a batch of dot paths, routed by the shared rules
 * and applied in one action, so every reaction (autocalc, the grid) runs
 * once, after the last write.
 */
@model("dealEditor/Deal")
export class Deal extends Model({
  id: idProp,
  notionalCcy: prop(initialDealFields.notionalCcy),
  premiumCcy: prop(initialDealFields.premiumCcy),
  notionalAmount: prop(initialDealFields.notionalAmount),
  isInternal: prop(initialDealSettings.isInternal),
  hedgeType: prop(initialDealSettings.hedgeType),
  /** In display order. */
  groups: prop<Group[]>(() => []),
  /** One immutable value, replaced by each transition. */
  calc: prop<Frozen<CalcState>>(() => frozen({ ...initialCalcState })),
}) {
  /** Kept outside the tree: ticks never notify observers; the grid repaints just that cell. */
  readonly spotPriceStream = createSpotPriceStream();

  /**
   * Each product and its group, by the product's id: derived from the groups
   * (time travel included) and kept alive, since the grid reads it outside
   * reactions. A lookup never scans the groups.
   */
  private readonly productIndex = computed(
    () =>
      new Map(this.groups.flatMap((group) => group.products.map((product) => [product.id, { group, product }] as const))),
    { keepAlive: true },
  );

  /** Every product of every group, in display order. */
  @computed get products() {
    return this.groups.flatMap((group) => group.products);
  }

  /** Reads every product's flag (no early exit), so every product's issues stay observed: cached. */
  @computed get hasValidationErrors() {
    return this.products.filter((product) => product.hasValidationErrors).length > 0;
  }

  /** No validation errors and no request pending: ready to calculate. */
  @computed get isReady() {
    return isCalcReady(this.hasValidationErrors, optionsStore.pending);
  }

  /** A product and its group, by the product's id. */
  findProduct(productId: string): { group: Group; product: Product } | undefined {
    return this.productIndex.get().get(productId);
  }

  /** Once in the app's tree: what the deal subscribes to. Keystone calls the returned cleanup when it leaves. */
  protected onAttachedToRootStore() {
    // the deal column's own options (its default parameters); loaded in the tree, so logged under its path
    this.loadOptions(dealOptionsRequests);
    const stops = [
      // the lists are shared: whichever deal asked, this deal's products reconcile too
      onOptionsLoaded((request, options) => this.reconcileOptions(request, options)),
      // autocalc: whenever the deal is ready and its price missing or outdated. An autorun,
      // not a reaction: a calculation can be superseded in the same batch that started it.
      // Readiness is read first, so validation stays observed (cached) whatever the switch.
      autorun(() => {
        if (this.isReady && devtoolsContext.get(this).isAutocalcEnabled && needsAutocalc(this.calc.data) && !isRestoring) {
          this.calculate();
        }
      }),
      autorun(() =>
        devtoolsContext.get(this).isSpotPriceStreamEnabled ? this.spotPriceStream.start() : this.spotPriceStream.stop(),
      ),
    ];
    return () => {
      stops.forEach((stop) => stop());
      this.spotPriceStream.stop();
    };
  }

  @modelAction addNewGroup(groupType: GroupType) {
    this.insertGroup(newGroup(groupType, this), this.groups.length);
  }

  /** Inserts a copy of the group (new ids, same data) right after it. */
  @modelAction cloneGroup(groupId: string) {
    const position = this.groups.findIndex(({ id }) => id === groupId);
    if (position !== -1) this.insertGroup(clone(this.groups[position]), position + 1);
  }

  @modelAction removeGroup(groupId: string) {
    const position = this.groups.findIndex(({ id }) => id === groupId);
    if (position === -1) return;
    this.groups.splice(position, 1);
    this.markInputsChanged();
  }

  /** Writes values at dot paths, in order, as one action: an edit, a paste, anything. */
  @modelAction writePaths(writes: readonly PathWrite[]) {
    const { notionalCcy, premiumCcy, notionalAmount, isInternal, hedgeType } = this;
    const routed = routeWrites(
      {
        dealFields: { notionalCcy, premiumCcy, notionalAmount },
        settings: { isInternal, hedgeType },
        products: this.groups.flatMap((group) =>
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
    // only what changed is written: only that notifies
    for (const [key, value] of Object.entries(next)) {
      if (!Object.is(current[key], value)) Object.assign(this, { [key]: value });
    }
    let changed = false;
    for (const [productId, { writes: productWrites }] of routed.products) {
      if (this.findProduct(productId)?.product.write(withSyncedValues(productWrites))) changed = true;
    }
    if (changed) this.markInputsChanged();
    this.loadOptions(routed.requests);
  }

  /** Calculates now, if ready (the manual Calculate). Only the latest request's response is kept. */
  @modelAction calculate() {
    if (!this.isReady) return;
    const requestId = this.calc.data.requestId + 1;
    this.setCalc(calcStarted(this.calc.data, requestId));
    calculatePrice(this.products.map((product) => product.data)).then(
      (price) => this.setCalc(calcSucceeded(this.calc.data, requestId, price)),
      () => this.setCalc(calcFailed(this.calc.data, requestId)),
    );
  }

  /**
   * Any change to the products outdates the price (and supersedes a
   * calculation in flight), in the action that made it: autocalc, which runs
   * after the action, never sees the change without it.
   */
  @modelAction markInputsChanged() {
    this.setCalc(calcInputsChanged(this.calc.data));
  }

  @modelAction private setCalc(calc: CalcState) {
    if (calc !== this.calc.data) this.calc = frozen(calc);
  }

  /** Options arrived (whichever deal asked): every product still on that parameter keeps a valid value. */
  @modelAction private reconcileOptions(request: OptionsRequest, options: readonly Option[]) {
    let changed = false;
    for (const product of this.products) {
      if (product.write(reconcileWrites(product.data, request, options))) changed = true;
    }
    if (changed) this.markInputsChanged();
  }

  private insertGroup(group: Group, position: number) {
    this.groups.splice(position, 0, group);
    this.markInputsChanged();
    this.loadOptions(uniqueRequests(group.products.flatMap(({ data }) => optionsRequestsOf(data))));
  }

  /** What arrives reconciles every deal (`reconcileOptions`), this one included. */
  private loadOptions(requests: readonly OptionsRequest[]) {
    for (const { source, param } of requests) void optionsStore.load(source, param);
  }
}
