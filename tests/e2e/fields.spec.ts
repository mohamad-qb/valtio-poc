import { dateInDays } from "../../src-shared/lib/date.ts";
import { apps, cell, editCell, expect, openApp, rowTexts, test } from "./support/fixtures.ts";

const ERROR = /grid-cell--error/;

for (const app of apps) {
  test.describe(app, () => {
    test.beforeEach(async ({ page }) => {
      await openApp(page, app);
      await page.getByRole("button", { name: "Add Strategy" }).click();
      await expect(page.getByText("Strategy #2")).toBeVisible();
    });

    test("edits commit on Enter, never while typing; Escape cancels", async ({ page }) => {
      // the deal's ccy: typing doesn't sync, Enter does
      await (await cell(page, "Notional Ccy", 0)).click();
      await page.keyboard.press("Enter");
      await page.locator(".grid-editor").fill("EUR");
      expect((await rowTexts(page, "Notional Ccy")).slice(1)).toEqual(["1xxxxxx", "1xxxxxx", "1xxxxxx"]);
      await page.keyboard.press("Enter");
      await expect.poll(() => rowTexts(page, "Notional Ccy")).toEqual(["EUR", "EUR", "EUR", "EUR"]);

      // Escape drops the draft
      await (await cell(page, "Premium Ccy", 2)).click();
      await page.keyboard.press("Enter");
      await page.locator(".grid-editor").fill("USD");
      await page.keyboard.press("Escape");
      await expect.poll(() => rowTexts(page, "Premium Ccy")).toEqual(["2", "2", "2", "2"]);

      // a product's ccy syncs back to the deal and every product
      await editCell(page, "Premium Ccy", 2, "USD");
      await expect.poll(() => rowTexts(page, "Premium Ccy")).toEqual(["USD", "USD", "USD", "USD"]);

      // validation runs on commit
      await editCell(page, "Strike", 1, "1234");
      await expect(await cell(page, "Strike", 1)).toHaveClass(ERROR);

      // Notional Amount: a synced number; cleared shows empty, not 0
      await editCell(page, "Notional Amount", 1, "1500");
      await expect.poll(() => rowTexts(page, "Notional Amount")).toEqual(["1500", "1500", "1500", "1500"]);
      await editCell(page, "Notional Amount", 0, "");
      await expect.poll(() => rowTexts(page, "Notional Amount")).toEqual(["", "", "", ""]);

      // broadcasts: every product, and the deal holds nothing
      await editCell(page, "Ccy Pair", 0, "EURUSD");
      await expect.poll(() => rowTexts(page, "Ccy Pair")).toEqual(["", "EURUSD", "EURUSD", "EURUSD"]);
    });

    test("typing over a cell starts an edit that replaces it", async ({ page }) => {
      await editCell(page, "Strike", 1, "9");
      await (await cell(page, "Strike", 1)).click();
      await page.keyboard.type("42");
      await page.keyboard.press("Enter");
      await expect.poll(() => rowTexts(page, "Strike")).toEqual(["", "42", "", ""]);
    });

    test("Expiry Days follows Expiry Date, and typing days moves the date", async ({ page }) => {
      await editCell(page, "Expiry Date", 1, "2999-01-01");
      const days = await cell(page, "Expiry Days", 1);
      await expect(days).not.toHaveClass(/grid-cell--readonly/);
      expect(Number(await days.textContent())).toBeGreaterThan(0);
      await editCell(page, "Expiry Days", 1, "5");
      await expect(days).toHaveText("5");
      await expect(await cell(page, "Expiry Date", 1)).toHaveText(dateInDays(5));
    });

    test("Strike takes 3 characters on an internal deal, 6 on an external one", async ({ page }) => {
      await editCell(page, "Strike", 1, "12345");
      await expect(await cell(page, "Strike", 1)).toHaveClass(ERROR);
      // only the deal changes: the products' cells are checked again
      await editCell(page, "Internal", "settings", "No");
      await expect(await cell(page, "Strike", 1)).not.toHaveClass(ERROR);
      await editCell(page, "Strike", 2, "1234567");
      await expect(await cell(page, "Strike", 2)).toHaveClass(ERROR);
      await editCell(page, "Internal", "settings", "Yes");
      await expect(await cell(page, "Strike", 1)).toHaveClass(ERROR);
      await expect(await cell(page, "Strike", 3)).not.toHaveClass(ERROR); // empty
    });

    test("Delivery Date can't be before Expiry Date", async ({ page }) => {
      for (const n of [1, 2]) {
        await editCell(page, "Expiry Date", n, "2999-02-10");
        await editCell(page, "Delivery Date", n, "2999-02-05");
        await expect(await cell(page, "Delivery Date", n)).toHaveClass(ERROR);
        await expect(await cell(page, "Expiry Date", n)).not.toHaveClass(ERROR);
        await editCell(page, "Expiry Date", n, "2999-02-01");
        await expect(await cell(page, "Delivery Date", n)).not.toHaveClass(ERROR);
      }
      // a broadcast of a later expiry flags the products, a later delivery clears them
      await editCell(page, "Expiry Date", 0, "2999-06-01");
      await expect(await cell(page, "Delivery Date", 1)).toHaveClass(ERROR);
      await expect(await cell(page, "Delivery Date", 2)).toHaveClass(ERROR);
      await expect(await cell(page, "Delivery Date", 0)).not.toHaveClass(ERROR);
      await editCell(page, "Delivery Date", 0, "2999-06-02");
      await expect(await cell(page, "Delivery Date", 1)).not.toHaveClass(ERROR);
      await expect(await cell(page, "Delivery Date", 2)).not.toHaveClass(ERROR);
    });
  });
}
