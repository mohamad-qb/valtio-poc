import type { $ZodIssue } from "zod/v4/core";
import type { DealSettingsState } from "./dealSettings.ts";
import type { ProductFieldId } from "./fields.ts";
import type { GroupType } from "./groups.ts";
import type { OptionsState } from "./options/optionsSource.ts";
import type { PathWrite } from "./paths.ts";
import type { ProductData } from "./products/productRegistry.ts";
import type { SpotPriceStream } from "./spotPriceStream.ts";

/**
 * A deal as every app exposes it: read and written by dot path (`paths.ts`),
 * the way the app being migrated works. The grid, the tests and anything
 * else talk to a deal only through this.
 *
 * What differs per state library is behind it: how `writePaths` applies a
 * batch (proxy writes, one action, one event, keyed api calls), and how
 * `subscribe` finds what changed.
 */

export type PathDealGroup = { id: string; title: string; productIds: readonly string[] };

export type PathDealProduct = { groupId: string; title: string; data: ProductData };

/** What changed: the grid repaints the matching cells. */
export type DealChange =
  | { kind: "groups" }
  | { kind: "products"; ids: readonly string[] }
  | { kind: "dealFields" }
  | { kind: "settings" }
  | { kind: "options" };

export type PathDeal = {
  /** The groups, in display order. */
  getGroups(): readonly PathDealGroup[];
  getProduct(productId: string): PathDealProduct | undefined;
  /** The value at a dot path (`undefined` where there is none). */
  readPath(path: string): unknown;
  /** Writes values at dot paths, in order, as one batch. */
  writePaths(writes: readonly PathWrite[]): void;
  /** A product field's issues (schema and rules); none for a field it doesn't have. */
  fieldIssues(productId: string, fieldId: ProductFieldId): readonly $ZodIssue[];
  getSettings(): DealSettingsState;
  /** The loaded dropdown options, per source and parameter. */
  getOptions(): Readonly<Record<string, OptionsState>>;
  subscribe(onChange: (change: DealChange) => void): () => void;
  addGroup(groupType: GroupType): void;
  cloneGroup(groupId: string): void;
  removeGroup(groupId: string): void;
  /** Ticks outside the stores. */
  spotPriceStream: SpotPriceStream;
};

/** A listener's error, rethrown on its own (so it is still reported) once every other listener has heard the change. */
const rethrowLater = (error: unknown) => {
  if (typeof reportError === "function") reportError(error);
  else
    queueMicrotask(() => {
      throw error;
    });
};

/**
 * One set of store subscriptions shared by every listener of a deal: started
 * with the first listener, stopped with the last. `start` subscribes to the
 * stores and reports changes through `emit`.
 *
 * Each subscription is its own entry (the same function subscribed twice is
 * two subscriptions, each ended by its own unsubscribe), and a listener that
 * throws doesn't keep the others from hearing the change: its error is
 * rethrown afterwards. A `start` that throws leaves no listener behind.
 */
export const createChangeHub = (
  start: (emit: (change: DealChange) => void) => () => void,
): PathDeal["subscribe"] => {
  const subscriptions = new Set<{ notify: (change: DealChange) => void }>();
  let stop: (() => void) | null = null;
  const emit = (change: DealChange) =>
    subscriptions.forEach(({ notify }) => {
      try {
        notify(change);
      } catch (error) {
        rethrowLater(error);
      }
    });
  return (listener) => {
    const subscription = { notify: listener };
    subscriptions.add(subscription);
    if (!stop) {
      try {
        stop = start(emit);
      } catch (error) {
        subscriptions.delete(subscription);
        throw error;
      }
    }
    return () => {
      if (!subscriptions.delete(subscription) || subscriptions.size || !stop) return;
      stop();
      stop = null;
    };
  };
};
