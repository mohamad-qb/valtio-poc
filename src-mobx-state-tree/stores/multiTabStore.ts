import { onSnapshot, types } from "mobx-state-tree";
import { Deal, type DealEnv } from "./dealModel.ts";

const DEVTOOLS_STORAGE_KEY = "mobx-state-tree-devtools";

/** App-wide developer settings, persisted to localStorage. */
const Devtools = types
  .model("Devtools", {
    isSpotPriceStreamEnabled: true,
    isAutocalcEnabled: true,
  })
  .actions((self) => ({
    toggleSpotPriceStreamEnabled() {
      self.isSpotPriceStreamEnabled = !self.isSpotPriceStreamEnabled;
    },
    toggleAutocalcEnabled() {
      self.isAutocalcEnabled = !self.isAutocalcEnabled;
    },
  }));

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

export const devtools = Devtools.create(loadSwitches());

onSnapshot(devtools, (snapshot) => {
  try {
    localStorage.setItem(DEVTOOLS_STORAGE_KEY, JSON.stringify(snapshot));
  } catch {
    // storage unavailable (private mode): keep the in-memory value
  }
});

/** The open deals, one per tab. */
const MultiTab = types
  .model("MultiTab", {
    deals: types.array(Deal),
    activeDealId: "",
  })
  .actions((self) => ({
    /** A new deal, with its first group, in a new tab. */
    addNewDeal() {
      self.deals.push({});
      const deal = self.deals[self.deals.length - 1];
      deal.addNewGroup("VanillaGroup");
      self.activeDealId = deal.id;
    },
    setActiveDeal(activeDealId: string) {
      self.activeDealId = activeDealId;
    },
  }));

// every deal in the tree reads the developer settings from its environment
export const multiTabStore = MultiTab.create({}, { devtools } satisfies DealEnv);
