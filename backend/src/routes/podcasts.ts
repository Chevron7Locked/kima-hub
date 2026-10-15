import { Router, Response } from "express";
import { logger } from "../utils/logger";
import { withTimeout } from "../utils/timeout";
import { requireAuth, requireAuthOrToken } from "../middleware/auth";
import { prisma } from "../utils/db";
import { rssParserService } from "../services/rss-parser";
import { parseRangeHeader } from "../utils/rangeParser";
import { safeError } from "../utils/errors";
import { validateUrlForFetch } from "../utils/ssrf";
import axios from "axios";
import { z } from "zod";
import fs from "fs";
import type { OutgoingHttpHeaders } from "http";
import type { Readable } from "stream";
import { resolveCorsOrigin } from "./audiobooks";
import { upstreamHeader, upstreamHeaderNumber } from "../utils/upstreamHeaders";
import {
    assignCategories,
    categoryTree,
    chart,
    CHART_MAX,
    forYou,
    lookupShows,
    oldestEpisode,
    rememberSnippet,
    similarShows,
    snippetFor,
    toDiscoveryItems,
    type Snippet,
} from "../services/podcastCatalog";
import { proxyPreviewStream } from "../utils/previewProxy";

const router = Router();

// Bound the preview RSS fetch so a slow or dead feed returns partial data
// quickly instead of sitting on the 30s parser timeout and hanging the request.
// The feed is non-critical for a preview; core data comes from
// iTunes/Deezer, and both call sites already fall through to partial data.
const PREVIEW_RSS_TIMEOUT_MS = 8000;

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
                coverUrl: podcast.localCoverPath
                    ? `/podcasts/${podcast.id}/cover`
                    : podcast.imageUrl, // Fallback to original URL if not cached
                episodeCount: podcast.episodeCount,
                autoDownloadEpisodes: false,
                episodes: podcast.episodes.map((ep) => ({
                    id: ep.id,
                    title: ep.title,
                    description: ep.description,
                    duration: ep.duration,
                    publishedAt: ep.publishedAt,
                    coverUrl: ep.localCoverPath
                        ? `/podcasts/episodes/${ep.id}/cover`
                        : ep.imageUrl, // Fallback to original URL
                    progress: ep.progress[0]
                        ? {
                              currentTime: ep.progress[0].currentTime,
                              progress:
                                  ep.progress[0].duration > 0
                                      ? Math.min(
                                            100,
                                            (ep.progress[0].currentTime / ep.progress[0].duration) * 100,
                                        )
                                      : 0,
                              isFinished: ep.progress[0].isFinished,
                              lastPlayedAt: ep.progress[0].lastPlayedAt,
                          }
                        : null,
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

/** GET /podcasts/categories — Apple's podcast categories, sub-categories naming their parent. */
router.get("/categories", async (_req, res) => {
    try {
        res.json(await categoryTree());
    } catch (error) {
        safeError(res, "Error fetching podcast categories", error);
    }
});

/** GET /podcasts/charts?category=<id>&limit&offset — Apple's chart for a category, the overall chart without one. */
router.get("/charts", async (req, res) => {
    const page = pageParams.safeParse(req.query);
    const category = req.query.category === undefined ? null : Number(req.query.category);
    if (!page.success || (category !== null && !Number.isInteger(category))) {
        return res.status(400).json({ error: "category must be a category id; limit 1-200; offset 0-200" });
    }
    try {
        const shows = (await chart(category)).slice(page.data.offset, page.data.offset + page.data.limit);
        res.json(await toDiscoveryItems(shows));
    } catch (error) {
        safeError(res, "Error fetching podcast chart", error);
    }
});

/** GET /podcasts/for-you — rows from the categories of the shows this user follows. */
router.get("/for-you", requireAuth, async (req, res) => {
    try {
        res.json(await forYou(req.user!.id));
    } catch (error) {
        safeError(res, "Error building podcast recommendations", error);
    }
});

const podcastCover = (p: { id: string; localCoverPath: string | null; imageUrl: string | null }) =>
    p.localCoverPath ? `/podcasts/${p.id}/cover` : p.imageUrl;
const episodeCover = (e: { id: string; localCoverPath: string | null; imageUrl: string | null }) =>
    e.localCoverPath ? `/podcasts/episodes/${e.id}/cover` : e.imageUrl;

/**
 * GET /podcasts/listening — across every followed show: episodes in progress (most recently played first) and
 * the newest episodes not yet started.
 */
router.get("/listening", requireAuth, async (req, res) => {
    const userId = req.user!.id;
    const followed = { podcast: { subscriptions: { some: { userId } } } };
    try {
        const [inProgress, newEpisodes] = await Promise.all([
            prisma.podcastProgress.findMany({
                where: { userId, isFinished: false, currentTime: { gt: 0 }, episode: followed },
                orderBy: { lastPlayedAt: "desc" },
                take: 12,
                include: { episode: { include: { podcast: true } } },
            }),
            prisma.podcastEpisode.findMany({
                where: { ...followed, progress: { none: { userId } } },
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
                progress: progress
                    ? {
                          currentTime: progress.currentTime,
                          progress: progress.duration > 0 ? Math.min(100, (progress.currentTime / progress.duration) * 100) : 0,
                          isFinished: progress.isFinished,
                          lastPlayedAt: progress.lastPlayedAt,
                      }
                    : null,
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

/** GET /podcasts/discover/top — the overall chart (kept for clients that ask here). */
router.get("/discover/top", async (req, res) => {
    const page = pageParams.safeParse(req.query);
    if (!page.success) return res.status(400).json({ error: "limit must be 1-200" });
    try {
        res.json(await toDiscoveryItems((await chart(null)).slice(0, page.data.limit)));
    } catch (error) {
        safeError(res, "Error fetching top podcasts", error);
    }
});

/** GET /podcasts/discover/genres?genres=a,b — the first ten of each category's chart, keyed by category id. */
router.get("/discover/genres", async (req, res) => {
    const ids = typeof req.query.genres === "string" ? req.query.genres.split(",").map((g) => Number(g.trim())) : [];
    if (ids.length === 0 || ids.some((id) => !Number.isInteger(id))) {
        return res.status(400).json({ error: "genres parameter required (comma-separated genre IDs)" });
    }
    try {
        const out: Record<number, unknown> = {};
        for (const id of ids) out[id] = await toDiscoveryItems((await chart(id)).slice(0, 10));
        res.json(out);
    } catch (error) {
        safeError(res, "Error fetching genre podcasts", error);
    }
});

/** GET /podcasts/discover/genre/:genreId?limit&offset — one category's chart, paged. */
router.get("/discover/genre/:genreId", async (req, res) => {
    const page = pageParams.safeParse(req.query);
    const id = Number(req.params.genreId);
    if (!page.success || !Number.isInteger(id)) return res.status(400).json({ error: "genreId must be a category id" });
    try {
        const shows = (await chart(id)).slice(page.data.offset, page.data.offset + page.data.limit);
        res.json(await toDiscoveryItems(shows));
    } catch (error) {
        safeError(res, "Error fetching paginated genre podcasts", error);
    }
});

/**
 * GET /podcasts/preview/:itunesId
 * Preview a podcast by iTunes or Deezer ID (for discovery, before subscribing)
 * Deezer IDs are prefixed with "deezer:" -- resolved via Deezer API + iTunes name search
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
                if (feedResult.notModified) throw new Error("Unexpected 304 on preview fetch");
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

        const names = new Map((await categoryTree()).map((c) => [c.id, c.name]));
        const categories = show.categoryIds
            .filter((id) => names.has(id))
            .map((id) => ({ id, name: names.get(id)! }));
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
        safeError(res, "Error previewing podcast", error);
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
            return feed.notModified ? null : snippetFrom(feed.episodes);
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
        safeError(res, "Error streaming podcast snippet", error);
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
            } catch {
                // Job already queued (dedup by jobId) -- skip silently
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
            progress: episode.progress[0]
                ? {
                      currentTime: episode.progress[0].currentTime,
                      progress:
                          episode.progress[0].duration > 0
                              ? Math.min(
                                    100,
                                    (episode.progress[0].currentTime / episode.progress[0].duration) * 100,
                                )
                              : 0,
                      isFinished: episode.progress[0].isFinished,
                      lastPlayedAt: episode.progress[0].lastPlayedAt,
                  }
                : null,
        }));

        res.json({
            id: podcast.id,
            title: podcast.title,
            author: podcast.author,
            description: podcast.description,
            coverUrl: podcast.imageUrl,
            feedUrl: podcast.feedUrl,
            genres: [],
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
                progress: episode.progress[0]
                    ? {
                          currentTime: episode.progress[0].currentTime,
                          progress:
                              episode.progress[0].duration > 0
                                  ? Math.min(
                                        100,
                                        (episode.progress[0].currentTime / episode.progress[0].duration) * 100,
                                    )
                                  : 0,
                          isFinished: episode.progress[0].isFinished,
                          lastPlayedAt: episode.progress[0].lastPlayedAt,
                      }
                    : null,
            })),
            total,
            offset,
            limit,
        });
    } catch (error) {
        safeError(res, "Error fetching podcast episodes", error);
    }
});

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

        logger.debug(
            `\n [PODCAST] Subscribe request from ${req.user!.username}`
        );
        logger.debug(`   Feed URL: ${feedUrl || "N/A"}`);
        logger.debug(`   iTunes ID: ${itunesId || "N/A"}`);

        let finalFeedUrl = feedUrl;

        // If only iTunes ID provided, fetch feed URL from iTunes API
        if (!finalFeedUrl && itunesId) {
            logger.debug(`    Looking up feed URL from iTunes...`);
            const itunesResponse = await axios.get(
                "https://itunes.apple.com/lookup",
                {
                    params: { id: itunesId, entity: "podcast" },
                }
            );

            if (
                itunesResponse.data.resultCount === 0 ||
                !itunesResponse.data.results[0].feedUrl
            ) {
                return res
                    .status(404)
                    .json({ error: "Podcast not found in iTunes" });
            }

            finalFeedUrl = itunesResponse.data.results[0].feedUrl;
            logger.debug(`   Found feed URL: ${finalFeedUrl}`);
        }

        // SSRF validation: block internal/private addresses
        const ssrfError = await validateUrlForFetch(finalFeedUrl);
        if (ssrfError) {
            return res.status(400).json({ error: `Invalid feed URL: ${ssrfError}` });
        }

        // Check if podcast already exists in database
        let podcast = await prisma.podcast.findUnique({
            where: { feedUrl: finalFeedUrl },
        });

        if (podcast) {
            logger.debug(`   Podcast exists in database: ${podcast.title}`);

            // Check if user is already subscribed
            const existingSubscription =
                await prisma.podcastSubscription.findUnique({
                    where: {
                        userId_podcastId: {
                            userId: req.user!.id,
                            podcastId: podcast.id,
                        },
                    },
                });

            if (existingSubscription) {
                logger.debug(`     User already subscribed`);
                return res.json({
                    success: true,
                    podcast: {
                        id: podcast.id,
                        title: podcast.title,
                    },
                    message: "Already subscribed",
                });
            }

            // Subscribe user to existing podcast
            await prisma.podcastSubscription.create({
                data: {
                    userId: req.user!.id,
                    podcastId: podcast.id,
                },
            });

            logger.debug(`   User subscribed to existing podcast`);
            return res.json({
                success: true,
                podcast: {
                    id: podcast.id,
                    title: podcast.title,
                },
                message: "Subscribed successfully",
            });
        }

        // Parse RSS feed to get podcast and episodes
        logger.debug(`   Parsing RSS feed...`);
        const subscribeResult = await rssParserService.parseFeed(finalFeedUrl);
        if (subscribeResult.notModified) {
            return res.status(500).json({ error: "Unexpected 304 on initial subscribe" });
        }
        const { podcast: podcastData, episodes } = subscribeResult;

        // Create podcast in database
        logger.debug(`    Saving podcast to database...`);
        // The column is a string, but iTunes ids arrive as numbers (e.g. from /discover/top).
        const rawItunesId = itunesId ?? podcastData.itunesId;
        const finalItunesId =
            rawItunesId === null || rawItunesId === undefined || rawItunesId === ""
                ? null
                : String(rawItunesId);
        logger.debug(`   iTunes ID to save: ${finalItunesId || "NONE"}`);

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

        await assignCategories(podcast.id, finalItunesId, podcastData.categoryNames);
        logger.debug(`   Podcast created: ${podcast.id}`);
        logger.debug(`   iTunes ID saved: ${podcast.itunesId || "NONE"}`);

        // Save episodes
        logger.debug(`    Saving ${episodes.length} episodes...`);
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

        logger.debug(`   Episodes saved`);

        // Subscribe user
        await prisma.podcastSubscription.create({
            data: {
                userId: req.user!.id,
                podcastId: podcast.id,
            },
        });

        logger.debug(`   User subscribed successfully`);

        res.json({
            success: true,
            podcast: {
                id: podcast.id,
                title: podcast.title,
            },
            message: "Subscribed successfully",
        });
    } catch (error: any) {
        // A feed that cannot be fetched or parsed is the feed being
        // unavailable, not the server failing. The status-code rule: an
        // upstream 4xx surfaces as a 4xx here, never a 500 — a dead URL and a
        // broken database must not look the same to the client.
        if (
            error instanceof Error &&
            error.message.startsWith("Failed to parse podcast feed")
        ) {
            return res.status(422).json({
                error: "Podcast feed could not be read",
                detail: error.message,
            });
        }
        safeError(res, "Error subscribing to podcast", error);
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

        logger.debug(`\n [PODCAST] Refresh request`);
        logger.debug(`   Podcast ID: ${id}`);

        const result = await refreshPodcastFeed(id);

        logger.debug(
            `   Refresh complete. ${result.newEpisodesCount} new episodes added.`
        );

        res.json({
            success: true,
            newEpisodesCount: result.newEpisodesCount,
            totalEpisodes: result.totalEpisodes,
            message: `Found ${result.newEpisodesCount} new episodes`,
        });
    } catch (error) {
        if (error instanceof Error && error.message?.includes("not found")) {
            return res.status(404).json({ error: "Podcast not found" });
        }
        safeError(res, "Error refreshing podcast", error);
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

        // Stream from RSS URL
        logger.debug(`   Streaming from RSS: ${episode.audioUrl}`);

        // Get file size first for proper range handling
        let fileSize = episode.fileSize;
        if (!fileSize) {
            try {
                const headResponse = await axios.head(episode.audioUrl);
                fileSize = upstreamHeaderNumber(headResponse.headers["content-length"]);
                if (Number.isFinite(fileSize) && fileSize > 0) {
                    await prisma.podcastEpisode.update({
                        where: { id: episode.id },
                        data: { fileSize },
                    });
                }
            } catch (err) {
                logger.warn("    Could not get file size via HEAD request");
            }
        }

        if (range && fileSize) {
            const parsed = parseRangeHeader(range, fileSize);
            if (!parsed.ok && parsed.reason !== "multi") {
                res.status(416).set({
                    "Content-Range": `bytes */${fileSize}`,
                });
                res.end();
                return;
            }
            // Multi-range falls through to the full-file stream below.
            if (parsed.ok) {
                const { start, end } = parsed;

                logger.debug(
                    `    Range request: bytes=${start}-${end}/${fileSize}`
                );

                const controller = new AbortController();
                res.on("close", () => {
                    controller.abort();
                });

                try {
                    const response = await axios.get(episode.audioUrl, {
                        headers: { Range: `bytes=${start}-${end}` },
                        responseType: "stream",
                        validateStatus: (status) =>
                            status === 206 || status === 200,
                        timeout: 30000,
                        signal: controller.signal,
                    });

                    // An upstream that ignored Range answers 200; wrapping that in a 206 would confuse the browser.
                    if (response.status === 200) {
                        logger.debug(
                            `    Upstream returned 200 OK (ignored Range), streaming full response`
                        );
                        res.writeHead(200, {
                            ...baseHeaders,
                            "Content-Length":
                                upstreamHeader(response.headers["content-length"]) || fileSize,
                        });
                    } else {
                        res.writeHead(206, {
                            ...baseHeaders,
                            "Content-Range": `bytes ${start}-${end}/${fileSize}`,
                            "Content-Length": end - start + 1,
                        });
                    }

                    pipeUpstream(res, response.data, "RSS stream");
                    return;
                } catch (rangeError: any) {
                    if (axios.isCancel(rangeError)) {
                        logger.debug("    Request aborted by client");
                        return;
                    }
                    // Many podcast CDNs reject range requests; stream the whole file and the browser seeks locally.
                    logger.debug(
                        `    Range request failed (${
                            rangeError.response?.status || rangeError.message
                        }), falling back to full stream`
                    );

                    const response = await axios.get(episode.audioUrl, {
                        responseType: "stream",
                        timeout: 60000,
                        signal: controller.signal,
                    });

                    const contentLength = upstreamHeader(response.headers["content-length"]);

                    res.writeHead(200, {
                        ...baseHeaders,
                        ...(contentLength && { "Content-Length": contentLength }),
                    });

                    pipeUpstream(res, response.data, "RSS fallback stream");
                    return;
                }
            }
        }

        logger.debug(`    Streaming full file`);

        const controller = new AbortController();
        res.on("close", () => {
            controller.abort();
        });

        try {
            const response = await axios.get(episode.audioUrl, {
                responseType: "stream",
                signal: controller.signal,
            });

            const contentLength = upstreamHeader(response.headers["content-length"]);

            res.writeHead(200, {
                ...baseHeaders,
                ...(contentLength && { "Content-Length": contentLength }),
            });

            pipeUpstream(res, response.data, "RSS full stream");
        } catch (error: any) {
            if (axios.isCancel(error)) {
                logger.debug("    Request aborted by client");
                return;
            }
            throw error;
        }
    } catch (error) {
        if (!res.headersSent) {
            safeError(res, "Podcast stream error", error);
        } else {
            logger.error("Podcast stream error (headers already sent):", error);
        }
    }
});

/**
 * POST /podcasts/:podcastId/episodes/:episodeId/progress
 * Update playback progress for a podcast episode
 */
// Lenient on shape (numbers as strings, no duration) so no client the route already served is refused.
const progressSchema = z.object({
    currentTime: z.coerce.number().finite().min(0),
    duration: z.coerce.number().finite().min(0).default(0),
    isFinished: z.boolean().optional(),
});

router.post("/:podcastId/episodes/:episodeId/progress", requireAuth, async (req, res) => {
    try {
        const { episodeId } = req.params;
        const body = progressSchema.safeParse(req.body);
        if (!body.success) {
            return res.status(400).json({ error: "currentTime and duration (seconds) are required" });
        }
        const { currentTime, duration, isFinished } = body.data;
        const episode = await prisma.podcastEpisode.findUnique({ where: { id: episodeId }, select: { id: true } });
        if (!episode) {
            return res.status(404).json({ error: "Episode not found" });
        }

        logger.debug(`\n [PODCAST PROGRESS] Update:`);
        logger.debug(`   User: ${req.user!.username}`);
        logger.debug(`   Episode ID: ${episodeId}`);
        logger.debug(`   Current Time: ${currentTime}s`);
        logger.debug(`   Duration: ${duration}s`);
        logger.debug(`   Finished: ${isFinished}`);

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
                duration,
                isFinished: isFinished || false,
            },
            update: {
                currentTime,
                duration,
                isFinished: isFinished || false,
                lastPlayedAt: new Date(),
            },
        });

        logger.debug(`   Progress saved`);

        res.json({
            success: true,
            progress: {
                currentTime: progress.currentTime,
                progress:
                    progress.duration > 0
                        ? Math.min(100, (progress.currentTime / progress.duration) * 100)
                        : 0,
                isFinished: progress.isFinished,
            },
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
        res.json(shows.map((show, i) => ({ ...show, score: shows.length - i })));
    } catch (error) {
        safeError(res, "Error fetching similar podcasts", error);
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
 * Refresh a single podcast feed -- shared logic used by both the route handler
 * and the enrichment worker's automatic refresh phase.
 */
export async function refreshPodcastFeed(podcastId: string): Promise<{ newEpisodesCount: number; totalEpisodes: number }> {
    const podcast = await prisma.podcast.findUnique({ where: { id: podcastId } });
    if (!podcast) throw new Error(`Podcast ${podcastId} not found`);

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
