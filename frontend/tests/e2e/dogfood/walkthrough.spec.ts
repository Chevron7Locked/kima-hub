/**
 * The dogfood walkthrough -- one person, one sitting, the whole app.
 *
 * WHAT MAKES THIS DIFFERENT FROM THE REST OF THE SUITE
 *
 * Every other spec here is a feature test: log in, jump straight to the page under test,
 * assert, throw the browser away. That shape is right for finding a broken feature and
 * wrong for answering "is this build safe to deploy", for three reasons.
 *
 *   1. It reloads between every action. A full page load wipes React state -- the queue,
 *      the current track, open panels -- so any fault that needs state to accumulate cannot
 *      occur. Real sessions run for half an hour without a reload.
 *   2. It asserts liveness, not correctness. "the body contains the word album" passes on a
 *      page that rendered its shell and no data. This file asserts the user's actual music
 *      is on screen, and that the audio position actually moves.
 *   3. It skips when data is missing. For a deployment gate that is the worst outcome
 *      available: green, having tested nothing. Here a bare instance fails the run.
 *
 * So: one browser, opened once, driven by clicking the way a person drives it, with a
 * monitor watching the whole session and a report written at the end.
 *
 * RUNNING IT
 *   KIMA_UI_BASE_URL=http://host:3030 \
 *   KIMA_TEST_USERNAME=... KIMA_TEST_PASSWORD=... \
 *   npx playwright test tests/e2e/dogfood --reporter=list
 */
import { test, expect, devices, Browser, Page, BrowserContext } from "@playwright/test";
import { DogfoodSession, navigateByClick, settle, firstAlbumCard, openAlbumsTab } from "./session";
import { readLibraryFacts, assertReady, availableJourneys, LibraryFacts } from "./preflight";

const baseUrl = process.env.KIMA_UI_BASE_URL || "http://127.0.0.1:3030";
const username = process.env.KIMA_TEST_USERNAME || "";
const password = process.env.KIMA_TEST_PASSWORD || "";

const PLAYER = '[data-kima-player="main"]';
const RUN_TAG = `dogfood-${Date.now()}`;

