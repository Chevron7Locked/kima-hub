import { Router } from "express";
import { logger } from "../utils/logger";
import { requireAuthOrToken, requireAdmin } from "../middleware/auth";
import { programmaticPlaylistService } from "../services/mixes";
import {
    moodBucketService,
    VALID_MOODS,
    MoodType,
} from "../services/moodBucketService";
import { prisma } from "../utils/db";
import { redisClient } from "../utils/redis";
import { MOOD_MIX_LIMIT, validateSaveTrackIds } from "./mixesValidation";
import { rankForPosition } from "../utils/lexoRank";
import { announcePlaylistChange } from "../services/playlistEvents";

const router = Router();

router.use(requireAuthOrToken);

const getRequestUserId = (req: any): string | null => {
    return req.user?.id || req.session?.userId || null;
};

const MIXES_CACHE_TTL = 3600; // 1 hour

function mixesCacheKey(userId: string): string {
    return `mixes:${userId}`;
}

/** All of the user's mixes: Redis first, regenerated and cached on a miss. */
async function getMixesForUser(userId: string): Promise<any[]> {
    const cached = await redisClient.get(mixesCacheKey(userId));
    if (cached) {
        return JSON.parse(cached);
    }

    const mixes = await programmaticPlaylistService.generateAllMixes(userId);
    await redisClient.setex(
        mixesCacheKey(userId),
        MIXES_CACHE_TTL,
        JSON.stringify(mixes)
    );
    return mixes;
}

/** Full track rows for the given ids, in the order the ids list them. */
async function loadTracksInMixOrder(trackIds: string[]): Promise<any[]> {
    const tracks = await prisma.track.findMany({
        where: { id: { in: trackIds } },
        include: {
            album: {
                include: {
                    artist: {
                        select: { id: true, name: true, mbid: true },
                    },
                },
            },
        },
    });
    return trackIds
        .map((id) => tracks.find((t) => t.id === id))
        .filter((t: any) => t !== undefined);
}

router.get("/", async (req, res) => {
    try {
        const userId = getRequestUserId(req);
        if (!userId) {
            return res.status(401).json({ error: "Not authenticated" });
        }

        res.json(await getMixesForUser(userId));
    } catch (error) {
        logger.error("Get mixes error:", error);
        res.status(500).json({ error: "Failed to get mixes" });
    }
});

router.get("/mood/buckets/presets", async (_req, res) => {
    try {
        const presets = await moodBucketService.getMoodPresets();
        res.json(presets);
    } catch (error) {
        logger.error("Get mood presets error:", error);
        res.status(500).json({ error: "Failed to get mood presets" });
    }
});

router.get("/mood/buckets/:mood", async (req, res) => {
    try {
        const mood = req.params.mood as MoodType;

        if (!VALID_MOODS.includes(mood)) {
            return res.status(400).json({
                error: `Invalid mood: ${mood}`,
                validMoods: VALID_MOODS,
            });
        }

        // Skip what this user was already served, then remember the ids this
        // mix actually went out with, so the next one doesn't repeat them.
        const userId = getRequestUserId(req);
        const remembered = userId
            ? await moodBucketService.getRememberedTrackIds(userId, mood)
            : [];

        const mix = await moodBucketService.getMoodMix(
            mood,
            MOOD_MIX_LIMIT,
            remembered
        );

        if (!mix) {
            return res.status(400).json({
                error: `Not enough tracks for mood: ${mood}`,
                suggestion: "Wait for more tracks to be analyzed",
            });
        }

        if (userId) {
            await moodBucketService.recordServedTracks(userId, mood, mix.trackIds);
        }

        const orderedTracks = await loadTracksInMixOrder(mix.trackIds);

        res.json({
            ...mix,
            tracks: orderedTracks,
        });
    } catch (error) {
        logger.error("Get mood bucket mix error:", error);
        res.status(500).json({ error: "Failed to get mood mix" });
    }
});

router.post("/mood/buckets/:mood/save", async (req, res) => {
    try {
        const userId = getRequestUserId(req);
        if (!userId) {
            return res.status(401).json({ error: "Not authenticated" });
        }

        const mood = req.params.mood as MoodType;

        if (!VALID_MOODS.includes(mood)) {
            return res.status(400).json({
                error: `Invalid mood: ${mood}`,
                validMoods: VALID_MOODS,
            });
        }

        // Validate optional trackIds from request body (pure helper — see tests).
        const validation = validateSaveTrackIds(req.body.trackIds, MOOD_MIX_LIMIT);
        if ("error" in validation) {
            return res.status(400).json({ error: validation.error });
        }
        const trackIds = validation.trackIds;

        const savedMix = await moodBucketService.saveUserMoodMix(
            userId,
            mood,
            MOOD_MIX_LIMIT,
            trackIds
        );

        if (!savedMix) {
            return res.status(400).json({
                error: `Not enough tracks for mood: ${mood}`,
                suggestion: "Wait for more tracks to be analyzed",
            });
        }

        // Invalidate mixes cache so home page refetches
        await redisClient.del(mixesCacheKey(userId));

        const orderedTracks = await loadTracksInMixOrder(savedMix.trackIds);

        logger.debug(
            `[MIXES] Saved mood bucket mix for user ${userId}: ${mood} (${savedMix.trackCount} tracks)`
        );

        res.json({
            success: true,
            mix: {
                ...savedMix,
                tracks: orderedTracks,
            },
        });
    } catch (error) {
        logger.error("Save mood bucket mix error:", error);
        res.status(500).json({ error: "Failed to save mood mix" });
    }
});

