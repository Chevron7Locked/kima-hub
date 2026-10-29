import { Router } from "express";
import { prisma } from "../../utils/db";
import { PLAYABLE } from "../../utils/libraryEligibility";
import { LIBRARY_LOCATION } from "../../services/libraryFilters";
import { logger } from "../../utils/logger";
import { subsonicOk, subsonicError, SubsonicError } from "../../utils/subsonicResponse";
import { mapSong, firstArtistGenre, wrap, parseRepeatedQueryParam } from "./mappers";

export const starredRouter = Router();

starredRouter.all(["/getStarred2.view", "/getStarred.view"], wrap(async (req, res) => {
    const userId = req.user!.id;
    // Only songs that can play, from the library.
    const liked = await prisma.likedTrack.findMany({
        where: { userId, track: { ...PLAYABLE, album: { location: LIBRARY_LOCATION } } },
        include: {
            track: {
                include: {
                    album: {
                        include: {
                            artist: { select: { id: true, name: true, displayName: true, genres: true, userGenres: true } },
                        },
                    },
                },
            },
        },
        orderBy: { likedAt: "desc" },
    });

    const key = req.path.includes("getStarred2") ? "starred2" : "starred";
    return subsonicOk(req, res, {
        [key]: {
            ...(liked.length > 0 ? {
                song: liked.map((l) => {
                    const t = l.track;
                    const artistName = t.album.artist.displayName || t.album.artist.name;
                    const genre = firstArtistGenre(t.album.artist.genres, t.album.artist.userGenres);
                    return {
                        ...mapSong(t, t.album, artistName, t.album.artist.id, genre),
                        "@_starred": l.likedAt.toISOString(),
                    };
                }),
            } : {}),
        },
    });
}));

starredRouter.all("/setRating.view", wrap(async (req, res) => {
    const id = req.query.id as string | undefined;
    const ratingRaw = req.query.rating as string | undefined;
    if (!id) {
        return subsonicError(req, res, SubsonicError.MISSING_PARAM, "Required parameter is missing: id");
    }
    if (ratingRaw === undefined) {
        return subsonicError(req, res, SubsonicError.MISSING_PARAM, "Required parameter is missing: rating");
    }

    const rating = parseInt(ratingRaw, 10);
    if (!Number.isInteger(rating) || rating < 0 || rating > 5) {
        return subsonicError(req, res, SubsonicError.GENERIC, "rating must be an integer between 0 and 5");
    }

    const userId = req.user!.id;
    const track = await prisma.track.findUnique({ where: { id }, select: { id: true } });

    // Kima stores binary preference (liked/unliked). Ratings 1..5 map to liked, 0 removes.
    if (track) {
        if (rating === 0) {
            await prisma.likedTrack.deleteMany({ where: { userId, trackId: id } });
        } else {
            await prisma.likedTrack.upsert({
                where: { userId_trackId: { userId, trackId: id } },
                create: { userId, trackId: id },
                update: {},
            });
        }
    }

    return subsonicOk(req, res);
}));

// star.view — only track starring (Kima's LikedTrack model); albumId/artistId params silently ignored
starredRouter.all("/star.view", wrap(async (req, res) => {
    const userId = req.user!.id;
    const ids = parseRepeatedQueryParam(req.query.id);

    // Star every id, skipping tracks that do not exist (P2003) and logging real
    // failures. Error only when a real failure left nothing starred; a partial
    // success answers ok, and the upsert makes a retry safe.
    let anySucceeded = false;
    let realFailure = false;
    for (const trackId of ids) {
        try {
            await prisma.likedTrack.upsert({
                where: { userId_trackId: { userId, trackId } },
                create: { userId, trackId },
                update: {},
            });
            anySucceeded = true;
        } catch (err) {
            if ((err as { code?: string }).code === "P2003") continue;
            realFailure = true;
            logger.warn(`[Subsonic] star failed for track ${trackId}:`, err);
        }
    }
    if (realFailure && !anySucceeded) {
        return subsonicError(req, res, SubsonicError.GENERIC, "Failed to star track");
    }
    return subsonicOk(req, res);
}));

starredRouter.all("/unstar.view", wrap(async (req, res) => {
    const userId = req.user!.id;
    const ids = parseRepeatedQueryParam(req.query.id);

    if (ids.length > 0) {
        await prisma.likedTrack.deleteMany({
            where: { userId, trackId: { in: ids } },
        });
    }
    return subsonicOk(req, res);
}));