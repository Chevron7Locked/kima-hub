import { Router } from "express";
import { logger } from "../utils/logger";
import { requireAuth } from "../middleware/auth";
import { prisma } from "../utils/db";
import { audiobookshelfService } from "../services/audiobookshelf";
import { lastFmService } from "../services/lastfm";
import { searchService } from "../services/search";
import axios from "axios";
import { redisClient } from "../utils/redis";

const router = Router();

router.use(requireAuth);

/**
 * @openapi
 * /search:
 *   get:
 *     summary: Search across your music library
 *     description: Search for artists, albums, tracks, audiobooks, and podcasts in your library using PostgreSQL full-text search
 *     tags: [Search]
 *     security:
 *       - sessionAuth: []
 *       - apiKeyAuth: []
 *     parameters:
 *       - in: query
 *         name: q
 *         schema:
 *           type: string
 *         required: true
 *         description: Search query
 *         example: "radiohead"
 *       - in: query
 *         name: type
 *         schema:
 *           type: string
 *           enum: [all, artists, albums, tracks, audiobooks, podcasts, episodes]
 *         description: Type of content to search
 *         default: all
 *       - in: query
 *         name: genre
 *         schema:
 *           type: string
 *         description: Filter tracks by genre
 *       - in: query
 *         name: limit
 *         schema:
 *           type: integer
 *           minimum: 1
 *           maximum: 100
 *         description: Maximum number of results per type
 *         default: 20
 *     responses:
 *       200:
 *         description: Search results
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               properties:
 *                 artists:
 *                   type: array
 *                   items:
 *                     $ref: '#/components/schemas/Artist'
 *                 albums:
 *                   type: array
 *                   items:
 *                     $ref: '#/components/schemas/Album'
 *                 tracks:
 *                   type: array
 *                   items:
 *                     $ref: '#/components/schemas/Track'
 *                 audiobooks:
 *                   type: array
 *                   items:
 *                     type: object
 *                 podcasts:
 *                   type: array
 *                   items:
 *                     type: object
 *       401:
 *         description: Not authenticated
 *         content:
 *           application/json:
 *             schema:
 *               $ref: '#/components/schemas/Error'
 */
