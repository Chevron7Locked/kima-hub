import { Router } from "express";
import { logger } from "../utils/logger";
import { requireAuth } from "../middleware/auth";
import { prisma } from "../utils/db";
import {
    getSimilarArtists,
    enrichSimilarArtists,
    type SimilarArtist,
} from "../services/artistSimilarity";
import { getArtistCorrection } from "../services/artistCorrection";
import { musicBrainzService } from "../services/musicbrainz";
import { searchService, normalizeCacheQuery, type SearchResults } from "../services/search";
import { redisClient } from "../utils/redis";
import { categoryIdsFrom, searchShows } from "../services/podcastCatalog";
import { failureCause } from "../utils/outcome";

const router = Router();

function transformSearchResults(serviceResults: SearchResults) {
    return {
        artists: serviceResults.artists,
        albums: serviceResults.albums.map((album) => ({
            id: album.id,
            title: album.title,
            artistId: album.artistId,
            year: album.year,
            coverUrl: album.coverUrl,
            artist: {
                id: album.artistId,
                name: album.artistName,
                mbid: "",
            },
        })),
        tracks: serviceResults.tracks.map((track) => ({
            id: track.id,
            title: track.title,
            displayTitle: track.displayTitle,
            albumId: track.albumId,
            duration: track.duration,
            trackNo: 0,
            discNumber: null,
            discSubtitle: null,
            album: {
                id: track.albumId,
                title: track.albumTitle,
                artistId: track.artistId,
                coverUrl: null,
                artist: {
                    id: track.artistId,
                    name: track.artistName,
                    mbid: "",
                },
            },
        })),
        audiobooks: serviceResults.audiobooks,
        podcasts: serviceResults.podcasts,
        episodes: serviceResults.episodes,
    };
}

router.use(requireAuth);

router.get("/", async (req, res) => {
    try {
        const { q = "", type = "all", genre, limit = "20" } = req.query;

        const query = (q as string).trim();
        const parsed = parseInt(limit as string, 10);
        const searchLimit = Number.isNaN(parsed) ? 20 : Math.min(Math.max(parsed, 1), 100);

        if (!query) {
            return res.json({
                artists: [],
                albums: [],
                tracks: [],
                audiobooks: [],
                podcasts: [],
                episodes: [],
            });
        }

        // Delegate to service (handles caching + parallel execution + genre filtering)
        if (type === "all") {
            const serviceResults = await searchService.searchAll({
                query,
                limit: searchLimit,
                genre: genre as string | undefined,
                userId: req.user!.id,
            });

            return res.json(transformSearchResults(serviceResults));
        }

        // Single-type search (service handles caching)
        const serviceResults = await searchService.searchByType({
            query,
            type: type as string,
            limit: searchLimit,
            genre: genre as string | undefined,
            userId: req.user!.id,
        });

        res.json(transformSearchResults(serviceResults));
    } catch (error) {
        logger.error("Search error:", error);
        res.status(500).json({ error: "Search failed" });
    }
});

/**
 * GET /search/discover?q=query&type=music|podcasts
 * Artists from MusicBrainz, songs from the library and podcasts from Apple, cached for 15 minutes.
 */
