/**
 * Kima 1.12's non-podcast features, driven through the real UI and checked against the server's own answers:
 * playlist reverse order, per-step enrichment re-runs, update pings, operator-only downloads, and the
 * What's new / changelog doors; then the queue and right-hand panel, the left rail, radio stations, track details,
 * and library-only collection. Every test puts back what it changed.
 */
import { test, expect, devices, Browser, BrowserContext, Page, APIRequestContext } from "@playwright/test";
import { DogfoodSession } from "./session";
import { settle, softwareWebGL, readPlayer, escapeRegExp } from "../fixtures/shared";
import { requireBaseUrl } from "../fixtures/target";
import { LibraryPicker } from "../fixtures/picker";

const baseUrl = requireBaseUrl();
const username = process.env.KIMA_TEST_USERNAME || "";
const password = process.env.KIMA_TEST_PASSWORD || "";
const RUN_TAG = `r112-${Date.now().toString(36)}`;

test.describe.configure({ mode: "serial" });
test.use(softwareWebGL);

/** Sign in on a page. The login screen's own "who am I" check answers 401 by design, so that is declared. */
async function signIn(page: Page, session: DogfoodSession, user: string, pass: string): Promise<string> {
    session.expectFailure({
        urlPattern: /\/api\/auth\/me/,
        status: 401,
        reason: "the session check on the login screen, before anyone has signed in",
    });
    await page.goto("/login");
    await page.locator("#username").fill(user);
    await page.locator("#password").fill(pass);
    await page.getByRole("button", { name: "Sign In" }).click();
    await page.waitForURL(/\/($|\?|home)/, { timeout: 20_000 });
    await settle(page, 1200);
    session.clearExpectedFailures();
    return page.evaluate(() => localStorage.getItem("auth_token") ?? "");
}

const bearer = (token: string) => ({ Authorization: `Bearer ${token}` });

