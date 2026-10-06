import { isAnyOf } from "@reduxjs/toolkit";
import { type DevtoolsState, autocalcToggled, defaultDevtools, spotPriceStreamToggled } from "./devtoolsSlice.ts";
import { createApp } from "./store.ts";

const DEVTOOLS_STORAGE_KEY = "redux-devtools-settings";

/** The stored settings: each one stored as a boolean, else its default (nothing readable: the defaults). */
const loadDevtools = (): DevtoolsState => {
  let stored: unknown = null;
  try {
    stored = JSON.parse(localStorage.getItem(DEVTOOLS_STORAGE_KEY) ?? "null");
  } catch {
    // unparsable, or storage unavailable (private mode): the defaults
  }
  const saved = (typeof stored === "object" && stored !== null ? stored : {}) as Record<string, unknown>;
  const setting = (key: keyof DevtoolsState) => {
    const value = saved[key];
    return typeof value === "boolean" ? value : defaultDevtools[key];
  };
  return { isSpotPriceStreamEnabled: setting("isSpotPriceStreamEnabled"), isAutocalcEnabled: setting("isAutocalcEnabled") };
};

/** The app's store, its developer settings loaded from localStorage. */
export const app = createApp(loadDevtools());

// saved when a switch is flipped: an action, never a DevTools jump (which only shows a past state)
app.listener.startListening({
  matcher: isAnyOf(autocalcToggled, spotPriceStreamToggled),
  effect: (_action, api) => {
    try {
      localStorage.setItem(DEVTOOLS_STORAGE_KEY, JSON.stringify(api.getState().devtools));
    } catch {
      // storage unavailable (private mode): keep the in-memory value
    }
  },
});
