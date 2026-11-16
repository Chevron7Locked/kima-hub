/**
 * Refreshing a followed show: the feed's ETag and Last-Modified are saved only once its episodes are stored, and an
 * episode already stored takes the feed's changed fields while keeping its id and the person's progress.
 * Real database; the feed fetch is replaced by a fixed parsed feed.
 */
import { prisma } from "../../utils/db";
import { rssParserService } from "../rss-parser";
import { refreshPodcastFeed } from "../podcastRefresh";

jest.mock("../rss-parser", () => ({
    rssParserService: { parseFeed: jest.fn() },
    FeedReadError: class FeedReadError extends Error {},
}));

const P = "pod_refresh_store";
const USER = "pod_refresh_user";
const parseFeed = rssParserService.parseFeed as unknown as jest.Mock;

const feedEpisode = (guid: string, over: Record<string, unknown> = {}) => ({
    guid,
    title: `Episode ${guid}`,
    description: "notes",
    audioUrl: `https://cdn.example.invalid/${guid}.mp3`,
    duration: 1800,
    publishedAt: new Date("2026-01-01T00:00:00Z"),
    fileSize: 1000,
    mimeType: "audio/mpeg",
    ...over,
});

const feed = (episodes: ReturnType<typeof feedEpisode>[], etag = '"v2"') => ({
    notModified: false,
    podcast: { title: "A Show", categoryNames: [] },
    episodes,
    etag,
    lastModified: "Mon, 02 Feb 2026 00:00:00 GMT",
});

beforeEach(async () => {
    jest.restoreAllMocks();
    parseFeed.mockReset();
    await prisma.podcastProgress.deleteMany({ where: { episodeId: { startsWith: P } } });
    await prisma.podcastDownload.deleteMany({ where: { episodeId: { startsWith: P } } });
    await prisma.podcastEpisode.deleteMany({ where: { podcastId: P } });
    await prisma.podcast.deleteMany({ where: { id: P } });
    await prisma.user.deleteMany({ where: { id: USER } });
    await prisma.user.create({ data: { id: USER, username: USER, passwordHash: "x", role: "user" } });
    await prisma.podcast.create({
        data: {
            id: P,
            feedUrl: "https://feeds.example.invalid/refresh",
            title: "A Show",
            categoryIds: [1],
            feedEtag: '"v1"',
            feedLastModified: "Sun, 01 Feb 2026 00:00:00 GMT",
            episodes: {
                create: [{
                    id: `${P}-ep1`, guid: "g1", title: "Old title", description: "old notes",
                    audioUrl: "https://cdn.example.invalid/old.mp3", duration: 100, fileSize: 5,
                    publishedAt: new Date("2025-12-01T00:00:00Z"),
                }],
            },
        },
    });
});

afterAll(async () => {
    await prisma.podcastProgress.deleteMany({ where: { episodeId: { startsWith: P } } });
    await prisma.podcastDownload.deleteMany({ where: { episodeId: { startsWith: P } } });
    await prisma.podcastEpisode.deleteMany({ where: { podcastId: P } });
    await prisma.podcast.deleteMany({ where: { id: P } });
    await prisma.user.deleteMany({ where: { id: USER } });
});

const show = () => prisma.podcast.findUniqueOrThrow({ where: { id: P } });

it("saves the feed's validators once its episodes are stored", async () => {
    parseFeed.mockResolvedValue(feed([feedEpisode("g1"), feedEpisode("g2")]));

    expect(await refreshPodcastFeed(P)).toEqual({ newEpisodesCount: 1, totalEpisodes: 2 });

    const row = await show();
    expect(row.feedEtag).toBe('"v2"');
    expect(row.feedLastModified).toBe("Mon, 02 Feb 2026 00:00:00 GMT");
    expect(await prisma.podcastEpisode.count({ where: { podcastId: P } })).toBe(2);
});

