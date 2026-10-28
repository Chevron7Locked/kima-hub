import { test, expect, Page } from "@playwright/test";
import {
    loginAsTestUser,
    startPlayingFirstAlbum,
    getAudioSrc,
    waitForSrcChange,
} from "./fixtures/test-helpers";

/** Opens the right-hand panel on its queue tab in place: page.goto reloads the page and wipes the in-memory queue. */
async function openQueueByClick(page: Page): Promise<void> {
    const open = page.getByRole("button", { name: "open panel" });
    if (await open.isVisible().catch(() => false)) await open.click();
    await page.getByRole("tab", { name: "up next" }).click();
}

test.describe("Queue", () => {
    test.beforeEach(async ({ page }) => {
        await loginAsTestUser(page);
    });

    test("Add to queue button appends track to up-next list", async ({ page }) => {
        await startPlayingFirstAlbum(page);

        const firstTrackRow = page.locator("[data-track-row]").first();
        await firstTrackRow.waitFor({ timeout: 10_000 });
        await firstTrackRow.hover();
        await firstTrackRow.getByLabel("Add to queue").click();

        await openQueueByClick(page);

        // Rows up next must appear since the album has multiple tracks ahead
        await expect(page.locator("[data-queue-row]").first()).toBeVisible({ timeout: 5_000 });
    });

    test("queue panel shows the playing track when one is active", async ({ page }) => {
        await startPlayingFirstAlbum(page);

        await openQueueByClick(page);

        await expect(page.locator("[data-queue-now]")).toBeVisible({ timeout: 5_000 });
    });

    test("queue panel shows track count", async ({ page }) => {
        await startPlayingFirstAlbum(page);

        await openQueueByClick(page);

        // The queue header reads "{n} track(s) in the queue"
        await expect(page.locator("[data-queue-count]")).toHaveText(/\d+ tracks? in the queue/, { timeout: 5_000 });
    });

    test("Play now jumps to selected queue item", async ({ page }) => {
        await startPlayingFirstAlbum(page);

        const srcBefore = await getAudioSrc(page);

        await openQueueByClick(page);
        // Each queued row has "play <title>"; the player's own button is plain "Play"/"Pause".
        const playNowButtons = page.locator("[data-queue-row]").getByRole("button", { name: /^play .+/ });
        await expect(playNowButtons.first(), "a started album leaves tracks up next").toBeAttached({ timeout: 5_000 });
        await playNowButtons.first().click();

        const srcAfter = await waitForSrcChange(page, srcBefore, 8_000);
        expect(srcAfter).not.toBe(srcBefore);
    });

    test("Remove removes item from queue", async ({ page }) => {
        await startPlayingFirstAlbum(page);

        await openQueueByClick(page);

        // A row's actions show on hover where there is a pointer, so the rows are found by their markup.
        const upNext = page.locator("[data-queue-row]").filter({ has: page.locator('button[aria-label$=" from the queue"]') });
        await expect(upNext.first(), "a started album leaves tracks up next").toBeAttached({ timeout: 5_000 });
        const initialCount = await upNext.count();

        await upNext.first().hover();
        await upNext.first().getByRole("button", { name: /^remove .+ from the queue$/ }).click();

        await expect(upNext).toHaveCount(initialCount - 1, { timeout: 3_000 });
    });

    test("Move up reorders queue item", async ({ page }) => {
        await startPlayingFirstAlbum(page);

        await openQueueByClick(page);

        // A row's actions show on hover where there is a pointer, so the rows are found by their markup. The first
        // row up next cannot move up; the second one moves to the top.
        const upNext = page.locator("[data-queue-row]").filter({ has: page.locator('button[aria-label$=" up"]') });
        await expect(upNext.nth(1), "two tracks up next").toBeAttached({ timeout: 5_000 });
        const titlesBefore = await upNext.locator("p.text-sm").allTextContents();
        const targetTitle = titlesBefore[1];

        await upNext.nth(1).hover();
        await upNext.nth(1).getByRole("button", { name: /^move .+ up$/, disabled: false }).click();

        await expect.poll(async () => (await upNext.locator("p.text-sm").allTextContents())[0]).toBe(targetTitle);
    });

    test("Clear queue empties the up-next list", async ({ page }) => {
        await startPlayingFirstAlbum(page);

        await openQueueByClick(page);

        // Clear queue only appears when queue.length > 0, and asks before clearing
        const clearBtn = page.getByRole("button", { name: "clear queue" });
        await expect(clearBtn).toBeVisible({ timeout: 5_000 });
        await clearBtn.click();
        await page.getByRole("dialog", { name: "clear the queue?" }).getByRole("button", { name: "clear queue" }).click();

        await expect(page.getByText("the queue is empty")).toBeVisible({ timeout: 5_000 });
    });
});
