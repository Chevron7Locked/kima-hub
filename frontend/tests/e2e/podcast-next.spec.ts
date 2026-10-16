import { test, expect, type Page } from "@playwright/test";
import { loginAsTestUser, getAuthToken } from "./fixtures/test-helpers";

/**
 * Resuming an episode from "continue listening" and letting it end marks it finished and plays the show's next
 * episode by release date; the player's next button does the same. A real show (Dungeons and Daddies, whose
 * stitched-in ads make the audio longer than the feed says), so this needs the internet.
 */

type Ep = { id: string; title: string; publishedAt: string };

const playingElement = (page: Page) =>
    page.waitForFunction(() => Array.from(document.querySelectorAll("audio")).some((a) => a.duration > 0 && !a.paused), null, {
        timeout: 60_000,
    });

test("an episode that ends is finished, and the next one plays; the player's next button moves on too", async ({ page }) => {
    test.setTimeout(300_000);
    await loginAsTestUser(page);
    const auth = { Authorization: `Bearer ${await getAuthToken(page)}` };
    const sub = await page.request.post("/api/podcasts/subscribe", { headers: auth, data: { itunesId: "1450241676" } });
    expect(sub.ok()).toBe(true);
    const podcastId: string = (await sub.json()).podcast.id;
    try {
        const show = await (await page.request.get(`/api/podcasts/${podcastId}/episodes?order=newest&limit=10`, { headers: auth })).json();
        const [third, second, first, resumed]: Ep[] = show.episodes.slice(0, 4);
        // Started earlier, so it waits under "continue listening"; the three after it are unplayed.
        const started = await page.request.post(`/api/podcasts/${podcastId}/episodes/${resumed.id}/progress`, {
            headers: auth,
            data: { currentTime: 60, duration: 4000 },
        });
        expect(started.ok()).toBe(true);
        for (const ep of [first, second, third]) {
            await page.request.delete(`/api/podcasts/${podcastId}/episodes/${ep.id}/progress`, { headers: auth });
        }

        await page.goto("/podcasts");
        await page.getByRole("button", { name: `resume ${resumed.title}` }).click();
        await playingElement(page);
        // The player resumes at the saved minute once the audio can play; jumping before that is undone by it.
        await page.waitForFunction(
            () => Array.from(document.querySelectorAll("audio")).some((a) => !a.paused && !a.seeking && a.currentTime >= 60),
            null,
            { timeout: 30_000 },
        );
        await page.evaluate(() => {
            const a = Array.from(document.querySelectorAll("audio")).find((x) => !x.paused)!;
            a.currentTime = a.duration - 4;
        });

        const player = page.getByRole("region", { name: "now playing" }).first();
        await expect(player.locator("[data-player-title]").filter({ hasText: first.title }).first()).toBeAttached({ timeout: 45_000 });
        await expect
            .poll(async () => {
                const page1 = await (await page.request.get(`/api/podcasts/${podcastId}/episodes?order=newest&limit=10`, { headers: auth })).json();
                return page1.episodes.find((e: Ep) => e.id === resumed.id)?.progress?.isFinished;
            }, { timeout: 15_000 })
            .toBe(true);

        await playingElement(page);
        await player.getByRole("button", { name: "next episode" }).first().click();
        await expect(player.locator("[data-player-title]").filter({ hasText: second.title }).first()).toBeAttached({ timeout: 30_000 });
        await playingElement(page);
    } finally {
        await page.request.delete(`/api/podcasts/${podcastId}/unsubscribe`, { headers: auth });
    }
});

test("the show's newest episode ending stays finished: nothing next, and leaving the page saves nothing over it", async ({ page }) => {
    test.setTimeout(300_000);
    await loginAsTestUser(page);
    const auth = { Authorization: `Bearer ${await getAuthToken(page)}` };
    const sub = await page.request.post("/api/podcasts/subscribe", { headers: auth, data: { itunesId: "1450241676" } });
    expect(sub.ok()).toBe(true);
    const podcastId: string = (await sub.json()).podcast.id;
    try {
        const show = await (await page.request.get(`/api/podcasts/${podcastId}/episodes?order=newest&limit=1`, { headers: auth })).json();
        const newest: Ep = show.episodes[0];
        await page.request.post(`/api/podcasts/${podcastId}/episodes/${newest.id}/progress`, {
            headers: auth,
            data: { currentTime: 60, duration: 4000 },
        });
        const saves: Array<{ isFinished: boolean }> = [];
        page.on("request", (r) => {
            if (r.method() === "POST" && r.url().includes(`/episodes/${newest.id}/progress`)) saves.push(JSON.parse(r.postData() ?? "{}"));
        });

        await page.goto("/podcasts");
        await page.getByRole("button", { name: `resume ${newest.title}` }).click();
        await playingElement(page);
        await page.waitForFunction(
            () => Array.from(document.querySelectorAll("audio")).some((a) => !a.paused && !a.seeking && a.currentTime >= 60),
            null,
            { timeout: 30_000 },
        );
        await page.evaluate(() => {
            const a = Array.from(document.querySelectorAll("audio")).find((x) => !x.paused)!;
            a.currentTime = a.duration - 4;
        });
        await expect.poll(() => saves.some((s) => s.isFinished), { timeout: 30_000 }).toBe(true);
        // Nothing comes next: the player stops, then the page is left.
        await page.waitForTimeout(5_000);
        await page.goto("/");
        await page.waitForTimeout(2_000);

        const finishedAt = saves.findIndex((s) => s.isFinished);
        expect(saves.slice(finishedAt + 1).filter((s) => !s.isFinished)).toEqual([]);
        const after = await (await page.request.get(`/api/podcasts/${podcastId}/episodes?order=newest&limit=1`, { headers: auth })).json();
        expect(after.episodes[0].progress?.isFinished).toBe(true);
    } finally {
        await page.request.delete(`/api/podcasts/${podcastId}/unsubscribe`, { headers: auth });
    }
});
