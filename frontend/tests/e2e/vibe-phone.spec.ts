import { test, expect } from "@playwright/test";
import type { Page } from "@playwright/test";
import { escapeRegExp, readPlayer, softwareWebGL } from "./fixtures/shared";
import { requireBaseUrl } from "./fixtures/target";
import { dismissWhatsNew } from "./fixtures/test-helpers";

// The phone layout of /vibe at 390x664, driven through the real page: it signs in on the login page,
// keeps the app's Bearer token (the app sets no cookie), and reads every number back from the rendered
// page. Nothing is intercepted; the tracks come from the app's own /api/vibe/map answer.

const BASE_URL = requireBaseUrl();
const USERNAME = process.env.KIMA_TEST_USERNAME ?? "";
const PASSWORD = process.env.KIMA_TEST_PASSWORD ?? "";
if (!USERNAME || !PASSWORD) {
    throw new Error("Export KIMA_TEST_USERNAME and KIMA_TEST_PASSWORD before running E2E tests.");
}

const PHONE = {
    viewport: { width: 390, height: 664 },
    isMobile: true,
    hasTouch: true,
    deviceScaleFactor: 3,
};

test.use({ ...PHONE, ...softwareWebGL });

const FIELD = '[data-testid="vibe-map-field"]';
const SEARCH = '[aria-label="Search tracks or artists"]';
const RESULTS = "#vibe-search-results";
const HANDLE = '[role="separator"][aria-label="vibe panel"]';

/** The peek height with a track playing: handle 44 + player 52 + search 52. */
const PEEK_WITH_PLAYBACK = 44 + 52 + 52;
/** How far a measured peek height may differ from the expected one. */
const PEEK_TOLERANCE = 4;

interface Rect {
    x: number;
    y: number;
    width: number;
    height: number;
}

interface MapTrack {
    id: string;
    title: string;
    artist: string;
}

interface SheetState {
    main: Rect;
    /** The sheet's positioning host — the element whose height the full stop is measured against. */
    host: Rect;
    sheet: Rect;
    field: Rect;
    snap: string | null;
    viewport: { width: number; height: number };
}

function must<T>(value: T | null, what: string): T {
    if (value === null) throw new Error(`${what} has no bounding box`);
    return value;
}

function bottomOf(r: Rect): number {
    return r.y + r.height;
}

function rightOf(r: Rect): number {
    return r.x + r.width;
}

// ---------------------------------------------------------------------------
// Signing in
// ---------------------------------------------------------------------------

/**
 * Signs in through the real login page. The form mounts after
 * domcontentloaded, so it is waited for rather than sampled once. A missing
 * token is an error: without it /api/vibe/map is a 401 and no layout can be
 * measured.
 */
async function signIn(page: Page): Promise<{ token: string; refresh: string | null }> {
    await page.goto("/login", { waitUntil: "domcontentloaded" });

    const username = page.locator("#username");
    await expect(username, "the login form must mount").toBeVisible({ timeout: 30_000 });
    await username.fill(USERNAME);
    await page.locator("#password").fill(PASSWORD);
    await page.getByRole("button", { name: /^sign in$/i }).click();

    try {
        // The app stores the token before redirecting; a wrong password leaves
        // the page on /login with the server's message.
        await page.waitForURL((url) => !url.pathname.startsWith("/login"), { timeout: 30_000 });
    } catch {
        const message = await page
            .locator('[role="alert"], .text-danger-light')
            .first()
            .innerText()
            .catch(() => "");
        throw new Error(
            `signing in as ${USERNAME} produced no auth_token${message ? `: ${message.trim()}` : ""}`,
        );
    }

    const token = await page.evaluate(() => localStorage.getItem("auth_token"));
    if (!token) {
        throw new Error(`signing in as ${USERNAME} stored no auth_token, so /api/vibe/map cannot be called`);
    }
    const refresh = await page.evaluate(() => localStorage.getItem("refresh_token"));
    return { token, refresh };
}

let auth: { token: string; refresh: string | null } | undefined;

test.beforeAll(async ({ browser }) => {
    const context = await browser.newContext({ ...PHONE, baseURL: BASE_URL });
    const page = await context.newPage();
    try {
        auth = await signIn(page);
    } finally {
        await context.close();
    }
});

/**
 * The map payload, read from the app's own endpoint with the Bearer token this
 * run signed in for. A 401/403 here is a real failure — the run has a token —
 * never a reason to skip. A 202 means the map is still being laid out.
 */
