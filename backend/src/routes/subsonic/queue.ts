import { Request, Router } from "express";
import { prisma } from "../../utils/db";
import { subsonicOk, subsonicError, SubsonicError } from "../../utils/subsonicResponse";
import { wrap, coverArtId } from "./mappers";
import { playableQueue, saveQueueOfIds, type QueueEntry } from "../../services/savedQueue";
import { one, many } from "../../utils/subsonicParams";

export const queueRouter = Router();

function mapQueueEntry(item: QueueEntry) {
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
        // The album's id, versioned by the stored cover the queue item carries; a stored value that is no cover (the web
        // player keeps an address of its own for some) leaves the plain id.
        "@_coverArt": item.album?.id ? coverArtId(item.album.id, item.album.coverArt) : undefined,
        "@_duration": item.duration || 0,
    };
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

    // A parameter that is not sent is missing (code 10); one that is sent but names no song of the list is a wrong
    // value (code 0, what the spec's generic error is for).
    if (ids.length > 0 && current === undefined) {
        return subsonicError(req, res, SubsonicError.MISSING_PARAM, "Required parameter is missing: current");
    }
    if (ids.length > 0 && !ids.includes(current!)) {
        return subsonicError(req, res, SubsonicError.GENERIC, "current must be included in id list");
    }

    await saveQueueOfIds(userId, {
        ids,
        clientIndex: current ? ids.indexOf(current) : 0,
        position: safePosition,
        changedBy: clientName(req),
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
        return subsonicError(req, res, SubsonicError.GENERIC, "currentIndex must not be set when id is not provided");
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
        return subsonicError(req, res, SubsonicError.GENERIC, "currentIndex must be between 0 and queue length - 1");
    }

    await saveQueueOfIds(userId, {
        ids,
        clientIndex: parsedIndex,
        position: safePosition,
        changedBy: clientName(req),
    });

    return subsonicOk(req, res);
}));