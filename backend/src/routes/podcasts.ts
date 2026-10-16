import { Router, Response } from "express";
import { logger } from "../utils/logger";
import { withTimeout } from "../utils/timeout";
import { forgetSearchesOf } from "../services/search";
import { upstreamFailure, upstreamUnreachable } from "../utils/upstream";
import { requireAuth, requireAuthOrToken } from "../middleware/auth";
import { prisma, Prisma } from "../utils/db";
import { FeedReadError, rssParserService } from "../services/rss-parser";
import { parseRangeHeader } from "../utils/rangeParser";
import { safeError } from "../utils/errors";
import { guardedAxios, validateUrlForFetch } from "../utils/ssrf";
import axios from "axios";
import { z } from "zod";
import fs from "fs";
import type { OutgoingHttpHeaders } from "http";
import type { Readable } from "stream";
import { resolveCorsOrigin } from "./audiobooks";
import { upstreamHeader } from "../utils/upstreamHeaders";
import { USER_AGENT } from "../config";
import {
    assignCategories,
    categoryTree,
    chart,
    CHART_MAX,
    forYou,
    lookupShows,
    isCategory,
    oldestEpisode,
    rememberSnippet,
    similarShows,
    snippetFor,
    toDiscoveryItems,
    type Snippet,
} from "../services/podcastCatalog";
import { proxyPreviewStream } from "../utils/previewProxy";

const router = Router();

// Bound the feed fetch for a show not yet followed, so a slow or dead feed does not sit on the 30s parser
// timeout. The preview then answers from Apple's data alone; the sample has nothing else to play, so a slow
// feed there is a 502.
const PREVIEW_RSS_TIMEOUT_MS = 8000;

/** A show's or episode's cover: the cached copy when there is one, the feed's image otherwise. */
const podcastCover = (p: { id: string; localCoverPath: string | null; imageUrl: string | null }) =>
    p.localCoverPath ? `/podcasts/${p.id}/cover` : p.imageUrl;
const episodeCover = (e: { id: string; localCoverPath: string | null; imageUrl: string | null }) =>
    e.localCoverPath ? `/podcasts/episodes/${e.id}/cover` : e.imageUrl;

/** How far a listener is through an episode, as every route reports it; the percent is capped at 100. */
const progressOf = (p: { currentTime: number; duration: number; isFinished: boolean; lastPlayedAt: Date } | null | undefined) =>
    p
        ? {
              currentTime: p.currentTime,
              progress: p.duration > 0 ? Math.min(100, (p.currentTime / p.duration) * 100) : 0,
              isFinished: p.isFinished,
              lastPlayedAt: p.lastPlayedAt,
          }
        : null;

router.use(requireAuthOrToken);

function corsHeaders(corsOrigin: string | null) {
    return corsOrigin
        ? {
              "Access-Control-Allow-Origin": corsOrigin,
              "Access-Control-Allow-Credentials": "true",
          }
        : {};
}

function pipeCachedFile(
    res: Response,
    filePath: string,
    status: 200 | 206,
    headers: OutgoingHttpHeaders,
    range?: { start: number; end: number },
) {
    res.writeHead(status, headers);
    const fileStream = fs.createReadStream(filePath, range);
    res.on("close", () => {
        if (!fileStream.destroyed) fileStream.destroy();
    });
    fileStream.pipe(res);
    fileStream.on("error", (err) => {
        logger.error("    Cache stream error:", err);
        if (!res.headersSent) {
            res.status(500).json({ error: "Failed to stream episode" });
        } else {
            res.end();
        }
    });
}

function pipeUpstream(res: Response, upstream: Readable, label: string) {
    upstream.on("error", (err: Error) => {
        // A client that seeks away closes the stream early; that is not an error.
        if ((err as NodeJS.ErrnoException).code !== "ERR_STREAM_PREMATURE_CLOSE") {
            logger.debug(`    ${label} error: ${err.message}`);
        }
        if (!res.writableEnded) {
            res.end();
        }
    });
    res.on("close", () => {
        if (!upstream.destroyed) upstream.destroy();
    });
    upstream.pipe(res);
}

/**
 * GET /podcasts
 * Get all podcasts the user is subscribed to
 */
router.get("/", requireAuth, async (req, res) => {
    try {
        const subscriptions = await prisma.podcastSubscription.findMany({
            where: { userId: req.user!.id },
            include: {
                podcast: {
                    include: {
                        episodes: {
                            orderBy: { publishedAt: "desc" },
                            take: 5, // Get latest 5 episodes per podcast
                            include: {
                                progress: {
                                    where: { userId: req.user!.id },
                                },
                            },
                        },
                    },
                },
            },
            orderBy: { subscribedAt: "desc" },
        });

        const podcasts = subscriptions.map((sub) => {
            const podcast = sub.podcast;
            return {
                id: podcast.id,
                title: podcast.title,
                author: podcast.author,
                description: podcast.description,
                coverUrl: podcastCover(podcast),
                episodeCount: podcast.episodeCount,
                autoDownloadEpisodes: false,
                // The episodes come newest first: the first one's date is when the show last published.
                latestEpisodeAt: podcast.episodes[0]?.publishedAt ?? null,
                episodes: podcast.episodes.map((ep) => ({
                    id: ep.id,
                    title: ep.title,
                    description: ep.description,
                    duration: ep.duration,
                    publishedAt: ep.publishedAt,
                    coverUrl: episodeCover(ep),
                    progress: progressOf(ep.progress[0]),
                })),
            };
        });

        res.json(podcasts);
    } catch (error) {
        safeError(res, "Error fetching podcasts", error);
    }
});

const pageParams = z.object({
    limit: z.coerce.number().int().min(1).max(CHART_MAX).default(20),
    offset: z.coerce.number().int().min(0).max(CHART_MAX).default(0),
});

/**
 * An upstream's trouble (Apple, a show's feed or audio host) is never Kima's 500: it has no such thing → 404 with
 * `missing`; it is down, throttling or answered with something else → 502 with `down` (utils/upstream).
 */
function answerUpstreamFailure(res: Response, label: string, error: unknown, missing: string, down: string) {
    const failure = upstreamFailure(error);
    if (failure === "missing") return res.status(404).json({ error: missing });
    if (failure === "down") {
        logger.warn(`[PODCAST] ${label}: ${(error as Error).message}`);
        return res.status(502).json({ error: down });
    }
    return safeError(res, label, error);
}

