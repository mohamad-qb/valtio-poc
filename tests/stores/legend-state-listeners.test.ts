import { afterEach, describe, expect, it, vi } from "vitest";
import { installFakeApi } from "./support/fakeApi.ts";
import { fieldPathIn, installFakeExtension, installLocalStorage } from "./support/reviewHelpers.ts";

// Its own file: in Legend-State 3.0.0-beta.48 a listener that throws inside a
// batch stops every later notification (`endBatch` has no try/finally), and
// that state is the library's own, so it would outlive this test.

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe("legend-state", () => {
  it("an app listener that throws (the DevTools reporter, its extension failing) doesn't stop the library's notifications", async () => {
    installFakeApi();
    const extension = installFakeExtension();
    installLocalStorage({ "legend-state-devtools": JSON.stringify({ isSpotPriceStreamEnabled: false, isAutocalcEnabled: false }) });
    const reported: unknown[] = [];
    vi.stubGlobal("reportError", (error: unknown) => reported.push(error));
    const { addNewDeal, dealStores, multiTab$ } = await import("../../src-legend-state/stores/multiTabStore.ts");
    const { createPathDeal } = await import("../../src-legend-state/stores/pathDeal.ts");
    await import("../../src-legend-state/devtools.ts");
    addNewDeal();
    const deal = dealStores.get(multiTab$.activeDealId.peek())!;
    const pathDeal = createPathDeal(deal);
    if (!pathDeal.getGroups().length) pathDeal.addGroup("VanillaGroup");
    const heard: string[] = [];
    const stop = pathDeal.subscribe((change) => heard.push(change.kind));
    const connection = extension.byName("Deal editor (Legend-State)")!;

    connection.failing = true;
    let threw = false;
    try {
      pathDeal.writePaths([{ path: fieldPathIn(pathDeal, 0, "strike"), value: "1" }]);
    } catch {
      threw = true;
    }
    connection.failing = false;
    heard.length = 0;
    pathDeal.writePaths([{ path: fieldPathIn(pathDeal, 0, "strike"), value: "2" }]);
    pathDeal.addGroup("Strategy");

    expect({ threw, heard: [...new Set(heard)].sort() }).toEqual({ threw: false, heard: ["groups", "products"] });
    expect(reported).toHaveLength(1); // the error isn't swallowed: it is reported on its own
    stop();
    deal.dispose();
  });
});
