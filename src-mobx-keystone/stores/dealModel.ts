import { autorun, computed, reaction } from "mobx";
import { Model, clone, createContext, getSnapshot, idProp, model, modelAction, prop } from "mobx-keystone";
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
import { initialDealFields } from "@shared/dealFields.ts";
import { initialDealSettings } from "@shared/dealSettings.ts";
import { routeWrites } from "@shared/dealWrites.ts";
import { dealOptionsRequests } from "@shared/fields.ts";
import type { GroupType } from "@shared/groups.ts";
import type { PathWrite } from "@shared/paths.ts";
import {
  type OptionsRequest,
  optionsRequestsOf,
  reconcileWrites,
  uniqueRequests,
} from "@shared/products/productWrites.ts";
import type { Option } from "@shared/options/optionsSource.ts";
import { createSpotPriceStream } from "@shared/spotPriceStream.ts";
import { type Group, newGroup } from "./groupModel.ts";
import { dealContext } from "./productModel.ts";
import { optionsStore } from "./optionsStore.ts";

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

/**
 * A deal. Every write is a batch of dot paths, routed by the shared rules
 * and applied in one action, so every reaction (autocalc, inputs changed,
 * the grid) runs once, after the last write.
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
  calc: prop<CalcState>(() => ({ ...initialCalcState })),
}) {
  /** Kept outside the tree: ticks never notify observers; the grid repaints just that cell. */
  readonly spotPriceStream = createSpotPriceStream();

  /** Every product of every group, in display order. */
  @computed get products() {
    return this.groups.flatMap((group) => group.products);
  }

  @computed get hasValidationErrors() {
    return this.products.some((product) => product.hasValidationErrors);
  }

  /** No validation errors and no request pending: ready to calculate. */
  @computed get isReady() {
    return isCalcReady(this.hasValidationErrors, optionsStore.pending);
  }

  /** A product and its group, by the product's id. */
  findProduct(productId: string) {
    for (const group of this.groups) {
      const product = group.products.find(({ id }) => id === productId);
      if (product) return { group, product };
    }
    return undefined;
  }

  /** On creation: the deal column's own options (its default parameters). */
  protected onInit() {
    // every product under the deal reads its values through this
    dealContext.set(this, this);
    this.loadOptions(dealOptionsRequests);
  }

  /** Once in the app's tree: the deal's reactions. Keystone calls the returned cleanup when it leaves. */
  protected onAttachedToRootStore() {
    const stops = [
      // any product edit outdates the price (and supersedes a calculation in flight);
      // the snapshot is a new object whenever anything in the groups changed
      reaction(
        () => getSnapshot(this.groups),
        () => this.markInputsChanged(),
      ),
      // autocalc: whenever the deal is ready and its price missing or outdated. An autorun,
      // not a reaction: a calculation can be superseded in the same batch that started it
      autorun(() => {
        if (devtoolsContext.get(this).isAutocalcEnabled && this.isReady && needsAutocalc(this.calc)) {
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
    if (position !== -1) this.groups.splice(position, 1);
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
    // same-value writes don't notify: only what changed does
    Object.assign(this, routed.dealFields, routed.settings);
    for (const [productId, { writes: productWrites }] of routed.products) {
      this.findProduct(productId)?.product.write(productWrites);
    }
    this.loadOptions(routed.requests);
  }

  /** Calculates now, if ready (the manual Calculate). Only the latest request's response is kept. */
  @modelAction calculate() {
    if (!this.isReady) return;
    const requestId = this.calc.requestId + 1;
    this.calc = calcStarted(this.calc, requestId);
    calculatePrice(this.products.map((product) => product.data)).then(
      (price) => this.setCalc(calcSucceeded(this.calc, requestId, price)),
      () => this.setCalc(calcFailed(this.calc, requestId)),
    );
  }

  @modelAction markInputsChanged() {
    this.calc = calcInputsChanged(this.calc);
  }

  @modelAction private setCalc(calc: CalcState) {
    this.calc = calc;
  }

  /** Options arrived: every product still on that parameter keeps a valid value, in one action. */
  @modelAction private reconcileOptions(request: OptionsRequest, options: readonly Option[]) {
    for (const product of this.products) product.write(reconcileWrites(product.data, request, options));
  }

  private insertGroup(group: Group, position: number) {
    this.groups.splice(position, 0, group);
    this.loadOptions(uniqueRequests(group.products.flatMap(({ data }) => optionsRequestsOf(data))));
  }

  private loadOptions(requests: readonly OptionsRequest[]) {
    for (const request of requests) {
      void optionsStore.load(request.source, request.param).then((options) => {
        if (options) this.reconcileOptions(request, options);
      });
    }
  }
}