router.get("/discover", async (req, res) => {
    try {
        const { q = "", type = "music", limit = "20" } = req.query;

        const query = (q as string).trim();
        const parsedLimit = parseInt(limit as string, 10);
        const searchLimit = Number.isNaN(parsedLimit) ? 20 : Math.min(Math.max(parsedLimit, 1), 50);

        if (!query) {
            return res.json({ results: [], aliasInfo: null });
        }

        const cacheKey = `search:discover:${type}:${normalizeCacheQuery(query)}:${searchLimit}`;
        try {
            const cached = await redisClient.get(cacheKey);
            if (cached) {
                logger.debug(`[SEARCH DISCOVER] Cache hit for query="${query}" type=${type}`);
                return res.json(JSON.parse(cached));
            }
        } catch (err) {
            logger.warn("[SEARCH DISCOVER] Redis read error:", err);
        }

        const results: any[] = [];
        // An empty section that came from a source failure must not be
        // cached as an empty answer, or a recovered source keeps serving
        // "no results" until the TTL expires.
        let cacheable = true;

        // Resolve alias (sequential -- modifies the search query, cached 30 days)
        let searchQuery = query;
        let aliasInfo: { original: string; canonical: string; mbid?: string } | null = null;

        if (type === "music" || type === "all") {
            try {
                const correction = await getArtistCorrection(query);
                if (correction?.corrected) {
                    searchQuery = correction.canonicalName;
                    aliasInfo = {
                        original: query,
                        canonical: correction.canonicalName,
                        mbid: correction.mbid,
                    };
                    logger.debug(`[SEARCH DISCOVER] Alias resolved: "${query}" -> "${correction.canonicalName}"`);
                }
            } catch (correctionError) {
                logger.warn("[SEARCH DISCOVER] Correction check failed:", correctionError);
                cacheable = false;
            }
        }

        // Build parallel promises for independent external calls
        const promiseMap: Record<string, Promise<any>> = {};

        if (type === "music" || type === "all") {
            // Artist results: MusicBrainz search.
            promiseMap.artists = (async () => {
                const found = await musicBrainzService.searchArtist(searchQuery, searchLimit);
                if (found.kind !== "answered") {
                    // Empty section, not a fabricated answer: the real
                    // cause goes to the log.
                    logger.warn(
                        `[SEARCH] MB artist search ${found.kind}: ${
                            found.kind === "absent"
                                ? "no matches"
                                : failureCause(found)
                        }`,
                    );
                    if (found.kind !== "absent") cacheable = false;
                    return [];
                }
                const similar: SimilarArtist[] = found.value.map((a: { id: string; name: string }) => ({
                    name: a.name,
                    mbid: a.id,
                    match: 1,
                    url: `https://musicbrainz.org/artist/${a.id}`,
                }));
                return enrichSimilarArtists(similar, searchLimit);
            })();
            // Track results: local library search.
            promiseMap.tracks = (async () => {
                const local = await searchService.searchTracks({ query: searchQuery, limit: searchLimit });
                const albumIds = [...new Set(local.map((t) => t.albumId).filter(Boolean))];
                const albums = await prisma.album.findMany({
                    where: { id: { in: albumIds } },
                    select: { id: true, coverUrl: true },
                });
                const coverById = new Map(albums.map((a) => [a.id, a.coverUrl]));
                return local.map((t) => ({
                    type: "track",
                    id: t.id,
                    name: t.displayTitle || t.title,
                    artist: t.artistName,
                    album: t.albumTitle,
                    listeners: 0,
                    url: "",
                    image: coverById.get(t.albumId) || null,
                    mbid: undefined,
                }));
            })();
        }

        if (type === "podcasts" || type === "all") {
            promiseMap.podcasts = (async () => {
                try {
                    return (await searchShows(query, searchLimit)).map((podcast: any) => ({
                        type: "podcast",
                        id: podcast.collectionId,
                        name: podcast.collectionName,
                        artist: podcast.artistName,
                        description: podcast.description,
                        coverUrl: podcast.artworkUrl600 || podcast.artworkUrl100,
                        feedUrl: podcast.feedUrl,
                        genres: (podcast.genres || []).filter((g: string) => g !== "Podcasts"),
                        categoryIds: categoryIdsFrom(podcast.genreIds),
                        trackCount: podcast.trackCount,
                    }));
                } catch (err: any) {
                    logger.warn("[SEARCH DISCOVER] iTunes podcast search failed:", err?.message || err);
                    cacheable = false;
                    return [];
                }
            })();
        }

        // Await all with allSettled so one failure doesn't block others
        const keys = Object.keys(promiseMap);
        const settled = await Promise.allSettled(keys.map((k) => promiseMap[k]));
        const resolved: Record<string, any[]> = {};
        keys.forEach((k, i) => {
            const result = settled[i];
            if (result.status === "fulfilled") {
                resolved[k] = result.value;
            } else {
                logger.error(`[SEARCH DISCOVER] ${k} search failed:`, result.reason);
                resolved[k] = [];
                cacheable = false;
            }
        });

        if (resolved.artists) {
            logger.debug(`[SEARCH DISCOVER] Found ${resolved.artists.length} artist results`);
            results.push(...resolved.artists);
        }
        if (resolved.tracks) {
            logger.debug(`[SEARCH DISCOVER] Found ${resolved.tracks.length} track results`);
            results.push(...resolved.tracks);
        }
        if (resolved.podcasts) {
            results.push(...resolved.podcasts);
        }

        const payload = { results, aliasInfo };

        if (cacheable) {
            try {
                await redisClient.setex(cacheKey, 900, JSON.stringify(payload));
            } catch (err) {
                logger.warn("[SEARCH DISCOVER] Redis write error:", err);
            }
        } else {
            logger.debug(
                `[SEARCH DISCOVER] Not caching "${query}" — at least one section came from a source failure`
            );
        }

        res.json(payload);
    } catch (error) {
        logger.error("Discovery search error:", error);
        res.status(500).json({ error: "Discovery search failed" });
    }
});

/**
 * GET /search/discover/similar?artist=name&mbid=xxx
 * Fetch musically similar artists (ListenBrainz, then Deezer).
 * Separate from discover so main search results return immediately; cached for an hour.
 */
router.get("/discover/similar", async (req, res) => {
    try {
        const { artist = "", mbid = "" } = req.query;
        const artistName = (artist as string).trim();
        const artistMbid = (mbid as string).trim();

        if (!artistName) {
            return res.json({ similarArtists: [] });
        }

        const cacheKey = `search:discover:similar:${normalizeCacheQuery(artistName)}:${artistMbid}`;
        try {
            const cached = await redisClient.get(cacheKey);
            if (cached) {
                logger.debug(`[SEARCH SIMILAR] Cache hit for artist="${artistName}"`);
                return res.json(JSON.parse(cached));
            }
        } catch (err) {
            logger.warn("[SEARCH SIMILAR] Redis read error:", err);
        }

        // artistSimilarity never throws; empty means "no data anywhere".
        const similar = await getSimilarArtists(artistMbid, artistName, 10);

        const similarArtists =
            similar.length > 0
                ? await enrichSimilarArtists(similar, 6)
                : [];

        const payload = { similarArtists };

        if (similar.length > 0) {
            try {
                await redisClient.setex(cacheKey, 3600, JSON.stringify(payload));
            } catch (err) {
                logger.warn("[SEARCH SIMILAR] Redis write error:", err);
            }
        }

        res.json(payload);
    } catch (error) {
        logger.error("Similar artists search error:", error);
        res.status(500).json({ error: "Similar artists search failed" });
    }
});

export default router;
