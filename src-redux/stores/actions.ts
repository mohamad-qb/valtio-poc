import { createAction } from "@reduxjs/toolkit";
import { asyncOptionFields } from "@shared/fields.ts";
import { type Option, optionsKey } from "@shared/options/optionsSource.ts";
import type { PathWrite } from "@shared/paths.ts";
import type { OptionsRequest } from "@shared/products/productWrites.ts";
import type { GroupState } from "./state.ts";

/**
 * Every action is an event: what happened, as plain data. The reducers of
 * every slice that cares handle it in the same dispatch, so no listener ever
 * sees one slice updated and another not yet (e.g. a write that starts
 * loading options: the edit and the pending load land together).
 */

/** One list of options to load, its source by id: actions carry plain data only. */
export type OptionsKeyRequest = { sourceId: string; param: string };

/**
 * `pending`: the options loads in flight once the action is handled. They
 * are counted where they start and settle (`thunks.ts`), not in the state,
 * so a state the DevTools restore mid-load is corrected by the next action.
 */
type Pending = { pending: number };

const sources = new Map(asyncOptionFields.map(({ options }) => [options.source.id, options.source]));
export const sourceOf = (sourceId: string) => sources.get(sourceId)!;
export const keyOf = ({ sourceId, param }: OptionsKeyRequest) => optionsKey(sourceOf(sourceId), param);
export const toKeyRequests = (requests: readonly OptionsRequest[]): OptionsKeyRequest[] =>
  requests.map(({ source, param }) => ({ sourceId: source.id, param }));

/** `requests`: the options it starts loading (its deal column's). */
export const dealAdded = createAction<{ dealId: string; requests: OptionsKeyRequest[] } & Pending>("deals/dealAdded");

/** A group built (new ids, or a clone's), inserted at `position`. */
export const groupInserted = createAction<
  {
    dealId: string;
    position: number;
    group: GroupState;
    requests: OptionsKeyRequest[];
  } & Pending
>("deals/groupInserted");

export const groupRemoved = createAction<{ dealId: string; groupId: string }>("deals/groupRemoved");

/**
 * A batch of path writes, as written: the reducer routes it by the shared
 * rules, from the deal it applies to, so replaying or skipping an action
 * keeps the deal and its products in step. `requests`: the options it reloads.
 */
export const pathsWritten = createAction<
  {
    dealId: string;
    writes: readonly PathWrite[];
    requests: OptionsKeyRequest[];
  } & Pending
>("deals/pathsWritten");

export const calculationStarted = createAction<{ dealId: string; requestId: number }>("deals/calculationStarted");
export const calculationSucceeded = createAction<{ dealId: string; requestId: number; price: number }>(
  "deals/calculationSucceeded",
);
export const calculationFailed = createAction<{ dealId: string; requestId: number }>("deals/calculationFailed");

export const optionsReceived = createAction<OptionsKeyRequest & { options: readonly Option[] } & Pending>(
  "options/received",
);
export const optionsRequestFailed = createAction<OptionsKeyRequest & Pending>("options/requestFailed");
