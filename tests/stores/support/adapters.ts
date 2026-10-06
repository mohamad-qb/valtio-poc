import { fileURLToPath } from "node:url";
import { vi } from "vitest";
import type { ProductFieldId } from "@shared/fields.ts";
import type { GridSource } from "@shared/grid/gridSource.ts";
import { createPathGridSource } from "@shared/grid/pathGridSource.ts";
import type { PathDeal } from "@shared/pathDeal.ts";
import { productPath } from "@shared/paths.ts";
import { type ProductData, definitionOf, productTypeOf } from "@shared/products/productRegistry.ts";

/**
 * Every app is driven the same way: through its `PathDeal`, by dot path, as
 * the app being migrated would. Each app only adds what isn't on it (the
 * calculation, the autocalc switch, the deal-wide validation flag).
 */
export type AppName = "valtio" | "mobx" | "mobx-state-tree" | "mobx-keystone" | "legend-state" | "redux" | "zustand" | "jotai" | "effector-nested" | "effector-model";
export const appNames: AppName[] = ["valtio", "mobx", "mobx-state-tree", "mobx-keystone", "legend-state", "redux", "zustand", "jotai", "effector-nested", "effector-model"];

type GroupType = "VanillaGroup" | "Strategy" | "Average";

/** A product, held even after it leaves the deal. */
export type ProductHandle = {
  read(fieldId: string): unknown;
  dataKeys(): string[];
};

export type DealAdapter = {
  addGroup(groupType: GroupType): void;
  cloneGroup(groupIndex: number): void;
  removeGroup(groupIndex: number): void;
  /** Group titles, in order. */
  groupTitles(): string[];
  groupProductTitles(groupIndex: number): string[];
  groupCount(): number;
  productCount(): number;
  /** The i-th product of the deal, across groups, in display order. */
  product(i: number): ProductHandle;
  productType(i: number): string;
  productIdsOfGroup(groupIndex: number): string[];
  /** A product field, read by its path. */
  read(i: number, fieldId: string): unknown;
  /** Whether the product's data has the field at all, not just an empty value. */
  has(i: number, fieldId: string): boolean;
  /** Writes a product field by its path, as its cell would. */
  commit(i: number, fieldId: string, value: unknown): void;
  /** Writes a synced deal field (Notional Ccy/Amount, Premium Ccy) at its root path. */
  sync(fieldId: string, value: unknown): void;
  dealValue(fieldId: string): unknown;
  /** Writes a deal broadcast field at its root path. */
  broadcast(fieldId: string, value: unknown): void;
  issues(i: number, fieldId: string): string[];
  hasValidationErrors(): boolean;
  /** Fixing source options as loaded for a settlement style. */
  optionsFor(settlementStyle: string): { status?: string; values: string[]; labels: string[] };
  /** The deal's calculation: its status and last price. */
  calc(): { status: string; price: number | null };
  /** Presses Calculate. */
  calculate(): void;
  /** Flips the autocalc switch (off in a new adapter). */
  setAutocalc(enabled: boolean): void;
  /** The grid source over this deal: what the grid reads, watches and writes. */
  grid(): GridSource;
  /** The deal itself, by path. */
  deal(): PathDeal;
  dispose(): void;
};

/** What an app adds to its `PathDeal` for the tests. */
type AppExtras = Pick<DealAdapter, "hasValidationErrors" | "calc" | "calculate" | "setAutocalc" | "dispose">;

type OptionsView = { status?: string; options?: readonly { value: string; label: string }[] };
const optionsView = (state: OptionsView | undefined) => ({
  status: state?.status,
  values: (state?.options ?? []).map((option) => option.value),
  labels: (state?.options ?? []).map((option) => option.label),
});

const at = (relative: string) => fileURLToPath(new URL(`../../../${relative}`, import.meta.url));
const pathGet = (target: unknown, path: string) =>
  path.split(".").reduce<unknown>((value, key) => (value as Record<string, unknown> | undefined)?.[key], target);
const fieldPathOf = (data: ProductData, fieldId: string) =>
  (definitionOf(productTypeOf(data)).fieldPaths as Record<string, string>)[fieldId];

const hasField = (data: ProductData, fieldId: string) => {
  const parts = fieldPathOf(data, fieldId).split(".");
  const key = parts.pop() as string;
  const parent = parts.length ? pathGet(data, parts.join(".")) : data;
  return typeof parent === "object" && parent !== null && key in parent;
};

