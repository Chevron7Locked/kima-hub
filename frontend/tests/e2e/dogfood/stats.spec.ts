/**
 * The stats page, period filter, play-history audit, player play count and queue
 * limit as one watched session, apart from the hours-long walkthrough. Needs a
 * real play history: more than 50 plays.
 */
import { test, expect, Browser, Page, BrowserContext } from "@playwright/test";
import { DogfoodSession } from "./session";
import { PLAYER, settle } from "../fixtures/shared";
import { dismissWhatsNew, getAuthToken, loginAsTestUser } from "../fixtures/test-helpers";
import { withApiKey } from "./apiKey";
import { requireBaseUrl, destructiveVerdict } from "../fixtures/target";

const baseUrl = requireBaseUrl();
const username = process.env.KIMA_TEST_USERNAME || "";
const password = process.env.KIMA_TEST_PASSWORD || "";

/** The timezone every stats request names, so the page and the API cut days the same way. */
const TZ = "Europe/London";

/** The fewest plays at which the stats page has anything to compare against the API. */
const MIN_PLAYS = 50;

/** One thread of interaction: the filter journeys mean nothing if the page never loaded. */
test.describe.configure({ mode: "serial" });

/** Opens the lazy play-history audit if it is waiting to be asked, and waits for its totals. */
async function scanPlayHistory(page: Page): Promise<void> {
    const ask = page.getByRole("button", { name: /scan play history/i });
    if (await ask.isVisible().catch(() => false)) await ask.click();
    await expect(page.getByText(/total plays/i).first()).toBeVisible({ timeout: 30_000 });
}

