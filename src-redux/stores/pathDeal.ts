import { readDealKey } from "@shared/dealWrites.ts";
import { groupTitle } from "@shared/groups.ts";
import { getValueByPath } from "@shared/lib/path.ts";
import { type PathDeal, createChangeHub } from "@shared/pathDeal.ts";
import { parsePath } from "@shared/paths.ts";
import { noIssues } from "@shared/validation.ts";
import { groupRemoved } from "./actions.ts";
import { issuesOf } from "./selectors.ts";
import type { AppStore } from "./store.ts";
import { addGroup, cloneGroup, spotStreamOf, writePaths } from "./thunks.ts";

/**
 * A Redux deal as a `PathDeal`. Its state already has the paths' shape
 * (`groups.<groupId>.products.<productId>.data…`); writes are dispatched.
 * Reducers copy only the path to what changed, so what changed is found by
 * identity: a product whose data is a new object (its issues follow from it).
 */
export const createPathDeal = (store: AppStore, dealId: string): PathDeal => {
  const dealOf = () => store.getState().deals[dealId];

  const findProduct = (productId: string) => {
    const deal = dealOf();
    for (const groupId of deal.groupIds) {
      const product = deal.groups[groupId].products[productId];
      if (product) return { groupId, product };
    }
    return undefined;
  };

  const subscribeToDeal = createChangeHub((emit) => {
    let previous = store.getState();
    return store.subscribe(() => {
      const state = store.getState();
      const before = previous.deals[dealId];
      const after = state.deals[dealId];
      const optionsBefore = previous.options.byKey;
      previous = state;
      if (state.options.byKey !== optionsBefore) emit({ kind: "options" });
      if (!after || !before || after === before) return;
      // titles follow from the order: a new order is new titles
      if (after.groupIds !== before.groupIds) emit({ kind: "groups" });
      const ids = after.groupIds.flatMap((groupId) => {
        const group = after.groups[groupId];
        return group.productIds.filter((productId) => {
          const was = before.groups[groupId]?.products[productId];
          return was && was.data !== group.products[productId].data;
        });
      });
      if (ids.length) emit({ kind: "products", ids });
      if (after.dealFields !== before.dealFields) emit({ kind: "dealFields" });
      if (after.settings !== before.settings) emit({ kind: "settings" });
    });
  });

  return {
    getGroups: () => {
      const { groupIds, groups } = dealOf();
      return groupIds.map((id, index) => ({
        id,
        title: groupTitle(groups[id].groupType, index),
        productIds: groups[id].productIds,
      }));
    },
    getProduct: (productId) => {
      const found = findProduct(productId);
      return found && { groupId: found.groupId, title: found.product.ui.title, data: found.product.data };
    },
    readPath: (path) => {
      const target = parsePath(path);
      if (!target) return undefined;
      const { dealFields, settings, groups } = dealOf();
      if (target.kind === "deal") return readDealKey(target.key, dealFields, settings);
      const product = groups[target.groupId]?.products[target.productId];
      return product && getValueByPath(product.data, target.dataPath);
    },
    writePaths: (writes) => store.dispatch(writePaths(dealId, writes)),
    fieldIssues: (productId, fieldId) => {
      const found = findProduct(productId);
      return (found && issuesOf(dealOf(), found.product.data)[fieldId]) ?? noIssues;
    },
    getSettings: () => dealOf().settings,
    getOptions: () => store.getState().options.byKey,
    subscribe: subscribeToDeal,
    addGroup: (groupType) => store.dispatch(addGroup(dealId, groupType)),
    cloneGroup: (groupId) => store.dispatch(cloneGroup(dealId, groupId)),
    removeGroup: (groupId) => store.dispatch(groupRemoved({ dealId, groupId })),
    spotPriceStream: store.dispatch(spotStreamOf(dealId)),
  };
};
