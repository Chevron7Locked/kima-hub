/**
 * The podcast browser as a user walks it, checked against the server's own answers: the podcasts page
 * (continue listening, for you, categories, top shows, a category's chart), a show not yet followed (description,
 * categories, episodes, its first-episode snippet playing, more like this), and "your shows" sorted by latest
 * episode. Real server, real Apple Podcasts; a console error or 5xx fails the spec like the walkthrough.
 */
import { test, expect, type APIRequestContext, type Locator, type Page } from "@playwright/test";
import { DogfoodSession } from "./session";
import { outsideFailure } from "./podcastReplies";
import { loginAsTestUser, getAuthToken } from "../fixtures/test-helpers";

const baseUrl = process.env.KIMA_UI_BASE_URL || "http://127.0.0.1:3030";
// Dungeons and Daddies: a long-running show with plenty of episodes, used by the other podcast specs.
const SEED_SHOW = "1450241676";
// Two more long-running shows, so "latest episode" has several shows with different newest dates to order.
const SORT_SHOWS = [SEED_SHOW, "201671138", "152249110"];

type Chart = Array<{ itunesId: string; title: string; chartRank: number | null }>;
type Cat = { id: number; name: string; parentId: number | null };
type Listing = { inProgress: Array<{ podcast: { id: string }; episode: { id: string; title: string } }> };

test.describe.configure({ mode: "serial" });

let session: DogfoodSession;
let page: Page;
let auth: { Authorization: string };
let api: APIRequestContext;
// What this spec created, undone in afterAll: shows it followed (not ones already followed) and progress it saved.
const followedHere: string[] = [];
const progressHere: Array<{ podcastId: string; episodeId: string }> = [];

const get = async (path: string) => {
    const res = await api.get(`/api/podcasts${path}`, { headers: auth });
    const blocked = await outsideFailure(res, path);
    if (blocked) test.skip(true, blocked);
    return res.json();
};

/** Follows a show unless this user already does; remembers it was followed here so afterAll can undo it. */
async function follow(itunesId: string): Promise<string> {
    const preview = await get(`/preview/${itunesId}`);
    if (preview.isSubscribed) return preview.subscribedPodcastId;
    const res = await api.post("/api/podcasts/subscribe", { headers: auth, data: { itunesId } });
    const blocked = await outsideFailure(res, `follow ${itunesId}`);
    if (blocked) test.skip(true, blocked);
    const id: string = (await res.json()).podcast.id;
    followedHere.push(id);
    return id;
}

/** The distinct links under a locator, in page order. */
const hrefsIn = async (root: Locator, prefix: string) => {
    const all = [...new Set(await root.locator(`a[href^="${prefix}"]`).evaluateAll((els) => els.map((e) => e.getAttribute("href") ?? "")))];
    // Under /podcasts/ the links wanted are shows; a section's "show all" link to a chart is not one.
    return prefix === "/podcasts/" ? all.filter((h) => !h.startsWith("/podcasts/category/")) : all;
};

const sectionTitled = (p: Page, title: string) => p.locator("section").filter({ has: p.getByRole("heading", { name: title, exact: true }) });

test.beforeAll(async ({ browser }) => {
    const context = await browser.newContext({ viewport: { width: 1440, height: 900 } });
    page = await context.newPage();
    api = page.request;
    session = new DogfoodSession(page, baseUrl);
    session.attach();
    // The sign-in page asks who is signed in before anyone is; that 401 is the answer, not a fault.
    session.expectFailure({ urlPattern: /\/api\/auth\/me/, status: 401, reason: "no session before sign-in" });
    // A show's first-episode snippet is played through an Audio element the page makes and never attaches.
    await page.addInitScript(() => {
        const w = window as unknown as { __played: HTMLMediaElement[] };
        w.__played = [];
        const play = HTMLMediaElement.prototype.play;
        HTMLMediaElement.prototype.play = function (this: HTMLMediaElement) {
            w.__played.push(this);
            return play.call(this);
        };
    });
    await loginAsTestUser(page);
    session.clearExpectedFailures();
    auth = { Authorization: `Bearer ${await getAuthToken(page)}` };
});

