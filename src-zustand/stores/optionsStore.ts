import { createStore } from "zustand/vanilla";
import { devtools } from "zustand/middleware";
import {
  type Option,
  type OptionsSource,
  type OptionsState,
  optionsFailed,
  optionsKey,
  optionsLoaded,
  optionsLoading,
} from "@shared/options/optionsSource.ts";
import type { OptionsRequest } from "@shared/products/productWrites.ts";

/** What a deal does with options as they arrive: reconcile its products. */
export type OnOptionsLoaded = (request: OptionsRequest, options: readonly Option[]) => void;

export type OptionsStoreState = {
  /** Loaded options per source and parameter (see `optionsKey`). */
  byKey: Record<string, OptionsState>;
  /** Loads in flight. */
  pending: number;
  actions: {
    load(source: OptionsSource, param: string): Promise<void>;
    /** Registers a deal's reconcile, called whenever options arrive; returns the unregister. */
    onLoaded(reconcile: OnOptionsLoaded): () => void;
  };
};

/** `byKey` with a key's new state; an unchanged state keeps the same `byKey`: nothing repaints. */
const withEntry = (byKey: Record<string, OptionsState>, key: string, next: OptionsState) =>
  byKey[key] === next ? byKey : { ...byKey, [key]: next };

// kept out of the state: functions, never shown in the devtools
const reconciles = new Set<OnOptionsLoaded>();

/** Every async dropdown's options, shared by every deal. */
export const optionsStore = createStore<OptionsStoreState>()(
  devtools(
    (set) => ({
      byKey: {},
      pending: 0,
      actions: {
        /**
         * (Re)loads. The options are shared, so when they arrive every deal
         * reconciles (not just the one that asked), and before they count as
         * loaded: two stores can't update together, so the products land
         * first, and autocalc, which waits for the load, never prices data
         * that is about to change.
         */
        async load(source, param) {
          const key = optionsKey(source, param);
          // the entry and the count in one `set`: one notification
          set(
            ({ byKey, pending }) => ({ byKey: withEntry(byKey, key, optionsLoading(byKey[key])), pending: pending + 1 }),
            false,
            "load",
          );
          const options = await source.load(param).catch(() => undefined);
          try {
            if (options) reconciles.forEach((reconcile) => reconcile({ source, param }, options));
          } finally {
            set(
              ({ byKey, pending }) => ({
                byKey: withEntry(byKey, key, options ? optionsLoaded(byKey[key], options) : optionsFailed(byKey[key])),
                pending: pending - 1,
              }),
              false,
              options ? "loaded" : "loadFailed",
            );
          }
        },
        onLoaded(reconcile) {
          reconciles.add(reconcile);
          return () => void reconciles.delete(reconcile);
        },
      },
    }),
    {
      name: "Options (Zustand)",
      enabled: import.meta.env.DEV,
      // time travel sets the state back from its JSON: leave the actions out of it, so they're kept
      serialize: { replacer: (key: string, value: unknown) => (key === "actions" ? undefined : value) },
    },
  ),
);
