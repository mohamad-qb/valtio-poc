import type { DealFieldsState } from "@shared/dealFields.ts";
import { type GroupType, groupDefinitions, groupTitle, productUi } from "@shared/groups.ts";
import { uuid } from "@shared/lib/uuid.ts";
import { type ProductState, createProduct } from "./productStore.ts";

export type GroupState = {
  id: string;
  groupType: GroupType;
  ui: { title: string; index: number }; // derived from the group's position
  /** The group's products by id, in display order; fixed at creation. */
  products: Record<string, ProductState>;
};

/** The deal's groups by id, in display order (key order). */
export type GroupsState = Record<string, GroupState>;

export type CreatedGroup = {
  group: GroupState;
  position: number;
};

/** A product, by its group and its own id. */
export const productOf = (groups: GroupsState, groupId: string, productId: string) =>
  groups[groupId]?.products[productId];

/** Every product of every group, in display order. */
export const productsOf = (groups: GroupsState) =>
  Object.values(groups).flatMap((group) => Object.values(group.products));

/** Updates every value; the same object if none changed. */
const mapValues = <T>(record: Record<string, T>, update: (value: T) => T) => {
  let changed = false;
  const next: Record<string, T> = {};
  for (const [id, value] of Object.entries(record)) {
    next[id] = update(value);
    if (next[id] !== value) changed = true;
  }
  return changed ? next : record; // same object: no update, no re-render
};

/**
 * Updates every product of every group. Only the groups with a changed
 * product are copied; the others, and their products, keep their identity.
 */
export const mapProducts = (
  groups: GroupsState,
  update: (product: ProductState) => ProductState,
) =>
  mapValues(groups, (group) => {
    const products = mapValues(group.products, update);
    return products === group.products ? group : { ...group, products };
  });

/**
 * Builds a group and its products, with new ids. `source` (a group to clone)
 * has its products copied by position. Products are numbered within the group.
 */
const buildGroup = (
  groupType: GroupType,
  defaults: DealFieldsState,
  source?: GroupState,
): GroupState => {
  const sourceProducts = source && Object.values(source.products);
  const products = groupDefinitions[groupType].productTypes.map((productType, index) =>
    createProduct(productType, defaults, productUi(productType, index), sourceProducts?.[index]),
  );
  return {
    id: uuid(),
    groupType,
    ui: { title: "", index: 0 }, // set by reindexGroupsReducer
    products: Object.fromEntries(products.map((product) => [product.id, product])),
  };
};

/** `addGroupAction`: a new group of `groupType`, placed last. */
export const addGroupReducer = (
  { defaults, groups }: { defaults: DealFieldsState; groups: GroupsState },
  groupType: GroupType,
): CreatedGroup => ({
  group: buildGroup(groupType, defaults),
  position: Object.keys(groups).length,
});

/**
 * `cloneGroupAction`: a copy of the group and its products, placed right
 * after the original.
 */
export const cloneGroupReducer = (
  { defaults, groups }: { defaults: DealFieldsState; groups: GroupsState },
  groupId: string,
): CreatedGroup => ({
  group: buildGroup(groups[groupId].groupType, defaults, groups[groupId]),
  position: Object.keys(groups).indexOf(groupId) + 1,
});

/**
 * Re-derives every group's index and title from its position. Groups whose
 * position did not change keep their identity, so their columns don't
 * re-render.
 */
const reindexGroupsReducer = (groups: GroupsState): GroupsState =>
  Object.fromEntries(
    Object.values(groups).map((group, index) => {
      const title = groupTitle(group.groupType, index);
      return [
        group.id,
        group.ui.index === index && group.ui.title === title
          ? group
          : { ...group, ui: { index, title } },
      ];
    }),
  );

/**
 * `groupCreated`: the groups with the new group inserted at its position.
 * Key order is the display order, so inserting rebuilds the object.
 */
export const groupCreatedReducer = (
  groups: GroupsState,
  { group, position }: CreatedGroup,
): GroupsState => {
  const entries = Object.entries(groups);
  entries.splice(position, 0, [group.id, group]);
  return reindexGroupsReducer(Object.fromEntries(entries));
};

/** `removeGroupAction`: the groups without the removed group (and its products). */
export const groupRemovedReducer = (groups: GroupsState, groupId: string): GroupsState => {
  if (!(groupId in groups)) return groups;
  const { [groupId]: _removed, ...rest } = groups;
  void _removed;
  return reindexGroupsReducer(rest);
};
