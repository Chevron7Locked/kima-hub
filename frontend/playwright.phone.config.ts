// Runner config for the phone-layout spec against the dev instance.
//
// The main playwright.config.ts runs globalSetup (which demands
// KIMA_TEST_USERNAME/KIMA_TEST_PASSWORD) and collects every spec in
// tests/e2e. This config collects one file only: the vibe phone layout, which
// signs in for itself. Everything else mirrors the main config.
import { defineConfig } from "@playwright/test";

const baseURL = process.env.KIMA_UI_BASE_URL || "http://127.0.0.1:3030";

export default defineConfig({
    testDir: "./tests/e2e",
    // Only this spec: the tree also holds dogfood, predeploy and campaign
    // specs that need their own data and setup.
    testMatch: ["**/vibe-phone.spec.ts"],
    fullyParallel: false,
    workers: 1,
    timeout: 120_000,
    expect: { timeout: 15_000 },
    retries: 0,
    use: {
        baseURL,
        trace: "retain-on-failure",
        screenshot: "only-on-failure",
        video: "retain-on-failure",
    },
    reporter: [["list"]],
});