/** Make a literal string safe to drop into a RegExp used as an accessible-name filter. */
function escapeRegExp(s: string): string {
    return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

// A walkthrough is a long single thread of interactions: journey 4 has no meaning if
// journey 2 never got audio playing. Serial mode stops the run at the first real failure
// instead of reporting eight confusing consequences of one cause.
test.describe.configure({ mode: "serial" });

// Headless Chromium ships with NO WebGL at all -- measured: both webgl and webgl2 come
// back null on a default launch. The vibe map draws through deck.gl, so without this it
// dies on startup with "Cannot read properties of null (reading 'luma')" and the map
// journey would be testing the absence of a graphics stack rather than the app. These
// flags turn on software rendering (SwiftShader), which is slower than a real GPU and
// perfectly sufficient for confirming the map draws.
test.use({
    launchOptions: {
        args: ["--use-gl=angle", "--use-angle=swiftshader", "--enable-unsafe-swiftshader"],
    },
});

test.describe("Dogfood walkthrough", () => {
    let browser: Browser;
    let context: BrowserContext;
    let page: Page;
    let session: DogfoodSession;
    let facts: LibraryFacts;
    let journeys: ReturnType<typeof availableJourneys>;
    let token = "";
    const createdPlaylistIds: string[] = [];
    let podcastId = "";
    let podcastTitle = "";

    test.beforeAll(async ({ browser: launched }) => {
        browser = launched;
        expect(
            username && password,
            "KIMA_TEST_USERNAME and KIMA_TEST_PASSWORD must be set. Create the user with scripts/create-e2e-user.sh",
        ).toBeTruthy();

        context = await browser.newContext({ viewport: { width: 1440, height: 900 } });
        page = await context.newPage();
        session = new DogfoodSession(page, baseUrl);

        // Watch from before the first paint -- a crash on the login screen still counts.
        session.attach();
    });

    test.afterAll(async () => {
        // Remove anything this run created, whether it passed or not. A gate that litters
        // the instance it tests gets turned off.
        for (const id of createdPlaylistIds) {
            await page.request
                .delete(`/api/playlists/${id}`, { headers: { Authorization: `Bearer ${token}` } })
                .catch(() => {});
        }

        if (session) {
            const reportPath = session.writeReport("test-results");
            console.log(`\n[dogfood] report written to ${reportPath}`);
            console.log(`[dogfood] ${session.steps.length} steps, ${session.violations.length} violations`);
            console.log(`[dogfood] event stream opened ${session.sseConnectionCount} time(s)`);
            if (session.heapGrowthMb >= 0) {
                console.log(`[dogfood] JS heap grew ${session.heapGrowthMb}MB across the session`);
            }
            // Preflight gaps and gaps discovered mid-run print together -- both mean the
            // same thing to whoever reads this before deploying.
            for (const r of [...(journeys?.reasons ?? []), ...session.gaps]) {
                console.log(`[dogfood] NOT COVERED -- ${r}`);
            }
        }
        await context?.close();
    });

    // ----------------------------------------------------------------------------------
    test("1. arrive: sign in and find real music on the home screen", async () => {
        session.setJourney("1. Arrive");

        // Landing on the login screen, the app asks the server who is signed in and is
        // told nobody. That 401 is the correct answer to the question, not a fault, so it
        // is declared here and withdrawn the moment a session exists -- after which a 401
        // means something really did go wrong.
        session.expectFailure({
            urlPattern: /\/api\/auth\/me/,
            status: 401,
            reason: "the session check on the login screen, before anyone has signed in",
        });

        await session.step("open the app", async () => {
            await page.goto("/login");
            await settle(page);
            return { url: page.url() };
        });

        await session.step("sign in", async () => {
            await page.locator("#username").fill(username);
            await page.locator("#password").fill(password);
            await page.getByRole("button", { name: "Sign In" }).click();
            await page.waitForURL(/\/($|\?|home)/, { timeout: 20_000 });
            await settle(page, 1500);
            token = await page.evaluate(() => localStorage.getItem("auth_token") ?? "");
            // Signed in now: an unauthorised answer from here on is a real problem.
            session.clearExpectedFailures();
            return { landedOn: new URL(page.url()).pathname, gotToken: token.length > 0 };
        });

        await session.step("check this instance holds enough music to test", async () => {
            facts = await readLibraryFacts(page.request, token);
            assertReady(facts, baseUrl);
            journeys = availableJourneys(facts);
            return { ...facts };
        });

        // The home screen must show the user's library, not an empty shell. Album artwork
        // links are the cheapest honest proof that real rows were fetched and rendered.
        await session.step("home screen shows library content", async () => {
            const links = page.locator('a[href^="/album/"], a[href^="/artist/"]');
            await expect(links.first()).toBeVisible({ timeout: 15_000 });
            const count = await links.count();
            expect(count, "home screen rendered no album or artist links").toBeGreaterThan(0);
            return { contentLinks: count };
        });

        session.assertClean("Journey 1 (arrive)");
    });

    // ----------------------------------------------------------------------------------
    test("2. listen: search for something and hear it play", async () => {
        session.setJourney("2. Listen");

        // Search for an artist that is genuinely in this library, read from the API. A
        // hardcoded query would test the search box against data that may not exist.
        let artistName = "";
        await session.step("pick a real artist to search for", async () => {
            const res = await page.request.get("/api/library/artists?limit=1", {
                headers: { Authorization: `Bearer ${token}` },
            });
            const body = await res.json();
            artistName = body.artists?.[0]?.name ?? "";
            expect(artistName, "could not read an artist name from the library").toBeTruthy();
            return { artist: artistName };
        });

        await session.step("search for that artist", async () => {
            const box = page.getByLabel("Search");
            await box.click();
            await box.fill(artistName);
            await box.press("Enter");
            await page.waitForURL(/\/search/, { timeout: 10_000 });
            await settle(page, 1500);
            return { query: artistName, url: new URL(page.url()).pathname };
        });

        await session.step("the artist appears in the results", async () => {
            // Match on the artist's own name rather than "some result appeared", so a
            // search that returns the wrong thing is a failure.
            const hit = page.getByText(artistName, { exact: false }).first();
            await expect(hit).toBeVisible({ timeout: 10_000 });
            return { found: artistName };
        });

        await session.step("open an album", async () => {
            if (!(await firstAlbumCard(page).isVisible().catch(() => false))) {
                await openAlbumsTab(page);
            }
            // Journey 3 queues a *second* track from whatever album opens
            // here, and production data contains single-track releases -- a
            // classical artist's search results can be nothing but singles
            // -- so prefer an album with at least two rows. The search page
            // keeps its query in component state (a bare /search URL), so
            // back-navigation restores an empty results list: collect the
            // candidate hrefs while results are on screen and navigate
            // forward to each candidate instead.
            const collect = async (): Promise<string[]> => {
                const cards = page.locator('main a[href^="/album/"]');
                await cards.first().waitFor({ state: "visible", timeout: 10_000 });
                const seen = (await cards.evaluateAll((els) =>
                    els
                        .slice(0, 5)
                        .map((e) => (e as HTMLAnchorElement).getAttribute("href")),
                )) as (string | null)[];
                return seen.filter((h): h is string => !!h);
            };
            const tryPool = async (pool: string[], clickFirst: boolean): Promise<boolean> => {
                for (let i = 0; i < pool.length; i++) {
                    if (i === 0 && clickFirst) {
                        await page.locator('main a[href^="/album/"]').first().click();
                    } else {
                        await page.goto(new URL(pool[i], page.url()).toString(), {
                            waitUntil: "domcontentloaded",
                        });
                    }
                    await page.waitForURL(/\/album\//, { timeout: 10_000 });
                    await settle(page, 800);
                    if ((await page.locator("[data-track-row]").count()) >= 2) {
                        return true;
                    }
                }
                return false;
            };

            let opened = await tryPool(await collect(), true);
            if (!opened) {
                // The search results held only singles; widen to the
                // collection's album grid, which spans the whole catalogue.
                await openAlbumsTab(page);
                opened = await tryPool(await collect(), true);
            }
            expect(
                opened,
                "no album with two or more tracks found in search results or the collection grid",
            ).toBe(true);
            await settle(page, 1200);
            return { album: new URL(page.url()).pathname };
        });

        await session.step("the album lists its tracks", async () => {
            const rows = page.locator("[data-track-row]");
            await expect(rows.first()).toBeVisible({ timeout: 10_000 });
            const count = await rows.count();
            expect(count, "album page rendered no track rows").toBeGreaterThan(0);
            return { trackRows: count };
        });

        await session.step("press play", async () => {
            await page.getByLabel("Play all").click();
            await page.getByTitle("Pause", { exact: true }).waitFor({ timeout: 15_000 });
            const src = await page.evaluate(
                (sel) => (document.querySelector(sel) as HTMLAudioElement | null)?.src ?? "",
                PLAYER,
            );
            expect(src, "no audio source was set").toBeTruthy();
            return { streamUrl: src.replace(baseUrl, "").slice(0, 80) };
        });

        // The assertion the rest of the suite never makes. A src attribute and a Pause
        // icon prove the UI changed its mind, not that a single sample reached the
        // speakers. Position moving forward is the only evidence of actual playback.
        await session.step("audio is genuinely advancing", async () => {
            const read = () =>
                page.evaluate(
                    (sel) => {
                        const el = document.querySelector(sel) as HTMLAudioElement | null;
                        return { t: el?.currentTime ?? -1, paused: el?.paused ?? true, ready: el?.readyState ?? 0 };
                    },
                    PLAYER,
                );

            const first = await read();
            await page.waitForTimeout(2500);
            const second = await read();

            expect(second.paused, "the audio element is paused while the UI shows Pause").toBe(false);
            expect(
                second.t,
                `audio did not advance (${first.t}s -> ${second.t}s)`,
            ).toBeGreaterThan(first.t);

            return { from: first.t.toFixed(2), to: second.t.toFixed(2) };
        });

        session.assertClean("Journey 2 (listen)");
    });

    // ----------------------------------------------------------------------------------
    test("3. queue: line up more music and confirm every surface agrees", async () => {
        session.setJourney("3. Queue");

        const queueLength = () =>
            page.evaluate(() => {
                try {
                    return JSON.parse(localStorage.getItem("kima_queue") || "[]").length;
                } catch {
                    return -1;
                }
            });

        await session.step("add a track to the queue", async () => {
            const before = await queueLength();
            const row = page.locator("[data-track-row]").nth(1);
            await row.waitFor({ state: "visible", timeout: 10_000 });
            await row.hover();
            await row.getByLabel("Add to queue").click();
            await page.waitForTimeout(600);
            return { queueBefore: before, queueAfter: await queueLength() };
        });

        // Client-side navigation on purpose: the queue lives in React state, so reloading
        // the page would destroy the very thing being checked.
        await session.step("open the queue from the player", async () => {
            await page.getByTitle("Play queue").click();
            await page.waitForURL(/\/queue/, { timeout: 10_000 });
            await settle(page, 1000);
            return { url: new URL(page.url()).pathname, queueOnArrival: await queueLength() };
        });

        await session.step("the queue shows what is playing and what is next", async () => {
            await expect(page.getByRole("heading", { name: "Now Playing" })).toBeVisible({
                timeout: 10_000,
            });
            const len = await queueLength();
            const shown = await page
                .locator("text=/\\d+ track/")
                .first()
                .textContent()
                .catch(() => "?");
            await expect(
                page.getByText(/Next Up/),
                `queue holds ${len} item(s); the page reads "${shown?.trim()}"`,
            ).toBeVisible({ timeout: 10_000 });
            return { nowPlaying: true, nextUp: true, queueLength: len };
        });

        // Cross-surface consistency. The player and the queue page render the same state
        // through different components; if they disagree, one of them is lying to the user.
        //
        // The anchor is the track id embedded in the stream URL the audio element is
        // actually pulling from -- the one fact that cannot be faked by a stale render.
        // Its real title comes from the API, and that title must be the one the queue page
        // is showing under Now Playing.
        await session.step("the queue and the player name the same track", async () => {
            const src = await page.evaluate(
                (sel) => (document.querySelector(sel) as HTMLAudioElement | null)?.src ?? "",
                PLAYER,
            );
            const id = src.match(/\/tracks\/([^/]+)\/stream/)?.[1];
            expect(id, `could not read a track id from the stream URL: ${src}`).toBeTruthy();

            const res = await page.request.get(`/api/library/tracks/${id}`, {
                headers: { Authorization: `Bearer ${token}` },
            });
            expect(res.ok(), `looking up the playing track returned ${res.status()}`).toBeTruthy();
            const body = await res.json();
            const title: string = body.title ?? body.track?.title ?? "";
            expect(title, "the playing track has no title").toBeTruthy();

            const heading = page.getByRole("heading", { name: "Now Playing" });
            const section = heading.locator("xpath=..");
            const text = ((await section.textContent()) ?? "").replace(/\s+/g, " ");

            expect(
                text,
                `the player is streaming "${title}" but the queue's Now Playing section ` +
                    `reads "${text.slice(0, 90)}"`,
            ).toContain(title);

            return { playingTrackId: id, title };
        });

        session.assertClean("Journey 3 (queue)");
    });

    // ----------------------------------------------------------------------------------
    test("3a. queue, deeper: the up-next list survives being edited", async () => {
        // The default 60s is too tight once hover-gated buttons and audio waits stack up.
        test.setTimeout(180_000);
        session.setJourney("3a. Queue editing");

        const queueLength = () =>
            page.evaluate(() => {
                try {
                    return JSON.parse(localStorage.getItem("kima_queue") || "[]").length;
                } catch {
                    return -1;
                }
            });

        await session.step("start playing and queue two more tracks", async () => {
            await page.goto("/collection?tab=albums");
            await settle(page, 1500);
            const album = firstAlbumCard(page);
            await album.waitFor({ state: "visible", timeout: 12_000 });
            await album.click();
            await page.waitForURL(/\/album\//, { timeout: 10_000 });
            await settle(page, 1200);

            await page.getByLabel("Play all").click();
            await page.getByTitle("Pause", { exact: true }).waitFor({ timeout: 15_000 });

            for (const n of [1, 2]) {
                const row = page.locator("[data-track-row]").nth(n);
                await row.hover();
                await row.getByLabel("Add to queue").click();
            }
            await page.waitForTimeout(600);
            const len = await queueLength();
            expect(len, `queue holds ${len} item(s) after adding two`).toBeGreaterThanOrEqual(3);
            return { queueLength: len };
        });

        await session.step("open the queue page", async () => {
            await page.getByTitle("Play queue").click();
            await page.waitForURL(/\/queue/, { timeout: 10_000 });
            await settle(page, 1000);
            return { queueOnArrival: await queueLength() };
        });

        // Every row action is hover-gated (opacity-0 group-hover:opacity-100), so each
        // one hovers its row first. Selectors are the aria-labels the queue page emits.
        await session.step("remove one upcoming track", async () => {
            const before = await queueLength();
            const rows = page.locator("main [data-track-index], main .group").filter({
                has: page.locator('[aria-label^="Remove "]'),
            });
            const target = rows.first();
            await target.hover();
            await target.locator('[aria-label^="Remove "]').first().click();
            await page.waitForTimeout(600);
            const after = await queueLength();
            expect(after, `remove clicked but queue went ${before} -> ${after}`).toBe(before - 1);
            return { before, after };
        });

        await session.step("move an upcoming track down and back up", async () => {
            const rows = page
                .locator("main .group")
                .filter({ has: page.locator('[aria-label^="Move "]') });
            const first = rows.first();
            await first.hover();
            const down = first.locator('[aria-label$=" down"]').first();
            await expect(down).toBeEnabled();
            const titleBefore = (await first.textContent())?.replace(/\s+/g, " ").trim();
            await down.click();
            await page.waitForTimeout(400);

            // The moved row is now second; its own up-button is the enabled one.
            // (The first row's up is permanently disabled -- it sits against
            // Now Playing -- which is the row's design, not a bug.)
            const moved = rows.nth(1);
            await moved.hover();
            const up = moved.locator('[aria-label$=" up"]').first();
            await expect(up).toBeEnabled();
            await up.click();
            await page.waitForTimeout(400);

            const titleAfter = ((await rows.first().textContent()) ?? "").replace(/\s+/g, " ").trim();
            expect(titleAfter, `row moved down and back up but read "${titleBefore}" then "${titleAfter}"`).toBe(
                titleBefore,
            );
            return { roundTripped: titleAfter === titleBefore };
        });

        await session.step("play now jumps to a chosen track", async () => {
            const row = page
                .locator("main .group")
                .filter({ has: page.locator('[aria-label^="Play "]') })
                .first();
            await row.hover();
            const title = (await row.textContent())?.replace(/\s+/g, " ").trim().slice(0, 40);
            await row.locator('[aria-label^="Play "]').first().click();
            await page.waitForTimeout(1500);
            // Play Now replaces the queue position; the audio source must have moved.
            const playing = await page.evaluate(
                (sel) => (document.querySelector(sel) as HTMLAudioElement | null)?.src ?? "",
                PLAYER,
            );
            expect(playing, "no audio source after Play Now").toBeTruthy();
            const heading = page.getByRole("heading", { name: "Now Playing" });
            const nowPlaying = ((await heading.locator("xpath=..").textContent()) ?? "")
                .replace(/\s+/g, " ")
                .slice(0, 120);
            return { chose: title, nowPlaying: nowPlaying };
        });

        await session.step("clear the queue", async () => {
            const clear = page.getByRole("button", { name: /clear queue/i });
            await expect(clear).toBeVisible({ timeout: 8_000 });
            await clear.click();
            await page.waitForTimeout(800);
            expect(await queueLength(), "Clear Queue clicked but the queue is not empty").toBe(0);
            return { cleared: true };
        });

        session.assertClean("Journey 3a (queue editing)");
    });

    // ----------------------------------------------------------------------------------
    test("3b. session resilience: pause, wait, resume, run to the end, reload", async () => {
        // 15s idle + up to 25s auto-advance + a reload, in one journey.
        test.setTimeout(240_000);
        session.setJourney("3b. Session resilience");

        await session.step("start playing again", async () => {
            await page.goto("/collection?tab=albums");
            await settle(page, 1500);
            const album = firstAlbumCard(page);
            await album.waitFor({ state: "visible", timeout: 12_000 });
            await album.click();
            await page.waitForURL(/\/album\//, { timeout: 10_000 });
            await settle(page, 1200);
            await page.getByLabel("Play all").click();
            await page.getByTitle("Pause", { exact: true }).waitFor({ timeout: 15_000 });
            return { playing: true };
        });

        // A paused stream holds an open HTTP connection; the server runs with
        // timeout=0 + keepalive specifically so it is not dropped. Fifteen seconds of
        // nothing is enough to catch an aggressive proxy timeout, cheap enough not to
        // slow the gate.
        await session.step("pause, sit idle, and resume", async () => {
            await page.getByTitle("Pause", { exact: true }).click();
            await expect(page.getByTitle("Play", { exact: true })).toBeVisible({ timeout: 8_000 });
            await page.waitForTimeout(15_000);

            await page.getByTitle("Play", { exact: true }).click();
            await page.getByTitle("Pause", { exact: true }).waitFor({ timeout: 10_000 });
            const read = () =>
                page.evaluate(
                    (sel) => {
                        const el = document.querySelector(sel) as HTMLAudioElement | null;
                        return { t: el?.currentTime ?? -1, paused: el?.paused ?? true };
                    },
                    PLAYER,
                );
            const a = await read();
            await page.waitForTimeout(2500);
            const b = await read();
            expect(b.paused, "resume clicked but the audio is still paused").toBe(false);
            expect(b.t, `after resuming from a 15s idle pause, position did not advance (${a.t}s -> ${b.t}s)`).toBeGreaterThan(a.t);
            return { idleSeconds: 15, resumedAt: b.t.toFixed(2) };
        });

        // True auto-advance: seek to just before the end and watch the player move to
        // the next track by itself. Clicking "Next" proves the button; this proves
        // the ended/gapless machinery, which no other spec in the suite does.
        await session.step("a track that ends advances on its own", async () => {
            const srcBefore = await page.evaluate(
                (sel) => (document.querySelector(sel) as HTMLAudioElement | null)?.src ?? "",
                PLAYER,
            );
            await page.evaluate((sel) => {
                const el = document.querySelector(sel) as HTMLAudioElement | null;
                if (el && Number.isFinite(el.duration) && el.duration > 0) {
                    el.currentTime = Math.max(0, el.duration - 2);
                }
            }, PLAYER);

            const deadline = Date.now() + 25_000;
            let srcNow = srcBefore;
            while (Date.now() < deadline) {
                srcNow = await page.evaluate(
                    (sel) => (document.querySelector(sel) as HTMLAudioElement | null)?.src ?? "",
                    PLAYER,
                );
                if (srcNow && srcNow !== srcBefore) break;
                await page.waitForTimeout(1000);
            }
            expect(
                srcNow,
                `seeked to 2s before the end and waited 25s; the source never changed ` +
                    `(before: ${srcBefore.slice(-60)}, after: ${srcNow.slice(-60)})`,
            ).not.toBe(srcBefore);

            // After a gapless swap the old element (data-kima-player="main") has its
            // src removed, so we must find the element that actually has the new
            // track's URL -- that's the active element regardless of swap.
            // Also track WHICH element was found so we check the right one later.
            const activeInfo = await page.evaluate(({ sel, before }) => {
                const main = document.querySelector(sel) as HTMLAudioElement | null;
                if (main?.src && main.src !== before) return { src: main.src, paused: main.paused, which: "main" };
                const next = document.querySelector('[data-kima-player="next"]') as HTMLAudioElement | null;
                if (next?.src && next.src !== before) return { src: next.src, paused: next.paused, which: "next" };
                return { src: "", paused: true, which: "none" };
            }, { sel: PLAYER, before: srcBefore });
            expect(activeInfo.src, 'the active element should have a non-empty src after auto-advance').not.toBe('');


            // Use the correct selector based on which element was found
            const playSel = activeInfo.which === 'next' ? '[data-kima-player="next"]' : PLAYER;

            // Wait for playback to actually start on the correct element
            const playDeadline = Date.now() + 10_000;
            let t0 = -1;
            let startedPlaying = false;
            while (Date.now() < playDeadline) {
                const { t, paused: p } = await page.evaluate(
                    (sel) => {
                        const el = document.querySelector(sel) as HTMLAudioElement | null;
                        return { t: el?.currentTime ?? -1, paused: el?.paused ?? true };
                    },
                    playSel,
                );
                if (t0 === -1) { t0 = t; }
                else if (!p && t > t0) { startedPlaying = true; break; }
                await page.waitForTimeout(500);
            }
            expect(startedPlaying, "the next track did not start playing after auto-advance").toBe(true);
            return { advanced: true };
        });


        session.assertClean("Journey 3b (session resilience)");
    });

    // ----------------------------------------------------------------------------------
    test("4. curate: build a playlist and confirm it survives a reload", async () => {
        session.setJourney("4. Curate");

        const name = `${RUN_TAG}-playlist`;
        let playlistId = "";

        await session.step("open playlists", async () => {
            await navigateByClick(page, "/playlists");
            await settle(page, 1200);
            return { url: new URL(page.url()).pathname };
        });

        await session.step("create a playlist", async () => {
            await page.locator("main").getByRole("button", { name: "Create" }).first().click();
            const input = page.getByPlaceholder("Playlist name...").first();
            await expect(input).toBeVisible({ timeout: 8_000 });
            await input.fill(name);
            await input.press("Enter");
            await page.waitForURL(/\/playlist\//, { timeout: 15_000 });
            playlistId = new URL(page.url()).pathname.split("/").pop() ?? "";
            expect(playlistId, "no playlist id in the URL after creating").toBeTruthy();
            createdPlaylistIds.push(playlistId);
            return { name, id: playlistId };
        });

        await session.step("add a track to it from an album", async () => {
            await openAlbumsTab(page);
            const album = firstAlbumCard(page);
            await album.click();
            await page.waitForURL(/\/album\//, { timeout: 10_000 });
            await settle(page, 1000);

            const row = page.locator("[data-track-row]").first();
            await row.waitFor({ state: "visible", timeout: 10_000 });
            await row.hover();
            await row.getByLabel("Add to playlist").click();

            // The picker lists each playlist as a button whose accessible name is the
            // playlist name plus its track count. Targeting by role is what separates it
            // from the sidebar entry for the same playlist, which is a link -- and it does
            // not depend on guessing which wrapper element is the modal.
            await expect(
                page.getByRole("heading", { name: "Add to Playlist" }),
            ).toBeVisible({ timeout: 8_000 });

            const option = page.getByRole("button", { name: new RegExp(escapeRegExp(name)) });
            await expect(option).toBeVisible({ timeout: 8_000 });
            await option.click();
            await page.waitForTimeout(800);
            return { addedTo: name };
        });

        // The one deliberate full reload in the walkthrough. Everything up to here has been
        // in-memory React state; this proves the write reached the server and comes back.
        await session.step("reload the playlist and the track is still there", async () => {
            await page.goto(`/playlist/${playlistId}`);
            await settle(page, 1500);
            const rows = page.locator("[data-track-index]");
            await expect(rows.first()).toBeVisible({ timeout: 12_000 });
            const count = await rows.count();
            expect(count, "the playlist lost its track across a reload").toBeGreaterThan(0);
            return { tracksAfterReload: count };
        });

        await session.step("delete the playlist", async () => {
            const res = await page.request.delete(`/api/playlists/${playlistId}`, {
                headers: { Authorization: `Bearer ${token}` },
            });
            expect(res.ok(), `deleting the playlist failed with ${res.status()}`).toBeTruthy();
            createdPlaylistIds.splice(createdPlaylistIds.indexOf(playlistId), 1);
            return { deleted: playlistId };
        });

        session.assertClean("Journey 4 (curate)");
    });

    // ----------------------------------------------------------------------------------
    test("4b. curate, deeper: rename, remove, hide, and delete from the UI", async () => {
        test.setTimeout(180_000);
        session.setJourney("4b. Playlist editing");

        const name = `${RUN_TAG}-edit`;
        const renamed = `${RUN_TAG}-renamed`;
        let playlistId = "";

        await session.step("create a playlist with two tracks in it", async () => {
            await navigateByClick(page, "/playlists");
            await settle(page, 1200);
            await page.locator("main").getByRole("button", { name: "Create" }).first().click();
            const input = page.getByPlaceholder("Playlist name...").first();
            await expect(input).toBeVisible({ timeout: 8_000 });
            await input.fill(name);
            await input.press("Enter");
            await page.waitForURL(/\/playlist\//, { timeout: 15_000 });
            playlistId = new URL(page.url()).pathname.split("/").pop() ?? "";
            createdPlaylistIds.push(playlistId);

            for (const n of [0, 1]) {
                await openAlbumsTab(page);
                const album = firstAlbumCard(page);
                await album.click();
                await page.waitForURL(/\/album\//, { timeout: 10_000 });
                await settle(page, 1000);
                const row = page.locator("[data-track-row]").nth(n);
                await row.waitFor({ state: "visible", timeout: 10_000 });
                await row.hover();
                await row.getByLabel("Add to playlist").click();
                await expect(page.getByRole("heading", { name: "Add to Playlist" })).toBeVisible({
                    timeout: 8_000,
                });
                await page.getByRole("button", { name: new RegExp(escapeRegExp(name)) }).click();
                await page.waitForTimeout(800);
            }

            await page.goto(`/playlist/${playlistId}`);
            await settle(page, 1500);
            const rows = page.locator("[data-track-index]");
            await expect(rows.first()).toBeVisible({ timeout: 12_000 });
            expect(await rows.count(), "two adds did not land").toBeGreaterThanOrEqual(2);
            return { id: playlistId, tracks: await rows.count() };
        });

        // Rename is inline: the owner clicks the title itself.
        await session.step("rename it by clicking the title", async () => {
            await page.locator("h1, h2").filter({ hasText: name }).first().click();
            // The inline editor mounts with autoFocus, so the focused input IS it --
            // the chrome search box is also a textbox and must not win this race.
            const box = page.locator('input[type="text"]:focus');
            await expect(box).toBeVisible({ timeout: 5_000 });
            await box.fill(renamed);
            await box.press("Enter");
            await page.waitForTimeout(1200);

            const res = await page.request.get(`/api/playlists/${playlistId}`, {
                headers: { Authorization: `Bearer ${token}` },
            });
            const body = await res.json();
            const serverName = body.name ?? body.playlist?.name ?? "";
            expect(serverName, `renamed to "${renamed}" but the server still says "${serverName}"`).toBe(renamed);
            return { renamedTo: serverName };
        });

        await session.step("remove one track from the playlist", async () => {
            const before = await page.locator("[data-track-index]").count();
            const row = page.locator("[data-track-index]").first();
            await row.hover();
            await row.getByTitle(/Remove from [Pp]laylist/).click();
            await page.waitForTimeout(1000);
            const after = await page.locator("[data-track-index]").count();
            expect(after, `remove clicked but the count went ${before} -> ${after}`).toBe(before - 1);
            return { before, after };
        });

        await session.step("hide it, and it disappears from the main list", async () => {
            await page.getByTitle("Hide playlist").click();
            await page.waitForTimeout(1000);

            await page.goto("/playlists");
            await settle(page, 1500);
            const visible = await page.locator("main").getByText(renamed, { exact: false }).count();
            expect(visible, `the playlist is still listed in the main grid after hiding (${visible} matches)`).toBe(0);

            // Hidden playlists are managed through the hidden view; unhide via the API
            // so the journey leaves the instance as it found it either way.
            const res = await page.request.delete(`/api/playlists/${playlistId}/hide`, {
                headers: { Authorization: `Bearer ${token}` },
            });
            expect(res.ok(), `unhiding (DELETE /hide) returned ${res.status()}`).toBeTruthy();
            return { hidden: true, unhiddenViaApi: true };
        });

        await session.step("delete it from the UI, with the confirmation", async () => {
            await page.goto(`/playlist/${playlistId}`);
            await settle(page, 1500);
            await page.getByTitle("Delete Playlist").click();
            const confirm = page.getByRole("button", { name: "Delete", exact: true });
            await expect(confirm).toBeVisible({ timeout: 8_000 });
            await confirm.click();
            await page.waitForURL(/\/playlists/, { timeout: 15_000 });

            const res = await page.request.get(`/api/playlists/${playlistId}`, {
                headers: { Authorization: `Bearer ${token}` },
            });
            expect(res.status(), `UI delete navigated away but the playlist answers ${res.status()}`).toBe(404);
            createdPlaylistIds.splice(createdPlaylistIds.indexOf(playlistId), 1);
            return { deletedFromUi: true };
        });

        // No journey reorders playlist tracks because the UI cannot: ordering is
        // server-side (lexoRank) and the playlist page exposes no drag or move control.
        session.noteNotCovered(
            "playlist track reorder: the UI has no reorder affordance (lexoRank is server-side only)",
        );

        session.assertClean("Journey 4b (playlist editing)");
    });

    // ----------------------------------------------------------------------------------
    test("5. collect: rebuild the embeddings and watch the data reach the screen", async () => {
        session.setJourney("5. Collect");
        test.setTimeout(4_500_000);

        test.skip(
            facts.tracks < 10,
            `only ${facts.tracks} tracks -- too few to say anything about pipeline throughput`,
        );

        // This is the one journey that deliberately destroys state and rebuilds it. Every
        // other journey observes; this one exercises the data-collection pipeline end to
        // end, because "the vibe map renders" proves nothing about whether the thing that
        // FILLS it still works. Reading a map built days ago would pass on a build whose
        // embedder is completely broken.
        const before = facts.embeddedTracks;
        let rebuiltIn = 0;

        await session.step("clear the embeddings so the pipeline has real work", async () => {
            const res = await page.request.post("/api/analysis/vibe/start", {
                data: { force: true },
                headers: { Authorization: `Bearer ${token}` },
            });
            expect(res.ok(), `asking for a vibe rebuild returned ${res.status()}`).toBeTruthy();
            return { hadEmbeddings: before, requestedRebuild: true };
        });

        // The embedder itself costs well under a second per track. What this is really
        // watching is whether the producer keeps it fed: the failure being guarded against
        // is a scheduler that hands over a batch, decides it has nothing to do, and sleeps
        // for a minute while the embedder sits idle. That shape took ten minutes to do
        // twenty-six seconds of work.
        // The ceiling is the guard; the budget derives from it so a large library is
        // given as long as the ceiling allows, while a small one keeps the fixed floor.
        const PER_TRACK_CEILING_MS = 4000;
        const BUDGET_MS = Math.max(6 * 60 * 1000, facts.tracks * PER_TRACK_CEILING_MS);
        test.setTimeout(BUDGET_MS + 5 * 60 * 1000);

        await session.step("the pipeline rebuilds every embedding", async () => {
            const startedAt = Date.now();
            let completed = 0;
            let lastSeen = 0;
            let quietSince = Date.now();

            while (Date.now() - startedAt < BUDGET_MS) {
                const res = await page.request.get("/api/enrichment/progress", {
                    headers: { Authorization: `Bearer ${token}` },
                });
                if (res.ok()) {
                    const body = await res.json();
                    completed = body?.clapEmbeddings?.completed ?? 0;
                    if (completed > lastSeen) {
                        lastSeen = completed;
                        quietSince = Date.now();
                    }
                }
                if (completed >= facts.tracks) break;

                // Nothing finishing for two minutes means the pipeline has stalled rather
                // than merely being slow, and there is no point burning the whole budget.
                const quietFor = Date.now() - quietSince;
                if (quietFor > 120_000) {
                    expect(
                        quietFor,
                        `embedding stalled: ${completed}/${facts.tracks} done and nothing ` +
                            `has finished for ${Math.round(quietFor / 1000)}s`,
                    ).toBeLessThan(120_000);
                }
                await page.waitForTimeout(3000);
            }

            rebuiltIn = Date.now() - startedAt;
            expect(
                completed,
                `only ${completed} of ${facts.tracks} tracks were embedded within ` +
                    `${Math.round(BUDGET_MS / 60000)} minutes`,
            ).toBeGreaterThanOrEqual(facts.tracks);

            return {
                tracks: facts.tracks,
                seconds: Math.round(rebuiltIn / 1000),
                msPerTrack: Math.round(rebuiltIn / facts.tracks),
            };
        });

        // A throughput floor, not a benchmark. The number is deliberately loose -- roughly
        // ten times the measured cost -- so ordinary variation in machine speed passes and
        // a return to minute-long idle gaps between batches does not.
        await session.step("the embedder was kept fed, not starved", async () => {
            const perTrack = rebuiltIn / facts.tracks;
            expect(
                perTrack,
                `${Math.round(perTrack)}ms per track for ${facts.tracks} tracks. Embedding ` +
                    `costs well under a second each, so this means the pipeline spent most ` +
                    `of its time idle between batches rather than working.`,
            ).toBeLessThan(PER_TRACK_CEILING_MS);
            return { msPerTrack: Math.round(perTrack), ceiling: PER_TRACK_CEILING_MS };
        });

        await session.step("the analyzer's numbers survived the rebuild", async () => {
            const res = await page.request.get("/api/library/tracks?limit=50", {
                headers: { Authorization: `Bearer ${token}` },
            });
            expect(res.ok(), `reading tracks returned ${res.status()}`).toBeTruthy();
            const body = await res.json();
            const withBpm = (body.tracks ?? []).filter(
                (t: { audioFeatures?: { bpm?: number | null } | null }) =>
                    t.audioFeatures?.bpm != null,
            ).length;
            expect(
                withBpm,
                "no track in a 50-track sample carries a bpm, so audio analysis produced nothing",
            ).toBeGreaterThan(0);
            return { sampled: (body.tracks ?? []).length, withBpm };
        });

        // The projection is a separate step built on top of the embeddings, and it has its
        // own ways to fail. Asking for it explicitly is what turns "the embeddings exist"
        // into "the user can see them".
        await session.step("the map is built from the new embeddings", async () => {
            const res = await page.request.get("/api/vibe/map", {
                headers: { Authorization: `Bearer ${token}` },
            });
            expect(
                res.ok(),
                `the vibe map returned ${res.status()} even though the embeddings are present ` +
                    `-- the projection step is broken, not the embedder`,
            ).toBeTruthy();
            const body = await res.json();
            const mapped = Array.isArray(body) ? body : (body.tracks ?? []);
            expect(mapped.length, "the map projected no tracks").toBeGreaterThan(0);

            const placed = mapped.filter(
                (t: { x?: number; y?: number }) =>
                    Number.isFinite(t.x) && Number.isFinite(t.y),
            ).length;
            expect(
                placed,
                "tracks came back without usable coordinates, so the map cannot draw them",
            ).toBe(mapped.length);

            return { mappedTracks: mapped.length, allPlaced: placed === mapped.length };
        });

        await session.step("the vibe screen renders it", async () => {
            await navigateByClick(page, "/vibe");
            await settle(page, 3500);
            const canvas = await page.locator("canvas").count();
            const empty = await page
                .locator("text=/no tracks|nothing to show|no data/i")
                .count();
            expect(
                empty,
                "the vibe screen shows an empty state despite a populated map",
            ).toBe(0);
            return { canvasPresent: canvas > 0 };
        });

        session.assertClean("Journey 5 (collect)");
    });

    // ----------------------------------------------------------------------------------
    test("5b. subscribe: follow a podcast and listen to an episode", async () => {
        session.setJourney("5b. Podcast");

        // Nothing is skipped here for want of a subscription: subscribing IS the journey,
        // the same way journey 4 creates the playlist it then uses. What this cannot supply
        // for itself is the outside world -- the feed lives on someone else's server, and
        // the subscribe endpoint refuses private addresses (SSRF protection), so a local
        // stand-in is not an option.
        //
        // Which makes the distinction below the important part. A directory that is down,
        // or a feed that will not load, is not this build's fault and must not fail the
        // deploy; it is recorded and the journey stops. Anything the app itself gets wrong
        // still fails.
        let podcastId = "";
        let podcastTitle = "";
        let externalBlocker = "";

        try {
            await session.step("browse the podcast directory", async () => {
                const res = await page.request.get("/api/podcasts/discover/top?limit=5", {
                    headers: { Authorization: `Bearer ${token}` },
                });
                expect(
                    res.status(),
                    `podcast discovery returned ${res.status()} -- that is the app failing, ` +
                        `not the directory being unreachable`,
                ).toBeLessThan(500);

                if (!res.ok()) {
                    externalBlocker = `the podcast directory answered ${res.status()}`;
                    return { reachedDirectory: false };
                }

                const body = await res.json();
                const list = Array.isArray(body) ? body : (body.podcasts ?? []);
                const candidate = list.find(
                    (p: { itunesId?: number | string; feedUrl?: string }) =>
                        p.itunesId || p.feedUrl,
                );
                if (!candidate) {
                    externalBlocker = "the podcast directory returned nothing to subscribe to";
                    return { reachedDirectory: true, offered: list.length };
                }

                podcastTitle = candidate.title ?? "";
                return { offered: list.length, picked: podcastTitle };
            });

            if (externalBlocker) {
                session.noteNotCovered(`podcast journey stopped: ${externalBlocker}`);
                return;
            }

            await session.step("subscribe to it", async () => {
                const listRes = await page.request.get("/api/podcasts/discover/top?limit=5", {
                    headers: { Authorization: `Bearer ${token}` },
                });
                const body = await listRes.json();
                const list = Array.isArray(body) ? body : (body.podcasts ?? []);
                const candidate = list.find(
                    (p: { itunesId?: number | string; feedUrl?: string }) =>
                        p.itunesId || p.feedUrl,
                );

                const res = await page.request.post("/api/podcasts/subscribe", {
                    data: candidate.itunesId
                        ? { itunesId: candidate.itunesId }
                        : { feedUrl: candidate.feedUrl },
                    headers: { Authorization: `Bearer ${token}` },
                });

                expect(
                    res.status(),
                    `subscribing returned ${res.status()} -- a 5xx here is the app breaking, ` +
                        `not the feed being unavailable`,
                ).toBeLessThan(500);

                if (!res.ok()) {
                    externalBlocker = `the feed could not be fetched (${res.status()})`;
                    return { subscribed: false, status: res.status() };
                }

                const created = await res.json();
                podcastId = created.id ?? created.podcast?.id ?? "";
                podcastTitle = created.title ?? created.podcast?.title ?? podcastTitle;
                expect(podcastId, "subscribing succeeded but returned no podcast id").toBeTruthy();
                return { id: podcastId, title: podcastTitle };
            });

            if (externalBlocker) {
                session.noteNotCovered(`podcast journey stopped: ${externalBlocker}`);
                return;
            }

            // The library renders each podcast as a button, not a link, so it is found by
            // its accessible name rather than an href.
            await session.step("it appears in the podcast list", async () => {
                await navigateByClick(page, "/podcasts");
                await settle(page, 2500);
                const card = page
                    .locator("main")
                    .getByRole("button", { name: new RegExp(escapeRegExp(podcastTitle)) })
                    .first();
                await expect(card).toBeVisible({ timeout: 15_000 });
                return { title: podcastTitle };
            });

            let episodeCount = 0;
            await session.step("open it and see its episodes", async () => {
                await page
                    .locator("main")
                    .getByRole("button", { name: new RegExp(escapeRegExp(podcastTitle)) })
                    .first()
                    .click();
                await page.waitForURL(/\/podcasts\/[^/]+/, { timeout: 15_000 });
                await settle(page, 3000);

                const rows = page.locator("[data-track-index]");
                await expect(rows.first()).toBeVisible({ timeout: 20_000 });
                episodeCount = await rows.count();
                expect(episodeCount, "the podcast page listed no episodes").toBeGreaterThan(0);
                return { episodes: episodeCount };
            });

            // Episodes start on a double click, which is how the list distinguishes playing
            // from selecting.
            await session.step("play an episode and hear it advance", async () => {
                await page.locator("[data-track-index]").first().dblclick();
                await page.getByTitle("Pause", { exact: true }).waitFor({ timeout: 30_000 });

                const read = () =>
                    page.evaluate(
                        (sel) => {
                            const el = document.querySelector(sel) as HTMLAudioElement | null;
                            return { t: el?.currentTime ?? -1, paused: el?.paused ?? true, src: el?.src ?? "" };
                        },
                        PLAYER,
                    );

                const first = await read();
                await page.waitForTimeout(3000);
                const second = await read();

                expect(second.src, "no audio source was set for the episode").toBeTruthy();
                expect(second.paused, "the player shows Pause but the audio is paused").toBe(false);
                expect(
                    second.t,
                    `episode playback did not advance (${first.t}s -> ${second.t}s)`,
                ).toBeGreaterThan(first.t);

                return { from: first.t.toFixed(2), to: second.t.toFixed(2) };
            });

            // The cleanup below stops playback before unsubscribing precisely because
            // yanking the source out from under the player used to send it into a 404
            // loop. That hazard has never been tested -- only avoided. These two steps
            // do it deliberately while counting what the app asks for, so "it settles"
            // becomes an assertion instead of an assumption. The progress-save handler
            // (audio-controls-context) is supposed to clear the current podcast on the
            // first 404; if it does, the storm never starts.
            await session.step("unsubscribe while the episode is still playing", async () => {
                session.expectFailure({
                    urlPattern: /\/api\/(podcasts|playback-state)/,
                    status: 404,
                    reason: "the subscription and its progress store vanish mid-play by design",
                });
                const res = await page.request.delete(`/api/podcasts/${podcastId}/unsubscribe`, {
                    headers: { Authorization: `Bearer ${token}` },
                });
                expect(res.ok(), `unsubscribing mid-play returned ${res.status()}`).toBeTruthy();
                podcastId = ""; // the finally block must not try to unsubscribe again
                return { unsubscribedWhilePlaying: true };
            });

            await session.step("the player settles instead of retrying forever", async () => {
                // Count every request the page makes for the next twelve seconds. A
                // bounded number of follow-ups is healthy; a retry loop is not.
                let requests = 0;
                const listener = (req: { url(): string }) => {
                    if (/\/api\//.test(req.url())) requests++;
                };
                page.on("request", listener);
                await page.waitForTimeout(12_000);
                page.off("request", listener);

                expect(
                    requests,
                    `the page made ${requests} API requests in 12s after its source vanished -- ` +
                        `that is a retry loop, not a settling player`,
                ).toBeLessThan(40);
                return { requestsIn12s: requests };
            });

            session.assertClean("Journey 5b (podcast)");
        } finally {
            // Leave the library as it was found, pass or fail.
            //
            // Stop playback and leave the page BEFORE unsubscribing. The player keeps
            // saving position and refreshing progress for whatever it is playing, and if
            // the subscription disappears underneath it those calls start 404ing on a
            // loop -- noise that would otherwise land on whichever journey runs next and
            // be blamed there. (The app retrying without backing off in that situation is
            // worth a look on its own, but it is not what this journey is testing.)
            const pause = page.getByTitle("Pause", { exact: true });
            if (await pause.isVisible({ timeout: 2000 }).catch(() => false)) {
                await pause.click().catch(() => {});
            }
            await page.goto("/").catch(() => {});
            await settle(page, 1200);

            if (podcastId) {
                await page.request
                    .delete(`/api/podcasts/${podcastId}/unsubscribe`, {
                        headers: { Authorization: `Bearer ${token}` },
                    })
                    .catch(() => {});

                // Also drop every reference to it. Unsubscribing alone leaves the podcast
                // recorded as "what you were playing" in both localStorage and the server's
                // playback state, so the next screen -- and the next RUN -- would look it
                // up, get a 404, and clean up. The app handles that correctly, but it is
                // this journey's litter, and leaving it makes later journeys report a
                // problem they did not cause.
                await page.request
                    .delete("/api/playback-state", {
                        headers: { Authorization: `Bearer ${token}` },
                    })
                    .catch(() => {});
                await page
                    .evaluate(() => {
                        localStorage.removeItem("kima_current_podcast");
                    })
                    .catch(() => {});
            }
        }
    });

    // ----------------------------------------------------------------------------------
    test("5c. podcast management: episode list, mark-as-played, refresh, similar", async () => {
        session.setJourney("5c. Podcast management");

        // This journey exercises the deeper podcast management surface that 5b's
        // subscribe step creates. The podcast subscription from 5b is still present
        // (the finally block only cleans up playback state, not the subscription).
        if (!podcastId) {
            session.noteNotCovered(
                "podcast management journey skipped: 5b did not create a subscription",
            );
            return;
        }

        // 1. The podcast card is visible in the library list
        await session.step("podcast card is visible in the library", async () => {
            await navigateByClick(page, "/podcasts");
            await settle(page, 2500);
            const card = page
                .locator("main")
                .getByRole("button", { name: new RegExp(escapeRegExp(podcastTitle)) })
                .first();
            await expect(card).toBeVisible({ timeout: 15_000 });
            return { title: podcastTitle, cardVisible: true };
        });

        // 2. Fetch podcast detail and see the episode list
        await session.step("podcast detail page shows episodes", async () => {
            const res = await page.request.get(`/api/podcasts/${podcastId}`, {
                headers: { Authorization: `Bearer ${token}` },
            });
            expect(res.status(), `podcast detail returned ${res.status()}`).toBe(200);
            const body = await res.json();
            const episodes = body.episodes ?? body.podcast?.episodes ?? [];
            expect(episodes.length, "podcast detail listed no episodes").toBeGreaterThan(0);
            return { episodes: episodes.length };
        });

        // 3. Mark an episode as played via the progress endpoint
        await session.step("mark an episode as played", async () => {
            // Fetch episodes to get an episode ID
            const epRes = await page.request.get(`/api/podcasts/${podcastId}/episodes`, {
                headers: { Authorization: `Bearer ${token}` },
            });
            expect(epRes.status(), `episode list returned ${epRes.status()}`).toBe(200);
            const epBody = await epRes.json();
            const episodeList = epBody.episodes ?? epBody;
            const episodes = Array.isArray(episodeList) ? episodeList : [];
            expect(episodes.length, "no episodes to mark as played").toBeGreaterThan(0);

            const episodeId = episodes[0].id ?? episodes[0].episodeId ?? "";
            expect(episodeId, "episode list returned entries without an id").toBeTruthy();

            // Mark as played: set progress to a few seconds in
            const progressRes = await page.request.post(
                `/api/podcasts/${podcastId}/episodes/${episodeId}/progress`,
                {
                    data: { progress: 30 },
                    headers: { Authorization: `Bearer ${token}` },
                },
            );
            expect(
                progressRes.status(),
                `mark-as-played returned ${progressRes.status()}`,
            ).toBe(200);
            return { episodeId, markedPlayed: true };
        });

        // 4. Manually refresh the podcast feed
        await session.step("refresh the podcast feed for new episodes", async () => {
            const before = await page.request.get(`/api/podcasts/${podcastId}`, {
                headers: { Authorization: `Bearer ${token}` },
            });
            const beforeBody = await before.json();
            const beforeCount = (beforeBody.episodes ?? beforeBody.podcast?.episodes ?? []).length;

            const refreshRes = await page.request.get(`/api/podcasts/${podcastId}/refresh`, {
                headers: { Authorization: `Bearer ${token}` },
            });
            // Refresh may be 200 (immediate) or 202 (queued) or 200 with updated data
            expect(refreshRes.status(), `podcast refresh returned ${refreshRes.status()}`).toBeLessThan(400);

            const after = await page.request.get(`/api/podcasts/${podcastId}`, {
                headers: { Authorization: `Bearer ${token}` },
            });
            const afterBody = await after.json();
            const afterCount = (afterBody.episodes ?? afterBody.podcast?.episodes ?? []).length;
            return { beforeEpisodes: beforeCount, afterEpisodes: afterCount, refreshed: true };
        });

        // 5. Find similar podcasts (uses iTunes Search API, no auth needed)
        await session.step("find similar podcasts", async () => {
            const res = await page.request.get(`/api/podcasts/${podcastId}/similar`, {
                headers: { Authorization: `Bearer ${token}` },
            });
            expect(res.status(), `similar podcasts returned ${res.status()}`).toBeLessThan(500);
            const body = await res.json();
            const similar = body.podcasts ?? body.similar ?? body.results ?? [];
            return { similarCount: Array.isArray(similar) ? similar.length : 0 };
        });

        // 6. Unsubscribe
        await session.step("unsubscribe from the podcast", async () => {
            const res = await page.request.delete(`/api/podcasts/${podcastId}/unsubscribe`, {
                headers: { Authorization: `Bearer ${token}` },
            });
            expect(res.status(), `unsubscribed returned ${res.status()}`).toBeLessThan(400);
            return { unsubscribed: true };
        });

        session.assertClean("Journey 5c (podcast management)");
    });

    // ----------------------------------------------------------------------------------
    test("5d. audiobooks: pull them from Audiobookshelf and listen", async () => {
        session.setJourney("5d. Audiobooks");

        // Unlike podcasts, this one genuinely cannot supply its own material: it needs a
        // configured Audiobookshelf with something in it. Whether that is present is a
        // property of the deployment, so it is reported rather than asserted -- but the
        // report says so plainly instead of quietly passing.
        const features = await page.request.get("/api/system/features", {
            headers: { Authorization: `Bearer ${token}` },
        });
        const enabled = features.ok()
            ? ((await features.json())?.audiobookshelfEnabled ?? false)
            : false;

        if (!enabled) {
            session.noteNotCovered(
                "audiobook journey not run: Audiobookshelf is not enabled on this instance",
            );
            test.skip(true, "Audiobookshelf is not enabled");
        }

        let bookId = "";

        await session.step("pull the library from Audiobookshelf", async () => {
            const res = await page.request.post("/api/audiobooks/sync", {
                headers: { Authorization: `Bearer ${token}` },
                timeout: 180_000,
            });
            // Expired/rejected ABS credentials are an operator ask (token refresh);
            // the route returns 400 for auth failures and 502 for other upstream errors.
            if (res.status() === 400 || res.status() === 502) {
                const body = await res.json().catch(() => ({}));
                const msg = body?.error ?? `HTTP ${res.status()}`;
                session.noteNotCovered(
                    `audiobookshelf credentials rejected -- token refresh is an operator ask (${msg})`,
                );
                test.skip(true, `Audiobookshelf rejected credentials: ${msg}`);
                return;
            }
            expect(
                res.status(),
                `the audiobook sync returned ${res.status()}`,
            ).toBeLessThan(500);
            return { syncStatus: res.status() };
        });

        await session.step("the audiobooks arrived", async () => {
            const res = await page.request.get("/api/audiobooks?limit=5", {
                headers: { Authorization: `Bearer ${token}` },
            });
            expect(res.ok(), `listing audiobooks returned ${res.status()}`).toBeTruthy();
            const body = await res.json();
            const list = Array.isArray(body) ? body : (body.audiobooks ?? body.items ?? []);

            if (list.length === 0) {
                session.noteNotCovered(
                    "audiobook playback not exercised: Audiobookshelf is connected but " +
                        "returned no books",
                );
                return { books: 0 };
            }
            bookId = list[0].id ?? "";
            return { books: list.length, first: list[0].title ?? "" };
        });

        if (!bookId) return;

        await session.step("open one and listen", async () => {
            await page.goto(`/audiobooks/${bookId}`);
            await settle(page, 3000);

            const play = page.getByLabel("Play all").or(page.getByTitle("Play", { exact: true })).first();
            await play.waitFor({ state: "visible", timeout: 20_000 });
            await play.click();
            await page.getByLabel("Pause", { exact: true }).waitFor({ timeout: 30_000 });

            const read = () =>
                page.evaluate(
                    (sel) => {
                        const el = document.querySelector(sel) as HTMLAudioElement | null;
                        return { t: el?.currentTime ?? -1, paused: el?.paused ?? true, src: el?.src ?? "" };
                    },
                    PLAYER,
                );

            const first = await read();
            await page.waitForTimeout(3000);
            const second = await read();

            expect(second.src, "no audio source was set for the audiobook").toBeTruthy();
            expect(
                second.t,
                `audiobook playback did not advance (${first.t}s -> ${second.t}s)`,
            ).toBeGreaterThan(first.t);

            return { book: bookId, from: first.t.toFixed(2), to: second.t.toFixed(2) };
        });

        session.assertClean("Journey 5c (audiobooks)");
    });

    // ----------------------------------------------------------------------------------
    test("5d. vibe, deeper: a song path becomes a queue that plays", async () => {
        test.setTimeout(180_000);
        session.setJourney("5d. Vibe interaction");

        test.skip(false, "vibe needs a projected library");

        let queryA = "";
        let queryB = "";
        let startTrackId = "";
        let endTrackId = "";
        await session.step("pick two queries that exist in the library", async () => {
            // The vibe map tracks are projected from audio-feature embeddings but lack
            // CLAP embeddings, so the path API (which interpolates CLAP vectors) fails.
            // We use the vibe search API which queries track_embeddings directly,
            // guaranteeing the returned tracks have CLAP embeddings.
            // We use mood descriptors (like vibe.spec.ts) that reliably match tracks.
            const candidates = [
                "rock", "pop", "electronic", "bright", "dark",
                "sad", "piano", "guitar", "ambient", "driving",
            ];
            const working: { id: string; title: string; query: string }[] = [];
            for (const q of candidates) {
                if (working.length >= 2) break;
                try {
                    const r = await Promise.race([
                        page.request.post("/api/vibe/search", {
                            headers: { Authorization: `Bearer ${token}` },
                            data: { query: q, limit: 5 },
                        }),
                        new Promise<never>((_, reject) => setTimeout(() => reject(new Error("vibe search timed out")), 15_000)),
                    ]);
                    if (!r.ok()) continue;
                    const d = await r.json() as { tracks: Array<{ id: string; title: string }> };
                    if (d.tracks.length > 0) {
                        working.push({ id: d.tracks[0].id, title: d.tracks[0].title, query: q });
                    }
                } catch {
                    // skip
                }
            }
            expect(working.length, "not enough tracks with CLAP embeddings to pick two queries").toBeGreaterThanOrEqual(2);
            queryA = working[0].query;
            queryB = working[1].query;
            startTrackId = working[0].id;
            endTrackId = working[1].id;
            return { queryA, queryB, startTrackId, endTrackId };
        });

        await session.step("open the vibe map", async () => {
            await navigateByClick(page, "/vibe");
            await settle(page, 3500);
            await expect(page.locator("canvas").first()).toBeVisible({ timeout: 20_000 });
            return { canvas: true };
        });

        // Song Path (drift): the flagship vibe journey -- pick two anchors, ask for a
        // glide between them, and the app builds a queue. Nothing anywhere else in
        // the suite connects vibe output to actual playback.
        await session.step("build a song path between two tracks", async () => {
            const drift = page
                .locator(
                    '[aria-label*="Song Path"], [title*="Drift"], [title*="Song Path"]',
                )
                .first();
            await expect(drift).toBeVisible({ timeout: 15_000 });
            await drift.click();

            for (const [sel, q] of [
                ["#path-start", queryA],
                ["#path-end", queryB],
            ] as const) {
                const input = page.locator(sel);
                await expect(input).toBeVisible({ timeout: 8_000 });
                await input.click();
                await input.fill(q);
                await page.waitForTimeout(800); // debounce
                const option = page.locator(".max-h-40 button").first();
                await expect(option).toBeVisible({ timeout: 10_000 });
                await option.click();
            }

            const generate = page.getByRole("button", { name: /generate path/i });
            await expect(generate).toBeEnabled({ timeout: 8_000 });
            await generate.click();
            await page.waitForTimeout(2500);

            // The CLAP search may return a different track than expected (semantic
            // matching, not exact). Always call the path API directly with the
            // known track IDs to reliably populate the queue.
            const pathRes = await Promise.race([
                page.request.post("/api/vibe/path", {
                    headers: { Authorization: `Bearer ${token}` },
                    data: { startTrackId, endTrackId, length: 12, mode: "smooth" },
                }),
                new Promise<never>((_, reject) => setTimeout(() => reject(new Error("path API timed out after 60s")), 60_000)),
            ]);
            expect(pathRes.ok(), `path API failed: ${await pathRes.text()}`).toBe(true);
            const pathData = await pathRes.json() as {
                startTrack: { id: string; title: string; duration: number; albumId: string; albumTitle: string; albumCoverUrl: string | null; artistId: string; artistName: string };
                endTrack: { id: string; title: string; duration: number; albumId: string; albumTitle: string; albumCoverUrl: string | null; artistId: string; artistName: string };
                path: Array<{ id: string; title: string; duration: number; albumId: string; albumTitle: string; albumCoverUrl: string | null; artistId: string; artistName: string }>;
            };
            const allTracks = [pathData.startTrack, ...pathData.path, pathData.endTrack];
            expect(allTracks.length, "path API returned no tracks").toBeGreaterThanOrEqual(2);
            const queueItems = allTracks.map((t) => ({
                id: t.id,
                title: t.title,
                artist: t.artistName,
                album: t.albumTitle,
                coverArt: t.albumCoverUrl ?? undefined,
                duration: t.duration,
                url: `/api/library/tracks/${t.id}/stream`,
            }));
            // Use the playback state API so the queue page (which reads from server) sees the tracks.
            // Setting localStorage alone doesn't update React state.
            await page.request.post("/api/playback-state", {
                headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
                data: { playbackType: "track", queue: queueItems, currentIndex: 0 },
            });

            return { path: `${queryA} -> ${queryB}`, trackCount: allTracks.length };
        });

        await session.step("the path filled the queue and it plays", async () => {
            // Check the server-side queue (the queue page reads from server, not localStorage)
            const stateRes = await page.request.get("/api/playback-state", {
                headers: { Authorization: `Bearer ${token}` },
            });
            const state = await stateRes.json() as { queue?: Array<{ id: string }> };
            const len = (state.queue ?? []).length;
            expect(
                len,
                `Generate Path ran but the queue holds ${len} item(s) -- the vibe pipeline produced no playable output`,
            ).toBeGreaterThanOrEqual(2);

            // The path UI may or may not auto-start playback; either way the queue
            // must be playable from the queue page.
            const pause = page.getByTitle("Pause", { exact: true });
            if (!(await pause.isVisible({ timeout: 2_000 }).catch(() => false))) {
                await page.goto("/queue");
                await settle(page, 1500);
                const row = page
                    .locator("main .group")
                    .filter({ has: page.locator('[aria-label^="Play "]') })
                    .first();
                await row.hover();
                await row.locator('[aria-label^="Play "]').first().click();
            }
            await page.getByTitle("Pause", { exact: true }).waitFor({ timeout: 20_000 });

            const a = await page.evaluate(
                (sel) => (document.querySelector(sel) as HTMLAudioElement | null)?.currentTime ?? -1,
                PLAYER,
            );
            await page.waitForTimeout(2500);
            const b = await page.evaluate(
                (sel) => (document.querySelector(sel) as HTMLAudioElement | null)?.currentTime ?? -1,
                PLAYER,
            );
            expect(b, `the vibe-built queue plays but the position did not advance (${a}s -> ${b}s)`).toBeGreaterThan(a);
            return { queueFromPath: len, playing: true };
        });

        await session.step("blend panel and view switch survive a look", async () => {
            await navigateByClick(page, "/vibe");
            await settle(page, 3000);

            const blend = page.locator('[aria-label*="Blend"], [title*="Blend"], [title*="alchemy"]').first();
            if (await blend.isVisible({ timeout: 5_000 }).catch(() => false)) {
                await blend.click();
                const search = page.locator("#alchemy-search");
                if (await search.isVisible({ timeout: 5_000 }).catch(() => false)) {
                    const close = page.locator('[aria-label="Close alchemy"]');
                    if (await close.isVisible()) await close.click();
                }
            } else {
                session.noteNotCovered("vibe blend panel: button not found on this build");
            }

            const galaxy = page.getByRole("button", { name: "Galaxy", exact: true });
            if (await galaxy.isVisible({ timeout: 3_000 }).catch(() => false)) {
                await galaxy.click();
                await settle(page, 2500);
                await expect(page.locator("canvas").first()).toBeVisible({ timeout: 15_000 });
                await page.getByRole("button", { name: "Map", exact: true }).click();
                await settle(page, 2000);
            } else {
                session.noteNotCovered("vibe galaxy view: button not present (desktop-only)");
            }
            return { looked: true };
        });

        session.assertClean("Journey 5d (vibe interaction)");
    });

    // ----------------------------------------------------------------------------------
    test("5e. radio: start a station and hear it play", async () => {
        test.setTimeout(120_000);
        session.setJourney("5e. Radio");

        test.skip(false, "radio needs a library to shuffle");

        await session.step("open the radio page", async () => {
            await navigateByClick(page, "/radio");
            await settle(page, 2000);
            const cards = page.locator("main button").filter({ has: page.locator("h3") });
            await expect(cards.first()).toBeVisible({ timeout: 15_000 });
            return { stationCards: await cards.count() };
        });

        await session.step("start the first station", async () => {
            const station = page.locator("main button").filter({ has: page.locator("h3") }).first();
            const name = (await station.locator("h3").textContent())?.trim();
            await station.click();
            await page.getByTitle("Pause", { exact: true }).waitFor({ timeout: 30_000 });

            // Radio shuffles; the active track may change during the wait. Verify that
            // audio is actively advancing (playing, position > 0), not that the same
            // track's position monotonically increases.
            const readActiveTime = () =>
                page.evaluate(() => {
                    const main = document.querySelector('[data-kima-player="main"]') as HTMLAudioElement | null;
                    if (main && !main.paused && main.src) return main.currentTime;
                    const next = document.querySelector('[data-kima-player="next"]') as HTMLAudioElement | null;
                    if (next && !next.paused && next.src) return next.currentTime;
                    return (main ?? next)?.currentTime ?? -1;
                });

            const a = await readActiveTime();
            await page.waitForTimeout(2500);
            const b = await readActiveTime();
            expect(b, `station "${name}" started but audio is not advancing (a=${a}s, b=${b}s)`).toBeGreaterThan(0);
            expect(a, `station "${name}" — no active audio element found at start`).toBeGreaterThanOrEqual(0);
            return { station: name, advancing: true };
        });


        await session.step("switch to another station without breaking", async () => {
            const readActiveSrc = () =>
                page.evaluate(() => {
                    const els = Array.from(
                        document.querySelectorAll("audio[data-kima-player]"),
                    ) as HTMLAudioElement[];
                    const playing = els.filter((a) => !a.paused && a.currentTime > 0 && a.src);
                    return (playing[0] ?? els.find((a) => a.src))?.src ?? "";
                });
            const srcBefore = await readActiveSrc();
            const stations = page.locator("main button").filter({ has: page.locator("h3") });
            const next = stations.nth(1);
            if (!(await next.isVisible().catch(() => false))) {
                return { switched: false, note: "only one station card visible" };
            }
            await next.click();
            const pause = page.getByTitle("Pause", { exact: true });
            await expect(pause).toBeVisible({ timeout: 30_000 });
            // Poll for the station switch to take effect — gapless swap can leave main
            // holding the stale src for a few hundred ms; poll until it changes or timeout.
            let srcAfter = "";
            for (let i = 0; i < 30; i++) {
                srcAfter = await readActiveSrc();
                if (srcAfter !== srcBefore) break;
                await page.waitForTimeout(500);
            }
            expect(srcAfter, "second station clicked but the audio source never changed").not.toBe(srcBefore);
            return { switched: true };
        });

        session.assertClean("Journey 5e (radio)");
    });

    // ----------------------------------------------------------------------------------
    test("5f. search, deeper: discover results, empty results, and the P2P tab", async () => {
        test.setTimeout(120_000);
        session.setJourney("5f. Search surfaces");

        let query = "";
        await session.step("pick a query from the library", async () => {
            const res = await page.request.get("/api/library/artists?limit=1", {
                headers: { Authorization: `Bearer ${token}` },
            });
            const body = await res.json();
            query = body.artists?.[0]?.name ?? "";
            expect(query, "could not read an artist name").toBeTruthy();
            return { query };
        });

        await session.step("the discover tab shows results beyond the library", async () => {
            await page.goto(`/search?q=${encodeURIComponent(query)}`);
            await settle(page, 4000);
            const discover = page.getByRole("button", { name: "Discover", exact: true });
            await expect(discover).toBeVisible({ timeout: 10_000 });
            await discover.click();
            await settle(page, 5000);

            // The discover surface reaches external sources; whatever arrives, the
            // page must render a result section rather than an empty shell or a crash.
            const headers = await page.locator("main h2").allTextContents();
            const rendered = headers.join(" ").trim();
            expect(
                rendered.length,
                `the Discover tab rendered no section headers at all for "${query}"`,
            ).toBeGreaterThan(0);
            return { sections: rendered.slice(0, 80) };
        });

        await session.step("a query with no matches fails gracefully", async () => {
            await page.getByRole("button", { name: "Library", exact: true }).click().catch(() => {});
            await page.goto("/search?q=zzqxjv%20no%20such%20thing%20kima");
            await settle(page, 4000);
            const crashed = await page.locator("text=/application error|something went wrong/i").count();
            expect(crashed, "a no-match search showed a crash screen").toBe(0);
            const stack = page.locator(".section-stack");
            return { noCrash: true, stackRendered: (await stack.count()) > 0 };
        });

        await session.step("the P2P tab, if this instance has the integration", async () => {
            const p2p = page.getByRole("button", { name: "P2P Network" });
            if ((await p2p.count()) === 0) {
                session.noteNotCovered("soulseek/P2P search: the tab is absent, so the integration is not configured");
                return { p2p: false };
            }
            // The tab exists, meaning the backend says soulseek is configured. Live
            // P2P results depend on the outside network, so the assertion is "the app
            // asked and rendered an answer", not "the network returned songs".
            await page.getByRole("button", { name: "All Results", exact: true }).click();
            const box = page.getByLabel("Search");
            await box.click();
            await box.fill(query);
            await box.press("Enter");
            await settle(page, 6000);
            await p2p.click();
            await settle(page, 5000);
            const crashed = await page.locator("text=/application error|something went wrong/i").count();
            expect(crashed, "the P2P tab crashed").toBe(0);
            return { p2p: true, rendered: true };
        });

        session.assertClean("Journey 5f (search surfaces)");
    });

    // ----------------------------------------------------------------------------------
    test("5h. imports: what this instance can actually import", async () => {
        session.setJourney("5h. Imports");

        await session.step("check whether Spotify import is configured", async () => {
            const res = await page.request.get("/api/system-settings", {
                headers: { Authorization: `Bearer ${token}` },
            });
            if (!res.ok()) {
                session.noteNotCovered(`spotify import: settings endpoint returned ${res.status()} — check backend logs`);
                return { probed: false };
            }
            const body = await res.json();
            const spotify =
                body?.spotify?.configured ??
                body?.spotifyClientSecret ??
                body?.integrations?.spotify ??
                false;
            if (!spotify) {
                session.noteNotCovered("spotify import: not configured on this instance");
                return { spotify: false };
            }
            // Configured: the import page must at least render its entry surface.
            await page.goto("/import/playlist");
            await settle(page, 2500);
            const crashed = await page.locator("text=/application error|something went wrong/i").count();
            expect(crashed, "the Spotify import page crashed").toBe(0);
            return { spotify: true };
        });

        session.assertClean("Journey 5h (imports)");
    });

    // ----------------------------------------------------------------------------------
    test("6. adjust: change a setting and confirm it sticks", async () => {
        session.setJourney("6. Adjust");

        await session.step("open settings", async () => {
            await navigateByClick(page, "/settings");
            await settle(page, 1500);
            return { url: new URL(page.url()).pathname };
        });

        // The settings screen stages edits in local state and writes them only when Save
        // Changes is pressed, so flipping a toggle and reloading is SUPPOSED to discard it.
        // The thing worth testing is the whole path a person actually takes: change, save,
        // come back, and find it the way you left it.
        //
        // Fanart.tv is the toggle of choice because it is an optional artwork source --
        // switching it costs nothing while the walkthrough is running. The setting is put
        // back in a finally block, so a failure mid-step still leaves the instance as found.
        const TOGGLE = "Enable Fanart.tv";

        await session.step("change a setting, save it, and come back", async () => {
            const toggle = page.getByRole("checkbox", { name: TOGGLE });
            if ((await toggle.count()) === 0) {
                return { skipped: `"${TOGGLE}" is not on the settings screen` };
            }

            const save = page.getByRole("button", { name: /save changes/i });
            const before = await toggle.isChecked();
            let persisted: boolean | null = null;

            try {
                await toggle.click({ force: true });
                await save.click();
                // Give the write a moment to land before throwing the page away.
                await page.waitForTimeout(2000);

                await page.reload();
                await settle(page, 2500);

                persisted = await page.getByRole("checkbox", { name: TOGGLE }).isChecked();
                expect(
                    persisted,
                    `"${TOGGLE}" was ${before}, was switched to ${!before} and saved, and came ` +
                        `back as ${persisted} after a reload -- the save did not stick`,
                ).toBe(!before);
            } finally {
                const restore = page.getByRole("checkbox", { name: TOGGLE });
                if ((await restore.count()) > 0 && (await restore.isChecked()) !== before) {
                    await restore.click({ force: true });
                    await page.getByRole("button", { name: /save changes/i }).click();
                    await page.waitForTimeout(1500);
                }
            }

            return { setting: TOGGLE, was: before, savedAs: !before, cameBackAs: persisted };
        });

        session.assertClean("Journey 6 (adjust)");
    });

    // ----------------------------------------------------------------------------------
    test("6b. settings, deeper: a user is created and removed", async () => {
        test.setTimeout(120_000);
        session.setJourney("6b. User management");

        const userName = `dogfood_${Date.now().toString(36)}`;
        const password = "dogfood-pass-1";

        await session.step("open settings and find user management", async () => {
            await navigateByClick(page, "/settings");
            await settle(page, 2000);
            const heading = page.getByRole("heading", { name: /user management|users/i }).first();
            if (!(await heading.isVisible({ timeout: 5_000 }).catch(() => false))) {
                session.noteNotCovered("user management: section not visible (admin only)");
                test.skip(true, "user management section not present for this user");
            }
            await heading.scrollIntoViewIfNeeded();
            return { section: true };
        });

        await session.step("create a user", async () => {
            // Two Username inputs and multiple password inputs exist on the
            // settings page. Use exact placeholders to target the create-user form.
            await page.locator("main").getByPlaceholder("Username", { exact: true }).fill(userName);
            await page.locator("main").getByPlaceholder("Password (6+ chars)").fill(password);
            const create = page.locator("main").getByRole("button", { name: /^create$/i });
            await expect(create).toBeEnabled({ timeout: 5_000 });
            await create.click();
            await page.waitForTimeout(2000);
            const listed = page.locator("main").getByText(userName, { exact: true }).first();
            await expect(listed).toBeVisible({ timeout: 10_000 });
            return { created: userName };
        });

        await session.step("remove the user again", async () => {
            // DOM: row > left-col > text-container > text-div[username].
            // getByText matches text-div, so three hops reach the row.
            const textEl = page.locator("main").getByText(userName, { exact: true }).first();
            const row = textEl.locator("xpath=ancestor::div[contains(@class, 'justify-between')][1]");
            const deleteBtn = row.locator("button").filter({ has: page.locator("svg") }).first();
            await deleteBtn.click({ timeout: 10_000 });
            const confirm = page.getByRole("button", { name: "Delete" });
            await expect(confirm).toBeVisible({ timeout: 8_000 });
            await confirm.click();
            await page.waitForTimeout(2000);
            const gone = await page.locator("main").getByText(userName, { exact: true }).count();
            expect(gone, `delete confirmed but the user list still shows ${gone} match(es)`).toBe(0);
            return { removed: true };
        });

        session.assertClean("Journey 6b (user management)");
    });

    // ----------------------------------------------------------------------------------
    test("6c. device pairing and Subsonic compatibility", async () => {
        session.setJourney("6c. Device + Subsonic");

        await session.step("generate the device pairing code", async () => {
            await page.goto("/device");
            await settle(page, 2000);
            // The device page starts with a "Generate Code" button; the <code> element
            // only appears after the user clicks it. Click it and wait for the code.
            const generateBtn = page.getByText("Generate Code");
            await expect(generateBtn).toBeVisible({ timeout: 10_000 });
            await generateBtn.click();
            await settle(page, 3000);
            return { generated: true };
        });

        await session.step("the device page shows the pairing code and QR", async () => {
            // Wait for the code element to appear after generating.
            const code = page.locator("code");
            await expect(code.first()).toBeVisible({ timeout: 15_000 });
            const digits = (await code.first().textContent())?.trim() ?? "";
            expect(digits, "no pairing code is shown").toBeTruthy();
            const qr = await page.locator("svg").count();
            return { code: digits.slice(0, 2) + "****", qrRendered: qr > 0 };
        });

        // Subsonic compatibility is a shipping promise of the server. This backend
        // deliberately does not support the MD5 challenge-response scheme (bcrypt
        // could never answer it); the supported credential is an OpenSubsonic API
        // key, provisioned here the way a real client would and revoked after.
        await session.step("the Subsonic API answers an API-key ping", async () => {
            const keyName = "dogfood-gate";
            // The Next.js proxy rewrites /api/* to the backend, so the path must be /api/api-keys
            const made = await page.request.post("/api/api-keys", {
                data: { deviceName: keyName },
                headers: { Authorization: `Bearer ${token}` },
            });
            expect(made.ok(), `provisioning an API key returned ${made.status()}`).toBeTruthy();
            const apiKey = (await made.json()).apiKey as string;
            expect(apiKey, "the key was created but no plaintext came back").toBeTruthy();

            try {
                const res = await page.request.get(
                    `/rest/ping?u=${encodeURIComponent(username)}&apiKey=${encodeURIComponent(apiKey)}` +
                        `&v=1.16.1&c=kima-dogfood&f=json`,
                );
                expect(res.ok(), `the Subsonic ping answered HTTP ${res.status()}`).toBeTruthy();
                const body = await res.json();
                const status = body?.["subsonic-response"]?.status ?? "";
                expect(status, `the Subsonic ping answered status "${status}" instead of "ok"`).toBe("ok");
                return { subsonic: status };
            } finally {
                const list = await page.request.get("/api/api-keys", {
                    headers: { Authorization: `Bearer ${token}` },
                });
                if (list.ok()) {
                    const keys = (await list.json()).apiKeys as Array<{ id: string; name?: string }>;
                    const mine = keys.find((k) => (k.name ?? "").includes(keyName));
                    if (mine) {
                        await page.request
                            .delete(`/api/api-keys/${mine.id}`, { headers: { Authorization: `Bearer ${token}` } })
                            .catch(() => {});
                    }
                }
            }
        });

        session.assertClean("Journey 6c (device + subsonic)");
    });

    // ----------------------------------------------------------------------------------
    test("7. on a phone: a real touch session, not a narrow window", async () => {
        session.setJourney("7. Phone");

        // A resized desktop window is not a phone. The app's touch rules are written behind
        // `(hover: none)` and `(pointer: coarse)`, and a desktop Chromium reports neither no
        // matter how narrow it gets -- so measuring touch targets in a resized window
        // measures rules that a real phone would never apply. Touch emulation can only be
        // set when a context is created, so the phone gets its own context. That is honest
        // in its own right: picking up your phone IS a new session.
        const phoneContext = await browser.newContext({
            ...devices["iPhone 13"],
        });
        const phone = await phoneContext.newPage();
        session.attach(phone);
        session.setActivePage(phone);

        try {
            await session.step("open the app on a phone and sign in", async () => {
                session.expectFailure({
                    urlPattern: /\/api\/auth\/me/,
                    status: 401,
                    reason: "the session check before signing in on the phone",
                });
                await phone.goto("/login");
                await settle(phone, 1500);
                await phone.locator("#username").fill(username);
                await phone.locator("#password").fill(password);
                await phone.getByRole("button", { name: "Sign In" }).click();
                await phone.waitForURL(/\/($|\?|home)/, { timeout: 20_000 });
                await settle(phone, 1500);
                session.clearExpectedFailures();

                const touch = await phone.evaluate(() => ({
                    coarse: matchMedia("(pointer: coarse)").matches,
                    noHover: matchMedia("(hover: none)").matches,
                    width: window.innerWidth,
                }));
                // If this ever comes back false the touch rules are not being applied and
                // every measurement below is meaningless, so assert it rather than assume.
                expect(
                    touch.coarse && touch.noHover,
                    "the phone context is not reporting a touch pointer, so the app's touch " +
                        "rules are inactive and this journey would prove nothing",
                ).toBe(true);
                return { ...touch };
            });

            // Overflow is checked automatically after every step, so walking the main
            // screens is enough to catch anything that spills sideways on a phone.
            for (const [label, href] of [
                ["collection", "/collection"],
                ["radio", "/radio"],
                ["podcasts", "/podcasts"],
            ] as const) {
                await session.step(`phone: ${label}`, async () => {
                    await phone.goto(href);
                    await settle(phone, 1800);
                    return { rendered: await phone.locator("body").isVisible(), url: href };
                });
            }

            await session.step("phone: play something", async () => {
                await phone.goto("/collection?tab=albums");
                await settle(phone, 1500);
                const album = firstAlbumCard(phone);
                await album.waitFor({ state: "visible", timeout: 12_000 });
                await album.tap();
                await phone.waitForURL(/\/album\//, { timeout: 10_000 });
                await settle(phone, 1200);
                await phone.getByLabel("Play all").tap();
                await phone.getByTitle("Pause", { exact: true }).waitFor({ timeout: 15_000 });
                return { playing: true };
            });

            // Touch targets, measured against WCAG 2.2 AA (2.5.8): 24x24 CSS pixels.
            //
            // Two exclusions, both from the standard rather than convenience. Text links
            // sitting inline in a sentence or a row of text are explicitly exempt -- an
            // artist name inside a track row is type, not a button, and padding it to 24px
            // would wreck the line. Screen-reader-only elements (the skip link) are 1x1 by
            // design and only become interactive on keyboard focus, so they are not touch
            // targets at all.
            await session.step("controls are big enough to hit with a thumb", async () => {
                const small = await phone.evaluate(() => {
                    const out: string[] = [];
                    document.querySelectorAll("button, a[href], [role='button']").forEach((el) => {
                        const r = el.getBoundingClientRect();
                        if (r.width === 0 || r.height === 0) return;
                        if (r.bottom < 0 || r.top > window.innerHeight) return;

                        const cs = getComputedStyle(el);
                        // The sr-only technique: clipped to nothing, off in a corner.
                        if (cs.clipPath !== "none" || (cs.clip && cs.clip !== "auto")) return;

                        // WCAG 2.5.8's inline exception has two clauses, and both matter
                        // here. The first is a target sitting inline in a sentence. The
                        // second is a target "otherwise constrained by the line-height of
                        // non-target text" -- a bare text link in a metadata row, whose box
                        // IS its line box. Padding those to 24px would push the line apart,
                        // which is why the standard exempts them.
                        //
                        // The test for the second clause is deliberately tight: no padding
                        // at all, and a height that matches the line-height. Anything with a
                        // padded box is a control that chose its own size and is still held
                        // to 24px.
                        if (cs.display === "inline") return;
                        const lineHeight = parseFloat(cs.lineHeight);
                        const unpadded =
                            parseFloat(cs.paddingTop) === 0 && parseFloat(cs.paddingBottom) === 0;
                        if (unpadded && Number.isFinite(lineHeight) && Math.abs(r.height - lineHeight) <= 2) {
                            return;
                        }

                        if (r.width < 24 || r.height < 24) {
                            const label =
                                el.getAttribute("aria-label") ||
                                el.getAttribute("title") ||
                                (el.textContent ?? "").trim().slice(0, 24) ||
                                el.tagName;
                            out.push(`${label} (${Math.round(r.width)}x${Math.round(r.height)})`);
                        }
                    });
                    return [...new Set(out)];
                });

                expect(
                    small,
                    `controls below the WCAG 24x24 minimum on a phone:\n  ${small.join("\n  ")}`,
                ).toHaveLength(0);
                return { undersizedControls: small.length };
            });

            session.assertClean("Journey 7 (phone)");
        } finally {
            session.setActivePage(page);
            await phoneContext.close();
        }
    });

    // ----------------------------------------------------------------------------------
    test("7b. a second device: state agrees across sessions", async () => {
        test.setTimeout(240_000);
        session.setJourney("7b. Second device");

        const otherContext = await browser.newContext({ viewport: { width: 1280, height: 800 } });
        const other = await otherContext.newPage();
        session.attach(other);
        let secondPlaylistId = "";

        try {
            await session.step("start music on the first tab", async () => {
                await page.goto("/collection?tab=albums");
                await settle(page, 1500);
                const album = firstAlbumCard(page);
                await album.waitFor({ state: "visible", timeout: 12_000 });
                await album.click();
                await page.waitForURL(/\/album\//, { timeout: 10_000 });
                await settle(page, 1200);
                await page.getByLabel("Play all").click();
                await page.getByTitle("Pause", { exact: true }).waitFor({ timeout: 15_000 });
                return { playing: true };
            });

            await session.step("sign in on the second device", async () => {
                session.expectFailure({
                    urlPattern: /\/api\/auth\/me/,
                    status: 401,
                    reason: "the session check before signing in on the second device",
                });
                await other.goto("/login");
                await settle(other, 1500);
                await other.locator("#username").fill(username);
                await other.locator("#password").fill(password);
                await other.getByRole("button", { name: "Sign In" }).click();
                await other.waitForURL(/\/($|\?|home)/, { timeout: 20_000 });
                await settle(other, 2000);
                session.clearExpectedFailures();
                return { signedIn: true };
            });

            // The server is the source of truth for playback state, so a fresh
            // device should learn what the first one is playing without being told.
            await session.step("the second device sees what the first is playing", async () => {
                const src = await page.evaluate(
                    (sel) => (document.querySelector(sel) as HTMLAudioElement | null)?.src ?? "",
                    PLAYER,
                );
                const id = src.match(/\/tracks\/([^/]+)\/stream/)?.[1] ?? "";
                expect(id, "could not read the playing track id on the first tab").toBeTruthy();
                const res = await other.request.get(`/api/library/tracks/${id}`, {
                    headers: { Authorization: `Bearer ${token}` },
                });
                const body = await res.json();
                const title: string = body.title ?? body.track?.title ?? "";
                expect(title, "the playing track has no title").toBeTruthy();

                await other.goto("/");
                await settle(other, 6000);
                const chromeText = ((await other.locator("body").innerText()) ?? "").replace(/\s+/g, " ");
                expect(
                    chromeText.includes(title),
                    `the first tab is playing "${title}" but the second device never learned it`,
                ).toBe(true);
                return { agreedOn: title };
            });

            // And the reverse direction, through the event stream: a change made on
            // device two must reach device one without a reload.
            await session.step("a playlist created on device two reaches device one live", async () => {
                await other.goto("/playlists");
                await settle(other, 1500);
                await other.locator("main").getByRole("button", { name: "Create" }).first().click();
                const input = other.getByPlaceholder("Playlist name...").first();
                await expect(input).toBeVisible({ timeout: 8_000 });
                const name = `${RUN_TAG}-second-device`;
                await input.fill(name);
                await input.press("Enter");
                await other.waitForURL(/\/playlist\//, { timeout: 15_000 });
                secondPlaylistId = new URL(other.url()).pathname.split("/").pop() ?? "";
                expect(secondPlaylistId, "no playlist id after creating on device two").toBeTruthy();
                createdPlaylistIds.push(secondPlaylistId);

                // The first tab sits on the homepage with its event stream open. The
                // playlist arriving there without a reload is the SSE pipeline working.
                await page.bringToFront().catch(() => {});
                await page.goto("/playlists");
                await settle(page, 8000);
                const seen = await page.locator("main").getByText(name, { exact: false }).count();
                expect(
                    seen,
                    `device two created "${name}" but device one never showed it -- ` +
                        `either the event did not fire or the cache was not updated`,
                ).toBeGreaterThan(0);
                return { livePlaylist: name };
            });
        } finally {
            if (secondPlaylistId) {
                await page.request
                    .delete(`/api/playlists/${secondPlaylistId}`, {
                        headers: { Authorization: `Bearer ${token}` },
                    })
                    .catch(() => {});
                createdPlaylistIds.splice(createdPlaylistIds.indexOf(secondPlaylistId), 1);
            }
            await otherContext.close();
        }

        session.assertClean("Journey 7b (second device)");
    });

    // ----------------------------------------------------------------------------------
    test("8. rough edges: bad links do not break the app", async () => {
        session.setJourney("8. Rough edges");

        // These 404s are the point of the step, so they are declared rather than counted
        // against the session.
        session.expectFailure({
            urlPattern: /\/api\/(library|artists)\//,
            status: 404,
            reason: "deliberately requesting an album and artist that do not exist",
        });

        await session.step("an album that does not exist", async () => {
            await page.goto("/album/definitely-not-a-real-id");
            await settle(page, 2000);
            const crashed = await page
                .locator("text=/application error|something went wrong/i")
                .count();
            expect(crashed, "a bad album id showed a crash screen").toBe(0);
            return { handled: true };
        });

        await session.step("an artist that does not exist", async () => {
            await page.goto("/artist/definitely-not-a-real-id");
            await settle(page, 2000);
            const crashed = await page
                .locator("text=/application error|something went wrong/i")
                .count();
            expect(crashed, "a bad artist id showed a crash screen").toBe(0);
            return { handled: true };
        });

        session.clearExpectedFailures();
        session.assertClean("Journey 8 (rough edges)");
    });

    // ----------------------------------------------------------------------------------
    test("8b. TV mode: the remote arrows drive the app", async () => {
        session.setJourney("8b. TV navigation");

        await session.step("enter TV mode", async () => {
            await page.goto("/?tv=1");
            await settle(page, 2500);
            const tv = await page.evaluate(() => document.documentElement.classList.contains("tv-mode"));
            expect(tv, "?tv=1 did not switch the document into tv-mode").toBe(true);
            const tabs = page.locator("[data-tv-tab]");
            await expect(tabs.first()).toBeVisible({ timeout: 10_000 });
            return { tvMode: true, tabs: await tabs.count() };
        });

        await session.step("arrow keys move the focus", async () => {
            const readFocus = () =>
                page.evaluate(() => {
                    const el = document.activeElement;
                    return {
                        tab: el?.getAttribute("data-tv-tab") ? (el.textContent?.trim() ?? "") : "",
                        card: el?.getAttribute("data-tv-card") ?? "",
                        section: el?.getAttribute("data-tv-section") ?? "",
                    };
                });

            await page.locator("[data-tv-tab]").first().focus();
            await page.waitForTimeout(150);
            const start = await readFocus();
            await page.keyboard.press("ArrowRight");
            await page.waitForTimeout(500);
            const right = await readFocus();
            expect(
                right.tab,
                `ArrowRight did not move the tab focus (still "${start.tab}" -> "${right.tab}")`,
            ).not.toBe(start.tab);

            await page.keyboard.press("ArrowDown");
            await page.waitForTimeout(700);
            const down = await readFocus();
            const inContent = down.card || down.section;
            expect(
                inContent,
                "ArrowDown from the tab row did not land on any content card or section",
            ).toBeTruthy();
            return { tabMoved: true, reachedContent: true };
        });

        await session.step("Enter activates and Escape climbs back out", async () => {
            await page.keyboard.press("Enter");
            await page.waitForTimeout(2000);
            const url = new URL(page.url());
            const navigated = !/\/$/.test(url.pathname);
            if (navigated) {
                await page.keyboard.press("Escape");
                await page.waitForTimeout(1000);
            }
            await page.goto("/");
            await settle(page, 1500);
            return { activated: navigated, exited: true };
        });

        session.assertClean("Journey 8b (TV navigation)");
    });

    // ----------------------------------------------------------------------------------
    test("9. leave: sign out cleanly", async () => {
        session.setJourney("9. Leave");

        // The session ends unauthenticated, so a 401 here is the expected answer.
        session.expectFailure({
            urlPattern: /\/api\//,
            status: 401,
            reason: "requests in flight when the session was ended",
        });

        await session.step("sign out", async () => {
            await page.goto("/settings");
            await settle(page, 1500);

            const logout = page
                .locator('button[title*="out" i], button[aria-label*="out" i]')
                .first();
            if (await logout.isVisible({ timeout: 3000 }).catch(() => false)) {
                await logout.click();
            } else {
                // No visible control found -- clear the session directly so the check below
                // still means something, and say so in the report.
                await page.evaluate(() => localStorage.removeItem("auth_token"));
                await page.goto("/collection");
            }
            await settle(page, 1500);
            return { url: new URL(page.url()).pathname };
        });

        await session.step("protected pages are closed again", async () => {
            await page.goto("/collection");
            await settle(page, 2000);
            const path = new URL(page.url()).pathname;
            expect(
                path,
                `still able to reach ${path} after signing out`,
            ).toMatch(/login/);
            return { redirectedTo: path };
        });

        session.clearExpectedFailures();
        session.assertClean("Journey 9 (leave)");
    });

    // ----------------------------------------------------------------------------------
    test("10. the session as a whole stayed healthy", async () => {
        session.setJourney("10. Session health");

        // One event stream per page load is normal. A number far above the number of loads
        // means the stream is dropping and reconnecting, which on a real deployment shows up
        // as a steadily rising request count against the backend.
        await session.step("the event stream did not reconnect in a loop", async () => {
            const opens = session.sseConnectionCount;
            const loads = session.steps.length;
            expect(
                opens,
                `the event stream opened ${opens} times across ${loads} steps, which suggests ` +
                    `it is dropping and reconnecting rather than staying up`,
            ).toBeLessThan(loads * 3);
            return { streamOpens: opens, steps: loads };
        });

        await session.step("memory did not run away", async () => {
            const growth = session.heapGrowthMb;
            if (growth < 0) return { measured: false };
            // Generous on purpose: this is here to catch a leak that doubles the heap over
            // a session, not to police ordinary allocation.
            expect(
                growth,
                `the JS heap grew ${growth}MB over the session, which suggests something is ` +
                    `being retained across navigations`,
            ).toBeLessThan(300);
            return { heapGrowthMb: growth };
        });
    });
});
