import { readDealKey } from "@shared/dealWrites.ts";
import { getValueByPath } from "@shared/lib/path.ts";
import { type PathDeal, createChangeHub } from "@shared/pathDeal.ts";
import { parsePath } from "@shared/paths.ts";
import { noIssues } from "@shared/validation.ts";
import type { DealStore } from "./dealStore.ts";
import { type GroupsState, productOf } from "./groupStore.ts";
import { $optionsByKey } from "./optionsStore.ts";
import type { ProductState } from "./productStore.ts";

/** Every product with its group, by product id. */
const productsById = (groups: GroupsState) =>
  new Map(
    Object.values(groups).flatMap((group) =>
      Object.values(group.products).map((product) => [product.id, { groupId: group.id, product }] as const),
    ),
  );

/**
 * A nested effector deal as a `PathDeal`. Its state already has the paths'
 * shape (`<groupId>.products.<productId>.data…`), so a product path reads
 * straight from it. A write copies only the path to what changed, so what
 * changed is found by identity: a group or product that changed is a new
 * object (its issues follow from its data).
 */
export const createPathDeal = (deal: DealStore): PathDeal => {
  // product id → its item, rebuilt only when the groups change
  let indexed: { groups: GroupsState; byId: Map<string, { groupId: string; product: ProductState }> } | null = null;
  const findProduct = (productId: string) => {
    const groups = deal.$groups.getState();
    if (indexed?.groups !== groups) indexed = { groups, byId: productsById(groups) };
    return indexed.byId.get(productId);
  };

  return {
    getGroups: () =>
      Object.values(deal.$groups.getState()).map((group) => ({
        id: group.id,
        title: group.ui.title,
        productIds: Object.keys(group.products),
      })),
    getProduct: (productId) => {
      const found = findProduct(productId);
      return found && { groupId: found.groupId, title: found.product.ui.title, data: found.product.data };
    },
    readPath: (path) => {
      const target = parsePath(path);
      if (!target) return undefined;
      if (target.kind === "deal") return readDealKey(target.key, deal.$dealFields.getState(), deal.$settings.getState());
      const product = productOf(deal.$groups.getState(), target.groupId, target.productId);
      return product && getValueByPath(product.data, target.dataPath);
    },
    writePaths: (writes) => deal.actions.writePathsAction(writes),
    fieldIssues: (productId, fieldId) => deal.$validation.getState()[productId]?.[fieldId] ?? noIssues,
    getSettings: () => deal.$settings.getState(),
    getOptions: () => $optionsByKey.getState(),

    // one set of watchers, however many listeners
    subscribe: createChangeHub((onChange) => {
      let groups = deal.$groups.getState();
      let products = productsById(groups);
      const stops = [
        // a product's issues follow from its data: one report per change
        deal.$groups.updates.watch((next) => {
          // every edit is a new `$groups`: only a group added, removed or re-titled is a column change
          const previous = Object.values(groups);
          const current = Object.values(next);
          groups = next;
          const sameGroups =
            previous.length === current.length &&
            current.every((group, i) => group.id === previous[i].id && group.ui === previous[i].ui);
          if (!sameGroups) onChange({ kind: "groups" });
          const nextProducts = productsById(next);
          const ids = [...nextProducts]
            .filter(([id, { product }]) => products.get(id)?.product !== product)
            .map(([id]) => id);
          products = nextProducts;
          if (ids.length) onChange({ kind: "products", ids });
        }),
        deal.$dealFields.updates.watch(() => onChange({ kind: "dealFields" })),
        deal.$settings.updates.watch(() => onChange({ kind: "settings" })),
        $optionsByKey.updates.watch(() => onChange({ kind: "options" })),
      ];
      return () => stops.forEach((stop) => stop());
    }),

    addGroup: (groupType) => deal.actions.addGroupAction(groupType),
    cloneGroup: (groupId) => deal.actions.cloneGroupAction(groupId),
    removeGroup: (groupId) => deal.actions.removeGroupAction(groupId),
    spotPriceStream: deal.spotPriceStream,
  };
};