test.afterAll(async () => {
    for (const { podcastId, episodeId } of progressHere) {
        await api.delete(`/api/podcasts/${podcastId}/episodes/${episodeId}/progress`, { headers: auth }).catch(() => {});
    }
    for (const id of followedHere) await api.delete(`/api/podcasts/${id}/unsubscribe`, { headers: auth }).catch(() => {});
    session.assertNoneLeft();
    await page.context().close();
});

test("the podcasts page shows continue listening, for you, every category and the top shows; a category opens its chart", async () => {
    test.setTimeout(240_000);
    session.setJourney("podcasts page");
    const podcastId = await follow(SEED_SHOW);
    const episodes = (await get(`/${podcastId}/episodes?order=newest&limit=3`)).episodes as Array<{ id: string; title: string }>;
    const started = await api.post(`/api/podcasts/${podcastId}/episodes/${episodes[0].id}/progress`, {
        headers: auth,
        data: { currentTime: 60, duration: 4000 },
    });
    expect(started.ok()).toBe(true);
    progressHere.push({ podcastId, episodeId: episodes[0].id });

    const listening: Listing = await get("/listening");
    const forYou: Array<{ category: Cat; podcasts: Array<{ itunesId: string }> }> = await get("/for-you");
    const categories: Cat[] = await get("/categories");
    const top: Chart = await get("/charts?limit=24");
    const topLevel = categories.filter((c) => c.parentId === null);
    expect(listening.inProgress.map((r) => r.episode.id)).toContain(episodes[0].id);
    expect(topLevel.length).toBeGreaterThan(0);
    expect(top.length).toBeGreaterThan(0);

    await session.step("open the podcasts page", async () => {
        await page.goto("/podcasts");
        await expect(page.getByRole("heading", { level: 1, name: "podcasts" })).toBeVisible();
    });

    await session.step("continue listening has every in-progress episode, each with a resume control", async () => {
        const section = sectionTitled(page, "continue listening");
        await expect(section).toBeVisible();
        for (const row of listening.inProgress) {
            await expect(section.getByRole("button", { name: `resume ${row.episode.title}` })).toBeAttached();
        }
        return { episodes: listening.inProgress.length };
    });

    await session.step("for you rows match the server's rows", async () => {
        // Rows show the server's categories in order, each with its shows.
        const headings = await page.getByRole("heading", { level: 2 }).filter({ hasText: /^for you · / }).allTextContents();
        expect(forYou.length, "following a show gives for-you rows").toBeGreaterThan(0);
        expect(headings).toEqual(forYou.map((r) => `for you · ${r.category.name}`));
        for (const row of forYou) {
            const section = sectionTitled(page, `for you · ${row.category.name}`);
            expect(await hrefsIn(section, "/podcasts/")).toEqual(
                [...new Set(row.podcasts.map((p) => `/podcasts/${p.itunesId}`))],
            );
        }
        return { rows: forYou.length };
    });

    await session.step("browse lists every top-level category", async () => {
        const nav = page.getByRole("navigation", { name: "podcast categories" });
        expect(await hrefsIn(nav, "/podcasts/category/")).toEqual(topLevel.map((c) => `/podcasts/category/${c.id}`));
        expect(await nav.getByRole("link").allTextContents()).toEqual(topLevel.map((c) => c.name));
        return { categories: topLevel.length };
    });

    await session.step("top shows are the overall chart, in rank order", async () => {
        const section = sectionTitled(page, "top shows");
        const shown = await hrefsIn(section, "/podcasts/");
        expect(shown).toEqual(top.map((s) => `/podcasts/${s.itunesId}`));
        return { shows: top.length };
    });

    // Prefer a category that has sub-categories, so the sub-category tabs are checked too.
    const parentWithKids = topLevel.find((c) => categories.some((k) => k.parentId === c.id)) ?? topLevel[0];
    await session.step(`opening ${parentWithKids.name} shows its chart`, async () => {
        const chart: Chart = await get(`/charts?category=${parentWithKids.id}&limit=48`);
        await page.getByRole("navigation", { name: "podcast categories" }).getByRole("link", { name: parentWithKids.name, exact: true }).click();
        await page.waitForURL(new RegExp(`/podcasts/category/${parentWithKids.id}$`));
        await expect(page.getByRole("heading", { level: 1, name: parentWithKids.name, exact: true })).toBeVisible();
        const grid = page.locator(".grid-media");
        await expect(grid.locator('a[href^="/podcasts/"]').first()).toBeVisible();
        const shown = await hrefsIn(grid, "/podcasts/");
        expect(shown).toEqual(chart.map((s) => `/podcasts/${s.itunesId}`));
        const kids = categories.filter((k) => k.parentId === parentWithKids.id);
        if (kids.length > 0) {
            const tabs = page.getByRole("navigation", { name: "podcast categories" });
            await expect(tabs.getByRole("link", { name: `all ${parentWithKids.name}`, exact: true })).toHaveAttribute("aria-current", "page");
            expect(await tabs.getByRole("link").allTextContents()).toEqual([`all ${parentWithKids.name}`, ...kids.map((k) => k.name)]);
        }
        return { category: parentWithKids.name, shows: chart.length };
    });
    session.assertClean("podcasts page");
});