const appleFailure = (res: Response, label: string, error: unknown) =>
    answerUpstreamFailure(res, label, error, "Apple Podcasts has no such chart or show", "Apple Podcasts did not answer; try again shortly");

/** GET /podcasts/categories — Apple's podcast categories, sub-categories naming their parent. */
router.get("/categories", async (_req, res) => {
    try {
        res.json(await categoryTree());
    } catch (error) {
        appleFailure(res, "Error fetching podcast categories", error);
    }
});

/**
 * A page of Apple's chart for a category (null: the overall chart). An id that is not a whole number, or a page
 * out of range, is a 400; an id that is not one of Apple's categories a 404, before Apple is asked for its chart.
 */
async function answerChart(res: Response, category: number | null, query: unknown, label: string) {
    const page = pageParams.safeParse(query);
    if (!page.success || (category !== null && !Number.isInteger(category))) {
        return res.status(400).json({ error: "category must be a category id; limit 1-200; offset 0-200" });
    }
    try {
        if (category !== null && !(await isCategory(category))) {
            return res.status(404).json({ error: "No such podcast category" });
        }
        const shows = (await chart(category)).slice(page.data.offset, page.data.offset + page.data.limit);
        res.json(await toDiscoveryItems(shows));
    } catch (error) {
        appleFailure(res, label, error);
    }
}

/** GET /podcasts/charts?category=<id>&limit&offset — Apple's chart for a category, the overall chart without one. */
router.get("/charts", (req, res) =>
    answerChart(res, req.query.category === undefined ? null : Number(req.query.category), req.query, "Error fetching podcast chart"),
);

/** GET /podcasts/for-you — rows from the categories of the shows this user follows. */
router.get("/for-you", requireAuth, async (req, res) => {
    try {
        res.json(await forYou(req.user!.id));
    } catch (error) {
        appleFailure(res, "Error building podcast recommendations", error);
    }
});

/** Category ids with Apple's names; a show page still answers when Apple's list cannot be read. */
async function namedCategories(ids: number[]): Promise<Array<{ id: number; name: string }>> {
    if (ids.length === 0) return [];
    try {
        const names = new Map((await categoryTree()).map((c) => [c.id, c.name]));
        return ids.filter((id) => names.has(id)).map((id) => ({ id, name: names.get(id)! }));
    } catch (err) {
        logger.warn(`[PODCAST] Category names unavailable: ${(err as Error).message}`);
        return [];
    }
}


/**
 * GET /podcasts/listening — across every followed show: episodes in progress (most recently played first) and,
 * like a podcast app's "up next", each show's newest episode while it is still unplayed, newest first.
 */
router.get("/listening", requireAuth, async (req, res) => {
    const userId = req.user!.id;
    const followed = { podcast: { subscriptions: { some: { userId } } } };
    try {
        const newestPerShow = await prisma.$queryRaw<{ id: string }[]>`
            SELECT DISTINCT ON (e."podcastId") e.id
            FROM "PodcastEpisode" e
            JOIN "PodcastSubscription" s ON s."podcastId" = e."podcastId" AND s."userId" = ${userId}
            ORDER BY e."podcastId", e."publishedAt" DESC, e.id`;
        const [inProgress, newEpisodes] = await Promise.all([
            prisma.podcastProgress.findMany({
                where: { userId, isFinished: false, currentTime: { gt: 0 }, episode: followed },
                orderBy: { lastPlayedAt: "desc" },
                take: 12,
                include: { episode: { include: { podcast: true } } },
            }),
            prisma.podcastEpisode.findMany({
                where: { id: { in: newestPerShow.map((r) => r.id) }, progress: { none: { userId } } },
                orderBy: { publishedAt: "desc" },
                take: 20,
                include: { podcast: true },
            }),
        ]);
        const row = (
            ep: (typeof newEpisodes)[number],
            progress: { currentTime: number; duration: number; isFinished: boolean; lastPlayedAt: Date } | null,
        ) => ({
            podcast: { id: ep.podcast.id, title: ep.podcast.title, coverUrl: podcastCover(ep.podcast) },
            episode: {
                id: ep.id,
                title: ep.title,
                description: ep.description,
                duration: ep.duration,
                publishedAt: ep.publishedAt,
                coverUrl: episodeCover(ep),
                progress: progressOf(progress),
            },
        });
        res.json({
            inProgress: inProgress.map((p) => row(p.episode, p)),
            newEpisodes: newEpisodes.map((ep) => row(ep, null)),
        });
    } catch (error) {
        safeError(res, "Error fetching podcast listening", error);
    }
});

/** GET /podcasts/discover/top?limit&offset — the overall chart, as /charts (kept for the iOS app, which asks here). */
router.get("/discover/top", (req, res) => answerChart(res, null, req.query, "Error fetching top podcasts"));

/**
 * GET /podcasts/discover/genres?genres=a,b — the first ten of each category's chart, keyed by category id. Only
 * Apple's own categories are asked for, each once; an id that is not one is left out of the answer.
 */
router.get("/discover/genres", async (req, res) => {
    const ids = typeof req.query.genres === "string" ? req.query.genres.split(",").map((g) => Number(g.trim())) : [];
    if (ids.length === 0 || ids.some((id) => !Number.isInteger(id))) {
        return res.status(400).json({ error: "genres parameter required (comma-separated genre IDs)" });
    }
    try {
        const known = new Set((await categoryTree()).map((c) => c.id));
        const out: Record<number, unknown> = {};
        for (const id of new Set(ids)) {
            if (known.has(id)) out[id] = await toDiscoveryItems((await chart(id)).slice(0, 10));
        }
        res.json(out);
    } catch (error) {
        appleFailure(res, "Error fetching genre podcasts", error);
    }
});

/** GET /podcasts/discover/genre/:genreId?limit&offset — one category's chart, as /charts (kept for the iOS app). */
router.get("/discover/genre/:genreId", (req, res) =>
    answerChart(res, Number(req.params.genreId), req.query, "Error fetching paginated genre podcasts"),
);

/**
 * GET /podcasts/preview/:itunesId
 * Preview a podcast by its Apple (iTunes) id, before following it
 */
