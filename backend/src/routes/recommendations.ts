import { Router } from "express";
import { logger } from "../utils/logger";
import { requireAuth, requireAuthOrToken } from "../middleware/auth";
import { prisma } from "../utils/db";
import { lastFmService } from "../services/lastfm";

const router = Router();

router.use(requireAuthOrToken);

// GET /recommendations/for-you?limit=10
router.get("/for-you", async (req, res) => {
    try {
        const { limit = "10" } = req.query;
        const userId = req.user!.id;
        const limitNum = parseInt(limit as string, 10);

        // Get user's most played artists
        const recentPlays = await prisma.play.findMany({
            where: { userId },
            orderBy: { playedAt: "desc" },
            take: 50,
            include: {
                track: {
                    include: {
                        album: {
                            include: {
                                artist: true,
                            },
                        },
                    },
                },
            },
        });

        // Count plays per artist
        const artistPlayCounts = new Map<
            string,
            { artist: any; count: number }
        >();
        for (const play of recentPlays) {
            const artist = play.track.album.artist;
            const existing = artistPlayCounts.get(artist.id);
            if (existing) {
                existing.count++;
            } else {
                artistPlayCounts.set(artist.id, { artist, count: 1 });
            }
        }

        // Sort by play count and get top 3 seed artists
        const topArtists = Array.from(artistPlayCounts.values())
            .sort((a, b) => b.count - a.count)
            .slice(0, 3);

        if (topArtists.length === 0) {
            // No listening history, return empty recommendations
            return res.json({ artists: [] });
        }

        // Get similar artists for each top artist
        const allSimilarArtists = await Promise.all(
            topArtists.map(async ({ artist }) => {
                const similar = await prisma.similarArtist.findMany({
                    where: { fromArtistId: artist.id },
                    orderBy: { weight: "desc" },
                    take: 10,
                    include: {
                        toArtist: {
                            select: {
                                id: true,
                                mbid: true,
                                name: true,
                                heroUrl: true,
                            },
                        },
                    },
                });
                return similar.map((s) => s.toArtist);
            })
        );

        // Flatten and deduplicate
        const recommendedArtists = Array.from(
            new Map(
                allSimilarArtists.flat().map((artist) => [artist.id, artist])
            ).values()
        );

        // Filter out artists user already owns (from native library)
        const ownedArtists = await prisma.ownedAlbum.findMany({
            select: { artistId: true },
            distinct: ["artistId"],
        });
        const ownedArtistIds = new Set(ownedArtists.map((a) => a.artistId));

        logger.debug(
            `Filtering recommendations: ${ownedArtistIds.size} owned artists to exclude`
        );

        const newArtists = recommendedArtists.filter(
            (artist) => !ownedArtistIds.has(artist.id)
        );

        // Get album counts for recommended artists (from enriched discography)
        const recommendedArtistIds = newArtists
            .slice(0, limitNum)
            .map((a) => a.id);
        const albumCounts = await prisma.album.groupBy({
            by: ["artistId"],
            where: { artistId: { in: recommendedArtistIds } },
            _count: { rgMbid: true },
        });
        const albumCountMap = new Map(
            albumCounts.map((ac) => [ac.artistId, ac._count.rgMbid])
        );

        // ========== CACHE-ONLY IMAGE LOOKUP FOR RECOMMENDATIONS ==========
        // Only use cached data (DB heroUrl or Redis cache) - no API calls during page loads
        // Background enrichment worker will populate cache over time
        const { redisClient } = await import("../utils/redis");

        // Get all cached images in a single Redis call for efficiency
        const artistsToCheck = newArtists.slice(0, limitNum);
        const cacheKeys = artistsToCheck
            .filter(a => !a.heroUrl)
            .map(a => `hero:${a.id}`);
        
        let cachedImages: (string | null)[] = [];
        if (cacheKeys.length > 0) {
            try {
                cachedImages = await redisClient.mGet(cacheKeys);
            } catch (err) {
                // Redis errors are non-critical
            }
        }

        // Build a map from cache results
        const cachedImageMap = new Map<string, string>();
        let cacheIndex = 0;
        for (const artist of artistsToCheck) {
            if (!artist.heroUrl) {
                const cached = cachedImages[cacheIndex];
                if (cached && cached !== "NOT_FOUND") {
                    cachedImageMap.set(artist.id, cached);
                }
                cacheIndex++;
            }
        }

        const artistsWithMetadata = artistsToCheck.map((artist) => {
            // Use DB heroUrl first, then Redis cache, otherwise null
            const coverArt = artist.heroUrl || cachedImageMap.get(artist.id) || null;

            return {
                ...artist,
                coverArt,
                albumCount: albumCountMap.get(artist.id) || 0,
            };
        });

        logger.debug(
            `Recommendations: Found ${artistsWithMetadata.length} new artists`
        );
        artistsWithMetadata.forEach((a) => {
            logger.debug(
                `  ${a.name}: coverArt=${a.coverArt ? "YES" : "NO"}, albums=${
                    a.albumCount
                }`
            );
        });

        res.json({ artists: artistsWithMetadata });
    } catch (error) {
        logger.error("Get recommendations for you error:", error);
        res.status(500).json({ error: "Failed to get recommendations" });
    }
});

