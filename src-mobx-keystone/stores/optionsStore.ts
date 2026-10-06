import { observable } from "mobx";
import { type Frozen, Model, frozen, model, modelAction, prop } from "mobx-keystone";
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
@model("dealEditor/Options")
class Options extends Model({
  /** Loaded options per source and parameter (see `optionsKey`): one immutable value. */
  byKey: prop<Frozen<Record<string, OptionsState>>>(() => frozen({})),
}) {
  /** Outside the snapshot: time travel never brings back a load that isn't running. */
  private readonly loads = observable.box(0);

  /** Loads in flight. */
  get pending() {
    return this.loads.get();
  }

  /** (Re)loads. */
  async load(source: OptionsSource, param: string): Promise<void> {
    const key = optionsKey(source, param);
    this.started(key);
    try {
      this.loaded({ source, param }, await source.load(param));
    } catch {
      this.failed(key);
    }
  }

  @modelAction private started(key: string) {
    this.setState(key, optionsLoading(this.byKey.data[key]));
    this.loads.set(this.loads.get() + 1);
  }

  /**
   * A list arrived: the listeners write first, while the load still counts
   * as pending, in this one action, so autocalc sees the reconciled deal only.
   */
  @modelAction private loaded(request: OptionsRequest, options: readonly Option[]) {
    listeners.forEach((listener) => listener(request, options));
    const key = optionsKey(request.source, request.param);
    this.setState(key, optionsLoaded(this.byKey.data[key], options));
    this.loads.set(this.loads.get() - 1);
  }

  @modelAction private failed(key: string) {
    this.setState(key, optionsFailed(this.byKey.data[key]));
    this.loads.set(this.loads.get() - 1);
  }

  /** Unchanged states come back as the same object: nothing to write, nothing notified. */
  private setState(key: string, state: OptionsState) {
    if (this.byKey.data[key] !== state) this.byKey = frozen({ ...this.byKey.data, [key]: state });
  }
}

export const optionsStore = new Options({});
