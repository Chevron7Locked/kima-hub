import { Router } from "express";
import { prisma } from "../../utils/db";
import { subsonicOk, subsonicError, SubsonicError } from "../../utils/subsonicResponse";
import { mapSong, wrap } from "./mappers";

export const playlistRouter = Router();

// ===================== PLAYLISTS =====================

playlistRouter.all("/getPlaylists.view", wrap(async (req, res) => {
    const userId = req.user!.id;

    const playlists = await prisma.playlist.findMany({
        where: { OR: [{ userId }, { isPublic: true }] },
        include: {
            _count: { select: { items: true } },
            items: { select: { track: { select: { duration: true } } } },
            user: { select: { username: true } },
        },
        orderBy: { createdAt: "desc" },
    });

    return subsonicOk(req, res, {
        playlists: {
            playlist: playlists.map((pl) => ({
                "@_id": pl.id,
                "@_name": pl.name,
                "@_songCount": pl._count.items,
                "@_duration": Math.round(pl.items.reduce((sum, i) => sum + (i.track.duration ?? 0), 0)),
                "@_public": pl.isPublic,
                "@_owner": pl.user.username,
            })),
        },
    });
}));

playlistRouter.all("/getPlaylist.view", wrap(async (req, res) => {
    const id = req.query.id as string | undefined;
    if (!id) {
        return subsonicError(req, res, SubsonicError.MISSING_PARAM, "id is required");
    }

    const playlist = await prisma.playlist.findUnique({
        where: { id },
        include: {
            user: { select: { username: true } },
            items: {
                orderBy: { sort: "asc" },
                include: {
                    track: {
                        include: {
                            album: {
                                include: { artist: true },
                            },
                        },
                    },
                },
            },
        },
    });

    if (!playlist) {
        return subsonicError(req, res, SubsonicError.NOT_FOUND, "Playlist not found");
    }

    if (playlist.userId !== req.user!.id && !playlist.isPublic) {
        return subsonicError(req, res, SubsonicError.NOT_AUTHORIZED, "Access denied");
    }

    let totalDuration = 0;
    const entries = playlist.items.map((item) => {
        const { track } = item;
        const { album } = track;
        const artist = album.artist;
        const artistName = artist.displayName || artist.name;
        const artistId = artist.id;
        totalDuration += track.duration ?? 0;
        return mapSong(track, album, artistName, artistId);
    });

    return subsonicOk(req, res, {
        playlist: {
            "@_id": playlist.id,
            "@_name": playlist.name,
            "@_songCount": playlist.items.length,
            "@_duration": Math.round(totalDuration),
            "@_public": playlist.isPublic,
            "@_owner": playlist.user.username,
            ...(entries.length > 0 ? { entry: entries } : {}),
        },
    });
}));

playlistRouter.all("/createPlaylist.view", wrap(async (req, res) => {
    const playlistId = req.query.playlistId as string | undefined;
    const name = req.query.name as string | undefined;
    const userId = req.user!.id;

    const rawSongIds = req.query.songId;
    const songIds: string[] = (
        Array.isArray(rawSongIds)
            ? rawSongIds
            : rawSongIds !== undefined
            ? [rawSongIds]
            : []
    ).filter(Boolean) as string[];

    if (playlistId) {
        const playlist = await prisma.playlist.findUnique({ where: { id: playlistId } });
        if (!playlist) {
            return subsonicError(req, res, SubsonicError.NOT_FOUND, "Playlist not found");
        }
        if (playlist.userId !== userId) {
            return subsonicError(req, res, SubsonicError.NOT_AUTHORIZED, "Access denied");
        }

        await prisma.$transaction([
            prisma.playlistItem.deleteMany({ where: { playlistId } }),
            ...(songIds.length > 0 ? [
                prisma.playlistItem.createMany({
                    data: songIds.map((trackId, index) => ({ playlistId, trackId, sort: index })),
                    skipDuplicates: true,
                }),
            ] : []),
        ]);
    } else if (name) {
        const playlist = await prisma.playlist.create({
            data: { userId, name, isPublic: false },
        });

        if (songIds.length > 0) {
            await prisma.playlistItem.createMany({
                data: songIds.map((trackId, index) => ({ playlistId: playlist.id, trackId, sort: index })),
                skipDuplicates: true,
            });
        }
    } else {
        return subsonicError(req, res, SubsonicError.MISSING_PARAM, "playlistId or name is required");
    }

    return subsonicOk(req, res);
}));

