import { Router } from "express";
import { rankForPosition } from "../../utils/lexoRank";
import { allocateAppendRanks, lockPlaylist, replaceItems } from "../../services/playlistService";
import { prisma } from "../../utils/db";
import { subsonicOk, subsonicError, SubsonicError } from "../../utils/subsonicResponse";
import { mapSong, wrap } from "./mappers";
import { announcePlaylistChange } from "../../services/playlistEvents";
import { PLAYABLE_SONG } from "../../utils/playableSong";
import { one, many } from "../../utils/subsonicParams";

export const playlistRouter = Router();

/**
 * A Subsonic client sees only a playlist's playable songs: its entries, counts, length and the indexes it removes by
 * all leave the others out. They stay in the playlist (the web marks them unavailable) and return when their file does.
 */
const SHOWN = { track: PLAYABLE_SONG } as const;

// ===================== PLAYLISTS =====================

playlistRouter.all("/getPlaylists.view", wrap(async (req, res) => {
    const userId = req.user!.id;

    const playlists = await prisma.playlist.findMany({
        where: { OR: [{ userId }, { isPublic: true }] },
        include: {
            _count: { select: { items: { where: SHOWN } } },
            items: { where: SHOWN, select: { track: { select: { duration: true } } } },
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

/** A playlist with its owner's name and its playable songs in order, each with album and artist. */
function loadPlaylist(id: string) {
    return prisma.playlist.findUnique({
        where: { id },
        include: {
            user: { select: { username: true } },
            items: {
                where: SHOWN,
                orderBy: { rank: "asc" },
                include: { track: { include: { album: { include: { artist: true } } } } },
            },
        },
    });
}

function playlistReply(playlist: NonNullable<Awaited<ReturnType<typeof loadPlaylist>>>) {
    const entries = playlist.items.map(({ track }) => {
        const { album } = track;
        return mapSong(track, album, album.artist.displayName || album.artist.name, album.artist.id);
    });
    return {
        "@_id": playlist.id,
        "@_name": playlist.name,
        "@_songCount": playlist.items.length,
        "@_duration": Math.round(playlist.items.reduce((sum, i) => sum + (i.track.duration ?? 0), 0)),
        "@_public": playlist.isPublic,
        "@_owner": playlist.user.username,
        ...(entries.length > 0 ? { entry: entries } : {}),
    };
}

playlistRouter.all("/getPlaylist.view", wrap(async (req, res) => {
    const id = one(req, "id");
    if (!id) {
        return subsonicError(req, res, SubsonicError.MISSING_PARAM, "id is required");
    }

    const playlist = await loadPlaylist(id);

    if (!playlist) {
        return subsonicError(req, res, SubsonicError.NOT_FOUND, "Playlist not found");
    }

    if (playlist.userId !== req.user!.id && !playlist.isPublic) {
        return subsonicError(req, res, SubsonicError.NOT_AUTHORIZED, "Access denied");
    }

    return subsonicOk(req, res, { playlist: playlistReply(playlist) });
}));

/** Whether every id names a playable song: a playlist change naming one that does not is refused whole, as not found. */
async function allSongsPlayable(ids: string[]): Promise<boolean> {
    const unique = [...new Set(ids)];
    if (unique.length === 0) return true;
    return (await prisma.track.count({ where: { id: { in: unique }, ...PLAYABLE_SONG } })) === unique.length;
}

playlistRouter.all("/createPlaylist.view", wrap(async (req, res) => {
    const playlistId = one(req, "playlistId");
    const name = one(req, "name");
    const userId = req.user!.id;

    const songIds = many(req, "songId");
    if (!(await allSongsPlayable(songIds))) {
        return subsonicError(req, res, SubsonicError.NOT_FOUND, "Song not found");
    }

    let resolvedPlaylistId: string;
    let changed = true;

    if (playlistId) {
        const playlist = await prisma.playlist.findUnique({ where: { id: playlistId } });
        if (!playlist) {
            return subsonicError(req, res, SubsonicError.NOT_FOUND, "Playlist not found");
        }
        if (playlist.userId !== userId) {
            return subsonicError(req, res, SubsonicError.NOT_AUTHORIZED, "Access denied");
        }

        // Replacing rewrites every entry (new ids, even for the same songs): devices are told unless nothing was there
        // before or after. The client replaces only the songs it was shown; the hidden ones are kept, after them, so a
        // song whose file comes back is not lost to a client that saved the playlist meanwhile.
        const written = await prisma.$transaction(async (tx) => {
            await lockPlaylist(tx, playlistId);
            const hidden = (
                await tx.playlistItem.findMany({
                    where: { playlistId, NOT: SHOWN },
                    orderBy: { rank: "asc" },
                    select: { trackId: true },
                })
            ).map((item) => item.trackId);
            // rank is the playlist order and must be unique per playlist; a song named twice is two entries. The
            // entries an import still waits for keep their ranks, which the client never saw, and the songs go around them.
            return replaceItems(tx, playlistId, songIds, hidden);
        });
        resolvedPlaylistId = playlistId;
        changed = written;
    } else if (name) {
        // One write: the playlist exists with all its songs or not at all. A song named twice is kept twice, in the order given.
        const playlist = await prisma.playlist.create({
            data: {
                userId,
                name,
                isPublic: false,
                items: {
                    create: songIds.map((trackId, index) => ({
                        trackId,
                        sort: index,
                        rank: rankForPosition(index),
                    })),
                },
            },
        });
        resolvedPlaylistId = playlist.id;
    } else {
        return subsonicError(req, res, SubsonicError.MISSING_PARAM, "playlistId or name is required");
    }

    if (changed) announcePlaylistChange(userId, resolvedPlaylistId);

    // The whole playlist, as getPlaylist shows it (OpenSubsonic, since 1.14.0).
    const created = await loadPlaylist(resolvedPlaylistId);
    if (!created) {
        return subsonicError(req, res, SubsonicError.NOT_FOUND, "Playlist not found after creation");
    }
    return subsonicOk(req, res, { playlist: playlistReply(created) });
}));

playlistRouter.all("/updatePlaylist.view", wrap(async (req, res) => {
    const playlistId = one(req, "playlistId");
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

    const name = one(req, "name");
    // A blank name leaves the name as it is, as the reference server and Navidrome do.
    if (name !== undefined && name.trim() !== "") {
        updateData.name = name;
    }

    const publicParam = one(req, "public");
    if (publicParam !== undefined) {
        updateData.isPublic = publicParam === "true";
    }

    const songIdsToAdd = many(req, "songIdToAdd");
    // Whole numbers only (`2abc` is not 2), each index once; one past the end is dropped where the entries are read.
    const indexesToRemove = [
        ...new Set(
            many(req, "songIndexToRemove")
                .filter((v) => /^\d+$/.test(v))
                .map((v) => Number(v)),
        ),
    ];

    if (!(await allSongsPlayable(songIdsToAdd))) {
        return subsonicError(req, res, SubsonicError.NOT_FOUND, "Song not found");
    }

    // One transaction: the name, the visibility and the songs change together or not at all.
    const changes = await prisma.$transaction(async (tx) => {
        let count = 0;
        if (indexesToRemove.length > 0 || songIdsToAdd.length > 0) await lockPlaylist(tx, playlistId);

        if (Object.keys(updateData).length > 0) {
            await tx.playlist.update({ where: { id: playlistId }, data: updateData });
            count += 1;
        }

        if (indexesToRemove.length > 0) {
            // The indexes count the entries the client was shown.
            const currentItems = await tx.playlistItem.findMany({
                where: { playlistId, ...SHOWN },
                orderBy: { rank: "asc" },
                select: { id: true },
            });
            const idsToDelete = indexesToRemove
                .filter((i) => i >= 0 && i < currentItems.length)
                .map((i) => currentItems[i].id);
            if (idsToDelete.length > 0) {
                count += (await tx.playlistItem.deleteMany({ where: { id: { in: idsToDelete } } })).count;
            }
        }

        if (songIdsToAdd.length > 0) {
            const aggregate = await tx.playlistItem.aggregate({
                where: { playlistId },
                _max: { sort: true },
            });
            const maxSort = aggregate._max.sort ?? -1;

            const ranks = await allocateAppendRanks(tx, playlistId, songIdsToAdd.length);
            const rows = songIdsToAdd.map((trackId, index) => ({
                playlistId,
                trackId,
                sort: maxSort + 1 + index,
                rank: ranks[index],
            }));

            count += (await tx.playlistItem.createMany({ data: rows })).count;
        }
        return count;
    });

    if (changes > 0) announcePlaylistChange(req.user!.id, playlistId);
    return subsonicOk(req, res);
}));

playlistRouter.all("/deletePlaylist.view", wrap(async (req, res) => {
    const id = one(req, "id");
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
    announcePlaylistChange(req.user!.id, id, true);

    return subsonicOk(req, res);
}));