router.get("/preview/:itunesId", requireAuth, async (req, res) => {
    try {
        const { itunesId } = req.params;

        // iTunes ids are numeric; anything else (our own record id, which the podcast page falls
        // back to, or a Deezer id an older client kept) is a 404, not an upstream error.
        if (!/^\d+$/.test(itunesId)) {
            return res.status(404).json({ error: "Podcast not found" });
        }

        const show = (await lookupShows([itunesId])).get(itunesId);
        if (!show) {
            return res.status(404).json({ error: "Podcast not found" });
        }

        const existingPodcast = await prisma.podcast.findFirst({
            where: { OR: [{ itunesId }, ...(show.feedUrl ? [{ feedUrl: show.feedUrl }] : [])] },
            select: { id: true },
        });
        const isSubscribed = existingPodcast
            ? !!(await prisma.podcastSubscription.findUnique({
                  where: { userId_podcastId: { userId: req.user!.id, podcastId: existingPodcast.id } },
              }))
            : false;

        let description = "";
        let previewEpisodes: Array<{ title: string; publishedAt: Date; duration: number; description: string }> = [];
        let snippet: Snippet | null = null;
        if (show.feedUrl) {
            try {
                const feedResult = await withTimeout(
                    rssParserService.parseFeed(show.feedUrl),
                    PREVIEW_RSS_TIMEOUT_MS,
                    "RSS preview timed out",
                );
                description = feedResult.podcast.description || "";
                previewEpisodes = [...feedResult.episodes]
                    .sort((a, b) => b.publishedAt.getTime() - a.publishedAt.getTime())
                    .slice(0, PREVIEW_EPISODES)
                    .map((ep) => ({
                        title: ep.title,
                        publishedAt: ep.publishedAt,
                        duration: ep.duration || 0,
                        description: ep.description || "",
                    }));
                snippet = snippetFrom(feedResult.episodes);
                if (snippet) await rememberSnippet(itunesId, snippet);
            } catch (error) {
                logger.warn(`  Failed to fetch RSS feed for preview:`, error);
            }
        }

        const categories = await namedCategories(show.categoryIds);
        res.json({
            itunesId: show.itunesId,
            title: show.title,
            author: show.author,
            description,
            coverUrl: show.coverUrl,
            feedUrl: show.feedUrl,
            genres: categories.map((c) => c.name),
            categories,
            episodeCount: show.episodeCount,
            previewEpisodes,
            snippet: snippet ? { ...snippet, audioUrl: undefined } : null,
            isSubscribed,
            subscribedPodcastId: isSubscribed ? existingPodcast!.id : null,
        });
    } catch (error) {
        appleFailure(res, "Error previewing podcast", error);
    }
});

/** The newest episodes a preview lists, with their summaries. */
const PREVIEW_EPISODES = 20;

function snippetFrom(episodes: Array<{ title: string; publishedAt: Date; duration: number; description?: string; audioUrl: string }>): Snippet | null {
    const ep = oldestEpisode(episodes);
    return ep
        ? { title: ep.title, publishedAt: ep.publishedAt.toISOString(), duration: ep.duration || 0, description: ep.description || "", audioUrl: ep.audioUrl }
        : null;
}

/**
 * GET /podcasts/preview/:itunesId/snippet — the show's first episode, streamed through Kima with range support,
 * so a show can be heard before it is followed. Nothing is stored; the feed (from Apple's record) names the audio.
 */
router.get("/preview/:itunesId/snippet", async (req, res) => {
    const { itunesId } = req.params;
    if (!/^\d+$/.test(itunesId)) {
        return res.status(404).json({ error: "Podcast not found" });
    }
    try {
        const snippet = await snippetFor(itunesId, async (feedUrl) => {
            const feed = await withTimeout(rssParserService.parseFeed(feedUrl), PREVIEW_RSS_TIMEOUT_MS, "RSS snippet timed out");
            return snippetFrom(feed.episodes);
        });
        if (!snippet) {
            return res.status(404).json({ error: "This podcast has no episode to sample" });
        }
        const ssrfError = await validateUrlForFetch(snippet.audioUrl);
        if (ssrfError) {
            return res.status(400).json({ error: `Invalid episode audio URL: ${ssrfError}` });
        }
        await proxyPreviewStream(res, snippet.audioUrl, {
            notFoundMessage: "Episode audio not found",
            logLabel: "[PODCAST SNIPPET]",
            rangeHeader: req.headers.range,
        });
    } catch (error) {
        answerUpstreamFailure(res, "Error streaming podcast snippet", error, "This podcast has no episode to sample", "The show's feed did not answer; try again shortly");
    }
});

/** GET /podcasts/preview/:itunesId/similar — a show not followed yet: shows on its categories' charts, as /:id/similar. */
router.get("/preview/:itunesId/similar", requireAuth, async (req, res) => {
    const { itunesId } = req.params;
    if (!/^\d+$/.test(itunesId)) {
        return res.status(404).json({ error: "Podcast not found" });
    }
    try {
        const show = (await lookupShows([itunesId])).get(itunesId);
        if (!show) {
            return res.status(404).json({ error: "Podcast not found" });
        }
        res.json(await similarShows(show));
    } catch (error) {
        appleFailure(res, "Error fetching similar podcasts", error);
    }
});

/**
 * POST /podcasts/refresh-all
 * Queue refresh jobs for all of the user's subscribed podcasts
 */
router.post("/refresh-all", requireAuth, async (req, res) => {
    try {
        const userId = req.user!.id;

        const subscriptions = await prisma.podcastSubscription.findMany({
            where: { userId },
            select: { podcastId: true, podcast: { select: { id: true, title: true } } },
        });

        if (subscriptions.length === 0) {
            return res.json({ queued: 0, message: "No subscribed podcasts" });
        }

        const { podcastQueue } = await import("../workers/enrichmentQueues");
        let queued = 0;
        for (const sub of subscriptions) {
            try {
                await podcastQueue.add(
                    "refresh",
                    { podcastId: sub.podcastId, podcastTitle: sub.podcast.title },
                    { jobId: `podcast-${sub.podcastId}-${Date.now()}` },
                );
                queued++;
            } catch (err) {
                logger.warn(`[PODCAST] Could not queue a refresh of ${sub.podcastId}: ${(err as Error).message}`);
            }
        }

        res.json({
            queued,
            total: subscriptions.length,
            message: `Queued ${queued} podcast${queued !== 1 ? "s" : ""} for refresh`,
        });
    } catch (error) {
        safeError(res, "Error refreshing all podcasts", error);
    }
});

