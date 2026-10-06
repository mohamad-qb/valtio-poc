import {
  type ThunkAction,
  type ThunkDispatch,
  type UnknownAction,
  combineReducers,
  configureStore,
  createListenerMiddleware,
} from "@reduxjs/toolkit";
import type { SpotPriceStream } from "@shared/spotPriceStream.ts";
import { dealsReducer } from "./dealsReducer.ts";
import { type DevtoolsState, devtoolsReducer } from "./devtoolsSlice.ts";
import { optionsReducer } from "./optionsReducer.ts";
import { selectShouldAutocalc } from "./selectors.ts";
import { tabsReducer } from "./tabsSlice.ts";
import { calculate } from "./thunks.ts";

/**
 * What thunks get besides the state: what isn't data. `loads.pending`: the
 * options loads in flight, which a state restored by the DevTools can't know.
 */
export type ThunkExtra = { spotStreams: Map<string, SpotPriceStream>; loads: { pending: number } };

const rootReducer = combineReducers({
  tabs: tabsReducer,
  deals: dealsReducer,
  options: optionsReducer,
  devtools: devtoolsReducer,
});

export type RootState = ReturnType<typeof rootReducer>;
export type AppDispatch = ThunkDispatch<RootState, ThunkExtra, UnknownAction>;
export type AppThunk<R = void> = ThunkAction<R, RootState, ThunkExtra, UnknownAction>;

/**
 * The whole app in one store: every tab's deal, the options, the developer
 * settings — plain data only; issues, titles and readiness are derived from
 * it (`selectors.ts`). So the Redux DevTools (dev builds) show every action
 * with the state after it, and can travel back: there is nothing else to restore.
 */
export const createApp = (devtools: DevtoolsState) => {
  const spotStreams = new Map<string, SpotPriceStream>();
  const listener = createListenerMiddleware<RootState, AppDispatch>();

  const store = configureStore({
    reducer: rootReducer,
    preloadedState: { devtools },
    middleware: (getDefaultMiddleware) =>
      getDefaultMiddleware({
        thunk: { extraArgument: { spotStreams, loads: { pending: 0 } } satisfies ThunkExtra },
      }).prepend(listener.middleware),
    devTools: import.meta.env.DEV && { name: "Deal editor (Redux)" },
  });

  // autocalc: after any action that leaves a deal ready with its price
  // missing or outdated. Calculating marks it calculating, so it runs once
  listener.startListening({
    predicate: (_action, state) => Object.keys(state.deals).some((dealId) => selectShouldAutocalc(state, dealId)),
    effect: (_action, api) => {
      for (const dealId of Object.keys(api.getState().deals)) {
        if (selectShouldAutocalc(api.getState(), dealId)) api.dispatch(calculate(dealId));
      }
    },
  });

  // the spot streams follow their switch (and new deals start with it)
  const unsubscribe = store.subscribe(() => {
    const enabled = store.getState().devtools.isSpotPriceStreamEnabled;
    for (const stream of spotStreams.values()) {
      if (enabled) stream.start();
      else stream.stop();
    }
  });

  return {
    store,
    listener,
    dispose: () => {
      unsubscribe();
      listener.clearListeners();
      spotStreams.forEach((stream) => stream.stop());
    },
  };
};

export type AppStore = ReturnType<typeof createApp>["store"];
