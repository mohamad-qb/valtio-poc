import { defineConfig } from "@playwright/test";

// browser tests against the dev server: every spec runs for every app
export default defineConfig({
  testDir: "tests/e2e",
  fullyParallel: true,
  use: {
    baseURL: "http://localhost:5173",
    channel: "chrome", // the installed Chrome: no browser download needed
    headless: true,
    viewport: { width: 2200, height: 1000 },
  },
  webServer: {
    command: "pnpm dev --port 5173 --strictPort",
    url: "http://localhost:5173/valtio.html",
    reuseExistingServer: true,
  },
});
