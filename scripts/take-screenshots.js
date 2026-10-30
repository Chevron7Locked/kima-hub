#!/usr/bin/env node
/**
 * Takes the README screenshots and the header card against a running Kima instance.
 * From frontend/ (the script finds Playwright there):
 *
 *   KIMA_TEST_USERNAME=… KIMA_TEST_PASSWORD=… node ../scripts/take-screenshots.js [name ...]
 *
 * KIMA_UI_BASE_URL is required and must not be on port 3030 (production). With no names it takes everything;
 * with names (for example `vibe-map mobile-player social-card`) it takes only those.
 * The card is rendered last from scripts/social-card.html, using the screenshots already on disk.
 *
 * Override the album, artist and song it shows with KIMA_SHOT_ALBUM, KIMA_SHOT_ALBUM_ARTIST, KIMA_SHOT_ARTIST and
 * KIMA_SHOT_TRACK. KIMA_SHOT_DIR saves somewhere other than assets/screenshots, for a trial run.
 *
 * The update window (whats-new) is taken only when it opens by itself after signing in, so sign in with an account
 * that has not answered the newest release yet.
 */

const { execFileSync } = require("child_process");
const fs = require("fs");
const path = require("path");

/** The test server's address from KIMA_UI_BASE_URL; there is no default, and port 3030 (production) is refused. */
function requireBaseUrl() {
    const value = process.env.KIMA_UI_BASE_URL;
    if (!value) {
        console.error(
            "KIMA_UI_BASE_URL is not set. Set it to the address of the test server " +
                "(for example http://127.0.0.1:3056). The tests never choose a server on their own.",
        );
        process.exit(1);
    }
    let url;
    try {
        url = new URL(value);
    } catch {
        console.error(`KIMA_UI_BASE_URL is not a web address: "${value}"`);
        process.exit(1);
    }
    const port = url.port || (url.protocol === "https:" ? "443" : "80");
    if (port === "3030") {
        console.error(
            "KIMA_UI_BASE_URL points at port 3030, which is the production Kima server. " +
                "These tests never run against it. Point KIMA_UI_BASE_URL at a test server.",
        );
        process.exit(1);
    }
    return value;
}

const { chromium } = require(require.resolve("playwright", { paths: [process.cwd(), __dirname] }));

const BASE_URL = requireBaseUrl();
const USERNAME = process.env.KIMA_TEST_USERNAME;
const PASSWORD = process.env.KIMA_TEST_PASSWORD;
const OUT_DIR = path.resolve(process.env.KIMA_SHOT_DIR || path.resolve(__dirname, "../assets/screenshots"));
const CARD_HTML = path.resolve(__dirname, "social-card.html");
const CARD_OUT = path.resolve(__dirname, "../assets/social-card.png");
const MAX_BYTES = 700 * 1024;

const PICKS = {
    album: process.env.KIMA_SHOT_ALBUM || "Violator",
    albumArtist: process.env.KIMA_SHOT_ALBUM_ARTIST || "Depeche Mode",
    artist: process.env.KIMA_SHOT_ARTIST || "Muse",
    track: process.env.KIMA_SHOT_TRACK || "Digital Love",
    search: "quiet piano",
    pathStart: "calm ambient pads",
    pathEnd: "heavy metal",
    blendMore: "quiet piano",
    blendLess: "heavy metal",
};

const DESKTOP = { viewport: { width: 1440, height: 900 }, deviceScaleFactor: 2 };
const PHONE = { viewport: { width: 390, height: 844 }, deviceScaleFactor: 3, isMobile: true, hasTouch: true };

if (!USERNAME || !PASSWORD) {
    console.error("Set KIMA_TEST_USERNAME and KIMA_TEST_PASSWORD before running.");
    process.exit(1);
}

const wanted = process.argv.slice(2);
const want = (name) => wanted.length === 0 || wanted.includes(name);
const failures = [];

function compress(file) {
    if (fs.statSync(file).size <= MAX_BYTES) return;
    for (const quality of ["70-95", "50-85", "40-75"]) {
        try {
            execFileSync("pngquant", [`--quality=${quality}`, "--speed=1", "--strip", "--force", "--output", file, file], { stdio: "ignore" });
        } catch {
            console.warn(`  [warn] ${path.basename(file)} is over ${MAX_BYTES / 1024} KB and pngquant is missing or refused it`);
            return;
        }
        if (fs.statSync(file).size <= MAX_BYTES) return;
    }
}

