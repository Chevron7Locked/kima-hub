/**
 * The notification tray, ListenBrainz, the public library export and live feed, the
 * GPU runtime and the release window as one watched session. Needs
 * KIMA_PUBLIC_VIBE_TOKEN, both GPU switches on, and the analyzers restarted since
 * the GPU runtime was last installed.
 */

import { test, expect, Browser, Page, BrowserContext, APIRequestContext, request } from "@playwright/test";
import { DogfoodSession, navigateByClick, openAlbumsTab, firstAlbumCard } from "./session";
import { readPlayer, settle } from "../fixtures/shared";

const baseUrl = process.env.KIMA_UI_BASE_URL || "http://127.0.0.1:3030";
const username = process.env.KIMA_TEST_USERNAME || "";
const password = process.env.KIMA_TEST_PASSWORD || "";
const vibeToken = process.env.KIMA_PUBLIC_VIBE_TOKEN || "";

const GPU_INSTALL_MS = 25 * 60_000;

/**
 * The newest release as the release window shows it. Its heading, items and changelog text are content, checked
 * word for word, so this block is updated with each release; the older releases stay, since the changelog keeps them.
 */
const NEWEST = {
    version: "1.12.0",
    heading: "Kima 1.12",
    items: ["podcasts.browse", "analysis.middle"],
    changelogText: /podcast browser/i,
};

test.describe.configure({ mode: "serial" });