/** The common test API over any app's `PathDeal`. */
const pathAdapter = (deal: PathDeal, extras: AppExtras): DealAdapter => {
  const products = () =>
    deal.getGroups().flatMap((group) =>
      group.productIds.map((productId) => ({ groupId: group.id, productId, data: deal.getProduct(productId)!.data })),
    );
  const pathOf = (i: number, fieldId: string) => {
    const { groupId, productId, data } = products()[i];
    return productPath(groupId, productId, fieldPathOf(data, fieldId));
  };
  const write = (path: string, value: unknown) => deal.writePaths([{ path, value }]);
  const groupAt = (i: number) => deal.getGroups()[i];

  return {
    addGroup: (groupType) => deal.addGroup(groupType),
    cloneGroup: (i) => deal.cloneGroup(groupAt(i).id),
    removeGroup: (i) => deal.removeGroup(groupAt(i)?.id ?? "unknown"),
    groupTitles: () => deal.getGroups().map(({ title }) => title),
    groupProductTitles: (i) => groupAt(i).productIds.map((id) => deal.getProduct(id)!.title),
    groupCount: () => deal.getGroups().length,
    productCount: () => products().length,
    product: (i) => {
      const { data } = products()[i];
      return { read: (fieldId) => pathGet(data, fieldPathOf(data, fieldId)), dataKeys: () => Object.keys(data) };
    },
    productType: (i) => products()[i].data.productType,
    productIdsOfGroup: (i) => [...groupAt(i).productIds],
    read: (i, fieldId) => deal.readPath(pathOf(i, fieldId)),
    has: (i, fieldId) => hasField(products()[i].data, fieldId),
    commit: (i, fieldId, value) => write(pathOf(i, fieldId), value),
    sync: (fieldId, value) => write(fieldId, value),
    dealValue: (fieldId) => deal.readPath(fieldId),
    broadcast: (fieldId, value) => write(fieldId, value),
    issues: (i, fieldId) =>
      deal.fieldIssues(products()[i].productId, fieldId as ProductFieldId).map((issue) => issue.message),
    optionsFor: (style) => optionsView(deal.getOptions()[`fixingSources:${style}`]),
    grid: () => createPathGridSource(deal),
    deal: () => deal,
    ...extras,
  };
};

const valtio = async (): Promise<DealAdapter> => {
  // the deal reads the devtools flags from the tab store; give it a plain one
  vi.doMock(at("src-valtio/stores/multiTabStore.ts"), async () => {
    const { proxy } = await import("valtio");
    return { multiTabStore: proxy({ devtools: { isSpotPriceStreamEnabled: false, isAutocalcEnabled: false } }) };
  });
  const { createDealStore } = await import("../../../src-valtio/stores/dealStore.ts");
  const { createPathDeal } = await import("../../../src-valtio/stores/pathDeal.ts");
  const { multiTabStore } = await import("../../../src-valtio/stores/multiTabStore.ts");
  const deal = createDealStore();
  return pathAdapter(createPathDeal(deal), {
    hasValidationErrors: () => deal.hasValidationErrors,
    calc: () => ({ status: deal.calc.status, price: deal.calc.price }),
    calculate: () => deal.actions.calculate(),
    setAutocalc: (enabled) => (multiTabStore.devtools.isAutocalcEnabled = enabled),
    dispose: () => deal.actions.dispose(),
  });
};

const mobx = async (): Promise<DealAdapter> => {
  const { configure, observable, runInAction } = await import("mobx");
  configure({ enforceActions: "always" });
  // any MobX warning (e.g. a write outside an action) fails the test
  vi.spyOn(console, "warn").mockImplementation((...args) => {
    throw new Error(`MobX warning: ${args.join(" ")}`);
  });
  const { createDealStore } = await import("../../../src-mobx/stores/dealStore.ts");
  const { createPathDeal } = await import("../../../src-mobx/stores/pathDeal.ts");
  const devtools = observable({ isSpotPriceStreamEnabled: false, isAutocalcEnabled: false });
  const deal = createDealStore(devtools);
  return pathAdapter(createPathDeal(deal), {
    hasValidationErrors: () => deal.hasValidationErrors,
    calc: () => ({ status: deal.calc.status, price: deal.calc.price }),
    calculate: () => deal.calculate(),
    setAutocalc: (enabled) => runInAction(() => (devtools.isAutocalcEnabled = enabled)),
    dispose: () => deal.dispose(),
  });
};

