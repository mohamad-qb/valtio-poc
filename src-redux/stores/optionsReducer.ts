import { type Draft, createReducer, isAnyOf } from "@reduxjs/toolkit";
import { type OptionsState, optionsFailed, optionsLoaded, optionsLoading } from "@shared/options/optionsSource.ts";
import { dealAdded, groupInserted, keyOf, optionsReceived, optionsRequestFailed, pathsWritten } from "./actions.ts";

export type OptionsStoreState = {
  /** Loaded options per source and parameter (see `optionsKey`). */
  byKey: Record<string, OptionsState>;
  /** Loads in flight, as the last action that started or settled one counted them. */
  pending: number;
};

/** Stores a key's new state (the shared helpers' readonly lists, as the draft types them). */
const setEntry = (state: Draft<OptionsStoreState>, key: string, next: OptionsState) => {
  state.byKey[key] = next as Draft<OptionsState>;
};

/** Every async dropdown's options, shared by every deal. */
export const optionsReducer = createReducer<OptionsStoreState>({ byKey: {}, pending: 0 }, (builder) =>
  builder
    .addCase(optionsReceived, (state, { payload }) => {
      const key = keyOf(payload);
      // unchanged options come back as the same object: no change
      setEntry(state, key, optionsLoaded(state.byKey[key], payload.options));
    })
    .addCase(optionsRequestFailed, (state, { payload }) => {
      const key = keyOf(payload);
      setEntry(state, key, optionsFailed(state.byKey[key]));
    })
    // whatever starts loading options marks them loading in the same dispatch
    .addMatcher(isAnyOf(dealAdded, groupInserted, pathsWritten), (state, { payload: { requests } }) => {
      for (const request of requests) {
        const key = keyOf(request);
        setEntry(state, key, optionsLoading(state.byKey[key]));
      }
    })
    // the count comes with the action, not from the state before it: a state
    // restored mid-load (DevTools commit or import) can't stay "loading" for good
    .addMatcher(
      isAnyOf(dealAdded, groupInserted, pathsWritten, optionsReceived, optionsRequestFailed),
      (state, { payload: { pending } }) => {
        state.pending = pending;
      },
    ),
);