/** Episodes per page, and with a podcast's detail, so the response does not grow with the show's age. */
const EPISODE_PAGE_SIZE = 50;
const EPISODE_PAGE_MAX = 200;

/**
 * limit/offset from the query string, clamped rather than rejected, matching
 * how the other paged lists here behave. A nonsense value falls back to the
 * default instead of 400-ing a client that guessed.
 */
function parseEpisodePage(query: Record<string, unknown>): {
    limit: number;
    offset: number;
} {
    const rawLimit = Number(query.limit);
    const rawOffset = Number(query.offset);
    const limit =
        Number.isFinite(rawLimit) && rawLimit > 0
            ? Math.min(Math.floor(rawLimit), EPISODE_PAGE_MAX)
            : EPISODE_PAGE_SIZE;
    const offset =
        Number.isFinite(rawOffset) && rawOffset > 0 ? Math.floor(rawOffset) : 0;
    return { limit, offset };
}

/**
 * Which end of the catalogue a page is taken from. "oldest" must decide the
 * page on the server: re-sorting a newest-first page client-side can only
 * ever show the oldest of the newest page, never the true oldest.
 */
function parseEpisodeOrder(query: Record<string, unknown>): "asc" | "desc" {
    return query.order === "oldest" ? "asc" : "desc";
}

/** GET /podcasts/:id: a podcast the user subscribes to, with one page of episodes. */
router.get("/:id", requireAuth, async (req, res) => {
    try {
        const { id } = req.params;
        const { limit, offset } = parseEpisodePage(req.query);
        const order = parseEpisodeOrder(req.query);

        const subscription = await prisma.podcastSubscription.findUnique({
            where: {
                userId_podcastId: {
                    userId: req.user!.id,
                    podcastId: id,
                },
            },
        });

        if (!subscription) {
            return res
                .status(404)
                .json({ error: "Podcast not found or not subscribed" });
        }

        const podcast = await prisma.podcast.findUnique({
            where: { id },
            include: {
                episodes: {
                    orderBy: { publishedAt: order },
                    take: limit,
                    skip: offset,
                    include: {
                        progress: {
                            where: { userId: req.user!.id },
                        },
                        downloads: {
                            where: { userId: req.user!.id },
                        },
                    },
                },
            },
        });

        if (!podcast) {
            return res.status(404).json({ error: "Podcast not found" });
        }

        const episodeTotal = await prisma.podcastEpisode.count({
            where: { podcastId: id },
        });

        const episodesWithProgress = podcast.episodes.map((episode) => ({
            id: episode.id,
            title: episode.title,
            description: episode.description,
            duration: episode.duration,
            publishedAt: episode.publishedAt,
            episodeNumber: episode.episodeNumber,
            season: episode.season,
            imageUrl: episode.imageUrl,
            isDownloaded: episode.downloads.length > 0,
            progress: progressOf(episode.progress[0]),
        }));

        const categories = await namedCategories(podcast.categoryIds);
        res.json({
            id: podcast.id,
            title: podcast.title,
            author: podcast.author,
            description: podcast.description,
            coverUrl: podcast.imageUrl,
            feedUrl: podcast.feedUrl,
            genres: categories.map((c) => c.name),
            categories,
            itunesId: podcast.itunesId,
            autoDownloadEpisodes: false,
            // `episodes` keeps its name and stays newest-first, so a client
            // that predates paging still renders -- it sees the first page
            // instead of a decade of back catalogue. episodeTotal is what tells
            // it there is more, and GET /:id/episodes is how it asks.
            episodes: episodesWithProgress,
            episodeTotal,
            episodeOffset: offset,
            episodeLimit: limit,
            isSubscribed: true,
        });
    } catch (error) {
        safeError(res, "Error fetching podcast", error);
    }
});

/**
 * GET /podcasts/:id/episodes
 * A page of one podcast's episodes, newest first, kept apart from the detail
 * so the stable part can be cached. Offset-based: an episode arriving between
 * page fetches shows one duplicate.
 */
router.get("/:id/episodes", requireAuth, async (req, res) => {
    try {
        const { id } = req.params;
        const { limit, offset } = parseEpisodePage(req.query);
        const order = parseEpisodeOrder(req.query);

        const subscription = await prisma.podcastSubscription.findUnique({
            where: {
                userId_podcastId: { userId: req.user!.id, podcastId: id },
            },
        });

        if (!subscription) {
            return res
                .status(404)
                .json({ error: "Podcast not found or not subscribed" });
        }

        const [episodes, total] = await Promise.all([
            prisma.podcastEpisode.findMany({
                where: { podcastId: id },
                orderBy: { publishedAt: order },
                take: limit,
                skip: offset,
                include: {
                    progress: { where: { userId: req.user!.id } },
                    downloads: { where: { userId: req.user!.id } },
                },
            }),
            prisma.podcastEpisode.count({ where: { podcastId: id } }),
        ]);

        res.json({
            episodes: episodes.map((episode) => ({
                id: episode.id,
                title: episode.title,
                description: episode.description,
                duration: episode.duration,
                publishedAt: episode.publishedAt,
                episodeNumber: episode.episodeNumber,
                season: episode.season,
                imageUrl: episode.imageUrl,
                isDownloaded: episode.downloads.length > 0,
                progress: progressOf(episode.progress[0]),
            })),
            total,
            offset,
            limit,
        });
    } catch (error) {
        safeError(res, "Error fetching podcast episodes", error);
    }
});

/** Follow a stored show; following it twice is following it once. */
async function follow(userId: string, podcast: { id: string; title: string }) {
    const { count } = await prisma.podcastSubscription.createMany({
        data: [{ userId, podcastId: podcast.id }],
        skipDuplicates: true,
    });
    if (count > 0) await forgetSearches(userId);
    return {
        success: true,
        podcast: { id: podcast.id, title: podcast.title },
        message: count > 0 ? "Subscribed successfully" : "Already subscribed",
    };
}

/** The same feed address, as Apple and a feed write it: scheme, the host's letter case and a trailing slash aside. */
const sameFeed = (a: string, b: string) => {
    const key = (url: string) => {
        try {
            const u = new URL(url.trim());
            return `${u.host}${u.pathname.replace(/\/+$/, "")}${u.search}`;
        } catch {
            return url.trim();
        }
    };
    return key(a) === key(b);
};