const mobxStateTree = async (): Promise<DealAdapter> => {
  const { observable, runInAction } = await import("mobx");
  const { destroy } = await import("mobx-state-tree");
  const { Deal } = await import("../../../src-mobx-state-tree/stores/dealModel.ts");
  const { createPathDeal } = await import("../../../src-mobx-state-tree/stores/pathDeal.ts");
  const devtools = observable({ isSpotPriceStreamEnabled: false, isAutocalcEnabled: false });
  const deal = Deal.create({}, { devtools });
  return pathAdapter(createPathDeal(deal), {
    hasValidationErrors: () => deal.hasValidationErrors,
    calc: () => ({ status: deal.calc.status, price: deal.calc.price }),
    calculate: () => deal.calculate(),
    setAutocalc: (enabled) => runInAction(() => (devtools.isAutocalcEnabled = enabled)),
    dispose: () => destroy(deal),
  });
};

const mobxKeystone = async (): Promise<DealAdapter> => {
  const { observable, runInAction } = await import("mobx");
  const { registerRootStore, setGlobalConfig, unregisterRootStore } = await import("mobx-keystone");
  // each test re-imports the models, which registers their names again
  setGlobalConfig({ showDuplicateModelNameWarnings: false });
  const { Deal, devtoolsContext } = await import("../../../src-mobx-keystone/stores/dealModel.ts");
  const { createPathDeal } = await import("../../../src-mobx-keystone/stores/pathDeal.ts");
  const devtools = observable({ isSpotPriceStreamEnabled: false, isAutocalcEnabled: false });
  const deal = new Deal({});
  devtoolsContext.set(deal, devtools);
  registerRootStore(deal); // starts the deal's reactions
  return pathAdapter(createPathDeal(deal), {
    hasValidationErrors: () => deal.hasValidationErrors,
    calc: () => ({ status: deal.calc.data.status, price: deal.calc.data.price }),
    calculate: () => deal.calculate(),
    setAutocalc: (enabled) => runInAction(() => (devtools.isAutocalcEnabled = enabled)),
    dispose: () => unregisterRootStore(deal),
  });
};

const legendState = async (): Promise<DealAdapter> => {
  const { observable } = await import("@legendapp/state");
  const { createDealStore } = await import("../../../src-legend-state/stores/dealStore.ts");
  const { createPathDeal } = await import("../../../src-legend-state/stores/pathDeal.ts");
  const devtools$ = observable({ isSpotPriceStreamEnabled: false, isAutocalcEnabled: false });
  const deal = createDealStore(devtools$);
  return pathAdapter(createPathDeal(deal), {
    hasValidationErrors: () => deal.hasValidationErrors$.get(),
    calc: () => ({ status: deal.deal$.calc.status.peek(), price: deal.deal$.calc.price.peek() }),
    calculate: () => deal.calculate(),
    setAutocalc: (enabled) => devtools$.isAutocalcEnabled.set(enabled),
    dispose: () => deal.dispose(),
  });
};

const redux = async (): Promise<DealAdapter> => {
  const { createApp } = await import("../../../src-redux/stores/store.ts");
  const { addDeal, calculate } = await import("../../../src-redux/stores/thunks.ts");
  const { autocalcToggled } = await import("../../../src-redux/stores/devtoolsSlice.ts");
  const { selectHasValidationErrors } = await import("../../../src-redux/stores/selectors.ts");
  const { createPathDeal } = await import("../../../src-redux/stores/pathDeal.ts");
  const { store, dispose } = createApp({ isSpotPriceStreamEnabled: false, isAutocalcEnabled: false });
  const dealId = store.dispatch(addDeal());
  return pathAdapter(createPathDeal(store, dealId), {
    hasValidationErrors: () => selectHasValidationErrors(store.getState(), dealId),
    calc: () => {
      const { status, price } = store.getState().deals[dealId].calc;
      return { status, price };
    },
    calculate: () => store.dispatch(calculate(dealId)),
    setAutocalc: (enabled) => {
      if (store.getState().devtools.isAutocalcEnabled !== enabled) store.dispatch(autocalcToggled());
    },
    dispose,
  });
};

