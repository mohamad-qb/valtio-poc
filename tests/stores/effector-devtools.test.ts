import { afterEach, describe, expect, it, vi } from "vitest";
import { installFakeApi, sleep } from "./support/fakeApi.ts";

/**
 * Both Effector apps report to the Redux DevTools through
 * `@effector/redux-devtools-adapter`, which queues logs for 500 ms and drops
 * the oldest past its queue size. A paste logs hundreds of updates: the
 * apps' adapters must deliver all of them.
 */

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

/** A stand-in for the extension: what each connection was sent. */
const fakeExtension = () => {
  const connections: string[][] = [];
  vi.stubGlobal("__REDUX_DEVTOOLS_EXTENSION__", {
    connect: () => {
      const sent: string[] = [];
      connections.push(sent);
      return { init: () => {}, send: (action: { type: string }) => sent.push(action.type), subscribe: () => () => {} };
    },
  });
  return connections;
};

describe.each(["effector-nested", "effector-model"] as const)("%s: devtools", (app) => {
  it("deliver every log of a burst: a paste, or many groups added", async () => {
    vi.stubGlobal("window", globalThis);
    vi.stubGlobal("location", { search: "" });
    vi.stubGlobal("localStorage", { getItem: () => null, setItem: () => {}, removeItem: () => {} });
    vi.stubGlobal("addEventListener", () => {});
    vi.stubGlobal("removeEventListener", () => {});
    installFakeApi();
    vi.resetModules();
    const connections = fakeExtension();
    if (app === "effector-nested") await import("../../src-effector-nested/devtools.ts");
    else await import("../../src-effector-model/devtools.ts");
    const tabs =
      app === "effector-nested"
        ? await import("../../src-effector-nested/stores/multiTabStore.ts")
        : await import("../../src-effector-model/stores/multiTabStore.ts");
    // the same graph, reported unbatched: everything there is to deliver
    const { attachReduxDevTools } = await import("@effector/redux-devtools-adapter");
    const detach = attachReduxDevTools({ name: "unbatched", trace: true, stateTab: true, batch: false });
    const [delivered, generated] = connections;

    /** Logs generated and delivered for what `run` does (one burst, then the adapter's 500 ms debounce). */
    const burst = async (run: () => void) => {
      const before = { delivered: delivered.length, generated: generated.length };
      run();
      await sleep(700);
      return { delivered: delivered.length - before.delivered, generated: generated.length - before.generated };
    };
    const adding = await burst(() => {
      tabs.addNewDealAction();
      const [deal] = Object.values(tabs.$deals.getState());
      for (let i = 0; i < 20; i += 1) deal.actions.addGroupAction("Strategy");
    });
    const [deal] = Object.values(tabs.$deals.getState());
    // one paste: a strike into each of the 41 products
    // (either app's groups: by id in nested, a list in model; their products the same way)
    type AnyGroup = { id: string; products: Record<string, { id: string }> | { id: string }[] };
    const groups = Object.values(deal.$groups.getState() as Record<string, AnyGroup> | AnyGroup[]);
    const pasting = await burst(() =>
      deal.actions.writePathsAction(
        groups.flatMap((group) =>
          Object.values(group.products).map((product) => ({
            path: `groups.${group.id}.products.${product.id}.data.optionsCommon.strike`,
            value: "1",
          })),
        ),
      ),
    );
    expect(Math.max(adding.generated, pasting.generated)).toBeGreaterThan(100); // more than the adapter's default queue
    expect(adding.delivered).toBe(adding.generated);
    expect(pasting.delivered).toBe(pasting.generated);
    detach();
  });
});
