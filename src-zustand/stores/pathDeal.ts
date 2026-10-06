import { syncedFieldIds } from "@shared/dealFields.ts";
import { dealSettings } from "@shared/dealSettings.ts";
import { readDealKey } from "@shared/dealWrites.ts";
import { getValueByPath } from "@shared/lib/path.ts";
import { type PathDeal, createChangeHub } from "@shared/pathDeal.ts";
import { parsePath } from "@shared/paths.ts";
import { noIssues } from "@shared/validation.ts";
import type { DealStore } from "./dealStore.ts";
import { optionsStore } from "./optionsStore.ts";
import { issuesOf } from "./validation.ts";

/**
 * A zustand deal as a `PathDeal`. Its state already has the paths' shape
 * (`groups.<groupId>.products.<productId>.data…`); writes are the deal's
 * `writePaths`. Writes copy only the path to what changed, so what changed
 * is found by identity: a product whose data is a new object (its issues
 * follow from it, `issuesOf`).
 */
export const createPathDeal = (dealStore: DealStore): PathDeal => {
  // product id → group id, rebuilt when the group order changes (a group's products never do)
  const groupOf = new Map<string, string>();
  let indexed: readonly string[] | undefined;
  const findProduct = (productId: string) => {
    const { groupIds, groups } = dealStore.getState();
    if (groupIds !== indexed) {
      indexed = groupIds;
      groupOf.clear();
      for (const groupId of groupIds) {
        for (const id of groups[groupId].productIds) groupOf.set(id, groupId);
      }
    }
    const groupId = groupOf.get(productId);
    if (groupId === undefined) return undefined;
    const product = groups[groupId]?.products[productId];
    return product && { groupId, product };
  };

  const subscribeToDeal = createChangeHub((emit) => {
    // compared with what this listener saw last, not with zustand's `prev`:
    // when an earlier listener sets the state again (autocalc), this one is
    // called for the newer state first, then once more with an older `prev`
    let previous = dealStore.getState();
    const stopDeal = dealStore.subscribe((state) => {
      const before = previous;
      previous = state;
      // groups are added and removed through the order, which re-titles them in the same `set`
      if (state.groupIds !== before.groupIds) emit({ kind: "groups" });
      if (state.groups !== before.groups) {
        const ids = state.groupIds.flatMap((groupId) => {
          const group = state.groups[groupId];
          return group.productIds.filter((productId) => {
            const was = before.groups[groupId]?.products[productId];
            return was && was.data !== group.products[productId].data;
          });
        });
        if (ids.length) emit({ kind: "products", ids });
      }
      if (syncedFieldIds.some((id) => !Object.is(state[id], before[id]))) emit({ kind: "dealFields" });
      if (dealSettings.some(({ id }) => !Object.is(state[id], before[id]))) emit({ kind: "settings" });
    });

    let previousOptions = optionsStore.getState().byKey;
    const stopOptions = optionsStore.subscribe(({ byKey }) => {
      if (byKey === previousOptions) return;
      previousOptions = byKey;
      emit({ kind: "options" });
    });

    return () => {
      stopDeal();
      stopOptions();
    };
  });

  return {
    getGroups: () => {
      const { groupIds, groups } = dealStore.getState();
      return groupIds.map((id) => ({ id, title: groups[id].ui.title, productIds: groups[id].productIds }));
    },
    getProduct: (productId) => {
      const found = findProduct(productId);
      return found && { groupId: found.groupId, title: found.product.ui.title, data: found.product.data };
    },
    readPath: (path) => {
      const target = parsePath(path);
      if (!target) return undefined;
      const state = dealStore.getState();
      if (target.kind === "deal") return readDealKey(target.key, state, state);
      const product = state.groups[target.groupId]?.products[target.productId];
      return product && getValueByPath(product.data, target.dataPath);
    },
    writePaths: (writes) => dealStore.getState().actions.writePaths(writes),
    fieldIssues: (productId, fieldId) => {
      const found = findProduct(productId);
      return (found && issuesOf(found.product.data)[fieldId]) ?? noIssues;
    },
    getSettings: () => {
      const { isInternal, hedgeType } = dealStore.getState();
      return { isInternal, hedgeType };
    },
    getOptions: () => optionsStore.getState().byKey,
    subscribe: subscribeToDeal,
    addGroup: (groupType) => dealStore.getState().actions.addNewGroup(groupType),
    cloneGroup: (groupId) => dealStore.getState().actions.cloneGroup(groupId),
    removeGroup: (groupId) => dealStore.getState().actions.removeGroup(groupId),
    spotPriceStream: dealStore.getState().spotPriceStream,
  };
};
