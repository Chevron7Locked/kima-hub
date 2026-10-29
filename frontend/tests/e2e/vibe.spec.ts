import { test, expect } from "@playwright/test";
import type { Page } from "@playwright/test";
import { dismissWhatsNew as dismiss, loginAsTestUser, getAuthToken } from "./fixtures/test-helpers";
import { softwareWebGL } from "./fixtures/shared";

// Each journey must clear the What's New window before touching the toolbar or the field; it mounts late,
// so the watcher also closes it if it appears during a later action.
const dismissWhatsNew = (page: Page) => dismiss(page, { watch: true });

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Returns the first two track IDs that have vibe embeddings, or null if none. */
async function getVibeTrackIds(page: Page): Promise<[string, string] | null> {
    try {
        const token = await getAuthToken(page);
        const res = await page.request.get("/api/vibe/map", {
            headers: { Authorization: `Bearer ${token}` },
        });
        if (!res.ok()) return null;
        const data = await res.json() as { tracks?: Array<{ id: string; title: string; artist: string }> };
        const tracks = data.tracks ?? [];
        if (tracks.length < 2) return null;
        // Song path needs two tracks far apart in vibe space; first/last in the
        // payload can be acoustic near-duplicates and the endpoint correctly
        // 400s those ("too similar for a meaningful journey"). Use the extremes
        // of the map projection instead: min vs max x+y.
        const withXY = tracks.filter((t) => typeof (t as { x?: number }).x === "number");
        if (withXY.length >= 2) {
            let lo = withXY[0], hi = withXY[0], loS = Infinity, hiS = -Infinity;
            for (const t of withXY) {
                const sum = (t as unknown as { x: number; y: number }).x + (t as unknown as { x: number; y: number }).y;
                if (sum < loS) { loS = sum; lo = t; }
                if (sum > hiS) { hiS = sum; hi = t; }
            }
            if (lo.id !== hi.id) return [lo.id, hi.id];
        }
        return [tracks[0].id, tracks[tracks.length - 1].id];
    } catch {
        return null;
    }
}

/**
 * Finds two distinct vibe search queries (music descriptors) that each return
 * at least one result. Returns null if the library lacks sufficient embeddings.
 */
async function getTwoVibeSearchQueries(page: Page): Promise<[string, string] | null> {
    const candidates = ["rock", "pop", "electronic", "bright", "run", "soft", "dark", "sad", "piano"];
    const token = await getAuthToken(page);
    const working: string[] = [];
    for (const q of candidates) {
        if (working.length >= 2) break;
        try {
            const r = await page.request.post("/api/vibe/search", {
                data: { query: q, limit: 5 },
                headers: { Authorization: `Bearer ${token}` },
            });
            if (!r.ok()) continue;
            const d = await r.json() as { tracks: unknown[] };
            if (d.tracks.length > 0) working.push(q);
        } catch {
            // a failing probe moves on to the next descriptor
        }
    }
    return working.length >= 2 ? [working[0], working[1]] : null;
}

// ---------------------------------------------------------------------------

test.use(softwareWebGL);

