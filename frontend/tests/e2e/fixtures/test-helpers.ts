import { Page, TestInfo } from "@playwright/test";

const username = process.env.LIDIFY_TEST_USERNAME || "predeploy";
const password = process.env.LIDIFY_TEST_PASSWORD || "predeploy-password";
const baseUrl = process.env.LIDIFY_UI_BASE_URL || "http://127.0.0.1:3030";

export async function loginAsTestUser(page: Page): Promise<void> {
    await page.goto("/login");
    await page.locator("#username").fill(username);
    await page.locator("#password").fill(password);
    await page.getByRole("button", { name: "Sign In" }).click();
    await page.waitForURL(/\/($|\?|home)/);
}

export function skipIfNoEnv(envVar: string, testInfo: TestInfo): void {
    if (!process.env[envVar]) {
        testInfo.skip(true, `Skipping: ${envVar} not set`);
    }
}

export async function waitForApiHealth(page: Page, timeoutMs = 30000): Promise<void> {
    const start = Date.now();
    while (Date.now() - start < timeoutMs) {
        try {
            const response = await page.request.get(`${baseUrl}/api/health`);
            if (response.ok()) return;
        } catch {}
        await page.waitForTimeout(1000);
    }
    throw new Error("API health check timed out");
}

export { username, password, baseUrl };