const zustand = async (): Promise<DealAdapter> => {
  const { createStore } = await import("zustand/vanilla");
  const { createDealStore } = await import("../../../src-zustand/stores/dealStore.ts");
  const { createPathDeal } = await import("../../../src-zustand/stores/pathDeal.ts");
  const { selectHasValidationErrors } = await import("../../../src-zustand/stores/validation.ts");
  // the deal reads the switches from a store of their own; give it a plain one
  const devtools = createStore(() => ({ isSpotPriceStreamEnabled: false, isAutocalcEnabled: false }));
  const deal = createDealStore(devtools);
  return pathAdapter(createPathDeal(deal), {
    hasValidationErrors: () => selectHasValidationErrors(deal.getState()),
    calc: () => {
      const { status, price } = deal.getState().calc;
      return { status, price };
    },
    calculate: () => deal.getState().actions.calculate(),
    setAutocalc: (enabled) => devtools.setState({ isAutocalcEnabled: enabled }),
    dispose: () => deal.getState().actions.dispose(),
  });
};

const jotai = async (): Promise<DealAdapter> => {
  const { atom, getDefaultStore } = await import("jotai/vanilla");
  const { createDealStore } = await import("../../../src-jotai/stores/dealStore.ts");
  const { createPathDeal } = await import("../../../src-jotai/stores/pathDeal.ts");
  // the app's store: jotai's default one, kept across tests (each test's atoms are new)
  const store = getDefaultStore();
  const devtoolsAtom = atom({ isSpotPriceStreamEnabled: false, isAutocalcEnabled: false });
  const deal = createDealStore(devtoolsAtom);
  return pathAdapter(createPathDeal(deal), {
    hasValidationErrors: () => store.get(deal.hasValidationErrorsAtom),
    calc: () => {
      const { status, price } = store.get(deal.calcAtom);
      return { status, price };
    },
    calculate: () => deal.actions.calculate(),
    setAutocalc: (enabled) => store.set(devtoolsAtom, (devtools) => ({ ...devtools, isAutocalcEnabled: enabled })),
    dispose: () => deal.dispose(), // the store outlives the test: drop the deal's subscriptions
  });
};

const effectorNested = async (): Promise<DealAdapter> => {
  const { createEvent, createStore } = await import("effector");
  const { createDealStore } = await import("../../../src-effector-nested/stores/dealStore.ts");
  const { createPathDeal } = await import("../../../src-effector-nested/stores/pathDeal.ts");
  const setAutocalc = createEvent<boolean>();
  const $isAutocalcEnabled = createStore(false).on(setAutocalc, (_, enabled) => enabled);
  const deal = createDealStore({ $isSpotPriceStreamEnabled: createStore(false), $isAutocalcEnabled });
  deal.actions.loadDealOptionsAction(); // as its tab does
  return pathAdapter(createPathDeal(deal), {
    hasValidationErrors: () => deal.$hasValidationErrors.getState(),
    calc: () => ({ status: deal.$calc.getState().status, price: deal.$calc.getState().price }),
    calculate: () => deal.actions.calculateAction(),
    setAutocalc,
    dispose: () => deal.dispose(),
  });
};

const effectorModel = async (): Promise<DealAdapter> => {
  const { createEvent, createStore } = await import("effector");
  const { createDealStore } = await import("../../../src-effector-model/stores/dealStore.ts");
  const { createPathDeal } = await import("../../../src-effector-model/stores/pathDeal.ts");
  const setAutocalc = createEvent<boolean>();
  const $isAutocalcEnabled = createStore(false).on(setAutocalc, (_, enabled) => enabled);
  const deal = createDealStore({ $isSpotPriceStreamEnabled: createStore(false), $isAutocalcEnabled });
  deal.actions.loadDealOptionsAction(); // as its tab does
  return pathAdapter(createPathDeal(deal), {
    hasValidationErrors: () => deal.$hasValidationErrors.getState(),
    calc: () => ({ status: deal.$calc.getState().status, price: deal.$calc.getState().price }),
    calculate: () => deal.actions.calculateAction(),
    setAutocalc,
    dispose: () => deal.dispose(),
  });
};

/** A fresh deal, with fresh modules (no state shared between tests). */
export const createAdapter = async (app: AppName): Promise<DealAdapter> => {
  vi.resetModules();
  return { valtio, mobx, "mobx-state-tree": mobxStateTree, "mobx-keystone": mobxKeystone, "legend-state": legendState, redux, zustand, jotai, "effector-nested": effectorNested, "effector-model": effectorModel }[app]();
};
