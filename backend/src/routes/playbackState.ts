import express from "express";
import { logger } from "../utils/logger";
import { prisma, Prisma } from "../utils/db";
import { requireAuth } from "../middleware/auth";
import { LiveQueueEntry, isPublicListener, reportLive } from "../services/liveListening";
import { QUEUE_LENGTH } from "../utils/systemSettings";

const router = express.Router();

/** Cached for a minute: this is read on every queue write. */
let cachedLimit: { value: number; at: number } | null = null;

/** The operator's queue length limit, clamped on read in case the stored value was edited by hand. */
async function queueLimit(): Promise<number> {
    if (cachedLimit && Date.now() - cachedLimit.at < 60_000) return cachedLimit.value;
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
    value = Math.min(QUEUE_LENGTH.max, Math.max(QUEUE_LENGTH.min, Math.floor(value)));
    cachedLimit = { value, at: Date.now() };
    return value;
}

/** The limit, for the client, so it does not have to guess. */
router.get("/limit", requireAuth, async (_req, res) => {
    res.json({ maxQueueLength: await queueLimit() });
});

// Get current playback state for the authenticated user
router.get("/", requireAuth, async (req, res) => {
    try {
        const userId = req.user!.id;

        res.json(await prisma.playbackState.findUnique({ where: { userId } }));
    } catch (error) {
        logger.error("Get playback state error:", error);
        res.status(500).json({ error: "Failed to get playback state" });
    }
});

// Update current playback state for the authenticated user
router.post("/", requireAuth, async (req, res) => {
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
        } = req.body;

        if (!["track", "audiobook", "podcast"].includes(playbackType)) {
            return res.status(400).json({ error: "playbackType must be track, audiobook or podcast" });
        }

        let safeQueue: any[] | null = null;
        if (Array.isArray(queue) && queue.length > 0) {
            safeQueue = queue
                .slice(0, await queueLimit())
                .filter((item: any) => item && item.id)
                .map((item: any) => ({
                    id: String(item.id),
                    title: String(item.title || "Unknown").substring(0, 500),
                    // The title as edited in Kima, so every device shows the edit.
                    displayTitle: item.displayTitle ? String(item.displayTitle).substring(0, 500) : null,
                    duration: Number(item.duration) || 0,
                    artist: item.artist ? {
                        id: String(item.artist.id || ""),
                        name: String(item.artist.name || "Unknown").substring(0, 200),
                    } : null,
                    album: item.album ? {
                        id: String(item.album.id || ""),
                        title: String(item.album.title || "Unknown").substring(0, 500),
                        coverArt: item.album.coverArt ? String(item.album.coverArt).substring(0, 1000) : null,
                    } : null,
                }));

            if (safeQueue.length === 0) {
                safeQueue = null;
            }
        }

        // A request without a `queue` is a partial update — a shuffle toggle, or a
        // track change within the queue the client already has. It must NOT clear
        // the stored queue: only an explicit array replaces it. Same for the fields
        // below; an omitted field is left alone rather than reset to its default.
        const queueProvided = Array.isArray(queue);

        const safeCurrentIndex = queueProvided
            ? Math.min(
                  Math.max(0, currentIndex || 0),
                  safeQueue?.length ? safeQueue.length - 1 : 0
              )
            : Math.max(0, currentIndex || 0);

        const queueUpdate = queueProvided
            ? {
                  queue: safeQueue === null ? Prisma.DbNull : safeQueue,
                  currentIndex: safeCurrentIndex,
              }
            : typeof currentIndex === "number"
              ? { currentIndex: safeCurrentIndex }
              : {};

        const playbackState = await prisma.playbackState.upsert({
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
                queue: safeQueue === null ? Prisma.DbNull : safeQueue,
                currentIndex: safeCurrentIndex,
                isShuffle: isShuffle || false,
            },
        });

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
router.post("/live", requireAuth, async (req, res) => {
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
router.delete("/", requireAuth, async (req, res) => {
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
