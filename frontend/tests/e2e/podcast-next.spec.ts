import { test, expect, type Page } from "@playwright/test";
import { loginAsTestUser, getAuthToken } from "./fixtures/test-helpers";
import { SEED_SHOW as SHOW } from "./dogfood/podcastReplies";

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

/** Waits until audio plays past the saved minute. The player resumes there once the audio can play; jumping before that is undone by it. */
const playingPastResume = (page: Page, timeout: number) =>
    page.waitForFunction(
        () => Array.from(document.querySelectorAll("audio")).some((a) => !a.paused && !a.seeking && a.currentTime >= 60),
        null,
        { timeout },
    );

/** Jumps the playing audio to four seconds before its own end (the feed's length is shorter than the audio's). */
const seekNearEnd = (page: Page) =>
    page.evaluate(() => {
        const a = Array.from(document.querySelectorAll("audio")).find((x) => !x.paused)!;
        a.currentTime = a.duration - 4;
    });

// Each test saves progress on the show and unfollows it at the end.

/**
 * Follows the show and returns its id, but skips the test when the user already follows it:
 * the test would overwrite that show's progress and then unfollow it.
 */
async function followNew(page: Page, auth: Record<string, string>): Promise<string> {
    const preview = await page.request.get(`/api/podcasts/preview/${SHOW}`, { headers: auth });
    expect(preview.ok(), `previewing the show returned ${preview.status()}`).toBe(true);
    if ((await preview.json()).isSubscribed) {
        test.skip(true, "not covered: this user already follows the show, and the test would overwrite its progress and unfollow it");
    }
    const sub = await page.request.post("/api/podcasts/subscribe", { headers: auth, data: { itunesId: SHOW } });
    expect(sub.ok()).toBe(true);
    return (await sub.json()).podcast.id;
}

test("an episode that ends is finished, and the next one plays; the player's next button moves on too", async ({ page }) => {
    test.setTimeout(300_000);
    await loginAsTestUser(page);
    const auth = { Authorization: `Bearer ${await getAuthToken(page)}` };
    const podcastId = await followNew(page, auth);
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
        await playingPastResume(page, 30_000);
        await seekNearEnd(page);

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
    const podcastId = await followNew(page, auth);
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
        await playingPastResume(page, 30_000);
        await seekNearEnd(page);
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

test("an episode played to 95% of its own length is finished; seeking back and saving makes it unfinished again", async ({ page }) => {
    test.setTimeout(300_000);
    await loginAsTestUser(page);
    const auth = { Authorization: `Bearer ${await getAuthToken(page)}` };
    const podcastId = await followNew(page, auth);
    let episodeId = "";
    const progressOf = async () => {
        const list = await (await page.request.get(`/api/podcasts/${podcastId}/episodes?order=newest&limit=1`, { headers: auth })).json();
        return list.episodes[0].progress as { isFinished: boolean; currentTime: number } | null;
    };
    try {
        const show = await (await page.request.get(`/api/podcasts/${podcastId}/episodes?order=newest&limit=1`, { headers: auth })).json();
        const ep: Ep = show.episodes[0];
        episodeId = ep.id;
        // Started earlier, so it waits under "continue listening" with a resume control.
        const started = await page.request.post(`/api/podcasts/${podcastId}/episodes/${ep.id}/progress`, {
            headers: auth,
            data: { currentTime: 60, duration: 4000 },
        });
        expect(started.ok()).toBe(true);
        expect((await progressOf())?.isFinished).toBe(false);

        await page.goto("/podcasts");
        await page.getByRole("button", { name: `resume ${ep.title}` }).click();
        await playingPastResume(page, 60_000);

        // Jump to 96% of the audio's own length (not the feed's), then pause: pausing saves progress.
        const target = await page.evaluate(() => {
            const a = Array.from(document.querySelectorAll("audio")).find((x) => !x.paused)!;
            a.currentTime = a.duration * 0.96;
            return { duration: a.duration, at: a.currentTime };
        });
        expect(target.duration).toBeGreaterThan(0);
        await page.waitForFunction(() => Array.from(document.querySelectorAll("audio")).some((a) => !a.seeking && a.currentTime > 0 && a.duration > 0 && a.currentTime / a.duration >= 0.95));
        await page.locator('[title="pause"]:visible').first().click();
        await expect.poll(async () => (await progressOf())?.isFinished, { timeout: 20_000 }).toBe(true);
        const finished = (await progressOf())!;
        expect(finished.currentTime).toBeGreaterThanOrEqual(target.duration * 0.95 - 1);

        // Seek back to ~10%, play, and pause again: that save is under 95% of the length, so unfinished.
        await page.locator('[title="play"]:visible').first().click();
        await page.waitForFunction(() => Array.from(document.querySelectorAll("audio")).some((a) => !a.paused && a.duration > 0));
        const back = await page.evaluate(() => {
            const a = Array.from(document.querySelectorAll("audio")).find((x) => !x.paused)!;
            a.currentTime = a.duration * 0.1;
            return { duration: a.duration };
        });
        await page.waitForFunction(() => Array.from(document.querySelectorAll("audio")).some((a) => !a.paused && !a.seeking && a.duration > 0 && a.currentTime / a.duration < 0.2));
        await page.locator('[title="pause"]:visible').first().click();
        await expect.poll(async () => (await progressOf())?.isFinished, { timeout: 20_000 }).toBe(false);
        expect((await progressOf())!.currentTime).toBeLessThan(back.duration * 0.5);
    } finally {
        if (episodeId) await page.request.delete(`/api/podcasts/${podcastId}/episodes/${episodeId}/progress`, { headers: auth });
        await page.request.delete(`/api/podcasts/${podcastId}/unsubscribe`, { headers: auth });
    }
});
