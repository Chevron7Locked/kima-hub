import express from "express";
import { logger } from "../utils/logger";
import { prisma, Prisma } from "../utils/db";
import { LiveQueueEntry, isPublicListener, reportLive } from "../services/liveListening";
import { acceptQueue, indexIntoStoredQueue, lockPlaybackState, namesCurrentSong, queueLimit, shownState, type PlaybackStateRow } from "../services/savedQueue";

const router = express.Router();

// A queue source is a short page address such as `album:<id>`; anything longer is not one and is dropped.
const MAX_QUEUE_SOURCE_LENGTH = 200;

/** Who saved the queue, as a Subsonic app reads it (`changedBy`): a save from the web is Kima's. */
const CHANGED_BY = "Kima";

/** The limit, for the client, so it does not have to guess. */
router.get("/limit", async (_req, res) => {
    res.json({ maxQueueLength: await queueLimit() });
});

// Get current playback state for the authenticated user
router.get("/", async (req, res) => {
    try {
        const userId = req.user!.id;
        res.json(await shownState(await prisma.playbackState.findUnique({ where: { userId } })));
    } catch (error) {
        logger.error("Get playback state error:", error);
        res.status(500).json({ error: "Failed to get playback state" });
    }
});

// Update current playback state for the authenticated user
router.post("/", async (req, res) => {
    try {
        const userId = req.user!.id;
        const {
            playbackType,
            trackId,
            audiobookId,
            podcastId,
            queue,
            currentIndex,
            isShuffle,
            queueSource,
            expectedUpdatedAt,
        } = req.body;

        if (!["track", "audiobook", "podcast"].includes(playbackType)) {
            return res.status(400).json({ error: "playbackType must be track, audiobook or podcast" });
        }

        // A save may name the time of the state it saw (`updatedAt`, as the server last answered it): it then writes
        // only while that is still the stored time, so a state another device saved since is never overwritten by
        // one decided on older word. Omitted, the save writes whatever is stored, as every client has until now.
        let expectedAt: Date | null = null;
        if (expectedUpdatedAt !== undefined) {
            expectedAt = typeof expectedUpdatedAt === "string" ? new Date(expectedUpdatedAt) : null;
            if (!expectedAt || Number.isNaN(expectedAt.getTime())) {
                return res.status(400).json({ error: "expectedUpdatedAt must be a date" });
            }
        }

        // A request without a `queue` is a partial update — a shuffle toggle, or a
        // track change within the queue the client already has. It must NOT clear
        // the stored queue: only an explicit array replaces it. Same for the fields
        // below; an omitted field is left alone rather than reset to its default.
        const queueProvided = Array.isArray(queue);
        const accepted = queueProvided ? acceptQueue(queue, currentIndex, await queueLimit()) : null;
        const safeQueue = accepted?.queue ?? null;
        const storedQueue = safeQueue === null ? Prisma.DbNull : (safeQueue as unknown as Prisma.InputJsonValue);
        const indexOnly = !queueProvided && namesCurrentSong(currentIndex, trackId);

        // Where the queue came from belongs to the queue it was saved with: a save that replaces the queue and sends no
        // source (an older client, the iOS app) clears it, and a save without a queue leaves it.
        const safeQueueSource =
            safeQueue !== null && typeof queueSource === "string" && queueSource.length > 0 && queueSource.length <= MAX_QUEUE_SOURCE_LENGTH
                ? queueSource
                : null;

        // `safeCurrentIndex` null: the save names a song the stored queue does not hold, so the stored index stays.
        // Returns null when the save named a time and the stored state is no longer the one saved at it (or is gone):
        // nothing was written.
        const write = async (db: Pick<Prisma.TransactionClient, "playbackState">, safeCurrentIndex: number | null): Promise<PlaybackStateRow | null> => {
            const queueUpdate = queueProvided
                ? {
                      queue: storedQueue,
                      queueSource: safeQueueSource,
                      currentIndex: safeCurrentIndex ?? 0,
                  }
                : indexOnly && safeCurrentIndex !== null
                  ? { currentIndex: safeCurrentIndex }
                  : {};
            const update = {
                playbackType,
                // Omitted fields are left alone: native clients send partial updates.
                ...(trackId !== undefined ? { trackId: trackId || null } : {}),
                ...(audiobookId !== undefined ? { audiobookId: audiobookId || null } : {}),
                ...(podcastId !== undefined ? { podcastId: podcastId || null } : {}),
                ...queueUpdate,
                ...(typeof isShuffle === "boolean" ? { isShuffle } : {}),
                changedBy: CHANGED_BY,
            };
            // One statement matches the time and writes, so two saves naming the same time cannot both write; a
            // state that is gone is never brought back by it.
            if (expectedAt) {
                const { count } = await db.playbackState.updateMany({ where: { userId, updatedAt: expectedAt }, data: update });
                return count === 0 ? null : db.playbackState.findUnique({ where: { userId } });
            }
            return db.playbackState.upsert({
                where: { userId },
                update,
                create: {
                    userId,
                    playbackType,
                    trackId: trackId || null,
                    audiobookId: audiobookId || null,
                    podcastId: podcastId || null,
                    queue: storedQueue,
                    queueSource: safeQueueSource,
                    currentIndex: safeCurrentIndex ?? 0,
                    isShuffle: isShuffle || false,
                    changedBy: CHANGED_BY,
                },
            });
        };

        // The index points into a queue: the one sent, or for a save without one the queue as it stands, which stays
        // locked until this save is written (see `indexIntoStoredQueue`). A time the save names is checked by that write,
        // so inside the same lock; a save that names one and carries its own queue takes the lock too, so the row it
        // answers with is the one it wrote and not one a later save made.
        const playbackState = indexOnly
            ? await prisma.$transaction(async (tx) => write(tx, await indexIntoStoredQueue(tx, userId, currentIndex, trackId)))
            : expectedAt
              ? await prisma.$transaction(async (tx) => {
                    await lockPlaybackState(tx, userId);
                    return write(tx, accepted?.currentIndex ?? 0);
                })
              : await write(prisma, accepted?.currentIndex ?? 0);

        if (!playbackState) {
            // What is stored now, as a client is shown it, so the client can take it up without asking again.
            const current = await prisma.playbackState.findUnique({ where: { userId } });
            return res.status(409).json({ error: "Playback state changed since it was read", state: await shownState(current) });
        }
        // The reply is the state as a read of it would show it, so a client holds one shape whichever way it learned it.
        res.json(await shownState(playbackState));
    } catch (error) {
        logger.error("Save playback state error:", error);
        res.status(500).json({ error: "Failed to save playback state" });
    }
});

