/**
 * Runs once before all tests: checks KIMA_TEST_USERNAME / KIMA_TEST_PASSWORD
 * can log in at KIMA_UI_BASE_URL (required; never port 3030), and aborts
 * with setup instructions if not.
 */
import { chromium } from "@playwright/test";
import { requireBaseUrl } from "./fixtures/target";

async function globalSetup(): Promise<void> {
    const username = process.env.KIMA_TEST_USERNAME;
    const password = process.env.KIMA_TEST_PASSWORD;
    const baseUrl = requireBaseUrl();

    if (!username || !password) {
        throw new Error(
            "E2E test user credentials not set.\n" +
            "Set KIMA_TEST_USERNAME and KIMA_TEST_PASSWORD in .env.test or export them before running E2E tests.\n" +
            "To create a test user, run: bash scripts/create-e2e-user.sh"
        );
    }

    // Verify the test user can log in via browser (also saves auth state)
    const browser = await chromium.launch();
    const page = await browser.newPage();

    try {
        await page.goto(`${baseUrl}/login`);
        await page.locator("#username").fill(username);
        await page.locator("#password").fill(password);
        await page.getByRole("button", { name: "Sign In" }).click();

        // Wait for redirect to the home page (matches /, /?..., /home)
        // Same pattern used by loginAsTestUser in test-helpers.ts
        try {
            await page.waitForURL(/\/($|\?|home)/, { timeout: 20_000 });
        } catch {
            const url = page.url();
            throw new Error(
                `Login failed for E2E test user '${username}'. Still on: ${url}\n` +
                "Create the user by running: bash scripts/create-e2e-user.sh"
            );
        }

        // Dismiss pending What's New releases server-side so the modal never
        // blocks tests; best effort. /api takes bearer tokens only, so the JWT
        // is read from the app's storage.
        try {
            // lib/api.ts persists the JWT under AUTH_TOKEN_KEY ("auth_token").
            const token = await page.evaluate(() => window.localStorage.getItem("auth_token"));
            if (!token) throw new Error("auth_token missing from localStorage");
            const api = (path: string) => `${baseUrl}${path}`;
            const readPending = async () => {
                const res = await page.request.get(api("/api/whats-new/pending"), {
                    headers: { Authorization: `Bearer ${token}` },
                    maxRetries: 1,
                });
                return res.ok() ? ((await res.json()) as { releases: Array<{ version: string }> }) : { releases: [] };
            };
            let { releases } = await readPending();
            // Dismissing the first release advances the pending queue to the
            // next unseen one, so loop until the queue is actually empty.
            for (let i = 0; i < 10 && (releases?.length ?? 0) > 0; i++) {
                const v = releases[0].version;
                const dr = await page.request.post(api(`/api/whats-new/${v}/dismiss`), {
                    headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
                    data: {},
                });
                if (!dr.ok()) throw new Error(`dismiss ${v} -> ${dr.status()}`);
                releases = (await readPending()).releases ?? [];
                console.log(`[setup] Dismissed What's New ${v} (queue now ${releases.length}).`);
            }
            if (!(releases?.length)) console.log("[setup] What's New queue clear.");
        } catch (e) {
            console.log(`[setup] What's New pre-dismiss skipped: ${e instanceof Error ? e.message : String(e)}`);
        }

        await page.context().storageState({ path: "tests/e2e/.auth/user.json" });
        console.log(`[setup] E2E test user '${username}' verified, auth state saved.`);
    } finally {
        await browser.close();
    }
}

export default globalSetup;