// GET /recommendations?seedArtistId=
router.get("/", async (req, res) => {
    try {
        const { seedArtistId } = req.query;

        if (!seedArtistId) {
            return res.status(400).json({ error: "seedArtistId required" });
        }

        // Get seed artist
        const seedArtist = await prisma.artist.findUnique({
            where: { id: seedArtistId as string },
        });

        if (!seedArtist) {
            return res.status(404).json({ error: "Artist not found" });
        }

        // Get similar artists from database
        const similarArtists = await prisma.similarArtist.findMany({
            where: { fromArtistId: seedArtistId as string },
            orderBy: { weight: "desc" },
            take: 20,
        });

        // Fetch full artist details for each similar artist
        const recommendations = await Promise.all(
            similarArtists.map(async (similar) => {
                const artist = await prisma.artist.findUnique({
                    where: { id: similar.toArtistId },
                });

                const albums = await prisma.album.findMany({
                    where: { artistId: similar.toArtistId },
                    orderBy: { year: "desc" },
                    take: 3,
                });

                const ownedAlbums = await prisma.ownedAlbum.findMany({
                    where: { artistId: similar.toArtistId },
                });

                const ownedRgMbids = new Set(ownedAlbums.map((o) => o.rgMbid));

                return {
                    artist: {
                        id: artist?.id,
                        mbid: artist?.mbid,
                        name: artist?.name,
                        heroUrl: artist?.heroUrl,
                    },
                    similarity: similar.weight,
                    topAlbums: albums.map((album) => ({
                        ...album,
                        owned: ownedRgMbids.has(album.rgMbid),
                    })),
                };
            })
        );

        res.json({
            seedArtist: {
                id: seedArtist.id,
                name: seedArtist.name,
            },
            recommendations,
        });
    } catch (error) {
        logger.error("Get recommendations error:", error);
        res.status(500).json({ error: "Failed to get recommendations" });
    }
});

