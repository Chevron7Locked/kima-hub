import { Router } from "express";
import { logger } from "../utils/logger";
import { prisma } from "../utils/db";
import { redisClient } from "../utils/redis";
import { PLAYABLE_SONG } from "../utils/playableSong";
import { recentPlayArtists } from "../services/stats/listens";
import { parseLimit } from "./library/paging";
import type { Artist } from "@prisma/client";

const router = Router();

// GET /recommendations/for-you?limit=10
router.get("/for-you", async (req, res) => {
    try {
        const userId = req.user!.id;
        // Default 10, at least 1, at most 50: a value that is not a number is the default, not NaN.
        const limitNum = parseLimit(req.query.limit, 10, 50);

        // Get user's most played artists
        // Plays of playable songs only: a Discover song feeds nothing until its album is liked into the library, and a
        // missing or corrupt one nothing until it is back.
        const playArtists = await recentPlayArtists(userId, { song: PLAYABLE_SONG, take: 50 });

        // Count plays per artist
        const artistPlayCounts = new Map<
            string,
            { artist: Artist; count: number }
        >();
        for (const artist of playArtists) {
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

        // Get similar artists for each top artist: only ones the library does not own, so `limit` per seed is enough for
        // `limit` in all. Equal weights go by artist id, so the same listener gets the same page every time.
        const allSimilarArtists = await Promise.all(
            topArtists.map(async ({ artist }) => {
                const similar = await prisma.similarArtist.findMany({
                    where: {
                        fromArtistId: artist.id,
                        toArtist: { ownedAlbums: { none: {} } },
                    },
                    orderBy: [{ weight: "desc" }, { toArtistId: "asc" }],
                    take: limitNum,
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
        const newArtists = Array.from(
            new Map(
                allSimilarArtists.flat().map((artist) => [artist.id, artist])
            ).values()
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

        // Pictures come from what is stored (the artist row, then the Redis cache), never a lookup during a page load.
        const artistsToCheck = newArtists.slice(0, limitNum);
        const cacheKeys = artistsToCheck
            .filter(a => !a.heroUrl)
            .map(a => `hero:${a.id}`);

        let cachedImages: (string | null)[] = [];
        if (cacheKeys.length > 0) {
            try {
                cachedImages = await redisClient.mget(cacheKeys);
            } catch {
                // Redis is down: these artists go out without a cached image.
            }
        }

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
            const coverArt = artist.heroUrl || cachedImageMap.get(artist.id) || null;

            return {
                ...artist,
                coverArt,
                albumCount: albumCountMap.get(artist.id) || 0,
            };
        });

        res.json({ artists: artistsWithMetadata });
    } catch (error) {
        logger.error("Get recommendations for you error:", error);
        res.status(500).json({ error: "Failed to get recommendations" });
    }
});

export default router;
