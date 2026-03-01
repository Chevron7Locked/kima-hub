import { Router } from "express";
import { logger } from "../utils/logger";
import { requireAuth } from "../middleware/auth";
import { prisma } from "../utils/db";
import { lastFmService } from "../services/lastfm";
import { searchService, normalizeCacheQuery, type SearchResults } from "../services/search";
import axios from "axios";
import { redisClient } from "../utils/redis";

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
            albumId: track.albumId,
            duration: track.duration,
            trackNo: 0,
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
            });

            return res.json(transformSearchResults(serviceResults));
        }

        // Single-type search (service handles caching)
        const serviceResults = await searchService.searchByType({
            query,
            type: type as string,
            limit: searchLimit,
            genre: genre as string | undefined,
        });

        res.json(transformSearchResults(serviceResults));
    } catch (error) {
        logger.error("Search error:", error);
        res.status(500).json({ error: "Search failed" });
    }
});

// GET /search/genres
router.get("/genres", async (req, res) => {
    try {
        const genres = await prisma.genre.findMany({
            orderBy: { name: "asc" },
            include: {
                _count: {
                    select: { trackGenres: true },
                },
            },
        });

        res.json(
            genres.map((g) => ({
                id: g.id,
                name: g.name,
                trackCount: g._count.trackGenres,
            }))
        );
    } catch (error) {
        logger.error("Get genres error:", error);
        res.status(500).json({ error: "Failed to get genres" });
    }
});

/**
 * GET /search/discover?q=query&type=music|podcasts
 * Search for NEW content to discover (not in your library).
 * Cache TTL: 15 min -- external data changes infrequently.
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

        // Cache TTL: 15 min (900s) -- external API data rarely changes
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

        // Resolve alias (sequential -- modifies the search query, cached 30 days)
        let searchQuery = query;
        let aliasInfo: { original: string; canonical: string; mbid?: string } | null = null;

        if (type === "music" || type === "all") {
            try {
                const correction = await lastFmService.getArtistCorrection(query);
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
            }
        }

        // Build parallel promises for independent external calls
        const promiseMap: Record<string, Promise<any>> = {};

        if (type === "music" || type === "all") {
            promiseMap.artists = lastFmService.searchArtists(searchQuery, searchLimit);
            promiseMap.tracks = lastFmService.searchTracks(searchQuery, searchLimit);
        }

        if (type === "podcasts" || type === "all") {
            promiseMap.podcasts = axios.get("https://itunes.apple.com/search", {
                params: { term: query, media: "podcast", entity: "podcast", limit: searchLimit },
                timeout: 5000,
            }).then((resp) => resp.data.results.map((podcast: any) => ({
                type: "podcast",
                id: podcast.collectionId,
                name: podcast.collectionName,
                artist: podcast.artistName,
                description: podcast.description,
                coverUrl: podcast.artworkUrl600 || podcast.artworkUrl100,
                feedUrl: podcast.feedUrl,
                genres: podcast.genres || [],
                trackCount: podcast.trackCount,
            })));
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

        try {
            await redisClient.setEx(cacheKey, 900, JSON.stringify(payload));
        } catch (err) {
            logger.warn("[SEARCH DISCOVER] Redis write error:", err);
        }

        res.json(payload);
    } catch (error) {
        logger.error("Discovery search error:", error);
        res.status(500).json({ error: "Discovery search failed" });
    }
});

/**
 * GET /search/discover/similar?artist=name&mbid=xxx
 * Fetch musically similar artists (Last.fm getSimilar).
 * Separate from discover so main search results return immediately.
 * Cache TTL: 1 hour -- similar artists change very rarely.
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

        const similar = await lastFmService.getSimilarArtists(artistMbid, artistName, 10);
        const similarArtists = similar.length > 0
            ? await lastFmService.enrichSimilarArtists(similar, 6)
            : [];

        const payload = { similarArtists };

        try {
            // Cache TTL: 1 hour (3600s) -- similar artists rarely change
            await redisClient.setEx(cacheKey, 3600, JSON.stringify(payload));
        } catch (err) {
            logger.warn("[SEARCH SIMILAR] Redis write error:", err);
        }

        res.json(payload);
    } catch (error) {
        logger.error("Similar artists search error:", error);
        res.status(500).json({ error: "Similar artists search failed" });
    }
});

export default router;
