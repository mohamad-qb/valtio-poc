import { createEvent, createStore } from "effector";
import type { Option } from "@shared/options/optionsSource.ts";
import type { ProductData, ProductUi } from "@shared/products/productRegistry.ts";
import {
  type OptionsRequest,
  type ProductWrite,
  planProductWrites,
  reconcileWrites,
} from "@shared/products/productWrites.ts";

/**
 * A product, as one item of an `@effector/model` collection: its own data
 * store and its own api events. A write to one product touches that
 * product's stores only (by the shared rules); the collection's `$items`
 * view is rebuilt from them, keeping every other item as the same object.
 * Its issues are the deal's (`$validation`): its rules can read its group
 * mates, which an item can't see. Each group builds its collection from it
 * (`keyval(createProduct)`).
 */
export const createProduct = () => {
  const $id = createStore("");
  const $ui = createStore<ProductUi>({ title: "", index: 0 });
  const $data = createStore<ProductData | null>(null);

  /** Writes into this product, in order. */
  const write = createEvent<readonly ProductWrite[]>();
  /** Options arrived: keep its fields that use them valid. */
  const reconcileOptions = createEvent<{ request: OptionsRequest; options: readonly Option[] }>();
  $data
    .on(write, (data, writes) => (data ? planProductWrites(data, writes).data : data))
    .on(reconcileOptions, (data, { request, options }) =>
      data ? planProductWrites(data, reconcileWrites(data, request, options)).data : data,
    );

  return {
    key: "id" as const,
    state: { id: $id, ui: $ui, data: $data },
    api: { write, reconcileOptions },
  };
};