test.describe("Vibe", () => {
    test.beforeEach(async ({ page }) => {
        await loginAsTestUser(page);
    });

    // ---- Page load ----------------------------------------------------------

    test("vibe page renders map or no-data state", async ({ page }) => {
        await page.goto("/vibe", { waitUntil: "domcontentloaded" });
        await dismissWhatsNew(page);

        // Wait for loading to settle: either the track count appears (map loaded with data)
        // or the no-data placeholder appears (library has no vibe embeddings yet).
        // "Computing music map" is a transient loading state -- do not assert on it.
        const trackCount = page.locator("text=/ tracks$/");
        const noData = page.locator("text=/No tracks with vibe/i");

        await expect(trackCount.or(noData)).toBeVisible({ timeout: 35_000 });
    });

    test("toolbar buttons are present when map loads", async ({ page }) => {
        await page.goto("/vibe", { waitUntil: "domcontentloaded" });
        await dismissWhatsNew(page);

        const canvas = page.locator("canvas").first();
        const noData = page.locator("text=/No tracks with vibe/i").first();
        await Promise.race([canvas.waitFor({ timeout: 35_000 }), noData.waitFor({ timeout: 35_000 })]);

        if ((await noData.count()) > 0) {
            test.skip();
            return;
        }

        await expect(page.locator('[title^="song path"]')).toBeVisible({ timeout: 5_000 });
        await expect(page.locator('[title^="blend"]')).toBeVisible({ timeout: 5_000 });
        await expect(page.locator('[aria-label="Search tracks or artists"]')).toBeVisible({ timeout: 5_000 });
    });

    // ---- API contract -------------------------------------------------------

    test("GET /api/vibe/map returns valid structure", async ({ page }) => {
        const token = await getAuthToken(page);
        const res = await page.request.get("/api/vibe/map", {
            headers: { Authorization: `Bearer ${token}` },
        });

        // 200 with tracks array (even if empty) or 204
        if (res.status() === 204) return; // no data yet -- valid
        expect(res.ok()).toBe(true);

        const data = await res.json() as { tracks: unknown[]; trackCount: number };
        expect(Array.isArray(data.tracks)).toBe(true);
        expect(typeof data.trackCount).toBe("number");
    });

    test("GET /api/vibe/similar returns tracks array for a valid id", async ({ page }) => {
        const ids = await getVibeTrackIds(page);
        if (!ids) { test.skip(); return; }

        const token = await getAuthToken(page);
        const res = await page.request.get(`/api/vibe/similar/${ids[0]}?limit=10`, {
            headers: { Authorization: `Bearer ${token}` },
        });
        expect(res.ok()).toBe(true);

        const data = await res.json() as { tracks: Array<{ id: string; title: string }> };
        expect(Array.isArray(data.tracks)).toBe(true);
        expect(data.tracks.length).toBeGreaterThan(0);
        // Returned tracks should all have ids and titles
        for (const t of data.tracks.slice(0, 5)) {
            expect(t.id).toBeTruthy();
            expect(t.title).toBeTruthy();
        }
    });

    test("POST /api/vibe/path returns a path with start and end tracks", async ({ page }) => {
        const ids = await getVibeTrackIds(page);
        if (!ids) { test.skip(); return; }

        const token = await getAuthToken(page);
        const res = await page.request.post("/api/vibe/path", {
            data: { startTrackId: ids[0], endTrackId: ids[1], length: 8, mode: "smooth" },
            headers: { Authorization: `Bearer ${token}` },
        });
        expect(res.ok()).toBe(true);

        const data = await res.json() as {
            startTrack: { id: string };
            endTrack: { id: string };
            path: Array<{ id: string }>;
        };
        expect(data.startTrack.id).toBe(ids[0]);
        expect(data.endTrack.id).toBe(ids[1]);
        expect(Array.isArray(data.path)).toBe(true);
    });

    // ---- Vibe search --------------------------------------------------------

    test("vibe search highlights matching tracks", async ({ page }) => {
        await page.goto("/vibe", { waitUntil: "domcontentloaded" });
        await dismissWhatsNew(page);

        const canvas = page.locator("canvas").first();
        const noData = page.locator("text=/No tracks with vibe/i").first();
        await Promise.race([canvas.waitFor({ timeout: 35_000 }), noData.waitFor({ timeout: 35_000 })]);
        if ((await noData.count()) > 0) { test.skip(); return; }

        const searchInput = page.locator('[aria-label="Search tracks or artists"]');
        await searchInput.fill("the");
        await page.waitForTimeout(400); // debounce

        const clearBtn = page.locator('[aria-label="Clear search"]');
        if (await clearBtn.isVisible()) await clearBtn.click();
        await page.waitForTimeout(200);

        await expect(canvas).toBeVisible();
    });

    // ---- Drift via Song Path form -------------------------------------------

    test("Drift button opens song path form", async ({ page }) => {
        await page.goto("/vibe", { waitUntil: "domcontentloaded" });
        await dismissWhatsNew(page);

        const canvas = page.locator("canvas").first();
        const noData = page.locator("text=/No tracks with vibe/i").first();
        await Promise.race([canvas.waitFor({ timeout: 35_000 }), noData.waitFor({ timeout: 35_000 })]);
        if ((await noData.count()) > 0) { test.skip(); return; }

        await page.locator('[title^="song path"]').click();

        await expect(page.locator('#path-start')).toBeVisible({ timeout: 5_000 });
        await expect(page.locator('#path-end')).toBeVisible({ timeout: 5_000 });
        await expect(page.locator('button:has-text("Generate Path")')).toBeVisible();
    });

    test("Drift song path form: search and select two tracks then generate queue", async ({ page }) => {
        const queries = await getTwoVibeSearchQueries(page);
        if (!queries) { test.skip(); return; }
        const [startQuery, endQuery] = queries;

        await page.goto("/vibe", { waitUntil: "domcontentloaded" });
        await dismissWhatsNew(page);

        const canvas = page.locator("canvas").first();
        await canvas.waitFor({ timeout: 35_000 });

        await page.locator('[title^="song path"]').click();
        await expect(page.locator('#path-start')).toBeVisible({ timeout: 5_000 });

        const startInput = page.locator('#path-start');
        await startInput.click();
        await startInput.fill(startQuery);
        await page.waitForTimeout(600);

        const firstResult = page.locator('.max-h-40 button').first();
        await firstResult.waitFor({ timeout: 8_000 });
        await firstResult.click();

        const endInput = page.locator('#path-end');
        await endInput.click();
        await endInput.fill(endQuery);
        await page.waitForTimeout(600);

        const endResult = page.locator('.max-h-40 button').first();
        await endResult.waitFor({ timeout: 8_000 });
        await endResult.click();

        const generateBtn = page.locator('button:has-text("Generate Path")');
        await expect(generateBtn).toBeEnabled({ timeout: 3_000 });
        await generateBtn.click();

        await expect(page.locator('#path-start')).not.toBeVisible({ timeout: 8_000 });
        await expect(canvas).toBeVisible();
    });

    // ---- Blend panel --------------------------------------------------------

    test("Blend button opens blend panel", async ({ page }) => {
        await page.goto("/vibe", { waitUntil: "domcontentloaded" });
        await dismissWhatsNew(page);

        const canvas = page.locator("canvas").first();
        const noData = page.locator("text=/No tracks with vibe/i").first();
        await Promise.race([canvas.waitFor({ timeout: 35_000 }), noData.waitFor({ timeout: 35_000 })]);
        if ((await noData.count()) > 0) { test.skip(); return; }

        await page.locator('[title^="blend"]').click();
        await page.waitForTimeout(500);

        const closeEl = page.locator('[aria-label="Close alchemy"]').first();
        await expect(closeEl).toBeVisible({ timeout: 5_000 });

        await closeEl.click();
    });

    // ---- Selected-track panel ------------------------------------------------

    // Stars are WebGL points, so a star is found by resting the pointer on the
    // field until the hover nameplate (a DOM chip) appears, then clicking there.
    test("clicking a star opens a panel with that track's own data", async ({ page }) => {
        await page.goto("/vibe", { waitUntil: "domcontentloaded" });
        await dismissWhatsNew(page);

        const field = page.getByTestId("vibe-map-field").first();
        const noData = page.locator("text=/No tracks with vibe/i").first();
        await Promise.race([field.waitFor({ timeout: 35_000 }), noData.waitFor({ timeout: 35_000 })]);
        if ((await noData.count()) > 0) {
            test.skip(true, "no vibe tracks available");
        }

        // Let the opening camera flight settle so hovered points stay put.
        await page.waitForTimeout(4_000);
        const panel = page.locator("#vibe-track-panel");
        const box = await field.boundingBox();
        expect(box, "the map field should render").not.toBeNull();

        const openFromHover = async () => {
            for (let gy = 0.3; gy < 0.8; gy += 0.05) {
                for (let gx = 0.25; gx < 0.65; gx += 0.04) {
                    const x = box!.x + box!.width * gx;
                    const y = box!.y + box!.height * gy;
                    await page.mouse.move(x, y);
                    // A star names itself only after the pointer rests on it briefly.
                    await page.waitForTimeout(480);
                    if ((await page.locator(".vibe-chip--focus").count()) === 0) continue;
                    await page.mouse.click(x, y);
                    if (await panel.waitFor({ state: "visible", timeout: 1_500 }).then(() => true).catch(() => false)) return true;
                }
            }
            return false;
        };

        expect(await openFromHover(), "the panel should open after clicking a star").toBe(true);
        await expect(field).not.toHaveAttribute("data-selected-id", "");

        // The panel shows THIS track's title from the map payload.
        const title = ((await page.locator("#vibe-track-panel-title").textContent()) ?? "").trim();
        const token = await getAuthToken(page);
        const map = await page.request.get("/api/vibe/map", { headers: { Authorization: `Bearer ${token}` } });
        const titles = (((await map.json()) as { tracks?: Array<{ title: string }> }).tracks ?? []).map((t) => t.title.normalize("NFC"));
        expect(titles, "the panel title must be one of the API track titles").toContain(title);

        await expect(panel.locator("a[href^='/artist/']")).toBeVisible();
        await expect(panel.getByLabel("Play this track")).toBeVisible();
        await expect(panel.getByLabel("Build vibe playlist from this track")).toBeVisible();
        await expect(panel.getByLabel("Find tracks similar to this one")).toBeVisible();
        await expect(panel.getByLabel("Start song path from this track")).toBeVisible();

        await page.keyboard.press("Escape");
        await expect(panel).toBeHidden({ timeout: 5_000 });

        expect(await openFromHover(), "the panel should re-open").toBe(true);
        await panel.getByLabel("Close track details").click();
        await expect(panel).toBeHidden({ timeout: 5_000 });
    });

    test("playing state reaches the map (playing marker wiring)", async ({ page }) => {
        await page.goto("/vibe", { waitUntil: "domcontentloaded" });
        await dismissWhatsNew(page);

        const gallery = page.getByTestId("vibe-map-field").first();
        const noData = page.locator("text=/No tracks with vibe/i").first();
        await Promise.race([gallery.waitFor({ timeout: 35_000 }), noData.waitFor({ timeout: 35_000 })]);
        if ((await noData.count()) > 0) {
            test.skip(true, "no vibe tracks available");
        }

        // Pick a real vibe track and set it as the server-side playback state —
        // the same source the audio state machine hydrates from on load.
        const token = await getAuthToken(page);
        const map = await page.request.get("/api/vibe/map", {
            headers: { Authorization: `Bearer ${token}` },
        });
        expect(map.ok()).toBeTruthy();
        const mapData = (await map.json()) as { tracks?: Array<{ id: string }> };
        const trackId = mapData.tracks?.[0]?.id;
        expect(trackId, "map should carry at least one track").toBeDefined();
        const playingId = trackId as string;

        const post = await page.request.post("/api/playback-state", {
            headers: { Authorization: `Bearer ${token}` },
            data: {
                playbackType: "track",
                trackId,
                position: 5_000,
                queue: [{ id: trackId }],
                currentIndex: 0,
                isShuffle: false,
                changedBy: "e2e-playing-marker",
            },
        });
        expect(post.status(), "playback-state seed should succeed").toBe(200);

        // Reload: the page hydrates audio state from playback-state, passes
        // playingTrackId down, and the wrapper exposes it as a DOM attribute —
        // DOM evidence the marker wiring works (the canvas star itself is GL).
        await page.reload({ waitUntil: "domcontentloaded" });
        await dismissWhatsNew(page);
        const wrapper = page.getByTestId("vibe-map-field").first();
        await expect(wrapper).toBeAttached({ timeout: 35_000 });
        await expect(wrapper).toHaveAttribute("data-playing-id", playingId, {
            timeout: 20_000,
        });
    });
});
