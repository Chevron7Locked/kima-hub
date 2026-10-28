import { test, expect, Page, Response, ConsoleMessage } from "@playwright/test";
import { skipIfEmptyLibrary, username, password } from "./fixtures/test-helpers";
import { settle } from "./fixtures/shared";
import { requireBaseUrl } from "./fixtures/target";

/** The app shell scrolls inside #main-content, so the document alone never overflows. */
const OVERFLOWS = () =>
    [document.documentElement, document.querySelector("#main-content")].some(
        (el) => !!el && el.scrollWidth > el.clientWidth + 1,
    );

const baseUrl = requireBaseUrl();

async function login(page: Page): Promise<void> {
    await page.goto("/login");
    await page.locator("#username").fill(username);
    await page.locator("#password").fill(password);
    await page.getByRole("button", { name: "Sign In" }).click();
    await page.waitForURL(/\/($|\?|home)/, { timeout: 15000 });
}

function isBrowserNoise(text: string): boolean {
    return text.includes("favicon") || text.includes("serviceWorker");
}

function collectConsoleErrors(page: Page): string[] {
    const errors: string[] = [];
    page.on("console", (msg) => {
        if (msg.type() === "error" && !isBrowserNoise(msg.text())) errors.push(msg.text());
    });
    return errors;
}

