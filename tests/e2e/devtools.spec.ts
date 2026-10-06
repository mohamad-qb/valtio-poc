import type { Page } from "@playwright/test";
import { apps, cell, expect, openApp, test } from "./support/fixtures.ts";

const toggle = (page: Page) => page.getByRole("button", { name: /Toggle Spot Price Stream/ });
const spot = async (page: Page) => Number(await (await cell(page, "Spot Stream", 0)).textContent());

for (const app of apps) {
  test.describe(app, () => {
    test("the spot stream follows its toggle, which survives a reload", async ({ page }) => {
      await openApp(page, app);
      await expect(toggle(page)).toContainText("Enabled");
      const before = await spot(page);
      await expect.poll(() => spot(page)).toBeGreaterThan(before);

      await toggle(page).click();
      await expect(toggle(page)).toContainText("Disabled");
      const stopped = await spot(page);
      await page.waitForTimeout(1200);
      expect(await spot(page)).toBe(stopped);

      await page.reload();
      await expect(page.getByText("Vanilla Group #1")).toBeVisible();
      await expect(toggle(page)).toContainText("Disabled");
    });

    test("tabs hold independent deals", async ({ page }) => {
      const groups = page.locator(".deal-grid .grid-group__title");
      const show = async (tab: string) => {
        await page.getByRole("button", { name: tab }).click();
        await page.waitForTimeout(250); // the deal mounted and settled: anything it adds on mount is there
      };
      await openApp(page, app);
      await page.getByRole("button", { name: "Add Strategy" }).click();
      await page.getByRole("button", { name: "Add New Deal" }).click();
      await expect(page.getByRole("button", { name: "Tab 2" })).toBeVisible();
      await expect(page.getByText("Strategy #2")).toHaveCount(0); // a fresh deal
      await expect(groups).toHaveText(["Vanilla Group #1"]);
      // switching away and back, again and again, shows exactly the groups the user made
      for (let i = 0; i < 3; i++) {
        await show("Tab 1");
        await expect(groups).toHaveText(["Vanilla Group #1", "Strategy #2"]);
        await show("Tab 2");
        await expect(groups).toHaveText(["Vanilla Group #1"]);
      }
    });

    test("a deal whose groups were all removed stays empty across tab switches", async ({ page }) => {
      const groups = page.locator(".deal-grid .grid-group__title");
      const show = async (tab: string) => {
        await page.getByRole("button", { name: tab }).click();
        await expect(page.locator(".deal-grid")).toBeVisible();
        await page.waitForTimeout(250); // the deal mounted and settled: anything it adds on mount is there
      };
      await openApp(page, app);
      await page.getByRole("button", { name: "Remove", exact: true }).click();
      await expect(groups).toHaveCount(0);
      await page.getByRole("button", { name: "Add New Deal" }).click();
      await expect(page.getByRole("button", { name: "Tab 2" })).toBeVisible();
      await expect(groups).toHaveCount(1); // the new deal starts with its own group
      await show("Tab 1");
      await expect(groups).toHaveCount(0);
      await show("Tab 2");
      await expect(groups).toHaveCount(1);
      await show("Tab 1");
      await expect(groups).toHaveCount(0);
    });
  });
}

test("effector-nested: the toggle is kept in sync across browser tabs", async ({ context }) => {
  const first = await context.newPage();
  await openApp(first, "effector-nested");
  const second = await context.newPage();
  await openApp(second, "effector-nested");
  await toggle(first).click();
  await expect(toggle(second)).toContainText("Disabled");
  await toggle(first).click();
  await expect(toggle(second)).toContainText("Enabled");
});