async function netIdle(page, ms = 6000) {
    try {
        await page.waitForLoadState("networkidle", { timeout: ms });
    } catch { /* ok */ }
}

// Waits for the images in view to finish loading, then lets fade-ins finish.
async function settle(page, pause = 1500) {
    await netIdle(page);
    await page
        .waitForFunction(
            () =>
                Array.from(document.images)
                    .filter((i) => {
                        const r = i.getBoundingClientRect();
                        return r.bottom > 0 && r.top < innerHeight && r.right > 0 && r.left < innerWidth && r.width > 0;
                    })
                    .every((i) => i.complete && i.naturalWidth > 0),
            null,
            { timeout: 15_000 },
        )
        .catch(() => console.warn("  [warn] some images in view had not loaded"));
    await page.waitForTimeout(pause);
}

// Refuses a shot that shows the account name, a server path, or a loading or error state.
async function guard(page, name) {
    const text = (await page.locator("body").innerText()).toLowerCase();
    const bad = [];
    if (text.includes(USERNAME.toLowerCase())) bad.push("the account name");
    if (/(^|\s)\/(music|media|data|srv|app|downloads)\//.test(text)) bad.push("a server path");
    if (/something went wrong|failed to load|error loading|loading\.\.\.|loading artist/.test(text)) bad.push("a loading or error message");
    if (await page.locator("#main-content .animate-spin:visible").count()) bad.push("a spinner");
    if (bad.length) throw new Error(`${name} shows ${bad.join(" and ")}`);
}

// The bell's activity dot would show the owner's notifications.
const HIDE_INDICATORS = 'button[aria-label="Toggle activity panel"] > span.absolute { visibility: hidden; }';

async function shot(page, name) {
    await guard(page, name);
    await page.addStyleTag({ content: HIDE_INDICATORS });
    // Park the pointer on empty sidebar so no card shows its hover state.
    if (page.viewportSize().width > 800) await page.mouse.move(130, 770);
    await page.waitForTimeout(400);
    const file = path.join(OUT_DIR, `${name}.png`);
    await page.screenshot({ path: file, fullPage: false });
    compress(file);
    console.log(`  [ok] ${name}.png (${Math.round(fs.statSync(file).size / 1024)} KB)`);
}

// The page the shots in progress are taken on, for keeping a picture of a failed one.
let currentPage = null;

async function attempt(name, fn, { always = false } = {}) {
    if (!always && !want(name)) return;
    try {
        await fn();
    } catch (e) {
        failures.push(name);
        console.warn(`  [fail] ${name}: ${e.message.split("\n")[0]}`);
        // A trial run (KIMA_SHOT_DIR) keeps what the page showed when the shot failed.
        if (currentPage && process.env.KIMA_SHOT_DIR) {
            await currentPage.screenshot({ path: path.join(OUT_DIR, `${name}.failed.png`) }).catch(() => {});
        }
    }
}

async function login(page) {
    await page.goto(`${BASE_URL}/login`);
    await page.locator("#username").fill(USERNAME);
    await page.locator("#password").fill(PASSWORD);
    await page.getByRole("button", { name: "Sign In" }).click();
    await page.waitForURL(/\/($|\?|home)/, { timeout: 30_000 });
}

// The release window opens over a fresh login and swallows every click; close it whenever it appears.
async function dismissWhatsNew(page) {
    const modal = page.locator('div[role="dialog"][aria-labelledby="whats-new-title"]');
    const dismiss = modal.locator('[aria-label="Close"]');
    // Closed by hand first: a click made once the handler is in place would be taken over by the handler itself.
    if (await dismiss.isVisible({ timeout: 4000 }).catch(() => false)) {
        await dismiss.click();
        await dismiss.waitFor({ state: "detached", timeout: 5000 }).catch(() => {});
    }
    await page.addLocatorHandler(modal, async () => {
        if (await dismiss.isVisible().catch(() => false)) await dismiss.click();
    });
}

// Client-side navigation, so the song that is playing keeps playing.
async function nav(page, url) {
    await page.evaluate((u) => window.next.router.push(u), url);
    await page.waitForFunction((u) => location.pathname + location.search === u, url, { timeout: 20_000 });
}

async function scrollMain(page, y) {
    await page.evaluate((top) => {
        window.scrollTo(0, top);
        document.getElementById("main-content")?.scrollTo(0, top);
    }, y);
    await page.waitForTimeout(800);
}

async function apiGet(page, url) {
    const token = await page.evaluate(() => localStorage.getItem("auth_token") ?? "");
    const res = await page.request.get(`${BASE_URL}${url}`, { headers: { Authorization: `Bearer ${token}` } });
    return res.ok() ? res.json() : null;
}

const same = (a, b) => (a ?? "").toLowerCase() === (b ?? "").toLowerCase();

async function findAlbumPath(page) {
    const found = await apiGet(page, `/api/search?q=${encodeURIComponent(PICKS.album)}&type=all&limit=10`);
    const hit = (found?.albums ?? []).find((a) => same(a.title, PICKS.album) && same(a.artist?.name, PICKS.albumArtist));
    return hit ? `/album/${hit.id}` : null;
}

async function findArtistPath(page) {
    const found = await apiGet(page, `/api/search?q=${encodeURIComponent(PICKS.artist)}&type=all&limit=10`);
    const hit = (found?.artists ?? []).find((a) => same(a.name, PICKS.artist));
    return hit ? `/artist/${hit.id}` : null;
}

async function startPlaying(page, albumPath) {
    await nav(page, albumPath);
    await page.getByLabel("Play all").first().waitFor({ timeout: 15_000 });
    await page.getByLabel("Play all").first().click();
    await page.waitForFunction(
        () => {
            const a = document.querySelector("audio");
            return !!a && !a.paused && a.currentTime > 4;
        },
        null,
        { timeout: 30_000 },
    );
}

async function dismissHint(page) {
    const hints = page.locator('button[aria-label="Dismiss"]:visible');
    for (let i = 0; i < (await hints.count()); i++) {
        const button = hints.nth(i);
        if (await button.evaluate((el) => !el.closest('[role="dialog"]'))) await button.click().catch(() => {});
    }
    await page.waitForTimeout(600);
}

async function openMap(page) {
    await nav(page, "/");
    await page.waitForTimeout(500);
    await nav(page, "/vibe");
    await page.getByTestId("vibe-map-field").first().waitFor({ timeout: 60_000 });
    await page.waitForTimeout(8000);
    await dismissHint(page);
    await page.getByLabel("Show the whole library").click();
    await page.waitForTimeout(3500);
}

// Looks a track up in the map's own search box and picks it, which selects it and flies the camera there.
async function pickOnMap(page, query) {
    const box = page.getByLabel("Search tracks or artists");
    await box.click();
    await box.fill(query);
    const first = page.locator("#vibe-search-results button").first();
    await first.waitFor({ timeout: 10_000 });
    await first.click();
    await page.getByLabel("Play this track").first().waitFor({ timeout: 10_000 });
    await page.waitForTimeout(2500);
}

// Song Path and Blend pickers: type, wait for a hit, take the first.
async function pickFromList(page, input, list, query) {
    await input.click();
    await input.fill(query);
    const first = list.first();
    await first.waitFor({ timeout: 15_000 });
    await page.waitForTimeout(1200);
    await first.click();
    await page.waitForTimeout(700);
}

async function openPathPanel(page) {
    await page.getByLabel("Song Path: build a queue that glides from one track to another").click();
    await page.waitForTimeout(1200);
}

// Opens the right-hand panel on its up next list. The activity counts are not part of any picture, so they are hidden.
async function showQueue(page) {
    const open = page.getByRole("button", { name: "open panel" });
    if (await open.isVisible().catch(() => false)) {
        await open.click();
        await page.waitForTimeout(1200);
    }
    const tab = page.getByRole("tab", { name: /^up next/ });
    await tab.waitFor({ timeout: 10_000 });
    await tab.click();
    await settle(page, 1500);
    // Wait for the rows' artwork; a long queue loads covers one by one.
    await page
        .waitForFunction(() => !document.querySelector('[id^="activity-panel"] .animate-spin'), null, { timeout: 10_000 })
        .catch(() => {});
}

async function takeVibeShots(page) {
    // The map draws the play queue as a thread between its songs. An album queue
    // zigzags across the whole map, so play one song alone and the thread goes away.
    await attempt("vibe-queue-reset", async () => {
        await openMap(page);
        await pickOnMap(page, PICKS.track);
        await page.locator("#vibe-track-panel").getByLabel("Play this track").click();
        await page.waitForFunction(() => {
            const a = document.querySelector("audio");
            return !!a && a.currentTime > 2;
        }, null, { timeout: 20_000 });
    }, { always: true });

    await attempt("vibe-map", async () => {
        await openMap(page);
        await shot(page, "vibe-map");
    });

    await attempt("vibe-search", async () => {
        await openMap(page);
        await openPathPanel(page);
        const start = page.locator("#path-start");
        await start.click();
        await start.fill(PICKS.search);
        await page.locator(".max-h-40 button").first().waitFor({ timeout: 15_000 });
        await page.waitForTimeout(2500);
        await shot(page, "vibe-search");
    });

    await attempt("vibe-blend", async () => {
        await openMap(page);
        await page.getByLabel("Blend: mix tracks you like (and ones you don't) into a new playlist").click();
        await page.waitForTimeout(1200);
        const input = page.locator("#alchemy-search");
        const list = page.locator(".max-h-40 button");
        for (let i = 0; i < 3; i++) {
            await input.click();
            await input.fill(PICKS.blendMore);
            await list.nth(i).waitFor({ timeout: 15_000 });
            await page.waitForTimeout(1200);
            await list.nth(i).click();
            await page.waitForTimeout(700);
        }
        await page.getByRole("button", { name: /less like/i }).click();
        await pickFromList(page, input, list, PICKS.blendLess);
        await page.getByRole("button", { name: /^blend$/i }).click();
        await page.getByText(/play result/i).first().waitFor({ timeout: 30_000 });
        await page.waitForTimeout(2500);
        await shot(page, "vibe-blend");
    });

    await attempt("vibe-track", async () => {
        await openMap(page);
        await pickOnMap(page, PICKS.track);
        await page.locator("#vibe-track-panel").getByLabel("Find tracks similar to this one").click();
        await page.waitForTimeout(6000);
        await shot(page, "vibe-track");
    });

    await attempt("vibe-songpath", async () => {
        await openMap(page);
        await openPathPanel(page);
        await pickFromList(page, page.locator("#path-start"), page.locator(".max-h-40 button"), PICKS.pathStart);
        await pickFromList(page, page.locator("#path-end"), page.locator(".max-h-40 button"), PICKS.pathEnd);
        await page.getByRole("button", { name: /generate path/i }).click();
        await page.waitForTimeout(6000);
        await showQueue(page);
        await shot(page, "vibe-songpath");
    });

}

async function takeDesktopShots(browser) {
    console.log("\nDesktop (1440x900 at 2x)...");
    const ctx = await browser.newContext(DESKTOP);
    const p = await ctx.newPage();
    currentPage = p;
    await login(p);

    await attempt("whats-new", async () => {
        const modal = p.locator('div[role="dialog"][aria-labelledby="whats-new-title"]');
        await modal.waitFor({ timeout: 15_000 });
        await settle(p, 2500);
        await shot(p, "whats-new");
    });

    await dismissWhatsNew(p);
    await p.waitForTimeout(3000);

    const albumPath = await findAlbumPath(p);
    const artistPath = await findArtistPath(p);
    if (!albumPath) throw new Error("the picked album was not found in the library");
    await startPlaying(p, albumPath);

    await attempt("desktop-home", async () => {
        await nav(p, "/");
        await settle(p);
        await scrollMain(p, 0);
        await shot(p, "desktop-home");
    });

    await attempt("desktop-library", async () => {
        await nav(p, "/collection?tab=albums");
        await settle(p);
        await shot(p, "desktop-library");
    });

    await attempt("desktop-album", async () => {
        await nav(p, albumPath);
        await settle(p);
        await shot(p, "desktop-album");
    });

    await attempt("desktop-artist", async () => {
        if (!artistPath) throw new Error("the picked artist was not found in the library");
        await nav(p, artistPath);
        await p.locator("h2, h3", { hasText: /^popular$/i }).first().waitFor({ timeout: 45_000 });
        await settle(p);
        await shot(p, "desktop-artist");
    });

    await attempt("desktop-radio", async () => {
        await nav(p, "/radio");
        await settle(p, 2500);
        await shot(p, "desktop-radio");
    });

    await attempt("desktop-stats", async () => {
        await nav(p, "/stats");
        await settle(p, 3000);
        await shot(p, "desktop-stats");
    });

    await attempt("mood-mixer", async () => {
        await nav(p, "/");
        await settle(p);
        await p.getByRole("button", { name: /mood mixer/i }).click();
        await p.getByText(/pick your vibe/i).waitFor({ timeout: 10_000 });
        await p.waitForTimeout(1500);
        await shot(p, "mood-mixer");
        await p.keyboard.press("Escape");
    });

    await attempt("desktop-podcasts", async () => {
        await nav(p, "/podcasts");
        await settle(p);
        await scrollMain(p, 150);
        await settle(p, 500);
        await shot(p, "desktop-podcasts");
    });

    await attempt("desktop-audiobooks", async () => {
        await nav(p, "/audiobooks");
        await settle(p);
        await scrollMain(p, 720);
        await settle(p, 500);
        await shot(p, "desktop-audiobooks");
    });

    await takeVibeShots(p);
    await ctx.close();
}

async function takePhoneShots(browser) {
    console.log("\nPhone (390x844 at 3x)...");
    const ctx = await browser.newContext(PHONE);
    const p = await ctx.newPage();
    currentPage = p;
    await login(p);
    await dismissWhatsNew(p);
    await p.waitForTimeout(3000);

    const albumPath = await findAlbumPath(p);
    if (!albumPath) throw new Error("the picked album was not found in the library");
    await startPlaying(p, albumPath);

    await attempt("mobile-home", async () => {
        await nav(p, "/");
        await settle(p);
        await shot(p, "mobile-home");
    });

    await attempt("mobile-library", async () => {
        await nav(p, "/collection?tab=albums");
        await settle(p);
        await shot(p, "mobile-library");
    });

    await attempt("mobile-vibe", async () => {
        // The page as it opens: the whole map, and the sheet at rest with the playing song and the search.
        await openMap(p);
        await settle(p, 2000);
        await shot(p, "mobile-vibe");
    });

    await attempt("mobile-player", async () => {
        await nav(p, albumPath);
        await settle(p);
        await p.getByLabel("Expand player").first().click();
        await p.waitForTimeout(3500);
        await shot(p, "mobile-player");
    });

    await ctx.close();
}

async function renderCard(browser) {
    console.log("\nHeader card (1280x640)...");
    const ctx = await browser.newContext({ viewport: { width: 1280, height: 640 }, deviceScaleFactor: 1 });
    const p = await ctx.newPage();
    await p.goto(`file://${CARD_HTML}`);
    await p.evaluate(() => document.fonts.ready);
    await p.waitForFunction(() => Array.from(document.images).every((i) => i.complete && i.naturalWidth > 0), null, { timeout: 15_000 });
    await p.waitForTimeout(800);
    await p.screenshot({ path: CARD_OUT, fullPage: false });
    compress(CARD_OUT);
    console.log(`  [ok] social-card.png (${Math.round(fs.statSync(CARD_OUT).size / 1024)} KB)`);
    await ctx.close();
}

async function main() {
    console.log(`Taking screenshots against ${BASE_URL}`);
    console.log(`Saving to ${OUT_DIR}\n`);

    const browser = await chromium.launch({
        headless: true,
        args: [
            "--enable-webgl",
            "--ignore-gpu-blocklist",
            "--use-gl=angle",
            "--use-angle=swiftshader",
            "--enable-unsafe-swiftshader",
            "--allow-file-access-from-files",
            "--autoplay-policy=no-user-gesture-required",
            "--disable-dev-shm-usage",
        ],
    });

    try {
        const desktop = ["whats-new", "desktop-home", "desktop-library", "desktop-radio", "desktop-album", "desktop-artist", "desktop-stats", "mood-mixer", "desktop-podcasts", "desktop-audiobooks", "vibe-map", "vibe-track", "vibe-search", "vibe-blend", "vibe-songpath"];
        const phone = ["mobile-home", "mobile-library", "mobile-vibe", "mobile-player"];
        if (desktop.some(want)) await takeDesktopShots(browser);
        if (phone.some(want)) await takePhoneShots(browser);
        if (want("social-card")) await renderCard(browser);
    } finally {
        await browser.close();
    }

    if (failures.length) {
        console.error(`\nFailed: ${failures.join(", ")}`);
        process.exitCode = 1;
    } else {
        console.log("\nDone.");
    }
}

main().catch((e) => {
    console.error(e);
    process.exit(1);
});