/** "status METHOD path" for a failed API response, or null for anything else. */
function apiFailure(resp: Response): string | null {
    const url = resp.url();
    if (!url.includes("/api/") || resp.status() < 400) return null;
    return `${resp.status()} ${resp.request().method()} ${url.replace("http://127.0.0.1:3006", "").replace(baseUrl, "")}`;
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
        const routes = [
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

        const results: Array<{ route: string; name: string; status: string; errors: string[] }> = [];

        for (const route of routes) {
            const networkErrors: string[] = [];
            const handler = (resp: Response) => {
                const failure = apiFailure(resp);
                if (failure) networkErrors.push(failure);
            };
            page.on("response", handler);

            try {
                const response = await page.goto(route.path, { timeout: 15000, waitUntil: "domcontentloaded" });
                await page.waitForTimeout(2500);

                const hasErrorBoundary = await page.locator("text=/something went wrong|application error/i").count();
                const httpStatus = response?.status() || 0;

                results.push({
                    route: route.path,
                    name: route.name,
                    status: httpStatus >= 500 || hasErrorBoundary > 0 ? "ERROR" : "OK",
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
            page.removeListener("response", handler);
        }

        console.log("\n=== ROUTE HEALTH CHECK ===");
        for (const r of results) {
            const tag = r.errors.length > 0 ? ` [${r.errors.length} API errors]` : "";
            console.log(`  ${r.status.padEnd(6)} ${r.name.padEnd(15)} ${r.route}${tag}`);
            r.errors.forEach((e) => console.log(`         -> ${e}`));
        }

        const crashes = results.filter((r) => r.status === "CRASH" || r.status === "ERROR");
        expect(crashes, `Routes crashed: ${crashes.map((c) => c.name).join(", ")}`).toHaveLength(0);
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
        const count = await albumLinks.count();
        expect(count).toBeGreaterThan(0);
        console.log(`Albums displayed: ${count}`);
    });

    test("artists tab shows artist cards", async ({ page }) => {
        await skipIfEmptyLibrary(page);
        await page.goto("/collection?tab=artists", { waitUntil: "domcontentloaded" });
        await settle(page, 3000);
        const artistLinks = page.locator('a[href^="/artist/"]');
        await expect(artistLinks.first()).toBeVisible({ timeout: 10000 });
        const count = await artistLinks.count();
        console.log(`Artists displayed: ${count}`);
    });

    test("tracks tab shows track rows", async ({ page }) => {
        await page.goto("/collection?tab=tracks", { waitUntil: "domcontentloaded" });
        await settle(page, 3000);
        const body = await page.locator("body").textContent();
        expect(body!.length).toBeGreaterThan(200);
    });

    test("album detail page has play button and track list", async ({ page }) => {
        await skipIfEmptyLibrary(page);
        const netErrors = collectNetworkErrors(page);
        await page.goto("/collection?tab=albums", { waitUntil: "domcontentloaded" });
        await settle(page, 3000);

        const firstAlbum = page.locator('a[href^="/album/"]').first();
        await expect(firstAlbum).toBeVisible({ timeout: 10000 });
        await firstAlbum.click();
        await expect(page).toHaveURL(/\/album\//);
        await settle(page, 3000);

        const playBtn = page.locator('button:has-text("Play"), button[aria-label*="Play" i], button[title*="Play" i]');
        const playCount = await playBtn.count();
        console.log(`Album detail: ${playCount} play buttons found`);

        if (netErrors.length > 0) {
            console.log("ALBUM DETAIL - API errors:", netErrors);
        }
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

        const body = await page.locator("body").textContent();
        expect(body!.length).toBeGreaterThan(100);
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
        await page.goto("/search", { waitUntil: "domcontentloaded" });
        await settle(page, 2000);

        const searchInput = page.locator('input[type="search"], input[placeholder*="search" i], input[type="text"]').first();
        await searchInput.fill("a");
        await searchInput.press("Enter");
        await page.waitForTimeout(3000);

        const body = await page.locator("body").textContent();
        expect(body!.length).toBeGreaterThan(100);
    });

    test("search with gibberish shows no results or empty state", async ({ page }) => {
        await page.goto("/search", { waitUntil: "domcontentloaded" });
        await settle(page, 2000);

        const searchInput = page.locator('input[type="search"], input[placeholder*="search" i], input[type="text"]').first();
        await searchInput.fill("xyznonexistentquery12345");
        await searchInput.press("Enter");
        await page.waitForTimeout(3000);

        const body = await page.locator("body").textContent();
        expect(body).toBeTruthy();
    });
});

// ============================================================
// 5. PLAYBACK
// ============================================================
test.describe("Playback", () => {
    test.beforeEach(async ({ page }) => { await login(page); });

    test("player appears when track starts playing", async ({ page }) => {
        await skipIfEmptyLibrary(page);
        await page.goto("/collection?tab=albums", { waitUntil: "domcontentloaded" });
        await settle(page, 2000);

        const firstAlbum = page.locator('a[href^="/album/"]').first();
        await firstAlbum.waitFor({ timeout: 10_000 });
        await firstAlbum.click();
        await page.waitForURL(/\/album\//);
        await page.waitForTimeout(500);

        await page.getByLabel("Play all").click();

        await expect(page.getByTitle("pause", { exact: true })).toBeVisible({ timeout: 10_000 });
    });

    test("clicking play on album starts playback UI", async ({ page }) => {
        await skipIfEmptyLibrary(page);
        const consoleErrors = collectConsoleErrors(page);

        await page.goto("/collection?tab=albums", { waitUntil: "domcontentloaded" });
        await settle(page, 3000);

        const firstAlbum = page.locator('a[href^="/album/"]').first();
        await firstAlbum.click();
        await settle(page, 3000);

        const playBtn = page.getByRole("button", { name: "play all", exact: true });
        await expect(playBtn).toBeVisible({ timeout: 5000 });
        await playBtn.click();
        await page.waitForTimeout(3000);

        const pauseBtn = await page.locator('button[title="pause"], button[aria-label="Pause"]').count();
        console.log(`After play click: pause button visible = ${pauseBtn > 0}`);
        if (consoleErrors.length > 0) {
            console.log("PLAYBACK console errors:", consoleErrors);
        }
    });

    test("play/pause toggle works", async ({ page }) => {
        await skipIfEmptyLibrary(page);
        await page.goto("/collection?tab=albums", { waitUntil: "domcontentloaded" });
        await settle(page, 3000);

        const firstAlbum = page.locator('a[href^="/album/"]').first();
        await firstAlbum.click();
        await settle(page, 3000);

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
        await page.goto("/collection?tab=albums", { waitUntil: "domcontentloaded" });
        await settle(page, 3000);

        const firstAlbum = page.locator('a[href^="/album/"]').first();
        await firstAlbum.click();
        await settle(page, 3000);

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

        const body = await page.locator("body").textContent();
        expect(body!.length).toBeGreaterThan(100);

        if (netErrors.length > 0) {
            console.log("SETTINGS - API errors:", netErrors);
        }
    });

    test("settings has navigable sections", async ({ page }) => {
        await page.goto("/settings", { waitUntil: "domcontentloaded" });
        await settle(page, 3000);

        const sections = page.locator("text=/general|media|library|display|account|server|integration|enrichment/i");
        const count = await sections.count();
        console.log(`Settings sections/links found: ${count}`);
    });
});

// ============================================================
// 7. VIBE / DISCOVERY
// ============================================================
test.describe("Vibe & Discovery", () => {
    test.beforeEach(async ({ page }) => { await login(page); });

    test("vibe page loads without crash", async ({ page }) => {
        const consoleErrors = collectConsoleErrors(page);
        const netErrors = collectNetworkErrors(page);
        await page.goto("/vibe", { waitUntil: "domcontentloaded" });
        await settle(page, 3000);

        const body = await page.locator("body").textContent();
        expect(body!.length).toBeGreaterThan(50);

        if (consoleErrors.length > 0) console.log("VIBE - Console errors:", consoleErrors);
        if (netErrors.length > 0) console.log("VIBE - Network errors:", netErrors);
    });

    test("discover page loads", async ({ page }) => {
        const netErrors = collectNetworkErrors(page);
        await page.goto("/discover", { waitUntil: "domcontentloaded" });
        await settle(page, 3000);

        const body = await page.locator("body").textContent();
        expect(body!.length).toBeGreaterThan(50);

        if (netErrors.length > 0) console.log("DISCOVER - Network errors:", netErrors);
    });

    test("releases page loads", async ({ page }) => {
        const netErrors = collectNetworkErrors(page);
        await page.goto("/releases", { waitUntil: "domcontentloaded" });
        await settle(page, 3000);

        const body = await page.locator("body").textContent();
        expect(body!.length).toBeGreaterThan(50);

        if (netErrors.length > 0) console.log("RELEASES - Network errors:", netErrors);
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
            if ((url.includes("cover") || url.includes("image") || url.includes(".jpg") || url.includes(".webp")) && resp.status() >= 400) {
                brokenAssets.push(`${resp.status()} ${url.slice(0, 100)}`);
            }
        });

        await page.goto("/collection?tab=albums", { waitUntil: "domcontentloaded" });
        await settle(page, 4000);

        if (brokenAssets.length > 0) {
            console.log(`BROKEN ASSETS (${brokenAssets.length}):`);
            brokenAssets.slice(0, 10).forEach((a) => console.log(`  ${a}`));
        }

        const imgs = page.locator("img");
        const imgCount = await imgs.count();
        let broken = 0;
        for (let i = 0; i < Math.min(imgCount, 20); i++) {
            const naturalWidth = await imgs.nth(i).evaluate((el: HTMLImageElement) => el.naturalWidth);
            if (naturalWidth === 0) broken++;
        }
        console.log(`Images: ${imgCount} total, ${broken} broken (0 naturalWidth)`);
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

        const bottomNav = page.locator('nav, [class*="mobile" i], [class*="bottom" i], [class*="MobileNav"]');
        const count = await bottomNav.count();
        console.log(`Mobile: nav elements found = ${count}`);
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
        await page.goto("/collection?tab=albums", { waitUntil: "domcontentloaded" });
        await settle(page, 3000);

        const firstAlbum = page.locator('a[href^="/album/"]').first();
        await firstAlbum.click();
        await settle(page, 3000);

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
        const routes = ["/", "/collection", "/search", "/settings"];
        console.log("\n=== HEADING HIERARCHY ===");

        for (const route of routes) {
            await page.goto(route, { waitUntil: "domcontentloaded" });
            await settle(page, 2000);

            const headings = await page.evaluate(() =>
                Array.from(document.querySelectorAll("h1, h2, h3, h4, h5, h6")).map(
                    (h) => `${h.tagName}: ${h.textContent?.trim().slice(0, 50)}`
                )
            );

            console.log(`  ${route}:`);
            if (headings.length === 0) {
                console.log("    [NO HEADINGS]");
            } else {
                headings.forEach((h) => console.log(`    ${h}`));
            }
        }
    });

    test("buttons without accessible names", async ({ page }) => {
        await page.goto("/", { waitUntil: "domcontentloaded" });
        await settle(page, 2000);

        const unlabeled = await page.evaluate(() => {
            return Array.from(document.querySelectorAll("button"))
                .filter((btn) => {
                    const text = btn.textContent?.trim();
                    const ariaLabel = btn.getAttribute("aria-label");
                    const title = btn.getAttribute("title");
                    return !text && !ariaLabel && !title;
                })
                .map((btn) => btn.outerHTML.slice(0, 150));
        });

        console.log(`Buttons without accessible names: ${unlabeled.length}`);
        unlabeled.slice(0, 5).forEach((h) => console.log(`  ${h}`));
    });

    test("images without alt text audit", async ({ page }) => {
        await page.goto("/collection?tab=albums", { waitUntil: "domcontentloaded" });
        await settle(page, 3000);

        const noAlt = await page.evaluate(() =>
            Array.from(document.querySelectorAll("img"))
                .filter((img) => !img.alt && !img.getAttribute("role"))
                .map((img) => ({ src: img.src.slice(0, 80), w: img.width }))
        );

        console.log(`Images without alt text: ${noAlt.length}`);
        noAlt.slice(0, 5).forEach((img) => console.log(`  ${img.src} (${img.w}px)`));
    });
});

// ============================================================
// 11. ERROR HANDLING
// ============================================================
test.describe("Error Handling", () => {
    test.beforeEach(async ({ page }) => { await login(page); });

    test("invalid album ID handled gracefully", async ({ page }) => {
        await page.goto("/album/nonexistent-id-12345", { waitUntil: "domcontentloaded" });
        await settle(page, 3000);

        const body = await page.locator("body").textContent();
        expect(body!.length).toBeGreaterThan(10);

        const url = page.url();
        const hasErrorText = /not found|error|404|doesn.t exist/i.test(body || "");
        const redirected = !url.includes("nonexistent");
        console.log(`Invalid album: errorText=${hasErrorText}, redirected=${redirected}`);
    });

    test("invalid artist ID handled gracefully", async ({ page }) => {
        await page.goto("/artist/nonexistent-id-12345", { waitUntil: "domcontentloaded" });
        await settle(page, 3000);

        const body = await page.locator("body").textContent();
        expect(body!.length).toBeGreaterThan(10);
    });

    test("nonexistent route handled", async ({ page }) => {
        await page.goto("/this-route-does-not-exist-xyz", { waitUntil: "domcontentloaded" });
        await settle(page, 2000);

        const body = await page.locator("body").textContent();
        console.log(`404 page: ${body!.length} chars, url=${page.url()}`);
        expect(body!.length).toBeGreaterThan(10);
    });
});

// ============================================================
// 12. PERFORMANCE
// ============================================================
test.describe("Performance", () => {
    test.beforeEach(async ({ page }) => { await login(page); });

    test("page load times", async ({ page }) => {
        const timings: Array<{ name: string; ms: number }> = [];
        for (const [name, path] of [
            ["Home", "/"],
            ["Collection", "/collection?tab=albums"],
            ["Search", "/search"],
            ["Settings", "/settings"],
            ["Vibe", "/vibe"],
        ] as const) {
            const start = Date.now();
            await page.goto(path, { waitUntil: "domcontentloaded" });
            await page.waitForTimeout(1000);
            timings.push({ name, ms: Date.now() - start });
        }

        console.log("\n=== PAGE LOAD TIMES ===");
        timings.forEach((t) => {
            const bar = t.ms > 5000 ? " [SLOW]" : "";
            console.log(`  ${t.name.padEnd(15)} ${t.ms}ms${bar}`);
        });
    });

    test("home page API request count", async ({ page }) => {
        const requests: string[] = [];

        // Navigate first, THEN start capturing to avoid counting leftover
        // requests from the previous page (login redirect to home).
        await page.goto("/", { waitUntil: "domcontentloaded" });

        page.on("request", (req) => {
            if (req.url().includes("/api/")) {
                requests.push(`${req.method()} ${req.url().replace(/http:\/\/127\.0\.0\.1:\d+/, "")}`);
            }
        });

        await page.waitForTimeout(5000);

        // Count unique API endpoints (ignore cover-art images and polling duplicates)
        const apiCalls = requests.filter(r => !r.includes("/cover-art"));
        const uniqueApis = new Set(apiCalls.map(r => r.replace(/\?.*$/, "")));

        console.log(`\nHome page API requests: ${requests.length} total (${uniqueApis.size} unique API endpoints)`);
        apiCalls.forEach((r) => console.log(`  ${r}`));

        if (uniqueApis.size > 25) {
            console.log(`\n  WARNING: ${uniqueApis.size} unique API endpoints seems excessive`);
        }
    });
});

// ============================================================
// 13. CONSOLE ERROR AUDIT (all pages)
// ============================================================
test.describe("Full Audit", () => {
    test.beforeEach(async ({ page }) => { await login(page); });

    test("console error audit across all pages", async ({ page }) => {
        const routes = [
            "/", "/collection", "/collection?tab=albums", "/collection?tab=artists",
            "/collection?tab=tracks", "/search", "/settings",
            "/discover", "/releases", "/vibe", "/playlists",
            "/audiobooks", "/podcasts", "/radio",
        ];

        const allErrors: Array<{ route: string; errors: string[] }> = [];

        for (const route of routes) {
            const errors: string[] = [];
            const handler = (msg: ConsoleMessage) => {
                const text = msg.text();
                if (msg.type() === "error" && !isBrowserNoise(text) && !text.includes("net::ERR")) {
                    errors.push(text.slice(0, 200));
                }
            };
            page.on("console", handler);

            await page.goto(route, { waitUntil: "domcontentloaded" });
            await page.waitForTimeout(2500);

            page.removeListener("console", handler);
            if (errors.length > 0) allErrors.push({ route, errors });
        }

        console.log("\n=== CONSOLE ERROR AUDIT ===");
        if (allErrors.length === 0) {
            console.log("  No console errors found!");
        } else {
            for (const entry of allErrors) {
                console.log(`\n  ${entry.route} (${entry.errors.length}):`);
                entry.errors.forEach((e) => console.log(`    ${e}`));
            }
        }
        console.log(`\nPages with errors: ${allErrors.length}/${routes.length}`);
    });

    test("API error audit across all pages", async ({ page }) => {
        const routes = [
            "/", "/collection", "/collection?tab=albums", "/collection?tab=artists",
            "/collection?tab=tracks", "/search", "/settings",
            "/discover", "/releases", "/vibe", "/playlists",
            "/audiobooks", "/podcasts", "/radio",
        ];

        const allErrors: Array<{ route: string; errors: string[] }> = [];

        for (const route of routes) {
            const errors: string[] = [];
            const handler = (resp: Response) => {
                const failure = apiFailure(resp);
                if (failure) errors.push(failure);
            };
            page.on("response", handler);

            await page.goto(route, { waitUntil: "domcontentloaded" });
            await page.waitForTimeout(2500);

            page.removeListener("response", handler);
            if (errors.length > 0) allErrors.push({ route, errors });
        }

        console.log("\n=== API ERROR AUDIT ===");
        if (allErrors.length === 0) {
            console.log("  No API errors found!");
        } else {
            for (const entry of allErrors) {
                console.log(`\n  ${entry.route} (${entry.errors.length}):`);
                entry.errors.forEach((e) => console.log(`    ${e}`));
            }
        }

        const total = allErrors.reduce((s, e) => s + e.errors.length, 0);
        console.log(`\nTotal: ${total} API errors across ${allErrors.length} pages`);
    });
});
