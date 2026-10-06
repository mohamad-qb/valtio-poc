import { observable } from "mobx";
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

/** What a deal does with a list that arrived: reconcile its products still on that parameter. */
export type OptionsListener = (request: OptionsRequest, options: readonly Option[]) => void;

export type OptionsStore = {
  /** Loaded options per source and parameter (see `optionsKey`). */
  byKey: Record<string, OptionsState>;
  /** Loads in flight. */
  pending: number;
  /**
   * Hears every list that arrives, whichever deal asked: the lists are shared,
   * so no deal may keep a value its list no longer offers. Returns the unsubscribe.
   */
  onLoaded(listener: OptionsListener): () => void;
  /** (Re)loads. */
  load(source: OptionsSource, param: string): Promise<void>;
  /**
   * A list arrived: the listeners write first, while the load still counts as
   * pending, in this one action, so autocalc sees the reconciled deal only.
   */
  loaded(request: OptionsRequest, options: readonly Option[]): void;
  failed(key: string): void;
};

const listeners = new Set<OptionsListener>();

/** Every async dropdown's options, shared by every deal. */
export const optionsStore: OptionsStore = observable<OptionsStore>(
  {
    byKey: {},
    pending: 0,
    onLoaded(listener) {
      listeners.add(listener);
      return () => void listeners.delete(listener);
    },
    async load(source, param) {
      const key = optionsKey(source, param);
      optionsStore.pending += 1;
      // unchanged states are written back as the same object: no reaction
      optionsStore.byKey[key] = optionsLoading(optionsStore.byKey[key]);
      try {
        // after an `await` we're outside the action: the result goes through one
        optionsStore.loaded({ source, param }, await source.load(param));
      } catch {
        optionsStore.failed(key);
      }
    },
    loaded(request, options) {
      listeners.forEach((listener) => listener(request, options));
      const key = optionsKey(request.source, request.param);
      optionsStore.byKey[key] = optionsLoaded(optionsStore.byKey[key], options);
      optionsStore.pending -= 1;
    },
    failed(key) {
      optionsStore.byKey[key] = optionsFailed(optionsStore.byKey[key]);
      optionsStore.pending -= 1;
    },
  },
  { onLoaded: false },
  { autoBind: true, name: "Options" },
);