async function readMapTracks(page: Page): Promise<MapTrack[]> {
    if (!auth) throw new Error("the sign-in hook did not produce a token");

    for (let attempt = 0; attempt < 20; attempt++) {
        const response = await page.request.get("/api/vibe/map", {
            headers: { Authorization: `Bearer ${auth.token}` },
            failOnStatusCode: false,
        });
        const status = response.status();
        if (status === 401 || status === 403) {
            throw new Error(`GET /api/vibe/map answered ${status} with the Bearer token this run signed in for`);
        }
        if (status === 202) {
            await page.waitForTimeout(1000);
            continue;
        }
        if (!response.ok()) throw new Error(`GET /api/vibe/map answered ${status}`);
        const data = (await response.json()) as { tracks?: MapTrack[] };
        return Array.isArray(data.tracks) ? data.tracks : [];
    }

    test.skip(true, "GET /api/vibe/map stayed at 202 (the map is still computing) for 20 s; there is no laid-out map to measure");
    throw new Error("unreachable: test.skip aborts the test");
}

/**
 * Opens /vibe with the signed-in token, clears the What's New window, and
 * reads the map. An instance with no analysed library renders its empty state
 * and never mounts the sheet; that is a skip with the measured reason, not a
 * pass.
 */
async function enterVibe(page: Page): Promise<MapTrack[]> {
    const tracks = await readMapTracks(page);
    if (tracks.length < 2) {
        test.skip(
            true,
            `signed in as ${USERNAME}; GET /api/vibe/map accepted the Bearer token and returned ${tracks.length} track(s). ` +
                "This instance has no analysed library, so /vibe renders its empty state and no sheet exists to measure.",
        );
    }

    await expect(page.locator(FIELD).first(), "the vibe map must render").toBeVisible({ timeout: 35_000 });
    // The sheet measures itself from its host after mount, and the opening
    // camera flight is GL-only; give the DOM a beat to settle.
    await page.waitForTimeout(800);
    return tracks;
}

let mapTracks: MapTrack[] = [];

test.beforeEach(async ({ page }) => {
    if (!auth) throw new Error("the sign-in hook did not produce a token");
    await page.addInitScript(({ token, refresh }) => {
        localStorage.setItem("auth_token", token);
        if (refresh) localStorage.setItem("refresh_token", refresh);
    }, auth);

    await page.goto("/vibe", { waitUntil: "domcontentloaded" });
    await dismissWhatsNew(page);
    mapTracks = await enterVibe(page);
});

// ---------------------------------------------------------------------------
// Geometry read back from the page
// ---------------------------------------------------------------------------

/** The page content, the sheet's host, the sheet, the map field and the reported snap. */
async function readSheet(page: Page): Promise<SheetState> {
    const state = await page.evaluate(() => {
        const rect = (el: Element | null): Rect | null => {
            if (!el) return null;
            const r = el.getBoundingClientRect();
            return { x: r.x, y: r.y, width: r.width, height: r.height };
        };
        const sheet = document.querySelector('[data-testid="vibe-sheet"]');
        return {
            main: rect(document.querySelector("#main-content")),
            host: rect(sheet?.parentElement ?? null),
            sheet: rect(sheet),
            field: rect(document.querySelector('[data-testid="vibe-map-field"]')),
            snap: sheet?.getAttribute("data-snap") ?? null,
            viewport: { width: window.innerWidth, height: window.innerHeight },
        };
    });

    if (!state.main) throw new Error("#main-content is missing");
    if (!state.host) throw new Error("the sheet's host is missing");
    if (!state.sheet) throw new Error("the sheet is missing");
    if (!state.field) throw new Error("the vibe map field is missing");
    return state as SheetState;
}

/** The sheet's height animates for 340 ms after a snap change; wait that out before measuring. */
async function waitForSheetToRest(page: Page): Promise<void> {
    await page.waitForTimeout(600);
}

/** The part of the sheet that is inside the page content. */
function visibleHeight(state: SheetState): number {
    const top = Math.max(state.sheet.y, state.main.y);
    const bottom = Math.min(bottomOf(state.sheet), bottomOf(state.main));
    return Math.max(0, bottom - top);
}

/**
 * Drags the sheet by its handle to a screen y. The pause before release keeps
 * the fling velocity near zero, so the sheet settles on the snap point nearest
 * the release position rather than continuing with the throw.
 */
