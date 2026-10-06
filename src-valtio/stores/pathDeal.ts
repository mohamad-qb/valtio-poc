import { snapshot, subscribe } from "valtio";
import { subscribeKey } from "valtio/utils";
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
 * A valtio deal as a `PathDeal`. Reads go straight to the proxies; writes
 * are the deal's `writePaths`. Changes are watched per product: one
 * subscription on each product's data, so a write notifies only its own
 * product, whatever it replaced inside it. Issues follow from the data
 * (`issuesOf`): they need no watch of their own.
 */
export const createPathDeal = (dealStore: DealStore): PathDeal => {
  // product id → group id, rebuilt when the group order changes (a group's products never do)
  const groupOf = new Map<string, string>();
  let indexed: readonly string[] | undefined;
  const findProduct = (productId: string) => {
    const order = snapshot(dealStore.groupIds); // the same object until the order changes
    if (order !== indexed) {
      indexed = order;
      groupOf.clear();
      for (const groupId of order) {
        for (const id of dealStore.groups[groupId].productIds) groupOf.set(id, groupId);
      }
    }
    const groupId = groupOf.get(productId);
    if (groupId === undefined) return undefined;
    const product = dealStore.groups[groupId]?.products[productId];
    return product && { groupId, product };
  };

  const subscribeToDeal = createChangeHub((emit) => {
    // each group's products' data, watched while the group is in the deal
    const groupStops = new Map<string, () => void>();
    const watchGroups = () => {
      const current = new Set(dealStore.groupIds);
      for (const groupId of current) {
        if (groupStops.has(groupId)) continue;
        const { products, productIds } = dealStore.groups[groupId];
        const stops = productIds.map((productId) =>
          subscribe(products[productId].data, () => emit({ kind: "products", ids: [productId] })),
        );
        groupStops.set(groupId, () => stops.forEach((stop) => stop()));
      }
      for (const [groupId, stop] of groupStops) {
        if (current.has(groupId)) continue;
        stop();
        groupStops.delete(groupId);
      }
    };
    watchGroups();

    // groups are added and removed through the order, which re-titles them in the same tick
    const stops = [
      subscribe(dealStore.groupIds, () => {
        watchGroups();
        emit({ kind: "groups" });
      }),
      ...syncedFieldIds.map((id) => subscribeKey(dealStore, id, () => emit({ kind: "dealFields" }))),
      ...dealSettings.map(({ id }) => subscribeKey(dealStore, id, () => emit({ kind: "settings" }))),
      subscribe(optionsStore.byKey, () => emit({ kind: "options" })),
    ];
    return () => {
      stops.forEach((stop) => stop());
      groupStops.forEach((stop) => stop());
    };
  });

  return {
    getGroups: () =>
      dealStore.groupIds.map((id) => {
        const group = dealStore.groups[id];
        return { id, title: group.ui.title, productIds: group.productIds };
      }),
    getProduct: (productId) => {
      const found = findProduct(productId);
      return found && { groupId: found.groupId, title: found.product.ui.title, data: found.product.data };
    },
    readPath: (path) => {
      const target = parsePath(path);
      if (!target) return undefined;
      if (target.kind === "deal") return readDealKey(target.key, dealStore, dealStore);
      const product = dealStore.groups[target.groupId]?.products[target.productId];
      return product && getValueByPath(product.data, target.dataPath);
    },
    writePaths: (writes) => dealStore.actions.writePaths(writes),
    fieldIssues: (productId, fieldId) => {
      const found = findProduct(productId);
      return (found && issuesOf(found.product.data)[fieldId]) ?? noIssues;
    },
    getSettings: () => ({ isInternal: dealStore.isInternal, hedgeType: dealStore.hedgeType }),
    getOptions: () => optionsStore.byKey,
    subscribe: subscribeToDeal,
    addGroup: (groupType) => dealStore.actions.addNewGroup(groupType),
    cloneGroup: (groupId) => dealStore.actions.cloneGroup(groupId),
    removeGroup: (groupId) => dealStore.actions.removeGroup(groupId),
    spotPriceStream: dealStore.spotPriceStream,
  };
};
