/**
 * Kima 1.12's non-podcast features, driven through the real UI and checked against the server's own answers:
 * playlist reverse order, per-step enrichment re-runs, update pings, operator-only downloads, and the
 * What's new / changelog doors. Every test puts back what it changed.
 */
import { test, expect, Browser, BrowserContext, Page, APIRequestContext } from "@playwright/test";
import { DogfoodSession } from "./session";
import { settle, softwareWebGL } from "../fixtures/shared";

const baseUrl = process.env.KIMA_UI_BASE_URL || "http://127.0.0.1:3030";
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

                const res = await api.get("/api/library/tracks?limit=40", { headers: bearer(token) });
                const all = ((await res.json()).tracks ?? []) as Array<{ id: string; title: string }>;
                // Distinct titles so a row can be told apart on screen.
                const seen = new Set<string>();
                const picks = all.filter((t) => (seen.has(t.title) ? false : (seen.add(t.title), true))).slice(0, 4);
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
                const list = (await (await api.get("/api/library/artists?limit=50", { headers: bearer(token) })).json()).artists as Array<{ id: string }>;
                for (const a of list) {
                    const d = await (await api.get(`/api/library/artists/${a.id}`, { headers: bearer(token) })).json();
                    if ((d.albums ?? []).some((al: { owned?: boolean }) => al.owned === false)) {
                        artistId = a.id;
                        break;
                    }
                }
                expect(artistId, "no library artist has albums that could be downloaded").toBeTruthy();
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
                await openArtist();
                await expect(member.getByRole("button", { name: /download all/i })).toHaveCount(0);
                expect(await downloadNames(member), "the member sees download controls on the artist page").toEqual([]);

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
                await openArtist();
                await expect(member.getByRole("button", { name: /download all/i })).toBeVisible({ timeout: 20_000 });
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
                await openArtist();
                await expect(member.getByRole("button", { name: /download all/i })).toHaveCount(0);
                expect(await downloadNames(member)).toEqual([]);
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