/** `candidate` when Apple says that id names `feedUrl`; null otherwise, or when Apple cannot be asked. */
async function appleIdFor(candidate: string | null, feedUrl: string): Promise<string | null> {
    if (!candidate || !/^\d+$/.test(candidate)) return null;
    try {
        const show = (await lookupShows([candidate])).get(candidate);
        return show?.feedUrl && sameFeed(show.feedUrl, feedUrl) ? candidate : null;
    } catch (error) {
        logger.warn(`[PODCAST] Could not confirm Apple id ${candidate}; storing the show without it: ${(error as Error).message}`);
        return null;
    }
}

/** A follow or removal must not leave a search answer from before it cached; a cache failure never fails either. */
async function forgetSearches(userId: string) {
    await forgetSearchesOf(userId).catch((error) => logger.warn(`[PODCAST] Could not clear cached searches: ${error.message}`));
}

/**
 * POST /podcasts/subscribe
 * Subscribe to a podcast by RSS feed URL or iTunes ID
 */
router.post("/subscribe", requireAuth, async (req, res) => {
    try {
        const { feedUrl, itunesId } = req.body;

        if (!feedUrl && !itunesId) {
            return res
                .status(400)
                .json({ error: "feedUrl or itunesId is required" });
        }

        const appleId = itunesId === undefined || itunesId === null || itunesId === "" ? null : String(itunesId);
        const userId = req.user!.id;

        // A show already here is followed as it is, found by either of its keys: Apple can give a show a new feed
        // address, and the preview finds it by its Apple id.
        const existing = async (url: string | null) =>
            prisma.podcast.findFirst({
                where: { OR: [...(url ? [{ feedUrl: url }] : []), ...(appleId ? [{ itunesId: appleId }] : [])] },
            });
        let podcast = await existing(feedUrl || null);
        if (podcast) return res.json(await follow(userId, podcast));

        // Only an Apple id given (checked above that one of the two is): Apple names the feed.
        const finalFeedUrl: string | null = feedUrl || ((await lookupShows([appleId!])).get(appleId!)?.feedUrl ?? null);
        if (!finalFeedUrl) {
            return res.status(404).json({ error: "Podcast not found in iTunes" });
        }
        if (!feedUrl) {
            podcast = await existing(finalFeedUrl);
            if (podcast) return res.json(await follow(userId, podcast));
        }

        // SSRF validation: block internal/private addresses
        const ssrfError = await validateUrlForFetch(finalFeedUrl);
        if (ssrfError) {
            return res.status(400).json({ error: `Invalid feed URL: ${ssrfError}` });
        }

        // Parse RSS feed to get podcast and episodes
        const subscribeResult = await rssParserService.parseFeed(finalFeedUrl);
        const { podcast: podcastData, episodes } = subscribeResult;

        // Create podcast in database. Apple ids are unique and the preview finds shows by them, so one is stored only
        // when Apple says it names this feed: the client and the feed itself can each claim any show's id.
        const feedDeclared = podcastData.itunesId ? String(podcastData.itunesId) : null;
        const finalItunesId =
            (await appleIdFor(appleId, finalFeedUrl)) ?? (feedDeclared !== appleId ? await appleIdFor(feedDeclared, finalFeedUrl) : null);

        try {
            podcast = await prisma.podcast.create({
                data: {
                    feedUrl: finalFeedUrl,
                    title: podcastData.title,
                    author: podcastData.author,
                    description: podcastData.description,
                    imageUrl: podcastData.imageUrl,
                    itunesId: finalItunesId,
                    language: podcastData.language,
                    explicit: podcastData.explicit || false,
                    episodeCount: episodes.length,
                    feedEtag: subscribeResult.etag || null,
                    feedLastModified: subscribeResult.lastModified || null,
                },
            });
        } catch (error) {
            // Two follows of a new show at once: the other request stored it first.
            if (!(error instanceof Prisma.PrismaClientKnownRequestError && error.code === "P2002")) throw error;
            const stored = await prisma.podcast.findFirst({
                where: { OR: [{ feedUrl: finalFeedUrl }, ...(finalItunesId ? [{ itunesId: finalItunesId }] : [])] },
            });
            if (!stored) throw error;
            return res.json(await follow(userId, stored));
        }

        await assignCategories(podcast.id, finalItunesId, podcastData.categoryNames);

        // Save episodes
        await prisma.podcastEpisode.createMany({
            data: episodes.map((ep) => ({
                podcastId: podcast!.id,
                guid: ep.guid,
                title: ep.title,
                description: ep.description,
                audioUrl: ep.audioUrl,
                duration: ep.duration,
                publishedAt: ep.publishedAt,
                episodeNumber: ep.episodeNumber,
                season: ep.season,
                imageUrl: ep.imageUrl,
                fileSize: ep.fileSize,
                mimeType: ep.mimeType,
            })),
            skipDuplicates: true,
        });

        res.json(await follow(userId, podcast));
    } catch (error: any) {
        // A feed or Apple failing is never the server failing (utils/upstream): nothing there → 404; the host or Apple
        // not answering → 502; a host that answered with something that is not a feed → 422.
        const failure = upstreamFailure(error);
        if (failure === "missing") {
            return res.status(404).json({ error: "Nothing was found at that feed address" });
        }
        if (failure === "down" && upstreamUnreachable(error)) {
            return res.status(502).json({ error: "The show's feed or Apple Podcasts did not answer; try again shortly" });
        }
        if (error instanceof FeedReadError) {
            return res.status(422).json({
                error: "Podcast feed could not be read",
                detail: error.message,
            });
        }
        appleFailure(res, "Error subscribing to podcast", error);
    }
});

/**
 * DELETE /podcasts/:id/unsubscribe
 * Unsubscribe from a podcast
 */