test.describe("Release 1.12 (non-podcast)", () => {
    let browser: Browser;
    let context: BrowserContext;
    let page: Page;
    let session: DogfoodSession;
    let token = "";
    let api: APIRequestContext;

    test.beforeAll(async ({ browser: launched }) => {
        browser = launched;
        expect(username && password, "KIMA_TEST_USERNAME and KIMA_TEST_PASSWORD must be set").toBeTruthy();
        context = await browser.newContext({ viewport: { width: 1440, height: 900 } });
        page = await context.newPage();
        api = page.request;
        session = new DogfoodSession(page, baseUrl);
        session.attach();
        session.setJourney("0. sign in");
        token = await signIn(page, session, username, password);
        expect(token, "no auth token after signing in").toBeTruthy();
        session.assertClean("sign in");
    });

    test.afterAll(async () => {
        try {
            session?.assertNoneLeft();
        } finally {
            if (session) console.log(`\n[release-112] report written to ${session.writeReport("test-results/release-112")}`);
            await context?.close();
        }
    });

    // ------------------------------------------------------------------------------------------
    test("1. playlist reverse order: shown, queued, remembered, and drag lands where it looks", async () => {
        test.setTimeout(180_000);
        session.setJourney("1. playlist reverse");
        let playlistId = "";
        try {
            let ids: string[] = [];
            let titles: string[] = [];
            await session.step("build a playlist of four library songs", async () => {
                const created = await api.post("/api/playlists", { data: { name: `${RUN_TAG}-reverse` }, headers: bearer(token) });
                expect(created.ok(), `creating the playlist returned ${created.status()}`).toBeTruthy();
                const body = await created.json();
                playlistId = body.id ?? body.playlist?.id;
                expect(playlistId).toBeTruthy();

                // Distinct titles so a row can be told apart on screen.
                const picks = await new LibraryPicker(api, token).distinctTitleTracks(4);
                expect(picks.length, "the library needs four songs with different titles").toBe(4);
                for (const t of picks) {
                    const add = await api.post(`/api/playlists/${playlistId}/items`, { data: { trackId: t.id }, headers: bearer(token) });
                    expect(add.ok(), `adding ${t.id} returned ${add.status()}`).toBeTruthy();
                }
                ids = picks.map((t) => t.id);
                titles = picks.map((t) => t.title);
                return { playlistId, order: titles.join(" | ") };
            });

            const rows = () => page.locator("[data-track-index]");
            const shownTitles = () =>
                rows().evaluateAll((els) =>
                    els.map((el) => (el.querySelector("p.text-sm.font-bold") ?? el.querySelector("p"))?.textContent?.trim() ?? ""),
                );
            const storedIds = async (): Promise<string[]> => {
                const r = await api.get(`/api/playlists/${playlistId}?order=asc`, { headers: bearer(token) });
                expect(r.ok()).toBeTruthy();
                const b = await r.json();
                return ((b.items ?? []) as Array<{ track: { id: string } }>).map((i) => i.track.id);
            };
            const reverseToggle = () => page.getByRole("button", { name: "reverse order" });

            await session.step("the list shows in stored order until the toggle is flipped", async () => {
                await page.goto(`/playlist/${playlistId}`);
                await expect(rows()).toHaveCount(4, { timeout: 15_000 });
                expect(await shownTitles()).toEqual(titles);
                await expect(reverseToggle()).toHaveAttribute("aria-pressed", "false");
                expect(await storedIds()).toEqual(ids);
            });

            await session.step("flip reverse: the list shows reversed and the server stored the choice", async () => {
                const saved = page.waitForResponse((r) => r.request().method() !== "GET" && r.url().includes(`/api/playlists/${playlistId}`));
                await reverseToggle().click();
                expect((await saved).ok()).toBeTruthy();
                await expect(reverseToggle()).toHaveAttribute("aria-pressed", "true");
                await expect.poll(shownTitles).toEqual([...titles].reverse());
                const r = await (await api.get(`/api/playlists/${playlistId}`, { headers: bearer(token) })).json();
                expect(r.reverseOrder, "the server did not keep the reverse choice").toBe(true);
                expect(await storedIds(), "reversing must not change the stored order").toEqual(ids);
            });

            await session.step("playing it queues the songs in the order shown", async () => {
                await page.getByRole("button", { name: "Play all" }).click();
                await page.getByTitle("pause", { exact: true }).waitFor({ timeout: 15_000 });
                const want = [...ids].reverse();
                await expect
                    .poll(
                        async () => {
                            const res = await api.get("/api/playback-state", { headers: bearer(token) });
                            const state = await res.json();
                            const queue = (state?.queue ?? []) as Array<{ id?: string; trackId?: string; track?: { id?: string } }>;
                            return queue.map((q) => q.id ?? q.trackId ?? q.track?.id);
                        },
                        { timeout: 20_000, message: "the saved queue never matched the order shown" },
                    )
                    .toEqual(want);
                await page.getByTitle("pause", { exact: true }).click();
            });

            await session.step("the choice is remembered after a reload", async () => {
                await page.reload();
                await expect(rows()).toHaveCount(4, { timeout: 15_000 });
                await expect(reverseToggle()).toHaveAttribute("aria-pressed", "true");
                expect(await shownTitles()).toEqual([...titles].reverse());
            });

            await session.step("drag in the reversed view lands where it looks", async () => {
                // Screen order is D C B A. Drop the first row (D) on the third (B): D goes right after B on screen.
                const before = await shownTitles();
                const [s0, s1, s2, s3] = before;
                const moved = page.waitForResponse((r) => r.request().method() === "PATCH" && r.url().includes("/move"));
                // Both rows must be on screen and clear of the player bar, or the browser never delivers the drop.
                await rows().nth(2).scrollIntoViewIfNeeded();
                await rows().nth(0).dragTo(rows().nth(2), { sourcePosition: { x: 6, y: 6 }, targetPosition: { x: 300, y: 20 }, timeout: 15_000 });
                expect((await moved).ok(), "the move request failed").toBeTruthy();
                await expect.poll(shownTitles).toEqual([s1, s2, s0, s3]);
                // The server's stored order (ascending) is the screen order mirrored.
                const byId = new Map(ids.map((id, i) => [titles[i], id]));
                const wantStored = [s1, s2, s0, s3].reverse().map((t) => byId.get(t));
                expect(await storedIds(), "stored order does not match what the screen shows, mirrored").toEqual(wantStored);
                // And after a reload the screen still agrees.
                await page.reload();
                await expect(rows()).toHaveCount(4, { timeout: 15_000 });
                expect(await shownTitles()).toEqual([s1, s2, s0, s3]);
            });

            session.assertClean("Journey 1 (playlist reverse)");
        } finally {
            if (playlistId) {
                await api.delete(`/api/playlists/${playlistId}`, { headers: bearer(token) }).catch(() => {});
            }
        }
    });

    // ------------------------------------------------------------------------------------------
    test("2. per-step re-run: similarity + map runs, finishes, and the vibe map still loads", async () => {
        test.setTimeout(30 * 60_000);
        session.setJourney("2. similarity re-run");

        const progress = async () => (await (await api.get("/api/enrichment/progress", { headers: bearer(token) })).json()) as {
            similarity: { total: number; completed: number };
            isFullyComplete: boolean;
        };
        const status = async () => (await (await api.get("/api/enrichment/status", { headers: bearer(token) })).json()) as { status: string };
        const mapState = async () => {
            const r = await api.get("/api/vibe/map", { headers: bearer(token) });
            if (r.status() === 202) return { computing: true, tracks: 0 };
            expect(r.ok(), `the vibe map answered ${r.status()}`).toBeTruthy();
            return { computing: false, tracks: ((await r.json()).tracks ?? []).length };
        };

        let total = 0;
        await session.step("start from a finished, idle library", async () => {
            const p = await progress();
            total = p.similarity.total;
            expect(total, "the library has no songs").toBeGreaterThan(0);
            expect(p.isFullyComplete && p.similarity.completed === total, "enrichment is not finished before the re-run").toBeTruthy();
            expect((await status()).status).toBe("idle");
            const m = await mapState();
            expect(m.computing, "the map is already being computed before the re-run").toBe(false);
            expect(m.tracks).toBe(total);
            return { total };
        });

        await session.step("pick 'similarity + map' in the step picker and confirm", async () => {
            await page.goto("/settings");
            await settle(page, 1500);
            const picker = page.locator("#enrichment-rerun-step");
            await picker.scrollIntoViewIfNeeded();
            await expect(picker).toBeVisible({ timeout: 15_000 });
            await picker.selectOption("similarity");
            await page.getByRole("button", { name: "Re-run from", exact: true }).click();
            const dialog = page.getByRole("dialog");
            await expect(dialog).toBeVisible();
            const started = page.waitForResponse((r) => r.request().method() === "POST" && r.url().endsWith("/api/enrichment/rerun"));
            await dialog.getByRole("button", { name: "Re-run", exact: true }).click();
            const resp = await started;
            expect(resp.status(), "the re-run request was refused").toBe(200);
            expect(resp.request().postDataJSON()).toEqual({ step: "similarity" });
            expect((await resp.json()).message).toMatch(/re-running from/i);
            await expect(page.getByTestId("enrichment-queue-result")).toBeVisible({ timeout: 15_000 });
        });

        await session.step("the server really redoes it, then finishes", async () => {
            // The map is wiped when the re-run starts, so the server answers "computing" (or similarity shows owed work)
            // until the fresh layout lands. Seeing that proves the re-run ran; leaving it proves it finished.
            let sawBusy = false;
            await expect
                .poll(
                    async () => {
                        const [m, p] = await Promise.all([mapState(), progress()]);
                        if (m.computing || p.similarity.completed < p.similarity.total) sawBusy = true;
                        return sawBusy;
                    },
                    { timeout: 60_000, intervals: [250], message: "the server never showed the map or similarity as being redone" },
                )
                .toBe(true);
            await expect
                .poll(
                    async () => {
                        const [m, p, s] = await Promise.all([mapState(), progress(), status()]);
                        return !m.computing && m.tracks === total && p.similarity.completed === p.similarity.total && p.isFullyComplete && s.status === "idle";
                    },
                    { timeout: 25 * 60_000, intervals: [2000], message: "the re-run never finished" },
                )
                .toBe(true);
        });

        await session.step("the vibe map page draws after the re-run", async () => {
            await page.goto("/vibe");
            await settle(page, 3500);
            await expect(page.locator("canvas").first()).toBeVisible({ timeout: 30_000 });
        });

        session.assertClean("Journey 2 (similarity re-run)");
    });

    // ------------------------------------------------------------------------------------------
    test("3. update ping: the switch persists, and no dot shows when this build is the newest", async () => {
        test.setTimeout(120_000);
        session.setJourney("3. update ping");
        const TOGGLE = "#update-checks";
        const chip = () => page.getByRole("button", { name: /^what's new in v/i });
        const updateStatus = async () =>
            (await (await api.get("/api/whats-new/update-status", { headers: bearer(token) })).json()) as {
                enabled: boolean;
                current: string;
                latest: string | null;
                hasUpdate: boolean;
            };
        const openSettings = async () => {
            await page.goto("/settings");
            await settle(page, 1500);
            await expect(page.locator(TOGGLE)).toHaveCount(1, { timeout: 15_000 });
        };
        const original = (await updateStatus()).enabled;
        try {
            await session.step("with checks on, the server's newest release is older than this build and no dot shows", async () => {
                if (!original) {
                    await openSettings();
                    await page.locator(TOGGLE).click({ force: true });
                    await page.getByRole("button", { name: /save changes/i }).click();
                    await expect.poll(async () => (await updateStatus()).enabled, { timeout: 15_000 }).toBe(true);
                }
                const checked = page.waitForResponse((r) => r.url().includes("/api/whats-new/update-status"));
                await page.goto("/");
                await checked;
                const s = await updateStatus();
                expect(s.enabled).toBe(true);
                // The server compares dotted numbers itself; this reads its answer and the numbers it based it on.
                const num = (v: string) => v.replace(/^v/, "").split(".").map((n) => parseInt(n, 10) || 0);
                const [c, l] = [num(s.current), num(s.latest ?? "0")];
                const newer = l[0] !== c[0] ? l[0] > c[0] : l[1] !== c[1] ? l[1] > c[1] : l[2] > c[2];
                expect(newer, `GitHub's latest (${s.latest}) is newer than this build (${s.current}); this check needs a build that is current`).toBe(false);
                expect(s.hasUpdate).toBe(false);
                await expect(chip()).toBeVisible({ timeout: 15_000 });
                await expect(chip()).toContainText(`v${s.current}`);
                expect(await chip().getAttribute("aria-label")).not.toMatch(/update available/i);
                expect(await chip().locator("span.bg-warning").count(), "an update dot is showing").toBe(0);
                return { current: s.current, latest: s.latest ?? "none", hasUpdate: s.hasUpdate };
            });

            await session.step("switch checks off, save: it survives a reload and the server agrees", async () => {
                await openSettings();
                await expect(page.locator(TOGGLE)).toBeChecked();
                await page.locator(TOGGLE).click({ force: true });
                await page.getByRole("button", { name: /save changes/i }).click();
                await expect.poll(async () => (await updateStatus()).enabled, { timeout: 15_000 }).toBe(false);
                await page.reload();
                await settle(page, 1500);
                await expect(page.locator(TOGGLE)).not.toBeChecked();
                expect((await updateStatus()).hasUpdate).toBe(false);
            });

            await session.step("switch it back on, save: it survives a reload", async () => {
                await page.locator(TOGGLE).click({ force: true });
                await page.getByRole("button", { name: /save changes/i }).click();
                await expect.poll(async () => (await updateStatus()).enabled, { timeout: 15_000 }).toBe(true);
                await page.reload();
                await settle(page, 1500);
                await expect(page.locator(TOGGLE)).toBeChecked();
            });
            session.assertClean("Journey 3 (update ping)");
        } finally {
            if ((await updateStatus()).enabled !== original) {
                await openSettings();
                await page.locator(TOGGLE).click({ force: true });
                await page.getByRole("button", { name: /save changes/i }).click();
                await expect.poll(async () => (await updateStatus()).enabled, { timeout: 15_000 }).toBe(original);
            }
        }
    });

    // ------------------------------------------------------------------------------------------
    test("4. downloads are operator-only by default, and open to members only when the operator allows it", async () => {
        test.setTimeout(240_000);
        session.setJourney("4. operator-only downloads");
        const ALLOW = "#allow-member-acquire";
        const memberName = `r112_${Date.now().toString(36)}`;
        const memberPass = "r112-pass-1";
        let memberCtx: BrowserContext | null = null;
        let created = false;
        let originalAllow: boolean | null = null;

        const readAllow = async () =>
            (await (await api.get("/api/system-settings", { headers: bearer(token) })).json()).allowMemberAcquire === true;
        const setAllow = async (want: boolean) => {
            await page.goto("/settings");
            await settle(page, 1500);
            const sw = page.locator(ALLOW);
            await sw.scrollIntoViewIfNeeded();
            await expect(sw).toHaveCount(1, { timeout: 15_000 });
            if ((await sw.isChecked()) !== want) {
                await sw.click({ force: true });
                await page.getByRole("button", { name: /save changes/i }).click();
            }
            await expect.poll(readAllow, { timeout: 15_000, message: `the server never reported Member Downloads as ${want}` }).toBe(want);
        };

        try {
            originalAllow = await readAllow();

            await session.step("make sure Member Downloads is off, then create a member through the admin UI", async () => {
                await setAllow(false);
                await page.goto("/settings");
                await settle(page, 2000);
                const heading = page.getByRole("heading", { name: /user management|users/i }).first();
                await expect(heading).toBeVisible({ timeout: 15_000 });
                await heading.scrollIntoViewIfNeeded();
                await page.locator("main").getByPlaceholder("Username", { exact: true }).fill(memberName);
                await page.locator("main").getByPlaceholder("Password (6+ chars)").fill(memberPass);
                const create = page.locator("main").getByRole("button", { name: /^create$/i });
                await expect(create).toBeEnabled();
                await create.click();
                created = true;
                await expect(page.locator("main").getByText(memberName, { exact: true }).first()).toBeVisible({ timeout: 10_000 });
            });

            // The member's own browser: a fresh context, so no admin cookie, token or cached answer carries over.
            memberCtx = await browser.newContext({ viewport: { width: 1440, height: 900 } });
            const member = await memberCtx.newPage();
            const memberSession = new DogfoodSession(member, baseUrl);
            memberSession.attach();
            memberSession.setJourney("4. operator-only downloads (member)");
            let memberToken = "";
            let artistId = "";

            await session.step("the member signs in", async () => {
                memberToken = await signIn(member, memberSession, memberName, memberPass);
                expect(memberToken).toBeTruthy();
                // A new member has unread release news; it opens over the page, so read it and close it first.
                const news = member.getByRole("dialog");
                await expect(news).toBeVisible({ timeout: 10_000 });
                await news.getByRole("button", { name: "Close", exact: true }).click();
                await expect(news).toHaveCount(0);
                const me = await (await member.request.get("/api/auth/me", { headers: bearer(memberToken) })).json();
                expect(me.role ?? me.user?.role, "the new user must be a member, not an admin").toBe("user");
                // An artist with albums the library lacks, so an allowed user is offered a download button.
                const artist = await new LibraryPicker(api, token).artistWithUnownedAlbums();
                artistId = artist?.id ?? "";
                if (!artistId) {
                    session.noteNotCovered("downloads: none of the first 50 library artists has an album the library lacks, so the artist page's download buttons were not checked (the server's 403 and 400 answers still were)");
                }
            });

            // Anything that starts a download. The top bar's "Downloads" tab only lists downloads already running.
            const downloadControls = (p: Page) => p.getByRole("button", { name: /^(?!downloads$).*download/i });
            const downloadNames = (p: Page) =>
                downloadControls(p).evaluateAll((els) => els.map((e) => e.getAttribute("aria-label") ?? e.textContent ?? ""));
            const openArtist = async () => {
                await member.goto(`/artist/${artistId}`);
                await settle(member, 1500);
                // The page has drawn once the artist's play control is there.
                await expect(member.getByRole("heading").first()).toBeVisible({ timeout: 20_000 });
                await expect(member.getByRole("button", { name: /^play all$/i }).or(member.getByRole("button", { name: /shuffle/i })).first()).toBeVisible({ timeout: 20_000 });
            };
            const memberCanAcquire = async () =>
                (await (await member.request.get("/api/system-settings/public-config", { headers: bearer(memberToken) })).json()).canAcquire;

            await session.step("off: the member sees no download buttons on the artist page or in search", async () => {
                expect(await memberCanAcquire()).toBe(false);
                if (artistId) {
                    await openArtist();
                    await expect(member.getByRole("button", { name: /download all/i })).toHaveCount(0);
                    expect(await downloadNames(member), "the member sees download controls on the artist page").toEqual([]);
                }

                const box = member.getByLabel("Search");
                await box.click();
                await box.fill("a");
                await box.press("Enter");
                await member.waitForURL(/\/search/, { timeout: 10_000 });
                await settle(member, 2000);
                expect(await downloadNames(member), "the member sees download controls in search").toEqual([]);
            });

            await session.step("off: the server refuses the member's download requests with 403", async () => {
                const asMember = bearer(memberToken);
                const direct = await member.request.post("/api/downloads", {
                    headers: asMember,
                    data: { type: "album", mbid: "00000000-0000-4000-8000-000000000000", subject: "x", artistName: "x", albumTitle: "x" },
                });
                expect(direct.status(), "POST /api/downloads").toBe(403);
                const release = await member.request.post("/api/releases/download/00000000-0000-4000-8000-000000000000", { headers: asMember, data: {} });
                expect(release.status(), "POST /api/releases/download/:mbid").toBe(403);
                expect(String((await direct.json()).error)).toMatch(/operator-only/i);
            });

            await session.step("on: the admin turns Member Downloads on and the member now gets download buttons", async () => {
                await setAllow(true);
                expect(await memberCanAcquire()).toBe(true);
                if (artistId) {
                    await openArtist();
                    await expect(member.getByRole("button", { name: /download all/i })).toBeVisible({ timeout: 20_000 });
                }
                // The server no longer answers 403 (the fake id is rejected for being unknown, not for permission).
                const after = await member.request.post("/api/downloads", {
                    headers: bearer(memberToken),
                    data: { type: "album", mbid: "not-an-mbid", subject: "x", artistName: "x", albumTitle: "x" },
                });
                expect(after.status(), "an allowed member must get past the permission gate").toBe(400);
            });

            await session.step("off again: the buttons are gone for the member", async () => {
                await setAllow(false);
                expect(await memberCanAcquire()).toBe(false);
                if (artistId) {
                    await openArtist();
                    await expect(member.getByRole("button", { name: /download all/i })).toHaveCount(0);
                    expect(await downloadNames(member)).toEqual([]);
                }
            });

            memberSession.assertClean("Journey 4 (member browser)");
            await memberCtx.close();
            memberCtx = null;
            session.assertClean("Journey 4 (operator-only downloads)");
        } finally {
            await memberCtx?.close().catch(() => {});
            if (originalAllow !== null && (await readAllow()) !== originalAllow) await setAllow(originalAllow);
            if (created) {
                await page.goto("/settings");
                await settle(page, 2000);
                const del = page.locator("main").getByRole("button", { name: `delete ${memberName}`, exact: true });
                if (await del.count()) {
                    await del.click();
                    await page.getByRole("button", { name: "Delete", exact: true }).click();
                    await expect(page.locator("main").getByText(memberName, { exact: true })).toHaveCount(0, { timeout: 10_000 });
                }
            }
        }
    });

    // ------------------------------------------------------------------------------------------
    test("5. What's new and the changelog: the version number opens them and 1.12 is listed", async () => {
        session.setJourney("5. whats new / changelog");
        const chip = () => page.getByRole("button", { name: /^what's new in v/i });

        await session.step("the version number opens What's new, or the changelog once everything is read", async () => {
            await page.goto("/");
            await settle(page, 1500);
            await expect(chip()).toBeVisible({ timeout: 15_000 });
            const pending = ((await (await api.get("/api/whats-new/pending", { headers: bearer(token) })).json()).releases ?? []) as unknown[];
            await chip().click();
            if (pending.length > 0) {
                const win = page.getByRole("dialog");
                await expect(win, "unread news exists but the version number did not open What's new").toBeVisible({ timeout: 10_000 });
                await win.getByRole("button", { name: "Close", exact: true }).click();
                await expect(win).toHaveCount(0);
            } else {
                await page.waitForURL(/\/changelog/, { timeout: 10_000 });
            }
            return { unread: pending.length };
        });

        await session.step("/changelog lists 1.12.0 newest-first, matching the server", async () => {
            const served = (await (await api.get("/api/whats-new/changelog", { headers: bearer(token) })).json()).releases as Array<{ version: string; title: string; items: unknown[] }>;
            const entry = served.find((r) => r.version === "1.12.0");
            expect(entry, "the server's changelog has no 1.12.0 entry").toBeTruthy();
            expect(entry!.items.length).toBeGreaterThan(0);
            await page.goto("/changelog");
            const section = page.locator('section[id="1.12.0"]');
            await expect(section).toBeVisible({ timeout: 15_000 });
            await expect(section.getByRole("heading", { level: 2 })).toHaveText(entry!.title, { ignoreCase: true });
            const ids = await page.locator("main section[id]").evaluateAll((els) => els.map((e) => e.id));
            expect(ids, "the page and the server list releases in different order").toEqual(served.map((r) => r.version));
            return { releases: ids.length };
        });

        await session.step("a deep link lands on 1.12.0", async () => {
            await page.goto("/changelog#1.12.0");
            await expect(page.locator('section[id="1.12.0"]')).toBeInViewport({ timeout: 15_000 });
        });

        session.assertClean("Journey 5 (what's new / changelog)");
    });
});

test.describe("Release 1.12 (library, panels, stations)", () => {
    let browser: Browser;
    let context: BrowserContext;
    let page: Page;
    let session: DogfoodSession;
    let token = "";
    let api: APIRequestContext;

    test.beforeAll(async ({ browser: launched }) => {
        browser = launched;
        expect(username && password, "KIMA_TEST_USERNAME and KIMA_TEST_PASSWORD must be set").toBeTruthy();
        context = await browser.newContext({ viewport: { width: 1440, height: 900 } });
        page = await context.newPage();
        api = page.request;
        session = new DogfoodSession(page, baseUrl);
        session.attach();
        session.setJourney("0. sign in");
        token = await signIn(page, session, username, password);
        expect(token, "no auth token after signing in").toBeTruthy();
        session.assertClean("sign in");
    });

    test.afterAll(async () => {
        try {
            session?.assertNoneLeft();
        } finally {
            if (session) console.log(`\n[release-112] report written to ${session.writeReport("test-results/release-112-library")}`);
            await context?.close();
        }
    });

    /** The panel's open handle when it is collapsed; the panel is the page's right edge either way. */
    const panelBox = async () => (await page.locator("#activity-panel").boundingBox())!;
    const openPanel = async () => {
        const handle = page.getByRole("button", { name: "open panel" });
        if (await handle.isVisible().catch(() => false)) await handle.click();
        await expect.poll(async () => (await panelBox()).x, { message: "the panel never opened" }).toBeLessThan(1440 - 300);
    };
    /** The id after /tracks/ in the audio element's stream address: the song the player is on. */
    const playingId = async () => {
        const src = (await readPlayer(page)).src;
        return /\/tracks\/([^/?]+)\/stream/.exec(src)?.[1] ?? "";
    };

    // ------------------------------------------------------------------------------------------
    test("6. the queue page is gone: /queue lands on home, and the up next panel lists the queue in the player's order", async () => {
        test.setTimeout(180_000);
        session.setJourney("6. queue in the panel");
        let playlistId = "";
        try {
            await session.step("/queue redirects to home", async () => {
                await page.goto("/queue");
                await page.waitForURL((u) => u.pathname === "/", { timeout: 15_000 });
                await settle(page, 1000);
                expect(new URL(page.url()).pathname).toBe("/");
            });

            let ids: string[] = [];
            let titles: string[] = [];
            await session.step("build a playlist of four library songs and play it from its page", async () => {
                const created = await api.post("/api/playlists", { data: { name: `${RUN_TAG}-queue` }, headers: bearer(token) });
                expect(created.ok(), `creating the playlist returned ${created.status()}`).toBeTruthy();
                const body = await created.json();
                playlistId = body.id ?? body.playlist?.id;
                const picks = await new LibraryPicker(api, token).distinctTitleTracks(4);
                expect(picks.length, "the library needs four songs with different titles").toBe(4);
                for (const t of picks) {
                    const add = await api.post(`/api/playlists/${playlistId}/items`, { data: { trackId: t.id }, headers: bearer(token) });
                    expect(add.ok(), `adding ${t.id} returned ${add.status()}`).toBeTruthy();
                }
                ids = picks.map((t) => t.id);
                titles = picks.map((t) => t.title);
                await page.goto(`/playlist/${playlistId}`);
                await expect(page.locator("[data-track-index]")).toHaveCount(4, { timeout: 15_000 });
                await page.getByRole("button", { name: "Play all" }).click();
                await page.getByTitle("pause", { exact: true }).waitFor({ timeout: 15_000 });
                return { playlistId, first: titles[0] };
            });

            const serverQueue = async (): Promise<string[]> => {
                const state = await (await api.get("/api/playback-state", { headers: bearer(token) })).json();
                const queue = (state?.queue ?? []) as Array<{ id?: string; trackId?: string; track?: { id?: string } }>;
                return queue.map((q) => (q.id ?? q.trackId ?? q.track?.id) as string);
            };
            const rowTitles = () =>
                page.locator("[data-queue-row]").evaluateAll((els) => els.map((el) => el.querySelector("p")?.textContent?.trim() ?? ""));

            await session.step("up next lists the songs after the playing one, and the server's queue has the same order", async () => {
                await openPanel();
                await page.getByRole("tab", { name: /^up next/ }).click();
                await expect(page.locator("[data-queue-row]")).toHaveCount(3);
                expect(await rowTitles()).toEqual(titles.slice(1));
                await expect(page.locator("[data-queue-count]")).toHaveText("4 tracks in the queue");
                await expect(page.getByRole("tab", { name: /^up next/ })).toContainText("3");
                await expect.poll(serverQueue, { timeout: 20_000, message: "the server's queue never matched the playlist" }).toEqual(ids);
                expect(await playingId(), "the player is not on the first song").toBe(ids[0]);
            });

            await session.step("moving a song down in the panel changes the server's order the same way", async () => {
                await page.locator("[data-queue-row]").first().hover();
                await page.getByRole("button", { name: `move ${titles[1]} down` }).click();
                await expect.poll(rowTitles).toEqual([titles[2], titles[1], titles[3]]);
                await expect
                    .poll(serverQueue, { timeout: 20_000, message: "the server's queue did not follow the move" })
                    .toEqual([ids[0], ids[2], ids[1], ids[3]]);
            });

            await session.step("removing a song takes it off both the panel and the server's queue", async () => {
                await page.locator("[data-queue-row]").first().hover();
                await page.getByRole("button", { name: `remove ${titles[2]} from the queue` }).click();
                await expect.poll(rowTitles).toEqual([titles[1], titles[3]]);
                await expect.poll(serverQueue, { timeout: 20_000 }).toEqual([ids[0], ids[1], ids[3]]);
            });

            await session.step("clearing the queue empties the panel (puts the queue back)", async () => {
                await page.getByRole("button", { name: "clear queue" }).first().click();
                await page.getByRole("dialog").getByRole("button", { name: "clear queue" }).click();
                await expect(page.locator("[data-queue-row]")).toHaveCount(0);
                await expect(page.getByText("the queue is empty")).toBeVisible();
                await expect.poll(serverQueue, { timeout: 20_000, message: "the server still holds the cleared queue" }).toEqual([]);
            });

            session.assertClean("Journey 6 (queue in the panel)");
        } finally {
            if (playlistId) {
                await api.delete(`/api/playlists/${playlistId}`, { headers: bearer(token) }).catch(() => {});
            }
        }
    });

    // ------------------------------------------------------------------------------------------
    test("7. the right-hand panel: listening and activity options switch their panels, and the panel hides and reopens", async () => {
        session.setJourney("7. right-hand panel");

        await session.step("the two halves offer exactly the listed options", async () => {
            await page.goto("/");
            await settle(page, 1200);
            await openPanel();
            const names = (label: string) =>
                page
                    .getByRole("tablist", { name: label, exact: true })
                    .getByRole("tab")
                    .evaluateAll((els) => els.map((el) => el.querySelector("span")?.textContent?.trim() ?? ""));
            expect(await names("listening")).toEqual(["up next", "lyrics", "about"]);
            expect(await names("activity")).toEqual(["all", "alerts", "downloads", "imports", "history"]);
        });

        await session.step("each listening option selects itself and changes the panel under it", async () => {
            const tabs = page.getByRole("tablist", { name: "listening", exact: true });
            const panel = page.locator("#panel-listening");
            const seen: string[] = [];
            for (const name of ["lyrics", "about", "up next"]) {
                await tabs.getByRole("tab", { name: new RegExp(`^${name}`) }).click();
                await expect(tabs.getByRole("tab", { name: new RegExp(`^${name}`) })).toHaveAttribute("aria-selected", "true");
                await expect(tabs.locator('[aria-selected="true"]')).toHaveCount(1);
                await expect(panel).toBeVisible();
                seen.push(`${name}:${((await panel.innerText()) || "").length}`);
            }
            // Nothing is playing after the queue was cleared, so up next says so.
            await expect(panel).toContainText("the queue is empty");
            return { seen: seen.join(" ") };
        });

        await session.step("each activity option selects itself and shows its own content", async () => {
            const tabs = page.getByRole("tablist", { name: "activity", exact: true });
            const panel = page.locator("#panel-activity");
            const html: Record<string, string> = {};
            for (const name of ["alerts", "downloads", "imports", "history", "all"]) {
                await tabs.getByRole("tab", { name: new RegExp(`^${name}`) }).click();
                await expect(tabs.getByRole("tab", { name: new RegExp(`^${name}`) })).toHaveAttribute("aria-selected", "true");
                await expect(tabs.locator('[aria-selected="true"]')).toHaveCount(1);
                await expect(panel).toBeVisible();
                await settle(page, 500);
                html[name] = await panel.innerHTML();
            }
            const distinct = new Set(Object.values(html));
            expect(distinct.size, "the activity options all show the same content").toBeGreaterThan(1);
        });

        await session.step("the alerts count matches the server's unread count", async () => {
            const served = await (await api.get("/api/notifications/unread-count", { headers: bearer(token) })).json();
            const unread = Number(served.count ?? served.unreadCount ?? 0);
            const alerts = page.getByRole("tablist", { name: "activity", exact: true }).getByRole("tab", { name: /^alerts/ });
            const text = (await alerts.innerText()).replace(/\D+/g, "");
            expect(Number(text || 0), "the alerts badge differs from the server's unread count").toBe(Math.min(unread, 99));
            return { unread };
        });

        await session.step("hide panel collapses it to a handle, and open panel brings it back", async () => {
            await page.getByRole("button", { name: "hide panel" }).click();
            await expect.poll(async () => (await panelBox()).x, { message: "the panel did not collapse" }).toBeGreaterThan(1440 - 40);
            await expect(page.getByRole("button", { name: "open panel" })).toBeVisible();
            await page.getByRole("button", { name: "open panel" }).click();
            await expect.poll(async () => (await panelBox()).x, { message: "the panel did not reopen" }).toBeLessThan(1440 - 300);
            await expect(page.getByRole("button", { name: "hide panel" })).toBeVisible();
        });

        session.assertClean("Journey 7 (right-hand panel)");
    });

    // ------------------------------------------------------------------------------------------
    test("8. the left rail: mixes show cover mosaics, and releases opens the radar on desktop and in the phone menu", async () => {
        test.setTimeout(120_000);
        session.setJourney("8. rail and releases");

        await session.step("the mixes list shows each mix the server returns, with its covers", async () => {
            await page.goto("/");
            await settle(page, 1500);
            const served = (await (await api.get("/api/mixes", { headers: bearer(token) })).json()) as Array<{
                id: string;
                name: string;
                coverUrls?: string[];
            }>;
            if (served.length === 0) {
                session.noteNotCovered("rail: the server returned no mixes for this user (mixes are built from listening history), so the mix tiles were not checked");
                return { mixes: 0 };
            }
            const tiles = page.locator('nav[aria-label="library"] a[href^="/mix/"], aside a[href^="/mix/"]');
            await expect(tiles).toHaveCount(served.length, { timeout: 15_000 });
            const shown = await tiles.evaluateAll((els) =>
                els.map((el) => ({
                    href: el.getAttribute("href"),
                    name: el.textContent?.trim() ?? "",
                    images: el.querySelectorAll("img").length,
                })),
            );
            expect(shown.map((t) => t.href)).toEqual(served.map((m) => `/mix/${m.id}`));
            expect(shown.map((t) => t.name.toLowerCase())).toEqual(served.map((m) => m.name.toLowerCase()));
            // One cover shows as one image; two or more as a grid of up to four.
            served.forEach((m, i) => {
                const want = Math.min(4, (m.coverUrls ?? []).length);
                expect(shown[i].images, `"${m.name}" shows ${shown[i].images} cover images, the server gave ${want}`).toBe(want);
            });
            return { mixes: served.length, mosaics: served.filter((m) => (m.coverUrls ?? []).length > 1).length };
        });

        await session.step("the releases link opens the release radar, and the radar loads", async () => {
            const radar = page.waitForResponse((r) => r.url().includes("/api/releases/radar"));
            await page.getByRole("navigation", { name: "main navigation" }).getByRole("link", { name: "releases" }).click();
            await page.waitForURL(/\/releases$/, { timeout: 15_000 });
            const res = await radar;
            expect(res.status(), "the release radar did not answer 200").toBe(200);
            const served = await res.json();
            await expect(page.getByRole("heading", { level: 1 })).toHaveText(/new and upcoming/i);
            await expect(page.getByRole("heading", { name: /coming soon/i })).toHaveCount(served.upcoming.length > 0 ? 1 : 0);
            await expect(page.getByRole("heading", { name: /just dropped/i })).toHaveCount(served.recent.length > 0 ? 1 : 0);
            return { upcoming: served.upcoming.length, recent: served.recent.length };
        });

        await session.step("on a phone, the menu lists releases and it opens the radar", async () => {
            const phoneContext = await browser.newContext({
                ...devices["iPhone 13"],
                storageState: await context.storageState(),
            });
            const phone = await phoneContext.newPage();
            session.attach(phone);
            session.setActivePage(phone);
            try {
                await phone.goto("/");
                await settle(phone, 1500);
                // The desktop's open panel carries over in storage and shows as a sheet on the phone.
                const sheet = phone.getByRole("button", { name: "close activity" });
                if (await sheet.isVisible().catch(() => false)) await sheet.tap();
                await phone.getByRole("button", { name: "Open menu" }).tap();
                const link = phone.getByRole("navigation", { name: "menu" }).getByRole("link", { name: "releases" });
                await expect(link).toBeVisible();
                const radar = phone.waitForResponse((r) => r.url().includes("/api/releases/radar"));
                await link.tap();
                await phone.waitForURL(/\/releases$/, { timeout: 15_000 });
                expect((await radar).status()).toBe(200);
            } finally {
                session.setActivePage(page);
                await phoneContext.close();
            }
        });

        session.assertClean("Journey 8 (rail and releases)");
    });

    // ------------------------------------------------------------------------------------------
    test("9. radio: the server's stations are listed, genres are one station each, and a started station plays one of its songs", async () => {
        test.setTimeout(120_000);
        session.setJourney("9. radio stations");
        const radioTiles = (section: string) =>
            page
                .locator("section")
                .filter({ has: page.getByRole("heading", { level: 2, name: section, exact: true }) })
                .locator("button[data-tv-card] h3");

        await session.step("the mood stations on the page are the stations the server lists", async () => {
            const served = ((await (await api.get("/api/library/radio/stations", { headers: bearer(token) })).json()).stations ?? []) as Array<{
                value: string;
                name: string;
                description: string;
            }>;
            expect(served.length, "the server lists no mood stations").toBeGreaterThan(0);
            await page.goto("/radio");
            await settle(page, 2000);
            const section = page.getByRole("heading", { level: 2, name: "By Mood", exact: true });
            if (!(await section.isVisible().catch(() => false))) {
                session.noteNotCovered("radio: the By Mood section is not shown because this instance has no sound vectors yet");
                return { moodSection: "absent", served: served.length };
            }
            const names = await radioTiles("By Mood").allTextContents();
            expect(names).toEqual(served.map((s) => s.name));
            return { stations: names.length };
        });

        await session.step("the genres list has no two spellings of one genre, and the page has one station per genre", async () => {
            const served = ((await (await api.get("/api/library/genres", { headers: bearer(token) })).json()).genres ?? []) as Array<{
                genre: string;
                count: number;
            }>;
            expect(served.length).toBeGreaterThan(0);
            const key = (g: string) => g.normalize("NFKC").toLowerCase().replace(/[\s  ­​﻿_/.·'‘’‐-―⁃−-]+/g, "");
            const keys = served.map((g) => key(g.genre));
            expect(new Set(keys).size, `two entries are one genre: ${keys.filter((k, i) => keys.indexOf(k) !== i).join(", ")}`).toBe(keys.length);
            const names = await radioTiles("By Genre").allTextContents();
            expect(names).toEqual(served.map((g) => g.genre));
            return { genres: served.length };
        });

        await session.step("starting a genre station plays a song from the server's answer for it", async () => {
            const genre = (await radioTiles("By Genre").first().textContent())!;
            const first = page.locator("button[data-tv-card]").filter({ has: page.locator("h3", { hasText: new RegExp(`^${escapeRegExp(genre)}$`) }) });
            const answer = page.waitForResponse((r) => r.url().includes("/api/library/radio?") && r.url().includes("type=genre"));
            await first.click();
            const res = await answer;
            expect(res.status()).toBe(200);
            const tracks = ((await res.json()).tracks ?? []) as Array<{ id: string }>;
            expect(tracks.length, "the station answered with no songs").toBeGreaterThan(0);
            await page.getByTitle("pause", { exact: true }).waitFor({ timeout: 20_000 });
            await expect.poll(playingId, { timeout: 15_000 }).not.toBe("");
            const playing = await playingId();
            expect(tracks.map((t) => t.id), `the player is on ${playing}, which the "${genre}" station did not return`).toContain(playing);
            await page.getByTitle("pause", { exact: true }).click();
            return { genre, songs: tracks.length };
        });

        await session.step("starting a mood station plays a song from its answer, when any song is tagged yet", async () => {
            const served = ((await (await api.get("/api/library/radio/stations", { headers: bearer(token) })).json()).stations ?? []) as Array<{
                value: string;
                name: string;
            }>;
            let pick: { value: string; name: string } | null = null;
            for (const s of served) {
                const r = await api.get(`/api/library/radio?type=mood&value=${s.value}&limit=100`, { headers: bearer(token) });
                if (r.ok() && ((await r.json()).tracks ?? []).length > 0) {
                    pick = s;
                    break;
                }
            }
            if (!pick) {
                session.noteNotCovered("radio: no mood station has a song yet (moods are scored at the end of enrichment), so no mood station was started");
                return { started: "none" };
            }
            await expect(radioTiles("By Mood").first()).toBeVisible();
            const tile = page.locator("button[data-tv-card]").filter({ has: page.locator("h3", { hasText: new RegExp(`^${escapeRegExp(pick.name)}$`) }) });
            const answer = page.waitForResponse((r) => r.url().includes("/api/library/radio?") && r.url().includes("type=mood"));
            await tile.click();
            const tracks = ((await (await answer).json()).tracks ?? []) as Array<{ id: string }>;
            await page.getByTitle("pause", { exact: true }).waitFor({ timeout: 20_000 });
            await expect.poll(playingId, { timeout: 15_000 }).not.toBe("");
            expect(tracks.map((t) => t.id)).toContain(await playingId());
            await page.getByTitle("pause", { exact: true }).click();
            return { started: pick.value };
        });

        session.assertClean("Journey 9 (radio stations)");
    });

    // ------------------------------------------------------------------------------------------
    test("10. track details carry exactly the eight audio features, and the removed endpoints answer 404", async () => {
        session.setJourney("10. audio features and removed endpoints");
        const asked: string[] = [];
        const featureObjects: Array<{ url: string; keys: string[] }> = [];
        const onRequest = (r: { method(): string; url(): string }) => asked.push(`${r.method()} ${r.url()}`);
        const onResponse = async (r: import("@playwright/test").Response) => {
            if (!r.url().includes("/api/") || !(r.headers()["content-type"] ?? "").includes("json")) return;
            const body = await r.json().catch(() => null);
            const walk = (node: unknown) => {
                if (Array.isArray(node)) node.forEach(walk);
                else if (node && typeof node === "object") {
                    const o = node as Record<string, unknown>;
                    if (o.audioFeatures && typeof o.audioFeatures === "object") {
                        featureObjects.push({ url: r.url(), keys: Object.keys(o.audioFeatures as object).sort() });
                    }
                    Object.values(o).forEach(walk);
                }
            };
            walk(body);
        };
        page.on("request", onRequest);
        page.on("response", onResponse);
        try {
            await session.step("pages that list songs get audioFeatures with exactly the eight fields", async () => {
                await page.goto("/collection?tab=tracks");
                await settle(page, 2500);
                await page.goto("/collection?tab=albums");
                await page.locator('a[href^="/album/"]').first().click();
                await page.waitForURL(/\/album\//);
                await settle(page, 2500);
                expect(featureObjects.length, "no response carried audioFeatures, so nothing was checked").toBeGreaterThan(0);
                const want = ["analysisMode", "arousal", "bpm", "danceability", "energy", "instrumentalness", "keyScale", "valence"];
                for (const f of featureObjects) expect(f.keys, `audioFeatures from ${f.url}`).toEqual(want);
                return { objects: featureObjects.length };
            });

            await session.step("a song's own detail answer has the same eight and no raw mood fields", async () => {
                // An analysed song: an unanalysed one has every feature empty, which proves nothing about the keys.
                const analysed = await new LibraryPicker(api, token).analysedTrack();
                if (!analysed) {
                    session.noteNotCovered("audio features: no playable song has been analysed, so a song's own detail answer was not checked");
                    return;
                }
                const detail = await (await api.get(`/api/library/tracks/${analysed.id}`, { headers: bearer(token) })).json();
                expect(Object.keys(detail.audioFeatures).sort()).toEqual(["analysisMode", "arousal", "bpm", "danceability", "energy", "instrumentalness", "keyScale", "valence"]);
                const moodKeys = Object.keys(detail).filter((k) => /^mood[A-Z]/.test(k));
                expect(moodKeys, "the track still carries raw mood fields").toEqual([]);
            });

            await session.step("the removed endpoints answer 404", async () => {
                for (const path of [
                    "/api/vibe/status",
                    "/api/recommendations/tracks?seedTrackId=x",
                    "/api/recommendations?seedArtistId=x",
                    "/api/recommendations/albums?seedAlbumId=x",
                    "/api/releases/recent",
                    "/api/releases/upcoming",
                    "/api/offline/stats",
                    "/api/plays",
                    "/api/artists/preview/x/y",
                    "/api/downloads",
                    "/api/downloads/x",
                    "/api/discover/generate/status/x",
                    "/api/discover/exclusions",
                    "/api/library/cover-art-colors?url=x",
                    "/api/analysis/track/x",
                    "/api/browse/playlists/featured",
                ]) {
                    const res = await api.get(path, { headers: bearer(token) });
                    expect(res.status(), `GET ${path}`).toBe(404);
                }
                for (const [method, path] of [
                    ["POST", "/api/spotify/parse"],
                    ["POST", "/api/offline/albums/x/download"],
                    ["POST", "/api/offline/tracks/x/complete"],
                    ["DELETE", "/api/offline/albums/x"],
                    ["PATCH", "/api/downloads/x"],
                    ["DELETE", "/api/discover/exclusions"],
                    ["DELETE", "/api/discover/exclusions/x"],
                    ["POST", "/api/playlists/x/pending/reconcile"],
                ]) {
                    const res = await api.fetch(path, { method, headers: bearer(token), data: {} });
                    expect(res.status(), `${method} ${path}`).toBe(404);
                }
            });

            await session.step("the pages opened here never asked for a removed endpoint", async () => {
                // Plays and downloads keep their POST and DELETE; only the GET forms were removed.
                const removed = asked.filter((u) => /^GET \S*\/api\/(vibe\/status|recommendations(\/tracks|\/albums)?|releases\/(recent|upcoming)|offline\/|plays|downloads(\/(?!failed)[^/?]+)?|artists\/preview\/[^/]+\/[^/?]+|discover\/(generate\/status|exclusions)|library\/cover-art-colors|browse\/playlists\/featured|analysis\/track\/[^/?]+)(\?|$)/.test(u) || /\/api\/offline\//.test(u));
                expect(removed).toEqual([]);
            });

            session.assertClean("Journey 10 (audio features and removed endpoints)");
        } finally {
            page.off("request", onRequest);
            page.off("response", onResponse);
        }
    });

    // ------------------------------------------------------------------------------------------
    test("11. library only: the collection lists library albums, and the Refine panel fits the screen at three sizes", async () => {
        test.setTimeout(180_000);
        session.setJourney("11. library only and refine");
        // An album cover held at an outside address that no longer has it: the cover proxy answers not-found by design.
        session.expectFailure({
            urlPattern: /\/api\/library\/cover-art\?url=/,
            status: 404,
            reason: "a library album's cover is gone from the outside site it was fetched from",
        });

        await session.step("every album the collection lists is a library album", async () => {
            const answer = page.waitForResponse((r) => /\/api\/library\/albums\?/.test(r.url()));
            await page.goto("/collection?tab=albums");
            const res = await answer;
            expect(res.status()).toBe(200);
            const served = (await res.json()) as { albums: Array<{ id: string; location: string }>; total: number };
            expect(served.albums.length).toBeGreaterThan(0);
            expect(served.albums.filter((a) => a.location !== "LIBRARY").map((a) => `${a.id}:${a.location}`)).toEqual([]);
            const cards = page.locator('#main-content a[href^="/album/"]');
            await expect(cards).toHaveCount(served.albums.length, { timeout: 15_000 });
            // Read every page: one request cannot be assumed to hold the whole library.
            const all = { albums: [] as Array<{ location: string }>, total: 0 };
            for (let offset = 0; ; offset += 1000) {
                const part = (await (await api.get(`/api/library/albums?limit=1000&offset=${offset}`, { headers: bearer(token) })).json()) as { albums: Array<{ location: string }>; total: number };
                all.albums.push(...part.albums);
                all.total = part.total;
                if (part.albums.length < 1000 || all.albums.length >= part.total) break;
            }
            expect(all.albums.length).toBe(all.total);
            expect(new Set(all.albums.map((a) => a.location))).toEqual(new Set(["LIBRARY"]));
            return { shown: served.albums.length, total: all.total };
        });

        const sizes = [
            { w: 1440, h: 900 },
            { w: 1024, h: 768 },
            { w: 390, h: 844 },
        ];
        try {
            for (const { w, h } of sizes) {
                await session.step(`the Refine panel fits a ${w}x${h} window and every control can be reached`, async () => {
                    await page.setViewportSize({ width: w, height: h });
                    await page.goto("/collection?tab=albums");
                    await expect(page.locator('a[href^="/album/"]').first()).toBeVisible({ timeout: 15_000 });
                    // The desktop's open panel carries over in storage and covers the page as a sheet below the desktop width.
                    const sheet = page.getByRole("button", { name: "close activity" });
                    if (await sheet.isVisible().catch(() => false)) await sheet.click();
                    await page.getByRole("button", { name: /^Refine/ }).click({ timeout: 10_000 });
                    const panel = page.locator("#refine-panel");
                    await expect(panel).toBeVisible();
                    await expect(panel).toHaveAttribute("aria-label", "Refine options");
                    const inside = async (box: { x: number; y: number; width: number; height: number }) => {
                        expect(box.x, "left edge outside the window").toBeGreaterThanOrEqual(-1);
                        expect(box.y, "top edge outside the window").toBeGreaterThanOrEqual(-1);
                        expect(box.x + box.width, "right edge outside the window").toBeLessThanOrEqual(w + 1);
                        expect(box.y + box.height, "bottom edge outside the window").toBeLessThanOrEqual(h + 1);
                    };
                    // The panel slides in; measure once it has stopped.
                    await expect
                        .poll(() => panel.evaluate((el) => el.getAnimations().every((a) => a.playState === "finished")))
                        .toBe(true);
                    await inside((await panel.boundingBox())!);
                    // Each choice, after scrolling inside the panel, sits within the panel and the window.
                    const radios = panel.getByRole("radio");
                    const count = await radios.count();
                    expect(count).toBeGreaterThanOrEqual(9);
                    for (let i = 0; i < count; i++) {
                        const radio = radios.nth(i);
                        await radio.scrollIntoViewIfNeeded();
                        const box = (await radio.boundingBox())!;
                        const pb = (await panel.boundingBox())!;
                        await inside(box);
                        expect(box.y, `choice ${i} is above the panel`).toBeGreaterThanOrEqual(pb.y - 1);
                        expect(box.y + box.height, `choice ${i} is below the panel`).toBeLessThanOrEqual(pb.y + pb.height + 1);
                    }
                    // The last choice works: pick the largest page size, then reset.
                    await panel.getByRole("radio", { name: "200", exact: true }).click();
                    await expect(page).toHaveURL(/[?&]per=200/);
                    await page.getByRole("button", { name: "Reset" }).click();
                    await expect(page).not.toHaveURL(/[?&]per=/);
                    await page.getByRole("button", { name: "Close refine panel" }).click();
                    await expect(panel).toHaveCount(0);
                    return { size: `${w}x${h}`, choices: count };
                });
            }
        } finally {
            await page.setViewportSize({ width: 1440, height: 900 });
        }

        session.assertClean("Journey 11 (library only and refine)");
        session.clearExpectedFailures();
    });
});
