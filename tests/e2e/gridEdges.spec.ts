import type { Page } from "@playwright/test";
import { activeCell, apps, cell, copy, editCell, expect, openApp, paste, rowTexts, test } from "./support/fixtures.ts";

/** The grid's status line: paste reports and editor validation errors. */
const status = (page: Page) => page.locator(".deal-grid__status");
const editor = (page: Page) => page.locator(".deal-grid .grid-editor");
const groupTitles = (page: Page) => page.locator(".deal-grid .grid-group__title");
const productHeaders = (page: Page) => page.locator(".deal-grid .slick-header-column.grid-header--product");

/** Opens an editor on a cell and types into it, without committing. */
const startEdit = async (page: Page, label: string, column: number, text: string) => {
  await (await cell(page, label, column)).click();
  await page.keyboard.press("Enter");
  await editor(page).fill(text);
};

/** Whether keyboard focus is somewhere inside the grid. */
const focusInGrid = (page: Page) =>
  page.evaluate(() => document.querySelector(".deal-grid")!.contains(document.activeElement));

/** DOM nodes and DOM event listeners alive after a full garbage collection. */
const domCounters = async (page: Page) => {
  const cdp = await page.context().newCDPSession(page);
  await cdp.send("HeapProfiler.enable");
  await cdp.send("HeapProfiler.collectGarbage");
  await cdp.send("HeapProfiler.collectGarbage");
  const counters = (await cdp.send("Memory.getDOMCounters")) as { nodes: number; jsEventListeners: number };
  await cdp.detach();
  return counters;
};