router.delete("/:id/unsubscribe", requireAuth, async (req, res) => {
    try {
        const { id } = req.params;

        logger.debug(`\n[PODCAST] Unsubscribe request`);
        logger.debug(`   User: ${req.user!.username}`);
        logger.debug(`   Podcast ID: ${id}`);

        // Delete subscription
        const deleted = await prisma.podcastSubscription.deleteMany({
            where: {
                userId: req.user!.id,
                podcastId: id,
            },
        });

        if (deleted.count === 0) {
            return res
                .status(404)
                .json({ error: "Not subscribed to this podcast" });
        }

        // Also delete user's progress for this podcast
        await prisma.podcastProgress.deleteMany({
            where: {
                userId: req.user!.id,
                episode: {
                    podcastId: id,
                },
            },
        });

        // Also delete any downloaded episodes
        await prisma.podcastDownload.deleteMany({
            where: {
                userId: req.user!.id,
                episode: {
                    podcastId: id,
                },
            },
        });

        logger.debug(`   Unsubscribed successfully`);
        await forgetSearches(req.user!.id);

        res.json({
            success: true,
            message: "Unsubscribed successfully",
        });
    } catch (error) {
        safeError(res, "Error unsubscribing from podcast", error);
    }
});

/**
 * GET /podcasts/:id/refresh
 * Manually refresh podcast feed to check for new episodes
 */
router.get("/:id/refresh", requireAuth, async (req, res) => {
    try {
        const { id } = req.params;

        const result = await refreshPodcastFeed(id);
        if (!result) return res.status(404).json({ error: "Podcast not found" });

        res.json({
            success: true,
            newEpisodesCount: result.newEpisodesCount,
            totalEpisodes: result.totalEpisodes,
            message: `Found ${result.newEpisodesCount} new episodes`,
        });
    } catch (error) {
        answerUpstreamFailure(res, "Error refreshing podcast", error, "The show's feed is gone", "The show's feed did not answer; try again shortly");
    }
});

/**
 * GET /podcasts/:podcastId/episodes/:episodeId/cache-status
 * Check if a podcast episode is cached locally
 * Used by frontend to know when it's safe to reload for seeking
 * Also returns download progress if downloading
 */
router.get("/:podcastId/episodes/:episodeId/cache-status", async (req, res) => {
    try {
        const { episodeId } = req.params;

        const { getCachedFilePath, isDownloading, getDownloadProgress } =
            await import("../services/podcastDownload");

        const cachedPath = await getCachedFilePath(episodeId);
        const downloading = isDownloading(episodeId);
        const progress = getDownloadProgress(episodeId);

        res.json({
            episodeId,
            cached: !!cachedPath,
            downloading,
            downloadProgress: progress?.progress ?? null, // 0-100 or null
            path: cachedPath ? true : false, // Don't expose actual path
        });
    } catch (error: any) {
        logger.error("[PODCAST] Cache status check failed:", error);
        res.status(500).json({ error: "Failed to check cache status" });
    }
});

/**
 * GET /podcasts/:podcastId/episodes/:episodeId/stream
 * Stream a podcast episode (from local cache or RSS URL)
 * Auto-caches episodes in background for better seeking support
 */
router.get("/:podcastId/episodes/:episodeId/stream", requireAuthOrToken, async (req, res) => {
    try {
        const { podcastId, episodeId } = req.params;
        const userId = req.user?.id;
        const podcastDebug = process.env.PODCAST_DEBUG === "1";
        // Resolved against the allowed origins, never just reflected (see resolveCorsOrigin in ./audiobooks).
        const corsOrigin = resolveCorsOrigin(req.headers.origin);

        logger.debug(`\n [PODCAST STREAM] Request:`);
        logger.debug(`   Podcast ID: ${podcastId}`);
        logger.debug(`   Episode ID: ${episodeId}`);
        if (podcastDebug) {
            logger.debug(`   Range: ${req.headers.range || "none"}`);
            logger.debug(`   UA: ${req.headers["user-agent"] || "unknown"}`);
        }

        const episode = await prisma.podcastEpisode.findUnique({
            where: { id: episodeId },
        });

        if (!episode) {
            return res.status(404).json({ error: "Episode not found" });
        }

        if (podcastDebug) {
            logger.debug(`   Episode DB: title="${episode.title}"`);
            logger.debug(`   Episode DB: guid="${episode.guid}"`);
            logger.debug(`   Episode DB: audioUrl="${episode.audioUrl}"`);
            logger.debug(
                `   Episode DB: mimeType="${
                    episode.mimeType || "unknown"
                }" fileSize=${episode.fileSize || 0}`
            );
        }

        const range = req.headers.range;

        const { getCachedFilePath, downloadInBackground, isDownloading } =
            await import("../services/podcastDownload");

        const cachedPath = await getCachedFilePath(episodeId);

        const baseHeaders = {
            "Content-Type": episode.mimeType || "audio/mpeg",
            "Accept-Ranges": "bytes",
            "Cache-Control": "public, max-age=3600",
            ...corsHeaders(corsOrigin),
        };

        if (cachedPath) {
            logger.debug(`   Streaming from cache: ${cachedPath}`);
            try {
                const stats = await fs.promises.stat(cachedPath);
                const fileSize = stats.size;
                if (podcastDebug) {
                    logger.debug(`   Cache file size: ${fileSize}`);
                }

                if (fileSize === 0) {
                    throw new Error("Cached file is empty");
                }

                if (range) {
                    const parsed = parseRangeHeader(range, fileSize);

                    if (!parsed.ok) {
                        if (parsed.reason === "multi") {
                            // RFC 9110: ignore multi-range, serve full file as 200
                            logger.debug(`    Multi-range ignored, serving full file`);
                            pipeCachedFile(res, cachedPath, 200, {
                                ...baseHeaders,
                                "Content-Length": fileSize,
                            });
                        } else {
                            res.status(416).set({
                                "Content-Range": `bytes */${fileSize}`,
                            });
                            res.end();
                        }
                        return;
                    }

                    const { start, end } = parsed;

                    logger.debug(
                        `    Serving range: bytes ${start}-${end}/${fileSize}`
                    );

                    pipeCachedFile(
                        res,
                        cachedPath,
                        206,
                        {
                            ...baseHeaders,
                            "Content-Range": `bytes ${start}-${end}/${fileSize}`,
                            "Content-Length": end - start + 1,
                        },
                        { start, end },
                    );
                    return;
                }

                logger.debug(`    Serving full file: ${fileSize} bytes`);
                pipeCachedFile(res, cachedPath, 200, {
                    ...baseHeaders,
                    "Content-Length": fileSize,
                });
                return;
            } catch (err: any) {
                logger.error(
                    "    Failed to stream from cache, falling back to RSS:",
                    err.message
                );
            }
        }

        // Not cached yet - trigger background download while streaming from RSS
        if (userId && !isDownloading(episodeId)) {
            logger.debug(`   Triggering background download for caching`);
            downloadInBackground(episodeId, episode.audioUrl, userId);
        }

        // SSRF protection: validate audio URL before fetching
        const ssrfError = await validateUrlForFetch(episode.audioUrl);
        if (ssrfError) {
            logger.warn(`[PODCAST STREAM] SSRF blocked: ${ssrfError} for ${episode.audioUrl}`);
            return res.status(400).json({ error: "Invalid audio URL" });
        }

        // Stream from the feed's host with the size it states for the copy it sends: a feed's declared enclosure
        // length can belong to another file, and the browser derives the episode's length from the size. Asked as
        // Kima, like the background download, because hosts that stitch ads in send each identity its own copy, so
        // the copy played is the copy cached and measured.
        logger.debug(`   Streaming from RSS: ${episode.audioUrl}`);

        const controller = new AbortController();
        res.on("close", () => {
            controller.abort();
        });
        const fetchUpstream = (rangeHeader?: string) =>
            axios.get(episode.audioUrl, {
                ...guardedAxios,
                headers: { "User-Agent": USER_AGENT, ...(rangeHeader && { Range: rangeHeader }) },
                responseType: "stream",
                decompress: false,
                validateStatus: (status) => status === 200 || status === 206 || status === 416,
                timeout: 30000,
                signal: controller.signal,
            });

        // One range is passed on as asked; several at once are answered with the whole file (RFC 9110).
        const singleRange = range && /^bytes=(\d+-\d*|-\d+)$/.test(range) ? range : undefined;
        let response;
        try {
            response = await fetchUpstream(singleRange);
        } catch (error: any) {
            if (axios.isCancel(error)) {
                logger.debug("    Request aborted by client");
                return;
            }
            if (!singleRange) throw error;
            // Some podcast CDNs refuse range requests outright; the whole file still plays.
            logger.debug(`    Range request failed (${error.response?.status || error.message}), streaming the whole file`);
            response = await fetchUpstream();
        }

        const contentRange = upstreamHeader(response.headers["content-range"]);
        if (response.status === 416) {
            response.data.destroy();
            res.status(416).set({ ...corsHeaders(corsOrigin), ...(contentRange && { "Content-Range": contentRange }) });
            res.end();
            return;
        }
        const contentLength = upstreamHeader(response.headers["content-length"]);
        res.writeHead(response.status, {
            ...baseHeaders,
            ...(contentLength && { "Content-Length": contentLength }),
            ...(response.status === 206 && contentRange && { "Content-Range": contentRange }),
        });
        pipeUpstream(res, response.data, "RSS stream");
    } catch (error) {
        // The host refusing or not having the file, or a redirect the guard refuses, is the episode being
        // unavailable; a host that is down or throttling is a bad gateway. Neither is a server failure.
        if (!res.headersSent) {
            answerUpstreamFailure(res, "Podcast stream error", error, "This episode is not available from its host", "The episode's host did not answer; try again shortly");
        } else {
            logger.error("Podcast stream error (headers already sent):", error);
        }
    }
});

