// Fresh README imagery for 1.11 — taken from the ARM dogfood stack (final UI:
// vibe map with labels off, crisp stars, mood bars, the new what's-new window).
// Usage: node scripts/shoot-readme-images.js   (needs the ARM stack tunneled + creds env)
const { chromium } = require("@playwright/test");
const fs = require("node:fs");

const BASE = process.env.KIMA_UI_BASE_URL || "http://localhost:3033";
const USER = process.env.KIMA_TEST_USERNAME || "kima_dogfood";
const PASS = process.env.KIMA_TEST_PASSWORD;
const OUT = process.env.KIMA_SHOT_DIR || "assets/screenshots";
const DESKTOP = { width: 1440, height: 900 };
const MOBILE = { width: 430, height: 932 };

async function login(page) {
    await page.goto(`${BASE}/login`, { waitUntil: "domcontentloaded" });
    await page.fill('input[type="text"], input[name="username"]', USER);
    await page.fill('input[type="password"]', PASS);
    await Promise.all([
        page.waitForURL((u) => !u.pathname.includes("login"), { timeout: 15000 }),
        page.click('button[type="submit"]'),
    ]);
    await page.waitForLoadState("domcontentloaded");
}

async function dismissWhatsNew(page) {
    await page.waitForTimeout(1200);
    const btn = page.locator('[data-testid="whatsnew-done"], button[aria-label="Close"]');
    if ((await btn.count()) > 0) {
        await btn.first().click().catch(() => {});
        await page.waitForTimeout(400);
    }
}

async function shoot(page, path, file, settle = 2500) {
    await page.goto(`${BASE}${path}`, { waitUntil: "domcontentloaded", timeout: 45000 });
    await dismissWhatsNew(page);
    await page.waitForTimeout(settle);
    fs.writeFileSync(`${OUT}/${file}.png`, await page.screenshot({ fullPage: false }));
    console.log("shot", file);
}

(async () => {
    const browser = await chromium.launch({ headless: true, args: ["--use-gl=angle", "--use-angle=swiftshader", "--enable-unsafe-swiftshader"] });
    const ctx = await browser.newContext({ viewport: DESKTOP, deviceScaleFactor: 2 });
    const page = await ctx.newPage();
    await login(page);

    // What's-new window opens itself on load (an unread release) — the hero shot first
    await page.goto(`${BASE}/library`, { waitUntil: "domcontentloaded" });
    try {
        await page.waitForSelector('[data-testid="whatsnew-done"]', { timeout: 12000 });
        await page.waitForTimeout(700);
        fs.writeFileSync(`${OUT}/whats-new.png`, await page.screenshot());
        console.log("shot whats-new");
        await page.locator('[data-testid="whatsnew-done"]').first().click({ timeout: 5000 });
        await page.waitForTimeout(600);
    } catch {
        console.log("WARN whats-new window did not open");
    }
    await dismissWhatsNew(page);

    await shoot(page, "/library", "desktop-home");
    await shoot(page, "/search", "vibe-search");
    await shoot(page, "/vibe", "vibe-map", 6000);
    await shoot(page, "/stats", "desktop-stats");
    await shoot(page, "/podcasts", "desktop-podcasts");
    await shoot(page, "/audiobooks", "desktop-audiobooks");
    await shoot(page, "/mix", "mood-mixer", 3500);

    // album + artist pages (were missing from the repo entirely)
    const albumCard = page.locator('[data-testid="album-card"], a[href*="/album/"]').first();
    if ((await albumCard.count()) > 0) {
        await albumCard.click();
        await page.waitForURL(/\/album\//, { timeout: 15000 });
        await page.waitForTimeout(2500);
        fs.writeFileSync(`${OUT}/desktop-album.png`, await page.screenshot());
        console.log("shot desktop-album");
        const artist = page.locator('a[href*="/artist/"]').first();
        if ((await artist.count()) > 0) {
            await artist.click();
            await page.waitForURL(/\/artist\//, { timeout: 15000 });
            await page.waitForTimeout(2500);
            fs.writeFileSync(`${OUT}/desktop-artist.png`, await page.screenshot());
            console.log("shot desktop-artist");
        }
    } else {
        console.log("WARN no album card found");
    }
    await ctx.close();

    // mobile vibe (map on the small screen, labels off)
    const mctx = await browser.newContext({ viewport: MOBILE, deviceScaleFactor: 2, isMobile: true, hasTouch: true });
    const m = await mctx.newPage();
    await login(m);
    await shoot(m, "/vibe", "mobile-vibe", 6000);
    try {
        await m.waitForSelector('[data-testid="whatsnew-done"]', { timeout: 12000 });
        await m.waitForTimeout(700);
        fs.writeFileSync(`${OUT}/mobile-whats-new.png`, await m.screenshot());
        console.log("shot mobile-whats-new");
    } catch {
        console.log("WARN mobile whats-new did not open");
    }
    await mctx.close();

    await browser.close();
    console.log("DONE", fs.readdirSync(OUT).length, "files");
})().catch((e) => { console.error("FAIL", e.message); process.exit(1); });
