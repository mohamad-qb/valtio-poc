import { autorun, observable } from "mobx";
import { uuid } from "@shared/lib/uuid.ts";
import { type DealStore, createDealStore } from "./dealStore.ts";

const DEVTOOLS_STORAGE_KEY = "mobx-devtools";

type Switches = { isSpotPriceStreamEnabled: boolean; isAutocalcEnabled: boolean };

export type DevtoolsStore = Switches & {
  toggleSpotPriceStreamEnabled(): void;
  toggleAutocalcEnabled(): void;
};

/** The stored switches, key by key: one missing, unreadable or not a boolean keeps its default. */
const loadSwitches = (defaults: Switches): Switches => {
  let stored: Partial<Record<keyof Switches, unknown>> = {};
  try {
    const parsed: unknown = JSON.parse(localStorage.getItem(DEVTOOLS_STORAGE_KEY) ?? "{}");
    if (typeof parsed === "object" && parsed !== null) stored = parsed;
  } catch {
    // unreadable (not JSON, or no storage): the defaults
  }
  const read = (key: keyof Switches) => {
    const value = stored[key];
    return typeof value === "boolean" ? value : defaults[key];
  };
  return { isSpotPriceStreamEnabled: read("isSpotPriceStreamEnabled"), isAutocalcEnabled: read("isAutocalcEnabled") };
};

/** App-wide developer settings, persisted to localStorage. */
const createDevtoolsStore = (): DevtoolsStore => {
  const devtools = observable<DevtoolsStore>(
    {
      ...loadSwitches({ isSpotPriceStreamEnabled: true, isAutocalcEnabled: true }),
      toggleSpotPriceStreamEnabled() {
        devtools.isSpotPriceStreamEnabled = !devtools.isSpotPriceStreamEnabled;
      },
      toggleAutocalcEnabled() {
        devtools.isAutocalcEnabled = !devtools.isAutocalcEnabled;
      },
    },
    {},
    { autoBind: true, name: "Switches" },
  );

  autorun(() => {
    const settings = {
      isSpotPriceStreamEnabled: devtools.isSpotPriceStreamEnabled,
      isAutocalcEnabled: devtools.isAutocalcEnabled,
    };
    try {
      localStorage.setItem(DEVTOOLS_STORAGE_KEY, JSON.stringify(settings));
    } catch {
      // storage unavailable (private mode): keep the in-memory value
    }
  });

  return devtools;
};

export type MultiTabStore = {
  readonly devtools: DevtoolsStore;
  activeDealId: string;
  deals: Record<string, DealStore>;
  readonly dealIds: string[];
  /** A new deal, with its first group, in a new tab. */
  addNewDeal(): void;
  setActiveDeal(activeDealId: string): void;
};

export const multiTabStore: MultiTabStore = observable<MultiTabStore>(
  {
    devtools: createDevtoolsStore(),
    activeDealId: "",
    deals: {},
    get dealIds() {
      return Object.keys(multiTabStore.deals);
    },
    addNewDeal() {
      const dealId = uuid();
      // the deal gets only the settings it reads, not the whole tab store
      const deal = createDealStore(multiTabStore.devtools);
      deal.addNewGroup("VanillaGroup");
      multiTabStore.deals[dealId] = deal;
      multiTabStore.activeDealId = dealId;
    },
    setActiveDeal(activeDealId) {
      multiTabStore.activeDealId = activeDealId;
    },
  },
  { devtools: false },
  { autoBind: true, name: "Tabs" },
);
