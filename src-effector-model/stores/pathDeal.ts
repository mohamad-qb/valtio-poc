import { type PathDeal, createChangeHub } from "@shared/pathDeal.ts";
import { noIssues } from "@shared/validation.ts";
import type { DealStore, GroupItem, ProductItem } from "./dealStore.ts";
import { $optionsByKey } from "./optionsStore.ts";

const productsById = (groups: readonly GroupItem[]) =>
  new Map(
    groups.flatMap((group) =>
      group.products.map((product) => [product.id, { groupId: group.id, product }] as const),
    ),
  );

/**
 * An `@effector/model` deal as a `PathDeal`. It already speaks paths
 * (`readPath`, `writePathsAction`); what changed comes from its collection:
 * each product is its own store, so a product that changed is a new item.
 */
export const createPathDeal = (deal: DealStore): PathDeal => {
  // product id → its item, rebuilt only when the groups change
  let indexed: { groups: GroupItem[]; byId: Map<string, { groupId: string; product: ProductItem }> } | null = null;
  const find = (productId: string) => {
    const groups = deal.$groups.getState();
    if (indexed?.groups !== groups) indexed = { groups, byId: productsById(groups) };
    return indexed.byId.get(productId);
  };

  return {
    getGroups: () =>
      deal.$groups.getState().map((group) => ({
        id: group.id,
        title: group.ui.title,
        productIds: group.products.map((product) => product.id),
      })),
    getProduct: (productId) => {
      const found = find(productId);
      return found?.product.data
        ? { groupId: found.groupId, title: found.product.ui.title, data: found.product.data }
        : undefined;
    },
    readPath: deal.readPath,
    writePaths: (writes) => deal.actions.writePathsAction(writes),
    fieldIssues: (productId, fieldId) => deal.$validation.getState()[productId]?.[fieldId] ?? noIssues,
    getSettings: () => deal.$settings.getState(),
    getOptions: () => $optionsByKey.getState(),

    // one set of watchers, however many listeners
    subscribe: createChangeHub((onChange) => {
      let groups = deal.$groups.getState();
      let products = productsById(groups);
      const stops = [
        deal.$groups.updates.watch((next) => {
          // a group added, removed or re-titled: its item's `ui` (or the list) changes
          const sameGroups =
            groups.length === next.length &&
            next.every((group, i) => group.id === groups[i].id && group.ui === groups[i].ui);
          groups = next;
          if (!sameGroups) onChange({ kind: "groups" });
          // a product item is a new object when its data changed (its group mates' issues: the grid's)
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
