import { defineConfig } from "@playwright/test";
import { requireBaseUrl } from "./tests/e2e/fixtures/target";

const baseURL = requireBaseUrl();

export default defineConfig({
    testDir: "./tests/e2e",
    timeout: 60_000,
    expect: { timeout: 15_000 },
    retries: process.env.CI ? 2 : 0,
    globalSetup: "./tests/e2e/global.setup.ts",
    use: {
        baseURL,
        trace: "retain-on-failure",
        screenshot: "only-on-failure",
        video: "retain-on-failure",
    },
    reporter: [["list"], ["html", { open: "never" }]],
    webServer: process.env.KIMA_E2E_START_WEB
        ? {
              // The dev server on the base URL's own port: `npm run dev` listens on 3030, which tests may not use.
              command: `npx next dev -p ${new URL(baseURL).port || "80"}`,
              url: baseURL,
              reuseExistingServer: true,
              timeout: 120_000,
          }
        : undefined,
});








