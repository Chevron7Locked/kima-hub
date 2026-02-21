import { Router } from "express";
import { prisma } from "../../utils/db";
import { subsonicOk, subsonicError, SubsonicError } from "../../utils/subsonicResponse";
import { mapSong, wrap } from "./mappers";

export const userRouter = Router();

// ===================== USER =====================

userRouter.all("/getUser.view", (req, res) => {
    subsonicOk(req, res, {
        user: {
            "@_username": req.user!.username,
            "@_scrobblingEnabled": true,
            "@_adminRole": req.user!.role === "admin",
            "@_settingsRole": true,
            "@_downloadRole": true,
            "@_uploadRole": false,
            "@_playlistRole": true,
            "@_coverArtRole": false,
            "@_commentRole": false,
            "@_podcastRole": false,
            "@_streamRole": true,
            "@_jukeboxRole": false,
            "@_shareRole": false,
            folder: [1],
        },
    });
});

// ===================== STARRED =====================

userRouter.all(["/getStarred2.view", "/getStarred.view"], wrap(async (req, res) => {
    const userId = req.user!.id;
    const liked = await prisma.likedTrack.findMany({
        where: { userId },
        include: {
            track: {
                include: {
                    album: {
                        include: {
                            artist: { select: { id: true, name: true, displayName: true } },
                        },
                    },
                },
            },
        },
        orderBy: { likedAt: "desc" },
    });

    const key = req.path.includes("getStarred2") ? "starred2" : "starred";
    subsonicOk(req, res, {
        [key]: {
            song: liked.map((l) => {
                const t = l.track;
                const artistName = t.album.artist.displayName || t.album.artist.name;
                return {
                    ...mapSong(t, t.album, artistName, t.album.artist.id),
                    "@_starred": l.likedAt.toISOString(),
                };
            }),
        },
    });
}));

// star.view — only track starring (Kima's LikedTrack model); albumId/artistId params silently ignored
userRouter.all("/star.view", wrap(async (req, res) => {
    const id = req.query.id as string | undefined;
    if (!id) return subsonicOk(req, res);

    const userId = req.user!.id;
    const track = await prisma.track.findUnique({ where: { id }, select: { id: true } });
    if (track) {
        await prisma.likedTrack
            .upsert({
                where: { userId_trackId: { userId, trackId: id } },
                create: { userId, trackId: id },
                update: {},
            })
            .catch(() => {});
    }

    return subsonicOk(req, res);
}));

userRouter.all("/unstar.view", wrap(async (req, res) => {
    const id = req.query.id as string | undefined;
    if (!id) return subsonicOk(req, res);

    const userId = req.user!.id;
    await prisma.likedTrack
        .delete({ where: { userId_trackId: { userId, trackId: id } } })
        .catch(() => {});

    return subsonicOk(req, res);
}));

// ===================== ARTIST INFO =====================

userRouter.all(["/getArtistInfo2.view", "/getArtistInfo.view"], wrap(async (req, res) => {
    const id = req.query.id as string | undefined;
    if (!id) return subsonicError(req, res, SubsonicError.MISSING_PARAM, "Required parameter is missing: id");

    const artist = await prisma.artist.findUnique({
        where: { id },
        select: {
            id: true,
            summary: true,
            heroUrl: true,
            similarArtistsJson: true,
        },
    });
    if (!artist) return subsonicError(req, res, SubsonicError.NOT_FOUND, "Artist not found");

    const rawSimilar = (artist.similarArtistsJson as Array<{ name: string; mbid?: string; match: number }>) || [];
    const resolvedSimilar: Array<{ id: string; name: string; coverArt: string }> = [];

    if (rawSimilar.length > 0) {
        const top10 = rawSimilar.slice(0, 10);
        const mbids = top10.filter((s) => s.mbid).map((s) => s.mbid as string);
        const names = top10.map((s) => s.name.toLowerCase());

        const candidates = await prisma.artist.findMany({
            where: {
                OR: [
                    ...(mbids.length > 0 ? [{ mbid: { in: mbids } }] : []),
                    { normalizedName: { in: names } },
                ],
            },
            select: { id: true, name: true, displayName: true, mbid: true, normalizedName: true },
            take: 20,
        });

        for (const s of top10) {
            const found = candidates.find(
                (a) => (s.mbid && a.mbid === s.mbid) || a.normalizedName === s.name.toLowerCase()
            );
            if (found) {
                resolvedSimilar.push({
                    id: found.id,
                    name: found.displayName || found.name,
                    coverArt: `ar-${found.id}`,
                });
            }
        }
    }

    const infoKey = req.path.includes("getArtistInfo2") ? "artistInfo2" : "artistInfo";
    return subsonicOk(req, res, {
        [infoKey]: {
            biography: artist.summary || undefined,
            coverArt: `ar-${artist.id}`,
            artistImageUrl: artist.heroUrl || undefined,
            ...(resolvedSimilar.length > 0 ? {
                similarArtist: resolvedSimilar.map((s) => ({
                    "@_id": s.id,
                    "@_name": s.name,
                    "@_coverArt": s.coverArt,
                })),
            } : {}),
        },
    });
}));
