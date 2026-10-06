import { batch, observable } from "@legendapp/state";
import { uuid } from "@shared/lib/uuid.ts";
import { type DealState, type DealStore, createDealStore, initialDealState } from "./dealStore.ts";

type Devtools = { isSpotPriceStreamEnabled: boolean; isAutocalcEnabled: boolean };

const DEVTOOLS_STORAGE_KEY = "legend-state-devtools";

const devtoolsDefaults: Devtools = { isSpotPriceStreamEnabled: true, isAutocalcEnabled: true };

/** The stored switches; one that isn't stored as a boolean (nothing stored, not JSON, `null`, another type) keeps its default. */
const loadDevtools = (): Devtools => {
  let stored: Partial<Record<keyof Devtools, unknown>> | null = null;
  try {
    stored = JSON.parse(localStorage.getItem(DEVTOOLS_STORAGE_KEY) ?? "null");
  } catch {
    // unreadable, or no storage: the defaults
  }
  const read = (key: keyof Devtools) => {
    const value = stored?.[key];
    return typeof value === "boolean" ? value : devtoolsDefaults[key];
  };
  return { isSpotPriceStreamEnabled: read("isSpotPriceStreamEnabled"), isAutocalcEnabled: read("isAutocalcEnabled") };
};

/** App-wide developer settings, persisted to localStorage: loaded now, saved as they change. */
export const devtools$ = observable(loadDevtools());

// in sync (Legend-State's own persistence saves a tick later), so a reload right after a toggle keeps it
devtools$.onChange(({ value }) => {
  try {
    localStorage.setItem(DEVTOOLS_STORAGE_KEY, JSON.stringify(value));
  } catch {
    // storage unavailable (private mode): keep the in-memory value
  }
});

export type MultiTabState = {
  activeDealId: string;
  dealIds: string[]; // tab order
  /** Every deal's state: the whole app is one tree of plain data (see `devtools.ts`). */
  deals: Record<string, DealState>;
};

export const multiTab$ = observable<MultiTabState>({ activeDealId: "", dealIds: [], deals: {} });

/** Each deal's actions and computeds, by id: not data, so kept beside the tree. */
export const dealStores = new Map<string, DealStore>();

export const addNewDeal = () => {
  const dealId = uuid();
  multiTab$.deals[dealId].set(initialDealState());
  // the deal gets only the settings it reads, and its own branch of the tree
  const deal = createDealStore(devtools$, multiTab$.deals[dealId]);
  // a deal starts with a group: made with it, not when its tab first shows
  deal.addNewGroup("VanillaGroup");
  dealStores.set(dealId, deal);
  batch(() => {
    multiTab$.dealIds.set((ids) => [...ids, dealId]);
    multiTab$.activeDealId.set(dealId);
  });
};

export const setActiveDeal = (dealId: string) => multiTab$.activeDealId.set(dealId);
