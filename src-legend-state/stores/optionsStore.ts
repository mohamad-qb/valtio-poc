import { batch, observable } from "@legendapp/state";
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

export type OptionsStoreState = {
  /** Loaded options per source and parameter (see `optionsKey`). */
  byKey: Record<string, OptionsState>;
  /** Loads in flight. */
  pending: number;
};

/** Every async dropdown's options, shared by every deal. */
export const options$ = observable<OptionsStoreState>({ byKey: {}, pending: 0 });

/** What a deal does with options as they arrive: reconcile its products. */
export type OnOptionsLoaded = (request: OptionsRequest, options: readonly Option[]) => void;

const reconciles = new Set<OnOptionsLoaded>();

/** Registers a deal's reconcile, called whenever options arrive; returns the unregister. */
export const onOptionsLoaded = (reconcile: OnOptionsLoaded) => {
  reconciles.add(reconcile);
  return () => void reconciles.delete(reconcile);
};

/**
 * (Re)loads. The options are shared, so when they arrive every deal
 * reconciles (not just the one that asked), in the batch that stores them
 * and ends the load: autocalc, which waits for it, never prices data that is
 * about to change.
 */
export const loadOptions = async (source: OptionsSource, param: string): Promise<void> => {
  const entry$ = options$.byKey[optionsKey(source, param)];
  // unchanged states come back as the same object: nothing to write
  const update = (next: OptionsState) => {
    if (next !== entry$.peek()) entry$.set(next);
  };
  batch(() => {
    options$.pending.set((pending) => pending + 1);
    update(optionsLoading(entry$.peek()));
  });
  const options = await source.load(param).catch(() => undefined);
  batch(() => {
    update(options ? optionsLoaded(entry$.peek(), options) : optionsFailed(entry$.peek()));
    if (options) reconciles.forEach((reconcile) => reconcile({ source, param }, options));
    options$.pending.set((pending) => pending - 1);
  });
};
