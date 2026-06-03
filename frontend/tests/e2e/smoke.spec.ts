import { test, expect } from "@playwright/test";
import { skipIfEmptyLibrary, getAudioCurrentTime } from "./fixtures/test-helpers";

const username = process.env.KIMA_TEST_USERNAME || "predeploy";
const password = process.env.KIMA_TEST_PASSWORD || "predeploy-password";

test("core smoke: login → play album → play/pause/next/prev", async ({ page }) => {
    // Login
    await page.goto("/login");
    await page.locator("#username").fill(username);
    await page.locator("#password").fill(password);
    await page.getByRole("button", { name: "Sign In" }).click();

    // Login redirects to / (assuming onboarding was already completed by the API smoke test)
    await page.waitForURL(/\/($|\?)/);

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

    // Wait for playback to actually start before asserting transport state -- a
    // freshly-booted container can lag the first audio load past the locator's
    // default wait, which left the player "Not Playing" and flaked this test.
    await expect.poll(() => getAudioCurrentTime(page), { timeout: 15_000 }).toBeGreaterThan(0);

    // Player should reflect playing state
    const playPause = page.locator('button[title="Pause"], button[title="Play"]').first();
    await expect(playPause).toHaveAttribute("title", "Pause");

    // Toggle pause/play
    await playPause.click();
    await expect(playPause).toHaveAttribute("title", "Play");
    await playPause.click();
    await expect(playPause).toHaveAttribute("title", "Pause");

    // Verify the audio element is actually advancing -- not stalled at 0
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