test.describe("Dogfood: tray, scrobbling, public feed, GPU, release window", () => {
    let browser: Browser;
    let context: BrowserContext;
    let page: Page;
    let session: DogfoodSession;
    let token = "";
    let publicApi: APIRequestContext;

    const auth = () => ({ Authorization: `Bearer ${token}` });
    const getJson = async <T>(path: string): Promise<T> => {
        const res = await page.request.get(`/api${path}`, { headers: auth() });
        expect(res.status(), `GET /api${path}`).toBe(200);
        return (await res.json()) as T;
    };
    const live = async () => {
        const res = await publicApi.get("/api/public/vibe/live", {
            headers: { Authorization: `Bearer ${vibeToken}` },
        });
        expect(res.status(), "GET /api/public/vibe/live").toBe(200);
        return (await res.json()) as { status: string; trackId: string | null; position: number };
    };
    const playingTrackId = async () =>
        (await readPlayer(page)).src.match(/\/tracks\/([^/]+)\//)?.[1] ?? null;
    // A settings switch hides its checkbox under the drawn switch, so clicks go to the label.
    const settingsSwitch = (id: string) => page.locator(`label:has(> #${id})`);

    const saveSettings = async () => {
        const saved = page.waitForResponse(
            (r) => r.url().endsWith("/api/settings") && r.request().method() === "POST",
        );
        await page.getByRole("button", { name: "Save changes" }).click();
        expect((await saved).status()).toBe(200);
    };

    test.beforeAll(async ({ browser: launched }) => {
        browser = launched;
        expect(username && password, "KIMA_TEST_USERNAME and KIMA_TEST_PASSWORD must be set").toBeTruthy();
        expect(vibeToken, "KIMA_PUBLIC_VIBE_TOKEN must be set").toBeTruthy();
        publicApi = await request.newContext({ baseURL: baseUrl });
        context = await browser.newContext({ viewport: { width: 1440, height: 900 } });
        page = await context.newPage();
        session = new DogfoodSession(page, baseUrl);
        session.attach();
    });

    test.afterAll(async () => {
        if (session) {
            const reportPath = session.writeReport("test-results");
            console.log(`\n[features-dogfood] report written to ${reportPath}`);
            console.log(
                `[features-dogfood] ${session.steps.length} steps, ${session.violations.length} violations`,
            );
        }
        await publicApi?.dispose();
        await context?.close();
    });

    test("1. arrive: sign in", async () => {
        session.setJourney("1. Arrive");
        session.expectFailure({
            urlPattern: /\/api\/auth\/me/,
            status: 401,
            reason: "the session check before anyone has signed in",
        });

        await session.step("sign in", async () => {
            await page.goto("/login");
            await page.locator("#username").fill(username);
            await page.locator("#password").fill(password);
            await page.getByRole("button", { name: /sign in/i }).click();
            await page.waitForURL((u) => !u.pathname.startsWith("/login"), { timeout: 30_000 });
            token = await page.evaluate(() => localStorage.getItem("auth_token") ?? "");
            expect(token, "a token should be stored after login").toBeTruthy();
        });

        await session.step("close any release window", async () => {
            const dialog = page.locator('div[role="dialog"][aria-labelledby="whats-new-title"]');
            for (let i = 0; i < 4 && (await dialog.isVisible({ timeout: 3_000 }).catch(() => false)); i++) {
                await page.getByTestId("whatsnew-done").click();
                await settle(page, 800);
            }
            await expect(dialog).toBeHidden();
        });

        session.clearExpectedFailures();
        session.assertClean("Journey 1 (arrive)");
    });

    test("2. tray: a manual scan leaves one row, and a repeat replaces it", async () => {
        test.setTimeout(10 * 60_000);
        session.setJourney("2. Notification tray");

        type Row = { id: string; title: string; message: string | null; createdAt: string };
        const scanRows = async () =>
            (await getJson<Row[]>("/notifications")).filter((n) => n.title === "Library scan finished");

        const scanAndWait = async (after: number) => {
            await page.getByRole("button", { name: "Sync library" }).click();
            await expect
                .poll(async () => (await scanRows()).some((r) => Date.parse(r.createdAt) > after), {
                    timeout: 8 * 60_000,
                    intervals: [3_000],
                })
                .toBe(true);
        };

        await session.step("the first scan finishes into the tray", async () => {
            await scanAndWait(Date.now() - 1_000);
            const rows = await scanRows();
            expect(rows, "one tray row per scan outcome").toHaveLength(1);
            return { message: rows[0].message ?? "" };
        });

        await session.step("a second scan replaces that row instead of adding one", async () => {
            const before = await scanRows();
            await scanAndWait(Date.parse(before[0].createdAt));
            const rows = await scanRows();
            expect(rows, "a repeat scan must replace its row").toHaveLength(1);
            return { message: rows[0].message ?? "" };
        });

        await session.step("the tray shows the same single row", async () => {
            const toggle = page.getByRole("button", { name: "Toggle activity panel" });
            const wasOpen = (await toggle.getAttribute("aria-expanded")) === "true";
            if (!wasOpen) await toggle.click();
            const panel = page.locator("#activity-panel");
            const tab = panel.getByRole("button", { name: /^Notifications/ });
            if ((await tab.getAttribute("aria-pressed", { timeout: 10_000 })) !== "true") await tab.click();
            const rows = panel.getByText("Library scan finished", { exact: true });
            await expect(rows.first()).toBeVisible({ timeout: 10_000 });
            expect(await rows.count()).toBe(1);
            if (!wasOpen) await toggle.click();
            return { trayRows: 1 };
        });

        session.assertClean("Journey 2 (tray)");
    });

    test("3. scrobbling: a ListenBrainz token is saved and removed", async () => {
        session.setJourney("3. ListenBrainz");
        const hasToken = async () =>
            (await getJson<{ hasListenbrainzToken: boolean }>("/settings")).hasListenbrainzToken;

        await session.step("open the scrobbling settings with no token", async () => {
            await navigateByClick(page, "/settings");
            await settle(page, 1500);
            if (await hasToken()) {
                await page.locator("#lb-token-clear").check();
                await page.getByRole("button", { name: "Remove token" }).click();
                await expect.poll(hasToken).toBe(false);
            }
            await page.locator("#lb-token").scrollIntoViewIfNeeded();
            await expect(page.locator("#lb-token")).toHaveAttribute("placeholder", "Paste your LB user token");
        });

        await session.step("save a token", async () => {
            await page.locator("#lb-token").fill(`dogfood-${Date.now().toString(36)}`);
            await page.getByRole("button", { name: "Save token" }).click();
            await expect(page.getByText("Scrobbling on")).toBeVisible({ timeout: 10_000 });
            await expect.poll(hasToken).toBe(true);
            await expect(page.locator("#lb-token")).toHaveAttribute("placeholder", "Token saved — type to replace");
            const body = JSON.stringify(await getJson("/settings"));
            expect(body, "the token must never come back from the server").not.toContain("dogfood-");
        });

        await session.step("remove it", async () => {
            await page.locator("#lb-token-clear").check();
            await page.getByRole("button", { name: "Remove token" }).click();
            await expect(page.getByText("Token removed")).toBeVisible({ timeout: 10_000 });
            await expect.poll(hasToken).toBe(false);
        });

        session.assertClean("Journey 3 (ListenBrainz)");
    });

    test("4. public feed: the export, the live trip, and the sharing switch", async () => {
        test.setTimeout(10 * 60_000);
        session.setJourney("4. Public feed");

        await session.step("the export refuses a missing token", async () => {
            const res = await publicApi.get("/api/public/vibe/library");
            expect(res.status()).toBe(401);
        });

        await session.step("the export serves the library, then 304 on its ETag", async () => {
            const headers = { Authorization: `Bearer ${vibeToken}` };
            // The export answers 503 until its first build after a restart finishes.
            let res = await publicApi.get("/api/public/vibe/library", { headers });
            for (const deadline = Date.now() + 5 * 60_000; res.status() === 503 && Date.now() < deadline; ) {
                await page.waitForTimeout(5_000);
                res = await publicApi.get("/api/public/vibe/library", { headers });
            }
            expect(res.status()).toBe(200);
            const etag = res.headers()["etag"];
            expect(etag, "the export must carry an ETag").toBeTruthy();
            const body = (await res.json()) as { version: number; tracks: { id: string; xyz: number[] }[]; excluded: number };
            expect(body.tracks.length, "the export has no tracks").toBeGreaterThan(0);
            expect(body.tracks[0].xyz).toHaveLength(3);
            const again = await publicApi.get("/api/public/vibe/library", {
                headers: { ...headers, "If-None-Match": etag },
            });
            expect(again.status()).toBe(304);
            return { tracks: body.tracks.length, excluded: body.excluded };
        });

        await session.step("the sharing switch is on", async () => {
            await navigateByClick(page, "/settings");
            await settle(page, 1500);
            const toggle = page.locator("#share-live");
            await toggle.scrollIntoViewIfNeeded();
            if (!(await toggle.isChecked())) {
                await settingsSwitch("share-live").click();
                await saveSettings();
            }
            await expect(toggle).toBeChecked();
        });

        let trackId: string | null = null;
        await session.step("playing shows on the live feed", async () => {
            await openAlbumsTab(page);
            await firstAlbumCard(page).click();
            await page.waitForURL(/\/album\//, { timeout: 15_000 });
            await settle(page, 1000);
            await page.getByLabel("Play all").click();
            await page.getByTitle("pause", { exact: true }).first().waitFor({ timeout: 15_000 });
            trackId = await playingTrackId();
            expect(trackId, "the player has no track source").toBeTruthy();
            await expect.poll(async () => (await live()).status, { timeout: 15_000 }).toBe("playing");
            expect((await live()).trackId).toBe(trackId);
            return { trackId: trackId ?? "" };
        });

        await session.step("pausing shows as paused, not stopped", async () => {
            await page.getByTitle("pause", { exact: true }).first().click();
            await expect.poll(async () => (await live()).status, { timeout: 15_000 }).toBe("paused");
            const state = await live();
            expect(state.trackId).toBe(trackId);
            expect(state.position).toBeGreaterThan(0);
        });

        await session.step("switching sharing off hides the feed at once", async () => {
            await navigateByClick(page, "/settings");
            await settle(page, 1500);
            const toggle = page.locator("#share-live");
            await toggle.scrollIntoViewIfNeeded();
            await settingsSwitch("share-live").click();
            await saveSettings();
            expect((await live()).status).toBe("hidden");
        });

        await session.step("switching it back on shows the feed again", async () => {
            await settingsSwitch("share-live").click();
            await saveSettings();
            expect((await live()).status).not.toBe("hidden");
            await page.getByTitle("play", { exact: true }).first().click();
            await expect.poll(async () => (await live()).status, { timeout: 15_000 }).toBe("playing");
            await page.getByTitle("pause", { exact: true }).first().click();
            await expect.poll(async () => (await live()).status, { timeout: 15_000 }).toBe("paused");
        });

        session.assertClean("Journey 4 (public feed)");
    });

    test("5. GPU: the runtime stays while either switch is on, goes when both are off, and each switch applies on its own", async () => {
        test.setTimeout(GPU_INSTALL_MS + 10 * 60_000);
        session.setJourney("5. GPU runtime");

        type Gpu = {
            supported: boolean; enabled: boolean; analysis: boolean; installed: boolean; installing: boolean;
            effective: boolean; analysisEffective: boolean; status: string; reason: string | null;
        };
        const gpu = () => getJson<Gpu>("/system-settings/gpu");
        const vectorsStatus = () => page.getByTestId("gpu-onnx-toggle-status");
        const analysisStatus = () => page.getByTestId("gpu-analysis-toggle-status");

        await session.step("vibe embeddings and audio analysis both run on the GPU", async () => {
            await navigateByClick(page, "/settings");
            await settle(page, 1500);
            await page.locator("#gpu-onnx-toggle").scrollIntoViewIfNeeded();
            const state = await gpu();
            expect(state, "both GPU switches should be on and active").toMatchObject({
                enabled: true, analysis: true, installed: true, effective: true, analysisEffective: true,
            });
            await expect(vectorsStatus()).toHaveText("Active");
            await expect(analysisStatus()).toHaveText("Active");
            await expect(page.locator("#gpu-onnx-toggle")).toBeChecked();
            await expect(page.locator("#gpu-analysis-toggle")).toBeChecked();
        });

        await session.step("switching vibe embeddings off keeps the runtime for audio analysis", async () => {
            await settingsSwitch("gpu-onnx-toggle").click();
            await expect(vectorsStatus()).toHaveText("Runtime installed; GPU is off.", { timeout: 2 * 60_000 });
            const state = await gpu();
            expect(state).toMatchObject({ enabled: false, analysis: true, installed: true });
        });

        await session.step("switching audio analysis off too removes the runtime", async () => {
            await settingsSwitch("gpu-analysis-toggle").click();
            await expect.poll(async () => (await gpu()).installed, { timeout: 2 * 60_000 }).toBe(false);
            await expect(vectorsStatus()).toHaveText("Off (CPU)");
            await expect(analysisStatus()).toHaveText("Off (CPU)");
            expect(await gpu()).toMatchObject({ effective: false, analysisEffective: false });
        });

        await session.step("switching both on downloads it again and both analyzers take it up on their own", async () => {
            const started = Date.now();
            await settingsSwitch("gpu-onnx-toggle").click();
            await settingsSwitch("gpu-analysis-toggle").click();
            await expect(vectorsStatus()).toHaveText("Active", { timeout: GPU_INSTALL_MS + 3 * 60_000 });
            await expect(analysisStatus()).toHaveText("Active", { timeout: 3 * 60_000 });
            expect(await gpu()).toMatchObject({
                enabled: true, analysis: true, installed: true, effective: true, analysisEffective: true, status: "installed",
            });
            return { applySeconds: Math.round((Date.now() - started) / 1000) };
        });

        session.assertClean("Journey 5 (GPU)");
    });

    test("6. release window: a new admin answers every release", async () => {
        test.setTimeout(5 * 60_000);
        session.setJourney("6. Release window");

        const name = `dogfood_rel_${Date.now().toString(36)}`;
        const pass = "dogfood-pass-1";
        let userId = "";
        const fresh = await browser.newContext({ viewport: { width: 1440, height: 900 } });
        const fp = await fresh.newPage();
        session.attach(fp);
        session.setActivePage(fp);
        const dialog = fp.locator('div[role="dialog"][aria-labelledby="whats-new-title"]');
        const heading = fp.locator("#whats-new-title");
        let freshToken = "";
        const freshGet = async <T>(path: string): Promise<T> => {
            const res = await fp.request.get(`/api${path}`, { headers: { Authorization: `Bearer ${freshToken}` } });
            expect(res.status(), `GET /api${path}`).toBe(200);
            return (await res.json()) as T;
        };

        try {
            await session.step("create an admin who has seen no release", async () => {
                const res = await page.request.post("/api/auth/create-user", {
                    headers: auth(),
                    data: { username: name, password: pass, role: "admin" },
                });
                expect(res.status()).toBeLessThan(300);
                const body = await res.json();
                userId = body.id;
                expect(userId, "create-user returned no id").toBeTruthy();
            });

            await session.step("sign in as them and give them a saved mood mix", async () => {
                session.expectFailure({ urlPattern: /\/api\/auth\/me/, status: 401, reason: "before sign-in" });
                await fp.goto("/login");
                await fp.locator("#username").fill(name);
                await fp.locator("#password").fill(pass);
                await fp.getByRole("button", { name: /sign in/i }).click();
                await fp.waitForURL((u) => !u.pathname.startsWith("/login"), { timeout: 30_000 });
                session.clearExpectedFailures();
                freshToken = await fp.evaluate(() => localStorage.getItem("auth_token") ?? "");
                const presets = await freshGet<{ id: string; trackCount: number }[]>("/mixes/mood/buckets/presets");
                const mood = presets.find((p) => p.trackCount >= 8);
                expect(mood, "no mood has enough tracks for a mix").toBeTruthy();
                const saved = await fp.request.post(`/api/mixes/mood/buckets/${mood!.id}/save`, {
                    headers: { Authorization: `Bearer ${freshToken}` },
                    data: {},
                });
                expect(saved.status()).toBe(200);
                await fp.reload();
                return { mood: mood!.id };
            });

            await session.step("the window opens on the newest release, with the older ones before it", async () => {
                await expect(dialog).toBeVisible({ timeout: 15_000 });
                await expect(heading).toHaveText(NEWEST.heading);
                for (const key of NEWEST.items) {
                    await expect(dialog.locator(`[data-item="${key}"]`)).toBeVisible();
                }
                await expect(dialog.locator('[data-release="1.11.0"]')).toContainText("a note from Kevin");
                await expect(dialog.locator('[data-release="1.10.1"]')).toBeVisible();
            });

            await session.step("an older release opens as its own page, and its items come back to it", async () => {
                await dialog.locator('[data-release="1.10.1"]').click();
                for (const title of ["A play means you listened", "Clean up old play counts"]) {
                    await expect(dialog.locator("[data-item]").filter({ hasText: title }).first()).toBeVisible();
                }
                await dialog.locator('[data-item="plays.repair"]').click();
                await expect(dialog.getByRole("link", { name: /Open the cleanup/ })).toHaveAttribute("href", "/stats#false-starts");
                await dialog.locator("[data-back]").click();
                await expect(dialog.locator('[data-item="plays.repair"]')).toBeFocused();
                await dialog.locator("[data-back]").click();
                await expect(dialog.locator('[data-release="1.10.1"]')).toBeFocused();

                await dialog.locator('[data-release="1.11.0"]').click();
                await expect(dialog.getByRole("heading", { name: "A note from Kevin" })).toBeVisible();
                for (const title of ["The new vibe engine", "The new vibe map"]) {
                    await expect(dialog.locator("[data-item]").filter({ hasText: title }).first()).toBeVisible();
                }
                // The wipe is offered only to a library enriched before 1.11.
                const wipe = dialog.locator('[data-item="engine.wipe"]');
                if (await wipe.count()) {
                    await wipe.click();
                    await expect(fp.getByTestId("wipe-run")).toBeVisible();
                    await dialog.locator("[data-back]").click();
                    await expect(wipe).toBeFocused();
                } else {
                    session.noteNotCovered("release window: the wipe item, since this library was enriched by 1.11 already");
                }
            });

            await session.step("the mood mix is saved as a playlist, then rebuilt", async () => {
                await dialog.locator('[data-item="moods.mixes"]').click();
                await expect(fp.getByTestId("moodmix-name")).toBeVisible({ timeout: 10_000 });
                const savedResponse = fp.waitForResponse((r) => r.url().includes("/whats-new/mood-mixes/save"));
                await fp.getByTestId("moodmix-save").click();
                const saved = (await (await savedResponse).json()) as { id: string; trackCount: number };
                await expect(fp.getByTestId("moodmix-saved")).toBeVisible({ timeout: 15_000 });
                await fp.getByTestId("moodmix-rebuild").click();
                await expect(fp.getByTestId("moodmix-rebuilt")).toBeVisible({ timeout: 15_000 });
                const state = await freshGet<{ mix: unknown }>("/whats-new/mood-mixes");
                expect(state.mix, "the rebuilt mix should be gone").toBeNull();
                // The rebuild clears the mix status, so read the playlist directly.
                const playlist = await freshGet<{ id: string; items: unknown[] }>(`/playlists/${saved.id}`);
                expect(playlist.items, "the saved playlist should keep its tracks").toHaveLength(saved.trackCount);
                await dialog.locator("[data-back]").click();
                await expect(dialog.locator("#whats-new-release")).toHaveText("Kima 1.11");
            });

            await session.step("the GPU answer is kept through closing, and every release closes", async () => {
                // The GPU question is asked exactly where the server says the GPU runtime can run (linux on x64).
                const gpuItem = dialog.locator('[data-item="gpu.accelerate"]');
                const gpuAsked = (await getJson<{ supported: boolean }>("/system-settings/gpu")).supported;
                await expect(gpuItem, gpuAsked ? "this host supports the GPU but the release never asks" : "this host cannot run the GPU but the release asks").toHaveCount(gpuAsked ? 1 : 0);
                if (gpuAsked) {
                    await gpuItem.click();
                    const answered = fp.waitForResponse((r) => r.url().includes("/whats-new/1.11.0/choice"));
                    await dialog.getByRole("button", { name: "Turn it on", exact: true }).click();
                    expect((await answered).status()).toBe(200);
                    await expect(dialog.getByRole("button", { name: "Turn it on", exact: true })).toHaveAttribute("aria-pressed", "true");
                } else {
                    session.noteNotCovered("release window: answering the GPU question, which this host rightly does not ask (not linux on x64)");
                }
                const older = fp.waitForResponse((r) => r.url().includes("/whats-new/1.10.1/dismiss"));
                const dismissed = fp.waitForResponse((r) => r.url().includes("/whats-new/1.11.0/dismiss"));
                const newest = fp.waitForResponse((r) => r.url().includes(`/whats-new/${NEWEST.version}/dismiss`));
                await fp.getByTestId("whatsnew-done").click();
                expect((await older).status()).toBe(200);
                expect((await newest).status()).toBe(200);
                const body = (await (await dismissed).json()) as { recordedDefaults: unknown[] };
                if (gpuAsked) {
                    expect(JSON.stringify(body.recordedDefaults), "an explicit answer must not be overwritten").not.toContain("gpu.accelerate");
                    expect((await getJson<{ enabled: boolean }>("/system-settings/gpu")).enabled).toBe(true);
                }
                await expect(dialog).toBeHidden({ timeout: 10_000 });
                const pending = await freshGet<{ releases: unknown[] }>("/whats-new/pending");
                expect(pending.releases).toHaveLength(0);
                await fp.reload();
                await settle(fp, 2500);
                await expect(dialog).toBeHidden();
            });

            await session.step("with everything read, the version number opens the changelog", async () => {
                await fp.getByRole("button", { name: /what's new in v/i }).click();
                await fp.waitForURL(/\/changelog$/, { timeout: 10_000 });
                await expect(dialog).toBeHidden();
                await expect(fp.locator(`[id="cl-${NEWEST.version}"]`)).toBeVisible({ timeout: 10_000 });
                await expect(fp.locator("main")).toContainText(NEWEST.changelogText);
            });
        } finally {
            session.setActivePage(page);
            await fresh.close();
            if (userId) {
                const res = await page.request.delete(`/api/auth/users/${userId}`, { headers: auth() });
                expect(res.status(), "removing the release-window user").toBeLessThan(300);
            }
        }

        session.assertClean("Journey 6 (release window)");
    });
});
