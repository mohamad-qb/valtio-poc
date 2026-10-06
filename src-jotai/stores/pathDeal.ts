import { getDefaultStore } from "jotai/vanilla";
import { readDealKey } from "@shared/dealWrites.ts";
import type { ProductFieldId } from "@shared/fields.ts";
import { getValueByPath } from "@shared/lib/path.ts";
import { type PathDeal, createChangeHub } from "@shared/pathDeal.ts";
import { parsePath } from "@shared/paths.ts";
import { noIssues } from "@shared/validation.ts";
import type { DealStore } from "./dealStore.ts";
import { optionsStore } from "./optionsStore.ts";

const store = getDefaultStore();

/**
 * A jotai deal as a `PathDeal`. Reads are `store.get`; writes are the deal's
 * `writePaths`. Changes are watched per atom: each product's data on its own
 * atom, so a write notifies only its own product. A product's issues follow
 * from its data alone: they change with it, and need no watch of their own.
 */
export const createPathDeal = (dealStore: DealStore): PathDeal => {
  // product id → group id, rebuilt when the group order changes (a group's products never do)
  const groupOf = new Map<string, string>();
  let indexed: readonly string[] | undefined;
  const findProduct = (productId: string) => {
    const groupIds = store.get(dealStore.groupIdsAtom);
    const groups = store.get(dealStore.groupsAtom);
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
    // each product's data atom, watched while the product is in the deal
    const productStops = new Map<string, () => void>();
    const watchProducts = () => {
      const current = new Set<string>();
      for (const groupId of store.get(dealStore.groupIdsAtom)) {
        const group = store.get(dealStore.groupsAtom)[groupId];
        for (const productId of group.productIds) {
          current.add(productId);
          if (productStops.has(productId)) continue;
          const { dataAtom } = group.products[productId];
          productStops.set(productId, store.sub(dataAtom, () => emit({ kind: "products", ids: [productId] })));
        }
      }
      for (const [productId, stop] of productStops) {
        if (current.has(productId)) continue;
        stop();
        productStops.delete(productId);
      }
    };
    watchProducts();

    // groups are added and removed through the order, which re-titles them in the same batch
    const stops = [
      store.sub(dealStore.groupIdsAtom, () => {
        watchProducts();
        emit({ kind: "groups" });
      }),
      store.sub(dealStore.dealFieldsAtom, () => emit({ kind: "dealFields" })),
      store.sub(dealStore.settingsAtom, () => emit({ kind: "settings" })),
      store.sub(optionsStore.byKeyAtom, () => emit({ kind: "options" })),
    ];
    return () => {
      stops.forEach((stop) => stop());
      productStops.forEach((stop) => stop());
    };
  });

  return {
    getGroups: () => {
      const groups = store.get(dealStore.groupsAtom);
      return store.get(dealStore.groupIdsAtom).map((id) => {
        const group = groups[id];
        return { id, title: store.get(group.uiAtom).title, productIds: group.productIds };
      });
    },
    getProduct: (productId) => {
      const found = findProduct(productId);
      return found && { groupId: found.groupId, title: found.product.ui.title, data: store.get(found.product.dataAtom) };
    },
    readPath: (path) => {
      const target = parsePath(path);
      if (!target) return undefined;
      if (target.kind === "deal") {
        return readDealKey(target.key, store.get(dealStore.dealFieldsAtom), store.get(dealStore.settingsAtom));
      }
      const product = store.get(dealStore.groupsAtom)[target.groupId]?.products[target.productId];
      return product && getValueByPath(store.get(product.dataAtom), target.dataPath);
    },
    writePaths: (writes) => dealStore.actions.writePaths(writes),
    fieldIssues: (productId, fieldId: ProductFieldId) => {
      const found = findProduct(productId);
      return (found && store.get(found.product.issuesAtom)[fieldId]) || noIssues;
    },
    getSettings: () => store.get(dealStore.settingsAtom),
    getOptions: () => store.get(optionsStore.byKeyAtom),
    subscribe: subscribeToDeal,
    addGroup: (groupType) => dealStore.actions.addNewGroup(groupType),
    cloneGroup: (groupId) => dealStore.actions.cloneGroup(groupId),
    removeGroup: (groupId) => dealStore.actions.removeGroup(groupId),
    spotPriceStream: dealStore.spotPriceStream,
  };
};
