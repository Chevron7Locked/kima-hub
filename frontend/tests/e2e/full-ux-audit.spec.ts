import { test, expect, Page, Response } from "@playwright/test";
import { loginAsTestUser as login, skipIfEmptyLibrary } from "./fixtures/test-helpers";
import { readPlayer, settle, softwareWebGL } from "./fixtures/shared";
import { requireBaseUrl } from "./fixtures/target";

/** The app shell scrolls inside #main-content, so the document alone never overflows. */
const OVERFLOWS = () =>
    [document.documentElement, document.querySelector("#main-content")].some(
        (el) => !!el && el.scrollWidth > el.clientWidth + 1,
    );

const baseUrl = requireBaseUrl();

test.use(softwareWebGL);

const ROUTES = [
    { path: "/", name: "Home" },
    { path: "/collection", name: "Collection" },
    { path: "/collection?tab=albums", name: "Albums Tab" },
    { path: "/collection?tab=artists", name: "Artists Tab" },
    { path: "/collection?tab=tracks", name: "Tracks Tab" },
    { path: "/search", name: "Search" },
    { path: "/settings", name: "Settings" },
    { path: "/discover", name: "Discover" },
    { path: "/releases", name: "Releases" },
    { path: "/vibe", name: "Vibe" },
    { path: "/playlists", name: "Playlists" },
    { path: "/audiobooks", name: "Audiobooks" },
    { path: "/podcasts", name: "Podcasts" },
    { path: "/radio", name: "Radio" },
];

const SEARCH_INPUT = 'input[type="search"], input[placeholder*="search" i], input[type="text"]';

