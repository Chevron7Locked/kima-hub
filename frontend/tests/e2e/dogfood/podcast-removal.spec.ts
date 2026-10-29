/**
 * Removing a podcast through the UI (Remove, then Confirm), checked against the API.
 * Unsubscribing a second time answers 404, not a server error.
 */
import { expect, test, type Page } from "@playwright/test";
import { escapeRegExp } from "../fixtures/shared";
import { dismissWhatsNew, getAuthToken, loginAsTestUser } from "../fixtures/test-helpers";
import { outsideFailure, pickUnfollowedShow } from "./podcastReplies";
import { requireBaseUrl } from "../fixtures/target";

const baseUrl = requireBaseUrl();

test.describe.serial("Podcast removal", () => {
    let page: Page;
    let token = "";
    let podcastId = "";
    let podcastTitle = "";

    test.beforeAll(async ({ browser }) => {
        page = await browser.newPage();
        await loginAsTestUser(page);
        await dismissWhatsNew(page);
        token = await getAuthToken(page);
        expect(token, "login should yield an auth token").toBeTruthy();
    });

    test("R1. subscribe to a podcast", async () => {
        // Only a show the user did not follow before is used: R3 and R4 remove it, which would erase a
        // followed show's progress and downloads. podcastId is set only for a show followed here.
        const picked = await pickUnfollowedShow(page.request, token);
        if ("none" in picked) {
            test.skip(true, `not covered: ${picked.none}`);
            return;
        }
        const pick = picked.show;
        podcastTitle = pick.title;

        const res = await page.request.post("/api/podcasts/subscribe", {
            data: { itunesId: pick.itunesId },
            headers: { Authorization: `Bearer ${token}` },
        });
        // Only a service outside Kima failing excuses the journey; any other failure is Kima's own.
        const blocked = await outsideFailure(res, "following the show");
        if (blocked) {
            test.skip(true, `${blocked}; the removal journey cannot run`);
            return;
        }
        const created = await res.json();
        podcastId = created.podcast.id;
        podcastTitle = created.podcast.title;
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
                const list = (await r.json()) as Array<{ id?: string }>;
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

        // Unsubscribing a show that is no longer followed is a 404, not a server error.
        const again = await page.request.delete(`/api/podcasts/${podcastId}/unsubscribe`, {
            headers: { Authorization: `Bearer ${token}` },
        });
        expect(again.status(), `second unsubscribe returned ${again.status()}`).toBe(404);
    });
});
