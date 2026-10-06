import { readDealKey } from "@shared/dealWrites.ts";
import { groupTitle } from "@shared/groups.ts";
import { getValueByPath } from "@shared/lib/path.ts";
import { type PathDeal, createChangeHub } from "@shared/pathDeal.ts";
import { parsePath } from "@shared/paths.ts";
import { noIssues } from "@shared/validation.ts";
import { groupRemoved } from "./actions.ts";
import { issuesOf } from "./selectors.ts";
import type { DealState } from "./state.ts";
import type { AppStore } from "./store.ts";
import { addGroup, cloneGroup, spotStreamOf, writePaths } from "./thunks.ts";

/** Each product's group, by product id. */
const groupsByProduct = (deal: DealState) =>
  new Map(deal.groupIds.flatMap((groupId) => deal.groups[groupId].productIds.map((id) => [id, groupId] as const)));

/**
 * A Redux deal as a `PathDeal`. Its state already has the paths' shape
 * (`groups.<groupId>.products.<productId>.data…`); writes are dispatched.
 * Reducers copy only the path to what changed, so what changed is found by
 * identity: a product whose data is a new object (its issues follow from it).
 */
export const createPathDeal = (store: AppStore, dealId: string): PathDeal => {
  const dealOf = () => store.getState().deals[dealId];

  // product id → group id, rebuilt only when the groups change (a new `groupIds`)
  let indexed: { groupIds: readonly string[]; groupOf: Map<string, string> } | null = null;
  const findProduct = (productId: string) => {
    const deal = dealOf();
    if (indexed?.groupIds !== deal.groupIds) indexed = { groupIds: deal.groupIds, groupOf: groupsByProduct(deal) };
    const groupId = indexed.groupOf.get(productId);
    const product = groupId === undefined ? undefined : deal.groups[groupId]?.products[productId];
    return product && { groupId: groupId!, product };
  };

  const subscribeToDeal = createChangeHub((emit) => {
    let previous = store.getState();
    const onStoreChange = () => {
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
    };
    return store.subscribe(() => {
      // a listener that throws must not abort the dispatch: the listener middleware (autocalc) runs after it
      try {
        onStoreChange();
      } catch (error) {
        console.error(error);
      }
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
      return (found && issuesOf(found.product.data)[fieldId]) ?? noIssues;
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