router.post("/mood/buckets/backfill", requireAdmin, async (req, res) => {
    try {
        const userId = getRequestUserId(req);
        if (!userId) {
            return res.status(401).json({ error: "Not authenticated" });
        }

        logger.debug(
            `[MIXES] Starting mood bucket backfill requested by user ${userId}`
        );

        const result = await moodBucketService.backfillAllTracks();

        res.json({
            success: true,
            processed: result.processed,
            assigned: result.assigned,
        });
    } catch (error) {
        logger.error("Backfill mood buckets error:", error);
        res.status(500).json({ error: "Failed to backfill mood buckets" });
    }
});

router.post("/refresh", async (req, res) => {
    try {
        const userId = getRequestUserId(req);
        if (!userId) {
            return res.status(401).json({ error: "Not authenticated" });
        }

        // Regenerate with random selection (not date-based) and replace the cache
        await redisClient.del(mixesCacheKey(userId));
        const mixes = await programmaticPlaylistService.generateAllMixes(
            userId,
            true
        );
        await redisClient.setex(
            mixesCacheKey(userId),
            MIXES_CACHE_TTL,
            JSON.stringify(mixes)
        );

        res.json({ message: "Mixes refreshed", mixes });
    } catch (error) {
        logger.error("Refresh mixes error:", error);
        res.status(500).json({ error: "Failed to refresh mixes" });
    }
});

router.post("/:id/save", async (req, res) => {
    try {
        const userId = getRequestUserId(req);
        if (!userId) {
            return res.status(401).json({ error: "Not authenticated" });
        }
        const mixId = req.params.id;
        const customName = req.body.name;

        const mixes = await getMixesForUser(userId);

        const mix = mixes.find((m: any) => m.id === mixId);

        if (!mix) {
            return res.status(404).json({ error: "Mix not found" });
        }

        const existingPlaylist = await prisma.playlist.findFirst({
            where: {
                userId,
                mixId: mix.id,
            },
            select: {
                id: true,
                name: true,
            },
        });

        if (existingPlaylist) {
            return res.status(409).json({
                error: "Mix already saved as playlist",
                playlistId: existingPlaylist.id,
                name: existingPlaylist.name,
            });
        }

        // Mixes are cached: a song deleted since the mix was made is left out, in the mix's order otherwise.
        const mixTrackIds: string[] = [...new Set<string>(mix.trackIds)];
        const present = new Set(
            (await prisma.track.findMany({ where: { id: { in: mixTrackIds } }, select: { id: true } })).map((t) => t.id)
        );
        const trackIds = mixTrackIds.filter((id) => present.has(id));
        if (trackIds.length === 0) {
            return res.status(422).json({ error: "None of this mix's songs are in the library any more" });
        }

        // One write: the playlist exists with all its songs or not at all. `rank` is unique per playlist, and the
        // playlist starts empty, so positional ranks are correct.
        const playlist = await prisma.playlist.create({
            data: {
                userId,
                mixId: mix.id,
                name: customName || mix.name,
                isPublic: false,
                items: {
                    create: trackIds.map((trackId, index) => ({
                        trackId,
                        sort: index,
                        rank: rankForPosition(index),
                    })),
                },
            },
        });

        logger.debug(
            `[MIXES] Saved mix ${mixId} as playlist ${playlist.id} (${trackIds.length} tracks)`
        );
        announcePlaylistChange(userId, playlist.id);

        res.json({
            id: playlist.id,
            name: playlist.name,
            trackCount: trackIds.length,
        });
    } catch (error) {
        logger.error("Save mix as playlist error:", error);
        res.status(500).json({ error: "Failed to save mix as playlist" });
    }
});

router.get("/:id", async (req, res) => {
    try {
        const userId = getRequestUserId(req);
        if (!userId) {
            return res.status(401).json({ error: "Not authenticated" });
        }
        const mixId = req.params.id;

        const mixes = await getMixesForUser(userId);

        // Find the specific mix
        const mix = mixes.find((m: any) => m.id === mixId);

        if (!mix) {
            return res.status(404).json({ error: "Mix not found" });
        }

        const orderedTracks = await loadTracksInMixOrder(mix.trackIds);

        res.json({
            ...mix,
            tracks: orderedTracks,
        });
    } catch (error) {
        logger.error("Get mix error:", error);
        res.status(500).json({ error: "Failed to get mix" });
    }
});

export default router;
