import { Page, TestInfo, test } from "@playwright/test";

function requireEnv(name: string): string {
    const value = process.env[name];
    if (!value) {
        throw new Error(`Required env var ${name} is not set. Set it before running E2E tests.`);
    }
    return value;
}

const username = requireEnv("KIMA_TEST_USERNAME");
const password = requireEnv("KIMA_TEST_PASSWORD");
const baseUrl = process.env.KIMA_UI_BASE_URL || "http://127.0.0.1:3030";

export async function loginAsTestUser(page: Page): Promise<void> {
    await page.goto("/login");
    await page.locator("#username").fill(username);
    await page.locator("#password").fill(password);
    await page.getByRole("button", { name: "Sign In" }).click();
    await page.waitForURL(/\/($|\?|home)/);
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

/** Navigate to the first available album and start playing all tracks.
 *  Skips gracefully if the library has no music (e.g., bare CI container). */
export async function startPlayingFirstAlbum(page: Page): Promise<void> {
    await page.goto("/collection?tab=albums");
    const firstAlbum = page.locator('a[href^="/album/"]').first();
    try {
        await firstAlbum.waitFor({ timeout: 10_000 });
    } catch {
        test.skip(true, "No music in library -- skipping (empty container)");
        return;
    }
    await firstAlbum.click();
    await page.waitForURL(/\/album\//);
    await page.getByLabel("Play all").click();
    await waitForPlaying(page); // waits for FullPlayer's title="Pause"
}

/** Wait until the player shows the Pause button (meaning audio started).
 * Uses `title="Pause"` to target the FullPlayer button specifically (avoids ambiguity
 * with album action bar and section-level Pause buttons). */
export async function waitForPlaying(page: Page, timeoutMs = 8_000): Promise<void> {
    await page.getByTitle("Pause", { exact: true }).waitFor({ timeout: timeoutMs });
}

/** Get the current <audio> src -- the stream URL. */
export async function getAudioSrc(page: Page): Promise<string> {
    return page.evaluate(() => {
        const el = document.querySelector('[data-kima-player="main"]') as HTMLAudioElement | null;
        return el?.src ?? "";
    });
}

/** Get the current playback position in seconds. */
export async function getAudioCurrentTime(page: Page): Promise<number> {
    return page.evaluate(() => (document.querySelector('[data-kima-player="main"]') as HTMLAudioElement | null)?.currentTime ?? -1);
}

/** Force-set the audio element currentTime (bypasses player seek logic -- test only). */
export async function setAudioCurrentTime(page: Page, seconds: number): Promise<void> {
    await page.evaluate((t) => {
        const el = document.querySelector('[data-kima-player="main"]') as HTMLAudioElement | null;
        if (el) el.currentTime = t;
    }, seconds);
}

/** Wait for audio.src to change from the given value. */
export async function waitForSrcChange(page: Page, prevSrc: string, timeoutMs = 6_000): Promise<string> {
    await page.waitForFunction(
        (prev) => {
            const src = (document.querySelector('[data-kima-player="main"]') as HTMLAudioElement | null)?.src ?? "";
            return src !== prev && src !== "";
        },
        prevSrc,
        { timeout: timeoutMs },
    );
    return getAudioSrc(page);
}

/** Click the seek slider at a percentage of its width (0–100). */
export async function seekToPercent(page: Page, percent: number): Promise<void> {
    const slider = page.locator('[title="Click or drag to seek"]');
    const box = await slider.boundingBox();
    if (!box) throw new Error("Seek slider not found");
    const x = box.x + box.width * (percent / 100);
    const y = box.y + box.height / 2;
    await page.mouse.click(x, y);
    // Brief settle time for the seek to take effect
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

export { username, password, baseUrl };
