import { compareStructural, reaction } from "mobx";
import { getSnapshot } from "mobx-keystone";
import { readDealKey } from "@shared/dealWrites.ts";
import { getValueByPath } from "@shared/lib/path.ts";
import { type PathDeal, createChangeHub } from "@shared/pathDeal.ts";
import { parsePath } from "@shared/paths.ts";
import { noIssues } from "@shared/validation.ts";
import type { Deal } from "./dealModel.ts";
import { optionsStore } from "./optionsStore.ts";

/**
 * A keystone deal as a `PathDeal`. Reads go through the models; writes are
 * the deal's `writePaths` action. What changed comes from snapshots:
 * keystone gives a product a new snapshot only when something in it changed.
 */
export const createPathDeal = (deal: Deal): PathDeal => ({
  getGroups: () =>
    deal.groups.map((group) => ({ id: group.id, title: group.title, productIds: group.products.map(({ id }) => id) })),
  getProduct: (productId) => {
    const found = deal.findProduct(productId);
    return found && { groupId: found.group.id, title: found.product.title, data: found.product.data };
  },
  readPath: (path) => {
    const target = parsePath(path);
    if (!target) return undefined;
    if (target.kind === "deal") return readDealKey(target.key, deal, deal);
    const found = deal.findProduct(target.productId);
    return found?.group.id === target.groupId ? getValueByPath(found.product.data, target.dataPath) : undefined;
  },
  writePaths: (writes) => deal.writePaths(writes),
  fieldIssues: (productId, fieldId) => deal.findProduct(productId)?.product.issues[fieldId] ?? noIssues,
  getSettings: () => ({ isInternal: deal.isInternal, hedgeType: deal.hedgeType }),
  getOptions: () => optionsStore.byKey.data,
  subscribe: createChangeHub((emit) => {
    const stops = [
      // groups added, removed or renumbered
      reaction(
        () => deal.groups.map((group) => `${group.id}:${group.title}`),
        () => emit({ kind: "groups" }),
        { equals: compareStructural },
      ),
      // the products whose snapshot changed (their issues come from their data)
      reaction(
        () => new Map(deal.products.map((product) => [product.id, getSnapshot(product)])),
        (now, before) => {
          const ids = [...now.keys()].filter((id) => before.has(id) && now.get(id) !== before.get(id));
          if (ids.length) emit({ kind: "products", ids });
        },
      ),
      reaction(
        () => [deal.notionalCcy, deal.premiumCcy, deal.notionalAmount],
        () => emit({ kind: "dealFields" }),
        { equals: compareStructural },
      ),
      reaction(
        () => [deal.isInternal, deal.hedgeType],
        () => emit({ kind: "settings" }),
        { equals: compareStructural },
      ),
      // a new (frozen) value whenever any options state changed
      reaction(
        () => optionsStore.byKey,
        () => emit({ kind: "options" }),
      ),
    ];
    return () => stops.forEach((stop) => stop());
  }),
  addGroup: (groupType) => deal.addNewGroup(groupType),
  cloneGroup: (groupId) => deal.cloneGroup(groupId),
  removeGroup: (groupId) => deal.removeGroup(groupId),
  spotPriceStream: deal.spotPriceStream,
});
