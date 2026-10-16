/**
 * Removing a podcast through the UI (Remove, then Confirm), checked against the API.
 * Unsubscribing a second time must not fail.
 */
import { expect, test, type Page } from "@playwright/test";
import { escapeRegExp } from "../fixtures/shared";
import { outsideFailure } from "./podcastReplies";

const baseUrl = process.env.KIMA_UI_BASE_URL || "http://127.0.0.1:3030";
const USERNAME = process.env.KIMA_TEST_USERNAME || "";
const PASSWORD = process.env.KIMA_TEST_PASSWORD || "";

/**
 * The release-notes dialog opens over the app on a fresh browser context and
 * intercepts every pointer event until it is dismissed.
 */
async function dismissWhatsNew(page: Page): Promise<void> {
    const dialog = page.locator('div[role="dialog"][aria-labelledby="whats-new-title"]');
    // The dialog mounts after login, so wait for it (bounded) instead of one
    // count(); a missed dialog blocks every click for the rest of the run.
    const appeared = await dialog
        .waitFor({ state: "visible", timeout: 15_000 })
        .then(() => true)
        .catch(() => false);
    if (!appeared) return;
    // The X in the header; clicking it runs the same close path as Done. The
    // button is briefly disabled while `closing` runs, so retry until hidden.
    const close = page.locator('div[role="dialog"] button[aria-label="Close"]').first();
    for (let i = 0; i < 6; i++) {
        if (await close.count()) {
            await close.click({ timeout: 3000 }).catch(() => {});
        }
        const gone = await dialog
            .waitFor({ state: "hidden", timeout: 2500 })
            .then(() => true)
            .catch(() => false);
        if (gone) return;
    }
}

test.describe.serial("Podcast removal", () => {
    let page: Page;
    let token = "";
    let podcastId = "";
    let podcastTitle = "";

    test.beforeAll(async ({ browser }) => {
        expect(
            USERNAME && PASSWORD,
            "KIMA_TEST_USERNAME and KIMA_TEST_PASSWORD must be set",
        ).toBeTruthy();
        page = await browser.newPage();
        await page.goto(baseUrl + "/login");
        await page.locator('input[placeholder="Enter your username"]').fill(USERNAME);
        await page.locator('input[placeholder="Enter your password"]').fill(PASSWORD);
        await page.getByRole("button", { name: /sign in|log in/i }).click();
        await page.waitForURL(/\/(home|sync|)$/, { timeout: 30_000 });
        await dismissWhatsNew(page);
        token = (await page.evaluate(() => localStorage.getItem("auth_token"))) ?? "";
        expect(token, "login should yield an auth token").toBeTruthy();
    });

    test("R1. subscribe to a podcast", async () => {
        // A show from the overall chart the podcasts page shows, followed by its Apple id as the page does.
        const chart = await page.request.get("/api/podcasts/charts?limit=5", {
            headers: { Authorization: `Bearer ${token}` },
        });
        expect(chart.status(), `chart returned ${chart.status()}`).toBe(200);
        const list: Array<{ itunesId?: string; title?: string }> = await chart.json();
        const pick = list.find((p) => p.itunesId);
        expect(pick, "the chart returned no show").toBeTruthy();
        podcastTitle = pick?.title ?? podcastTitle;

        const res = await page.request.post("/api/podcasts/subscribe", {
            data: { itunesId: pick?.itunesId },
            headers: { Authorization: `Bearer ${token}` },
        });
        // Only a service outside Kima failing excuses the journey; any other failure is Kima's own.
        const blocked = await outsideFailure(res, "following the show");
        if (blocked) {
            test.skip(true, `${blocked}; the removal journey cannot run`);
            return;
        }
        const created = await res.json();
        podcastId = created.id ?? created.podcast?.id ?? "";
        podcastTitle = created.title ?? created.podcast?.title ?? podcastTitle;
        expect(podcastId, "subscribe returned no id").toBeTruthy();
    });

    test("R2. it appears in the podcast library", async () => {
        test.skip(!podcastId, "R1 did not subscribe");
        await page.goto(baseUrl + "/podcasts");
        await page.waitForTimeout(2500);
        // Scoped to "your shows": the same show can also sit on the charts further down the page.
        const card = page
            .locator('[data-tv-section="your-shows"]')
            .getByRole("link", { name: new RegExp(escapeRegExp(podcastTitle), "i") })
            .first();
        await expect(card).toBeVisible({ timeout: 15_000 });
    });

    test("R3. delete it through the real UI", async () => {
        test.skip(!podcastId, "R1 did not subscribe");
        await page
            .locator('[data-tv-section="your-shows"]')
            .getByRole("link", { name: new RegExp(escapeRegExp(podcastTitle), "i") })
            .first()
            .click();
        await page.waitForURL(/\/podcasts\/[^/]+/, { timeout: 15_000 });
        await page.waitForTimeout(2500);

        // The Remove control (PodcastActionBar: shows only when subscribed).
        const remove = page.getByRole("button", { name: "remove podcast" });
        await expect(remove).toBeVisible({ timeout: 15_000 });
        await remove.click();
        // The shared confirm dialog asks first.
        const confirm = page.getByRole("dialog").getByRole("button", { name: "remove", exact: true });
        await expect(confirm).toBeVisible({ timeout: 10_000 });
        await confirm.click();

        // back at the library, and the card is gone. The list's cache can
        // lag the server; the API is the source of truth, the UI assertion
        // follows once the server agrees.
        await page.waitForURL(/\/podcasts$/, { timeout: 20_000 });
        await expect
            .poll(async () => {
                const r = await page.request.get("/api/podcasts", {
                    headers: { Authorization: `Bearer ${token}` },
                });
                if (!r.ok()) return -1;
                const d = await r.json();
                const list: Array<{ id?: string }> = Array.isArray(d) ? d : (d.podcasts ?? []);
                return list.filter((p) => p.id === podcastId).length;
            }, { timeout: 30_000 })
            .toBe(0);
        // Gone from "your shows"; it can still appear on the charts further down.
        await expect(
            page.locator('[data-tv-section="your-shows"]')
                .getByRole("link", { name: new RegExp(escapeRegExp(podcastTitle), "i") }),
        ).toHaveCount(0, { timeout: 30_000 });
    });

    test("R4. the podcast is gone from the API, and deleting again is idempotent", async () => {
        test.skip(!podcastId, "R1 did not subscribe");
        const detail = await page.request.get(`/api/podcasts/${podcastId}`, {
            headers: { Authorization: `Bearer ${token}` },
        });
        expect(detail.status(), `detail after delete returned ${detail.status()}`).toBe(404);

        // idempotency: unsubscribing an already-deleted podcast must not 500
        const again = await page.request.delete(`/api/podcasts/${podcastId}/unsubscribe`, {
            headers: { Authorization: `Bearer ${token}` },
        });
        expect(
            again.status(),
            `second unsubscribe returned ${again.status()} -- delete on missing row must be idempotent`,
        ).toBeLessThan(500);
    });
});
