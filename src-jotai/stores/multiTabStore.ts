import { type PrimitiveAtom, atom, getDefaultStore } from "jotai/vanilla";
import { atomWithStorage } from "jotai/vanilla/utils";
import { type DealStore, createDealStore } from "./dealStore.ts";
import { uuid } from "@shared/lib/uuid.ts";

const store = getDefaultStore();

export type DevToolsStore = {
  isSpotPriceStreamEnabled: boolean;
  isAutocalcEnabled: boolean;
};

/**
 * localStorage, as JSON, read key by key: one that isn't stored as a boolean
 * (nothing stored, not JSON, `null`, another type) keeps its default. No
 * `subscribe`: with it, the switches would follow other browser tabs, which
 * only the Effector Nested app does.
 */
const devtoolsStorage = {
  getItem: (key: string, defaults: DevToolsStore): DevToolsStore => {
    let stored: Partial<Record<keyof DevToolsStore, unknown>> | null = null;
    try {
      stored = JSON.parse(localStorage.getItem(key) ?? "null");
    } catch {
      // unreadable, or no storage: the defaults
    }
    const read = (name: keyof DevToolsStore) => {
      const value = stored?.[name];
      return typeof value === "boolean" ? value : defaults[name];
    };
    return { isSpotPriceStreamEnabled: read("isSpotPriceStreamEnabled"), isAutocalcEnabled: read("isAutocalcEnabled") };
  },
  setItem: (key: string, value: DevToolsStore) => {
    try {
      localStorage.setItem(key, JSON.stringify(value));
    } catch {
      // storage unavailable (private mode): keep the in-memory value
    }
  },
  removeItem: (key: string) => {
    try {
      localStorage.removeItem(key);
    } catch {
      // storage unavailable: nothing stored
    }
  },
};

// persisted by jotai itself: read at once, saved on every change
const devtoolsAtom = atomWithStorage<DevToolsStore>(
  "jotai-devtools",
  { isSpotPriceStreamEnabled: true, isAutocalcEnabled: true },
  devtoolsStorage,
  { getOnInit: true }, // the stored value from the start, not once something subscribes
);

export type MultiTabStore = {
  devtoolsAtom: typeof devtoolsAtom;
  activeDealIdAtom: PrimitiveAtom<string>;
  dealsAtom: PrimitiveAtom<Record<string, DealStore>>;
  actions: {
    addNewDeal(): void;
    setActiveDeal(activeDealId: string): void;
    toggleSpotPriceStreamEnabled(): void;
    toggleAutocalcEnabled(): void;
  };
};

const addNewDealAtom = atom(null, (_get, set) => {
  const newDealId = uuid();
  // before anything is set: a new deal subscribes, starts loading and adds its group, each flushing the store
  const dealStore = createDealStore(devtoolsAtom);
  // a deal starts with a group: made with it, not when its tab first shows
  dealStore.actions.addNewGroup("VanillaGroup");
  set(multiTabStore.dealsAtom, (deals) => ({ ...deals, [newDealId]: dealStore }));
  set(multiTabStore.activeDealIdAtom, newDealId);
});
const setActiveDealAtom = atom(null, (_get, set, activeDealId: string) => {
  set(multiTabStore.activeDealIdAtom, activeDealId);
});
const toggleSpotPriceStreamEnabledAtom = atom(null, (_get, set) => {
  set(devtoolsAtom, (devtools) => ({ ...devtools, isSpotPriceStreamEnabled: !devtools.isSpotPriceStreamEnabled }));
});
const toggleAutocalcEnabledAtom = atom(null, (_get, set) => {
  set(devtoolsAtom, (devtools) => ({ ...devtools, isAutocalcEnabled: !devtools.isAutocalcEnabled }));
});

// named for the devtools (`devtools.ts`), which report each action by its label
addNewDealAtom.debugLabel = "addNewDeal";
setActiveDealAtom.debugLabel = "setActiveDeal";
toggleSpotPriceStreamEnabledAtom.debugLabel = "toggleSpotPriceStreamEnabled";
toggleAutocalcEnabledAtom.debugLabel = "toggleAutocalcEnabled";

export const multiTabStore: MultiTabStore = {
  devtoolsAtom,
  activeDealIdAtom: atom(""),
  dealsAtom: atom<Record<string, DealStore>>({}),
  actions: {
    addNewDeal: () => store.set(addNewDealAtom),
    setActiveDeal: (activeDealId) => store.set(setActiveDealAtom, activeDealId),
    toggleSpotPriceStreamEnabled: () => store.set(toggleSpotPriceStreamEnabledAtom),
    toggleAutocalcEnabled: () => store.set(toggleAutocalcEnabledAtom),
  },
};