test("a show not yet followed previews its description, categories, episodes and first-episode snippet, then lists more like it", async () => {
    test.setTimeout(240_000);
    session.setJourney("show preview");
    const top: Chart = await get("/charts?limit=24");
    // The first top show that is unfollowed and has a readable feed with episodes and a first episode to sample.
    let pick: { itunesId: string; data: Record<string, any> } | null = null; // eslint-disable-line @typescript-eslint/no-explicit-any
    for (const s of top) {
        const data = await get(`/preview/${s.itunesId}`);
        if (!data.isSubscribed && data.previewEpisodes?.length > 0 && data.snippet && data.description) {
            pick = { itunesId: s.itunesId, data };
            break;
        }
    }
    if (!pick) {
        session.noteNotCovered("show preview: no top show was unfollowed with a readable feed");
        test.skip(true, "no previewable top show");
        return;
    }
    const { data } = pick;
    const similar: Chart = await get(`/preview/${pick.itunesId}/similar`);
    expect(data.previewEpisodes.length).toBeLessThanOrEqual(20);

    await session.step("open the show from top shows", async () => {
        await page.goto("/podcasts");
        const card = sectionTitled(page, "top shows").locator(`a[href="/podcasts/${pick!.itunesId}"]`).first();
        await card.scrollIntoViewIfNeeded();
        await card.click();
        await page.waitForURL(new RegExp(`/podcasts/${pick!.itunesId}$`));
        await expect(page.getByRole("heading", { level: 1, name: data.title, exact: true })).toBeVisible();
    });

    await session.step("description and categories match the server's", async () => {
        const about = sectionTitled(page, "about");
        await expect(about).toBeVisible();
        const words = (s: string) => s.replace(/<[^>]*>/g, " ").replace(/&amp;/g, "&").replace(/\s+/g, " ").trim();
        const wanted = words(data.description).slice(0, 40);
        expect((await about.innerText()).replace(/\s+/g, " ")).toContain(wanted.toLowerCase());
        for (const c of (data.categories as Array<{ id: number }>).slice(0, 4)) {
            await expect(page.locator(`a[href="/podcasts/category/${c.id}"]`).first()).toBeAttached();
        }
        return { categories: data.categories.length };
    });

    await session.step("the episode list is the server's newest episodes, at most 20", async () => {
        const list = sectionTitled(page, "latest episodes").locator("ol > li");
        await expect(list).toHaveCount(data.previewEpisodes.length);
        expect(await list.locator("h3").allTextContents()).toEqual(data.previewEpisodes.map((e: { title: string }) => e.title));
        return { episodes: data.previewEpisodes.length };
    });

    await session.step("the first-episode snippet plays and advances", async () => {
        const snippetReply = page.waitForResponse((r) => r.url().includes(`/preview/${pick!.itunesId}/snippet`) && r.request().method() === "GET", { timeout: 60_000 });
        await page.getByRole("button", { name: `play the first episode, ${data.snippet.title}` }).click();
        const reply = await snippetReply;
        expect([200, 206]).toContain(reply.status());
        await expect(page.getByRole("button", { name: "stop the first episode" })).toBeVisible();
        const position = () =>
            page.evaluate(() => {
                const played = (window as unknown as { __played: HTMLMediaElement[] }).__played;
                const a = played[played.length - 1];
                return a && !a.paused ? a.currentTime : -1;
            });
        await expect.poll(position, { timeout: 60_000 }).toBeGreaterThan(0.5);
        const first = await position();
        await expect.poll(position, { timeout: 30_000 }).toBeGreaterThan(first + 1);
        await page.getByRole("button", { name: "stop the first episode" }).click();
        await expect(page.getByRole("button", { name: `play the first episode, ${data.snippet.title}` })).toBeVisible();
        return { advancedTo: Math.round(await page.evaluate(() => (window as unknown as { __played: HTMLMediaElement[] }).__played.at(-1)!.currentTime)) };
    });

    await session.step("more like this lists the server's similar shows", async () => {
        const section = sectionTitled(page, "more like this");
        if (similar.length === 0) {
            await expect(section).toHaveCount(0);
            session.noteNotCovered("show preview: the server returned no similar shows for the picked show");
            return { shows: 0 };
        }
        await expect(section).toBeVisible();
        const shown = await hrefsIn(section, "/podcasts/");
        expect(shown).toEqual([...new Set(similar.map((s) => `/podcasts/${s.itunesId}`))]);
        return { shows: similar.length };
    });
    session.assertClean("show preview");
});

