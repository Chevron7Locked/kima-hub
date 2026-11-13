import { Request, Router } from "express";
import { prisma, Prisma } from "../../utils/db";
import { subsonicOk, subsonicError, SubsonicError } from "../../utils/subsonicResponse";
import { wrap } from "./mappers";
import { PLAYABLE_SONG } from "../../utils/libraryEligibility";
import { one, many } from "../../utils/subsonicParams";

export const queueRouter = Router();

type QueueTrack = {
    id: string;
    title?: string;
    /** The title as edited in Kima; the web player reads it too. */
    displayTitle?: string | null;
    duration?: number;
    artist?: { id?: string; name?: string } | null;
    album?: { id?: string; title?: string; coverArt?: string | null } | null;
};

function getQueueFromPlaybackState(queue: unknown): QueueTrack[] {
    if (!Array.isArray(queue)) return [];
    return queue
        .map((item) => (item && typeof item === "object" ? (item as QueueTrack) : null))
        .filter((item): item is QueueTrack => Boolean(item?.id));
}

function mapQueueEntry(item: QueueTrack) {
    return {
        "@_id": item.id,
        "@_title": item.displayTitle || item.title || "Unknown",
        "@_isDir": false,
        "@_isVideo": false,
        "@_type": "music",
        "@_albumId": item.album?.id || undefined,
        "@_album": item.album?.title || undefined,
        "@_artistId": item.artist?.id || undefined,
        "@_artist": item.artist?.name || undefined,
        "@_coverArt": item.album?.coverArt || item.album?.id || undefined,
        "@_duration": item.duration || 0,
    };
}

/**
 * The saved queue as a Subsonic client sees it: only its playable songs, the stored queue left as it is (the web
 * player shares it, and a song whose file comes back returns to it). When the current song is left out, the next
 * playable one becomes current (else the last one before it), from its start.
 */
async function playableQueue(state: { queue: unknown; currentIndex: number; position: number } | null) {
    const saved = getQueueFromPlaybackState(state?.queue);
    const playable = new Set(
        saved.length === 0
            ? []
            : (
                  await prisma.track.findMany({
                      where: { id: { in: saved.map((item) => item.id) }, ...PLAYABLE_SONG },
                      select: { id: true },
                  })
              ).map((t) => t.id),
    );
    const savedIndex = Math.min(Math.max(state?.currentIndex ?? 0, 0), Math.max(saved.length - 1, 0));
    const shownBefore = saved.slice(0, savedIndex).filter((item) => playable.has(item.id)).length;
    const queue = saved.filter((item) => playable.has(item.id));
    const currentKept = saved.length > 0 && playable.has(saved[savedIndex].id);
    return {
        queue,
        currentIndex: queue.length === 0 ? 0 : Math.min(shownBefore, queue.length - 1),
        position: currentKept ? (state?.position ?? 0) : 0,
    };
}

/**
 * Track ids as the full queue items the web player stores and renders, in the
 * given order; unknown ids are dropped.
 */
async function hydrateQueue(ids: string[]): Promise<QueueTrack[]> {
    if (ids.length === 0) return [];

    const tracks = await prisma.track.findMany({
        where: { id: { in: ids } },
        select: {
            id: true,
            title: true,
            displayTitle: true,
            duration: true,
            album: {
                select: {
                    id: true,
                    title: true,
                    coverUrl: true,
                    artist: { select: { id: true, name: true, displayName: true } },
                },
            },
        },
    });

    const byId = new Map(tracks.map((t) => [t.id, t]));
    return ids
        .map((id) => byId.get(id))
        .filter((t): t is NonNullable<typeof t> => t != null)
        .map((t) => ({
            id: t.id,
            title: t.title,
            displayTitle: t.displayTitle,
            duration: t.duration ?? undefined,
            artist: t.album?.artist
                ? {
                      id: t.album.artist.id,
                      name: t.album.artist.displayName || t.album.artist.name,
                  }
                : null,
            album: t.album
                ? {
                      id: t.album.id,
                      title: t.album.title,
                      coverArt: t.album.coverUrl,
                  }
                : null,
        }));
}

/**
 * Where the client's current song sits in the queue as stored, which leaves out the ids it did not know. The songs
 * before it that were dropped no longer count, so the stored index still names the client's current song.
 */
function storedIndex(ids: string[], stored: QueueTrack[], clientIndex: number): number {
    if (stored.length === 0) return 0;
    const known = new Set(stored.map((item) => item.id));
    const before = ids.slice(0, clientIndex).filter((id) => known.has(id)).length;
    return Math.min(before, stored.length - 1);
}

/** The client writing the queue, stored so other devices see who changed it. */
function clientName(req: Request): string {
    const c = one(req, "c");
    return c && c.trim() ? c.trim().slice(0, 64) : "Kima";
}

queueRouter.all("/getPlayQueue.view", wrap(async (req, res) => {
    const userId = req.user!.id;
    const state = await prisma.playbackState.findUnique({ where: { userId } });

    const { queue, currentIndex, position } = await playableQueue(state);
    const currentId = queue[currentIndex]?.id;

    const entry = queue.map(mapQueueEntry);

    return subsonicOk(req, res, {
        playQueue: {
            "@_current": currentId,
            "@_position": position,
            "@_username": req.user!.username,
            "@_changed": state?.updatedAt?.toISOString() || new Date().toISOString(),
            "@_changedBy": state?.changedBy || "Kima",
            ...(entry.length > 0 ? { entry } : {}),
        },
    });
}));

