import { types } from "mobx-state-tree";
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

const listeners = new Set<OptionsListener>();

/**
 * Hears every list that arrives, whichever deal asked: the lists are shared,
 * so no deal may keep a value its list no longer offers. Returns the unsubscribe.
 */
export const onOptionsLoaded = (listener: OptionsListener) => {
  listeners.add(listener);
  return () => void listeners.delete(listener);
};

/** Every async dropdown's options, shared by every deal. */
const Options = types
  .model("Options", {
    /** Loaded options per source and parameter (see `optionsKey`). */
    byKey: types.frozen<Record<string, OptionsState>>({}),
    /** Loads in flight. */
    pending: 0,
  })
  .actions((self) => {
    /** Unchanged states come back as the same object: nothing to write, nothing notified. */
    const setState = (key: string, state: OptionsState) => {
      if (self.byKey[key] !== state) self.byKey = { ...self.byKey, [key]: state };
    };
    return {
      started(key: string) {
        setState(key, optionsLoading(self.byKey[key]));
        self.pending += 1;
      },
      /**
       * A list arrived: the listeners write first, while the load still counts
       * as pending, in this one action, so autocalc sees the reconciled deal only.
       */
      loaded(request: OptionsRequest, options: readonly Option[]) {
        listeners.forEach((listener) => listener(request, options));
        const key = optionsKey(request.source, request.param);
        setState(key, optionsLoaded(self.byKey[key], options));
        self.pending -= 1;
      },
      failed(key: string) {
        setState(key, optionsFailed(self.byKey[key]));
        self.pending -= 1;
      },
    };
  })
  .actions((self) => ({
    /** (Re)loads. */
    async load(source: OptionsSource, param: string): Promise<void> {
      const key = optionsKey(source, param);
      self.started(key);
      try {
        // after an `await` we're outside the action: changes go through actions
        self.loaded({ source, param }, await source.load(param));
      } catch {
        self.failed(key);
      }
    },
  }));

export const optionsStore = Options.create();