test("your shows sorted by latest episode run newest first, as the server's newest episode dates say", async () => {
    test.setTimeout(300_000);
    session.setJourney("sort by latest episode");
    for (const id of SORT_SHOWS) await follow(id);
    type Mine = Array<{ id: string; title: string; author: string; latestEpisodeAt: string | null }>;
    const time = (p: { latestEpisodeAt: string | null }) => (p.latestEpisodeAt ? new Date(p.latestEpisodeAt).getTime() : 0);
    const orders = (list: Mine) => {
        const byDate = [...list].sort((a, b) => time(b) - time(a)).map((p) => p.id);
        const byTitle = [...list].sort((a, b) => a.title.localeCompare(b.title)).map((p) => p.id);
        const byAuthor = [...list].sort((a, b) => a.author.localeCompare(b.author)).map((p) => p.id);
        return { byDate, differs: byDate.join() !== byTitle.join() && byDate.join() !== byAuthor.join() };
    };
    let mine: Mine = await (await api.get("/api/podcasts", { headers: auth })).json();
    // The order by date must differ from the order by title and by author, or the sort proves nothing: follow more chart shows until it does.
    for (const s of (await get("/charts?limit=12")) as Chart) {
        if (orders(mine).differs) break;
        await follow(s.itunesId);
        mine = await (await api.get("/api/podcasts", { headers: auth })).json();
    }
    expect(mine.length).toBeGreaterThanOrEqual(2);
    expect(orders(mine).differs, "newest-episode order must differ from title and author order").toBe(true);
    const dateOf = new Map(mine.map((p) => [`/podcasts/${p.id}`, time(p)]));
    expect(new Set(dateOf.values()).size, "the shows need different newest dates for the order to mean anything").toBeGreaterThan(1);

    await session.step("choose latest episode", async () => {
        await page.goto("/podcasts");
        const grid = page.locator('[data-tv-section="your-shows"]');
        await expect(grid.locator('a[href^="/podcasts/"]').first()).toBeVisible();
        const sort = page.getByRole("combobox", { name: "sort your shows" });
        await expect(sort).toHaveValue("title");
        await sort.selectOption({ label: "latest episode" });
        await expect(sort).toHaveValue("latest");
    });

    await session.step("the shows' order on screen is newest first by the server's dates", async () => {
        const grid = page.locator('[data-tv-section="your-shows"]');
        const datesOnScreen = async () => (await hrefsIn(grid, "/podcasts/")).map((h) => dateOf.get(h));
        await expect.poll(async () => {
            const dates = await datesOnScreen();
            return dates.length > 0 && dates.every((d, i) => d !== undefined && (i === 0 || dates[i - 1]! >= d));
        }, { message: "cards run newest episode first" }).toBe(true);
        const shown = await hrefsIn(grid, "/podcasts/");
        expect(shown.length).toBe(Math.min(mine.length, 50));
        return { shows: shown.length };
    });
    session.assertClean("sort by latest episode");
});