// Lenient on shape (numbers as strings, no duration) so no client the route already served is refused;
// a missing duration keeps the one stored.
const progressSchema = z.object({
    currentTime: z.coerce.number().finite().min(0),
    duration: z.coerce.number().finite().min(0).optional(),
    isFinished: z.boolean().optional(),
});

/**
 * POST /podcasts/:podcastId/episodes/:episodeId/progress
 * Update playback progress for a podcast episode
 */
router.post("/:podcastId/episodes/:episodeId/progress", requireAuth, async (req, res) => {
    try {
        const { episodeId } = req.params;
        const body = progressSchema.safeParse(req.body);
        if (!body.success) {
            return res.status(400).json({ error: "currentTime (seconds) is required" });
        }
        const { currentTime, duration, isFinished } = body.data;
        const episode = await prisma.podcastEpisode.findUnique({ where: { id: episodeId }, select: { id: true } });
        if (!episode) {
            return res.status(404).json({ error: "Episode not found" });
        }

        const progress = await prisma.podcastProgress.upsert({
            where: {
                userId_episodeId: {
                    userId: req.user!.id,
                    episodeId: episodeId,
                },
            },
            create: {
                userId: req.user!.id,
                episodeId: episodeId,
                currentTime,
                duration: duration ?? 0,
                isFinished: isFinished || false,
            },
            update: {
                currentTime,
                ...(duration !== undefined && { duration }),
                isFinished: isFinished || false,
                lastPlayedAt: new Date(),
            },
        });

        res.json({
            success: true,
            progress: progressOf(progress),
        });
    } catch (error) {
        safeError(res, "Error updating progress", error);
    }
});

/**
 * DELETE /podcasts/:podcastId/episodes/:episodeId/progress
 * Remove/reset progress for a podcast episode
 */
router.delete("/:podcastId/episodes/:episodeId/progress", requireAuth, async (req, res) => {
    try {
        const { episodeId } = req.params;

        logger.debug(`\n[PODCAST PROGRESS] Delete:`);
        logger.debug(`   User: ${req.user!.username}`);
        logger.debug(`   Episode ID: ${episodeId}`);

        await prisma.podcastProgress.deleteMany({
            where: {
                userId: req.user!.id,
                episodeId: episodeId,
            },
        });

        logger.debug(`   Progress removed`);

        res.json({
            success: true,
            message: "Progress removed",
        });
    } catch (error) {
        safeError(res, "Error removing progress", error);
    }
});

/** GET /podcasts/:id/similar — shows on its own categories' charts (see similarShows). */
router.get("/:id/similar", async (req, res) => {
    try {
        const podcast = await prisma.podcast.findUnique({
            where: { id: req.params.id },
            select: { itunesId: true, categoryIds: true },
        });
        if (!podcast) {
            return res.status(404).json({ error: "Podcast not found" });
        }
        const shows = await similarShows(podcast);
        res.json(shows);
    } catch (error) {
        appleFailure(res, "Error fetching similar podcasts", error);
    }
});

/**
 * OPTIONS /podcasts/:id/cover
 * Handle CORS preflight request for podcast cover images
 */