const LIVE_STATUSES = new Set(["playing", "paused", "stopped"]);

function millis(value: unknown): number | null {
    const n = Number(value);
    return Number.isFinite(n) && n >= 0 ? Math.round(n) : null;
}

// The web player's play/pause/seek/track changes, for the public live trip. Players only send
// them when /system/features says so; anyone else still gets a 404, which silences them.
router.post("/live", async (req, res) => {
    try {
        if (!(await isPublicListener(req.user!.id))) {
            return res.status(404).json({ error: "Not available" });
        }
        const { status, trackId, position, duration, queue } = req.body ?? {};
        const positionMs = millis(position);
        const durationMs = millis(duration);
        if (!LIVE_STATUSES.has(status) || typeof trackId !== "string" || !trackId || positionMs === null || durationMs === null) {
            return res.status(400).json({ error: "status, trackId, position and duration are required" });
        }
        const upNext: LiveQueueEntry[] = Array.isArray(queue)
            ? queue
                .filter((e: any) => e && typeof e.trackId === "string" && millis(e.duration) !== null)
                .map((e: any) => ({ trackId: e.trackId, duration: millis(e.duration)! }))
            : [];
        reportLive({ status, trackId, position: positionMs, duration: durationMs, queue: upNext });
        res.json({ ok: true });
    } catch (error) {
        // Not a 404: that would silence the player for the session over one failed lookup.
        logger.error("Live playback report error:", error);
        res.status(500).json({ error: "Failed to report live playback" });
    }
});

// Clear playback state (when user stops playback completely)
router.delete("/", async (req, res) => {
    try {
        const userId = req.user!.id;

        // deleteMany, so clearing state that is already gone succeeds; clients call
        // this to recover from state pointing at something deleted.
        const removed = await prisma.playbackState.deleteMany({
            where: { userId },
        });

        res.json({ success: true, cleared: removed.count });
    } catch (error) {
        logger.error("Delete playback state error:", error);
        res.status(500).json({ error: "Failed to delete playback state" });
    }
});

export default router;