it("keeps the old validators when storing an episode fails, so the next refresh reads the feed again", async () => {
    parseFeed.mockResolvedValue(feed([feedEpisode("g2"), feedEpisode("g3")]));
    const upsert = jest.spyOn(prisma.podcastEpisode, "upsert");
    upsert.mockRejectedValueOnce(new Error("database went away"));

    await expect(refreshPodcastFeed(P)).rejects.toThrow("database went away");

    const row = await show();
    expect(row.feedEtag).toBe('"v1"');
    expect(row.feedLastModified).toBe("Sun, 01 Feb 2026 00:00:00 GMT");
});

it("updates an episode already stored to the feed's current fields, keeping its id and progress", async () => {
    await prisma.podcastProgress.create({
        data: { userId: USER, episodeId: `${P}-ep1`, currentTime: 42, duration: 100 },
    });
    parseFeed.mockResolvedValue(feed([feedEpisode("g1", {
        title: "New title",
        description: "new notes",
        audioUrl: "https://cdn.example.invalid/new.mp3",
        duration: 2400,
        fileSize: 9000,
        publishedAt: new Date("2026-01-05T00:00:00Z"),
    })]));

    expect(await refreshPodcastFeed(P)).toEqual({ newEpisodesCount: 0, totalEpisodes: 1 });

    const ep = await prisma.podcastEpisode.findUniqueOrThrow({ where: { id: `${P}-ep1` } });
    expect(ep).toMatchObject({
        guid: "g1",
        title: "New title",
        description: "new notes",
        audioUrl: "https://cdn.example.invalid/new.mp3",
        duration: 2400,
        fileSize: 9000,
    });
    expect(ep.publishedAt.toISOString()).toBe("2026-01-05T00:00:00.000Z");
    const progress = await prisma.podcastProgress.findFirstOrThrow({ where: { episodeId: `${P}-ep1`, userId: USER } });
    expect(progress.currentTime).toBe(42);
});

it("clears a description the feed no longer gives", async () => {
    parseFeed.mockResolvedValue(feed([feedEpisode("g1", { description: undefined })]));
    await refreshPodcastFeed(P);
    const ep = await prisma.podcastEpisode.findUniqueOrThrow({ where: { id: `${P}-ep1` } });
    expect(ep.description).toBeNull();
});

it("leaves the measured length and size of an episode whose copy is cached", async () => {
    await prisma.podcastDownload.create({
        data: { userId: USER, episodeId: `${P}-ep1`, localPath: "/cache/x.mp3", fileSizeMb: 1 },
    });
    parseFeed.mockResolvedValue(feed([feedEpisode("g1", { duration: 2400, fileSize: 9000, title: "New title" })]));

    await refreshPodcastFeed(P);

    const ep = await prisma.podcastEpisode.findUniqueOrThrow({ where: { id: `${P}-ep1` } });
    expect(ep.title).toBe("New title");
    expect(ep.duration).toBe(100);
    expect(ep.fileSize).toBe(5);
});

it("keeps the stored date, length and size when the feed gives none of its own", async () => {
    parseFeed.mockResolvedValue(feed([feedEpisode("g1", {
        publishedAt: new Date(), publishedGiven: false, duration: 0, fileSize: undefined,
    })]));

    await refreshPodcastFeed(P);

    const ep = await prisma.podcastEpisode.findUniqueOrThrow({ where: { id: `${P}-ep1` } });
    expect(ep.publishedAt.toISOString()).toBe("2025-12-01T00:00:00.000Z");
    expect(ep.duration).toBe(100);
    expect(ep.fileSize).toBe(5);
});

it("counts an episode once when the feed lists its guid twice", async () => {
    parseFeed.mockResolvedValue(feed([feedEpisode("g2"), feedEpisode("g2")]));
    expect(await refreshPodcastFeed(P)).toEqual({ newEpisodesCount: 1, totalEpisodes: 2 });
});

it("a 304 changes nothing but the refresh time", async () => {
    parseFeed.mockResolvedValue({ notModified: true });
    await refreshPodcastFeed(P);
    const row = await show();
    expect(row.feedEtag).toBe('"v1"');
    expect(await prisma.podcastEpisode.count({ where: { podcastId: P } })).toBe(1);
});
