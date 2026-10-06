import { type StoreApi, createStore } from "zustand/vanilla";
import { devtools } from "zustand/middleware";
import { type DealStore, createDealStore } from "./dealStore.ts";
import { uuid } from "@shared/lib/uuid.ts";

export type DevToolsState = {
  isSpotPriceStreamEnabled: boolean;
  isAutocalcEnabled: boolean;
};

export type DevToolsStore = StoreApi<DevToolsState>;

const DEVTOOLS_STORAGE_KEY = "zustand-devtools";

const devtoolsDefaults: DevToolsState = {
  isSpotPriceStreamEnabled: true,
  isAutocalcEnabled: true,
};

/** The stored switches; one that isn't stored as a boolean (nothing stored, not JSON, `null`, another type) keeps its default. */
const loadDevtools = (): DevToolsState => {
  let stored: Partial<Record<keyof DevToolsState, unknown>> | null = null;
  try {
    stored = JSON.parse(localStorage.getItem(DEVTOOLS_STORAGE_KEY) ?? "null");
  } catch {
    // unreadable, or no storage: the defaults
  }
  const read = (key: keyof DevToolsState) => {
    const value = stored?.[key];
    return typeof value === "boolean" ? value : devtoolsDefaults[key];
  };
  return { isSpotPriceStreamEnabled: read("isSpotPriceStreamEnabled"), isAutocalcEnabled: read("isAutocalcEnabled") };
};

/**
 * App-wide developer settings, persisted to localStorage: loaded before the
 * store is made (so the devtools start from them), saved on every change.
 */
export const devtoolsStore = createStore<DevToolsState>()(
  devtools(loadDevtools, { name: "Devtools (Zustand)", enabled: import.meta.env.DEV }),
);

// in sync, so a reload right after a toggle keeps it
devtoolsStore.subscribe((state) => {
  try {
    localStorage.setItem(DEVTOOLS_STORAGE_KEY, JSON.stringify(state));
  } catch {
    // storage unavailable (private mode): keep the in-memory value
  }
});

export type MultiTabState = {
  activeDealId: string;
  deals: Record<string, DealStore>;
  actions: {
    addNewDeal(): void;
    setActiveDeal(activeDealId: string): void;
    toggleSpotPriceStreamEnabled(): void;
    toggleAutocalcEnabled(): void;
  };
};

export const multiTabStore = createStore<MultiTabState>()(
  devtools(
    (set) => ({
      activeDealId: "",
      deals: {},
      actions: {
        addNewDeal() {
          const dealId = uuid();
          // the deal gets only the settings it reads, not the whole tab store
          const dealStore = createDealStore(devtoolsStore);
          // a deal starts with a group: made with it, not when its tab first shows
          dealStore.getState().actions.addNewGroup("VanillaGroup");
          set((state) => ({ deals: { ...state.deals, [dealId]: dealStore }, activeDealId: dealId }), false, "addNewDeal");
        },
        setActiveDeal(activeDealId: string) {
          set({ activeDealId }, false, "setActiveDeal");
        },
        toggleSpotPriceStreamEnabled() {
          devtoolsStore.setState(
            (state) => ({ isSpotPriceStreamEnabled: !state.isSpotPriceStreamEnabled }),
            false,
            "toggleSpotPriceStreamEnabled",
          );
        },
        toggleAutocalcEnabled() {
          devtoolsStore.setState(
            (state) => ({ isAutocalcEnabled: !state.isAutocalcEnabled }),
            false,
            "toggleAutocalcEnabled",
          );
        },
      },
    }),
    {
      name: "Tabs (Zustand)",
      enabled: import.meta.env.DEV,
      // time travel sets the state back from its JSON: leave out what isn't
      // data (the actions, each deal's store), so a jump keeps the live ones
      serialize: {
        replacer: (key: string, value: unknown) => (key === "actions" || key === "deals" ? undefined : value),
      },
    },
  ),
);
