import { type Store, combine, createEvent, createStore } from "effector";
import type { ReadDeal } from "@shared/dealKeys.ts";
import type { Option } from "@shared/options/optionsSource.ts";
import type { ProductData, ProductUi } from "@shared/products/productRegistry.ts";
import {
  type OptionsRequest,
  type ProductWrite,
  planProductWrites,
  reconcileWrites,
} from "@shared/products/productWrites.ts";
import { type FieldIssues, createIssuesMemo } from "@shared/validation.ts";

const noIssues: FieldIssues = {};

// product data is never changed in place: issues are cached by it, and by the deal values rules read
const validate = createIssuesMemo();

/**
 * A product, as one item of an `@effector/model` collection: its own data
 * store, its issues derived from it (and from the deal values its rules
 * read: `$readDeal`, its deal's), and its own api events. A write to one
 * product touches that product's stores only (by the shared rules); the
 * collection's `$items` view is rebuilt from them, keeping every other item
 * as the same object. Each group builds its collection from it
 * (`keyval(() => createProduct($readDeal))`).
 */
export const createProduct = ($readDeal: Store<ReadDeal>) => {
  const $id = createStore("");
  const $ui = createStore<ProductUi>({ title: "", index: 0 });
  const $data = createStore<ProductData | null>(null);
  // re-validated when this product's data changes, or a deal value (only the fields that read it)
  const $issues = combine($data, $readDeal, (data, readDeal) => (data ? validate(data, readDeal) : noIssues));

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
    state: { id: $id, ui: $ui, data: $data, issues: $issues },
    api: { write, reconcileOptions },
  };
};
