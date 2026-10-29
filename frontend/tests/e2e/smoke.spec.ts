import { test, expect } from "@playwright/test";
import { loginAsTestUser, skipIfEmptyLibrary, getAudioCurrentTime } from "./fixtures/test-helpers";

test("core smoke: login → play album → play/pause/next/prev", async ({ page }) => {
    await loginAsTestUser(page);

    await skipIfEmptyLibrary(page);

    // Navigate to albums and open the first one
    await page.goto("/collection?tab=albums");
    await expect(page.locator('a[href^="/album/"]').first()).toBeVisible({ timeout: 10_000 });

    const firstAlbum = page.locator('a[href^="/album/"]').first();
    const albumCount = await firstAlbum.count();
    expect(albumCount).toBeGreaterThan(0);
    await firstAlbum.click();

    // Start playback
    await page.getByLabel("Play all").click();

    // Wait for playback to start before asserting transport state: a freshly-booted
    // container can lag the first audio load past the locator's default wait.
    await expect.poll(() => getAudioCurrentTime(page), { timeout: 15_000 }).toBeGreaterThan(0);

    // Player should reflect playing state
    const playPause = page.locator('button[title="pause"], button[title="play"]').first();
    await expect(playPause).toHaveAttribute("title", "pause");

    // Toggle pause/play
    await playPause.click();
    await expect(playPause).toHaveAttribute("title", "play");
    await playPause.click();
    await expect(playPause).toHaveAttribute("title", "pause");

    const t0 = await getAudioCurrentTime(page);
    await page.waitForTimeout(2_000);
    const t1 = await getAudioCurrentTime(page);
    expect(t1).toBeGreaterThan(t0);

    // Next/Previous should be available for tracks (library content)
    const nextBtn = page.getByLabel("Next track");
    const prevBtn = page.getByLabel("Previous track");
    await expect(nextBtn).toBeVisible();
    await expect(prevBtn).toBeVisible();

    await nextBtn.click();
    await prevBtn.click();
});

