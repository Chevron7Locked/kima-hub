import { Page, TestInfo, expect, test } from "@playwright/test";
import { PLAYER, readPlayer } from "./shared";
import { LibraryPicker } from "./picker";

function requireEnv(name: string): string {
    const value = process.env[name];
    if (!value) {
        throw new Error(`Required env var ${name} is not set. Set it before running E2E tests.`);
    }
    return value;
}

const username = requireEnv("KIMA_TEST_USERNAME");
const password = requireEnv("KIMA_TEST_PASSWORD");

export async function loginAsTestUser(page: Page): Promise<void> {
    await page.goto("/login");
    await page.locator("#username").fill(username);
    await page.locator("#password").fill(password);
    await page.getByRole("button", { name: "Sign In" }).click();
    await page.waitForURL(/\/($|\?|home)/);
}

/**
 * Closes the What's New window, which is aria-modal and swallows every pointer event while it is up.
 * It mounts late on a cold session, so the first one is waited for (15 s); each release closed
 * can bring the next, so up to four are cleared. If the Close button is refused, the window's
 * changelog link is followed and the page it started on is reopened. With `watch`, a handler
 * also closes any later appearance on this page. Returns whether a window was shown.
 */
export async function dismissWhatsNew(page: Page, opts: { watch?: boolean } = {}): Promise<boolean> {
    const dialog = page.locator('div[role="dialog"][aria-labelledby="whats-new-title"]');
    const close = dialog.locator('button[aria-label="Close"]').first();
    if (opts.watch) {
        await page.addLocatorHandler(dialog, async () => {
            if (await close.isVisible().catch(() => false)) await close.click();
        });
    }
    let shownAny = false;
    for (let release = 0; release < 4; release++) {
        const shown = await dialog
            .waitFor({ state: "visible", timeout: release === 0 ? 15_000 : 3_000 })
            .then(() => true)
            .catch(() => false);
        if (!shown) break;
        shownAny = true;
        // The button is disabled while the close is being saved, so retry until the window is gone.
        let gone = false;
        for (let i = 0; i < 6 && !gone; i++) {
            if (await close.count()) await close.click({ timeout: 3_000 }).catch(() => {});
            gone = await dialog
                .waitFor({ state: "hidden", timeout: 2_500 })
                .then(() => true)
                .catch(() => false);
        }
        if (!gone) {
            const from = page.url();
            const changelog = dialog.locator('a[href="/changelog"]').first();
            await expect(changelog, "the What's New window must be dismissible").toBeVisible({ timeout: 5_000 });
            await changelog.click();
            await page.waitForURL(/\/changelog/, { timeout: 20_000 });
            await page.goto(from, { waitUntil: "domcontentloaded" });
        }
    }
    await expect(dialog, "the What's New window must be closed").toBeHidden({ timeout: 10_000 });
    return shownAny;
}

/** Read the auth token from localStorage (set after login) for use in page.request calls. */
export async function getAuthToken(page: Page): Promise<string> {
    return page.evaluate(() => localStorage.getItem("auth_token") ?? "");
}

export function skipIfNoEnv(envVar: string, testInfo: TestInfo): void {
    if (!process.env[envVar]) {
        testInfo.skip(true, `Skipping: ${envVar} not set`);
    }
}

/** Open an album the server says has at least two playable songs and start playing all of it.
 *  Skips, with the reason in the test report, only when the library has no such album. */
export async function startPlayingFirstAlbum(page: Page): Promise<void> {
    await page.goto("/collection?tab=albums");
    const token = await getAuthToken(page);
    // The tests skip, queue and move between songs, so the album needs at least two.
    const album = await new LibraryPicker(page.request, token).albumWithTracks(2);
    if (!album) {
        test.skip(true, "The library has no album with two or more playable songs");
        return;
    }
    await page.goto(`/album/${album.id}`);
    await page.locator("[data-track-row]").first().waitFor({ timeout: 10_000 });
    await page.getByLabel("Play all").click();
    await waitForPlaying(page); // waits for FullPlayer's title="pause"
}

/** Wait until the player shows the Pause button (meaning audio started).
 * Uses `title="pause"` to target the FullPlayer button specifically (avoids ambiguity
 * with album action bar and section-level Pause buttons). */
async function waitForPlaying(page: Page, timeoutMs = 8_000): Promise<void> {
    await page.getByTitle("pause", { exact: true }).waitFor({ timeout: timeoutMs });
}

/** Get the current <audio> src -- the stream URL. */
export async function getAudioSrc(page: Page): Promise<string> {
    return (await readPlayer(page)).src;
}

/** Get the current playback position in seconds. */
export async function getAudioCurrentTime(page: Page): Promise<number> {
    return (await readPlayer(page)).t;
}

/** Force-set the audio element currentTime (bypasses player seek logic -- test only). */
export async function setAudioCurrentTime(page: Page, seconds: number): Promise<void> {
    await page.evaluate(({ sel, t }) => {
        const el = document.querySelector(sel) as HTMLAudioElement | null;
        if (el) el.currentTime = t;
    }, { sel: PLAYER, t: seconds });
}

/** Wait for audio.src to change from the given value. */
export async function waitForSrcChange(page: Page, prevSrc: string, timeoutMs = 6_000): Promise<string> {
    await page.waitForFunction(
        ({ sel, prev }) => {
            const src = (document.querySelector(sel) as HTMLAudioElement | null)?.src ?? "";
            return src !== prev && src !== "";
        },
        { sel: PLAYER, prev: prevSrc },
        { timeout: timeoutMs },
    );
    return getAudioSrc(page);
}

/** Click the seek slider at a percentage of its width (0–100). */
export async function seekToPercent(page: Page, percent: number): Promise<void> {
    const slider = page.locator('[title="click or drag to seek"]');
    const box = await slider.boundingBox();
    if (!box) throw new Error("Seek slider not found");
    const x = box.x + box.width * (percent / 100);
    const y = box.y + box.height / 2;
    await page.mouse.click(x, y);
    await page.waitForTimeout(300);
}

/** Skip the current test if the library has no music.
 *  Must be called after login (reads auth token from localStorage). */
export async function skipIfEmptyLibrary(page: Page): Promise<void> {
    const token = await getAuthToken(page);
    let isEmpty = false;
    try {
        const res = await page.request.get("/api/library/tracks?limit=1", {
            headers: { Authorization: `Bearer ${token}` },
        });
        if (res.ok()) {
            const data = await res.json() as { tracks?: unknown[]; total?: number };
            const total = data.total ?? (data.tracks ?? []).length;
            isEmpty = total === 0;
        }
    } catch {
        // network error -- don't skip, let test proceed
    }
    // test.skip() must be called OUTSIDE the try/catch -- it works by throwing
    // a SkipError internally, which the catch block above would otherwise swallow.
    if (isEmpty) {
        test.skip(true, "No music in library -- skipping (empty CI container)");
    }
}

export { username, password };
