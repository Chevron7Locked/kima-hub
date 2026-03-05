import { Router } from "express";
import { prisma, Prisma } from "../../utils/db";
import { subsonicOk, subsonicError, SubsonicError } from "../../utils/subsonicResponse";
import { wrap } from "./mappers";

export const queueRouter = Router();

type QueueTrack = {
    id: string;
    title?: string;
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
        "@_title": item.title || "Unknown",
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

queueRouter.all("/getPlayQueue.view", wrap(async (req, res) => {
    const userId = req.user!.id;
    const state = await prisma.playbackState.findUnique({ where: { userId } });

    const queue = getQueueFromPlaybackState(state?.queue);
    const currentIndex = state?.currentIndex ?? 0;
    const currentId = queue.length > 0
        ? queue[Math.min(Math.max(currentIndex, 0), queue.length - 1)]?.id
        : undefined;

    const entry = queue.map(mapQueueEntry);

    return subsonicOk(req, res, {
        playQueue: {
            "@_current": currentId,
            "@_position": 0,
            "@_username": req.user!.username,
            "@_changed": state?.updatedAt?.toISOString() || new Date().toISOString(),
            "@_changedBy": (req.query.c as string | undefined) || "Kima",
            ...(entry.length > 0 ? { entry } : {}),
        },
    });
}));

queueRouter.all("/getPlayQueueByIndex.view", wrap(async (req, res) => {
    const userId = req.user!.id;
    const state = await prisma.playbackState.findUnique({ where: { userId } });

    const queue = getQueueFromPlaybackState(state?.queue);
    const currentIndex = queue.length > 0
        ? Math.min(Math.max(state?.currentIndex ?? 0, 0), queue.length - 1)
        : 0;

    const entry = queue.map(mapQueueEntry);

    return subsonicOk(req, res, {
        playQueueByIndex: {
            "@_currentIndex": currentIndex,
            "@_position": 0,
            "@_username": req.user!.username,
            "@_changed": state?.updatedAt?.toISOString() || new Date().toISOString(),
            "@_changedBy": (req.query.c as string | undefined) || "Kima",
            ...(entry.length > 0 ? { entry } : {}),
        },
    });
}));

queueRouter.all("/savePlayQueue.view", wrap(async (req, res) => {
    const userId = req.user!.id;

    const rawIds = req.query.id;
    const ids: string[] = (
        Array.isArray(rawIds)
            ? rawIds
            : rawIds !== undefined
            ? [rawIds]
            : []
    ).filter(Boolean) as string[];

    const current = req.query.current as string | undefined;
    const positionRaw = req.query.position as string | undefined;
    const position = positionRaw ? parseInt(positionRaw, 10) : 0;

    if (ids.length > 0 && (!current || !ids.includes(current))) {
        return subsonicError(
            req,
            res,
            SubsonicError.MISSING_PARAM,
            "current must be present and included in id list"
        );
    }

    const queueItems: QueueTrack[] = ids.map((id) => ({ id }));
    const currentIndex =
        current && ids.length > 0
            ? Math.max(0, ids.indexOf(current))
            : 0;

    await prisma.playbackState.upsert({
        where: { userId },
        update: {
            playbackType: "track",
            trackId: current || null,
            audiobookId: null,
            podcastId: null,
            queue: queueItems.length > 0 ? (queueItems as unknown as Prisma.InputJsonValue) : Prisma.DbNull,
            currentIndex,
            isShuffle: false,
        },
        create: {
            userId,
            playbackType: "track",
            trackId: current || null,
            audiobookId: null,
            podcastId: null,
            queue: queueItems.length > 0 ? (queueItems as unknown as Prisma.InputJsonValue) : Prisma.DbNull,
            currentIndex,
            isShuffle: false,
        },
    });

    // Position is acknowledged but not persisted separately in Kima playback state.
    void position;

    return subsonicOk(req, res);
}));

queueRouter.all("/savePlayQueueByIndex.view", wrap(async (req, res) => {
    const userId = req.user!.id;

    const rawIds = req.query.id;
    const ids: string[] = (
        Array.isArray(rawIds)
            ? rawIds
            : rawIds !== undefined
            ? [rawIds]
            : []
    ).filter(Boolean) as string[];

    const currentIndexRaw = req.query.currentIndex as string | undefined;
    const positionRaw = req.query.position as string | undefined;
    const position = positionRaw === undefined || positionRaw === ""
        ? 0
        : parseInt(positionRaw, 10);

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

    const queueItems: QueueTrack[] = ids.map((queueId) => ({ id: queueId }));
    const currentTrackId = ids.length > 0 ? ids[parsedIndex] : null;

    await prisma.playbackState.upsert({
        where: { userId },
        update: {
            playbackType: "track",
            trackId: currentTrackId,
            audiobookId: null,
            podcastId: null,
            queue: queueItems.length > 0 ? (queueItems as unknown as Prisma.InputJsonValue) : Prisma.DbNull,
            currentIndex: ids.length > 0 ? parsedIndex : 0,
            isShuffle: false,
        },
        create: {
            userId,
            playbackType: "track",
            trackId: currentTrackId,
            audiobookId: null,
            podcastId: null,
            queue: queueItems.length > 0 ? (queueItems as unknown as Prisma.InputJsonValue) : Prisma.DbNull,
            currentIndex: ids.length > 0 ? parsedIndex : 0,
            isShuffle: false,
        },
    });

    void position;

    return subsonicOk(req, res);
}));