queueRouter.all("/getPlayQueueByIndex.view", wrap(async (req, res) => {
    const userId = req.user!.id;
    const state = await prisma.playbackState.findUnique({ where: { userId } });

    const { queue, currentIndex, position } = await playableQueue(state);

    const entry = queue.map(mapQueueEntry);

    return subsonicOk(req, res, {
        playQueueByIndex: {
            "@_currentIndex": currentIndex,
            "@_position": position,
            "@_username": req.user!.username,
            "@_changed": state?.updatedAt?.toISOString() || new Date().toISOString(),
            "@_changedBy": state?.changedBy || "Kima",
            ...(entry.length > 0 ? { entry } : {}),
        },
    });
}));

queueRouter.all("/savePlayQueue.view", wrap(async (req, res) => {
    const userId = req.user!.id;

    const ids = many(req, "id");

    const current = one(req, "current");
    const positionRaw = one(req, "position");
    const position = positionRaw ? parseInt(positionRaw, 10) : 0;
    const safePosition = Number.isFinite(position) && position >= 0 ? position : 0;

    if (ids.length > 0 && (!current || !ids.includes(current))) {
        return subsonicError(
            req,
            res,
            SubsonicError.MISSING_PARAM,
            "current must be present and included in id list"
        );
    }

    const queueItems = await hydrateQueue(ids);
    const currentIndex = current ? storedIndex(ids, queueItems, ids.indexOf(current)) : 0;
    const currentTrackId = queueItems[currentIndex]?.id ?? null;
    // A current song Kima does not know was dropped, so the song now current starts from its beginning.
    const storedPosition = currentTrackId === current ? safePosition : 0;

    await prisma.playbackState.upsert({
        where: { userId },
        update: {
            playbackType: "track",
            trackId: currentTrackId,
            audiobookId: null,
            podcastId: null,
            queue: queueItems.length > 0 ? (queueItems as unknown as Prisma.InputJsonValue) : Prisma.DbNull,
            currentIndex,
            isShuffle: false,
            position: storedPosition,
            changedBy: clientName(req),
        },
        create: {
            userId,
            playbackType: "track",
            trackId: currentTrackId,
            audiobookId: null,
            podcastId: null,
            queue: queueItems.length > 0 ? (queueItems as unknown as Prisma.InputJsonValue) : Prisma.DbNull,
            currentIndex,
            isShuffle: false,
            position: storedPosition,
            changedBy: clientName(req),
        },
    });

    return subsonicOk(req, res);
}));

queueRouter.all("/savePlayQueueByIndex.view", wrap(async (req, res) => {
    const userId = req.user!.id;

    const ids = many(req, "id");

    const currentIndexRaw = one(req, "currentIndex");
    const positionRaw = one(req, "position");
    const position = positionRaw === undefined || positionRaw === ""
        ? 0
        : parseInt(positionRaw, 10);
    const safePosition = Number.isFinite(position) && position >= 0 ? position : 0;

    if (ids.length === 0 && currentIndexRaw !== undefined) {
        return subsonicError(
            req,
            res,
            SubsonicError.MISSING_PARAM,
            "currentIndex must not be set when id is not provided"
        );
    }

    if (ids.length > 0 && currentIndexRaw === undefined) {
        return subsonicError(
            req,
            res,
            SubsonicError.MISSING_PARAM,
            "Required parameter is missing: currentIndex"
        );
    }

    const parsedIndex = currentIndexRaw !== undefined ? parseInt(currentIndexRaw, 10) : 0;
    if (ids.length > 0 && (!Number.isInteger(parsedIndex) || parsedIndex < 0 || parsedIndex >= ids.length)) {
        return subsonicError(
            req,
            res,
            SubsonicError.MISSING_PARAM,
            "currentIndex must be between 0 and queue length - 1"
        );
    }

    const queueItems = await hydrateQueue(ids);
    const currentIndex = storedIndex(ids, queueItems, parsedIndex);
    const currentTrackId = queueItems[currentIndex]?.id ?? null;
    // A current song Kima does not know was dropped, so the song now current starts from its beginning.
    const storedPosition = ids.length > 0 && currentTrackId === ids[parsedIndex] ? safePosition : 0;

    await prisma.playbackState.upsert({
        where: { userId },
        update: {
            playbackType: "track",
            trackId: currentTrackId,
            audiobookId: null,
            podcastId: null,
            queue: queueItems.length > 0 ? (queueItems as unknown as Prisma.InputJsonValue) : Prisma.DbNull,
            currentIndex,
            isShuffle: false,
            position: storedPosition,
            changedBy: clientName(req),
        },
        create: {
            userId,
            playbackType: "track",
            trackId: currentTrackId,
            audiobookId: null,
            podcastId: null,
            queue: queueItems.length > 0 ? (queueItems as unknown as Prisma.InputJsonValue) : Prisma.DbNull,
            currentIndex,
            isShuffle: false,
            position: storedPosition,
            changedBy: clientName(req),
        },
    });

    return subsonicOk(req, res);
}));