import express from "express";
import { logger } from "../utils/logger";
import { prisma, Prisma } from "../utils/db";
import { LiveQueueEntry, isPublicListener, reportLive } from "../services/liveListening";
import { QUEUE_LENGTH } from "../utils/systemSettings";
import { acceptQueue, indexIntoStoredQueue, playableQueue } from "../services/savedQueue";

const router = express.Router();

// A queue source is a short page address such as `album:<id>`; anything longer is not one and is dropped.
const MAX_QUEUE_SOURCE_LENGTH = 200;

/**
 * The operator's queue length limit, clamped on read in case the stored value was edited by hand. Read on every queue
 * write (one row by primary key), so a saved limit applies at once.
 */
async function queueLimit(): Promise<number> {
    let value: number = QUEUE_LENGTH.default;
    try {
        const settings = await prisma.systemSettings.findUnique({
            where: { id: "default" },
            select: { maxQueueLength: true },
        });
        if (settings?.maxQueueLength) value = settings.maxQueueLength;
    } catch {
        // A settings read that fails must not stop somebody's queue saving.
    }
    return Math.min(QUEUE_LENGTH.max, Math.max(QUEUE_LENGTH.min, Math.floor(value)));
}

/** The limit, for the client, so it does not have to guess. */
router.get("/limit", async (_req, res) => {
    res.json({ maxQueueLength: await queueLimit() });
});

// Get current playback state for the authenticated user
router.get("/", async (req, res) => {
    try {
        const userId = req.user!.id;

        const state = await prisma.playbackState.findUnique({ where: { userId } });
        if (!state) return res.json(state);

        // Only the queue's playable songs are shown, as to a Subsonic client; what is stored stays as it is. A track the
        // state names that is not playable gives way to the song now current.
        const shown = await playableQueue(state);
        if (!Array.isArray(state.queue)) return res.json({ ...state, trackId: shown.trackId });
        res.json({
            ...state,
            queue: shown.queue.length > 0 ? shown.queue : null,
            queueSource: shown.queue.length > 0 ? state.queueSource : null,
            currentIndex: shown.currentIndex,
            position: shown.position,
            trackId: shown.trackId,
        });
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
        } = req.body;

        if (!["track", "audiobook", "podcast"].includes(playbackType)) {
            return res.status(400).json({ error: "playbackType must be track, audiobook or podcast" });
        }

        // A request without a `queue` is a partial update — a shuffle toggle, or a
        // track change within the queue the client already has. It must NOT clear
        // the stored queue: only an explicit array replaces it. Same for the fields
        // below; an omitted field is left alone rather than reset to its default.
        const queueProvided = Array.isArray(queue);
        const accepted = queueProvided ? acceptQueue(queue, currentIndex, await queueLimit()) : null;
        const safeQueue = accepted?.queue ?? null;
        const storedQueue = safeQueue === null ? Prisma.DbNull : (safeQueue as unknown as Prisma.InputJsonValue);
        const indexOnly =!queueProvided && typeof currentIndex === "number";

        // Where the queue came from belongs to the queue it was saved with: a save that replaces the queue and sends no
        // source (an older client, the iOS app) clears it, and a save without a queue leaves it.
        const safeQueueSource =
            safeQueue !== null && typeof queueSource === "string" && queueSource.length > 0 && queueSource.length <= MAX_QUEUE_SOURCE_LENGTH
                ? queueSource
                : null;

        const write = (db: Pick<Prisma.TransactionClient, "playbackState">, safeCurrentIndex: number) => {
            const queueUpdate = queueProvided
                ? {
                      queue: storedQueue,
                      queueSource: safeQueueSource,
                      currentIndex: safeCurrentIndex,
                  }
                : indexOnly
                  ? { currentIndex: safeCurrentIndex }
                  : {};
            return db.playbackState.upsert({
                where: { userId },
                update: {
                    playbackType,
                    // Omitted fields are left alone: native clients send partial updates.
                    ...(trackId !== undefined ? { trackId: trackId || null } : {}),
                    ...(audiobookId !== undefined ? { audiobookId: audiobookId || null } : {}),
                    ...(podcastId !== undefined ? { podcastId: podcastId || null } : {}),
                    ...queueUpdate,
                    ...(typeof isShuffle === "boolean" ? { isShuffle } : {}),
                },
                create: {
                    userId,
                    playbackType,
                    trackId: trackId || null,
                    audiobookId: audiobookId || null,
                    podcastId: podcastId || null,
                    queue: storedQueue,
                    queueSource: safeQueueSource,
                    currentIndex: safeCurrentIndex,
                    isShuffle: isShuffle || false,
                },
            });
        };

        // The index points into a queue: the one sent, or for a save without one the queue as it stands, which stays
        // locked until this save is written (see `indexIntoStoredQueue`).
        const playbackState = indexOnly
            ? await prisma.$transaction(async (tx) => write(tx, await indexIntoStoredQueue(tx, userId, currentIndex, trackId)))
            : await write(prisma, accepted?.currentIndex ?? 0);

        res.json(playbackState);
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
