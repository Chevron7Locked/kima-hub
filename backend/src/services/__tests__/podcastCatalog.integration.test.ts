/**
 * The podcast catalog reads Apple's real replies (recorded by scripts/record-apple-podcasts.ts): the category tree,
 * per-category charts, and each show's categories. Real database and Redis.
 */
import { loadRecording, startReplayServer, type ReplayServer } from "../../__tests__/helpers/replayServer";
import { prisma } from "../../utils/db";
import { waitForRedisReady } from "../../utils/redis";
import { clearCatalogCache } from "./helpers/catalogCache";
import * as catalog from "../podcastCatalog";

const recording = loadRecording("apple", "catalog");
let replay: ReplayServer;

const DND = "1450241676";
const P = "pod_catalog_dnd";

beforeAll(async () => {
    replay = await startReplayServer(recording);
    process.env.ITUNES_BASE_URL = replay.url;
    await waitForRedisReady();
    await clearCatalogCache();
    await prisma.podcast.deleteMany({ where: { id: P } });
});

// The cache is cleared before each run, not after: the shared client reaper has closed Redis by then.
afterAll(async () => {
    await prisma.podcast.deleteMany({ where: { id: P } });
    delete process.env.ITUNES_BASE_URL;
    await replay.close();
});

it("reads Apple's whole category tree, sub-categories under their parents", async () => {
    const tree = await catalog.categoryTree();
    expect(tree.filter((c) => c.parentId === null)).toHaveLength(19);
    expect(tree).toContainEqual({ id: 1495, name: "Improv", parentId: 1303 });
    expect(tree).toContainEqual({ id: 1507, name: "Games", parentId: 1502 });
    expect(tree.some((c) => c.id === 26)).toBe(false);
});

it("reads a category's chart in rank order with large artwork and Apple's description", async () => {
    const improv = await catalog.chart(1495);
    expect(improv).toHaveLength(200);
    expect(improv.map((p) => p.chartRank).slice(0, 3)).toEqual([1, 2, 3]);
    const dnd = improv.find((p) => p.itunesId === DND)!;
    expect(dnd.title).toBe("Dungeons and Daddies");
    expect(dnd.chartRank).toBeLessThanOrEqual(20);
    expect(dnd.description.length).toBeGreaterThan(20);
    expect(dnd.coverUrl).toMatch(/600x600bb\./);
});

it("reads the overall chart without a category", async () => {
    const top = await catalog.chart(null);
    expect(top.length).toBeGreaterThan(100);
    expect(top[0].chartRank).toBe(1);
});

it("names a show's categories most specific first, without Apple's root", async () => {
    const shows = await catalog.lookupShows([DND, "1276705357", "367330921", "not-an-id"]);
    expect(shows.get(DND)!.categoryIds).toEqual([1495, 1303, 1502, 1507]);
    expect(shows.get("1276705357")!.categoryIds).toEqual([1485, 1483, 1486]);
    expect(shows.get("367330921")!.categoryIds).toEqual([1303]);
    expect(shows.has("not-an-id")).toBe(false);
});

it("maps a feed's own category names onto Apple's ids and drops names Apple does not use", async () => {
    expect(await catalog.categoryIdsForNames(["Comedy", "TV & Film", "Not A Category"])).toEqual([1303, 1309]);
});

it("stores a show's categories from Apple, else from its feed", async () => {
    await prisma.podcast.create({ data: { id: P, feedUrl: "https://feeds.example.invalid/dnd", title: "Dungeons and Daddies", itunesId: DND } });
    expect(await catalog.assignCategories(P, DND)).toEqual([1495, 1303, 1502, 1507]);
    expect((await prisma.podcast.findUniqueOrThrow({ where: { id: P } })).categoryIds).toEqual([1495, 1303, 1502, 1507]);
    expect(await catalog.assignCategories(P, null, ["Fiction", "Comedy Fiction"])).toEqual([1483, 1486]);
});

it("samples a show by its oldest dated episode with audio", () => {
    const ep = (title: string, date: string, audioUrl = "https://a.invalid/x.mp3") => ({ title, publishedAt: new Date(date), audioUrl });
    const feed = [ep("S4 Ep. 15", "2026-10-01"), ep("Ep. 1 - A Man and His Handshake", "2019-02-14"), ep("Season 4 Trailer", "2025-01-01")];
    expect(catalog.oldestEpisode(feed)?.title).toBe("Ep. 1 - A Man and His Handshake");
    expect(catalog.oldestEpisode([ep("no date", "not a date"), ep("no audio", "2010-01-01", "")])).toBeNull();
});
