import { type PrimitiveAtom, type Setter, type WritableAtom, atom } from "jotai/vanilla";
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

/** What a deal does with options as they arrive: a write atom that reconciles its products. */
export type ReconcileAtom = WritableAtom<null, [request: OptionsRequest, options: readonly Option[]], void>;

export type OptionsStore = {
  /** Loaded options per source and parameter (see `optionsKey`). */
  byKeyAtom: PrimitiveAtom<Record<string, OptionsState>>;
  /** Loads in flight. */
  pendingAtom: PrimitiveAtom<number>;
  /**
   * (Re)loads. A write atom, not an action: a deal action sets it with its
   * own `set`, so the load is counted (`pendingAtom`) in that action's batch.
   * Once the options arrive, their state, every deal's reconcile and the
   * count are one batch: nothing sees the load done before the deals have
   * used them.
   */
  loadAtom: WritableAtom<null, [source: OptionsSource, param: string], Promise<void>>;
  /** Registers a deal's reconcile, set whenever options arrive; returns the unregister. */
  onLoaded(reconcile: ReconcileAtom): () => void;
};

/** Updates one key's state; an unchanged state keeps the record: no notification. */
const setOptionsState = (set: Setter, key: string, next: (previous: OptionsState | undefined) => OptionsState) =>
  set(optionsStore.byKeyAtom, (byKey) => {
    const state = next(byKey[key]);
    return state === byKey[key] ? byKey : { ...byKey, [key]: state };
  });

const reconciles = new Set<ReconcileAtom>();

/**
 * A load done (`options`: none when it failed), in one batch. The options are
 * shared, so every deal reconciles, not just the one that asked.
 */
const loadDoneAtom = atom(null, (_get, set, request: OptionsRequest, options?: readonly Option[]) => {
  setOptionsState(set, optionsKey(request.source, request.param), (previous) =>
    options ? optionsLoaded(previous, options) : optionsFailed(previous),
  );
  if (options) reconciles.forEach((reconcile) => set(reconcile, request, options));
  set(optionsStore.pendingAtom, (pending) => pending - 1);
});

/** Every async dropdown's options, shared by every deal. */
export const optionsStore: OptionsStore = {
  byKeyAtom: atom<Record<string, OptionsState>>({}),
  pendingAtom: atom(0),
  loadAtom: atom(null, async (_get, set, source: OptionsSource, param: string) => {
    setOptionsState(set, optionsKey(source, param), optionsLoading);
    set(optionsStore.pendingAtom, (pending) => pending + 1);
    const options = await source.load(param).catch(() => undefined);
    // after an `await`, each `set` is a batch of its own: one write atom makes the rest one
    set(loadDoneAtom, { source, param }, options);
  }),
  onLoaded: (reconcile) => {
    reconciles.add(reconcile);
    return () => void reconciles.delete(reconcile);
  },
};
