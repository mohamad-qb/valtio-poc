import type { Page } from "@playwright/test";
import { activeCell, apps, cell, copy, editCell, expect, openApp, paste, rowTexts, test } from "./support/fixtures.ts";

/** The grid's paste report (the price is a status too). */
const pasteStatus = (page: Page) => page.locator(".deal-grid__status");

/**
 * Starts recording which cells' content the grid repaints (spot price ticks
 * aside); `repainted` returns them as "Label:column", sorted.
 */
const recordRepaints = async (page: Page) => {
  await page.evaluate(() => {
    const w = window as unknown as { __repainted: Set<string>; __observer?: MutationObserver };
    w.__observer?.disconnect();
    w.__repainted = new Set();
    const labelOf = (row: string, labels: string) =>
      document.querySelector(`.deal-grid .slick-row[data-row="${row}"] > .slick-cell.${labels}`)?.textContent;
    w.__observer = new MutationObserver((records) => {
      for (const { target } of records) {
        const node = target instanceof Element ? target : target.parentElement;
        const cell = node?.closest(".slick-cell");
        if (!cell) continue;
        const row = (cell.parentElement as HTMLElement).dataset.row!;
        // columns: settings labels l0, settings l1, deal l2, field labels l3, products from l4
        const index = Number([...cell.classList].find((name) => /^l\d+$/.test(name))!.slice(1));
        if (index === 0 || index === 3) continue;
        const label = labelOf(row, index === 1 ? "l0" : "l3");
        const column = index === 1 ? "settings" : index === 2 ? 0 : index - 3;
        if (label !== "Spot Stream") w.__repainted.add(`${label}:${column}`);
      }
    });
    w.__observer.observe(document.querySelector(".deal-grid")!, { subtree: true, childList: true, characterData: true });
  });
  return async () => {
    await page.waitForTimeout(300);
    return page.evaluate(() => [...(window as unknown as { __repainted: Set<string> }).__repainted].sort());
  };
};