async function dragSheet(page: Page, toY: number): Promise<void> {
    const handle = must(await page.locator(HANDLE).boundingBox(), "the sheet handle");
    const fromX = handle.x + handle.width / 2;
    const fromY = handle.y + handle.height / 2;

    await page.mouse.move(fromX, fromY);
    await page.mouse.down();
    const steps = 16;
    for (let i = 1; i <= steps; i++) {
        await page.mouse.move(fromX, fromY + ((toY - fromY) * i) / steps);
        await page.waitForTimeout(18);
    }
    await page.waitForTimeout(160);
    await page.mouse.up();
    await page.waitForTimeout(900);
}

async function openHalf(page: Page): Promise<SheetState> {
    const before = await readSheet(page);
    await dragSheet(page, before.host.y + before.host.height * 0.5);
    await expect(page.getByTestId("vibe-sheet")).toHaveAttribute("data-snap", "half", { timeout: 8_000 });
    return readSheet(page);
}

async function openFull(page: Page): Promise<SheetState> {
    const before = await readSheet(page);
    await dragSheet(page, before.host.y + 2);
    await expect(page.getByTestId("vibe-sheet")).toHaveAttribute("data-snap", "full", { timeout: 8_000 });
    return readSheet(page);
}

async function closeToPeek(page: Page): Promise<SheetState> {
    const before = await readSheet(page);
    await dragSheet(page, before.host.y + before.host.height + 60);
    await expect(page.getByTestId("vibe-sheet")).toHaveAttribute("data-snap", "peek", { timeout: 8_000 });
    return readSheet(page);
}

// ---------------------------------------------------------------------------
// Search and playback
// ---------------------------------------------------------------------------

/**
 * Words from the map's own titles that a search can be built from: folded the
 * way the sheet folds a query (NFD, combining marks stripped, lower-cased),
 * split on anything that is not a letter or digit, and kept at two characters
 * or more because the field needs that much to search. The sheet matches a
 * query word as a substring of "title artist" (features/vibe/librarySearch.ts,
 * searchLibrary), so a word taken from a title matches at least the track it
 * came from. Candidates are deduplicated in map order.
 */
function titleWords(tracks: MapTrack[]): string[] {
    const seen = new Set<string>();
    const words: string[] = [];
    for (const { title } of tracks) {
        const folded = title.normalize("NFD").replace(/[\u0300-\u036f]/g, "").toLowerCase();
        for (const word of folded.split(/[^\p{L}\p{N}]+/u)) {
            if (word.length < 2 || seen.has(word)) continue;
            seen.add(word);
            words.push(word);
        }
    }
    return words;
}

/**
 * A query this instance's own library can answer. Each candidate is typed into
 * the sheet's field and kept only once its results list shows a track, so the
 * spec never asserts on a word the library may not contain.
 */
async function libraryQuery(page: Page, tracks: MapTrack[]): Promise<string> {
    const words = titleWords(tracks);
    if (words.length === 0) {
        test.skip(true, `none of the ${tracks.length} map titles holds a word of two characters or more to search for`);
    }

    const input = page.locator(SEARCH);
    await expect(input, "the sheet must offer a search field").toBeVisible({ timeout: 8_000 });
    const option = page.locator(`${RESULTS} [role="option"]`).first();
    const tried = words.slice(0, 8);

    for (const word of tried) {
        await input.fill(word);
        const matched = await option
            .waitFor({ state: "visible", timeout: 3_000 })
            .then(() => true)
            .catch(() => false);
        if (!matched) continue;

        const clear = page.getByRole("button", { name: /clear search/i });
        if (await clear.isVisible().catch(() => false)) {
            await clear.click();
            await expect(page.locator(RESULTS)).toHaveCount(0);
        } else {
            await input.fill("");
        }
        return word;
    }

    test.skip(
        true,
        `no title word returned a search result on this library (tried ${tried.length} of ${words.length}: ${tried.join(", ")})`,
    );
    throw new Error("unreachable: test.skip aborts the test");
}

/** Types a query the library is known to answer and picks the first result; returns the title it showed. */
async function pickFirstResult(page: Page, query: string): Promise<string> {
    const input = page.locator(SEARCH);
    await input.fill(query);

    const option = page.locator(`${RESULTS} [role="option"]`).first();
    await expect(option, "the search must offer results").toBeVisible({ timeout: 10_000 });
    const title = (await option.innerText())
        .split("\n")
        .map((line) => line.trim())
        .filter(Boolean)[0] ?? "";
    expect(title, "a search result should carry a title").not.toBe("");

    await option.click();
    // A selection opens the sheet at its half stop.
    await expect(page.getByTestId("vibe-sheet")).toHaveAttribute("data-snap", "half", { timeout: 8_000 });
    await page.waitForTimeout(400);
    return title;
}

