import {
  createEffect,
  createEvent,
  createStore,
  sample as connect,
  withFactory,
} from "effector";
import { type Fail, persist } from "effector-storage/local";
import { z } from "zod";
import { uuid } from "@shared/lib/uuid.ts";
import { type DealStore, createDealStore } from "./dealStore.ts";

// effector exports it (its babel plugin calls it for factories), but doesn't type it
declare module "effector" {
  export function withFactory<T>(config: { sid: string; fn: () => T }): T;
}

// --- developer settings, persisted to localStorage
export const toggleSpotPriceStreamEnabledAction = createEvent();
export const $isSpotPriceStreamEnabled = createStore(true).on(
  toggleSpotPriceStreamEnabledAction,
  (enabled) => !enabled,
);

export const toggleAutocalcEnabledAction = createEvent();
export const $isAutocalcEnabled = createStore(true).on(
  toggleAutocalcEnabledAction,
  (enabled) => !enabled,
);

/** A stored value that isn't readable or isn't a boolean: ignored (the default applies), without logging it. */
const storedSettingRejected = createEvent<Fail<Error>>();

/**
 * Restores the settings on load and saves every change (also kept in sync
 * across browser tabs). Each setting is stored on its own, so a bad value
 * resets only its own.
 */
persist({
  store: $isSpotPriceStreamEnabled,
  keyPrefix: "effector-nested-devtools:",
  key: "isSpotPriceStreamEnabled",
  contract: z.boolean(),
  fail: storedSettingRejected,
});
persist({
  store: $isAutocalcEnabled,
  keyPrefix: "effector-nested-devtools:",
  key: "isAutocalcEnabled",
  contract: z.boolean(),
  fail: storedSettingRejected,
});

// --- deals (tabs)
/**
 * A deal is a set of units (its model), created at runtime — a side effect,
 * so it happens in an effect. Its units' sids are prefixed with its id, so
 * deals don't share them in a scope. A new tab's deal comes with its first
 * group, and loads its options in the caller's scope.
 */
const addNewDealEffect = createEffect(() => {
  const dealId = uuid();
  // the deal gets only the settings it reads
  const deal = withFactory({
    sid: dealId,
    fn: () => createDealStore({ $isSpotPriceStreamEnabled, $isAutocalcEnabled }),
  });
  deal.actions.loadDealOptionsAction();
  deal.actions.addGroupAction("VanillaGroup");
  return { dealId, deal };
});

export const addNewDealAction = createEvent();
export const setActiveDealAction = createEvent<string>();

connect({ clock: addNewDealAction, target: addNewDealEffect });

/**
 * The deals by id, in tab order (key order) — the same shape as groups and
 * products. A deal is a model, not data: the store holds references to its
 * units, and a deal's own changes happen in its own stores, never here.
 */
export const $deals = createStore<Record<string, DealStore>>({}).on(
  addNewDealEffect.doneData,
  (deals, { dealId, deal }) => ({ ...deals, [dealId]: deal }),
);

export const $activeDealId = createStore("")
  .on(addNewDealEffect.doneData, (_, { dealId }) => dealId)
  .on(setActiveDealAction, (_, dealId) => dealId);