router.get("/", async (req, res) => {
    try {
        const { q = "", type = "all", genre, limit = "20" } = req.query;

        const query = (q as string).trim();
        const searchLimit = Math.min(parseInt(limit as string, 10), 100);

        if (!query) {
            return res.json({
                artists: [],
                albums: [],
                tracks: [],
                audiobooks: [],
                podcasts: [],
            });
        }

        // Check cache for library search (short TTL since library can change)
        const cacheKey = `search:library:${type}:${
            genre || ""
        }:${query}:${searchLimit}`;
        try {
            const cached = await redisClient.get(cacheKey);
            if (cached) {
                logger.debug(`[SEARCH] Cache hit for query="${query}"`);
                return res.json(JSON.parse(cached));
            }
        } catch (err) {
            // Redis errors are non-critical
        }

        const results: any = {
            artists: [],
            albums: [],
            tracks: [],
            audiobooks: [],
            podcasts: [],
            episodes: [],
        };

        // Search artists using full-text search (only show artists with actual albums in library)
        if (type === "all" || type === "artists") {
            const artistResults = await searchService.searchArtists({
                query,
                limit: searchLimit,
            });

            // Filter to only include artists with albums
            const artistIds = artistResults.map((a) => a.id);
            const artistsWithAlbums = await prisma.artist.findMany({
                where: {
                    id: { in: artistIds },
                    albums: {
                        some: {},
                    },
                },
                select: {
                    id: true,
                    mbid: true,
                    name: true,
                    heroUrl: true,
                    summary: true,
                },
            });

            // Preserve rank order from full-text search
            const rankMap = new Map(artistResults.map((a) => [a.id, a.rank]));
            results.artists = artistsWithAlbums.sort((a, b) => {
                const rankA = rankMap.get(a.id) || 0;
                const rankB = rankMap.get(b.id) || 0;
                return rankB - rankA; // Sort by rank DESC
            });
        }

        // Search albums using full-text search
        if (type === "all" || type === "albums") {
            const albumResults = await searchService.searchAlbums({
                query,
                limit: searchLimit,
            });

            results.albums = albumResults.map((album) => ({
                id: album.id,
                title: album.title,
                artistId: album.artistId,
                year: album.year,
                coverUrl: album.coverUrl,
                artist: {
                    id: album.artistId,
                    name: album.artistName,
                    mbid: "", // Not included in search result
                },
            }));
        }

        // Search tracks using full-text search
        if (type === "all" || type === "tracks") {
            const trackResults = await searchService.searchTracks({
                query,
                limit: searchLimit,
            });

            // If genre filter is applied, filter the results
            if (genre) {
                const trackIds = trackResults.map((t) => t.id);
                const tracksWithGenre = await prisma.track.findMany({
                    where: {
                        id: { in: trackIds },
                        trackGenres: {
                            some: {
                                genre: {
                                    name: {
                                        equals: genre as string,
                                        mode: "insensitive",
                                    },
                                },
                            },
                        },
                    },
                    select: { id: true },
                });

                const genreTrackIds = new Set(tracksWithGenre.map((t) => t.id));
                results.tracks = trackResults
                    .filter((t) => genreTrackIds.has(t.id))
                    .map((track) => ({
                        id: track.id,
                        title: track.title,
                        albumId: track.albumId,
                        duration: track.duration,
                        trackNo: 0, // Not included in search result
                        album: {
                            id: track.albumId,
                            title: track.albumTitle,
                            artistId: track.artistId,
                            coverUrl: null, // Not included in search result
                            artist: {
                                id: track.artistId,
                                name: track.artistName,
                                mbid: "", // Not included in search result
                            },
                        },
                    }));
            } else {
                results.tracks = trackResults.map((track) => ({
                    id: track.id,
                    title: track.title,
                    albumId: track.albumId,
                    duration: track.duration,
                    trackNo: 0, // Not included in search result
                    album: {
                        id: track.albumId,
                        title: track.albumTitle,
                        artistId: track.artistId,
                        coverUrl: null, // Not included in search result
                        artist: {
                            id: track.artistId,
                            name: track.artistName,
                            mbid: "", // Not included in search result
                        },
                    },
                }));
            }
        }

        // Search audiobooks using FTS
        if (type === "all" || type === "audiobooks") {
            try {
                const audiobooks = await searchService.searchAudiobooksFTS({
                    query,
                    limit: searchLimit,
                });
                results.audiobooks = audiobooks;
            } catch (error) {
                logger.error("Audiobook search error:", error);
                results.audiobooks = [];
            }
        }

        // Search podcasts using FTS
        if (type === "all" || type === "podcasts") {
            try {
                const podcasts = await searchService.searchPodcastsFTS({
                    query,
                    limit: searchLimit,
                });
                results.podcasts = podcasts;
            } catch (error) {
                logger.error("Podcast search error:", error);
                results.podcasts = [];
            }
        }

        // Search podcast episodes
        if (type === "all" || type === "episodes") {
            try {
                const episodes = await searchService.searchEpisodes({
                    query,
                    limit: searchLimit,
                });
                results.episodes = episodes;
            } catch (error) {
                logger.error("Episode search error:", error);
                results.episodes = [];
            }
        }

        // Cache search results for 2 minutes (library can change)
        try {
            await redisClient.setEx(cacheKey, 120, JSON.stringify(results));
        } catch (err) {
            // Redis errors are non-critical
        }

        res.json(results);
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
 * Search for NEW content to discover (not in your library)
 */
router.get("/discover", async (req, res) => {
    try {
        const { q = "", type = "music", limit = "20" } = req.query;

        const query = (q as string).trim();
        const searchLimit = Math.min(parseInt(limit as string, 10), 50);

        if (!query) {
            return res.json({ results: [] });
        }

        const cacheKey = `search:discover:${type}:${query}:${searchLimit}`;
        try {
            const cached = await redisClient.get(cacheKey);
            if (cached) {
                logger.debug(
                    `[SEARCH DISCOVER] Cache hit for query="${query}" type=${type}`
                );
                return res.json(JSON.parse(cached));
            }
        } catch (err) {
            logger.warn("[SEARCH DISCOVER] Redis read error:", err);
        }

        const results: any[] = [];

        if (type === "music" || type === "all") {
            // Search Last.fm for artists AND tracks
            try {
                // Check if query is a potential alias
                let searchQuery = query;
                let aliasInfo: any = null;

                try {
                    const correction = await lastFmService.getArtistCorrection(query);
                    if (correction?.corrected) {
                        // Query is an alias - search for canonical name instead
                        searchQuery = correction.canonicalName;
                        aliasInfo = {
                            type: "alias_resolution",
                            original: query,
                            canonical: correction.canonicalName,
                            mbid: correction.mbid,
                        };
                        logger.debug(
                            `[SEARCH DISCOVER] Alias resolved: "${query}" → "${correction.canonicalName}"`
                        );
                    }
                } catch (correctionError) {
                    logger.warn("[SEARCH DISCOVER] Correction check failed:", correctionError);
                }

                // Search for artists (using potentially corrected query)
                const lastfmArtistResults = await lastFmService.searchArtists(
                    searchQuery,
                    searchLimit
                );
                logger.debug(
                    `[SEARCH ENDPOINT] Found ${lastfmArtistResults.length} artist results`
                );

                // Add alias info to response if applicable
                if (aliasInfo) {
                    results.push(aliasInfo);
                }

                results.push(...lastfmArtistResults);

                // Search for tracks (songs) - use corrected query for consistency
                const lastfmTrackResults = await lastFmService.searchTracks(
                    searchQuery,
                    searchLimit
                );
                logger.debug(
                    `[SEARCH ENDPOINT] Found ${lastfmTrackResults.length} track results`
                );
                results.push(...lastfmTrackResults);
            } catch (error) {
                logger.error("Last.fm search error:", error);
            }
        }

        if (type === "podcasts" || type === "all") {
            // Search iTunes Podcast API
            try {
                const itunesResponse = await axios.get(
                    "https://itunes.apple.com/search",
                    {
                        params: {
                            term: query,
                            media: "podcast",
                            entity: "podcast",
                            limit: searchLimit,
                        },
                        timeout: 5000,
                    }
                );

                const podcasts = itunesResponse.data.results.map(
                    (podcast: any) => ({
                        type: "podcast",
                        id: podcast.collectionId,
                        name: podcast.collectionName,
                        artist: podcast.artistName,
                        description: podcast.description,
                        coverUrl:
                            podcast.artworkUrl600 || podcast.artworkUrl100,
                        feedUrl: podcast.feedUrl,
                        genres: podcast.genres || [],
                        trackCount: podcast.trackCount,
                    })
                );

                results.push(...podcasts);
            } catch (error) {
                logger.error("iTunes podcast search error:", error);
            }
        }

        const payload = { results };

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

export default router;