/** Opens the collection's albums tab, then the first album's page. */
async function openFirstAlbum(page: Page): Promise<void> {
    await page.goto("/collection?tab=albums", { waitUntil: "domcontentloaded" });
    await settle(page, 3000);
    const firstAlbum = page.locator('a[href^="/album/"]').first();
    await expect(firstAlbum).toBeVisible({ timeout: 10000 });
    await firstAlbum.click();
    await expect(page).toHaveURL(/\/album\//);
    await settle(page, 3000);
}

/** Waits for the search page to show the results heading for `query`. */
async function searchFor(page: Page, query: string): Promise<void> {
    await page.goto("/search", { waitUntil: "domcontentloaded" });
    await settle(page, 2000);
    const input = page.locator(SEARCH_INPUT).first();
    await input.fill(query);
    await input.press("Enter");
    await expect(page).toHaveURL(new RegExp(`[?&]q=${encodeURIComponent(query)}(&|$)`));
    await expect(page.getByRole("heading", { level: 1, name: query, exact: true })).toBeVisible({ timeout: 10000 });
}

function isBrowserNoise(text: string): boolean {
    return text.includes("favicon") || text.includes("serviceWorker");
}

/** "status METHOD path" for a failed API response, or null for anything else. */
function apiFailure(resp: Response): string | null {
    const url = resp.url();
    if (!url.includes("/api/") || resp.status() < 400) return null;
    return `${resp.status()} ${resp.request().method()} ${url.replace(baseUrl, "")}`;
}

function collectNetworkErrors(page: Page): string[] {
    const errors: string[] = [];
    page.on("response", (resp) => {
        const failure = apiFailure(resp);
        if (failure) errors.push(failure);
    });
    return errors;
}

// ============================================================
// 1. AUTH FLOW
// ============================================================
test.describe("Auth Flow", () => {
    test("login page renders correctly", async ({ page }) => {
        await page.goto("/login");
        await expect(page.getByRole("heading", { name: /welcome|sign in/i })).toBeVisible();
        await expect(page.locator("#username")).toBeVisible();
        await expect(page.locator("#password")).toBeVisible();
        await expect(page.getByRole("button", { name: "Sign In" })).toBeVisible();
    });

    test("invalid login shows error message", async ({ page }) => {
        await page.goto("/login");
        await page.locator("#username").fill("nonexistent");
        await page.locator("#password").fill("wrongpassword");
        await page.getByRole("button", { name: "Sign In" }).click();
        await expect(page.locator("text=/invalid|error|not authenticated/i")).toBeVisible({ timeout: 5000 });
        await expect(page).toHaveURL(/login/);
    });

    test("empty form submission stays on login", async ({ page }) => {
        await page.goto("/login");
        await page.getByRole("button", { name: "Sign In" }).click();
        await page.waitForTimeout(1000);
        await expect(page).toHaveURL(/login/);
    });

    test("successful login redirects to home", async ({ page }) => {
        await login(page);
        await expect(page).not.toHaveURL(/login/);
    });

    test("protected routes redirect unauthenticated users", async ({ page }) => {
        for (const route of ["/collection", "/settings", "/search", "/vibe"]) {
            await page.goto(route);
            await expect(page).toHaveURL(/login/, { timeout: 10000 });
        }
    });
});

// ============================================================
// 2. ROUTE HEALTH CHECK
// ============================================================
test.describe("Route Health", () => {
    test.beforeEach(async ({ page }) => { await login(page); });

    test("all main routes load without crashing", async ({ page }) => {
        const results: Array<{ route: string; name: string; status: string; errors: string[] }> = [];

        for (const route of ROUTES) {
            const networkErrors = collectNetworkErrors(page);
            try {
                const response = await page.goto(route.path, { timeout: 15000, waitUntil: "domcontentloaded" });
                await page.waitForTimeout(2500);

                const hasErrorBoundary = await page.locator("text=/something went wrong|application error/i").count();
                const httpStatus = response?.status() || 0;
                const serverErrors = networkErrors.filter((e) => /^5\d\d /.test(e));

                results.push({
                    route: route.path,
                    name: route.name,
                    status: httpStatus >= 500 || hasErrorBoundary > 0 || serverErrors.length > 0 ? "ERROR" : "OK",
                    errors: [...networkErrors],
                });
            } catch (err) {
                results.push({
                    route: route.path,
                    name: route.name,
                    status: "CRASH",
                    errors: [String(err).slice(0, 150)],
                });
            }
            page.removeAllListeners("response");
        }

        const crashes = results.filter((r) => r.status === "CRASH" || r.status === "ERROR");
        expect(
            crashes.map((c) => `${c.name} ${c.route}: ${c.errors.join("; ")}`),
            "routes that crashed, showed an error screen or got a 5xx from the API",
        ).toEqual([]);
    });
});

// ============================================================
// 3. COLLECTION / LIBRARY
// ============================================================
test.describe("Collection & Library", () => {
    test.beforeEach(async ({ page }) => { await login(page); });

    test("collection page loads with tabs", async ({ page }) => {
        await page.goto("/collection", { waitUntil: "domcontentloaded" });
        await settle(page, 2000);
        const tabs = page.locator("text=/albums|artists|tracks/i");
        await expect(tabs.first()).toBeVisible({ timeout: 10000 });
    });

    test("albums tab shows album cards with links", async ({ page }) => {
        await skipIfEmptyLibrary(page);
        await page.goto("/collection?tab=albums", { waitUntil: "domcontentloaded" });
        await settle(page, 3000);
        const albumLinks = page.locator('a[href^="/album/"]');
        await expect(albumLinks.first()).toBeVisible({ timeout: 10000 });
        expect(await albumLinks.count()).toBeGreaterThan(0);
    });

    test("artists tab shows artist cards", async ({ page }) => {
        await skipIfEmptyLibrary(page);
        await page.goto("/collection?tab=artists", { waitUntil: "domcontentloaded" });
        await settle(page, 3000);
        const artistLinks = page.locator('a[href^="/artist/"]');
        await expect(artistLinks.first()).toBeVisible({ timeout: 10000 });
        expect(await artistLinks.count()).toBeGreaterThan(0);
    });

    test("tracks tab shows track rows", async ({ page }) => {
        await skipIfEmptyLibrary(page);
        await page.goto("/collection?tab=tracks", { waitUntil: "domcontentloaded" });
        await settle(page, 3000);
        // Track rows are divs; the tab pills above them are buttons with the same marker.
        const rows = page.locator("div[data-tv-card]");
        await expect(rows.first()).toBeVisible({ timeout: 10000 });
        await expect(rows.first().getByRole("button", { name: /^(Play|Pause)$/ })).toBeAttached();
    });

    test("album detail page has play button and track list", async ({ page }) => {
        await skipIfEmptyLibrary(page);
        const netErrors = collectNetworkErrors(page);
        await openFirstAlbum(page);

        await expect(page.getByRole("button", { name: "play all", exact: true })).toBeVisible({ timeout: 5000 });
        await expect(page.locator("[data-track-index]").first()).toBeVisible();
        await expect(page.getByRole("heading", { name: /album not found|couldn't load this album/i })).toHaveCount(0);
        expect(netErrors.filter((e) => /^5\d\d /.test(e)), "the album page got 5xx API answers").toEqual([]);
    });

    test("artist detail page loads", async ({ page }) => {
        await skipIfEmptyLibrary(page);
        await page.goto("/collection?tab=artists", { waitUntil: "domcontentloaded" });
        await settle(page, 3000);

        const firstArtist = page.locator('a[href^="/artist/"]').first();
        await expect(firstArtist).toBeVisible({ timeout: 10000 });
        await firstArtist.click();
        await expect(page).toHaveURL(/\/artist\//);
        await settle(page, 3000);

        await expect(page.getByRole("heading", { name: /artist not found|couldn't load this artist/i })).toHaveCount(0);
        await expect(page.getByRole("heading", { level: 1 }).first()).toBeVisible();
    });
});

// ============================================================
// 4. SEARCH
// ============================================================
test.describe("Search", () => {
    test.beforeEach(async ({ page }) => { await login(page); });

    test("search page has input field", async ({ page }) => {
        await page.goto("/search", { waitUntil: "domcontentloaded" });
        await settle(page, 2000);
        const searchInput = page.locator('input[type="search"], input[placeholder*="search" i], input[type="text"]');
        await expect(searchInput.first()).toBeVisible({ timeout: 5000 });
    });

    test("typing in search triggers results", async ({ page }) => {
        await searchFor(page, "a");
        await expect(page.getByText("Scanning library and network...")).toBeHidden({ timeout: 30_000 });
    });

    test("search with gibberish completes and shows the query", async ({ page }) => {
        await searchFor(page, "xyznonexistentquery12345");
        await expect(page.getByText("Scanning library and network...")).toBeHidden({ timeout: 30_000 });
        await expect(page.getByText(/something went wrong|application error/i)).toHaveCount(0);
    });
});

// ============================================================
// 5. PLAYBACK
// ============================================================
test.describe("Playback", () => {
    test.beforeEach(async ({ page }) => { await login(page); });

    test("player appears when track starts playing", async ({ page }) => {
        await skipIfEmptyLibrary(page);
        await openFirstAlbum(page);

        await page.getByLabel("Play all").click();

        await expect(page.getByTitle("pause", { exact: true })).toBeVisible({ timeout: 10_000 });
    });

    test("clicking play on album plays audio that advances", async ({ page }) => {
        await skipIfEmptyLibrary(page);
        await openFirstAlbum(page);

        const playBtn = page.getByRole("button", { name: "play all", exact: true });
        await expect(playBtn).toBeVisible({ timeout: 5000 });
        await playBtn.click();
        await expect(page.getByTitle("pause", { exact: true })).toBeVisible({ timeout: 10_000 });

        const first = await readPlayer(page);
        await page.waitForTimeout(3000);
        const second = await readPlayer(page);
        expect(second.src, "the audio element has no stream source").toMatch(/\/tracks\/[^/]+\/stream/);
        expect(second.paused, "the player shows Pause but the audio is paused").toBe(false);
        expect(second.t, `playback did not advance (${first.t}s -> ${second.t}s)`).toBeGreaterThan(first.t);
    });

    test("play/pause toggle works", async ({ page }) => {
        await skipIfEmptyLibrary(page);
        await openFirstAlbum(page);

        const playBtn = page.getByRole("button", { name: "play all", exact: true });
        await playBtn.click();
        await page.waitForTimeout(2000);

        const pauseBtn = page.locator('button[title="pause"]').first();
        await expect(pauseBtn, "playback started").toBeVisible({ timeout: 5000 });
        await pauseBtn.click();
        await expect(page.locator('button[title="play"]').first()).toBeVisible({ timeout: 3000 });
    });

    test("next/prev buttons visible during playback", async ({ page }) => {
        await skipIfEmptyLibrary(page);
        await openFirstAlbum(page);

        const playBtn = page.getByRole("button", { name: "play all", exact: true });
        await playBtn.click();
        await page.waitForTimeout(2000);

        await expect(page.getByRole("button", { name: "Next track" }).first()).toBeVisible({ timeout: 5000 });
        await expect(page.getByRole("button", { name: "Previous track" }).first()).toBeVisible({ timeout: 5000 });
    });
});

// ============================================================
// 6. SETTINGS
// ============================================================
test.describe("Settings", () => {
    test.beforeEach(async ({ page }) => { await login(page); });

    test("settings page loads", async ({ page }) => {
        const netErrors = collectNetworkErrors(page);
        await page.goto("/settings", { waitUntil: "domcontentloaded" });
        await settle(page, 3000);

        await expect(page.getByText("Settings could not be loaded")).toHaveCount(0);
        await expect(page.locator(".section-stack")).toBeVisible({ timeout: 10000 });
        expect(netErrors.filter((e) => /^5\d\d /.test(e)), "settings got 5xx API answers").toEqual([]);
    });

    test("settings has navigable sections", async ({ page }) => {
        await page.goto("/settings", { waitUntil: "domcontentloaded" });
        await settle(page, 3000);

        // Every user, admin or not, gets these four sections.
        for (const id of ["account", "subsonic", "playback", "scrobbling"]) {
            await expect(page.locator(`section#${id}`), `the ${id} section is missing`).toBeAttached({ timeout: 10000 });
        }
    });
});

// ============================================================
// 7. VIBE / DISCOVERY
// ============================================================
test.describe("Vibe & Discovery", () => {
    test.beforeEach(async ({ page }) => { await login(page); });

    test("vibe page loads without crash", async ({ page }) => {
        const netErrors = collectNetworkErrors(page);
        await page.goto("/vibe", { waitUntil: "domcontentloaded" });
        await settle(page, 3000);

        // Any of these is a healthy answer for some instance: the map, a build in progress, or no analysed tracks yet.
        const healthy = page
            .getByTestId("vibe-map-field")
            .or(page.getByText(/charting your library|getting your sound features ready|no tracks with vibe analysis yet/i));
        await expect(healthy.first()).toBeVisible({ timeout: 15000 });
        await expect(page.getByText(/the music map did not load|the map could not be drawn/i)).toHaveCount(0);
        expect(netErrors.filter((e) => /^5\d\d /.test(e)), "the vibe page got 5xx API answers").toEqual([]);
    });

    test("discover page loads", async ({ page }) => {
        const netErrors = collectNetworkErrors(page);
        await page.goto("/discover", { waitUntil: "domcontentloaded" });
        await settle(page, 3000);

        await expect(page.getByText("Could not load discovery data.")).toHaveCount(0);
        await expect(page.getByRole("heading", { level: 1, name: "Discover Weekly" })).toBeVisible({ timeout: 10000 });
        expect(netErrors.filter((e) => /^5\d\d /.test(e)), "discover got 5xx API answers").toEqual([]);
    });

    test("releases page loads", async ({ page }) => {
        const netErrors = collectNetworkErrors(page);
        await page.goto("/releases", { waitUntil: "domcontentloaded" });
        await settle(page, 3000);

        await expect(page.getByRole("heading", { level: 1, name: "New and upcoming" })).toBeVisible({ timeout: 10000 });
        await expect(page.getByRole("heading", { name: "Couldn't load releases" })).toHaveCount(0);
        expect(netErrors.filter((e) => /^5\d\d /.test(e)), "releases got 5xx API answers").toEqual([]);
    });
});

// ============================================================
// 8. IMAGE/ASSET LOADING
// ============================================================
test.describe("Asset Loading", () => {
    test.beforeEach(async ({ page }) => { await login(page); });

    test("album covers load without 404s", async ({ page }) => {
        const brokenAssets: string[] = [];
        page.on("response", (resp) => {
            const url = resp.url();
            // A cover-art 404 is the server's "this album has no art"; the page then draws no image (CachedImage).
            const noArt = url.includes("/cover-art") && resp.status() === 404;
            if ((url.includes("cover") || url.includes("image") || url.includes(".jpg") || url.includes(".webp")) && resp.status() >= 400 && !noArt) {
                brokenAssets.push(`${resp.status()} ${url.slice(0, 100)}`);
            }
        });

        await page.goto("/collection?tab=albums", { waitUntil: "domcontentloaded" });
        await settle(page, 4000);

        expect(brokenAssets, "cover or image requests that failed").toEqual([]);

        // An image the browser finished loading with no pixels is a broken picture.
        const failedImages = await page.evaluate(() =>
            Array.from(document.querySelectorAll("img"))
                .slice(0, 20)
                .filter((img) => img.complete && img.naturalWidth === 0)
                .map((img) => img.src.slice(0, 100)),
        );
        expect(failedImages, "images that finished loading with no pixels").toEqual([]);
    });
});

// ============================================================
// 9. MOBILE LAYOUT
// ============================================================
test.describe("Mobile Layout", () => {
    test.use({ viewport: { width: 375, height: 812 } });
    test.beforeEach(async ({ page }) => { await login(page); });

    test("mobile: home page renders without horizontal overflow", async ({ page }) => {
        await page.goto("/", { waitUntil: "domcontentloaded" });
        await settle(page, 2000);

        const hasOverflow = await page.evaluate(OVERFLOWS);
        expect(hasOverflow, "the home page must not scroll sideways").toBe(false);
    });

    test("mobile: bottom nav present", async ({ page }) => {
        await page.goto("/", { waitUntil: "domcontentloaded" });
        await settle(page, 2000);

        const nav = page.getByRole("navigation", { name: "Main navigation" });
        await expect(nav).toBeVisible({ timeout: 10000 });
        for (const name of ["collection", "vibe", "podcasts", "playlists"]) {
            await expect(nav.getByRole("link", { name }), `the bottom nav has no ${name} link`).toBeVisible();
        }
    });

    test("mobile: collection page works at small viewport", async ({ page }) => {
        await skipIfEmptyLibrary(page);
        await page.goto("/collection?tab=albums", { waitUntil: "domcontentloaded" });
        await settle(page, 3000);

        const albumLinks = page.locator('a[href^="/album/"]');
        await expect(albumLinks.first()).toBeVisible({ timeout: 10000 });
    });

    test("mobile: album detail has no overflow", async ({ page }) => {
        await skipIfEmptyLibrary(page);
        await openFirstAlbum(page);

        const hasOverflow = await page.evaluate(OVERFLOWS);
        expect(hasOverflow, "the album page must not scroll sideways").toBe(false);
    });

    test("mobile: search input accessible", async ({ page }) => {
        await page.goto("/search", { waitUntil: "domcontentloaded" });
        await settle(page, 2000);

        const searchInput = page.locator('input[type="search"], input[placeholder*="search" i], input[type="text"]').first();
        await expect(searchInput).toBeVisible({ timeout: 5000 });
    });

    test("mobile: overflow audit across pages", async ({ page }) => {
        const overflowPages: string[] = [];
        for (const route of ["/", "/collection", "/search", "/settings", "/vibe"]) {
            await page.goto(route, { waitUntil: "domcontentloaded" });
            await settle(page, 2000);

            if (await page.evaluate(OVERFLOWS)) overflowPages.push(route);
        }

        expect(overflowPages, "pages that scroll sideways").toEqual([]);
    });
});

// ============================================================
// 10. ACCESSIBILITY BASICS
// ============================================================
test.describe("Accessibility", () => {
    test.beforeEach(async ({ page }) => { await login(page); });

    test("heading hierarchy audit", async ({ page }) => {
        for (const route of ["/", "/collection", "/search", "/settings"]) {
            await page.goto(route, { waitUntil: "domcontentloaded" });
            await settle(page, 2000);

            const headings = await page.evaluate(() => document.querySelectorAll("h1, h2, h3, h4, h5, h6").length);
            expect(headings, `${route} has no headings`).toBeGreaterThan(0);
        }
    });

    test("buttons without accessible names", async ({ page }) => {
        await page.goto("/", { waitUntil: "domcontentloaded" });
        await settle(page, 2000);

        const unlabeled = await page.evaluate(() =>
            Array.from(document.querySelectorAll("button"))
                .filter(
                    (btn) =>
                        !btn.textContent?.trim() &&
                        !btn.getAttribute("aria-label") &&
                        !btn.getAttribute("aria-labelledby") &&
                        !btn.getAttribute("title") &&
                        !btn.querySelector("img[alt]:not([alt=''])"),
                )
                .map((btn) => btn.outerHTML.slice(0, 150)),
        );

        expect(unlabeled, "buttons with no text, label or title").toEqual([]);
    });

    test("images without alt text audit", async ({ page }) => {
        await page.goto("/collection?tab=albums", { waitUntil: "domcontentloaded" });
        await settle(page, 3000);

        // alt="" marks a decorative image and is fine; a missing alt attribute is not.
        const noAlt = await page.evaluate(() =>
            Array.from(document.querySelectorAll("img"))
                .filter((img) => !img.hasAttribute("alt") && !img.getAttribute("role"))
                .map((img) => img.src.slice(0, 80)),
        );

        expect(noAlt, "images with no alt attribute").toEqual([]);
    });
});

// ============================================================
// 11. ERROR HANDLING
// ============================================================
test.describe("Error Handling", () => {
    test.beforeEach(async ({ page }) => { await login(page); });

    test("invalid album ID handled gracefully", async ({ page }) => {
        await page.goto("/album/nonexistent-id-12345", { waitUntil: "domcontentloaded" });
        await expect(page.getByRole("heading", { name: "Album not found" })).toBeVisible({ timeout: 15000 });
    });

    test("invalid artist ID handled gracefully", async ({ page }) => {
        await page.goto("/artist/nonexistent-id-12345", { waitUntil: "domcontentloaded" });
        await expect(page.getByRole("heading", { name: "Artist not found" })).toBeVisible({ timeout: 15000 });
    });

    test("nonexistent route handled", async ({ page }) => {
        await page.goto("/this-route-does-not-exist-xyz", { waitUntil: "domcontentloaded" });
        await expect(page.getByRole("heading", { name: "Page not found" })).toBeVisible({ timeout: 10000 });
    });
});

// ============================================================
// 12. PERFORMANCE
// ============================================================
test.describe("Performance", () => {
    test.beforeEach(async ({ page }) => { await login(page); });

    test("page load times", async ({ page }) => {
        const timings: string[] = [];
        for (const [name, path] of [
            ["Home", "/"],
            ["Collection", "/collection?tab=albums"],
            ["Search", "/search"],
            ["Settings", "/settings"],
            ["Vibe", "/vibe"],
        ] as const) {
            const start = Date.now();
            // The navigation's own timeout fails the test if a page never reaches domcontentloaded.
            const response = await page.goto(path, { waitUntil: "domcontentloaded" });
            expect(response?.status() ?? 0, `${name} answered ${response?.status()}`).toBeLessThan(400);
            timings.push(`${name} ${Date.now() - start}ms`);
            await page.waitForTimeout(1000);
        }

        test.info().annotations.push({ type: "domcontentloaded times", description: timings.join(", ") });
    });

    test("home page API replies are all successful", async ({ page }) => {
        const replies: string[] = [];
        const failed: string[] = [];

        // The listener starts after sign-in has finished, so its leftover replies are not counted.
        page.on("response", (res) => {
            if (!res.url().includes("/api/")) return;
            const line = `${res.request().method()} ${new URL(res.url()).pathname}`;
            replies.push(line);
            if (res.status() >= 400) failed.push(`${res.status()} ${line}`);
        });

        // networkidle never fires (the app holds an event stream open), so the home page's own content marks loaded.
        await page.goto("/", { waitUntil: "domcontentloaded" });
        await expect(page.locator(".section-stack")).toBeVisible({ timeout: 10000 });

        // Unique endpoints, ignoring cover-art images and polling repeats; the count is reported, not limited.
        const uniqueApis = new Set(replies.filter((r) => !r.includes("/cover-art")));
        test.info().annotations.push({ type: "home api endpoints", description: String(uniqueApis.size) });
        expect(failed, "home page API calls that answered 400 or worse").toEqual([]);
    });
});

// ============================================================
// 13. CONSOLE AND API ERROR AUDIT (all pages)
// ============================================================
test.describe("Full Audit", () => {
    test.beforeEach(async ({ page }) => { await login(page); });

    test("console error audit across all pages", async ({ page }) => {
        const allErrors: string[] = [];
        let route = "";
        page.on("console", (msg) => {
            const text = msg.text();
            // The browser logs each cover-art 404 (an album with no art) as a failed resource; that is not an error.
            const noArt = text.includes("404") && msg.location().url.includes("/cover-art");
            if (msg.type() === "error" && !isBrowserNoise(text) && !text.includes("net::ERR") && !noArt) {
                allErrors.push(`${route}: ${text.slice(0, 200)}`);
            }
        });
        page.on("pageerror", (err) => allErrors.push(`${route}: uncaught ${err.name}: ${err.message}`.slice(0, 250)));

        for (const r of ROUTES) {
            route = r.path;
            await page.goto(r.path, { waitUntil: "domcontentloaded" });
            await page.waitForTimeout(2500);
        }

        expect(allErrors, "console errors and uncaught exceptions").toEqual([]);
    });

    test("API error audit across all pages", async ({ page }) => {
        const failures: string[] = [];
        let route = "";
        page.on("response", (resp) => {
            const failure = apiFailure(resp);
            if (failure && resp.status() >= 500) failures.push(`${route}: ${failure}`);
        });

        for (const r of ROUTES) {
            route = r.path;
            await page.goto(r.path, { waitUntil: "domcontentloaded" });
            await page.waitForTimeout(2500);
        }

        expect(failures, "5xx API answers while loading each page").toEqual([]);
    });
});