router.options("/:id/cover", (req, res) => {
    const origin = resolveCorsOrigin(req.headers.origin);
    if (origin) {
        res.setHeader("Access-Control-Allow-Origin", origin);
        res.setHeader("Access-Control-Allow-Credentials", "true");
    }
    res.setHeader("Access-Control-Allow-Methods", "GET, OPTIONS");
    res.setHeader("Access-Control-Allow-Headers", "Content-Type");
    res.setHeader("Access-Control-Max-Age", "86400"); // 24 hours
    res.status(204).end();
});

/**
 * GET /podcasts/:id/cover
 * Serve cached podcast cover from local disk
 */
router.get("/:id/cover", async (req, res) => {
    try {
        const { id } = req.params;

        const podcast = await prisma.podcast.findUnique({
            where: { id },
            select: { localCoverPath: true, imageUrl: true },
        });

        if (!podcast) {
            return res.status(404).json({ error: "Podcast not found" });
        }

        // Serve from local disk if cached
        if (podcast.localCoverPath) {
            res.setHeader(
                "Cache-Control",
                "public, max-age=31536000, immutable"
            );
            const origin = resolveCorsOrigin(req.headers.origin);
            if (origin) {
                res.setHeader("Access-Control-Allow-Origin", origin);
                res.setHeader("Access-Control-Allow-Credentials", "true");
            }
            res.setHeader("Cross-Origin-Resource-Policy", "cross-origin");
            return res.sendFile(podcast.localCoverPath);
        }

        // Fallback: redirect to original URL
        if (podcast.imageUrl) {
            return res.redirect(podcast.imageUrl);
        }

        res.status(404).json({ error: "Cover not found" });
    } catch (error) {
        safeError(res, "Error serving podcast cover", error);
    }
});

/**
 * OPTIONS /podcasts/episodes/:episodeId/cover
 * Handle CORS preflight request for episode cover images
 */
router.options("/episodes/:episodeId/cover", (req, res) => {
    const origin = resolveCorsOrigin(req.headers.origin);
    if (origin) {
        res.setHeader("Access-Control-Allow-Origin", origin);
        res.setHeader("Access-Control-Allow-Credentials", "true");
    }
    res.setHeader("Access-Control-Allow-Methods", "GET, OPTIONS");
    res.setHeader("Access-Control-Allow-Headers", "Content-Type");
    res.setHeader("Access-Control-Max-Age", "86400"); // 24 hours
    res.status(204).end();
});

/**
 * GET /podcasts/episodes/:episodeId/cover
 * Serve cached episode cover from local disk
 */
router.get("/episodes/:episodeId/cover", async (req, res) => {
    try {
        const { episodeId } = req.params;

        const episode = await prisma.podcastEpisode.findUnique({
            where: { id: episodeId },
            select: { localCoverPath: true, imageUrl: true },
        });

        if (!episode) {
            return res.status(404).json({ error: "Episode not found" });
        }

        // Serve from local disk if cached
        if (episode.localCoverPath) {
            res.setHeader(
                "Cache-Control",
                "public, max-age=31536000, immutable"
            );
            const origin = resolveCorsOrigin(req.headers.origin);
            if (origin) {
                res.setHeader("Access-Control-Allow-Origin", origin);
                res.setHeader("Access-Control-Allow-Credentials", "true");
            }
            res.setHeader("Cross-Origin-Resource-Policy", "cross-origin");
            return res.sendFile(episode.localCoverPath);
        }

        // Fallback: redirect to original URL
        if (episode.imageUrl) {
            return res.redirect(episode.imageUrl);
        }

        res.status(404).json({ error: "Cover not found" });
    } catch (error) {
        safeError(res, "Error serving episode cover", error);
    }
});

/**
 * Fetch a stored show's feed again and store its new episodes; null when the show is not stored. Shared by the
 * refresh route, the Subsonic refresh and the podcast worker.
 */
export async function refreshPodcastFeed(podcastId: string): Promise<{ newEpisodesCount: number; totalEpisodes: number } | null> {
    const podcast = await prisma.podcast.findUnique({ where: { id: podcastId } });
    if (!podcast) return null;

    const result = await rssParserService.parseFeed(podcast.feedUrl, {
        etag: podcast.feedEtag,
        lastModified: podcast.feedLastModified,
    });

    if (result.notModified) {
        await prisma.podcast.update({
            where: { id: podcastId },
            data: { lastRefreshed: new Date() },
        });
        return { newEpisodesCount: 0, totalEpisodes: podcast.episodeCount };
    }

    await prisma.podcast.update({
        where: { id: podcastId },
        data: {
            title: result.podcast.title,
            author: result.podcast.author,
            description: result.podcast.description,
            imageUrl: result.podcast.imageUrl,
            language: result.podcast.language,
            explicit: result.podcast.explicit || false,
            episodeCount: result.episodes.length,
            lastRefreshed: new Date(),
            feedEtag: result.etag || null,
            feedLastModified: result.lastModified || null,
        },
    });
    if (podcast.categoryIds.length === 0) {
        await assignCategories(podcastId, podcast.itunesId, result.podcast.categoryNames);
    }

    // Batch fetch all existing GUIDs to avoid N+1 queries
    const feedGuids = result.episodes.map(e => e.guid).filter(Boolean);
    const existingGuids = new Set(
        (await prisma.podcastEpisode.findMany({
            where: { podcastId, guid: { in: feedGuids } },
            select: { guid: true },
        })).map(e => e.guid)
    );

    let newEpisodesCount = 0;
    for (const ep of result.episodes) {
        if (existingGuids.has(ep.guid)) continue;

        // upsert, not find-then-create: manual and automatic refreshes can race on the
        // (podcastId, guid) unique key. An existing episode is left untouched.
        await prisma.podcastEpisode.upsert({
            where: { podcastId_guid: { podcastId, guid: ep.guid } },
            create: {
                podcastId,
                guid: ep.guid,
                title: ep.title,
                description: ep.description,
                audioUrl: ep.audioUrl,
                duration: ep.duration,
                publishedAt: ep.publishedAt,
                episodeNumber: ep.episodeNumber,
                season: ep.season,
                imageUrl: ep.imageUrl,
                fileSize: ep.fileSize,
                mimeType: ep.mimeType,
            },
            update: {},
        });
        newEpisodesCount++;
    }

    return { newEpisodesCount, totalEpisodes: result.episodes.length };
}

export default router;