playlistRouter.all("/updatePlaylist.view", wrap(async (req, res) => {
    const playlistId = req.query.playlistId as string | undefined;
    if (!playlistId) {
        return subsonicError(req, res, SubsonicError.MISSING_PARAM, "playlistId is required");
    }

    const playlist = await prisma.playlist.findUnique({ where: { id: playlistId } });
    if (!playlist) {
        return subsonicError(req, res, SubsonicError.NOT_FOUND, "Playlist not found");
    }
    if (playlist.userId !== req.user!.id) {
        return subsonicError(req, res, SubsonicError.NOT_AUTHORIZED, "Access denied");
    }

    const updateData: { name?: string; isPublic?: boolean } = {};

    const name = req.query.name as string | undefined;
    if (name !== undefined) {
        updateData.name = name;
    }

    const publicParam = req.query.public as string | undefined;
    if (publicParam !== undefined) {
        updateData.isPublic = publicParam === "true";
    }

    if (Object.keys(updateData).length > 0) {
        await prisma.playlist.update({ where: { id: playlistId }, data: updateData });
    }

    const rawSongIdsToAdd = req.query.songIdToAdd;
    const songIdsToAdd: string[] = (
        Array.isArray(rawSongIdsToAdd)
            ? rawSongIdsToAdd
            : rawSongIdsToAdd !== undefined
            ? [rawSongIdsToAdd]
            : []
    ).filter(Boolean) as string[];

    const rawIndexesToRemove = req.query.songIndexToRemove;
    const indexesToRemove: number[] = (
        Array.isArray(rawIndexesToRemove)
            ? rawIndexesToRemove
            : rawIndexesToRemove !== undefined
            ? [rawIndexesToRemove]
            : []
    )
        .map((v) => parseInt(v as string, 10))
        .filter((n) => !isNaN(n));

    if (indexesToRemove.length > 0 || songIdsToAdd.length > 0) {
        await prisma.$transaction(async (tx) => {
            if (indexesToRemove.length > 0) {
                const currentItems = await tx.playlistItem.findMany({
                    where: { playlistId },
                    orderBy: { sort: "asc" },
                    select: { id: true },
                });
                const idsToDelete = indexesToRemove
                    .filter((i) => i >= 0 && i < currentItems.length)
                    .map((i) => currentItems[i].id);
                if (idsToDelete.length > 0) {
                    await tx.playlistItem.deleteMany({ where: { id: { in: idsToDelete } } });
                }
            }

            if (songIdsToAdd.length > 0) {
                const aggregate = await tx.playlistItem.aggregate({
                    where: { playlistId },
                    _max: { sort: true },
                });
                const maxSort = aggregate._max.sort ?? -1;
                await tx.playlistItem.createMany({
                    data: songIdsToAdd.map((trackId, index) => ({
                        playlistId,
                        trackId,
                        sort: maxSort + 1 + index,
                    })),
                    skipDuplicates: true,
                });
            }
        });
    }

    return subsonicOk(req, res);
}));

playlistRouter.all("/deletePlaylist.view", wrap(async (req, res) => {
    const id = req.query.id as string | undefined;
    if (!id) {
        return subsonicError(req, res, SubsonicError.MISSING_PARAM, "id is required");
    }

    const playlist = await prisma.playlist.findUnique({ where: { id } });
    if (!playlist) {
        return subsonicError(req, res, SubsonicError.NOT_FOUND, "Playlist not found");
    }
    if (playlist.userId !== req.user!.id) {
        return subsonicError(req, res, SubsonicError.NOT_AUTHORIZED, "Access denied");
    }

    await prisma.playlist.delete({ where: { id } });

    return subsonicOk(req, res);
}));
