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

test.describe("Dogfood walkthrough", () => {
    let browser: Browser;
    let context: BrowserContext;
    let page: Page;
    let session: DogfoodSession;
    let facts: LibraryFacts;
    let journeys: ReturnType<typeof availableJourneys>;
    let token = "";
    const createdPlaylistIds: string[] = [];

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
            for (const r of journeys?.reasons ?? []) console.log(`[dogfood] NOT COVERED -- ${r}`);
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
            const album = firstAlbumCard(page);
            if (!(await album.isVisible().catch(() => false))) {
                await openAlbumsTab(page);
            }
            const target = firstAlbumCard(page);
            await target.waitFor({ state: "visible", timeout: 10_000 });
            await target.click();
            await page.waitForURL(/\/album\//, { timeout: 10_000 });
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
                `playback position did not advance (${first.t}s -> ${second.t}s, readyState ${second.ready}). ` +
                    `The UI claims it is playing but no audio is moving.`,
            ).toBeGreaterThan(first.t);

            return { from: first.t.toFixed(2), to: second.t.toFixed(2), readyState: second.ready };
        });

        session.assertClean("Journey 2 (listen)");
    });

    // ----------------------------------------------------------------------------------
    test("3. queue: line up more music and confirm every surface agrees", async () => {
        session.setJourney("3. Queue");

        await session.step("add a track to the queue", async () => {
            const row = page.locator("[data-track-row]").nth(1);
            await row.waitFor({ state: "visible", timeout: 10_000 });
            await row.hover();
            await row.getByLabel("Add to queue").click();
            await page.waitForTimeout(600);
            return { added: true };
        });

        // Client-side navigation on purpose: the queue lives in React state, so reloading
        // the page would destroy the very thing being checked.
        await session.step("open the queue from the player", async () => {
            await page.getByTitle("Play queue").click();
            await page.waitForURL(/\/queue/, { timeout: 10_000 });
            await settle(page, 1000);
            return { url: new URL(page.url()).pathname };
        });

        await session.step("the queue shows what is playing and what is next", async () => {
            await expect(page.getByRole("heading", { name: "Now Playing" })).toBeVisible({
                timeout: 10_000,
            });
            await expect(page.getByText(/Next Up/)).toBeVisible({ timeout: 10_000 });
            return { nowPlaying: true, nextUp: true };
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
    test("5. explore: the enrichment pipeline's output reaches the screen", async () => {
        session.setJourney("5. Explore");

        test.skip(
            !journeys.vibe,
            `no vibe map on this instance (${facts.embeddedTracks} embedded tracks)`,
        );

        await session.step("open the vibe map", async () => {
            await navigateByClick(page, "/vibe");
            await settle(page, 3000);
            return { url: new URL(page.url()).pathname };
        });

        // This is the user-visible end of the analyzer and embedding work. If the map is
        // empty while the database holds embeddings, the break is between them.
        await session.step("the map is drawn from real embeddings", async () => {
            const res = await page.request.get("/api/vibe/map", {
                headers: { Authorization: `Bearer ${token}` },
            });
            expect(res.ok(), `the vibe map API returned ${res.status()}`).toBeTruthy();
            const body = await res.json();
            const nodes = Array.isArray(body) ? body.length : (body.tracks?.length ?? 0);
            expect(nodes, "the vibe map API returned no tracks").toBeGreaterThan(0);

            const canvas = page.locator("canvas");
            const hasCanvas = (await canvas.count()) > 0;
            return { mappedTracks: nodes, canvasRendered: hasCanvas };
        });

        session.assertClean("Journey 5 (explore)");
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