for (const app of apps) {
  test.describe(app, () => {
    test.beforeEach(async ({ page }) => {
      await openApp(page, app);
      await page.getByRole("button", { name: "Add Strategy" }).click(); // products 1, 2 and 3
      await expect(page.getByText("Strategy #2")).toBeVisible();
    });

    test("Tab follows the field priority; arrows move to the neighbouring cell", async ({ page }) => {
      await (await cell(page, "Notional Amount", 1)).click();
      const visited = [];
      for (let i = 0; i < 4; i++) {
        await page.keyboard.press("Tab");
        visited.push((await activeCell(page)).label);
      }
      expect(visited).toEqual(["Expiry Date", "Strike", "Notional Ccy", "Premium Ccy"]); // Expiry Days: read-only, skipped
      await page.keyboard.press("Shift+Tab");
      expect(await activeCell(page)).toEqual({ label: "Notional Ccy", column: 1 });

      // the labels column sits between the deal and the products: arrows pass over it
      await (await cell(page, "Strike", 0)).click();
      await page.keyboard.press("ArrowRight");
      expect(await activeCell(page)).toEqual({ label: "Strike", column: 1 });
      await page.keyboard.press("ArrowDown");
      expect(await activeCell(page)).toEqual({ label: "Call / Put", column: 1 });
    });

    test("Enter after an edit moves on by priority", async ({ page }) => {
      await editCell(page, "Notional Amount", 1, "1000");
      expect(await activeCell(page)).toEqual({ label: "Expiry Date", column: 1 });
    });

    test("copies a range as tab-separated text, dropdowns as their labels", async ({ page }) => {
      await (await cell(page, "Strike", 1)).click();
      await paste(page, "1\t2\nCall\tPut");
      await (await cell(page, "Settlement Style", 1)).click();
      await page.keyboard.press("Shift+ArrowRight");
      await page.keyboard.press("Shift+ArrowDown");
      expect(await copy(page)).toBe("Delivery\tDelivery\n\t\n"); // every row ends with a newline, like Excel's
      await (await cell(page, "Strike", 1)).click();
      await page.keyboard.press("Shift+ArrowRight");
      await page.keyboard.press("Shift+ArrowDown");
      expect(await copy(page)).toBe("1\t2\nCall\tPut\n");
    });

    test("pastes a block, fills a selection, and skips what doesn't fit", async ({ page }) => {
      await (await cell(page, "Strike", 1)).click();
      await paste(page, "1\t2\t3\nCall\tPut\tCall\n");
      await expect.poll(() => rowTexts(page, "Strike")).toEqual(["", "1", "2", "3"]);
      await expect.poll(() => rowTexts(page, "Call / Put")).toEqual(["", "Call", "Put", "Call"]);
      await expect(pasteStatus(page)).toHaveText("Pasted 6 cells");

      // one value over a selection fills it
      await (await cell(page, "Strike", 2)).click();
      await page.keyboard.press("Shift+ArrowRight");
      await paste(page, "7");
      await expect.poll(() => rowTexts(page, "Strike")).toEqual(["", "1", "7", "7"]);

      // a dropdown takes a label; unknown values are skipped
      await (await cell(page, "Settlement Style", 1)).click();
      await paste(page, "Cash\tBogus\tDelivery");
      await expect.poll(() => rowTexts(page, "Settlement Style")).toEqual(["", "Cash", "Delivery", "Delivery"]);
      await expect(pasteStatus(page)).toHaveText("Pasted 2 cells, skipped 1");
      // a number pasted into Expiry Days is written, like typing it
      await (await cell(page, "Expiry Days", 1)).click();
      await paste(page, "5");
      await expect(pasteStatus(page)).toHaveText("Pasted 1 cell");
      await expect.poll(() => rowTexts(page, "Expiry Days")).toEqual(["", "5", "", ""]);
    });

    test("a paste into the deal column broadcasts and syncs", async ({ page }) => {
      await (await cell(page, "Notional Amount", 0)).click();
      await page.keyboard.press("Shift+ArrowDown");
      await page.keyboard.press("Shift+ArrowDown");
      await paste(page, "1000\nEUR\n"); // Notional Amount (synced), then Premium Ccy (synced)
      await expect.poll(() => rowTexts(page, "Notional Amount")).toEqual(["1000", "1000", "1000", "1000"]);
      await expect.poll(() => rowTexts(page, "Premium Ccy")).toEqual(["EUR", "EUR", "EUR", "EUR"]);
      await (await cell(page, "Strike", 0)).click();
      await paste(page, "4");
      await expect.poll(() => rowTexts(page, "Strike")).toEqual(["", "4", "4", "4"]);
    });

    test("repaints only the cells a change touches", async ({ page }) => {
      // the deal's fixing sources loaded: nothing else in flight
      await expect(await cell(page, "Fixing Source", 0)).toHaveText("", { timeout: 5000 });

      // an edit: that cell
      let repainted = await recordRepaints(page);
      await editCell(page, "Strike", 1, "1");
      expect(await repainted()).toEqual(["Strike:1"]);

      // a synced field: its row
      repainted = await recordRepaints(page);
      await editCell(page, "Premium Ccy", 3, "EUR");
      expect(await repainted()).toEqual(["Premium Ccy:0", "Premium Ccy:1", "Premium Ccy:2", "Premium Ccy:3"]);

      // a paste: the pasted cells, each once, all from one batch
      repainted = await recordRepaints(page);
      await (await cell(page, "Strike", 2)).click();
      await paste(page, "5\t6\nPut\tCall");
      expect(await repainted()).toEqual(["Call / Put:2", "Call / Put:3", "Strike:2", "Strike:3"]);
    });

    test("the settings subgrid: beside the deal a few rows down, reachable by arrows and Tab", async ({ page }) => {
      const hedgeType = await cell(page, "Hedge Type", "settings");
      await expect(hedgeType).toHaveText("a");
      await expect(await cell(page, "Internal", "settings")).toHaveText("Yes");

      // arrows cross between the subgrids, row for row
      await hedgeType.click();
      await page.keyboard.press("ArrowRight");
      expect(await activeCell(page)).toEqual({ label: "Premium Ccy", column: 0 });
      await page.keyboard.press("ArrowDown");
      await page.keyboard.press("ArrowLeft");
      expect(await activeCell(page)).toEqual({ label: "Internal", column: "settings" });
      await page.keyboard.press("ArrowDown"); // nothing below the subgrid: stays
      expect(await activeCell(page)).toEqual({ label: "Internal", column: "settings" });

      // Tab: the settings top-down, then on into the deal by priority; Shift+Tab comes back
      await hedgeType.click();
      await page.keyboard.press("Tab");
      expect(await activeCell(page)).toEqual({ label: "Internal", column: "settings" });
      await page.keyboard.press("Tab");
      expect(await activeCell(page)).toEqual({ label: "Notional Amount", column: 0 });
      await page.keyboard.press("Shift+Tab");
      expect(await activeCell(page)).toEqual({ label: "Internal", column: "settings" });

      // the hedge types follow Internal; one no longer offered resets to the first
      await editCell(page, "Internal", "settings", "No");
      await expect(hedgeType).toHaveText("d");
      await editCell(page, "Hedge Type", "settings", "f");
      await expect(hedgeType).toHaveText("f");
      await editCell(page, "Internal", "settings", "Yes");
      await expect(hedgeType).toHaveText("a");

      // copy and paste work across the subgrid too
      await hedgeType.click();
      await page.keyboard.press("Shift+ArrowDown");
      expect(await copy(page)).toBe("a\nYes\n");
      await hedgeType.click();
      await paste(page, "c");
      await expect(hedgeType).toHaveText("c");
    });
  });
}