for (const app of apps) {
  test.describe(app, () => {
    test("a number cell takes thousands separators and refuses text that isn't a number", async ({ page }) => {
      await openApp(page, app);
      await editCell(page, "Notional Amount", 1, "1,000");
      await expect.poll(() => rowTexts(page, "Notional Amount")).toEqual(["1000", "1000"]);

      // not a number: the editor stays open, flagged, with the reason in the status line; Escape keeps the old value
      for (const text of ["1,5", "0x10", "1e3", "Infinity"]) {
        await startEdit(page, "Notional Amount", 1, text);
        await page.keyboard.press("Enter");
        await expect(editor(page)).toHaveCount(1);
        await expect(editor(page)).toHaveAttribute("aria-invalid", "true");
        await expect(status(page)).toContainText("is not a number");
        await page.keyboard.press("Escape");
        await expect(editor(page)).toHaveCount(0);
        await expect.poll(() => rowTexts(page, "Notional Amount")).toEqual(["1000", "1000"]);
      }

      // junk typed into Expiry Days leaves the Expiry Date alone; empty still clears
      await editCell(page, "Expiry Date", 1, "2999-01-01");
      await expect.poll(async () => (await rowTexts(page, "Expiry Date"))[1]).toBe("2999-01-01");
      await startEdit(page, "Expiry Days", 1, "soon");
      await page.keyboard.press("Enter");
      await expect(editor(page)).toHaveCount(1);
      await page.keyboard.press("Escape");
      expect((await rowTexts(page, "Expiry Date"))[1]).toBe("2999-01-01");
      await editCell(page, "Notional Amount", 1, "");
      await expect.poll(() => rowTexts(page, "Notional Amount")).toEqual(["", ""]);
    });

    test("removing the last group while its cell is being edited", async ({ page }) => {
      await openApp(page, app);
      await page.getByRole("button", { name: "Add Strategy" }).click();
      await expect(productHeaders(page)).toHaveCount(3);
      await startEdit(page, "Strike", 3, "EDIT");
      await page.getByRole("button", { name: "Remove", exact: true }).last().click();
      // gone at once, no error (any console error fails the test), no editor left behind
      await expect(groupTitles(page)).toHaveText(["Vanilla Group #1"]);
      await expect(productHeaders(page)).toHaveCount(1);
      await expect(editor(page)).toHaveCount(0);
      // and the grid still edits
      await editCell(page, "Strike", 1, "fine");
      await expect.poll(async () => (await rowTexts(page, "Strike"))[1]).toBe("fine");
    });

    test("an edit open while a group is added is committed, and the active cell stays on it", async ({ page }) => {
      await openApp(page, app);
      await startEdit(page, "Strike", 1, "kept");
      await page.getByRole("button", { name: "Add Strategy" }).click();
      await expect(productHeaders(page)).toHaveCount(3);
      await expect(editor(page)).toHaveCount(0);
      await expect.poll(async () => (await rowTexts(page, "Strike"))[1]).toBe("kept");
      expect(await activeCell(page)).toEqual({ label: "Strike", column: 1 });
    });

    test("a burst of adds rebuilds the columns once", async ({ page }) => {
      await openApp(page, app);
      const rebuilt = await page.evaluate(async () => {
        let removedHeaders = 0;
        const observer = new MutationObserver((records) => {
          for (const record of records) {
            for (const node of record.removedNodes) {
              if (node instanceof HTMLElement && node.classList.contains("slick-header-column")) removedHeaders++;
            }
          }
        });
        observer.observe(document.querySelector(".deal-grid")!, { subtree: true, childList: true });
        const headers = document.querySelectorAll(".deal-grid .slick-header-column").length;
        const add = [...document.querySelectorAll("button")].find((button) => button.textContent?.trim() === "Add Vanilla Group")!;
        for (let i = 0; i < 10; i++) add.click();
        await new Promise((resolve) => setTimeout(resolve, 300));
        observer.disconnect();
        return { headers, removedHeaders };
      });
      await expect(groupTitles(page)).toHaveCount(11);
      // one rebuild tears the old headers down once
      expect(rebuilt.removedHeaders).toBe(rebuilt.headers);
    });

    test("adding and removing groups leaves no header listeners or nodes behind", async ({ page }) => {
      await openApp(page, app);
      const cycle = async () => {
        await page.getByRole("button", { name: "Add Strategy" }).click();
        await expect(groupTitles(page)).toHaveCount(2);
        await page.getByRole("button", { name: "Remove", exact: true }).last().click();
        await expect(groupTitles(page)).toHaveCount(1);
      };
      for (let i = 0; i < 3; i++) await cycle();
      const before = await domCounters(page);
      for (let i = 0; i < 10; i++) await cycle();
      const after = await domCounters(page);
      // before the fix each cycle kept 24 listeners and 30 nodes of removed headers
      expect((after.jsEventListeners - before.jsEventListeners) / 10).toBeLessThan(1);
      expect((after.nodes - before.nodes) / 10).toBeLessThan(5);
    });

    test("Tab past the last cell leaves the grid, and Shift+Tab before the first", async ({ page }) => {
      await openApp(page, app);
      // the last cell in keyboard order: the last product's last field (Premium Date)
      await (await cell(page, "Premium Date", 1)).click();
      await page.keyboard.press("Tab");
      expect(await focusInGrid(page)).toBe(false);

      // the first cell in keyboard order: the settings' Hedge Type; before it, the toolbar
      await (await cell(page, "Hedge Type", "settings")).click();
      await page.keyboard.press("Shift+Tab");
      expect(await focusInGrid(page)).toBe(false);
      await expect(page.locator(":focus")).toHaveText(/Toggle Spot Price Stream/);
      // and Tab comes back in
      await page.keyboard.press("Tab");
      expect(await focusInGrid(page)).toBe(true);
    });

    test("the paste report counts every value that didn't land", async ({ page }) => {
      await openApp(page, app);
      // past the subgrid's last row
      await (await cell(page, "Internal", "settings")).click();
      await paste(page, "Yes\n7\n8\n9");
      await expect(status(page)).toHaveText("Pasted 1 cell, skipped 3");
      // past the grid's right edge
      await (await cell(page, "Strike", 1)).click();
      await paste(page, "1\t2\t3");
      await expect(status(page)).toHaveText("Pasted 1 cell, skipped 2");
      // past the grid's bottom edge
      await (await cell(page, "Spot Stream", 1)).click();
      await paste(page, "1\n2");
      await expect(status(page)).toHaveText("Pasted 0 cells, skipped 2");
      // a field the product doesn't have (a fixing source on a Delivery product)
      await (await cell(page, "Fixing Source", 1)).click();
      await paste(page, "Shared C");
      await expect(status(page)).toHaveText("Pasted 0 cells, skipped 1");
      await expect(await cell(page, "Fixing Source", 1)).toHaveText("");
      // a read-only cell (the deal's spot price)
      await (await cell(page, "Spot Stream", 0)).click();
      await paste(page, "5");
      await expect(status(page)).toHaveText("Pasted 0 cells, skipped 1");
    });

    test("a copied settings column pastes back whole: the hedge type follows the Internal pasted with it", async ({ page }) => {
      await openApp(page, app);
      const hedgeType = await cell(page, "Hedge Type", "settings");
      await hedgeType.click();
      await paste(page, "e\nNo"); // e is only offered once Internal is No
      await expect(status(page)).toHaveText("Pasted 2 cells");
      await expect(hedgeType).toHaveText("e");
      await expect(await cell(page, "Internal", "settings")).toHaveText("No");
      await hedgeType.click();
      await paste(page, "b\nYes");
      await expect(hedgeType).toHaveText("b");
      await expect(await cell(page, "Internal", "settings")).toHaveText("Yes");
    });

    test("copying a column that ends in an empty cell keeps that cell", async ({ page }) => {
      await openApp(page, app);
      await page.getByRole("button", { name: "Add Strategy" }).click();
      await expect(productHeaders(page)).toHaveCount(3);
      await (await cell(page, "Strike", 1)).click();
      await paste(page, "7");
      await page.keyboard.press("Shift+ArrowDown"); // Strike, then an empty Call / Put
      const copied = await copy(page);
      expect(copied).toBe("7\n\n");
      await (await cell(page, "Strike", 2)).click();
      await paste(page, "8\nPut");
      await expect.poll(async () => (await rowTexts(page, "Call / Put"))[2]).toBe("Put");
      await paste(page, copied);
      await expect(status(page)).toHaveText("Pasted 2 cells");
      await expect.poll(async () => (await rowTexts(page, "Strike"))[2]).toBe("7");
      await expect.poll(async () => (await rowTexts(page, "Call / Put"))[2]).toBe("");
    });
  });

  test(`${app}: at phone width the products can be reached and the bars wrap`, async ({ page }) => {
    await page.setViewportSize({ width: 375, height: 812 });
    await openApp(page, app);
    for (let i = 0; i < 5; i++) await page.getByRole("button", { name: "Add New Deal" }).click();
    await expect(page.getByRole("button", { name: "Tab 6" })).toBeVisible();
    await page.getByRole("button", { name: "Add Strategy" }).click(); // in the new deal, Tab 6
    await expect(productHeaders(page)).toHaveCount(3);

    // nothing sticks out of the page: the tab bar and the toolbar wrap
    const layout = await page.evaluate(() => ({
      overflow: document.documentElement.scrollWidth - document.documentElement.clientWidth,
      tabRows: new Set([...document.querySelectorAll(".multi-deal__tabs button")].map((b) => Math.round(b.getBoundingClientRect().top))).size,
    }));
    expect(layout.overflow).toBe(0);
    expect(layout.tabRows).toBeGreaterThan(1);

    // the keyboard reaches a product's cell, in view, and edits it
    await (await cell(page, "Strike", 0)).click();
    await page.keyboard.press("ArrowRight");
    await page.keyboard.press("ArrowRight");
    expect(await activeCell(page)).toEqual({ label: "Strike", column: 2 });
    const box = await page.locator(".deal-grid .slick-cell.active").boundingBox();
    expect(box && box.width > 0 && box.x >= 0 && box.x + box.width <= 375).toBe(true);
    await page.keyboard.press("Enter");
    await editor(page).fill("5");
    await page.keyboard.press("Enter");
    await expect(await cell(page, "Strike", 2)).toHaveText("5");
  });
}