// GET /recommendations/albums?seedAlbumId=
router.get("/albums", async (req, res) => {
    try {
        const { seedAlbumId } = req.query;

        if (!seedAlbumId) {
            return res.status(400).json({ error: "seedAlbumId required" });
        }

        // Get seed album
        const seedAlbum = await prisma.album.findUnique({
            where: { id: seedAlbumId as string },
            include: {
                artist: true,
                tracks: {
                    include: {
                        trackGenres: {
                            include: {
                                genre: true,
                            },
                        },
                    },
                },
            },
        });

        if (!seedAlbum) {
            return res.status(404).json({ error: "Album not found" });
        }

        // Get genre tags from the album's tracks
        const genreTags = Array.from(
            new Set(
                seedAlbum.tracks.flatMap((track) =>
                    track.trackGenres.map((tg) => tg.genre.name)
                )
            )
        );

        // Strategy 1: Get albums from similar artists
        const similarArtists = await prisma.similarArtist.findMany({
            where: { fromArtistId: seedAlbum.artistId },
            orderBy: { weight: "desc" },
            take: 10,
        });

        const similarArtistAlbums = await prisma.album.findMany({
            where: {
                artistId: { in: similarArtists.map((sa) => sa.toArtistId) },
                id: { not: seedAlbumId as string }, // Exclude seed album
            },
            include: {
                artist: true,
            },
            orderBy: { year: "desc" },
            take: 15,
        });

        // Strategy 2: Get albums with matching genres
        let genreMatchAlbums: any[] = [];
        if (genreTags.length > 0) {
            genreMatchAlbums = await prisma.album.findMany({
                where: {
                    id: { not: seedAlbumId as string },
                    tracks: {
                        some: {
                            trackGenres: {
                                some: {
                                    genre: {
                                        name: { in: genreTags },
                                    },
                                },
                            },
                        },
                    },
                },
                include: {
                    artist: true,
                },
                take: 10,
            });
        }

        // Combine and deduplicate
        const allAlbums = [...similarArtistAlbums, ...genreMatchAlbums];
        const uniqueAlbums = Array.from(
            new Map(allAlbums.map((album) => [album.id, album])).values()
        );

        // Check ownership
        const recommendations = await Promise.all(
            uniqueAlbums.slice(0, 20).map(async (album) => {
                const ownedAlbums = await prisma.ownedAlbum.findMany({
                    where: { artistId: album.artistId },
                });

                const ownedRgMbids = new Set(ownedAlbums.map((o) => o.rgMbid));

                return {
                    ...album,
                    owned: ownedRgMbids.has(album.rgMbid),
                };
            })
        );

        res.json({
            seedAlbum: {
                id: seedAlbum.id,
                title: seedAlbum.title,
                artist: seedAlbum.artist.name,
            },
            recommendations,
        });
    } catch (error) {
        logger.error("Get album recommendations error:", error);
        res.status(500).json({
            error: "Failed to get album recommendations",
        });
    }
});

// GET /recommendations/tracks?seedTrackId=
router.get("/tracks", async (req, res) => {
    try {
        const { seedTrackId } = req.query;

        if (!seedTrackId) {
            return res.status(400).json({ error: "seedTrackId required" });
        }

        // Get seed track
        const seedTrack = await prisma.track.findUnique({
            where: { id: seedTrackId as string },
            include: {
                album: {
                    include: {
                        artist: true,
                    },
                },
            },
        });

        if (!seedTrack) {
            return res.status(404).json({ error: "Track not found" });
        }

        // Use Last.fm to get similar tracks
        const similarTracksFromLastFm = await lastFmService.getSimilarTracks(
            seedTrack.album.artist.name,
            seedTrack.title,
            20
        );

        // Try to match similar tracks in our library
        const recommendations = [];

        for (const lfmTrack of similarTracksFromLastFm) {
            const matchedTracks = await prisma.track.findMany({
                where: {
                    title: {
                        contains: lfmTrack.name,
                        mode: "insensitive",
                    },
                    album: {
                        artist: {
                            name: {
                                contains: lfmTrack.artist?.name || "",
                                mode: "insensitive",
                            },
                        },
                    },
                },
                include: {
                    album: {
                        include: {
                            artist: true,
                        },
                    },
                },
                take: 1,
            });

            if (matchedTracks.length > 0) {
                recommendations.push({
                    ...matchedTracks[0],
                    inLibrary: true,
                    similarity: lfmTrack.match || 0,
                });
            } else {
                // Include Last.fm suggestion even if not in library
                recommendations.push({
                    title: lfmTrack.name,
                    artist: lfmTrack.artist?.name || "Unknown",
                    inLibrary: false,
                    similarity: lfmTrack.match || 0,
                    lastFmUrl: lfmTrack.url,
                });
            }
        }

        res.json({
            seedTrack: {
                id: seedTrack.id,
                title: seedTrack.title,
                artist: seedTrack.album.artist.name,
                album: seedTrack.album.title,
            },
            recommendations,
        });
    } catch (error) {
        logger.error("Get track recommendations error:", error);
        res.status(500).json({
            error: "Failed to get track recommendations",
        });
    }
});

export default router;