/**
 * Starts the picked track from the sheet's own action and waits until the
 * audio element really has a source and is not paused. An instance that cannot
 * open a stream for the track skips the playing-state tests with that
 * reason; a stream that opens but never plays is a failure.
 */
async function playPicked(page: Page): Promise<void> {
    const actions = page.getByTestId("vibe-sheet-actions");
    await expect(actions, "the sheet must show the picked track's actions").toBeVisible({ timeout: 8_000 });
    const play = actions.getByRole("button", { name: /^play this track$/i }).first();
    await expect(play, "the sheet must offer a play control for the picked track").toBeVisible({ timeout: 5_000 });
    await play.click();

    const opened = await expect
        .poll(async () => (await readPlayer(page)).src, { timeout: 20_000 })
        .not.toBe("")
        .then(() => true)
        .catch(() => false);
    if (!opened) {
        test.skip(true, "the picked track opened no audio stream, so the playing-state layout cannot be measured on this instance");
    }

    await expect.poll(async () => (await readPlayer(page)).paused, { timeout: 20_000 }).toBe(false);
    await expect(page.getByTestId("vibe-peek-player"), "the sheet's now-playing row must appear once a track plays").toBeVisible({
        timeout: 10_000,
    });
}

/** Visible "now playing" regions and where they live, as the page reports them. */
async function nowPlayingRegions(page: Page) {
    return page.evaluate(() => {
        const sheet = document.querySelector('[data-testid="vibe-sheet"]');
        const main = document.querySelector("#main-content");
        const visible = (el: Element) => {
            const r = el.getBoundingClientRect();
            const s = getComputedStyle(el);
            return r.width > 0 && r.height > 0 && s.display !== "none" && s.visibility !== "hidden" && s.opacity !== "0";
        };
        const all = [...document.querySelectorAll('[aria-label="now playing"]')].filter(visible);
        return {
            total: all.length,
            insideSheet: all.filter((el) => !!sheet && sheet.contains(el)).length,
            outsideSheet: all.filter((el) => !sheet || !sheet.contains(el)).length,
            outsideMain: all.filter((el) => !main || !main.contains(el)).length,
        };
    });
}

// ---------------------------------------------------------------------------

