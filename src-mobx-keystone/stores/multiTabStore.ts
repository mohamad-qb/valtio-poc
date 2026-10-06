import { Model, model, modelAction, onSnapshot, prop, registerRootStore } from "mobx-keystone";
import { Deal, devtoolsContext } from "./dealModel.ts";
import { optionsStore } from "./optionsStore.ts";

const DEVTOOLS_STORAGE_KEY = "mobx-keystone-devtools";

/** App-wide developer settings, persisted to localStorage. */
@model("dealEditor/Devtools")
class Devtools extends Model({
  isSpotPriceStreamEnabled: prop(true),
  isAutocalcEnabled: prop(true),
}) {
  @modelAction toggleSpotPriceStreamEnabled() {
    this.isSpotPriceStreamEnabled = !this.isSpotPriceStreamEnabled;
  }

  @modelAction toggleAutocalcEnabled() {
    this.isAutocalcEnabled = !this.isAutocalcEnabled;
  }
}

type Switches = { isSpotPriceStreamEnabled: boolean; isAutocalcEnabled: boolean };

/** The stored switches, key by key: one missing, unreadable or not a boolean keeps its default. */
const loadSwitches = (): Partial<Switches> => {
  let stored: Partial<Record<keyof Switches, unknown>> = {};
  try {
    const parsed: unknown = JSON.parse(localStorage.getItem(DEVTOOLS_STORAGE_KEY) ?? "{}");
    if (typeof parsed === "object" && parsed !== null) stored = parsed;
  } catch {
    // unreadable (not JSON, or no storage): the defaults
  }
  const switches: Partial<Switches> = {};
  for (const key of ["isSpotPriceStreamEnabled", "isAutocalcEnabled"] as const) {
    const value = stored[key];
    if (typeof value === "boolean") switches[key] = value;
  }
  return switches;
};

/**
 * The open deals, one per tab, the developer settings every deal reads, and
 * the options every deal shares: one tree, so DevTools show one history,
 * every action under its own path in it.
 */
@model("dealEditor/MultiTab")
class MultiTab extends Model({
  devtools: prop(() => new Devtools(loadSwitches())),
  options: prop(() => optionsStore),
  deals: prop<Deal[]>(() => []),
  activeDealId: prop(""),
}) {
  protected onInit() {
    devtoolsContext.set(this, this.devtools);
  }

  /** A new deal, with its first group, in a new tab. */
  @modelAction addNewDeal() {
    const deal = new Deal({});
    this.deals.push(deal);
    deal.addNewGroup("VanillaGroup");
    this.activeDealId = deal.id;
  }

  @modelAction setActiveDeal(activeDealId: string) {
    this.activeDealId = activeDealId;
  }
}

export const multiTabStore = new MultiTab({});
// the root store: deals start their reactions as they join it
registerRootStore(multiTabStore);

onSnapshot(multiTabStore.devtools, ({ isSpotPriceStreamEnabled, isAutocalcEnabled }) => {
  try {
    localStorage.setItem(DEVTOOLS_STORAGE_KEY, JSON.stringify({ isSpotPriceStreamEnabled, isAutocalcEnabled }));
  } catch {
    // storage unavailable (private mode): keep the in-memory value
  }
});
