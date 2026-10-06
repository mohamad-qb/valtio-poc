import { type Draft, createReducer, current, isDraft, original } from "@reduxjs/toolkit";
import { calcFailed, calcInputsChanged, calcStarted, calcSucceeded } from "@shared/calc.ts";
import type { ProductData } from "@shared/products/productRegistry.ts";
import { type ProductWrite, planProductWrites, reconcileWrites } from "@shared/products/productWrites.ts";
import {
  calculationFailed,
  calculationStarted,
  calculationSucceeded,
  dealAdded,
  groupInserted,
  groupRemoved,
  optionsReceived,
  pathsWritten,
  sourceOf,
} from "./actions.ts";
import { routedWrites } from "./selectors.ts";
import { type DealState, type ProductState, initialDealState } from "./state.ts";

/** The value as plain data: the shared rules work on plain objects, not drafts. */
const plain = <T,>(value: T): T => (isDraft(value) ? current(value as Draft<T>) : value) as T;

/** Any change to the products (an edit, a group added or removed) outdates the price and supersedes a calculation in flight. */
const inputsChanged = (deal: Draft<DealState>) => {
  deal.calc = calcInputsChanged(deal.calc);
};

/**
 * Replaces a product's data with the shared rules' result, which copies only
 * the objects along the changed paths; the same data (no change at all) is
 * left alone. Whether anything changed.
 */
const applyProductWrites = (product: Draft<ProductState>, writes: readonly ProductWrite[]) => {
  const planned = planProductWrites(plain(product.data) as ProductData, writes);
  if (!planned.changes.length) return false;
  product.data = planned.data;
  return true;
};

const sameValues = <T extends object>(a: T, b: T) =>
  (Object.keys(b) as (keyof T)[]).every((key) => Object.is(a[key], b[key]));

/** Every deal, by id. Pure: ids and options requests come in with the actions. */
export const dealsReducer = createReducer({} as Record<string, DealState>, (builder) =>
  builder
    .addCase(dealAdded, (deals, { payload }) => {
      deals[payload.dealId] = initialDealState();
    })
    .addCase(groupInserted, (deals, { payload: { dealId, position, group } }) => {
      const deal = deals[dealId];
      if (!deal) return;
      deal.groups[group.id] = group;
      deal.groupIds.splice(position, 0, group.id);
      inputsChanged(deal);
    })
    .addCase(groupRemoved, (deals, { payload: { dealId, groupId } }) => {
      const deal = deals[dealId];
      if (!deal?.groups[groupId]) return;
      deal.groupIds.splice(deal.groupIds.indexOf(groupId), 1);
      delete deal.groups[groupId];
      inputsChanged(deal);
    })
    // routed here, from the deal it applies to: the action holds only the writes
    .addCase(pathsWritten, (deals, { payload }) => {
      const deal = deals[payload.dealId];
      if (!deal) return;
      const routed = routedWrites(original(deal) as DealState, payload.writes);
      // replaced only when a value changed: unchanged parts keep their identity
      if (!sameValues(deal.dealFields, routed.dealFields)) deal.dealFields = routed.dealFields;
      if (!sameValues(deal.settings, routed.settings)) deal.settings = routed.settings;
      let changed = false;
      for (const [productId, { groupId, writes }] of routed.products) {
        const product = deal.groups[groupId]?.products[productId];
        if (product && applyProductWrites(product, writes)) changed = true;
      }
      if (changed) inputsChanged(deal);
    })
    // options arrived: products still on that parameter keep their value if
    // it's an option, else take the first (a product since moved on: no
    // writes). Every deal, not only the one that asked: a deal on that
    // parameter would otherwise keep a value the server no longer offers.
    .addCase(optionsReceived, (deals, { payload: { sourceId, param, options } }) => {
      const request = { source: sourceOf(sourceId), param };
      for (const deal of Object.values(deals)) {
        let changed = false;
        for (const group of Object.values(deal.groups)) {
          for (const product of Object.values(group.products)) {
            if (applyProductWrites(product, reconcileWrites(plain(product.data) as ProductData, request, options))) {
              changed = true;
            }
          }
        }
        if (changed) inputsChanged(deal);
      }
    })
    .addCase(calculationStarted, (deals, { payload: { dealId, requestId } }) => {
      const deal = deals[dealId];
      if (deal) deal.calc = calcStarted(deal.calc, requestId);
    })
    // a superseded request's response comes back as the same state: no change
    .addCase(calculationSucceeded, (deals, { payload: { dealId, requestId, price } }) => {
      const deal = deals[dealId];
      if (deal) deal.calc = calcSucceeded(deal.calc, requestId, price);
    })
    .addCase(calculationFailed, (deals, { payload: { dealId, requestId } }) => {
      const deal = deals[dealId];
      if (deal) deal.calc = calcFailed(deal.calc, requestId);
    }),
);