test.describe("Vibe, phone layout", () => {
    // one bottom surface. No floating mini player outside the
    // sheet on /vibe; exactly one "now playing" region, inside the sheet.
    test("one bottom surface: no floating player outside the sheet", async ({ page }) => {
        const query = await libraryQuery(page, mapTracks);
        const title = await pickFirstResult(page, query);
        await playPicked(page);
        await closeToPeek(page);

        const regions = await nowPlayingRegions(page);
        expect(regions.total, "exactly one now-playing region may be visible").toBe(1);
        expect(regions.insideSheet, "the now-playing region must sit inside the sheet").toBe(1);
        expect(regions.outsideSheet, "no now-playing region may float outside the sheet").toBe(0);
        expect(regions.outsideMain, "no now-playing region may float outside the page content").toBe(0);

        const peek = page.getByTestId("vibe-peek-player");
        await expect(peek, "the sheet's peek row must show the playing track").toBeVisible();
        await expect(peek).toContainText(new RegExp(escapeRegExp(title), "i"));

        // The surface at the content's foot is the sheet, not a player under it.
        const state = await readSheet(page);
        const hit = await page.evaluate(
            ({ cx, y }) => {
                const el = document.elementFromPoint(cx, y);
                const sheet = document.querySelector('[data-testid="vibe-sheet"]');
                return {
                    insideSheet: !!el && !!sheet && (el === sheet || sheet.contains(el)),
                    tag: el?.tagName ?? null,
                };
            },
            { cx: state.main.x + state.main.width / 2, y: bottomOf(state.main) - 10 },
        );
        expect(hit.insideSheet, `the surface at the content's foot must be the sheet (hit ${hit.tag})`).toBe(true);
    });

    // the sheet reports its snap state via data-snap.
    test("the sheet reports its snap state through data-snap", async ({ page }) => {
        const sheet = page.getByTestId("vibe-sheet");
        await expect(sheet, "the sheet element must exist").toBeVisible({ timeout: 8_000 });
        expect(["peek", "half", "full"], "data-snap must name one of the three positions").toContain(
            await sheet.getAttribute("data-snap"),
        );
        await expect(sheet, "the resting sheet must report peek").toHaveAttribute("data-snap", "peek");

        await openHalf(page);
        await expect(sheet, "an opened sheet must report half").toHaveAttribute("data-snap", "half");

        await openFull(page);
        await expect(sheet, "a sheet dragged to the top must report full").toHaveAttribute("data-snap", "full");
    });

    // at peek with a track playing, the visible height is 148 px
    // (handle 44 + player row 52 + search 52), within a few px.
    test("at peek with a track playing the sheet is 148 px tall", async ({ page }) => {
        const query = await libraryQuery(page, mapTracks);
        await pickFirstResult(page, query);
        await playPicked(page);
        const peek = await closeToPeek(page);

        await expect(page.getByTestId("vibe-peek-player"), "the playing row must be present at peek").toBeVisible();
        expect(peek.snap, "the sheet must report peek").toBe("peek");

        const visible = visibleHeight(peek);
        expect(
            Math.abs(visible - PEEK_WITH_PLAYBACK),
            `peek with playback must be ${PEEK_WITH_PLAYBACK} px (handle 44 + player 52 + search 52), measured ${visible}`,
        ).toBeLessThanOrEqual(PEEK_TOLERANCE);

        expect(
            Math.abs(peek.sheet.height - PEEK_WITH_PLAYBACK),
            `the sheet's own box must be ${PEEK_WITH_PLAYBACK} px at peek with playback, measured ${peek.sheet.height}`,
        ).toBeLessThanOrEqual(PEEK_TOLERANCE);
    });

    // picking a search result opens the sheet to half, and the
    // queue tab bar is fully on screen while a track is playing.
    test("picking a search result opens the sheet to half with the queue tab on screen", async ({ page }) => {
        const query = await libraryQuery(page, mapTracks);
        await pickFirstResult(page, query);
        await playPicked(page);

        const half = await readSheet(page);
        expect(half.snap, "a pick must open the sheet to half").toBe("half");

        const queue = page.getByTestId("vibe-sheet").getByRole("tab", { name: /^queue$/i }).first();
        await expect(queue, "the sheet must carry a queue tab").toBeVisible({ timeout: 5_000 });
        const box = must(await queue.boundingBox(), "the queue tab");
        const sheetBottom = Math.min(bottomOf(half.sheet), bottomOf(half.main));

        expect(
            bottomOf(box),
            `the queue tab's bottom (${bottomOf(box).toFixed(1)}) must not pass the sheet's bottom (${sheetBottom.toFixed(1)})`,
        ).toBeLessThanOrEqual(sheetBottom + 0.5);
        expect(box.y, "the queue tab must be inside the sheet").toBeGreaterThanOrEqual(half.sheet.y - 1);
        expect(box.y, "the queue tab must be on screen").toBeGreaterThanOrEqual(0);
        expect(bottomOf(box), "the queue tab must be on screen").toBeLessThanOrEqual(half.viewport.height + 0.5);

        // The whole tab bar, not just the button's text. The 1px allowance is
        // fractional CSS layout (the sheet's height is an integer px while the
        // row's line boxes are not); it is not a licence to sit below the
        // sheet — the bar's bottom is at the sheet's own edge.
        const bar = must(await queue.locator("xpath=..").boundingBox(), "the queue tab bar");
        expect(
            bottomOf(bar),
            `the tab bar's bottom (${bottomOf(bar).toFixed(2)}) must not pass the sheet's bottom (${sheetBottom.toFixed(2)})`,
        ).toBeLessThanOrEqual(sheetBottom + 1);
    });

    // search lives in the sheet; results stay inside it and clear
    // of the actions.
    test("search lives in the sheet and its results stay inside it, clear of the actions", async ({ page }) => {
        const query = await libraryQuery(page, mapTracks);
        // A picked track puts the action row on screen, so the results have
        // something to stay clear of.
        await pickFirstResult(page, query);

        const input = page.locator(SEARCH);
        await expect(input, "the search field must exist once").toHaveCount(1);
        const inside = await page.evaluate(() => {
            const field = document.querySelector('[aria-label="Search tracks or artists"]');
            const sheet = document.querySelector('[data-testid="vibe-sheet"]');
            return !!field && !!sheet && sheet.contains(field);
        });
        expect(inside, "the search field must be a descendant of the sheet").toBe(true);

        await input.fill(query);
        const results = page.locator(RESULTS);
        await expect(results, "the results list must open").toBeVisible({ timeout: 10_000 });

        const state = await readSheet(page);
        const list = must(await results.boundingBox(), "the results list");
        expect(list.y, "the results must not sit above the sheet").toBeGreaterThanOrEqual(state.sheet.y - 0.5);
        expect(list.x, "the results must not spill past the sheet's left edge").toBeGreaterThanOrEqual(state.sheet.x - 0.5);
        expect(rightOf(list), "the results must not spill past the sheet's right edge").toBeLessThanOrEqual(
            rightOf(state.sheet) + 0.5,
        );
        expect(bottomOf(list), "the results must not spill below the sheet").toBeLessThanOrEqual(
            bottomOf(state.sheet) + 0.5,
        );

        // The action row is hidden while the results are open; measure it only when it is on the page.
        const actions = page.locator('[data-testid="vibe-sheet-actions"]');
        const actionsBox = (await actions.count()) ? await actions.boundingBox() : null;
        const buttonBoxes: Rect[] = await page.evaluate(() =>
            [...document.querySelectorAll("button")]
                .filter((b) => /^(play this track|match vibe|similar|song path)\b/i.test(b.getAttribute("aria-label") ?? ""))
                .map((b) => {
                    const r = b.getBoundingClientRect();
                    return { x: r.x, y: r.y, width: r.width, height: r.height };
                }),
        );
        const intersects = (a: Rect, b: Rect | null) =>
            !!b && a.x < rightOf(b) && b.x < rightOf(a) && a.y < bottomOf(b) && b.y < bottomOf(a);
        const geometry = {
            intersectsActions: intersects(list, actionsBox),
            intersectsButton: buttonBoxes.some((button) => intersects(list, button)),
        };

        expect(geometry.intersectsActions, "the results must not cover the sheet's action row").toBe(false);
        expect(geometry.intersectsButton, "the results must not cover an action button").toBe(false);
    });

    // dragging the handle to the top makes the sheet full: the whole page content, top to bottom,
    // so the queue and lyrics get the height.
    test("dragging the handle to the top makes the sheet fill the page", async ({ page }) => {
        const full = await openFull(page);
        expect(full.snap, "the sheet must report full").toBe("full");

        expect(
            Math.abs(full.sheet.height - full.host.height),
            `the full sheet must be its host's height (${full.host.height.toFixed(1)} px), measured ${full.sheet.height.toFixed(1)}`,
        ).toBeLessThanOrEqual(2);
        expect(Math.abs(full.sheet.y - full.host.y), "the full sheet must reach the host's top").toBeLessThanOrEqual(1);
        expect(
            Math.abs(bottomOf(full.sheet) - bottomOf(full.host)),
            "the sheet must stay anchored to the host's bottom",
        ).toBeLessThanOrEqual(1);
    });

    // an open sheet's scrim covers the map and blurs it.
    test("an open sheet's scrim covers the map and has a backdrop blur", async ({ page }) => {
        const half = await openHalf(page);
        const scrim = page.getByTestId("vibe-sheet-scrim");
        await expect(scrim, "an open sheet must show its scrim").toBeVisible({ timeout: 5_000 });

        const style = await page.evaluate(() => {
            const el = document.querySelector('[data-testid="vibe-sheet-scrim"]');
            if (!el) return null;
            const s = getComputedStyle(el);
            return { backdropFilter: s.backdropFilter, webkit: s.getPropertyValue("-webkit-backdrop-filter") };
        });
        expect(style, "the scrim must exist").not.toBeNull();
        const filter = (style!.backdropFilter || style!.webkit || "").trim();
        expect(filter, "the scrim must set a backdrop-filter, not none").not.toBe("none");
        expect(filter, `the scrim's backdrop-filter must blur the map, got "${filter}"`).toMatch(/blur\(\s*[1-9]/);

        // The scrim takes pointer events, so it must be the element hit over the map.
        const cx = Math.round(half.main.x + half.main.width / 2);
        const y = Math.round(half.sheet.y - 40);
        const hit = await page.evaluate(
            ({ cx, y }) => {
                const el = document.elementFromPoint(cx, y);
                const scrim = document.querySelector('[data-testid="vibe-sheet-scrim"]');
                return {
                    isScrim: !!el && !!scrim && (el === scrim || scrim.contains(el)),
                    tag: el?.tagName ?? null,
                    testid: el?.getAttribute("data-testid") ?? null,
                };
            },
            { cx, y },
        );
        expect(
            hit.isScrim,
            `the scrim must cover the map above the sheet at (${cx}, ${y}); the hit was ${hit.tag}[${hit.testid}]`,
        ).toBe(true);
    });

    // The blur behind the sheet does not flicker off while the sheet is dragged, and fades in with the drag up from peek.
    test("the scrim keeps its blur during a drag, and fades in as the sheet is pulled up from peek", async ({ page }) => {
        const scrimState = () =>
            page.evaluate(() => {
                const el = document.querySelector('[data-testid="vibe-sheet-scrim"]');
                if (!el) return null;
                const style = getComputedStyle(el);
                return { filter: style.backdropFilter || style.getPropertyValue("-webkit-backdrop-filter"), opacity: Number(style.opacity) };
            });
        const grabHandle = async () => {
            const handle = must(await page.locator(HANDLE).boundingBox(), "the sheet handle");
            const x = handle.x + handle.width / 2;
            const y = handle.y + handle.height / 2;
            await page.mouse.move(x, y);
            await page.mouse.down();
            return { x, y };
        };
        const moveTo = async (x: number, from: number, to: number) => {
            for (let i = 1; i <= 8; i++) {
                await page.mouse.move(x, from + ((to - from) * i) / 8);
                await page.waitForTimeout(18);
            }
            await page.waitForTimeout(120);
        };

        // Half to full: the blur stays on the whole way.
        const half = await openHalf(page);
        let grip = await grabHandle();
        await moveTo(grip.x, grip.y, half.host.y + half.host.height * 0.25);
        const midDrag = await scrimState();
        await page.mouse.up();
        await waitForSheetToRest(page);
        expect(midDrag, "the scrim must stay while the sheet is dragged").not.toBeNull();
        expect(midDrag!.filter, `mid-drag the scrim must still blur the map, got "${midDrag!.filter}"`).toMatch(/blur\(\s*[1-9]/);

        // Peek, part of the way to half: the blur is already fading in, not waiting for the release.
        const peek = await closeToPeek(page);
        grip = await grabHandle();
        const halfY = peek.host.y + peek.host.height * 0.5;
        await moveTo(grip.x, grip.y, grip.y + (halfY - grip.y) * 0.4);
        const pulling = await scrimState();
        await page.mouse.move(grip.x, grip.y);
        await page.mouse.up();
        await waitForSheetToRest(page);
        expect(pulling, "pulling up from peek must already show the scrim").not.toBeNull();
        expect(pulling!.filter, `the scrim must blur while pulling up, got "${pulling!.filter}"`).toMatch(/blur\(\s*[1-9]/);
        expect(pulling!.opacity, "part of the way up, the scrim must be part of the way in").toBeGreaterThan(0.05);
        expect(pulling!.opacity, "part of the way up, the scrim must not be fully in yet").toBeLessThan(0.95);
    });

    // a scrim tap returns the sheet to peek.
    test("a scrim tap returns the sheet to peek", async ({ page }) => {
        const peekBefore = await readSheet(page);
        const peekHeight = visibleHeight(peekBefore);

        const half = await openHalf(page);
        await page.mouse.click(Math.round(half.main.x + half.main.width / 2), Math.round(half.sheet.y - 40));

        await expect(page.getByTestId("vibe-sheet")).toHaveAttribute("data-snap", "peek", { timeout: 8_000 });
        await waitForSheetToRest(page);
        const after = await readSheet(page);
        expect(
            Math.abs(visibleHeight(after) - peekHeight),
            `the sheet must return to its peek height (${peekHeight} px), measured ${visibleHeight(after)}`,
        ).toBeLessThanOrEqual(2);
        // Back at peek the scrim is hidden: nothing blurs the map and taps reach it.
        const scrim = page.getByTestId("vibe-sheet-scrim");
        await expect(scrim).toBeHidden();
        await expect(scrim).toHaveCSS("pointer-events", "none");
    });

    // Grabbing the sheet while it settles holds the blur where it was, rather than jumping it to the end of its fade.
    test("grabbing the sheet mid-settle holds the scrim's fade where it was", async ({ page }) => {
        const peek = (await readSheet(page)).sheet.height;
        const half = await openHalf(page);
        // Transitions at a tenth of their speed, so the grab lands mid-settle wherever the handle has got to.
        const cdp = await page.context().newCDPSession(page);
        await cdp.send("Animation.enable");
        await cdp.send("Animation.setPlaybackRate", { playbackRate: 0.1 });
        await page.mouse.click(Math.round(half.main.x + half.main.width / 2), Math.round(half.sheet.y - 40));
        await page.waitForTimeout(400);
        const handle = must(await page.locator(HANDLE).boundingBox(), "the sheet handle");
        await page.mouse.move(handle.x + handle.width / 2, handle.y + handle.height / 2);
        await page.mouse.down();
        const held = await page.evaluate(() => {
            const sheet = document.querySelector('[data-testid="vibe-sheet"]')!.getBoundingClientRect().height;
            const scrim = Number(getComputedStyle(document.querySelector('[data-testid="vibe-sheet-scrim"]')!).opacity);
            return { sheet, scrim };
        });
        await page.mouse.up();
        await cdp.send("Animation.setPlaybackRate", { playbackRate: 1 });
        await waitForSheetToRest(page);
        const along = (held.sheet - peek) / (half.sheet.height - peek);
        expect(along, "the grab must land while the sheet is still on its way down").toBeGreaterThan(0.2);
        expect(along, "the grab must land while the sheet is still on its way down").toBeLessThan(0.95);
        expect(
            Math.abs(held.scrim - along),
            `the scrim must match the sheet's height at the grab: opacity ${held.scrim}, sheet ${Math.round(along * 100)}% of the way up`,
        ).toBeLessThan(0.1);
    });

    // dragging down from half returns the sheet to peek.
    test("dragging down from half returns the sheet to peek", async ({ page }) => {
        const peekBefore = await readSheet(page);
        const peekHeight = visibleHeight(peekBefore);

        const half = await openHalf(page);
        await dragSheet(page, half.host.y + half.host.height + 60);

        await expect(page.getByTestId("vibe-sheet")).toHaveAttribute("data-snap", "peek", { timeout: 8_000 });
        const after = await readSheet(page);
        expect(
            Math.abs(visibleHeight(after) - peekHeight),
            `the sheet must return to its peek height (${peekHeight} px), measured ${visibleHeight(after)}`,
        ).toBeLessThanOrEqual(2);
    });

    // the mood legend is a compact control, not a full-width band.
    test("the mood legend is a compact control, not a full-width band", async ({ page }) => {
        const chip = page.locator('button[aria-label="Moods"]');
        await expect(chip, "the compact mood control must be visible at rest").toBeVisible({ timeout: 5_000 });

        const box = must(await chip.boundingBox(), "the mood control");
        const state = await readSheet(page);
        expect(box.width, `the mood control must be compact, measured ${box.width} px wide`).toBeLessThanOrEqual(200);
        expect(box.width, "the mood control must not be a full-width band").toBeLessThan(state.viewport.width * 0.5);
        expect(box.height, "the mood control must be one chip tall").toBeLessThanOrEqual(48);

        const bands = page.locator('[role="group"][aria-label="Moods in your library"]');
        for (let i = 0; i < (await bands.count()); i++) {
            const band = await bands.nth(i).boundingBox();
            if (band) {
                expect(band.width, "a mood group must not span the page at rest").toBeLessThan(
                    state.viewport.width * 0.9,
                );
            }
        }

        await chip.click();
        const dialog = page.getByRole("dialog", { name: "Moods in your library" });
        await expect(dialog, "the compact control must open the mood list").toBeVisible({ timeout: 5_000 });
    });

    // Escape steps full -> half -> peek.
    test("Escape steps the sheet full to half to peek", async ({ page }) => {
        const peekBefore = await readSheet(page);
        const peekHeight = visibleHeight(peekBefore);

        const full = await openFull(page);
        const fullHeight = visibleHeight(full);
        expect(full.snap, "the sheet must be full for this journey").toBe("full");

        await page.keyboard.press("Escape");
        await expect(page.getByTestId("vibe-sheet")).toHaveAttribute("data-snap", "half", { timeout: 8_000 });
        await waitForSheetToRest(page);
        const half = await readSheet(page);
        // The half stop grows to clear the selected track's actions and the tab
        // bar, so on a tall sheet it can reach the full height; the snap
        // sequence is what is checked, and the peek height is fixed.
        expect(visibleHeight(half), "Escape must not grow the sheet past full").toBeLessThanOrEqual(fullHeight + 0.5);
        expect(visibleHeight(half), "Escape must not jump past half to peek").toBeGreaterThanOrEqual(peekHeight);

        await page.keyboard.press("Escape");
        await expect(page.getByTestId("vibe-sheet")).toHaveAttribute("data-snap", "peek", { timeout: 8_000 });
        await waitForSheetToRest(page);
        const peek = await readSheet(page);
        expect(
            Math.abs(visibleHeight(peek) - peekHeight),
            `Escape must return the sheet to its peek height (${peekHeight} px), measured ${visibleHeight(peek)}`,
        ).toBeLessThanOrEqual(2);
    });
});
