import { proxy } from "valtio";
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

export type OptionsStore = {
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

// kept outside the proxy: functions, never rendered or snapshotted
const reconciles = new Set<OnOptionsLoaded>();

/** Every async dropdown's options, shared by every deal. */
export const optionsStore = proxy<OptionsStore>({
  byKey: {},
  pending: 0,
  actions: {
    /**
     * (Re)loads. The options are shared, so when they arrive every deal
     * reconciles (not just the one that asked), and before they count as
     * loaded: autocalc, which waits for them, never prices data that is
     * about to change.
     */
    async load(source, param) {
      const key = optionsKey(source, param);
      const { byKey } = optionsStore;
      // unchanged states are written back as the same object: no notification
      byKey[key] = optionsLoading(byKey[key]);
      optionsStore.pending += 1;
      try {
        const options = await source.load(param);
        byKey[key] = optionsLoaded(byKey[key], options);
        reconciles.forEach((reconcile) => reconcile({ source, param }, options));
      } catch {
        byKey[key] = optionsFailed(byKey[key]);
      } finally {
        optionsStore.pending -= 1;
      }
    },
    onLoaded(reconcile) {
      reconciles.add(reconcile);
      return () => void reconciles.delete(reconcile);
    },
  },
});
