import { proxy, subscribe } from "valtio";
import { type DealStore, createDealStore } from "./dealStore.ts";
import { uuid } from "@shared/lib/uuid.ts";

export type DevToolsStore = {
  isSpotPriceStreamEnabled: boolean;
  isAutocalcEnabled: boolean;
};

const DEVTOOLS_STORAGE_KEY = "valtio-devtools";

const devtoolsDefaults: DevToolsStore = {
  isSpotPriceStreamEnabled: true,
  isAutocalcEnabled: true,
};

/** The stored switches; one that isn't stored as a boolean (nothing stored, not JSON, `null`, another type) keeps its default. */
const loadDevtools = (): DevToolsStore => {
  let stored: Partial<Record<keyof DevToolsStore, unknown>> | null = null;
  try {
    stored = JSON.parse(localStorage.getItem(DEVTOOLS_STORAGE_KEY) ?? "null");
  } catch {
    // unreadable, or no storage: the defaults
  }
  const read = (key: keyof DevToolsStore) => {
    const value = stored?.[key];
    return typeof value === "boolean" ? value : devtoolsDefaults[key];
  };
  return { isSpotPriceStreamEnabled: read("isSpotPriceStreamEnabled"), isAutocalcEnabled: read("isAutocalcEnabled") };
};

/** App-wide developer settings, persisted to localStorage: loaded now, saved as they change. */
export const devtoolsStore = proxy<DevToolsStore>(loadDevtools());

// in sync, so a reload right after a toggle keeps it
subscribe(
  devtoolsStore,
  () => {
    try {
      localStorage.setItem(DEVTOOLS_STORAGE_KEY, JSON.stringify(devtoolsStore));
    } catch {
      // storage unavailable (private mode): keep the in-memory value
    }
  },
  true,
);

export type MultiTabStore = {
  devtools: DevToolsStore;
  activeDealId: string;
  deals: Record<string, DealStore>;
  actions: {
    addNewDeal(): void;
    setActiveDeal(activeDealId: string): void;
    toggleSpotPriceStreamEnabled(): void;
    toggleAutocalcEnabled(): void;
  };
};

export const multiTabStore = proxy<MultiTabStore>({
  devtools: devtoolsStore,
  activeDealId: "",
  deals: {},
  actions: {
    addNewDeal() {
      const dealId = uuid();
      const dealStore = createDealStore();
      // a deal starts with a group: made with it, not when its tab first shows
      dealStore.actions.addNewGroup("VanillaGroup");
      multiTabStore.deals[dealId] = dealStore;
      multiTabStore.activeDealId = dealId;
    },
    setActiveDeal(activeDealId: string) {
      multiTabStore.activeDealId = activeDealId;
    },
    toggleSpotPriceStreamEnabled() {
      devtoolsStore.isSpotPriceStreamEnabled =
        !devtoolsStore.isSpotPriceStreamEnabled;
    },
    toggleAutocalcEnabled() {
      devtoolsStore.isAutocalcEnabled = !devtoolsStore.isAutocalcEnabled;
    },
  },
});