test.describe("Dogfood: stats, filters, audit, queue", () => {
    let browser: Browser;
    let context: BrowserContext;
    let page: Page;
    let session: DogfoodSession;
    let token = "";
    /** Read once so later journeys can assert the page agrees with the API. */
    let allTime: {
        plays: number;
        distinctArtists: number;
        forHalf: number | null;
        neverPlayed: number;
    } | null = null;
    /** False when the signed-in user has too few plays for the history-dependent journeys. */
    let hasHistory = true;

    /** Records the skipped journey as not covered; true when the caller should stop. */
    const lacksHistory = (journey: string): boolean => {
        if (hasHistory) return false;
        session.noteNotCovered(`stats ${journey}: the signed-in user has ${allTime?.plays ?? 0} plays (needs more than ${MIN_PLAYS}), so this journey did not run`);
        return true;
    };

    test.beforeAll(async ({ browser: launched }) => {
        browser = launched;
        expect(
            username && password,
            "KIMA_TEST_USERNAME and KIMA_TEST_PASSWORD must be set",
        ).toBeTruthy();

        context = await browser.newContext({ viewport: { width: 1440, height: 900 } });
        page = await context.newPage();
        session = new DogfoodSession(page, baseUrl);
        session.attach();
    });

    test.afterAll(async () => {
        if (session) {
            const reportPath = session.writeReport("test-results/stats");
            console.log(`\n[stats-dogfood] report written to ${reportPath}`);
            console.log(
                `[stats-dogfood] ${session.steps.length} steps, ${session.violations.length} violations`,
            );
        }
        try {
            // Anything that went wrong after a journey's own check, or in a journey that stopped before its own.
            session?.assertNoneLeft();
        } finally {
            await context?.close();
        }
    });

    test("1. arrive: sign in and reach the stats page", async () => {
        session.setJourney("1. Arrive");

        // On the login screen the app asks who is signed in and is told nobody.
        // That 401 is the right answer, not a fault. Withdrawn once a session
        // exists, after which a 401 means something genuinely went wrong.
        session.expectFailure({
            urlPattern: /\/api\/auth\/me/,
            status: 401,
            reason: "the session check before anyone has signed in",
        });

        await session.step("sign in", async () => {
            await loginAsTestUser(page);
            token = await getAuthToken(page);
            expect(token, "a token should be stored after login").toBeTruthy();
        });

        await session.step("read the API's own answer, to compare the page against", async () => {
            const res = await page.request.get(
                `/api/stats?tz=${TZ}&period=all`,
                { headers: { Authorization: `Bearer ${token}` } },
            );
            expect(res.status()).toBe(200);
            const d = await res.json();
            allTime = {
                plays: d.listening.plays,
                distinctArtists: d.listening.distinctArtists,
                forHalf: d.signature.concentration?.forHalf ?? null,
                neverPlayed: d.shelf.neverPlayed,
            };
            // A page of zeroes proves nothing, and plays are never invented to fill it.
            hasHistory = allTime.plays > MIN_PLAYS;
            if (!hasHistory) {
                session.noteNotCovered(
                    `stats: the signed-in user has ${allTime.plays} plays (needs more than ${MIN_PLAYS}); the figure, filter, playable-slice, play-count and audit-read journeys did not run`,
                );
            }
        });

        await session.step("dismiss the release window if it is up", async () => {
            // The release window opens over everything on first login after an upgrade.
            if (!(await dismissWhatsNew(page))) {
                session.noteNotCovered("no release window was shown on this instance");
            }
        });

        await session.step("the stats page loads", async () => {
            await page.goto("/stats");
            await settle(page);
            await expect(page.getByText(/your listening/i).first()).toBeVisible();
        });

        session.assertClean("1. Arrive");
    });

    test("2. the ledger states the same numbers the API does", async () => {
        session.setJourney("2. Ledger");
        if (lacksHistory("journey 2")) return;

        await session.step("the headline figures match the API exactly", async () => {
            const body = await page.locator("main").innerText();
            expect(body).toContain(allTime!.plays.toLocaleString());
            expect(body).toContain(allTime!.distinctArtists.toLocaleString());
            if (allTime!.forHalf !== null) {
                expect(
                    body,
                    "the concentration figure the ledger prints must be the one the API returned",
                ).toContain(`${allTime!.forHalf} songs`);
            }
        });

        await session.step("every chart drew something", async () => {
            // A section that renders its frame and no data reads as a broken page.
            const svgShapes = await page.locator("main svg circle, main svg path, main svg rect").count();
            expect(svgShapes, "the charts should have drawn marks, not empty frames").toBeGreaterThan(50);
            const cells = await page.locator("button[data-cell]").count();
            expect(cells, "the week grid is 7x24").toBe(168);
        });

        await session.step("nothing overflows the measure", async () => {
            const overflow = await page.evaluate(
                () => [document.documentElement, document.querySelector("#main-content")].some((el) => !!el && el.scrollWidth > el.clientWidth + 1),
            );
            expect(overflow, "the page must not scroll sideways").toBe(false);
        });

        session.assertClean("2. Ledger");
    });

    test("3. the period filter actually narrows, and says which window it is showing", async () => {
        session.setJourney("3. Period filter");
        if (lacksHistory("journey 3")) return;

        let thirtyDayPlays = 0;

        await session.step("switching to 30 days refetches and shows fewer plays", async () => {
            const [res] = await Promise.all([
                page.waitForResponse(
                    (r) => r.url().includes("/api/stats?") && r.url().includes("period=30d"),
                    { timeout: 30_000 },
                ),
                page.getByRole("button", { name: "30 days", exact: true }).click(),
            ]);
            expect(res.status()).toBe(200);
            const d = await res.json();
            expect(d.period, "the server should echo the window it answered for").toBe("30d");
            thirtyDayPlays = d.listening.plays;
            expect(
                thirtyDayPlays,
                "thirty days cannot contain more listening than all time",
            ).toBeLessThanOrEqual(allTime!.plays);
            await settle(page);
        });

        await session.step("the headline says which window it is describing", async () => {
            const hero = await page.locator("main h1").first().innerText();
            expect(
                hero,
                "a figure for one window must not read as a figure for all of them",
            ).toMatch(/last 30 days/i);
        });

        await session.step("the shelf sections declare that they did not move", async () => {
            // They are not made of listening events, so the period control cannot
            // reach them; the page has to say so.
            const body = await page.locator("main").innerText();
            expect(body.toLowerCase()).toContain("all time");
        });

        await session.step("the never-played count is a shelf fact and is unchanged", async () => {
            const res = await page.request.get(`/api/stats?tz=${TZ}&period=30d`, {
                headers: { Authorization: `Bearer ${token}` },
            });
            const d = await res.json();
            expect(d.shelf.neverPlayed).toBe(allTime!.neverPlayed);
        });

        await session.step("switching back to all time restores the full figures", async () => {
            await Promise.all([
                page.waitForResponse(
                    (r) => r.url().includes("/api/stats?") && r.url().includes("period=all"),
                    { timeout: 30_000 },
                ),
                page.getByRole("button", { name: "all time", exact: true }).click(),
            ]);
            await settle(page);
            const body = await page.locator("main").innerText();
            expect(body).toContain(allTime!.plays.toLocaleString());
        });

        session.assertClean("3. Period filter");
    });

    test("4. every figure the page can play, plays", async () => {
        session.setJourney("4. Playable slices");
        if (lacksHistory("journey 4")) return;

        await session.step("a key wedge returns tracks rather than silently nothing", async () => {
            // The wheel folds both spellings of a pitch into one wedge. When the
            // query matched only the wedge's own label, a wedge could show
            // hundreds of listens and hand back an empty queue.
            const res = await page.request.get(`/api/stats?tz=${TZ}&period=all`, {
                headers: { Authorization: `Bearer ${token}` },
            });
            const keys = (await res.json()).signature.key;
            test.skip(!keys, "no analysed keys in this library");

            for (const k of keys.all.filter((x: { plays: number }) => x.plays > 0).slice(0, 6)) {
                const slice = await page.request.get(
                    `/api/stats/tracks?of=key&key=${encodeURIComponent(`${k.key} ${k.scale}`)}&limit=10`,
                    { headers: { Authorization: `Bearer ${token}` } },
                );
                expect(slice.status()).toBe(200);
                const { tracks } = await slice.json();
                expect(
                    tracks.length,
                    `"${k.key} ${k.scale}" shows ${k.plays} listens but returned no tracks`,
                ).toBeGreaterThan(0);
            }
        });

        await session.step("the core slice never promises more than it returns", async () => {
            const forHalf = allTime!.forHalf ?? 40;
            const res = await page.request.get(`/api/stats/tracks?of=core&limit=${forHalf}`, {
                headers: { Authorization: `Bearer ${token}` },
            });
            expect(res.status()).toBe(200);
            const { tracks } = await res.json();
            expect(tracks.length).toBeGreaterThan(0);
            expect(tracks.length).toBeLessThanOrEqual(Math.min(forHalf, 100));
        });

        await session.step("a nonsense limit gets the default list, not a server error or everything", async () => {
            const res = await page.request.get(`/api/stats/tracks?of=top&limit=abc`, {
                headers: { Authorization: `Bearer ${token}` },
            });
            expect(res.status(), "a bad limit should not be a server error").toBe(200);
            const { tracks } = await res.json();
            expect(tracks.length, "and must not sail past the cap").toBeLessThanOrEqual(100);
        });

        await session.step("pressing play on a top track starts audio", async () => {
            await page.goto("/stats");
            await settle(page);
            const trackRow = page.locator('main ol li button[aria-label^="Play "]').first();
            await expect(trackRow).toBeVisible({ timeout: 15_000 });
            await trackRow.click();

            // The player is an <audio> element and is never visible. What
            // matters is that it got a source and started moving.
            await expect
                .poll(
                    async () =>
                        page.$eval(PLAYER, (el) => {
                            const a = el as HTMLAudioElement;
                            return a.src ? (a.paused ? "paused" : "playing") : "no source";
                        }).catch(() => "missing"),
                    { timeout: 25_000, message: "pressing play on a top track should start audio" },
                )
                .toBe("playing");

            const src = await page.$eval(PLAYER, (el) => (el as HTMLAudioElement).src);
            expect(src, "and the source should be a real stream URL").toContain("/stream");
            // Deliberately not asserting readyState: headless Chromium ships no
            // audio codec, so it reports HAVE_NOTHING however well the stream is
            // being served. `paused === false` plus a stream URL is the same bar
            // the main walkthrough uses.
        });

        session.assertClean("4. Playable slices");
    });

    test("5. the player states how many times you have heard this track", async () => {
        session.setJourney("5. Player play count");
        if (lacksHistory("journey 5")) return;

        await session.step("the count in the bar is the count the API gives", async () => {
            // The track id comes from the bar's audio element; the stored
            // current-track key lags the player by seconds.
            const idFromPlayer = () =>
                page
                    .$eval(PLAYER, (el) =>
                        (el as HTMLAudioElement).src.match(/\/tracks\/([^/?#]+)\/stream/)?.[1] ?? "",
                    )
                    .catch(() => "");

            const ordinalOf = (n: number) => {
                const suffix =
                    n % 10 === 1 && n % 100 !== 11
                        ? "st"
                        : n % 10 === 2 && n % 100 !== 12
                          ? "nd"
                          : n % 10 === 3 && n % 100 !== 13
                            ? "rd"
                            : "th";
                return new RegExp(`\\b${n}(${suffix}) play\\b`);
            };

            test.skip(!(await idFromPlayer()), "nothing is playing to count");

            // The listen is recorded mid-window, so the bar shows plays+1
            // before it lands and plays after. A first listen shows nothing.
            await expect
                .poll(
                    async () => {
                        const id = await idFromPlayer();
                        if (!id) return "the player lost its stream";
                        const res = await page.request.get(`/api/stats/track/${id}/plays`, {
                            headers: { Authorization: `Bearer ${token}` },
                        });
                        expect(res.status()).toBe(200);
                        const { plays } = await res.json();
                        expect(typeof plays).toBe("number");
                        if (plays < 1) return "consistent";
                        const body = (await page.locator("body").innerText()).replace(/\s+/g, " ");
                        for (const n of [plays + 1, plays]) {
                            const ordinal = ordinalOf(n);
                            if (ordinal.test(body)) {
                                const link = page.getByRole("link", { name: ordinal });
                                await expect(link).toHaveAttribute("href", "/stats");
                                return "consistent";
                            }
                        }
                        return `bar shows no play ordinal for a track with ${plays} listens`;
                    },
                    { timeout: 20_000, message: "the bar's count must be the API's count" },
                )
                .toBe("consistent");
        });

        await session.step("an unknown track counts zero rather than erroring", async () => {
            const res = await page.request.get(`/api/stats/track/no-such-track/plays`, {
                headers: { Authorization: `Bearer ${token}` },
            });
            expect(res.status()).toBe(200);
            expect((await res.json()).plays).toBe(0);
        });

        session.assertClean("5. Player play count");
    });

    test("6. the queue limit is a setting, and the server enforces it", async () => {
        session.setJourney("6. Queue limit");

        // Pause first: a playing page saves its own queue on every advance and
        // would overwrite this journey's probe.
        const pause = page.getByTitle("pause", { exact: true });
        if (await pause.isVisible({ timeout: 2000 }).catch(() => false)) {
            await pause.click().catch(() => {});
            await settle(page, 1500);
        }

        await session.step("the server publishes the limit it will honour", async () => {
            const res = await page.request.get(`/api/playback-state/limit`, {
                headers: { Authorization: `Bearer ${token}` },
            });
            expect(res.status()).toBe(200);
            const { maxQueueLength } = await res.json();
            expect(maxQueueLength).toBeGreaterThanOrEqual(100);
            expect(maxQueueLength).toBeLessThanOrEqual(100_000);
        });

        await session.step("a queue longer than the limit is clamped, not rejected", async () => {
            // A Kima page saves the playback state on its own (on pause, on leaving), so no Kima page is open while
            // the probe is written and read back; the last save of leaving lands before it.
            await page.goto("about:blank");
            await page.waitForTimeout(1500);
            const limitRes = await page.request.get(`/api/playback-state/limit`, {
                headers: { Authorization: `Bearer ${token}` },
            });
            const { maxQueueLength } = await limitRes.json();

            const oversized = Array.from({ length: maxQueueLength + 25 }, (_, i) => ({
                id: `probe-${i}`,
                title: `Probe ${i}`,
                duration: 180,
            }));
            const save = await page.request.post(`/api/playback-state`, {
                headers: { Authorization: `Bearer ${token}` },
                data: { playbackType: "track", queue: oversized, currentIndex: 0 },
            });
            expect(save.status(), "an over-long queue should be trimmed, not refused").toBe(200);

            const read = await page.request.get(`/api/playback-state`, {
                headers: { Authorization: `Bearer ${token}` },
            });
            const state = await read.json();
            expect(Array.isArray(state.queue)).toBe(true);
            expect(state.queue.length).toBe(maxQueueLength);
            await page.goto("/");
            await settle(page);
        });

        await session.step("the queue is not written to localStorage", async () => {
            // Nothing reads it, and serialising the whole queue on every skip is costly.
            const stored = await page.evaluate(() => localStorage.getItem("kima_queue"));
            expect(stored, "kima_queue should not be written to localStorage").toBeNull();
        });

        await session.step("an admin can see the setting in Settings", async () => {
            await page.goto("/settings");
            await settle(page);
            const row = page.getByText(/queue limit/i).first();
            await expect(row).toBeVisible({ timeout: 15_000 });
        });

        session.assertClean("6. Queue limit");
    });

    test("7. the play-history audit reports honestly and deletes only what it proves", async () => {
        session.setJourney("7. Play history audit");
        if (lacksHistory("journey 7")) return;

        let before: {
            totalListens: number;
            heard: number;
            skipped: number;
            tooShort: number;
            unclear: number;
            duplicateRows: number;
            collapsibleRows: number;
        };

        await session.step("the audit's figures add up to the listens it counted", async () => {
            const res = await page.request.get(`/api/stats/false-starts`, {
                headers: { Authorization: `Bearer ${token}` },
            });
            expect(res.status()).toBe(200);
            before = await res.json();
            expect(
                before.heard + before.skipped + before.tooShort + before.unclear,
                "the four buckets are read against 'total plays' and must sum to it",
            ).toBe(before.totalListens);
        });

        await session.step("a track too short to ever count is never queued for deletion", async () => {
            const res = await page.request.get(`/api/stats/false-starts`, {
                headers: { Authorization: `Bearer ${token}` },
            });
            const audit = await res.json();
            const onlyTooShort = audit.tracks.filter(
                (t: { skipped: number; tooShort: number }) => t.skipped === 0 && t.tooShort > 0,
            );
            expect(
                onlyTooShort.length,
                "being under thirty seconds is a fact about a track, not proof about a listen",
            ).toBe(0);
        });

        // The merge itself is exercised through its button in journey 7b: a second
        // run here would find the duplicates already consumed.

        await session.step("the stats page still agrees after the merge", async () => {
            const res = await page.request.get(`/api/stats?tz=${TZ}&period=all`, {
                headers: { Authorization: `Bearer ${token}` },
            });
            const d = await res.json();
            expect(
                d.listening.plays,
                "the merge removes duplicate records, not listens",
            ).toBe(allTime!.plays);
        });

        await session.step("the panel renders what the API said", async () => {
            await page.goto("/stats#false-starts");
            await settle(page);

            // The audit reads the whole history, so it is deliberately lazy —
            // "nothing runs until you ask". Asking is part of the journey.
            await scanPlayHistory(page);

            // The four buckets on screen must be the four the API returned, or
            // the panel is describing a different history than the one audited.
            const res = await page.request.get(`/api/stats/false-starts`, {
                headers: { Authorization: `Bearer ${token}` },
            });
            const audit = await res.json();
            const shown = (await page.locator("main").innerText()).replace(/\s+/g, " ");
            expect(shown).toContain(audit.totalListens.toLocaleString());
            expect(shown).toContain(audit.heard.toLocaleString());
        });

        session.assertClean("7. Play history audit");
    });

    test("7b. the audit's buttons: merge, ignore, restore, remove", async () => {
        session.setJourney("7b. Audit buttons");

        // The merge and remove buttons permanently delete play rows, so they only run on a marked test copy.
        const verdict = await destructiveVerdict(baseUrl, async () => {
            const res = await page.request.get("/api/playlists?limit=100", { headers: { Authorization: `Bearer ${token}` } });
            const lists = res.ok() ? ((await res.json()) as Array<{ name: string; isOwner: boolean }>) : [];
            return lists.filter((l) => l.isOwner).map((l) => l.name);
        });
        if (!verdict.ok) {
            session.noteNotCovered(`stats 7b (merge, ignore, restore, remove play history) did not run: ${verdict.reason}`);
            return;
        }

        /** The audit as the server currently sees it. */
        const audit = async () =>
            (
                await page.request.get(`/api/stats/false-starts`, {
                    headers: { Authorization: `Bearer ${token}` },
                })
            ).json();

        /** Every play row this user has, counted at the source. */
        const rowCount = async (): Promise<number> => {
            const res = await page.request.get(`/api/stats/false-starts`, {
                headers: { Authorization: `Bearer ${token}` },
            });
            return (await res.json()).totalRows;
        };

        await session.step("scrobble three back-dated plays, five seconds apart", async () => {
            // Five seconds of a track is a provable skip, so the first two plays
            // give the audit something to act on in every run. The dates sit long
            // before any real play; a repeat run's rows are refused as duplicates.
            const tracksRes = await page.request.get("/api/library/tracks?limit=50", {
                headers: { Authorization: `Bearer ${token}` },
            });
            expect(tracksRes.ok(), `track list returned ${tracksRes.status()}`).toBeTruthy();
            const listed: Array<{ id: string; duration: number }> = (await tracksRes.json()).tracks;
            const picked = listed.filter((t) => t.duration > 60).slice(0, 3);
            expect(picked.length, "the library needs three tracks over a minute long").toBe(3);

            // A run that died after "ignore" left these tracks off the list.
            const restored = await page.request.post("/api/stats/false-starts/restore", {
                data: { trackIds: picked.map((t) => t.id) },
                headers: { Authorization: `Bearer ${token}` },
            });
            expect(restored.ok(), `putting the tracks back returned ${restored.status()}`).toBeTruthy();

            await withApiKey(page, token, "dogfood-audit", async (apiKey) => {
                const start = Date.UTC(2001, 0, 1);
                for (const [i, track] of picked.entries()) {
                    const res = await page.request.get(
                        `/rest/scrobble.view?u=${encodeURIComponent(username)}` +
                            `&apiKey=${encodeURIComponent(apiKey)}&id=${track.id}` +
                            `&time=${start + i * 5000}&submission=true&v=1.16.1&c=kima-dogfood&f=json`,
                    );
                    const status = (await res.json())?.["subsonic-response"]?.status;
                    expect(status, `scrobble ${i + 1} answered "${status}"`).toBe("ok");
                }
            });

            const flagged = new Set((await audit()).tracks.map((t: { trackId: string }) => t.trackId));
            expect(
                picked.slice(0, 2).every((t) => flagged.has(t.id)),
                "the two short plays must be listed as skips",
            ).toBe(true);
        });

        await session.step("open the panel and ask it to look", async () => {
            await page.goto("/stats#false-starts");
            await settle(page);
            await scanPlayHistory(page);
        });

        await session.step("the merge button removes exactly the number it names", async () => {
            const start = await audit();
            const button = page.getByRole("button", { name: /merge [\d,]+ duplicates?/i });
            // Recording refuses duplicates, so only history from older versions
            // has any to merge; once merged, the button must not be offered.
            if (start.collapsibleRows === 0) {
                await expect(button, "with nothing to merge, no merge is offered").toHaveCount(0);
                return;
            }

            await expect(button).toBeVisible();
            const label = await button.innerText();
            const promised = Number(label.replace(/\D/g, ""));
            expect(
                promised,
                "the button must name the number of rows it will actually delete",
            ).toBe(start.collapsibleRows);

            const rowsBefore = await rowCount();
            await button.click();
            await expect(page.getByText(/merged [\d,]+ duplicates?/i)).toBeVisible({
                timeout: 60_000,
            });

            const rowsAfter = await rowCount();
            expect(
                rowsBefore - rowsAfter,
                "the rows that disappeared must be the rows it promised",
            ).toBe(promised);

            const end = await audit();
            expect(end.totalListens, "a merge changes records, never listens").toBe(
                start.totalListens,
            );
            expect(end.heard, "and must not destroy the evidence behind 'proven heard'").toBe(
                start.heard,
            );
        });

        await session.step("leaving a track alone removes nothing and takes it off the list", async () => {
            await page.reload();
            await settle(page);
            await scanPlayHistory(page);

            const start = await audit();
            expect(start.tracks.length, "the seeded skips must be listed").toBeGreaterThan(0);

            const rowsBefore = await rowCount();
            const firstBox = page.locator('main input[type="checkbox"]').first();
            await expect(firstBox).toBeVisible({ timeout: 15_000 });
            await firstBox.check();

            await page.getByRole("button", { name: "ignore", exact: true }).click();
            await expect(page.getByText(/ignored \d+ tracks?/i)).toBeVisible({ timeout: 30_000 });

            expect(
                await rowCount(),
                "'ignore' must not delete a single row",
            ).toBe(rowsBefore);

            const end = await audit();
            expect(end.ignored.length, "and the track should now be listed as ignored").toBe(
                start.ignored.length + 1,
            );
        });

        await session.step("restoring it returns it to the results", async () => {
            const start = await audit();
            expect(start.ignored.length, "the ignored track must be listed").toBeGreaterThan(0);

            // The ignored list is collapsed by default, so expand it first. The
            // control inside reads "restore"; "restored" is the message it shows
            // afterwards.
            const reveal = page.getByRole("button", { name: /show \d+ ignored/i });
            await expect(reveal).toBeVisible({ timeout: 15_000 });
            await reveal.click();

            const back = page.getByRole("button", { name: "restore", exact: true }).first();
            await expect(back).toBeVisible({ timeout: 15_000 });
            const rowsBefore = await rowCount();
            await back.click();
            await expect
                .poll(async () => (await audit()).ignored.length, { timeout: 30_000 })
                .toBe(start.ignored.length - 1);
            expect(await rowCount(), "restoring must not touch any row either").toBe(rowsBefore);
        });

        await session.step("remove deletes the provable skips, and only those", async () => {
            await page.reload();
            await settle(page);
            await scanPlayHistory(page);

            const start = await audit();
            expect(start.skipped, "the seeded skips must still be provable").toBeGreaterThan(0);

            const rowsBefore = await rowCount();

            const selectAll = page.getByRole("button", { name: /select all/i });
            await expect(selectAll).toBeVisible({ timeout: 15_000 });
            await selectAll.click();

            // The confirmation is deliberately two presses: a delete this size
            // should not happen on one click.
            const remove = page.getByRole("button", { name: /remove skipped plays \(\d+ tracks?\)/i });
            await expect(remove).toBeVisible({ timeout: 15_000 });
            await remove.click();
            const confirm = page.getByRole("button", { name: /delete [\d,]+ plays?\?/i });
            await expect(confirm, "a destructive action should ask before acting").toBeVisible({
                timeout: 15_000,
            });
            const promised = Number((await confirm.innerText()).replace(/\D/g, ""));
            await confirm.click();

            await expect(page.getByText(/removed [\d,]+ records? from/i)).toBeVisible({ timeout: 60_000 });

            const end = await audit();
            const rowsAfter = await rowCount();

            // The confirmation counts LISTENS; the table stores ROWS, and after a
            // merge a listen is still one or two rows, so the promise is compared
            // to the listens that went, not to the row delta.
            expect(
                start.totalListens - end.totalListens,
                "the listens that went must be the listens it named",
            ).toBe(promised);
            expect(
                rowsBefore - rowsAfter,
                "and every deleted listen takes at least its own row with it",
            ).toBeGreaterThanOrEqual(promised);
            expect(
                end.heard,
                "a delete of provable skips must not take a proven-heard listen with it",
            ).toBe(start.heard);
            expect(
                end.tooShort,
                "nor a track that was only ever too short to count",
            ).toBe(start.tooShort);
            expect(end.skipped, "and the skips it proved should now be gone").toBeLessThan(
                start.skipped,
            );
        });

        session.assertClean("7b. Audit buttons");
    });

    test("7c. the queue limit setting is saved and honoured", async () => {
        session.setJourney("7c. Queue limit setting");

        await session.step("changing the number in Settings changes what the server keeps", async () => {
            const original = (
                await (
                    await page.request.get(`/api/playback-state/limit`, {
                        headers: { Authorization: `Bearer ${token}` },
                    })
                ).json()
            ).maxQueueLength as number;

            await page.goto("/settings");
            await settle(page);

            const row = page.getByText(/queue limit/i).first();
            await expect(row).toBeVisible({ timeout: 20_000 });
            const input = page
                .locator("input[type=number]")
                .filter({ hasNot: page.locator("[disabled]") })
                .last();
            await input.fill("2500");
            await input.blur(); // the blur lifts the number into the page's state
            // The page-level "Save Changes" button is the only door to the
            // server: it POSTs the whole settings state. A locator that
            // matches any Save hits the API-keys "Save token" button first.
            await page.getByRole("button", { name: /save changes/i }).click();

            await expect
                .poll(
                    async () =>
                        (
                            await (
                                await page.request.get(`/api/playback-state/limit`, {
                                    headers: { Authorization: `Bearer ${token}` },
                                })
                            ).json()
                        ).maxQueueLength,
                    { timeout: 90_000, message: "the server should honour the saved limit" },
                )
                .toBe(2500);

            // And the clamp must follow the new number, not the old one.
            const oversized = Array.from({ length: 2600 }, (_, i) => ({
                id: `probe-${i}`,
                title: `Probe ${i}`,
                duration: 180,
            }));
            await page.request.post(`/api/playback-state`, {
                headers: { Authorization: `Bearer ${token}` },
                data: { playbackType: "track", queue: oversized, currentIndex: 0 },
            });
            const state = await (
                await page.request.get(`/api/playback-state`, {
                    headers: { Authorization: `Bearer ${token}` },
                })
            ).json();
            expect(state.queue.length).toBe(2500);

            // Put it back, so the suite leaves the instance as it found it.
            await page.request.post(`/api/system-settings`, {
                headers: { Authorization: `Bearer ${token}` },
                data: { maxQueueLength: original },
            });
        });

        session.assertClean("7c. Queue limit setting");
    });

    test("8. on a phone: the same page, adapted rather than amputated", async () => {
        session.setJourney("8. Phone");

        await session.step("nothing scrolls sideways at 390px", async () => {
            const phone = await browser.newContext({
                viewport: { width: 390, height: 844 },
                hasTouch: true,
                isMobile: true,
            });
            const p = await phone.newPage();
            session.setActivePage(p);
            session.attach(p);
            try {
                await loginAsTestUser(p);
                await p.goto(`${baseUrl}/stats`);
                await settle(p);

                const overflow = await p.evaluate(
                    () => [document.documentElement, document.querySelector("#main-content")].some((el) => !!el && el.scrollWidth > el.clientWidth + 1),
                );
                expect(overflow, "a phone must not scroll sideways").toBe(false);

                // On a phone the period is a select folded into the tab row; it
                // has to be reachable and has to change what the page shows.
                const periodSelect = p.getByRole("combobox", { name: "period" });
                await expect(periodSelect).toBeVisible();
                await periodSelect.selectOption("30d");
                // The 30-day view's heading: the period's name, or its empty state on a user with no plays (the
                // all-time empty state says "no plays yet" instead).
                await expect(p.locator("main h1").first()).toHaveText(/last 30 days|no plays in this period/i);
            } finally {
                session.setActivePage(page);
                await phone.close();
            }
        });

        session.assertClean("8. Phone");
    });
});
