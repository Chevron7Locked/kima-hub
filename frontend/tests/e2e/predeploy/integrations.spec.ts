import { test, expect } from "@playwright/test";
import { loginAsTestUser, skipIfNoEnv } from "../fixtures/test-helpers";

test.describe("Integrations", () => {
    test.beforeEach(async ({ page }) => {
        await loginAsTestUser(page);
    });

    test("Audiobookshelf connection test", async ({ page }, testInfo) => {
        skipIfNoEnv("KIMA_TEST_ABS_URL", testInfo);
        skipIfNoEnv("KIMA_TEST_ABS_API_KEY", testInfo);

        await page.goto("/settings");

        const mediaServersLink = page.locator("text=Media Servers").first();
        await expect(mediaServersLink).toBeVisible({ timeout: 5000 });
        await mediaServersLink.click();

        const absContainer = page.locator('#audiobookshelf');
        await expect(absContainer).toBeVisible({ timeout: 5000 });

        const enableToggle = page.locator('#abs-enabled');
        if (await enableToggle.isVisible({ timeout: 2000 })) {
            const isChecked = await enableToggle.isChecked();
            if (!isChecked) {
                await enableToggle.click({ force: true });
                await page.waitForTimeout(500);
            }
        }
        const urlInput = absContainer.locator('input[placeholder*="localhost:13378" i]');
        const apiKeyInput = absContainer.getByRole('textbox', { name: 'Enter API key' });

        if (await urlInput.isVisible({ timeout: 2000 })) {
            await urlInput.fill(process.env.KIMA_TEST_ABS_URL!);
        }
        if (await apiKeyInput.isVisible({ timeout: 2000 })) {
            await apiKeyInput.fill(process.env.KIMA_TEST_ABS_API_KEY!);
        }

        const testBtn = absContainer.getByRole("button", { name: /test connection/i });
        await expect(testBtn).toBeVisible({ timeout: 3000 });
        await testBtn.click();

        // On success the status beside the button (a green InlineStatus) reads exactly "v<version>" or "Connected".
        await expect(
            absContainer.locator("span.text-success"),
            "the Audiobookshelf connection test did not report a successful connection",
        ).toHaveText(/^(v\d+(\.\d+)+[\w.+-]*|Connected)$/, { timeout: 20_000 });
    });

    test("Lidarr connection test", async ({ page }, testInfo) => {
        skipIfNoEnv("KIMA_TEST_LIDARR_URL", testInfo);
        skipIfNoEnv("KIMA_TEST_LIDARR_API_KEY", testInfo);

        await page.goto("/settings");

        const lidarrContainer = page.locator('#lidarr');
        await expect(lidarrContainer).toBeVisible({ timeout: 5000 });

        const urlInput = lidarrContainer.locator('input[type="url"], input[type="text"]').first();
        const apiKeyInput = lidarrContainer.locator('input[type="password"], input[placeholder*="api" i]').first();

        if (await urlInput.isVisible({ timeout: 2000 })) {
            await urlInput.fill(process.env.KIMA_TEST_LIDARR_URL!);
        }
        if (await apiKeyInput.isVisible({ timeout: 2000 })) {
            await apiKeyInput.fill(process.env.KIMA_TEST_LIDARR_API_KEY!);
        }

        const testBtn = lidarrContainer.getByRole("button", { name: /test connection/i });
        await expect(testBtn).toBeVisible({ timeout: 3000 });
        await testBtn.click();

        // On success the status beside the button (a green InlineStatus) reads exactly "v<version>" or "Connected".
        await expect(
            lidarrContainer.locator("span.text-success"),
            "the Lidarr connection test did not report a successful connection",
        ).toHaveText(/^(v\d+(\.\d+)+[\w.+-]*|Connected)$/, { timeout: 20_000 });
    });

    test("Soulseek connection test", async ({ page }, testInfo) => {
        skipIfNoEnv("KIMA_TEST_SOULSEEK_USER", testInfo);
        skipIfNoEnv("KIMA_TEST_SOULSEEK_PASS", testInfo);

        await page.goto("/settings");

        const soulseekContainer = page.locator('#soulseek');
        await expect(soulseekContainer).toBeVisible({ timeout: 5000 });

        const userInput = soulseekContainer.locator('input[placeholder*="username" i], input[type="text"]').first();
        const passInput = soulseekContainer.locator('input[type="password"]').first();

        if (await userInput.isVisible({ timeout: 2000 })) {
            await userInput.fill(process.env.KIMA_TEST_SOULSEEK_USER!);
        }
        if (await passInput.isVisible({ timeout: 2000 })) {
            await passInput.fill(process.env.KIMA_TEST_SOULSEEK_PASS!);
        }

        const testBtn = soulseekContainer.getByRole("button", { name: /test connection/i });
        await expect(testBtn).toBeVisible({ timeout: 3000 });
        await testBtn.click();

        // The Soulseek handshake can take 10-15 seconds; the success text is "Connected to Soulseek".
        await expect(
            soulseekContainer.locator("span.text-success"),
            "the Soulseek connection test did not report a successful connection",
        ).toHaveText("Connected to Soulseek", { timeout: 20_000 });
    });
});
