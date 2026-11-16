import { Router, Request, Response } from "express";
import { prisma } from "../../utils/db";
import { PLAYABLE_SONG } from "../../utils/playableSong";
import { logger } from "../../utils/logger";
import { subsonicOk, subsonicError, SubsonicError } from "../../utils/subsonicResponse";
import { shownAlbumGenres } from "../../utils/genreSql";
import { mapSong, wrap } from "./mappers";
import { one, many } from "../../utils/subsonicParams";

export const starredRouter = Router();

starredRouter.all(["/getStarred2.view", "/getStarred.view"], wrap(async (req, res) => {
    const userId = req.user!.id;
    // Only playable songs.
    const liked = await prisma.likedTrack.findMany({
        where: { userId, track: PLAYABLE_SONG },
        include: {
            track: {
                include: {
                    album: {
                        include: {
                            artist: { select: { id: true, name: true, normalizedName: true, displayName: true, genres: true, userGenres: true } },
                        },
                    },
                },
            },
        },
        orderBy: [{ likedAt: "desc" }, { trackId: "asc" }],
    });

    const key = req.path.includes("getStarred2") ? "starred2" : "starred";
    return subsonicOk(req, res, {
        [key]: {
            ...(liked.length > 0 ? {
                song: liked.map((l) => {
                    const t = l.track;
                    const artistName = t.album.artist.displayName || t.album.artist.name;
                    const genres = shownAlbumGenres(t.album, t.album.artist);
                    return {
                        ...mapSong(t, t.album, artistName, t.album.artist.id, genres),
                        "@_starred": l.likedAt.toISOString(),
                    };
                }),
            } : {}),
        },
    });
}));

starredRouter.all("/setRating.view", wrap(async (req, res) => {
    const id = one(req, "id");
    const ratingRaw = one(req, "rating");
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
    // A song the app is never offered (Discover, missing, corrupt) is skipped like one that is not there.
    const track = await prisma.track.findFirst({ where: { id, ...PLAYABLE_SONG }, select: { id: true } });

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

/**
 * The song ids a star or unstar names, or null once the refusal is sent. Kima keeps song likes only, so an album or
 * artist id is refused even beside song ids (an ok would show the app a star that is never stored), and a request
 * naming nothing is missing its parameter.
 */
function songIdsOrRefuse(req: Request, res: Response): string[] | null {
    const ids = many(req, "id");
    if (many(req, "albumId").length > 0 || many(req, "artistId").length > 0) {
        subsonicError(req, res, SubsonicError.GENERIC, "starring albums and artists isn't supported");
        return null;
    }
    if (ids.length === 0) {
        subsonicError(req, res, SubsonicError.MISSING_PARAM, "Required parameter is missing: id");
        return null;
    }
    return ids;
}

starredRouter.all("/star.view", wrap(async (req, res) => {
    const userId = req.user!.id;
    const ids = songIdsOrRefuse(req, res);
    if (!ids) return;

    // A song the app is never offered (Discover, missing, corrupt) is skipped like one that is not there.
    const playable = async () =>
        (await prisma.track.findMany({ where: { id: { in: ids }, ...PLAYABLE_SONG }, select: { id: true } })).map((t) => ({
            userId,
            trackId: t.id,
        }));

    // One write for every song; a song already liked is left as it is, so a retry is safe. A song deleted between the
    // read and the write (P2003) fails the write, so it is read again once and the rest are still starred.
    try {
        for (let attempt = 0; ; attempt++) {
            try {
                await prisma.likedTrack.createMany({ data: await playable(), skipDuplicates: true });
                break;
            } catch (err) {
                if ((err as { code?: string }).code !== "P2003" || attempt > 0) throw err;
            }
        }
    } catch (err) {
        logger.warn(`[Subsonic] star failed for ${ids.join(",")}:`, err);
        return subsonicError(req, res, SubsonicError.GENERIC, "Failed to star track");
    }
    return subsonicOk(req, res);
}));

starredRouter.all("/unstar.view", wrap(async (req, res) => {
    const userId = req.user!.id;
    const ids = songIdsOrRefuse(req, res);
    if (!ids) return;

    await prisma.likedTrack.deleteMany({
        where: { userId, trackId: { in: ids } },
    });
    return subsonicOk(req, res);
}));
